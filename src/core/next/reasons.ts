/**
 * Why `next` passed a Story or an Epic over. Its own module, imported by
 * `next`, the coordinator side and the Epic holds, so none of them imports
 * another for a type and the `core/next` import graph has no cycle. Pure.
 */

export type ReasonCode =
  | "reconcile-not-due"
  | "unmanifested"
  | "unclaimable"
  | "dependency-epic"
  | "retro-rejected"
  | "epic-context"
  | "record-state"
  | "depends-on"
  | "escalation"
  | "overlap"
  | "planning-held"
  | "live-evidence";

/** Why a Story or Epic was passed over. `subject` is `epic:<N>` or a unit id. */
export type Reason = { readonly subject: string; readonly code: ReasonCode; readonly message: string };
