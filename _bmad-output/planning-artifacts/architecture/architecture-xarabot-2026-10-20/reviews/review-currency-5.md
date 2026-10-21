---
review: currency (pass 5)
target: ARCHITECTURE-SPINE.md (architecture-xarabot-2026-10-20), uncommitted change "Epic graph moves into .xarabot/epics.yaml"
reviewed: 2026-10-21
lens: Each claim in the change was checked against the installed files, Xaravel's real repo, and Bun 1.4.3 on the Xarabot host. Nothing here is from training data.
---

# Currency review 5: the Epic graph file

## Verdict

**Pass with corrections.** The core claim is true. Stock BMAD 6.12.4 writes `## Epic N:` and `### Story N.M:` headings with a numeric N, and Xaravel's `epics.md` follows that shape for all 74 Epics. But the AD-11 text does not yet hold up against what the tools actually do:

- The stock output has a second set of Epic-like headings (the Epic List).
- BMAD's own parser accepts Story numbers such as `2.6a`.
- `Bun.YAML` always turns the numeric map keys into strings, and it silently drops duplicate keys.

The schema has to settle each of these points, or two loaders will read the same file differently. That is the problem AD-11 says it prevents.

## Method

- Read `.claude/skills/bmad-create-epics-and-stories/` (the template and steps 01 to 04) and `_bmad/_config/manifest.yaml`, which shows version 6.12.4 for core and bmm.
- Read `.claude/skills/bmad-sprint-planning/scripts/sprint_plan.py` and `references/generate-tracking.md`. This is BMAD's own deterministic parser for `epics.md`.
- Read `~/repos/xaravel/_bmad-output/planning-artifacts/epics.md` (8,822 lines), `~/repos/xaravel/stories/*.md` and `~/repos/xaravel/tools/orchestrator/iteration.md`.
- Ran `bun` 1.4.3 (`/opt/homebrew/bin/bun --version` gives `1.4.3`) on a scratch script in `/tmp/currency5/t.ts`. Ran zod 4.6.7 from the earlier `/tmp/ts7run` scratch project (`/tmp/ts7run/zkeys.ts`).
- Fetched bun.com/docs/runtime/yaml.

## Claim 1: the stock template emits `## Epic {{N}}:` and `### Story {{N}}.{{M}}:` with numeric N

**Confirmed, with one catch.**

- `templates/epics-template.md` line 41 is `## Epic {{N}}: {{epic_title_N}}`, with the comment `N = 1, 2, 3...`. Line 47 is `### Story {{N}}.{{M}}: {{story_title_N_M}}`, with the comment `M = 1, 2, 3...`.
- `step-03-create-stories.md` line 82 repeats `### Story {N}.{M}: {story_title}`. It says to process the Epics "in order (Epic 1, Epic 2, etc.)".
- **The catch.** `step-02-design-epics.md` (Step D, lines 131 to 144) tells the agent to fill `{{epics_list}}` under `## Epic List` with **`### Epic 1: [Epic Title]`** headings. A stock `epics.md` therefore has every Epic number twice: once at level 3 in the Epic List, and once at level 2 as the Epic section.
  - BMAD's own parser (`sprint_plan.py` `EPIC_RE = ^#{1,3}\s*Epic\s+(\d+)\s*:?...`, case-insensitive) matches both levels and merges them with `setdefault`.
  - A Xarabot parser that matched on "Epic N:" without the heading level would see each Epic twice. A parser that matched only level 3 would see Epics that have no Stories.
- **BMAD's grammar is looser than "N.M".** `STORY_RE = ^#{2,4}\s*Story\s+(\d+)\.(\d+[a-z]?)` accepts a letter suffix. Its tests include `### Story 2.6a: Split Story, With Punctuation!` and expect the key `2-6a-split-story-with-punctuation`. The sprint-status key grammar (`STORY_KEY_RE`) also allows `[a-z]?`. Split Stories (`2.6a`) are therefore a supported BMAD shape. AD-11 says "N.M" and does not say whether `2.6a` is a Story, an error, or ignored.
- BMAD's parser also skips fenced code blocks, accepts heading levels 1 to 3 for Epics and 2 to 4 for Stories, and makes the colon optional. `generate-tracking.md` also lists `epic-*.md` and a sharded `epics/` folder as normal locations. The spine names only `epics.md`. That fits the "classic shape" rule in AD-13, but it should be stated, not assumed.

