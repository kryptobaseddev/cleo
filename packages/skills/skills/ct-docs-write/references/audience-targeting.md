# Audience Targeting

CLEO docs serve three audiences with very different needs. Writing
without identifying the audience produces docs that satisfy none.
This reference defines each audience's profile and how to tune the
draft to fit.

## Three Audiences

| Audience | Profile | Reading goal |
|----------|---------|--------------|
| End-user | Uses CLEO to ship their own software | "Help me do this thing now" |
| Agent | LLM consuming the doc as context | "Give me the structure I need" |
| Maintainer | Contributes to CLEO itself | "Show me how this works internally" |

Identifying the audience is the first step in any documentation task.
The downstream choices — tone, depth, examples, structure — all flow
from this single decision.

## End-User Audience

The end-user has installed CLEO and wants to use it. They are a
developer or a tech-comfortable team lead. They are working — not
exploring.

### Tone

Conversational, practical, second-person.

```markdown
You can run the release pipeline manually with `cleo release ship`.
Just kidding — never use "just". Run it with `cleo release ship`,
and CLEO walks through the gates one by one.
```

### Depth

Show the action; show the outcome; show the recovery if it fails.
Do not explain why unless the why directly affects behavior.

```markdown
GOOD (end-user):
Run `cleo release ship 2026.5.82 --epic T9567`.

You see:
- The 12 release steps run in order.
- CI status streams in real-time.
- On success, the tag is pushed and the PR merges.

If a step fails, CLEO stops and prints the failing gate. Fix the issue
and re-run.

BAD (end-user, too deep):
The `cleo release ship` command dispatches through `dispatch.ts`,
loading the `release` handler from the registry built at module
init. The handler then constructs a release plan using the 12-stage
state machine defined in `packages/cleo/src/commands/release/...`
```

### Examples

Realistic. Copy-paste-able. With expected output.

```markdown
GOOD:
```bash
$ cleo show T9567
T9567 — E-SKILLS-DEPTH-BACKFILL
Status: pending
Acceptance:
  1. Each of 6+ stub skills gains references/ with min 3 docs each
  ...
```
```

### Structure

How-to or tutorial template. The reader scans for steps; give them
steps.

## Agent Audience

The agent is an LLM — Claude, GPT, a CLEO subagent. It consumes the
doc as context for completing a task. Its needs are very different
from the human's.

### Tone

Dense, structured, declarative. Bullet points and tables over prose.

```markdown
GOOD (agent):
Worker contract:
1. cd to worktree path (provided in spawn prompt)
2. read task with `cleo show <ID>`
3. implement; commit on task branch
4. verify each gate with `cleo verify --gate X --evidence Y`
5. complete with `cleo complete <ID>`
6. observe learning with `cleo memory observe`

BAD (agent, too narrative):
When the worker starts up, it first navigates to the worktree the
orchestrator created. This is important because all subsequent
operations need to happen inside the worktree's boundary. After
arrival, the worker reads the task it was assigned...
```

### Depth

Maximum useful. The agent can absorb dense reference material; it
prefers structured data to prose framing.

### Examples

Schemas, JSON, command sequences. Show the data shape directly.

```markdown
Manifest entry shape:

```json
{
  "id": "<topic>-<date>",
  "file": "<filename>",
  "title": "<title>",
  "status": "complete" | "partial" | "blocked",
  "agent_type": "research" | "spec" | "implementation" | ...,
  "topics": ["<tag>", "<tag>"],
  "key_findings": ["<sentence>", ...],
  "actionable": true | false,
  "needs_followup": ["<task-id>", ...],
  "linked_tasks": ["<epic-id>", "<task-id>"]
}
```
```

### Structure

Reference template. Tables. Bullet lists. The agent doesn't need
warm-up prose.

## Maintainer Audience

The maintainer is a CLEO contributor — they have read the codebase
and want to understand or modify the internals. They are exploring
or making architectural decisions.

### Tone

Technical, precise, third-person.

