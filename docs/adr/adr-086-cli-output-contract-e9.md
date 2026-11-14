---
id: adr-086-cli-output-contract-e9
tasks: [T9934, T9927, T9855]
kind: adr
summary: ADR-086 — CLI Output Contract (E9 of Saga T9855). Codifies stdout=envelope-only discipline, --field/--output/--summary/--quiet projection flags, and minimal-by-default mutate envelopes so agents stop piping cleo output through tail/jq/python.
---

# ADR-086: CLI Output Contract (E9 of Saga T9855)

- **Status**: Accepted
- **Date**: 2026-05-24
- **Author**: cleo-prime (T9934 worker)
- **Tags**: cli, output, envelope, agent-contract, stdout, stderr, e9, saga-t9855
- **Task**: T9934 (T9.7 — E9 closeout doc)
- **Epic**: T9927 (E9-CLI-OUTPUT-CONTRACT)
- **Saga**: T9855 (SG-TEMPLATE-CONFIG-SSOT)
- **Related ADRs**: ADR-039 (LAFS envelope shape), ADR-076 (canonical docs routing), ADR-077 (human render contract — E11)
- **Related Tasks**: T9928 (stdout-envelope-only), T9929 (--field jsonpointer), T9930 (--output mode), T9931 (minimal mutate envelopes), T9932 (--summary), T9933 (--quiet), T9924 (stdout-write allowlist lint), T10135 (stdout-discipline lint)

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## §1 Context

Agents that consume the `cleo` CLI need predictable, parseable output. Before Epic
T9927 shipped, the response surface had three contract gaps that caused agents to
fall back to shell tooling (`tail -1`, `head -c N`, `jq`, `python3 -c json.load`,
`grep`) to extract usable signal from `cleo` invocations:

1. **stdout contamination.** Sub-step operations (`cleo orchestrate spawn`, worktree
   provisioning, git operations) leaked Pino WARN lines, `[LocalBackend]` markers,
   `[worktree] symlink` notices, and `failed to delete branch` strings directly to
   stdout. Agents had to `tail -1` to grab the actual LAFS envelope.

2. **Full envelopes by default for trivial ops.** `cleo show T9855` returned
   ~4 KiB of payload when the agent only wanted to confirm existence. `cleo list
   --parent <epic>` returned full task objects when the agent only wanted IDs to
   iterate over. Mutate ops (`add`, `add-batch`, `update`, `complete`) returned
   the full record set when the agent only needed the affected count.

3. **Zero output-projection flags.** `cleo show`, `cleo add`, `cleo update`,
   `cleo find` had no `--field`, `--format`, `--output`, `--select`, or
   `--silent` flag. Agents resorted to `cleo show … | jq -r '.data.task.id'`
   for every scalar extract — fragile, slow, and indistinguishable in transcripts
   from "agent laziness." The root cause was the CLI itself.

Epic T9927 (E9-CLI-OUTPUT-CONTRACT) closed all three gaps via six
sibling-task PRs (T9928–T9933) plus two CI gates (T9924, T10135). This ADR
codifies the resulting contract so that future CLI additions inherit the same
shape without re-litigating it per command.

This ADR is the **emission contract**. The **shape contract** for the envelope
itself is ADR-039 (LAFS envelope schema). The **human-readable render contract**
is ADR-077 (E11 — `RenderableEnvelope<T>` discriminator + render registry).
Together, E8 (shape) + E9 (emission) + E11 (human render) make the `cleo`
response surface fully agent-optimal.

---

## §2 Decision

### §2.1 stdout = envelope-only (T9928)

The stdout stream of every `cleo` subcommand MUST carry exactly ONE LAFS
envelope: a single JSON object terminated by a single trailing newline. No
other bytes. No log lines. No progress markers. No interactive prompts.

All sub-step logs, warnings, progress messages, deprecation notices, and
informational chatter MUST route through Pino → stderr. Two CI gates enforce
this invariant:

- `scripts/lint-stdout-discipline.mjs` (T10135) — package-prefix allowlist of
  paths that MAY write to stdout (the canonical render SSoT and the CLI
  dispatcher only).