## Claim 2: Xaravel's `epics.md` has the same shape, and what an adoption migration must capture

**The shape is confirmed.** There are 74 `## Epic N:` headings, numbered 1 to 74 in a row with no gaps, and 324 `### Story N.M:` headings. Every Story heading has a numeric M and none has a letter suffix. Titles can carry extra text, for example `## Epic 71: Browser tests (post-alpha, outline)`, and that is harmless.

**Differences from stock that a parser must tolerate:**

- Xaravel's Epic List groups Epics under `### Phase K` headings, so its Epic List entries are **`#### Epic N:`** (level 4), not the stock `### Epic N:`. If the parser matches level 2 only, both files work. If it copies BMAD's `#{1,3}` rule, Xaravel's level-4 entries fall outside it, and BMAD's own parser warns that they are "unparsed Epic/Story-like heading" lines.

**How Xaravel expresses order and checkpoints today. A migration must turn all of these into data:**

| Source | Where | What it says |
|---|---|---|
| Runner rule | `tools/orchestrator/iteration.md` step F | "Epics run strictly in order, so a later epic never starts before an earlier one is finished and reviewed." This matches the new serial default. |
| Checkpoint list | `iteration.md` line 15 | `CHECKPOINT EPICS: 8`. This matches the glossary's "(Xaravel: Epic 8)". |
| Epic List preamble | `epics.md` line 814 | "Phases 0–8 run in dependency order ... Epics within one Phase may run in parallel unless an Epic's notes say otherwise." |
| Phase headings | `### Phase 0` to `### Phase 9` | Phase membership: 1–8, 9–16, 17–20, 21–33, 34–39, 40–43, 44–53, 54–61, 62–70, 71–74. |
| Phase notes | Phase 3 (line 1017), Phase 6 (line 1185) | Edges such as "Epic 27 needs Epic 23", "Epic 30 needs Epic 27", "Epic 32 needs Epics 24 and 31", "Epic 33 needs Epic 32", and the order Cookie(44), Session(45) → Http(46, 47) → Routing(48) → View(49, 50) → Foundation(51, 52) → htmx(53). |
| Per-Epic bullets | lines 875, 921, 932, 944, 1097, 1174, 1344 | `**Needs:** Epic 3`, `**Gate:** Phase 1 starts only after this Epic is accepted` (Epic 8), `**Order:** first in Phase 1` (9), `**Order:** after Epic 9` (10), `**Order:** after Epic 31` (32), `**Needs:** Epic 41` (42), `**Needs:** Epic 65` (66). |
| Phase 4 note | line 1108 | "The Maintainer's progress review comes at the end of the Phase". This may be a second checkpoint (Epic 39). It is not in `iteration.md`'s checkpoint list. |
| Non-Epic dependency | Epic 19 | "Depends on the OQ-4 spike outcome." The graph cannot express this. |

What this means:

