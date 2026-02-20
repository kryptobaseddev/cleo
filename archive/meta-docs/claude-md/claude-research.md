# Research Supporting CLAUDE.md Optimization

Evidence-based findings that inform best practices for CLAUDE.md design and task management systems.

---

## 1. Instruction Following Degrades with Density

**Source**: IFScale Benchmark (July 2025)

The most directly relevant research is the IFScale benchmark which evaluated 20 state-of-the-art LLMs on instruction following as instruction count increases:

> Production-grade LLM systems require robust adherence to dozens or even hundreds of instructions simultaneously. However, the instruction-following capabilities of LLMs at high instruction densities have not yet been characterized.
> — *arXiv*

### Key Findings

- **Three distinct degradation patterns emerge**:
  1. **Threshold decay**: Near-perfect performance until a critical density, then rising variance and decreased adherence (reasoning models like o3, gemini-2.5-pro)
  2. **Linear decay**: Gradual degradation (gpt-4.1, claude-sonnet-4)
  3. **Exponential decay**: Rapid performance loss (gpt-4o, llama-4-scout)

- Even the best frontier models only achieve **68% accuracy** at the max density of 500 instructions

- **Order effects matter**: Items presented earlier receive more attention

### Implication

This directly supports the "less is more" principle—Claude Sonnet 4 shows linear decay as instructions increase, meaning **every unnecessary instruction in CLAUDE.md degrades performance** on the instructions that actually matter.

---

## 2. Context Length Hurts Performance Even with Perfect Retrieval

**Sources**: Chroma "Context Rot" Research, NoLiMa Benchmark

The "Context Rot" research from Chroma demonstrates:

> Even under these minimal conditions, model performance degrades as input length increases, often in surprising and non-uniform ways. Real-world applications typically involve much greater complexity, implying that the influence of input length may be even more pronounced in practice.
> — *Trychroma*

More critically:

> Even when a model can perfectly retrieve all the evidence—in the strictest possible sense, reciting all tokens with 100% exact match—its performance still degrades substantially as input length increases.
> — *arXiv*

### Key Finding

The NoLiMa benchmark found that at **32k tokens, 11 out of 12 tested models dropped below 50%** of their performance in short contexts.

### Implication

Bloated CLAUDE.md files hurt performance **even if Claude can "see" all the content**.

---

## 3. Repository-Specific Prompt Optimization Yields 5-11% Gains

**Source**: Arize Prompt Learning Study

Research from Arize on Prompt Learning for Claude Code found:

> Claude Code already uses one of the strongest coding models available (Claude Sonnet 4.5), yet optimizing only its system prompt yielded **5%+ gains** in general coding performance and even larger gains when specialized to a single repository.
> — *Arize*

For repository-specific optimization:

> We saw an even bigger improvement for our in-repo test: **+10.87%**. This is expected, as we were training and testing Claude Code using issues from the same Python repo.
> — *Arize*

### Implication

This validates the "repository-specific rules" approach—**tailoring CLAUDE.md to your specific codebase patterns yields measurably better results**.

---

## 4. Lost in the Middle Phenomenon

**Sources**: Medium, Greg Kamradt Research

> A key challenge with long-context models is the Lost in the Middle phenomenon. This refers to the U-shaped performance curve observation that LLMs generally perform better when processing information at the beginning or end of a context rather than the middle.
> — *Medium*

Greg Kamradt found that GPT-4 accuracy noticeably degrades:
- With large context of more than **64k tokens**
- When text was placed between **10–50% of the context depth**

### Implication

**Place the most critical instructions at the beginning** of CLAUDE.md files.

---

## Research Supporting the "No Time Estimates" Rule

### 1. Planning Fallacy (Kahneman & Tversky, 1979)

> The planning fallacy is a phenomenon in which predictions about how much time will be needed to complete a future task display an optimism bias and underestimate the time needed. This phenomenon sometimes occurs regardless of the individual's knowledge that past tasks of a similar nature have taken longer to complete than generally planned.
> — *Wikipedia*

