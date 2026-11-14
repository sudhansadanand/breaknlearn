/**
 * Student bundle service worker (F6). ES5, no imports. `__BUILD_ID__` is replaced at build time.
 * Strategy: network-first for the five bundle URLs only; on network failure serve the last good
 * copy from the cache. Every other request (/api, /admin, …) is not intercepted at all.
 */
interface SwFetchEvent {
  request: { method: string; url: string; mode?: string; clone(): unknown };
  respondWith(r: unknown): void;
}
interface SwExtendableEvent {
  waitUntil(p: unknown): void;
}
interface SwResponse {
  ok: boolean;
  status: number;
  type?: string;
  clone(): SwResponse;
}
interface SwThenable<T> {
  then<U>(f: (v: T) => U | SwThenable<U>, r?: (e: unknown) => U | SwThenable<U>): SwThenable<U>;
}
interface SwCache {
  addAll(urls: string[]): SwThenable<void>;
  put(req: unknown, res: SwResponse): SwThenable<void>;
  match(req: unknown): SwThenable<SwResponse | undefined>;
}
interface SwScope {
  location: { origin: string };
  addEventListener(type: string, fn: (e: SwFetchEvent & SwExtendableEvent) => void): void;
  skipWaiting(): unknown;
  clients: { claim(): unknown };
  caches: {
    open(name: string): SwThenable<SwCache>;
    keys(): SwThenable<string[]>;
    delete(name: string): SwThenable<boolean>;
    match(req: unknown): SwThenable<SwResponse | undefined>;
    has(name: string): SwThenable<boolean>;
  };
  fetch(req: unknown): SwThenable<SwResponse>;
}

(function () {
  const sw = self as unknown as SwScope;
  const BUILD = "__BUILD_ID__";
  const CACHE = "bnl-student-" + BUILD;
  const CORE = ["/", "/index.html", "/app.js?v=" + BUILD, "/logo.webp", "/music.wav"];
  const PATHS = ["/", "/index.html", "/app.js", "/logo.webp", "/music.wav"];

  sw.addEventListener("install", function (e) {
    e.waitUntil(
      sw.caches.open(CACHE).then(function (c) {
        return c.addAll(CORE);
      }).then(function () {
        return sw.skipWaiting();
      }),
    );
  });

  sw.addEventListener("activate", function (e) {
    e.waitUntil(
      sw.caches.keys().then(function (keys) {
        for (let i = 0; i < keys.length; i++) if (keys[i].indexOf("bnl-student-") === 0 && keys[i] !== CACHE) sw.caches.delete(keys[i]);
        return sw.clients.claim();
      }),
    );
  });

  sw.addEventListener("fetch", function (e) {
    const req = e.request;
    if (req.method !== "GET") return;
    const m = /^(https?:\/\/[^/]+)(\/[^?#]*)/.exec(req.url);
    if (!m || m[1] !== sw.location.origin || PATHS.indexOf(m[2]) < 0) return;
    const navigate = req.mode === "navigate";
    const killing = /[?&]sw=off(&|$)/.test(req.url); // kill switch page load: never write the cache
    e.respondWith(
      sw.fetch(req).then(
        function (res) {
          if (res && res.status === 200 && res.type !== "opaque" && !killing) {
            const copy = res.clone();
            // Only refresh a cache that still exists: after the kill switch deleted it, stay out.
            sw.caches.has(CACHE).then(function (exists) {
              if (exists)
                sw.caches.open(CACHE).then(function (c) {
                  return c.put(req, copy);
                });
            });
          }
          return res;
        },
        function () {
          return sw.caches.match(req).then(function (hit) {
            if (hit) return hit;
            return navigate ? sw.caches.match("/") : (undefined as unknown as SwResponse);
          });
        },
      ),
    );
  });
})();
