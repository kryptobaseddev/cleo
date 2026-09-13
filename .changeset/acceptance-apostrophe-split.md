---
id: acceptance-apostrophe-split
tasks: [T12175]
kind: fix
summary: A prose apostrophe no longer swallows every acceptance criterion after it
---

**gh#1321, defect 1 — and the reported mechanism was wrong.** The issue attributes
it to input length. It is an **apostrophe**.

Measured against `parseAcceptanceCriteria` before the fix:

```
 5 | plain 5 ACs                   -> ["a","b","c","d","e"]
 2 | "ac one|the user doesn't care|ac three"
 2 | "ac one|the user's token|ac three"
 3 | "ac one|doesn't|can't|ac four"      ← two apostrophes, a DIFFERENT wrong answer
 2 | "a|see (note|c|d|e"                 ← unbalanced bracket, same shape
 5 | 804 characters, no quotes           ← length is irrelevant
```

`splitAcceptance` is a quote- and bracket-aware tokenizer added under T9839/gh#409
so that `ENUM (a|b|c)` and `'realtime-token'|'batch'` survive tokenizing. Its rule
is that a quote opens a context which *only the matching close* can end — so a
prose apostrophe opened a context nothing could close, and every remaining
delimiter was absorbed.

**The trigger is not exotic input; it is ordinary English.** `doesn't`, `user's`,
`can't`.

Length correlates with *severity*, not occurrence: an unmatched quote swallows
the remainder, so longer input loses more criteria. In a four-sample set where
the longest also contained an apostrophe, the two are indistinguishable — which
is exactly the trap, since "stops working past some length" sends an implementer
hunting for a cap that does not exist.

Two narrow rules, both preserving gh#409:

1. A quote opens a context **only when a matching close exists later** *and* it
   sits at a token boundary. An apostrophe immediately after a letter or digit is
   prose, never a quote opener. gh#409's quotes are balanced by construction and
   sit at boundaries, so they are untouched.
2. A bracket opens depth **only when its partner exists later**. An unbalanced
   `(` groups nothing, so it is a literal.

10/10 on a matrix covering both defects and every gh#409 case; 24/24 in the file;
724/724 across the 45 acceptance-related core suites.

**Two existing tests changed expectations**, and they were pinning the corruption
— their own docblocks described the swallowing as intended behaviour
(`['AC1', '(unclosed|AC2']` and `['[not-json|AC2']`). Both now assert the
recovered criteria. That is a deliberate behavioural change, flagged rather than
buried.

Defect 2 of the issue (a task born at `pipelineStage=implementation`, locking AC
immediately) is **not** addressed here — it is a lifecycle question that may be
deliberate for some creation paths, and it deserves its own decision rather than
being bundled with a tokenizer fix.
