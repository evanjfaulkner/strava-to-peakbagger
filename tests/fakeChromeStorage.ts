type Bag = Record<string, unknown>;

export function installFakeChromeStorage(initial: Bag = {}): {
  bag: Bag;
  reset: () => void;
} {
  const bag: Bag = { ...initial };

  const fake = {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          if (keys == null) return { ...bag };
          const list = typeof keys === "string" ? [keys] : keys;
          const out: Bag = {};
          for (const k of list) {
            if (k in bag) out[k] = bag[k];
          }
          return out;
        },
        async set(obj: Bag) {
          Object.assign(bag, obj);
        },
        async remove(keys: string | string[]) {
          const list = typeof keys === "string" ? [keys] : keys;
          for (const k of list) delete bag[k];
        },
        async clear() {
          for (const k of Object.keys(bag)) delete bag[k];
        },
      },
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = fake;

  return {
    bag,
    reset() {
      for (const k of Object.keys(bag)) delete bag[k];
    },
  };
}
