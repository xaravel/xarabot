import { test } from "bun:test";

/** True when live tests are switched on with `XARABOT_LIVE=1`. */
export const isLive: boolean = process.env.XARABOT_LIVE === "1";

/**
 * A test that talks to real services. It runs only under `XARABOT_LIVE=1`
 * and otherwise reports skipped. (The switch is an environment variable
 * because Bun 1.4.3 swallows a `--live` flag.)
 */
export const liveTest: typeof test = test.skipIf(!isLive) as typeof test;

/**
 * True when long-running live cases (such as the 30-minute stale takeover)
 * are asked for too, with `XARABOT_LIVE_LONG=1`. It needs `XARABOT_LIVE=1`
 * as well; on its own it switches nothing on.
 */
export const isLiveLong: boolean = isLive && process.env.XARABOT_LIVE_LONG === "1";
