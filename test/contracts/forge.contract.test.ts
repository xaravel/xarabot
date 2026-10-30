import { createFakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { forgeContract, type ForgeControlName } from "./forge.contract.ts";

/** Every contract control; `satisfies` fails `tsc` when one is added or removed. */
const CONTROLS = {
  makeCommit: true,
  setMain: true,
  setNow: true,
  writeForeignLedger: true,
  setChecks: true,
  setCiLog: true,
  injectError: true,
  refusePushes: true,
  mergeQueueHead: true,
  addReview: true,
  comments: true,
  reviewBodies: true,
  queue: true,
  trace: true,
  inboxes: true,
  inboxComments: true,
  addInboxComment: true,
  addInboxCommentBeforeRead: true,
} as const satisfies Record<ForgeControlName, true>;
const ALL_CONTROLS = Object.keys(CONTROLS) as ForgeControlName[];

forgeContract({
  name: "fake",
  controls: ALL_CONTROLS,
  make: () => createFakeForge(),
});

// A harness offering no controls: the cases needing one report skipped.
forgeContract({
  name: "fake without controls",
  controls: [],
  make: () => ({ forge: createFakeForge().forge, control: {} }),
});
