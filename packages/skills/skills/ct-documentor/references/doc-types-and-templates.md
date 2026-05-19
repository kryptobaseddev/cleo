# Doc Types and Templates

CLEO documentation follows the Diátaxis grid (tutorial, how-to,
reference, explanation) plus three CLEO-native types (ADR,
agent-output, skill). Each type has a distinct shape — using the
wrong template confuses the reader. This reference defines each
type's purpose, audience, and skeleton.

## Diátaxis Grid

| Type | Purpose | When user is | Cognitive mode |
|------|---------|--------------|----------------|
| Tutorial | Learning by doing | New, exploring | Acquisition |
| How-to | Solving a problem | Working, blocked | Application |
| Reference | Looking up details | Working, knows what | Lookup |
| Explanation | Understanding | Reflecting, curious | Cognition |

The four types are NOT interchangeable. A how-to written as a tutorial
is too slow for working users; a reference written as explanation
hides the lookup data behind prose. Identify the type up front.

## Tutorial Template

```markdown
# {Tutorial Title}: Build a {thing} with {tech}

This tutorial walks you through building {thing} from scratch using
{tech}. By the end, you'll have a working {thing} and understand
{key concepts}.

## What you'll build

{Screenshot or output of finished thing}

## Prerequisites

- {Required tool / knowledge}
- {Required tool / knowledge}

## Step 1: {action verb + noun}

{1-3 sentences setting up the step.}

```bash
{exact command}
```

You should see {expected output}.

## Step 2: ...

...

## What you learned

- {concept 1}
- {concept 2}

## Next steps

- See [{how-to}](../how-to/...) to do {related task}.
- See [{reference}](../reference/...) for the full {API} surface.
```

Tutorials are linear. They never branch. They never ask the reader
to choose. Every step results in observable progress.

## How-to Template

```markdown
# How to {accomplish task}

When you need to {accomplish task}, follow these steps.

## Prerequisites

- {Required state / config}

## Steps

1. {Action verb + noun}.
   ```bash
   {exact command}
   ```

2. {Action verb + noun}.

3. {Action verb + noun}.

## Verify

Check that {observable outcome}.

```bash
{verification command}
```

## Troubleshooting

- **{Symptom}**: {Cause + fix}
- **{Symptom}**: {Cause + fix}

## Related

- [{Reference page}]
- [{Similar how-to}]
```

How-tos assume the reader knows the basics. They do not explain why —
they instruct.

## Reference Template

```markdown
# {API/command/feature} Reference

{One-sentence definition.}

## Synopsis

```bash
{command-syntax} [OPTIONS] <ARGS>
```

## Arguments

| Argument | Type | Description |
|----------|------|-------------|
| `<arg1>` | string | {what it is} |
| `<arg2>` | number | {what it is} |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--flag` | false | {effect} |
| `--opt <v>` | (none) | {effect} |

## Output

```json
{ "schema": "..." }
```

## Errors

| Exit | Code | Cause |
|------|------|-------|
| 0 | — | Success |
| 1 | E_VALIDATION | Bad input |

## Examples

```bash
{example 1}
```

```bash
{example 2}
```
```

References are dense and exhaustive. They do not include narrative.
Tables are preferred over prose.

## Explanation Template

```markdown
# {Concept or System Name}: Why {it matters}

## Context

{Why this exists; what problem it solves.}

## Mental model

{2-3 paragraphs framing the concept.}

```mermaid
{diagram if useful}
```

## How it works

{Walk through the structure.}

## Trade-offs

- **{trade-off 1}**: {what gives, what gains}
- **{trade-off 2}**: {what gives, what gains}

## Comparisons

| Alternative | Why we didn't pick it |
|-------------|-----------------------|
| {Alt A} | {reason} |
| {Alt B} | {reason} |

## Related

- [{ADR-NNN}]: the decision record
- [{Reference}]: the surface
- [{How-to}]: practical recipe
```

Explanations are essays. They have a thesis. They argue.

## CLEO-Native: ADR

Architecture Decision Record. Lives in `.cleo/adrs/`. Strictly templated.

```markdown
# ADR-NNN: {Short title}

**Status**: proposed | accepted | superseded | deprecated
**Date**: YYYY-MM-DD
**Decider(s)**: {names or "council vote ID"}
**Supersedes**: {ADR-MMM} or "(none)"
**Superseded by**: {ADR-PPP} or "(none)"

## Context

{Why this decision is needed now.}

## Decision

We will {state the decision}.

## Alternatives Considered

1. **{Alt A}**: {description, why rejected}
2. **{Alt B}**: {description, why rejected}

## Consequences

- **Positive**: {what improves}
- **Negative**: {what costs}
- **Neutral**: {what changes without strong direction}

## Implementation Notes

{Pointers to follow-up tasks, specs, code.}
```

ADRs are immutable once accepted. Changes go in a new ADR that
supersedes the old one.

## CLEO-Native: Agent-Output

Outputs of agent work, recorded in `.cleo/agent-outputs/`. Templated
to support `cleo docs add` registration and rollup.

```markdown
---
date: YYYY-MM-DD
agent: <agent-id>
task: T####
status: complete | partial | blocked
topics: [topic1, topic2]
---

# {Output Title}

## Summary

{2-3 sentences.}

## Findings / Deliverables

{Body.}

## Manifest Entry

```json
{ ... }
```
```

The frontmatter is mandatory. The CI lint (`agent-outputs-registration`
job per T1617) rejects any new `.md` in this directory that lacks it
or that wasn't registered via `cleo docs add` / `cleo memory observe`.

## CLEO-Native: Skill

Lives in `packages/skills/skills/<name>/SKILL.md`. The ct-skill-creator
skill is the canonical template — see its references/.

## When to Pick Which Type

| Question | Type |
|----------|------|
| "How do I do X?" — and the reader is learning | Tutorial |
| "How do I do X?" — and the reader is working | How-to |
| "What does X do?" / "What's the syntax?" | Reference |
| "Why does X work this way?" | Explanation |
| "Why did we pick X over Y?" | ADR |
| "What did this agent produce?" | Agent-output |
| "Add a new agent skill" | Skill |

When in doubt: pick how-to. It is the type most users want most of the
time, and the easiest to convert to reference later.
