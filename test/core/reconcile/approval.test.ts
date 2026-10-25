import { describe, expect, test } from "bun:test";
import { standingApproval, type ApprovalReview } from "../../../src/core/reconcile/approval.ts";

const H = "a".repeat(40);
const H0 = "b".repeat(40);
const PARKED = "2026-10-24T10:00:00Z";
const Q = { owner: "alice", head: H, parkedAt: PARKED };

const at = (minutes: number) => new Date(Date.parse(PARKED) + minutes * 60_000).toISOString();
const r = (author: string | null, state: string, commit: string | null, submitted: string | null): ApprovalReview => ({
  author,
  state,
  commit_sha: commit,
  submitted_at: submitted,
});
const approve = (minutes: number, over: Partial<ApprovalReview> = {}): ApprovalReview => ({ ...r("alice", "approved", H, at(minutes)), ...over });

describe("standingApproval", () => {
  test.each([
    ["Approved: the owner approves the head after the park", [approve(5)], 0],
    ["a later commented review does not void it", [approve(5), r("alice", "commented", H, at(6))], 0],
    ["a later pending review does not void it", [approve(5), r("alice", "pending", H, null)], 0],
    ["another login's changes request does not void it", [approve(5), r("bob", "changes_requested", H, at(6))], 0],
    ["the owner's login compares case-insensitively", [approve(5, { author: "Alice" })], 0],
    ["a changes request before the park does not void a later approval", [r("alice", "changes_requested", H, at(-5)), approve(5)], 1],
    ["a changes request superseded by a later approval", [r("alice", "changes_requested", H, at(3)), approve(5)], 1],
    ["the latest by submitted time decides, not list order", [approve(5), r("alice", "changes_requested", H, at(3))], 0],
    ["a tie in submitted time goes to the later review in the list", [r("alice", "changes_requested", H, at(5)), approve(5)], 1],
    ["an older head approved, then the current head approved", [approve(3, { commit_sha: H0 }), approve(5)], 1],
  ] as const)("%s: stands", (_name, reviews, index) => {
    expect(standingApproval(reviews, Q)).toBe(reviews[index] as ApprovalReview);
  });

  test.each([
    ["no reviews", []],
    ["Older head: the approval is of H0, the head is H", [approve(5, { commit_sha: H0 })]],
    ["an approval with no commit SHA", [approve(5, { commit_sha: null })]],
    ["Before the park: submitted at heartbeat_at", [approve(0)]],
    ["Before the park: submitted before heartbeat_at", [approve(-1)]],
    ["Not the owner: another login approves", [approve(5, { author: "bob" })]],
    ["a deleted account's approval", [approve(5, { author: null })]],
    ["Superseded: the owner approves H, then requests changes", [approve(5), r("alice", "changes_requested", H, at(6))]],
    ["Superseded: the approval is dismissed later", [approve(5), r("alice", "dismissed", H, at(6))]],
    ["a tie in submitted time goes to the later changes request", [approve(5), r("alice", "changes_requested", H, at(5))]],
    ["a commented review alone", [r("alice", "commented", H, at(5))]],
    ["a pending review alone", [r("alice", "pending", H, null)]],
    ["an approval with no submitted time", [approve(5, { submitted_at: null })]],
    ["an approval with an unparseable submitted time", [approve(5, { submitted_at: "yesterday" })]],
    ["Re-approval needed: the only approval predates the re-park", [approve(-30)]],
  ] as const)("%s: none", (_name, reviews) => {
    expect(standingApproval(reviews, Q)).toBeNull();
  });

  test("an unparseable park time: none", () => {
    expect(standingApproval([approve(5)], { ...Q, parkedAt: "never" })).toBeNull();
  });

  test("Dismissed, as GitHub reports it: the approval's own state turns dismissed: none", () => {
    expect(standingApproval([approve(5, { state: "dismissed" })], Q)).toBeNull();
    expect(standingApproval([approve(-5, { state: "dismissed" })], { ...Q, parkedAt: null })).toBeNull();
  });
});

describe("standingApproval with no park time (a builder's first park)", () => {
  const FIRST = { ...Q, parkedAt: null };

  test.each([
    ["First park, approved during CI: an approval before the park counts", [approve(-30)], 0],
    ["an approval at the park's time counts", [approve(0)], 0],
    ["an approval after the park counts", [approve(5)], 0],
    ["a changes request superseded by a later approval, both before the park", [r("alice", "changes_requested", H, at(-10)), approve(-5)], 1],
  ] as const)("%s: stands", (_name, reviews, index) => {
    expect(standingApproval(reviews, FIRST)).toBe(reviews[index] as ApprovalReview);
  });

  test.each([
    ["Superseded: an approval before the park, then a changes request", [approve(-30), r("alice", "changes_requested", H, at(-10))]],
    ["Superseded: an approval, then a changes request after the park", [approve(-30), r("alice", "changes_requested", H, at(5))]],
    ["Older head: the approval is of H0", [approve(-30, { commit_sha: H0 })]],
    ["Not the owner", [approve(-30, { author: "bob" })]],
    ["an approval with no submitted time", [approve(-30, { submitted_at: null })]],
  ] as const)("%s: none", (_name, reviews) => {
    expect(standingApproval(reviews, FIRST)).toBeNull();
  });
});
