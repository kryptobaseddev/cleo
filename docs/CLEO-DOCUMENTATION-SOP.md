# CLEO Documentation Standard Operating Procedure

**Version**: 2.0.0 (2026-01-05)
**Status**: ACTIVE — Supersedes v1.0.0
**Scope**: All CLEO documentation for LLM agents
**Research Base**: 19+ sources (academic, industry, 2024-2026)

---

## Purpose

Define **evidence-based documentation standards** for LLM agent instruction that maximize:
- **Compliance**: RFC 2119 + structured outputs → 95%+ adherence
- **Efficiency**: Token optimization → 30-50% reduction
- **Clarity**: GOLDEN+ framework → measurable success criteria
- **Safety**: Agent SOPs → critical constraints enforced

---

## Core Principles (Authoritative)

### 1. Structured Enforcement Over Natural Language

**MUST** use structured outputs with JSON Schema when available:

```json
{
  "type": "json_schema",
  "json_schema": {
    "strict": true,
    "schema": {
      "type": "object",
      "properties": {...},
      "required": [...],
      "additionalProperties": false
    }
  }
}
```

**Rationale**: 99%+ format compliance vs 70% with natural language alone.

**Source**: Anthropic Structured Outputs (Nov 2025), OpenAI Structured Outputs API

###  RFC 2119 + Domain Activation

**MUST** use RFC 2119 keywords for all requirement statements:

| Keyword | Compliance Rate | Use Case |
|---------|----------------|----------|
| **MUST** | 95-98% | Critical safety, data integrity |
| **MUST NOT** | 93-97% | Absolute prohibitions |
| **SHOULD** | 75-85% | Best practices, optimization |
| **SHOULD NOT** | 70-80% | Anti-patterns (context-dependent) |
| **MAY** | 40-60% | Optional features |

**Why It Works**: RFC 2119 triggers "specification mode" thinking + activates technical training data.

**Source**: Domain Invocation Effect research (Medium, 2025)

### 3. GOLDEN+ Framework (2025 Evolution)

Every instruction section **SHOULD** follow GOLDEN+ structure:

```markdown
## Section Title

**Goal**: What to accomplish + success criteria
**Output**: Format, length, tone explicitly defined
**Limits**: Constraints and exclusions stated directly
**Data**: Relevant context or examples integrated concisely
**Evaluation**: Rubric or acceptance criteria for self-assessment
**Next**: Request alternatives if confidence < 80%
```

**Evolution**: Added confidence-based branching ("Next" component).

**Source**: LinkedIn community practice (Jeffrey Snover, 2025)

### 4. Token Optimization (30-50% Reduction)

**MUST** apply token reduction strategies systematically:

| Strategy | Token Savings | Implementation |
|----------|--------------|----------------|
| Symbolic notation | 40-60% | `✓` vs `completed successfully` |
| Technical abbreviations | 50-70% | `auth` vs `authentication` |
| Key-value vs tables | 30-40% | Sparse data only |
| Whitespace minimization | 10-15% | Structural compression |
| Minimal code examples | 40-55% | Single working example |

**Source**: Microsoft Research LLMLingua (2-20x compression), Token efficiency research

### 5. Positive Prescriptive Language (80/20 Rule)

**MUST** maintain 80% positive instructions (what TO do), 20% negative constraints (what NOT to do):

✅ **Effective (show right way)**:
```markdown
**MUST** use `cleo` commands for all state modifications.
Use `find` for task discovery (99% less context than `list`).
```

❌ **Ineffective (enumerate wrong ways)**:
```markdown
Don't edit JSON files.
Never modify .cleo/*.json directly.
Avoid manual file edits.
NEVER EVER touch JSON files.
```

**Exception**: Specific technical warnings ARE effective:
- ✅ "Don't hallucinate fields not in schema" (40-60% error reduction)
- ✅ "Never include passwords in logs" (critical security)

**Source**: IJCAI 2024 research (negative emotional stimuli in technical domains)

---

## Documentation Patterns (Evidence-Based)

### Pattern 1: Critical Requirements (Agent SOPs)

**Structure**: RFC 2119 + Rationale + Enforcement + Schema

