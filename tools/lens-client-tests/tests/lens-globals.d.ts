// lens-globals.d.ts — MINIMAL stand-ins for the Lens globals the pure sources
// reference as types, plus the node-ish globals the test harness itself uses.
// The authoritative compile runs against the REAL StudioLib.d.ts
// (tsconfig.ls.json); this file only lets the offline node build type-check.

declare class InternetModule {
  fetch(request: string | unknown, options?: unknown | null): Promise<Response>;
}

declare class Headers {
  get(name: string): string;
  has(name: string): boolean;
  set(name: string, value: string): void;
  append(name: string, value: string): void;
}

declare class Response {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  readonly url: string;
  readonly headers: Headers;
  readonly bodyUsed: boolean;
  text(): Promise<string>;
  json(): Promise<any>;
  bytes(): Promise<Uint8Array>;
}

declare class Request {
  constructor(input: string, options?: unknown | null);
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  text(): Promise<string>;
}

declare function getTime(): number;
declare function getRealTimeNanos(): number;
declare function getDeltaTime(): number;

// node-ish test globals
declare var console: { log(message: string): void };
declare var process: { exit(code?: number): void; argv: string[] };
declare function require(id: string): any;
declare var module: { exports: unknown };
declare function setTimeout(cb: () => void, ms: number): unknown;
declare var __filename: string;
declare namespace fs {
  function readFileSync(path: string, encoding: string): string;
  function accessSync(path: string): void;
}

// portable source-read helper support (public test copies only)
declare var __dirname: string;
