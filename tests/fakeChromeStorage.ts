type Bag = Record<string, unknown>;

export type FakeChrome = {
  bag: Bag;
  sessionBag: Bag;
  identity: {
    getRedirectURL: () => string;
    launchWebAuthFlow: (details: {
      url: string;
      interactive?: boolean;
    }) => Promise<string>;
  };
  messages: unknown[];
  tabsCreated: { url: string; active?: boolean }[];
  reset: () => void;
};

export function installFakeChromeStorage(initial: Bag = {}): FakeChrome {
  const bag: Bag = { ...initial };
  const messages: unknown[] = [];
  const tabsCreated: { url: string; active?: boolean }[] = [];

  const identity = {
    getRedirectURL: () => "https://test-extension.chromiumapp.org/",
    launchWebAuthFlow: async (_details: {
      url: string;
      interactive?: boolean;
    }): Promise<string> => {
      throw new Error("chrome.identity.launchWebAuthFlow not stubbed");
    },
  };

  const sessionBag: Bag = {};
  const localApi = {
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
  };
  const sessionApi = {
    async get(keys: string | string[] | null) {
      if (keys == null) return { ...sessionBag };
      const list = typeof keys === "string" ? [keys] : keys;
      const out: Bag = {};
      for (const k of list) {
        if (k in sessionBag) out[k] = sessionBag[k];
      }
      return out;
    },
    async set(obj: Bag) {
      Object.assign(sessionBag, obj);
    },
    async remove(keys: string | string[]) {
      const list = typeof keys === "string" ? [keys] : keys;
      for (const k of list) delete sessionBag[k];
    },
    async clear() {
      for (const k of Object.keys(sessionBag)) delete sessionBag[k];
    },
  };

  const fake = {
    storage: {
      local: localApi,
      session: sessionApi,
    },
    identity,
    runtime: {
      async sendMessage(msg: unknown): Promise<undefined> {
        messages.push(msg);
        return undefined;
      },
    },
    tabs: {
      async create(options: { url: string; active?: boolean }) {
        tabsCreated.push(options);
        return { id: tabsCreated.length };
      },
      async query(_filter: unknown) {
        // Test default: every tab we've created is "open".
        return tabsCreated.map((_, i) => ({ id: i + 1 }));
      },
      onRemoved: {
        addListener: (_cb: (tabId: number) => void) => {
          /* no-op stub for tests */
        },
      },
    },
    alarms: {
      create: (_name: string, _options: unknown) => {
        /* no-op */
      },
      onAlarm: {
        addListener: (_cb: (alarm: { name: string }) => void) => {
          /* no-op */
        },
      },
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = fake;

  return {
    bag,
    sessionBag,
    identity,
    messages,
    tabsCreated,
    reset() {
      for (const k of Object.keys(bag)) delete bag[k];
      for (const k of Object.keys(sessionBag)) delete sessionBag[k];
      messages.length = 0;
      tabsCreated.length = 0;
    },
  };
}
