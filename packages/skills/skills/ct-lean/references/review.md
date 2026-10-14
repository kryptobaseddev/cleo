# Review a change with ct-lean

Review a change like the senior developer who gets paged when it breaks. Order of
importance: **correct, safe, holds under load, tested, fast, lean**. Lean still matters:
every extra line must be read, tested and fixed later. The owner asked for a report, so
give it in full. Use this for "review this", "review my PR", "review the last commit",
and for your own diff before `cleo verify`.

Adapted from Ponytail 5.1.0's `ponytail-review` (DietrichGebert, MIT; see
`../LICENSE-ponytail`), rebuilt on CLEO's code graph and evidence rules.

## 1. Understand first

- Review what the owner names: uncommitted or staged changes, a branch, a PR, or files.
  Nothing named: the uncommitted changes, or the last commit if there are none.
- Check the code graph is fresh with `cleo nexus status`. A stale index means its answers
  below are incomplete; say so under **Not checked**.
- Read the diff, then the code it touches. For every changed function, run
  `cleo nexus context <symbol>` (callers, callees, the flows it belongs to) and
  `cleo nexus impact <symbol>` (blast radius). These are parsed from source, so they are
  exact where grep guesses. Static analysis cannot see dynamic or string references, so
  also grep for the name before you claim nothing else calls it.
- For a PR or commit range, `cleo nexus diff` shows new and removed relations and broken
  call chains between the two commits.
- Trace the real flow: where data comes in, what is stored, what goes out.
- Find the expected load in the repo (README, deploy config): one person running a script,
  or many users and processes at once. Judge scale against it and say which load you assumed.

## 2. Look for

1. **Bug:** wrong result, crash, missed edge case (empty, zero, last item, rounding, time
   zones), a caller broken by the change, a fix in one caller while the shared function
   stays broken.
2. **Risk:** security holes (injection, weak randomness, secrets, unchecked user input),
   privacy (one user's data reaching another), data loss (swallowed errors, writes in the
   wrong order, no transaction). In CLEO: a raw DB open or table write outside the
   chokepoint, a `catch (err: unknown)`, an evidence gate self-attested.
3. **Scale:** fine for one user, wrong for many: check-then-write races, the same work done
   by every process, memory or lists that only grow, a query per item, O(n²) on big input,
   per-process state that must be shared.
4. **Missing test:** risky new logic (a branch, a parser, money, security, a data write, a
   bug fix) with no test that fails when it breaks. One good test, not coverage.
5. **Speed:** big slowdowns are problems. Small wins (work repeated in a hot loop) are
   suggestions.
6. **Lean:** code that should not exist or should be smaller.
   - delete: dead code, unused options, speculative features
   - reuse: the repo already has this helper, contract or chokepoint (name the path)
   - stdlib / native: the platform already does it; a new dependency for a few lines
   - yagni: an abstraction with one implementation, config nobody sets
   - merge: near-copies that must change together
   - split: one function doing several unrelated jobs. Split by job, never by line count.
   - boundary: code in the wrong package (see the AGENTS.md package table)

## 3. Check before you report

- Every finding needs a concrete case: "this input or situation leads to this wrong
  result". No case, no finding.
- Re-read the lines and confirm: the caller exists (`cleo nexus context`), the value can
  really be empty, the code really is unused (no callers in `cleo nexus impact` **and** no
  string or dynamic reference in a grep).
- A shortcut marked with a `shortcut:` (or older `ponytail:`) comment that names its limit
  is a decision, not a finding, unless the expected load already crosses it.
  `cleo lean debt` lists them all.
- Propose the smallest fix that works. Prefer fixes that delete code. Never add layers,
  frameworks or config the problem does not need.
- No style taste, no "consider", no vague worries.

## 4. Output

Very simple English: short sentences, everyday words. Explain a technical term the first
time you use it.

Start with `What this change does:` in two or three sentences.

Then the findings in three groups, skipping empty groups:
- **Must fix:** bug, security, privacy, data loss, breaks at the expected load.
- **Should fix:** risky code without a test, real slowness, duplication, a function that
  mixes jobs, code that should not exist.
- **Nice to have:** small speed-ups, shorter forms.

Number findings across all groups, so the owner can say "fix 2 and 5". Every finding has
four parts, each one or two short sentences:

2. **Orders land on the wrong day** (`billing/close_day.py:L40-52`)
   - **What this is:** At midnight this job closes the day and bills all orders of that day.
   - **Problem:** It takes "today" from the server clock, which runs in UTC. An order placed
     at 00:30 in Berlin is billed on the day before.
   - **Fix:** Compute the day once in the shop's time zone. One line, nothing else changes.
   - **If we skip it:** Late orders show the wrong date, and accounting fixes them by hand.

End with:
- `Verdict: Ship.` or `Verdict: fix 1 and 3 first.`
- `Lean: -<N> lines possible.` when lean findings exist.
- `Not checked:` one line, if something mattered and you could not check it (a stale
  `cleo nexus status`, an untested path, a harness you could not run).

Nothing found: `What this change does:`, then `Looks good. Ship.` and one line on what you
checked. The review lists findings and changes no code. In CLEO, file each serious
finding as a task (`cleo add --type task --parent <epic> --title ... --acceptance "..."`)
so none stays only in chat.