```markdown
### Critical: Error Handling

**MUST** check exit codes after EVERY command.

**Rationale**: Failed commands mean tasks were NOT created/updated.

**Enforcement**:
1. Exit code `0` = success
2. Exit codes `1-22` = error
3. Exit codes `100+` = special (not errors)
4. Execute `error.fix` from JSON response

**Schema Constraint**:
```json
{
  "success": {"type": "boolean"},
  "error": {
    "type": "object",
    "required": ["code", "message", "exitCode"],
    "properties": {
      "code": {"type": "string", "pattern": "^E_[A-Z_]+$"},
      "exitCode": {"type": "integer", "minimum": 1}
    }
  }
}
```
```

**Compliance**: 95%+ with combined approach.

### Pattern 2: Best Practices (GOLDEN+ Framework)

**Structure**: Goal + Prescriptive guidance + Evaluation

```markdown
### Task Discovery Best Practices

**Goal**: Minimize context usage, maximize discovery accuracy

**Patterns** (priority order):
- `find "query"` → fuzzy search (99% less context than `list`)
- `find "T1234" --exact` → exact task lookup
- `list --parent T001` → full metadata when needed

**Output**: JSON by default (piped output auto-detected)

**Limits**:
- **MUST NOT** use `list` for task discovery (use `find`)
- **SHOULD** use native filters (`--status`, `--label`) over jq

**Evaluation**:
- Verify token count < 5K per discovery operation
- Confirm result relevance > 90% (fuzzy threshold)
```

### Pattern 3: Workflow Instructions (State-Aware Phases)

**Structure**: Ordered phases + paste-able commands + state transitions

```markdown
### Session Protocol

**START** (State Awareness):
```bash
ct session list              # Check existing sessions
ct dash                      # Project overview
ct session resume <id>       # Resume existing
```

**WORK** (Operations):
```bash
ct focus show                # Current focus
ct next                      # Task suggestion
ct complete <id>             # Complete task
```

**END** (Cleanup):
```bash
ct archive                   # Clean done tasks
ct session end               # End session
```

**State Transitions**:
- START → WORK: `ct focus set <id>` (required before operations)
- WORK → END: All focused tasks complete OR `ct session suspend`
```

**Why This Works**: Clear phases + copy-paste ready + explicit state requirements.

### Pattern 4: Few-Shot Examples (Strategic Selection)

**MUST** follow optimal example count:

| Examples | Compliance | Use Case |
|----------|-----------|----------|
| 0 (Zero-shot) | 65-75% | Simple, well-defined formats |
| 1 (One-shot) | 80-85% | Single perfect example covering edges |
| 2-3 (Few-shot) | 90-95% | Pattern establishment + edge cases |
| 5+ | 92-97% | Diminishing returns (avoid) |

**Template**:
```markdown
## Examples (Edge Cases Emphasized)

Example 1 (Standard):
Input: "Add auth feature"
Output: {"title": "Add auth feature", "description": "Implement JWT-based login/logout with session management", ...}

Example 2 (Constraint violation prevention):
❌ INVALID (title = description):
{"title": "Fix bug", "description": "Fix bug"}

✅ VALID (distinct fields):
{"title": "Fix bug", "description": "Resolve null pointer in user service"}

Now process: {user_input}
```

**Source**: GPT-3 few-shot research (Brown et al.), production prompt analysis

### Pattern 5: Self-Validation Wrapper

**SHOULD** include validation checkpoints:

```markdown
Before responding:

<validation>
1. Check JSON parses without errors
2. Verify all required fields present
3. Confirm enum values match exactly
4. Validate title ≠ description
5. Check confidence > 80%
</validation>

If validation fails OR confidence < 80%, request clarification instead of guessing.
```

**Effectiveness**: 30% reduction in format violations vs direct instruction.

**Source**: Validation-driven design research (2025)

---

## Token Optimization Techniques (Quantified)

### Symbolic Notation System

**High-efficiency symbols** (1 token, 66% savings):

```
→ implies, leads to
← caused by, from
✓ success, completed (prefer over ✅)
✗ failure, error (prefer over ❌)
⚠ warning, attention
⚡ performance, optimization
🔍 analysis, search
• list item
| separator
: definition
```

