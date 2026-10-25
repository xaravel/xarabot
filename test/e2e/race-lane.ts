import { readFileSync } from "node:fs";
import { fakeArea, liveArea, runRaceLane, type RaceArea, type RaceLaneConfig } from "./race-harness.ts";

/**
 * One race lane as its own OS process (Story 2.12):
 *
 *     bun test/e2e/race-lane.ts <config.json>
 *
 * It runs one `runRaceLane` from the config (`RaceLaneConfig`): in `fake`
 * mode on its own fake forge, in `live` mode on the live area's ledger
 * branch and prefix. It prints the lane's lines (stdout and stderr as the
 * lane wrote them) and exits with the lane's code. Its alerts are recorded,
 * never posted, and it never cleans up the live area: the test that started
 * it does.
 */

async function main(): Promise<number> {
  const [path, ...rest] = Bun.argv.slice(2);
  if (path === undefined || rest.length > 0) {
    console.error("usage: bun test/e2e/race-lane.ts <config.json>");
    return 1;
  }
  const config = JSON.parse(readFileSync(path, "utf8")) as RaceLaneConfig;
  const area: RaceArea =
    config.area.kind === "fake"
      ? fakeArea({ repo: config.host.repo, owner: config.host.owner })
      : await liveArea({ ledgerBranch: config.area.ledgerBranch, prefix: config.area.prefix });
  const alerts: string[] = [];
  const r = await runRaceLane({
    host: config.host,
    connect: area.connect({ view: config.view, alerts, tag: config.tag }),
    control: config.control,
    tag: config.tag,
    out: (l) => console.log(l),
    errOut: (l) => console.error(l),
  });
  for (const a of alerts) console.error(`race lane: recorded alert ${a}`);
  return r.code;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`race lane: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exit(1);
    },
  );
}
