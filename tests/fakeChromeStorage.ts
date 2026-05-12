type Bag = Record<string, unknown>;

export type FakeChrome = {
  bag: Bag;
  identity: {
    getRedirectURL: () => string;
    launchWebAuthFlow: (details: {
      url: string;
      interactive?: boolean;
    }) => Promise<string>;
  };
  reset: () => void;
};

export function installFakeChromeStorage(initial: Bag = {}): FakeChrome {
  const bag: Bag = { ...initial };

  const identity = {
    getRedirectURL: () => "https://test-extension.chromiumapp.org/",
    launchWebAuthFlow: async (_details: {
      url: string;
      interactive?: boolean;
    }): Promise<string> => {
      throw new Error("chrome.identity.launchWebAuthFlow not stubbed");
    },
  };

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
    identity,
  };

  (globalThis as unknown as { chrome: unknown }).chrome = fake;

  return {
    bag,
    identity,
    reset() {
      for (const k of Object.keys(bag)) delete bag[k];
    },
  };
}