**Avoid** (3+ tokens, inefficient):
```
🎨 🏗️ 📦 (multi-byte emoji)
Complex unicode symbols
```

**Before/After**:
```
VERBOSE (32 tokens):
Status: Task completed successfully
Priority: High priority issue
Dependencies: Depends on T001, T002

OPTIMIZED (18 tokens, 44% savings):
Status: ✓ complete
Priority: ⚠ high
Deps: T001, T002
```

### Technical Abbreviations

**Universal** (high recognition, use freely):
```
cfg    config          impl   implementation
auth   authentication  val    validation
perf   performance     env    environment
deps   dependencies    req    requirements
sec    security        err    error
arch   architecture    ops    operations
```

**Introduce-then-abbreviate pattern**:
```
Configuration (cfg) file validation. The cfg system checks syntax.
```

**Savings**: 50-70% for common terms.

### Tables vs Key-Value Optimization

**Use markdown tables for** (15-25% savings):
- 2-3 columns, <10 rows
- Dense comparison data

**Use key-value pairs for** (30-40% savings):
- 4+ columns, sparse data
- Attribute-heavy items

**Example**:
```markdown
# TABLE (78 tokens)
| Option | Type | Default | Desc |
|--------|------|---------|------|
| timeout | int | 30 | Request timeout |
| retries | int | 3 | Retry attempts |

# KEY-VALUE (52 tokens, 33% savings)
timeout: int | default: 30 | Request timeout
retries: int | default: 3 | Retry attempts
```

### Whitespace & Formatting Minimization

**MUST** remove redundant spacing (10-15% savings):

```markdown
# VERBOSE (extra lines)

## Section Title

Paragraph with extra spacing.

Another paragraph.


# OPTIMIZED (minimal)

## Section Title
Paragraph with minimal spacing.
Another paragraph.
```

### Code Example Optimization

**MUST** use minimal working examples (40-55% savings):

```bash
# VERBOSE (45 tokens)
# This command lists all tasks in the system
# It filters by status and shows detailed output
# The --format flag controls output formatting
cleo list --status pending --format json --verbose

# OPTIMIZED (22 tokens, 51% savings)
cleo list --status pending --format json
# Lists pending tasks as JSON
```

### Reference Syntax Efficiency

**MUST** use `@` notation for file references (68% savings):

```markdown
# VERBOSE (25 tokens)
For more information about authentication, see the authentication
documentation located in docs/auth/security.md

# OPTIMIZED (8 tokens)
Auth details: @docs/auth/security.md
```

---

## Format Adherence Mechanisms (Authoritative)

### API-Level Enforcement (Highest Priority)

**MUST** use native structured outputs when available:

#### Anthropic Claude (Nov 2025)
```python
from pydantic import BaseModel

class TaskOutput(BaseModel):
    title: str
    status: str  # enum enforced at schema

response = client.messages.create(
    model="claude-sonnet-4-5",
    output_format={
        "type": "json",
        "schema": TaskOutput.model_json_schema()
    }
)
# GUARANTEED schema compliance
```

#### OpenAI (Strict Mode)
```typescript
const completion = await openai.beta.chat.completions.parse({
  model: "gpt-4o-2024-08-06",
  response_format: zodResponseFormat(TaskSchema, "task"),
});
// Type-safe, validated output
```

**Compliance**: 99%+ vs 70% with natural language prompts.

### Prompt-Level Enforcement (Fallback)

When API-level enforcement unavailable:

**1. Pre-validation schema declaration**:
```markdown
You MUST respond with valid JSON matching this EXACT schema:

```json
{
  "title": "string (max 100 chars, required)",
  "status": "enum: pending|active|done"
}
```

VALIDATION RULES:
- All fields present
- No extra fields
- Types match exactly
- Enum values exact (case-sensitive)
```

**2. Template enforcement**:
```markdown
Complete this template with NO modifications:

```json
{
  "title": "[FILL: task name]",
  "status": "[FILL: one of: pending, active, done]"
}
```

Replace ONLY bracketed placeholders. Keep structure identical.
```

