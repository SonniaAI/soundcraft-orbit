// SoundcraftCompanionHttp.ts — the Lens-side HTTP boundary for the SoundCraft
// companion. NEW file. Uses ONLY the real Lens InternetModule fetch API
// (Support/StudioLib.d.ts: `InternetModule.fetch(request: string | Request,
// options?: any | null): Promise<Response>`, `Response.status/text()/headers`,
// `Headers.get`) — no web DOM objects, no fetch polyfills, no timers outside
// the injected Lens `DelayedCallbackEvent` deadline.
//
// Design for honesty under loss:
//  * A deadline that fires while the fetch is still pending does NOT pretend
//    the request never happened — it returns `outcome: "unknown"` (the server
//    may have applied it). Callers use the journal readback to settle ingest
//    uncertainty, and never blind-retry a commit or a save.
//  * The error envelope `{"error": {code, message, details?}}` is parsed
//    strictly; a non-JSON reply is surfaced as its own typed outcome.
//  * Retry-After is honoured (companion rate limits at 429).

import { ErrorEnvelope } from "./SoundcraftCompanionTypes";

// ---- injected environment (so the pure client is testable offline) ----------

/** Monotonic wall clock in nanoseconds. The Lens wires `getRealTimeNanos()`. */
export type RealTimeNanos = () => number;

/** Seconds since lens start. The Lens wires `getTime()`. */
export type LensSeconds = () => number;

/**
 * Deadline timer. The Lens wires ScriptComponent.createEvent("DelayedCallbackEvent")
 * (`reset(seconds)` fires the callback, `cancel()` aborts it — StudioLib.d.ts
 * :14580). Tests wire a fake. No setTimeout/setInterval exists in this runtime.
 */
export type DeadlineTimer = {
  arm: (seconds: number, onFire: () => void) => { cancel: () => void };
};

export function neverTime(): DeadlineTimer {
  return {
    arm: (_seconds: number, _onFire: () => void) => {
      // Degenerate timer for judge mode / tests: fires never.
      return { cancel: () => {} };
    },
  };
}

// ---- typed transport outcomes -----------------------------------------------

/** How a request ended. "unknown" means the reply was not observed — never retried blindly. */
export type TransportOutcome =
  | "ok" // got a well-formed HTTP reply (any status)
  | "network_error" // fetch rejected before any reply (malformed URL / connection failure)
  | "deadline" // our deadline fired while the fetch was pending — outcome unknown
  | "local_only"; // the null transport refused: judge mode never talks to a network

export type TransportReply = {
  outcome: TransportOutcome;
  status: number; // 0 unless outcome === "ok"
  bodyText: string; // raw body ("" when nothing was observed)
  retryAfterSeconds: number; // parsed from headers; 0 when absent/unparseable
  problem: string; // human-readable detail for logs/status (no secrets)
};

/**
 * The one seam tests stub. Every client network action goes through here, so
 * offline tests exercise the exact same state machine as on-Lens runs.
 */
export interface CompanionTransport {
  request(
    method: "GET" | "POST" | "DELETE",
    path: string, // begins with /v1/...; no query secrets, no paths to files — ever
    bodyJson: string | null,
    withAuth: boolean
  ): Promise<TransportReply>;
}

/**
 * Transports that hold the paired token in memory. The token NEVER leaves this
 * variable — no inspector field, no scene asset, no log line ever carries it.
 */
export interface BearerCapableTransport extends CompanionTransport {
  bearerToken: string | null;
}

// ---- parsing helpers ---------------------------------------------------------

export function parseJsonBody(text: string): { ok: boolean; value: unknown; problem: string } {
  if (text.length === 0) {
    return { ok: false, value: null, problem: "empty body" };
  }
  try {
    return { ok: true, value: JSON.parse(text), problem: "" };
  } catch (e) {
    return { ok: false, value: null, problem: "body was not valid JSON" };
  }
}

export function errorEnvelopeOf(reply: TransportReply): { code: string; message: string; details: unknown } | null {
  const parsed = parseJsonBody(reply.bodyText);
  if (!parsed.ok) {
    return null;
  }
  const obj = parsed.value as { [key: string]: unknown };
  if (obj === null || typeof obj !== "object") {
    return null;
  }
  const err = obj["error"];
  if (err === null || err === undefined || typeof err !== "object") {
    return null;
  }
  const errObj = err as { [key: string]: unknown };
  const code = typeof errObj["code"] === "string" ? errObj["code"] : "error";
  const message = typeof errObj["message"] === "string" ? errObj["message"] : "";
  return { code: code, message: message, details: errObj["details"] };
}

/** Strict safe-integer check (mirrors the backend's MAX_JSON_INT rule). */
export function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value && Math.abs(value) <= 9007199254740991;
}

// ---- the real transport (Lens InternetModule) --------------------------------

