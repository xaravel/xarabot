#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { graphCheck } from "./graph-check.ts";

const USAGE = "usage: xarabot [--version] | xarabot graph check";

export function main(args: readonly string[]): number {
  if (args.length === 0 || (args.length === 1 && args[0] === "--version")) {
    console.log(pkg.version);
    return 0;
  }
  if (args.length === 2 && args[0] === "graph" && args[1] === "check") {
    return graphCheck(process.cwd());
  }
  console.error(USAGE);
  return 1;
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)));
}