- `scripts/lint-stdout-write-allowlist.mjs` (T9924) — stricter per-line gate
  layered ON TOP of T10135. Every `process.stdout.write` outside
  `packages/cleo/src/cli/renderers/**` and `packages/core/src/render/**` MUST
  carry an explicit allowlist comment with a justification.

Both gates run in baseline mode by default and fail CI on regressions
(net-add). The current baselines are committed and ratchet downward as legacy
sites migrate.

### §2.2 `--field <jsonpointer>` (T9929)

Every read+mutate operation that emits a LAFS envelope MUST support
`--field <jsonpointer>` for scalar extraction. The flag takes an RFC 6901
JSON Pointer rooted at the envelope (`/data/task/id`, `/data/count`,
`/meta/requestId`) and emits the resolved value as a newline-terminated raw
string. No JSON wrapper. No quoting of strings. Arrays of scalars emit one
value per line.

```bash
# Before
cleo add 'Foo' --type task --acceptance "..." | jq -r '.data.task.id'

# After
cleo add 'Foo' --type task --acceptance "..." --field /data/task/id
# → "T9920\n"
```

Pointer-not-found returns the canonical `E_NOT_FOUND` envelope (code 4) so
shell scripts can branch on exit code.

### §2.3 `--output {envelope|id|table|count|silent}` (T9930)

Every operation MUST support `--output <mode>` where:

| Mode       | stdout content                                                  |
|------------|-----------------------------------------------------------------|
| `envelope` | Full LAFS envelope (default; identical to pre-T9930 behavior)   |
| `id`       | Newline-delimited IDs of affected resources                     |
| `table`    | Tab-separated values, one row per record, no header             |
| `count`    | Single integer: number of affected rows                         |
| `silent`   | Nothing on stdout. Exit code is the only signal                 |

`--field` and `--output` are mutually exclusive on a single invocation.
Combining them returns `E_VALIDATION`. `--output id` is the canonical pipeline
form for loops:

```bash
cleo list --parent T9927 --output id | while read child; do
  cleo show "$child" --field /data/task/status
done
```

### §2.4 Minimal-by-default mutate envelopes (T9931)

`cleo add`, `cleo add-batch`, `cleo update`, and `cleo complete` MUST return
a minimal envelope by default:

```json
{
  "success": true,
  "data": { "count": 1, "ids": ["T9920"] },
  "meta": { "operation": "tasks.add", "requestId": "...", "duration_ms": 12 }
}
```

The full task record(s) MUST NOT appear in the default envelope. Agents that
need the full record opt back in via `--full` (or, equivalently,
`--include=full`). This change is breaking for any tool that pre-T9931 read
mutate envelopes for the full `data.task` body; the migration path is
documented in the T9931 PR description.

### §2.5 `--summary` for read ops (T9932)

`cleo show` and `cleo list` MUST support `--summary` returning one-line
records of the shape `{id, title, status}` (or domain-equivalent) instead of
full records. `--summary` and `--full` are mutually exclusive on a single
invocation.

### §2.6 `--quiet` (T9933)

`--quiet` MUST suppress all non-error stderr output from the invocation —
including Pino INFO/DEBUG/WARN lines, sub-step progress markers, and
routing notices. Errors (Pino ERROR level and above) still land on stderr.

`--quiet` is composable with `--output {id|table|count|silent}` and `--field`
to produce fully clean shell pipelines:

```bash
# Fully clean pipeline — stdout has IDs only, stderr is empty unless an error fires
id=$(cleo add 'Foo' --acceptance "..." --quiet --field /data/task/id)
```

### §2.7 Error envelopes

Errors MUST land on BOTH stdout (as a LAFS error envelope, so `JSON.parse`
of stdout is always successful) AND stderr (as a one-line human-readable
summary). Exit code reflects the canonical `codeName` (e.g. `E_NOT_FOUND`
→ 4, `E_VALIDATION` → 6, `E_PARENT_NOT_FOUND` → 10). Agents that route
`2>/dev/null` still receive a parseable envelope on stdout; agents that
route `>/dev/null` still see the human summary on stderr.

---

## §3 Consequences

### §3.1 Positive

- **Agents stop piping through `tail`/`jq`/`python`.** Every common shape —
  scalar extract, ID list, count, table — has a first-class flag. Transcripts
  no longer show shell-tool patches around CLI gaps.
