# CLEO Documentation SOP

**v2.0.0** | ACTIVE | LLM agent instructions only

---

## RFC 2119 Keywords (REQUIRED)

| Keyword | Use | Compliance |
|---------|-----|-----------|
| **MUST** | Critical/safety | 95-98% |
| **MUST NOT** | Prohibitions | 93-97% |
| **SHOULD** | Best practices | 75-85% |
| **MAY** | Optional | 40-60% |

---

## Core Rules

### 1. Structured Output

**MUST** use JSON Schema + `strict: true` when available (99% compliance).

```json
{"type": "json_schema", "json_schema": {"strict": true, "additionalProperties": false}}
```

### 2. Instruction Ratio

**MUST** maintain: 80% positive (what TO do) / 20% negative (what NOT to do).

Exception: Specific technical warnings effective ("**MUST NOT** hallucinate schema fields").

### 3. Token Optimization (30-50% reduction)

| Strategy | Savings | Pattern |
|----------|---------|---------|
| Symbols | 40-60% | `✓` not "completed successfully" |
| Abbreviations | 50-70% | `auth` not "authentication" |
| Key-value | 30-40% | Sparse data only |
| Whitespace | 10-15% | Remove extra lines |
| Examples | 40-55% | 1 minimal example |

### 4. GOLDEN+ Structure

```markdown
**Goal**: Objective + success criteria
**Output**: Format, length, tone
**Limits**: Constraints, exclusions
**Data**: Context, examples (minimal)
**Evaluation**: Acceptance criteria
**Next**: Alternatives if confidence < 80%
```

---

## Quick Reference

### Symbols (1 token)

```
→ implies    ✓ success    ⚠ warning    ⚡ perf    🔍 analysis
← from       ✗ failure    • list       | sep     : define
```

### Abbreviations

```
cfg config    auth authentication    impl implementation
perf performance    deps dependencies    val validation
env environment     req requirements     sec security
```

### Format Selection

| Data | Use | Savings |
|------|-----|---------|
| 2-3 cols, <10 rows | Table | 15-25% |
| 4+ cols, sparse | Key-value | 30-40% |
| Hierarchical | YAML | 25-35% |

### Examples Count

| Count | Compliance | Use |
|-------|-----------|-----|
| 0 | 65-75% | Simple |
| 1 | 80-85% | Edge-case |
| 2-3 | 90-95% | Pattern |
| 5+ | 92-97% | Avoid |

---

## Pattern Templates

### Critical Requirement

```markdown
### Critical: {Topic}

**MUST** {requirement}.

**Enforcement**: {checks}

**Schema**: {definition}
```

### Best Practice

```markdown
### {Topic}

**Goal**: {objective}
**Patterns**: {list}
**Limits**: **MUST NOT** {constraint}
**Evaluation**: {criteria}
```

### Workflow

```markdown
**PHASE 1**: {purpose}
```bash
cmd1  # comment
```
```

---

## Format Adherence

### API-Level (priority)

**Anthropic**: `output_format={"type": "json", "schema": schema}`
**OpenAI**: `response_format: zodResponseFormat(Schema)`

### Prompt-Level

```markdown
MUST respond matching schema: {schema}
VALIDATION: Fields present, no extras, enums exact.
```

### Self-Validation

```markdown
<validation>
1. JSON parses
2. Required fields present
3. Enums exact
4. Confidence > 80%
</validation>
```

---

## Anti-Patterns

| Pattern | Bad | Good | Savings |
|---------|-----|------|---------|
| **Semantic repetition** | 4 ways to say "don't edit JSON" | **MUST** use CLI | 75% |
| **Vague negatives** | "Don't make mistakes" | **MUST NOT** {specific} | N/A |
| **Excessive examples** | 10 examples | 2-3 strategic | 70% |
| **Buried constraints** | Critical rule at line 500 | **CRITICAL** (first 100 tokens) | N/A |

---

## Checklist

- [ ] RFC 2119 keywords all requirements
- [ ] 80/20 positive/negative ratio
- [ ] No semantic repetition
- [ ] 30%+ token reduction
- [ ] Schema defined
- [ ] 2-3 examples max
- [ ] Validation checkpoints
- [ ] GOLDEN+ applied

---

## Metrics

| Metric | Target |
|--------|--------|
| Format adherence | >98% |
| Token efficiency | <5K/req |
| Compliance | >90% |
| Hallucination | <5% |

---

**Research**: @docs/CLEO-DOCUMENTATION-SOP-v2.md