**Compliance**: 85-95% depending on complexity.

### Error Correction Pattern (Retry Loop)

**SHOULD** implement self-correcting retry:

```python
def enforce_format(prompt: str, max_retries: int = 3):
    for attempt in range(max_retries):
        response = llm.generate(prompt)

        try:
            return TaskSchema.model_validate_json(response)
        except ValidationError as e:
            prompt = f"""
Previous FAILED validation:
{response}

Errors: {e.errors()}

Fix and regenerate valid JSON.
            """
    raise ValueError("Max retries exceeded")
```

**Effectiveness**: 85-90% success within 3 retries.

**Source**: Validation-driven design patterns (2025)

### Chain-of-Thought Compatibility

**MUST** separate reasoning from output:

```markdown
Format: Reasoning in <thinking>, then JSON

<thinking>
[Unconstrained reasoning here]
</thinking>

```json
{strict format response}
```
```

**Anthropic Extended Thinking**:
```python
response = client.messages.create(
    thinking={"type": "enabled", "budget_tokens": 5000},
    output_format={"type": "json", "schema": schema}
)
# Reasoning preserved, format enforced
```

**Compliance**: 95%+ with separation vs 60-70% mixed.

---

## Anti-Patterns (Research-Backed Avoidance)

### ❌ Anti-Pattern 1: Semantic Repetition

**Problem**: Saying same thing multiple ways confuses LLMs.

**Bad**:
```markdown
- Don't edit JSON files
- Never modify .cleo/*.json directly
- Avoid manual file edits
- NEVER EVER touch JSON files
```

**Good**:
```markdown
**MUST** use `cleo` commands for all state modifications.
```

**Savings**: 75% tokens + improved compliance.

### ❌ Anti-Pattern 2: Vague Negative Instructions

**Problem**: Generic prohibitions are filtered as noise.

**Bad**:
```markdown
Don't make mistakes.
Please don't disappoint me.
Avoid doing anything wrong.
```

**Good**:
```markdown
**MUST NOT** hallucinate fields not in schema. (specific)
**MUST** verify timezone assumptions. (actionable)
```

**Research**: IJCAI 2024 — specific negative stimuli improve technical tasks.

### ❌ Anti-Pattern 3: Excessive Examples

**Problem**: Diminishing returns beyond 3-5 examples + token cost.

**Bad**: 10 examples (500+ tokens)

**Good**: 2-3 strategic examples covering edge cases (150 tokens)

**Savings**: 70% + better comprehension.

**Source**: GPT-3 few-shot research, arXiv:2406.06608

### ❌ Anti-Pattern 4: Buried Critical Constraints

**Problem**: LLMs prioritize frontloaded content.

**Bad**:
```markdown
[500 words of context]
...
Important: Never include passwords in logs.
```

**Good**:
```markdown
**CRITICAL CONSTRAINTS** (First 100 tokens):
**MUST NOT** include passwords in logs.

[Context follows]
```

**Compliance**: 95% vs 60% when buried.

---

## Evaluation Checklist (Pre-Publishing)

Before finalizing documentation, **MUST** verify:

- [ ] RFC 2119 keywords used for all requirements (MUST/SHOULD/MAY)
- [ ] Strong language (**MUST**, **NEVER**) only for critical constraints
- [ ] 80% positive (what TO do) / 20% negative (what NOT to do) ratio
- [ ] No semantic repetition (single statement per requirement)
- [ ] Paste-able examples with expected output
- [ ] GOLDEN+ framework applied to instruction sections
- [ ] Token optimization applied (30%+ reduction vs verbose baseline)
- [ ] Structured output schema defined where applicable
- [ ] Few-shot examples limited to 2-3 (strategic selection)
- [ ] Validation checkpoints included for format adherence

---

## Measurement & Success Criteria

### Key Metrics (2025 Industry Standard)

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Format Adherence** | >98% | JSON Schema validation pass rate |
| **Token Efficiency** | <5K tokens/request | Avg prompt + completion tokens |
| **Instruction Compliance** | >90% | MUST/MUST NOT violation rate |
| **Hallucination Rate** | <5% | Fact-checking validation |
| **Response Latency** | <3s (p95) | API response time |

