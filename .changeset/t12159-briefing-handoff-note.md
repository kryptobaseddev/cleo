---
id: t12159-briefing-handoff-note
tasks: [T12159]
kind: fix
summary: briefing discloses a note-free handoff instead of omitting the key, so a lost handoff and a note-free one are no longer byte-identical
---

Closes GH #1277.

`briefing.data.lastSession.handoff` omitted `note` entirely when none was recorded. `cleanHandoff` strips the empty arrays around it, so what reached the consumer **read as a complete handoff** — a lost handoff and a note-free handoff were byte-identical. The human renderer was silent for the same reason, so neither surface disclosed it.

## The producer assigned the key only when it had a value

```ts
// packages/core/src/sessions/handoff.ts — before
const handoff: HandoffData = { lastTask, tasksCompleted, /* … */ openBugs };
if (options.note) {
  handoff.note = options.note;
}
```

Note the guard is truthiness, not nullishness: an explicitly **empty** note was also dropped, so "recorded nothing" and "recorded an empty string" collapsed together too — the same information loss one layer down. `nextAction` sat directly beneath it with an identical guard.

`note` is now `string | null` and always emitted, alongside `noteChars` — which lets a consumer tell "no note" from "note withheld by a projection" without carrying the note itself.

## Four surfaces, because fixing one producer is what failed the last two times

1. **`computeHandoff`** emits `note: options.note ?? null` and `noteChars`.
2. **The docs-based fallback producer** (`briefing.ts`, T9967) — a **second** construction site that neither the issue nor the review identified. Making `HandoffData.note` non-optional is what surfaced it; the typechecker found it, not a reader. Had only the first producer been fixed, the contract rule below would have fired from the fallback path, which is a confusing place to debug from.
3. **`cleo session handoff`** mirrors the same shape.
4. **The human renderer** prints `Note: (none recorded)` instead of rendering nothing.

## The part that makes it stay fixed

This is the third instance of the same family — GH #1243 (`cleo show` omitting `description` entirely), GH #1242 (an undisclosed truncated page), now this. Each was fixed at its producer and re-emerged somewhere else. So the load-bearing change is not any of the four above:

```ts
// the default contract cleo briefing evaluates on every call
'lastSession.handoff': { requireKeys: ['note'] },
```

`BriefingFieldRule` gains `requireKeys`, and `ContractViolation.kind` gains `missing-key`. A handoff missing `note` is now a **contract violation** rather than a shape that merely happens to be right today.

Three deliberate details:

- **`null` satisfies the rule; a missing key does not.** That distinction is the entire point.
- **The check runs before the array guard**, because it is the only rule that applies to object-valued fields. Every existing rule operates on lists.
- **A field that is absent entirely is skipped.** A fresh project has no last session, and firing there would make the rule permanently red — and a rule that is always red is a rule nobody reads.

`cleanHandoff`'s TSDoc now names `note`/`noteChars` as deliberately-retained keys with a pointer to the contract rule, so a future diet pass cannot quietly strip them back out.

## Tests

Eight, in `handoff-note-disclosure.test.ts`. Three fail on current code: the missing-key violation, the default contract carrying the rule, and the renderer's `(none recorded)` line. The other three pin behaviour that must not change — an explicit `null` is accepted, a null `lastSession` does not fire, and a real note still renders verbatim.

`getDefaultBriefingContract()` is exported so the rules are assertable in isolation. A rule that exists only inline at its call site can be deleted without a test noticing, which is how this shape regressed twice before.

## `nextAction` is fixed here too — a deliberate scope expansion

An earlier draft left `nextAction` out to keep this PR to the reported defect, and flagged it for a separate issue. That was wrong, for one reason: the contract rule this PR introduces is `'lastSession.handoff': { requireKeys: […] }`. **A rule that guards one field of an object while a field with the identical defect sits beside it knowingly under-covers the object it names** — and it names the whole handoff.

`nextAction` had the same declaration (`nextAction?: string`), the same truthiness guard (`if (options.nextAction)`), and the same consequence. It is now `string | null`, always emitted, with `nextActionChars`, an explicit `(none set)` line in the human renderer, and a place in `requireKeys`:

```ts
'lastSession.handoff': { requireKeys: ['note', 'nextAction'] },
```

One test pins the half-fix specifically: a handoff that discloses `note` but still omits `nextAction` must produce exactly one `missing-key` violation naming `nextAction`. A future change that fixes one twin and not the other fails rather than passing quietly.