- **Stdout is `JSON.parse`-safe by construction.** No more "tail -1 to peel
  off the log line." The two CI gates (T9924 + T10135) regression-lock this
  invariant.
- **Mutate ops are O(1) by default.** Bulk `add-batch` over hundreds of
  tasks no longer ships the full record set per call. Agents that want the
  full set opt in with `--full`.
- **`--quiet` makes `cleo` first-class in shell pipelines.** No need for
  `2>/dev/null` boilerplate when the operation is known-safe.

### §3.2 Negative / migration burden

- **T9931 is a breaking change** for tools that read `data.task` from mutate
  envelopes. The default shape is now `{count, ids[]}`. Mitigation: `--full`
  flag preserves the legacy behavior; migration documented in the T9931 PR.
- **Two CI gates with separate baselines.** T9924 and T10135 cover overlapping
  surfaces but use different rule shapes (per-line vs path-prefix). The
  baselines must be refreshed together when a legacy site migrates;
  forgetting one yields a confusing CI failure. The
  `chore(T10162): refresh stdout-discipline + stdout-write-allowlist baselines`
  commit pattern is the canonical refresh.
- **Pino-only logger surface.** Adapters that pre-T9928 wrote to stdout
  directly (LocalBackend, worktree provisioning, git shim) now MUST route
  through `getCleoLogger()`. New adapters MUST follow suit; the gates catch
  net-add violations.

### §3.3 Out of scope (deferred)

- **`cleo tree` JSON-only regression (T10352).** Filed during E9 dogfood —
  `treeCommand` bypasses the dispatcher's format resolver, so `cleo tree
  T9855` returns JSON unconditionally (no `--human` rendering). The fix
  is tracked as a P1 follow-up under E11 (ADR-077), not E9.
- **Programmatic `--field` validation against the envelope schema.** Today
  `--field` accepts any JSON Pointer; if the path doesn't resolve, the op
  exits with `E_NOT_FOUND`. A future epic may validate the pointer against
  the operation's declared LAFS schema at parse time.

---

## §4 CI Gate Summary

| Gate | Script | Mode | Baseline file |
|------|--------|------|----------------|
| stdout-discipline (T10135) | `scripts/lint-stdout-discipline.mjs` | Baseline | committed in `.lint-stdout-discipline-baseline.json` |
| stdout-write-allowlist (T9924) | `scripts/lint-stdout-write-allowlist.mjs` | Baseline | committed in `.lint-stdout-write-allowlist-baseline.json` |

Both run in the canonical CI job and fail on net-add. Use
`--update-baseline` after migrating a legacy site to lock in the
improvement.

---

## §5 Canonical Agent Patterns (the post-E9 contract)

```bash
# Scalar extract — no jq needed.
id=$(cleo add 'Title' --type task --parent T9927 --acceptance "..." \
       --field /data/task/id)

# ID-only pipeline — no JSON parsing.
cleo list --parent T9927 --output id | while read child; do
  cleo verify "$child" --gate qaPassed --evidence "tool:lint;tool:typecheck"
done

# Count-only check.
remaining=$(cleo list --parent T9927 --status pending --output count)

# Full clean pipeline — empty stderr, IDs on stdout.
cleo add-batch --file /tmp/batch.json --parent T9927 --quiet --output id

# Summary view for triage.
cleo list --parent T9927 --summary

# Force full record when needed.
cleo show T9920 --full
```

**Anti-patterns** (REJECTED — these are CLI bugs if they appear in agent
transcripts post-E9):

- ❌ `cleo show T123 | tail -1 | jq -r .data.task.id` → use `--field /data/task/id`
- ❌ `cleo list --parent E1 | jq -r '.data.tasks[].id'` → use `--output id`
- ❌ `cleo show T123 | python3 -c 'import json,sys; …'` → use `--field`
- ❌ `cleo add 'X' 2>&1 | grep -oE 'T[0-9]+'` → use `--field /data/task/id`

---

## §6 Status

Accepted 2026-05-24 with sibling tasks T9928, T9929, T9930, T9931 done; T9932
and T9933 in-flight (closeout permitted because the contract is locked and
shippable; remaining work is the `--summary` and `--quiet` flag implementations,
not contract changes).
