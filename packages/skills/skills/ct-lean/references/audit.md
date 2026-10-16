# Audit a whole repo with ct-lean

Audit the repo like the senior developer who just inherited it and gets paged when it
breaks. Order of importance: **correct, safe, holds under load, tested, fast, lean**. The
owner asked for a report, so give it in full. Use this for "audit this codebase", "find
bloat", "what can I delete". It is a one-shot report that changes nothing.

Adapted from Ponytail 5.1.0's `ponytail-audit` (DietrichGebert, MIT; see
`../LICENSE-ponytail`), rebuilt on CLEO's code graph and project map.

## 1. Map first

- Audit what the owner names: a folder, a package, or the whole repo. Nothing named: the
  whole repo.
- Survey with `cleo map` (stack, architecture, structure, conventions, testing,
  integrations, concerns). `cleo map --focus concerns` goes straight to the risky parts.
- Check the code graph is fresh with `cleo nexus status`; re-index with
  `cleo nexus analyze` if it is stale and you may.
- See how the code hangs together with `cleo nexus clusters` (communities) and
  `cleo nexus flows` (execution flows). Read the main flows end to end: user input, money,
  auth, data writes, background jobs, anything shared between processes.
- Find the expected load (README, deploy config) and say which load you assumed.
- In a big repo, go deep where a mistake costs the most, not file by file. Say which parts
  you did not read.

## 2. Look for

1. **Bug:** wrong result, crash, missed edge case, callers that disagree with what a
   function returns, the same rule applied differently in two places.
2. **Risk:** security holes, privacy (one user's data reaching another), data loss. In
   CLEO: DB opens or table writes outside the chokepoint, swallowed errors, self-attested
   evidence.
3. **Scale:** check-then-write races, the same work done by every process, memory that only
   grows, a query per item, O(n²) on big input, per-process state that must be shared.
4. **Missing test:** risky logic with no test that fails when it breaks. One good test, not
   coverage.
5. **Speed:** big slowdowns are problems; small wins are suggestions.
6. **Lean:** code that should not exist or should be smaller.
   - delete: dead code, unused options, flags and config, speculative features
   - reuse: two helpers doing the same thing (keep one, name the path)
   - stdlib / native: a dependency doing what a few lines or the platform can do
   - yagni: an interface with one implementation, a factory with one product, a wrapper
     that only passes calls through
   - merge: near-copies that must change together
   - split: one function or class doing several unrelated jobs (split by job, never by
     line count)
   - boundary: code in the wrong package (see the AGENTS.md package table)

## 3. Check before you report

- Every finding needs a concrete case. No case, no finding.
- Before calling code unused: `cleo nexus impact <symbol>` shows no callers **and** a grep
  of the whole tree (tests, fixtures, config, string and dynamic references) finds none.
  An empty impact alone never proves it unused.
- A `shortcut:` (or older `ponytail:`) comment that names its limit is a decision, not a
  finding, unless the expected load already crosses it. `cleo lean debt` lists them; one
  with no upgrade trigger is worth a line.
- Propose the smallest fix that works. Prefer fixes that delete code.
- No style taste, no "consider", no vague worries.

## 4. Output

Very simple English. Start with `What this repo does:` in two or three sentences, and the
load you assumed.

Then the findings in three groups, most important first, skipping empty groups: **Must
fix** (bug, security, privacy, data loss, breaks at the expected load), **Should fix**
(risky code without a test, real slowness, duplication, mixed jobs, code that should not
exist), **Nice to have** (small speed-ups, shorter forms).

Number findings across all groups, at most 20; if you left smaller ones out, say how many.
Every finding has four parts (**What this is**, **Problem**, **Fix**, **If we skip it**),
each one or two short sentences, with its `path:line`.

End with:
- `Verdict:` one line: healthy, or what to fix first.
- `Lean: -<N> lines, -<M> dependencies possible.` when lean findings exist.
- `Not checked:` the parts you did not read or could not run.

Nothing found: `What this repo does:`, then `Healthy. Nothing to fix.` and one line on what
you checked. The audit changes no code. In CLEO, file each serious finding as a task so it
does not stay only in chat.
