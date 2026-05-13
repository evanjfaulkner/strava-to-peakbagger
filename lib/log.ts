import type { LogEntry } from "./models";
import { get, set } from "./storage";

export const LOG_RING_MAX = 200;

type Level = LogEntry["level"];

// Serialize writes so concurrent log() calls from different modules
// don't lose entries via lost-update on the ring buffer.
let writeChain: Promise<void> = Promise.resolve();

export async function log(
  level: Level,
  msg: string,
  ctx?: Record<string, unknown>,
): Promise<void> {
  // Mirror to the SW DevTools console for the operator who's already
  // looking there; the ring buffer is for the Options-page viewer.
  const consoleArgs: unknown[] =
    ctx === undefined ? [`[s2p] ${msg}`] : [`[s2p] ${msg}`, ctx];
  if (level === "error") console.error(...consoleArgs);
  else if (level === "warn") console.warn(...consoleArgs);
  else console.log(...consoleArgs);

  const entry: LogEntry = {
    t: Date.now(),
    level,
    msg,
    ...(ctx === undefined ? {} : { ctx }),
  };

  writeChain = writeChain.then(async () => {
    try {
      const current = (await get("log")) ?? [];
      const next = [...current, entry];
      const trimmed =
        next.length > LOG_RING_MAX ? next.slice(next.length - LOG_RING_MAX) : next;
      await set("log", trimmed);
    } catch {
      // Don't let log failure cascade — the operator can still see
      // the SW console mirror.
    }
  });
  await writeChain;
}

export async function getRecentLog(limit = 50): Promise<LogEntry[]> {
  const all = (await get("log")) ?? [];
  return all.slice(Math.max(0, all.length - limit));
}

export async function clearLog(): Promise<void> {
  await set("log", []);
}