export type InternetTransportDeps = {
  internetModule: InternetModule; // global asset type from StudioLib.d.ts
  baseUrl: string; // inspector-configured HTTPS endpoint; NO tokens baked here
  deadlineSeconds: number; // per-request deadline (the companion bounds its own phases too)
  timer: DeadlineTimer;
  clockNanos: RealTimeNanos;
  log: (message: string) => void;
};

/**
 * Request deadline guard: races the in-flight fetch against the injected
 * DelayedCallbackEvent timer. When the deadline fires we return
 * `outcome: "deadline"` (outcome unknown) — the underlying fetch is left alone
 * (this runtime has no AbortController; honesty, not suppression).
 */
export class InternetModuleTransport implements BearerCapableTransport {
  private deps: InternetTransportDeps;
  private minSpacingSeconds: number;
  private lastRequestAtNanos: number;

  /**
   * The paired token lives ONLY here while paired: set after a successful
   * pair, cleared on expiry/unpair. Never written to any inspector field,
   * scene asset, or log.
   */
  bearerToken: string | null = null;

  constructor(deps: InternetTransportDeps, minSpacingSeconds: number) {
    this.deps = deps;
    this.minSpacingSeconds = minSpacingSeconds > 0 ? minSpacingSeconds : 0;
    this.lastRequestAtNanos = 0;
  }

  request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    bodyJson: string | null,
    withAuth: boolean
  ): Promise<TransportReply> {
    const deps = this.deps;
    // Spacing guard: keeps the client far under the companion's 120 req/min.
    const nowNanos = deps.clockNanos();
    const earliestNanos = this.lastRequestAtNanos + this.minSpacingSeconds * 1e9;
    const waitSeconds = this.lastRequestAtNanos === 0 ? 0 : (earliestNanos - nowNanos) / 1e9;
    this.lastRequestAtNanos = Math.max(nowNanos, earliestNanos);

    return new Promise<TransportReply>((resolve) => {
      const startedAtNanos = deps.clockNanos();
      let settled = false;
      const finish = (reply: TransportReply) => {
        if (settled) {
          return;
        }
        settled = true;
        timerHandle.cancel();
        resolve(reply);
      };

      const timerHandle = deps.timer.arm(deps.deadlineSeconds, () => {
        finish({
          outcome: "deadline",
          status: 0,
          bodyText: "",
          retryAfterSeconds: 0,
          problem:
            "no reply within " + deps.deadlineSeconds + "s — outcome unknown; use the readback, do not resend blindly",
        });
      });

      const headers: { [header: string]: string } = {
        Accept: "application/json",
      };
      if (bodyJson !== null) {
        headers["Content-Type"] = "application/json";
      }
      if (withAuth) {
        const token = this.bearerToken;
        if (token === null || token.length === 0) {
          finish({
            outcome: "network_error",
            status: 0,
            bodyText: "",
            retryAfterSeconds: 0,
            problem: "no live token in memory — pair first",
          });
          return;
        }
        headers["Authorization"] = "Bearer " + token;
      }

      const options: any = {
        method: method,
        headers: headers,
        // REFUSE redirects at the protocol level: a followed redirect would
        // already have forwarded the Authorization header to the redirect
        // target before any post-hoc URL check could run. "error" turns a
        // redirect into a failed fetch (fetch rejects) — nothing is forwarded.
        redirect: "error",
      };
      if (bodyJson !== null) {
        options.body = bodyJson;
      }

      const schedule = (work: () => void) => {
        if (waitSeconds <= 0) {
          work();
        } else {
          const spacingHandle = deps.timer.arm(waitSeconds + 0.001, () => {
            spacingHandle.cancel(); // one-shot
            work();
          });
        }
      };

      schedule(() => {
        deps.internetModule
          .fetch(deps.baseUrl + path, options)
          .then((response: Response) => {
            response
              .text()
              .then((bodyText: string) => {
                let retryAfter = 0;
                const ra = response.headers.get("retry-after");
                if (ra !== null) {
                  const parsed = parseInt(ra, 10);
                  if (isSafeInt(parsed) && parsed > 0) {
                    retryAfter = parsed;
                  }
                }
                finish({
                  outcome: "ok",
                  status: response.status,
                  bodyText: bodyText,
                  retryAfterSeconds: retryAfter,
                  problem: "",
                });
              })
              .catch((bodyErr: unknown) => {
                finish({
                  outcome: "network_error",
                  status: response.status,
                  bodyText: "",
                  retryAfterSeconds: 0,
                  problem: "reply body unreadable (" + String(bodyErr) + ")",
                });
              });
          })
          .catch((err: unknown) => {
            finish({
              outcome: "network_error",
              status: 0,
              bodyText: "",
              retryAfterSeconds: 0,
              problem: "fetch failed before any reply (" + String(err) + ")",
            });
          });
      });
    });
  }
}
