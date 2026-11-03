/**
 * SessionDataSource.ts — fetch the soundcraft-orbit/session@1 JSON.
 *
 * The same endpoint the web companion uses (web/data/session.json, produced
 * by tools/build_data.py from the SoundCraft bundle). In Lens Studio the URL
 * must be allow-listed in the Remote Service module configuration.
 */

export class SessionDataSource {
  public onData: ((data: any) => void) | null = null;
  public onError: ((status: number, body: string) => void) | null = null;

  constructor(
    private remoteService: RemoteServiceModule,
    private url: string,
  ) {}

  fetch() {
    const req = this.remoteService.performRequest("GET", this.url);
    req.onDone = (resp: RemoteServiceHttpResponse) => {
      if (resp.status !== 200) {
        if (this.onError) this.onError(resp.status, "fetch failed");
        return;
      }
      try {
        const data = JSON.parse(resp.body);
        if (this.onData) this.onData(data);
      } catch (e) {
        if (this.onError) this.onError(-1, "bad JSON: " + String(e));
      }
    };
    req.onError = (code: number, err: string) => {
      if (this.onError) this.onError(code, err);
    };
  }
}
