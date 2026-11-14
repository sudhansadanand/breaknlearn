import { memoryStore, type KeyValueStore } from "../src/util";

export function storeWith(values: Record<string, string | null>): KeyValueStore & { dump(): Record<string, string> } {
  const keys = new Set<string>();
  const s = memoryStore();
  for (const [k, v] of Object.entries(values)) if (v !== null) {
    s.setItem(k, v);
    keys.add(k);
  }
  return {
    getItem: (k) => s.getItem(k),
    setItem: (k, v) => {
      keys.add(k);
      s.setItem(k, v);
    },
    removeItem: (k) => {
      keys.delete(k);
      s.removeItem(k);
    },
    dump: () => {
      const out: Record<string, string> = {};
      for (const k of [...keys].sort()) {
        const v = s.getItem(k);
        if (v !== null) out[k] = v;
      }
      return out;
    },
  };
}
