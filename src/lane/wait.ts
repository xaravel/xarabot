import type { LaneStore } from "../ports/lane-store.ts";

/**
 * The lane's waits (FR15, AR3): each one is a child `sleep` whose PID is in
 * `wait.pid`, so `xarabot wake` can end it by that exact PID. A STOP marker,
 * checked every `pollMs`, or the caller's signal ends it early. `wait` never
 * throws and always clears `wait.pid`.
 */

export type WaitEnd = "elapsed" | "woken" | "stopped" | "aborted" | "failed";

export type WaitResult = { readonly end: WaitEnd; readonly message?: string };

export type WaitParams = {
  readonly ms: number;
  /** Aborting it kills the sleep: `aborted`. */
  readonly signal?: AbortSignal;
  /** How often `onTick` runs during the wait. */
  readonly tickMs?: number;
  readonly onTick?: () => void | Promise<void>;
};

export type Waiter = {
  wait(params: WaitParams): Promise<WaitResult>;
};

/** A spawned `sleep`, as much of it as the waiter uses. */
export type SleepChild = {
  readonly pid: number;
  /** Resolves when the child exits. */
  readonly exited: Promise<unknown>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  /** SIGTERM to the child's own PID. */
  kill(): void;
};

export type SpawnSleep = (argv: readonly string[]) => SleepChild;

export type SleepWaiterParams = {
  readonly store: LaneStore;
  /** How often the STOP markers are checked; default 5 s. */
  readonly pollMs?: number;
  readonly spawn?: SpawnSleep;
};

export const DEFAULT_POLL_MS = 5000;

const bunSpawn: SpawnSleep = (argv) => {
  const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return {
    pid: proc.pid,
    exited: proc.exited,
    get exitCode() {
      return proc.exitCode;
    },
    get signalCode() {
      const code = proc.signalCode;
      return code === null || code === undefined ? null : String(code);
    },
    kill: () => proc.kill("SIGTERM"),
  };
};

/** `ms` as `sleep`'s seconds argument. */
function seconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return Number.isFinite(s) ? String(Math.round(s * 1000) / 1000) : "0";
}

/** A thrown value's text: this module's own copy of `session.ts`'s, since `session.ts` imports this module. */
function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createSleepWaiter(params: SleepWaiterParams): Waiter {
  const { store } = params;
  const pollMs = params.pollMs ?? DEFAULT_POLL_MS;
  const spawn = params.spawn ?? bunSpawn;

  /** A STOP marker that is present or can't be read. */
  const stopped = (): string | null => {
    const s = store.stopMarkers();
    if (!s.ok) return `STOP markers unreadable: ${s.error.message}`;
    if (s.value.host) return "host STOP marker present";
    if (s.value.lane) return "lane STOP marker present";
    return null;
  };

  return {
    async wait({ ms, signal, tickMs, onTick }) {
      const before = stopped();
      if (before !== null) return { end: "stopped", message: before };
      if (signal?.aborted === true) return { end: "aborted" };

      let child: SleepChild;
      try {
        child = spawn(["sleep", seconds(ms)]);
      } catch (e) {
        return { end: "failed", message: `sleep: ${message(e)}` };
      }
      const timers: ReturnType<typeof setInterval>[] = [];
      let killedFor: { readonly end: "stopped" | "aborted"; readonly message?: string } | null = null;
      const killFor = (end: "stopped" | "aborted", why?: string): void => {
        if (killedFor !== null) return;
        killedFor = why === undefined ? { end } : { end, message: why };
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      };
      const onAbort = (): void => killFor("aborted");
      /** The tick in flight; a tick never overlaps the last one, and the wait ends after it. */
      let ticking: Promise<void> | null = null;

      try {
        const pid = store.writePid("wait", child.pid, "sleep");
        if (!pid.ok) {
          killFor("aborted");
          await child.exited;
          return { end: "failed", message: `wait.pid: ${pid.error.message}` };
        }
        signal?.addEventListener("abort", onAbort);
        timers.push(
          setInterval(() => {
            const why = stopped();
            if (why !== null) killFor("stopped", why);
          }, pollMs),
        );
        if (onTick !== undefined && tickMs !== undefined && tickMs > 0) {
          timers.push(
            setInterval(() => {
              if (ticking !== null) return;
              ticking = (async () => {
                try {
                  await onTick();
                } catch {
                  // A tick's failure never ends the wait.
                }
              })().finally(() => {
                ticking = null;
              });
            }, tickMs),
          );
        }
        await child.exited;
        for (const t of timers.splice(0)) clearInterval(t);
        if (ticking !== null) await ticking;
        const killed = killedFor as { readonly end: "stopped" | "aborted"; readonly message?: string } | null;
        if (killed !== null) return killed;
        // A STOP written since the last poll still wins over an elapsed or woken sleep.
        const after = stopped();
        if (after !== null) return { end: "stopped", message: after };
        if (child.exitCode === 0) return { end: "elapsed" };
        if (child.signalCode !== null) return { end: "woken", message: `sleep ended on ${child.signalCode}` };
        return { end: "failed", message: `sleep exited ${child.exitCode ?? "?"}` };
      } catch (e) {
        return { end: "failed", message: `wait: ${message(e)}` };
      } finally {
        for (const t of timers) clearInterval(t);
        signal?.removeEventListener("abort", onAbort);
        store.clearPid("wait");
      }
    },
  };
}
