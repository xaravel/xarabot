/**
 * The daily digest's clock (Story 4.2): today's slot and whether it is due.
 * A leaf module, so `next`'s due rule, the ledger edits and the inbox step
 * share it with no import cycle. Pure.
 */

/** Today's digest slot by `now` (UTC): the ISO instant of `digestTime` (`HH:MM`) on `now`'s UTC day. */
export function digestSlot(now: string, digestTime: string): string {
  const day = new Date(Date.parse(now)).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T${digestTime}:00Z`)).toISOString();
}

/**
 * Whether the daily digest slot has passed unposted: today's `digest_time`
 * (UTC, by `now`) is due when `now` is at or past it and `postedAt` is
 * `null` or before it.
 */
export function digestDue(now: string, digestTime: string, postedAt: string | null): boolean {
  const nowMs = Date.parse(now);
  const slot = Date.parse(digestSlot(now, digestTime));
  if (nowMs < slot) return false;
  return postedAt === null || Date.parse(postedAt) < slot;
}
