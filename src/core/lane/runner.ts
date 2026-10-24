import { err, ok, type Result } from "../result.ts";
import type { HostConfig } from "../schemas/host.ts";
import type { Policy } from "../schemas/policy.ts";

/**
 * The pinned runner and the start checks (FR1, NFR15, AR22, AR26, AR34),
 * pure. A runner version is both a git tag and the folder name under
 * `~/.xarabot/runner/`, so it is a plain name with no `..`. The lane folder's
 * `runner` file names the version the launcher runs; `failed-starts` counts
 * refused starts in a row, and the third writes the lane's `STOP`.
 */

/** A runner version: a git tag and a folder name. */
export const RUNNER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

/** Refused starts in a row before the lane writes its own `STOP`. */
export const MAX_FAILED_STARTS = 3;

/** The builder lanes a host runs when `XARABOT_MAX_BUILDERS` is unset (Epic 1). */
export const DEFAULT_MAX_BUILDERS = 1;

export function checkRunnerVersion(v: string): Result<string, "invalid"> {
  if (!RUNNER_VERSION.test(v) || v.includes("..")) {
    return err("invalid", `runner version ${JSON.stringify(v)} is not a plain version name ([A-Za-z0-9._+-], at most 100, no ..)`);
  }
  return ok(v);
}

/** The version from the first line of a `runner` file. */
export function parseRunnerFile(text: string): Result<string, "invalid"> {
  const first = text.split("\n")[0] ?? "";
  if (first === "") return err("invalid", "runner file: the first line is empty");
  return checkRunnerVersion(first);
}

/** The `runner` file's text for `version`. */
export function runnerFileText(version: string): string {
  return `${version}\n`;
}

/** The count in a `failed-starts` file; anything but a whole number reads as 0. */
export function parseFailedStarts(text: string): number {
  const first = (text.split("\n")[0] ?? "").trim();
  return /^[0-9]{1,6}$/.test(first) ? Number(first) : 0;
}

/** The count after one more refused start, and whether it stops the lane. */
export function afterFailedStart(count: number): { readonly count: number; readonly stop: boolean } {
  const next = (Number.isSafeInteger(count) && count > 0 ? count : 0) + 1;
  return { count: next, stop: next >= MAX_FAILED_STARTS };
}

/** `XARABOT_MAX_BUILDERS`: unset or empty is 1, a positive integer is itself, anything else is an error. */
export function builderLimit(raw: string | undefined): Result<number, "invalid"> {
  if (raw === undefined || raw === "") return ok(DEFAULT_MAX_BUILDERS);
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) return err("invalid", `XARABOT_MAX_BUILDERS ${JSON.stringify(raw)} is not a positive integer`);
  return ok(Number(raw));
}

/**
 * Refuses a builder lane when `host.yaml` has more builder lanes, across all
 * repos, than `limit`. A coordinator is never refused here.
 */
export function builderRefusal(host: HostConfig, laneName: string, limit: number): Result<void, "refused"> {
  const lane = Object.hasOwn(host.lanes, laneName) ? host.lanes[laneName] : undefined;
  if (lane === undefined) return err("refused", `lane ${JSON.stringify(laneName)} is not in host.yaml`);
  if (lane.role !== "builder") return ok(undefined);
  const builders = Object.keys(host.lanes)
    .filter((name) => host.lanes[name]?.role === "builder")
    .sort();
  if (builders.length > limit) {
    return err("refused", `host.yaml has ${builders.length} builder lanes (${builders.join(", ")}), more than XARABOT_MAX_BUILDERS=${limit}`);
  }
  return ok(undefined);
}

/** Refuses an agent the policy does not allow unattended. */
export function unattendedRefusal(policy: Pick<Policy, "unattended_adapters">, agent: string): Result<void, "refused"> {
  if ((policy.unattended_adapters as readonly string[]).includes(agent)) return ok(undefined);
  const allowed = policy.unattended_adapters.length === 0 ? "none" : policy.unattended_adapters.join(", ");
  return err("refused", `agent ${agent} is not in .xarabot/policy.yaml unattended_adapters (allowed: ${allowed})`);
}