**Key statistic**: Only **30% of subjects** completed projects within their predicted schedule.

### 2. LLMs Cannot Improve on Human Estimation Biases

> Traditional estimation techniques, although widely utilized, often fall short due to their complexity and the dynamic nature of software development projects.
> — *arXiv*

While LLMs can help with cost estimation from historical data, they **inherit human biases** in training data and cannot reliably track elapsed time or predict interruptions.

### 3. METR Study: AI Tools Made Experienced Developers 19% Slower

> We conduct a randomized controlled trial (RCT) to understand how early-2025 AI tools affect the productivity of experienced open-source developers working on their own repositories. Surprisingly, we find that when developers use AI tools, they take **19% longer** than without—AI makes them slower.
> — *METR*

### Implication

Even with AI assistance, **time estimates remain unreliable**, and the relationship between AI usage and completion time is not straightforward.

---

## Research Supporting Flat, Computed-on-Read Schema Design

### 1. LLM Performance with Complex vs. Simple Structures

> LLM performance follows a strikingly consistent sigmoid or exponential decay as problem difficulty increases, highlighting fundamental limitations in scaling reasoning capabilities.
> — *arXiv*

**Finding**: Deeply nested JSON structures increase parsing complexity. **Flat structures with direct array access are more reliably processed**.

### 2. Instruction Conflict Creates Errors

> We show that an important factor contributing to this trend is the degree of tension and conflict that arises as the number of instructions is increased.
> — *arXiv*

**Finding**: Storing computed values (like completion percentages) alongside raw data creates potential conflicts when the computed value doesn't match reality—the model must resolve conflicting information.

---

## Research Supporting Focus/Session Context in Task Tracking

### 1. Memory Drift in Long Contexts

> Performance degradation begins well before the maximum supported context window, with measurable declines in structural recovery observed... o1 remains similar to GPT-4o for shorter inputs but its memory drift surpasses GPT-4o for prompts longer than **2000 tokens**.
> — *arXiv*

**Solution**: Explicit `focus.currentTask`, `sessionNote`, and `nextAction` fields compensate for this drift by providing immediate context without requiring the model to reconstruct state from history.

### 2. System Prompts Significantly Impact Performance

> Comparing the default setting with the "w.o. system prompt" condition reveals a **universal and significant degradation** in performance across all models and metrics.
> — *arXiv (EvolIF benchmark)*

### Implication

This validates the importance of **well-structured task context** in system prompts/CLAUDE.md files.

---

## Summary of Key Metrics

| Finding | Source | Impact |
|---------|--------|--------|
| Instruction following degrades linearly for Claude Sonnet 4 | IFScale (2025) | Every unnecessary instruction hurts |
| 11/12 models drop below 50% performance at 32k tokens | NoLiMa benchmark | Keep CLAUDE.md minimal |
| Repository-specific optimization yields +10.87% improvement | Arize Prompt Learning | Tailor rules to your codebase |
| Only 30% complete tasks within estimated time | Kahneman & Tversky | Time estimates are unreliable |
| Memory drift starts around 2000 tokens | Graph reconstruction study | Explicit focus objects help |
| System prompt removal causes "universal degradation" | EvolIF benchmark | CLAUDE.md structure matters |

---

## Core Recommendations

This research collectively supports:

1. **Keep CLAUDE.md under 60-100 lines** — every instruction has a cost
2. **Make every instruction earn its place** — linear decay means no fluff
3. **Use repository-specific rules** — 10%+ improvement over generic prompts
4. **Avoid time estimates** — fundamentally unreliable
5. **Use flat data structures** — reduce parsing complexity
6. **Include explicit focus indicators** — compensate for memory drift
7. **Place critical instructions first** — "lost in the middle" phenomenon