```markdown
GOOD (maintainer):
The release pipeline is implemented as a 12-stage state machine in
`packages/cleo/src/commands/release/`. Stages are pure functions
that take a `ReleaseContext` and return either `{ ok: true, ctx }`
or `{ ok: false, error }`. The dispatcher in `pipeline.ts` runs
stages in declared order, short-circuiting on failure.

BAD (maintainer, too casual):
Releases work through this cool 12-step thing. Each step is a
function that either works or doesn't. If a step fails, we stop.
```

### Depth

Maximum. Internal symbols, file paths, design decisions. The reader
is expected to follow links into the codebase.

### Examples

Code excerpts with the actual implementation. Reference to ADRs
and prior discussions.

```markdown
The dispatcher signature is:

```typescript
// packages/cleo/src/commands/release/pipeline.ts
export async function runPipeline(
  stages: Stage[],
  ctx: ReleaseContext
): Promise<Result<ReleaseContext, ReleaseError>>;
```

See ADR-065 for the gate-ordering rationale.
```

### Structure

Explanation template often. Mermaid diagrams for flows. Cross-references
to ADRs.

## Mixed-Audience Pitfalls

The most common style failure is mixing audiences within a single doc.

### Pitfall: End-user doc with maintainer aside

```markdown
BAD:
Run `cleo release ship`.

(Internally, this dispatches through `dispatch.ts` to the release
handler registered via the registry pattern...)

Then check that the PR opens.
```

The aside is for maintainers, not end-users. End-users don't care
about `dispatch.ts`. Either:
- Cut the aside.
- Move it to a separate maintainer doc.
- Link to it as "for more details, see [release pipeline internals]".

### Pitfall: Maintainer doc with consumer hand-holding

```markdown
BAD:
The release pipeline runs gates in order — that means each step
happens one after another, like steps on a staircase. (You go up
one step at a time, right?)
```

Maintainer-audience readers know what "in order" means. Patronizing
them wastes their time.

### Pitfall: Agent doc with narrative warm-up

```markdown
BAD (agent doc):
Welcome to the worker protocol! In this guide, we'll walk through
the steps you'll follow as a worker. We're excited to have you on
board. Let's get started!

(Then 200 lines of actual protocol.)
```

Agent readers want the protocol immediately. The warm-up is pure
token waste.

## Tagging Audience in Frontmatter

Every CLEO doc SHOULD declare its audience in frontmatter:

```markdown
---
title: How to ship a release
audience: end-user
type: how-to
---
```

The audience tag lets reviewers, future maintainers, and automated
style checks apply the right rubric. Without it, the reader has to
infer from tone — and inference is error-prone.

## Audience-Specific Conventions

| Element | End-user | Agent | Maintainer |
|---------|----------|-------|------------|
| Pronoun | "you" | (none — declarative) | "the X", "we" rarely |
| Verb mood | Imperative | Declarative | Descriptive |
| Code examples | Realistic, with output | Schemas, JSON | Code excerpts with paths |
| Internal refs | Avoid | None | Heavy |
| ADR refs | Rarely | Rarely | Heavy |
| Diagrams | Sometimes | Rarely | Often (Mermaid) |
| Warm-up | One sentence | None | Context paragraph |

## Re-Targeting

When a doc is mis-audienced, the fix is usually structural — not
tonal. Re-target by:

1. Re-classify the audience in frontmatter.
2. Restructure to the new audience's template.
3. Strip content that doesn't fit (maintainer details from end-user
   doc; warm-up from agent doc).
4. Add content that does fit (verification steps for end-user;
   internal links for maintainer).

Re-targeting a long doc is sometimes more expensive than splitting it.
A doc that genuinely serves two audiences should be two docs with
cross-links — not one doc trying to do both.

## Cross-Audience References

When a doc primarily serves audience A but the reader from audience B
might land on it (via search, link, etc.), add a footer pointer:

```markdown
> Are you contributing to CLEO? See the [maintainer's deep dive
> on release internals](../internals/release-pipeline.md) instead.
```

The pointer respects B's time without polluting A's reading flow.

## Self-Check

Before declaring a draft done:

- [ ] Frontmatter declares the audience.
- [ ] Tone matches the audience profile.
- [ ] Depth matches what the audience needs.
- [ ] No content from a different audience snuck in.
- [ ] Cross-references to other-audience docs added if relevant.
