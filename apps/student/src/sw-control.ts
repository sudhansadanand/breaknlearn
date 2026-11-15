/**
 * Service-worker registration and kill switch (F6). The worker (sw.ts) only serves the static
 * student bundle network-first with a last-good cache fallback; it never touches /api or /admin.
 *
 * Kill switch, any of:
 *  - server config `{"service_worker": false}` from GET /api/v1/student/config;
 *  - opening the app with `?sw=off` (support/troubleshooting);
 *  - deploying the self-unregistering sw.js described in apps/student/README.md.
 * Each path unregisters every registration on this origin and deletes the `bnl-student-*` caches.
 */
export const CACHE_PREFIX = "bnl-student-";

interface SwRegistration {
  unregister(): unknown;
}
interface SwContainer {
  register(url: string, opts?: { scope?: string }): { then?: (ok: () => void, bad: () => void) => unknown } | undefined;
  getRegistrations?: () => { then: (f: (r: SwRegistration[]) => void) => unknown };
}
interface CacheStorageLike {
  keys(): { then: (f: (k: string[]) => void) => unknown };
  delete(k: string): unknown;
}

function container(win: Window): SwContainer | null {
  const nav = win.navigator as unknown as { serviceWorker?: SwContainer };
  return nav && nav.serviceWorker ? nav.serviceWorker : null;
}

export function disableServiceWorker(win: Window): void {
  const c = container(win);
  try {
    const caches = (win as unknown as { caches?: CacheStorageLike }).caches;
    const wipe = function () {
      if (!caches) return;
      caches.keys().then(function (keys) {
        for (let i = 0; i < keys.length; i++) if (keys[i].indexOf(CACHE_PREFIX) === 0) caches.delete(keys[i]);
      });
    };
    wipe();
    if (c && c.getRegistrations) {
      c.getRegistrations().then(function (regs) {
        for (let i = 0; i < regs.length; i++) regs[i].unregister();
        wipe(); // again, after in-flight worker writes of this page load
      });
    }
  } catch {
    /* best effort */
  }
}

export function enableServiceWorker(win: Window, url: string): void {
  const c = container(win);
  if (!c) return; // old webOS engines: HTTP cache only, exactly like the live app
  const proto = win.location.protocol;
  if (proto !== "https:" && proto !== "http:") return;
  try {
    const r = c.register(url, { scope: "/" });
    if (r && r.then) r.then(function () {}, function () {});
  } catch {
    /* registration refused (insecure origin, private mode): run without it */
  }
}

/** `?sw=off` in the URL → kill switch for this device. */
export function swDisabledByUrl(win: Window): boolean {
  return /[?&]sw=off(&|$)/.test(win.location.search || "");
}
