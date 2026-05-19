# RFC 2119 Language

The skill MUST use RFC 2119 keywords correctly. This reference defines each
keyword precisely, gives positive and negative examples, and lists the
common misuses that downstream test writers and validators catch most
often. A spec is only as testable as its language is unambiguous.

## The Five Keywords

| Keyword | Synonyms | Precise meaning |
|---------|----------|-----------------|
| **MUST** | REQUIRED, SHALL | Absolute requirement. Non-compliance is a defect. |
| **MUST NOT** | SHALL NOT | Absolute prohibition. Non-compliance is a defect. |
| **SHOULD** | RECOMMENDED | Recommended; non-compliance requires recorded rationale. |
| **SHOULD NOT** | NOT RECOMMENDED | Discouraged; non-compliance requires recorded rationale. |
| **MAY** | OPTIONAL | Truly optional; compliance and non-compliance are both fine. |

These keywords are case-sensitive in their normative meaning. Use UPPERCASE
when carrying RFC 2119 weight; lowercase ("must", "should") is prose and
does not bind implementations.

## The Mandatory Header

Every CLEO specification MUST open with the IETF boilerplate, exactly:

```markdown
The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.
```

If the boilerplate is missing, the document is a guide, not a spec.
Downstream tooling — `ct-validator`, the IVT loop, the consensus voter —
will not enforce normative weight on un-boilerplated documents.

## Positive Examples

**Absolute requirement (MUST)**

> **REQ-007**: The release-ship command MUST cut the release branch from
> the tip of `main` after passing all quality gates.

This is testable: the test reads the branch's merge-base; if it is not
the `main`-tip-at-cut-time, the test fails.

**Conditional requirement (MUST + when-clause)**

> **REQ-008**: When `release.branchModel` is `feat-to-main`, the
> release pipeline MUST refuse direct pushes to `main`.

This is testable: with the config set, attempt a direct push; assert
rejection.

**Recommendation (SHOULD)**

> **REQ-012**: The orchestrator SHOULD batch parallel-safe tasks into
> waves rather than serializing them.

Compliant if waves exist; if serialization happens for a documented
reason (e.g. a dependency the auto-detector missed) the implementation
remains compliant — but the rationale MUST be recorded.

**Truly optional (MAY)**

> **REQ-019**: Implementations MAY cache the resolved skill manifest
> for the duration of a single orchestration session.

No conformance pressure either way. Caching and re-fetching are both
valid implementations.

## Negative Examples (Anti-Spec Language)

These phrasings look normative but are not. Replace each before the spec
ships.

| Anti-pattern | Why it fails | Replacement |
|--------------|--------------|-------------|
| "The system needs to validate input" | "Needs to" is aspirational, not binding | "The system MUST validate input" |
| "It is recommended that you encrypt at rest" | "It is recommended" is passive prose | "Implementations SHOULD encrypt at rest" |
| "We will use HTTPS" | First-person future tense is a plan, not a requirement | "All transports MUST use HTTPS" |
| "Should ideally be idempotent" | "Ideally" weakens SHOULD into nothing | "MUST be idempotent" or "SHOULD be idempotent" |
| "Try to keep payloads under 1MB" | "Try to" is unmeasurable | "Payloads SHOULD NOT exceed 1MB" |
| "Cannot exceed 100 requests/minute" | "Cannot" is descriptive, not normative | "MUST NOT exceed 100 requests/minute" |

## When to Pick Which Keyword

Use this decision rubric:

1. **Will an implementation that violates this rule fail user expectations
   or break interoperability?**
   - Yes → MUST / MUST NOT
   - Maybe → continue
2. **Is there a legitimate operating environment where violating this rule
   is the right call?**
   - Yes → SHOULD / SHOULD NOT
   - No → revisit step 1
3. **Is the behavior genuinely a choice with no preferred direction?**
   - Yes → MAY
   - No → revisit steps 1-2

If you cannot decide between MUST and SHOULD, the requirement is probably
under-specified — sharpen the failure condition first, then re-evaluate.

## Cross-Reference Patterns

When one requirement depends on another, link them explicitly so the test
matrix can build the dependency graph.

```markdown
**REQ-021**: The skill MUST emit a `pipeline_manifest` entry per
**REQ-008** before completing the task.
```

Avoid prose-cross-references ("as mentioned above") — they cannot be
machine-extracted. Use the `REQ-NNN` token.

## Compliance Statements

Every spec MUST close with a `## Compliance` section that enumerates the
conditions under which an implementation is conformant.

```markdown
## Compliance

An implementation is **conformant** if and only if:

1. All MUST and MUST NOT requirements (REQ-001 through REQ-007) hold.
2. Each SHOULD or SHOULD NOT requirement either holds OR is accompanied
   by a recorded rationale in the implementation's `decisions` table.
3. MAY requirements are reported in the implementation's capability
   manifest if applicable.

Non-conformant implementations SHOULD provide a remediation plan with
target conformance date.
```

This section is what `ct-validator` reads when producing the validation
report — without it, validation cannot proceed.
