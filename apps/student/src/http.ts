/**
 * Minimal XMLHttpRequest transport (no fetch/Promise on old webOS). Every failure — offline, timeout,
 * CORS, non-JSON body — is reported through the callback; nothing throws into the UI.
 */
export interface HttpResponse {
  /** 0 = network failure / timeout. */
  status: number;
  body: unknown;
  header: (name: string) => string | null;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: { [name: string]: string };
  body?: unknown;
  timeoutMs?: number;
}

export type Http = (req: HttpRequest, done: (res: HttpResponse) => void) => void;

const noHeader = function (): string | null {
  return null;
};

export const xhrHttp: Http = function (req, done) {
  let finished = false;
  const finish = function (res: HttpResponse) {
    if (finished) return;
    finished = true;
    try {
      done(res);
    } catch {
      /* a consumer bug must never break the app loop */
    }
  };
  let x: XMLHttpRequest;
  try {
    x = new XMLHttpRequest();
    x.open(req.method, req.url, true);
    x.timeout = req.timeoutMs || 10000;
    const h = req.headers || {};
    for (const k in h) if (Object.prototype.hasOwnProperty.call(h, k)) x.setRequestHeader(k, h[k]);
    if (req.body !== undefined) x.setRequestHeader("Content-Type", "application/json");
  } catch {
    finish({ status: 0, body: null, header: noHeader });
    return;
  }
  x.onreadystatechange = function () {
    if (x.readyState !== 4) return;
    let body: unknown = null;
    try {
      body = x.responseText ? JSON.parse(x.responseText) : null;
    } catch {
      body = null;
    }
    finish({
      status: x.status || 0,
      body: body,
      header: function (n: string) {
        try {
          return x.getResponseHeader(n);
        } catch {
          return null;
        }
      },
    });
  };
  x.ontimeout = function () {
    finish({ status: 0, body: null, header: noHeader });
  };
  x.onerror = function () {
    finish({ status: 0, body: null, header: noHeader });
  };
  try {
    x.send(req.body === undefined ? null : JSON.stringify(req.body));
  } catch {
    finish({ status: 0, body: null, header: noHeader });
  }
};