1. **The serial default matches what Xaravel runs today.** The smallest faithful migration is `8: {depends_on: [7], checkpoint: true}`, and only that, because every later Epic already depends on Epic 8 through the serial chain. Xaravel's checkpoint holds "later epics" (all M > N). AD-12 holds dependents only. The two are the same only while the chain stays serial.
2. **If parallelism is turned on, `epics.md` and `epics.yaml` say different things.** The `epics.md` prose permits parallel work inside a Phase. Turning that on means writing every Phase barrier and every note edge above into `epics.yaml`. A Phase barrier means each Epic depends on every Epic of the previous Phase, or on a join Epic, so that is many `depends_on` entries. The prose stays in `epics.md` and Xarabot ignores it, so the two files can drift apart and no check notices. Which file is authoritative, and whether Phase 4's review is a checkpoint, are Maintainer decisions for the adoption Epic.
3. **This is not new to this change, but it is a current fact.** 47 Xaravel Story headings have no manifest: 19.3, 19.4, 28.3, ..., 60.x, 65.x, 68.x, 69.1, 70.3, and all of the outline-only Epics 71 to 74. AD-11 says "a Story heading in `epics.md` with no manifest ... stops every lane". Against Xaravel's `main` as it is now, validation would stop every lane on its first run. Adoption must either create those manifests first, or AD-11 must exempt something, such as Epics with no manifests yet or outline Epics.

## Claim 3: `Bun.YAML` (1.4.3) parses the proposed map with numeric keys as expected

**The result is not what an "Epic numbers" schema expects. The key type must be settled.** Verified on the host with Bun 1.4.3:

| Input | `Bun.YAML.parse` result |
|---|---|
| `epics: {1: {depends_on: []}, 8: {depends_on: [7], checkpoint: true}}` | keys are **strings** `"1"`, `"8"`; `depends_on` elements are **numbers** `7` |
| `"04": {depends_on: ["3"]}` (quoted) | key `"04"`, `depends_on: ["3"]` (strings) |
| `04:` / `010:` / `0x1F:` / `1e1:` (plain) | normalized to `"4"`, `"10"`, **`"31"`**, **`"10"`**. `010` and `1e1` **collide**, and the later one silently replaces the earlier |
| `1: …` then `"1": …`, or `1:` twice | **no error**, last one wins, one key left |
| `checkpoint: yes` / `on` / `"true"` | strings `"yes"` / `"on"` / `"true"` (YAML 1.2 core schema; only `true`/`True` give a boolean) |
| `depends_on:` (empty) or `~` | `null` |
| `epics:` (empty) | `null` |
| two documents split by `---` | an **array** of documents. The docs confirm: "returns an array" |
| `Bun.YAML.stringify({epics: {1: …}})` | writes `"1":`, a quoted string key |

bun.com/docs/runtime/yaml confirms YAML 1.2 and `SyntaxError` on invalid input. It says nothing about duplicate keys or non-string keys. The table above is what Bun actually does.

zod 4.6.7 (the `[ASSUMPTION: zod 4]` in AD-27): `z.record(z.number().int().positive(), entry)` **accepts** these string keys. TypeScript then infers `Record<number, …>`, but `Object.keys` still returns strings at runtime. So `depends_on.includes(key)` and `key === manifest.epic` are always false. Xaravel's manifests carry `epic: 1` as an integer. The same schema also accepts the quoted key `"04"` as a separate entry from `"4"`, and rejects `"0"`, `"-1"`, `"1.5"` and `"1e1"`.

**What the schema must settle (AD-11 or AD-27):**

- **Key grammar.** Keys must match `^[1-9][0-9]*$` (canonical decimal, so no `"04"`). The loader turns them into a `Map<number, Entry>` once, in `src/core/schemas/`. Every other part of the code compares integers. Also decide whether a quoted `"8":` is allowed. `Bun.YAML.stringify` writes it that way, so a round trip produces quoted keys.
- **`depends_on`.** An array of positive integers. Reject strings and `null`, and say whether an omitted `depends_on` means `[]` or "use the serial default". The current text says an entry "has `depends_on`", but does not say it is required.
- **`checkpoint`.** Accept only the literal `true`, through a strict object, so that `checkpoint: yes` is an invalid file and not a silent no-checkpoint.
- **Duplicate keys cannot be detected after `Bun.YAML.parse`.** A file that names Epic 8 twice, once with `checkpoint: true` and once without, loses one entry without any error. A checkpoint is exactly what AD-11 says must never be lost unseen. Either scan the raw text for duplicate keys before parsing, or state the limit, which owner review of this Protected Path may cover. Either way, "an invalid file" in AD-11 does not catch it today.
- **Top-level shape.** Reject a multi-document file (an array) and an empty `epics:` (`null`), or define an empty `epics` as "all serial".