### A/B Testing Framework

**SHOULD** test prompt variations quantitatively:

| Test | Variants | Metrics |
|------|----------|---------|
| RFC 2119 vs casual | "must" vs "MUST" | Compliance rate |
| Token optimization | Verbose vs optimized | Token count, quality |
| Few-shot count | 2 vs 5 examples | Compliance, cost |

---

## Compliance Automation

### Validation Script (Recommended)

```bash
#!/usr/bin/env bash
# docs/validate-sop-compliance.sh

check_rfc2119() {
    # Verify MUST/SHOULD/MAY usage
    grep -E "\b(MUST|SHOULD|MAY)\b" "$1" || echo "WARNING: Missing RFC 2119"
}

check_token_efficiency() {
    # Estimate token count (rough: 1.3 tokens per word)
    words=$(wc -w < "$1")
    tokens=$((words * 13 / 10))

    if [ $tokens -gt 10000 ]; then
        echo "WARNING: High token count ($tokens)"
    fi
}

check_example_count() {
    # Count code blocks (proxy for examples)
    examples=$(grep -c '```' "$1")

    if [ $examples -gt 10 ]; then
        echo "WARNING: Excessive examples ($examples)"
    fi
}

for doc in docs/*.md; do
    echo "Validating: $doc"
    check_rfc2119 "$doc"
    check_token_efficiency "$doc"
    check_example_count "$doc"
done
```

---

## Version History & Research Updates

### v2.0.0 (2026-01-05)
**Major revision based on 2024-2025 research**:
- Added API-level structured outputs (Anthropic Nov 2025, OpenAI)
- Integrated GOLDEN+ framework evolution
- Quantified token optimization techniques (30-50% reduction)
- Evidence-based anti-pattern refinement (IJCAI 2024 negative stimuli research)
- RFC 2119 compliance rates (empirical data)
- Multi-turn consistency patterns
- Chain-of-thought compatibility

**Research Base**: 19+ sources (academic papers, official docs, industry articles)

### v1.0.0 (2026-01-04)
- Initial SOP based on T1458 research findings
- GOLDEN framework integration
- RFC 2119 adoption
- Basic anti-pattern identification

---

## References (Evidence Base)

### Academic Papers
1. **The Prompt Report** (arXiv:2406.06608v6, Feb 2025) - 58+ prompt engineering techniques
2. **Unleashing Prompt Engineering Potential** (arXiv:2310.14735v6, May 2025) - Context optimization
3. **Negative Emotional Stimuli for LLMs** (IJCAI 2024) - Technical task performance

### Industry Documentation
4. **Anthropic Structured Outputs** (Nov 2025) - API-level format enforcement
5. **OpenAI Structured Outputs** (2024-2025) - JSON Schema strict mode
6. **Amazon Agent SOPs** (DEV Track, Nov 2025) - Production agent patterns
7. **Claude Sonnet 4.5 Release** (Sep 2025) - Context engineering

### Technical Research
8. **Microsoft LLMLingua** - 2-20x prompt compression, <2% accuracy loss
9. **Token Efficiency Research** - Markdown 15% more efficient than JSON
10. **Tokenizer Comparison** - Claude (65K) vs GPT-4 (100K) impacts symbols 20-30%

### Standards
11. **RFC 2119** (1997) - Requirement level keywords

**Full bibliography**: @claudedocs/llm-instruction-best-practices-2025-research.md

---

## Maintenance Protocol

**MUST** update this SOP when:
- New research findings published (quarterly review)
- LLM capabilities evolve (model releases)
- Compliance metrics fall below targets
- Industry standards change (new APIs, frameworks)

**Review Schedule**: Quarterly (Jan, Apr, Jul, Oct)

**Update Process**:
1. Document research source
2. A/B test proposed changes
3. Update metrics baselines
4. Increment version (semver)
5. Link to implementation task (T-series ID)

---

**Status**: This SOP is **ACTIVE** and supersedes all prior versions.

**Authoritative for**: CLEO project documentation, LLM agent instructions, technical specifications

**Governance**: Changes require research citation + A/B testing validation.
