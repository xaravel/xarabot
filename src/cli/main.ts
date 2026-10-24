#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { graphCheck } from "./graph-check.ts";
import { LANE_USAGE, laneCommand } from "./lane-commands.ts";

const USAGE = `usage: xarabot [--version] | xarabot graph check | ${LANE_USAGE}`;

export async function main(args: readonly string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--version")) {
    console.log(pkg.version);
    return 0;
  }
  if (args.length === 2 && args[0] === "graph" && args[1] === "check") {
    return graphCheck(process.cwd());
  }
  if (args[0] === "wake" || args[0] === "stop") {
    return laneCommand(args, { env: process.env });
  }
  console.error(USAGE);
  return 1;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