## Other checks

- **The serial default rule matches Xaravel.** The rule says "next lower Epic number present", which handles gaps. Xaravel has none.
- The **spec memlog** calls the default "the Epic numbered just below it", while the spine says "next lower Epic number present". These differ only when there are gaps, and the spine's wording is the more precise one. SPEC.md CAP-2 uses "the Epic numbered just below it" too. That is low severity, but worth aligning so a gap such as 1, 2, 5 does not leave Epic 5 with no dependency.
- **`.xarabot/**` being refused to builders (AD-30) and owner-gated (AD-16)** is consistent with the Protected Path constraint. No outside facts are involved.

## Findings

| # | Sev | Finding | Fix |
|---|---|---|---|
| F1 | High | `Bun.YAML` turns numeric keys into strings, while `depends_on` and manifest `epic` stay numbers. zod's numeric record key hides this in the types. | In AD-11/AD-27, define keys as canonical decimal strings (`^[1-9][0-9]*$`) that the loader turns into a `Map<number, Entry>` in `src/core/schemas/`. `depends_on` holds positive integers. `checkpoint` accepts the literal `true` only, in a strict object. |
| F2 | High | `Bun.YAML` silently keeps the last of duplicate keys (`8:` vs `"8":`, `010` vs `1e1`), so a duplicate entry can drop `checkpoint: true` while the file still counts as valid. | Make a duplicate Epic key an invalid file, checked on the raw text or through a parse that reports duplicates. Or state the limit in AD-11 and rely on owner review. |
| F3 | Medium | Stock `epics.md` has `### Epic N:` in the Epic List as well as `## Epic N:` sections (Xaravel uses `#### Epic N:`), and BMAD's parser accepts `### Story 2.6a:`. | In AD-11, state the exact grammar: Epic = level-2 `## Epic <int>:` only, Story = level-3 `### Story <int>.<id>:` where `<id>` is `\d+[a-z]?` (as in BMAD's `STORY_RE`), outside fenced code. Say what a letter suffix does to Story order and manifest keys. |
| F4 | Medium | Against Xaravel's `main` today, 47 Story headings (including all of Epics 71 to 74, which are outline only) have no manifest, so AD-11 validation stops every lane on adoption. | In the adoption Epic, create the manifests first, or have AD-11 exempt Epics with no manifests or outline Epics. Maintainer decision. |
| F5 | Medium | Xaravel's ordering facts are prose: Phases, the "parallel within a Phase" preamble, Phase 3 and 6 notes, and `Needs`/`Order`/`Gate` bullets. Its checkpoints live only in `iteration.md` (`8`, plus a possible Phase 4 review). Xarabot will ignore all of the prose. | Record in the spine's adoption notes (or Xaravel's adoption Epic) that the migration writes `8: {depends_on: [7], checkpoint: true}` for serial parity. Enabling Phase parallelism needs a Maintainer ruling on which file is authoritative and on whether Phase 4's review is a checkpoint. |
| F6 | Low | The spec and memlog say "the Epic numbered just below it", while the spine says "the next lower Epic number present". These diverge when the numbers have gaps. | Use the spine's wording in SPEC CAP-2 and the glossary, through `bmad-spec`. |
| F7 | Low | Multi-document YAML parses to an array, and an empty `epics:` parses to `null`. | The schema rejects an array at the top level. Define whether `epics: null` or `{}` means "all serial". |

## Not confirmed

- Whether a future BMAD version changes the Epic List heading level or the Story grammar. Only 6.12.4 was checked.
- Whether zod 4 is the final schema library. It is still `[ASSUMPTION]` in AD-27. The F1 key-type problem applies to any validator, because it comes from `Bun.YAML` returning plain objects.
- Whether Phase 4's "Maintainer's progress review" is meant as a checkpoint. Only the Maintainer can say.
