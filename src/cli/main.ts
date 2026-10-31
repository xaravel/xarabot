#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { graphCheck } from "./graph-check.ts";
import { JOIN_USAGE, joinCommand } from "./join.ts";
import { LANE_USAGE, laneCommand } from "./lane-commands.ts";
import { LANE_INSTALL_USAGE, laneInstall } from "./lane-install.ts";
import { LANE_RUN_USAGE, laneRun } from "./lane-run.ts";
import { RULE_USAGE, ruleCommand } from "./rule.ts";

const USAGE = `usage: xarabot [--version] | xarabot graph check | ${JOIN_USAGE} | ${LANE_USAGE} | ${LANE_INSTALL_USAGE} | ${LANE_RUN_USAGE} | ${RULE_USAGE}`;

export async function main(args: readonly string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--version")) {
    console.log(pkg.version);
    return 0;
  }
  if (args.length === 2 && args[0] === "graph" && args[1] === "check") {
    return graphCheck(process.cwd());
  }
  if (args[0] === "join") {
    return joinCommand(args.slice(1), { env: process.env });
  }
  if (args[0] === "wake" || args[0] === "stop") {
    return laneCommand(args, { env: process.env });
  }
  if (args[0] === "lane" && args[1] === "install") {
    return laneInstall(args.slice(2), { env: process.env });
  }
  if (args[0] === "lane" && args[1] === "run") {
    return laneRun(args.slice(2), { env: process.env });
  }
  if (args[0] === "rule") {
    return ruleCommand(args.slice(1), { env: process.env });
  }
  console.error(USAGE);
  return 1;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
