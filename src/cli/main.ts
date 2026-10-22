#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };

const USAGE = "usage: xarabot [--version]";

export function main(args: readonly string[]): number {
  if (args.length === 0 || (args.length === 1 && args[0] === "--version")) {
    console.log(pkg.version);
    return 0;
  }
  console.error(USAGE);
  return 1;
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)));
}
