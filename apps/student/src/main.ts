/**
 * Entry point. Order matters: the legacy backup is taken before anything new is written.
 */
import { startApp } from "./app";
import { ensureLegacyBackup } from "./legacy";
import { xhrHttp } from "./http";
import { createPaired } from "./paired";
import { disableServiceWorker, enableServiceWorker, swDisabledByUrl } from "./sw-control";
import { safeStore, type KeyValueStore } from "./util";

/** Replaced with the build hash by scripts/build.mjs. */
const BUILD_ID = "__BUILD_ID__";

(function () {
  let ls: KeyValueStore | null = null;
  try {
    ls = window.localStorage;
  } catch {
    ls = null;
  }
  const store = safeStore(ls);
  try {
    ensureLegacyBackup(store, Date.now());
  } catch {
    /* a storage failure must not stop the app */
  }
  const root = document.getElementById("app") as HTMLElement;
  const music = document.getElementById("music") as HTMLAudioElement;
  const paired = createPaired({
    store: store,
    http: xhrHttp,
    now: function () {
      return Date.now();
    },
    random: Math.random,
    setTimeout: function (fn, ms) {
      return window.setTimeout(fn, ms);
    },
    clearTimeout: function (h) {
      window.clearTimeout(h as number);
    },
    setInterval: function (fn, ms) {
      return window.setInterval(fn, ms);
    },
    onServiceWorkerFlag: function (enabled) {
      if (!enabled) disableServiceWorker(window);
    },
  });
  startApp({ root: root, music: music, store: store, paired: paired, doc: document, win: window });
  try {
    paired.start();
  } catch {
    /* paired mode is optional */
  }
  if (swDisabledByUrl(window) || !paired.config().service_worker) disableServiceWorker(window);
  else enableServiceWorker(window, "/sw.js?v=" + BUILD_ID);
})();
