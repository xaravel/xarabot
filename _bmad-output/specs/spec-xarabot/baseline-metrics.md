# Baseline metrics

Xaravel's one-lane loop, measured over 73 hours (from the brief, 2026-10-20). Xarabot success is judged against these.

| Measure | Value |
|---|---|
| Iterations | 194 |
| Stories merged | 51 |
| Story PR, open to merged | median 7 minutes |
| Story merges inside an Epic | about 44 minutes apart |
| Time inside Epics | 48 h |
| Time between Epics (retros, their action items, waits on the Maintainer) | 24 h |
| Individual gaps between Epics | 3.2, 5.0, 7.8, 0.5, 4.3, 2.9 h |
| Stories passing review the first time (Opus) | 45 of 51 |
| CI-fix commits | 8 in total |

Derived: about 0.70 Stories per hour overall.

Observed in Xaravel issue #10: after Epics 4, 5 and 6, the loop spent one iteration (about 4–8 minutes each, 4 per Epic) only to route each Maintainer-owned action item into `waiting_on_maintainer`.
