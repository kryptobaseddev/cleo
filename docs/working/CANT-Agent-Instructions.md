CANT Agent Instructions Research

We breakdown the openclaw agent system templates from AGENTS.md, BOOT.md, BOOTSTRAP.md HEARTBEAT.md, IDENTITY.md, SOUL.md TOOLS.md and USER.md so we can quantify each of these, what makes an agent today in order to apply to the CANT DSL for use across ANY LLM provdier system using '.cant' files

Reference docs form Openclaw:
https://docs.openclaw.ai/reference/AGENTS.default
https://docs.openclaw.ai/reference/templates/AGENTS.md
https://docs.openclaw.ai/reference/templates/BOOT.md
https://docs.openclaw.ai/reference/templates/BOOTSTRAP.md
https://docs.openclaw.ai/reference/templates/HEARTBEAT.md
https://docs.openclaw.ai/reference/templates/IDENTITY.md
https://docs.openclaw.ai/reference/templates/SOUL.md
https://docs.openclaw.ai/reference/templates/TOOLS.md
https://docs.openclaw.ai/reference/templates/USER.md

The whole goal is really creating a comprehensive scope around highly modern non-prose approach for these. I have a 'CANT' DSL standard convention I want to use to create these instruction file type system for agents as their definitions

To transition the OpenClaw framework from legacy, prose-heavy Markdown templates to the highly modern, AST-driven **CANT (Collaborative Agent Notation Tongue) DSL**, we must fundamentally shift our architectural mental model. 

In the legacy OpenClaw paradigm, an agent "reads itself into existence" by parsing thousands of tokens of prose (`AGENTS.md`, `SOUL.md`, etc.). You are essentially *pleading* with a stochastic LLM to simulate a state machine ("please be ethical," "please check this every 5 minutes," "please ask the user before deploying"). This is prone to token amnesia, prompt injection, and hallucination.

Under the CANT paradigm, **an agent is compiled into execution.** Prose is stripped away entirely, except where it acts as a literal instruction to the model (`prompt:`) or an explicit AI evaluation boundary (`**discretion**`). 

Here is the comprehensive breakdown of how we quantify the traditional OpenClaw system templates into deterministic, non-prose CANT architecture.

---

### What Quantifies an Agent in CANT?
An agent is no longer a collection of text files injected into a context window. It is a **secure, bounded state machine** quantified by exactly four structural pillars:
1. **Scope & State Bounds (`kind: agent`)**: Its base model, timeout thresholds, and cryptographic access controls (`read`, `write`, `execute`).
2. **Lifecycle Reactivity (`on Event:`)**: Synchronous hooks that replace "Standard Operating Procedures" with deterministic event-driven triggers.
3. **Deterministic Capability (`kind: skill`, `pipeline`)**: Tools bounded by typed parameters and executable binaries, strictly forbidding shell-injection.
4. **Cognitive Orchestration (`kind: workflow`)**: The flow of data where LLMs are *only* invoked at specific `session` or `discretion` gates to evaluate ambiguity.

---

### 1. `IDENTITY.md` & `SOUL.md` ➔ Embedded Properties & Cryptographic Hooks
**The Legacy Concept:** Sprawling markdown files filled with psychological profiles, ethical guidelines, and behavioral "Red Lines" (e.g., "You never execute destructive commands").
**The CANT Quantification:** "Identity" is distilled down to metadata (`model`, `persist`) and a single `prompt:` string. "Soul" (alignment and ethics) is completely removed from the LLM's hands. It is quantified mathematically into **Closed-Set Permissions** (Rule S13) and **Blocking Hooks** (`on PreToolUse:`). 

If an agent attempts a destructive action, the CANT Rust runtime physically blocks the execution via the AST, rather than relying on the LLM's moral compliance.

```cant
---
kind: agent
version: 1
---

agent openclaw-core:
  model: "opus"
  persist: "project"
  # IDENTITY quantified: Scoped strictly to operational framing
  prompt: "You coordinate operations and delegate tasks. You never implement directly."
  skills: ["fs-read", "db-query"]

  # SOUL quantified: Mathematical access boundaries
  permissions:
    tasks: read, write
    session: read, write
    infrastructure: read   # Can observe, but physically cannot deploy/destroy

  # ALIGNMENT quantified: Enforced by deterministic event hooks, not prose
  on PreToolUse:
    if tool.name == "fs-delete" and **the target path is outside the workspace**:
      deny "System destruction violates core operational alignment."
    else:
      allow
```

### 2. `TOOLS.md` ➔ Explicit Skill Contracts
**The Legacy Concept:** Markdown tables describing what tools exist, leaving the LLM to hallucinate parameters, guess at defaults, or inject unsafe shell syntax.
**The CANT Quantification:** Capabilities are translated into Layer 2 `kind: skill` definitions. Tools are bound by strict, statically analyzed type signatures (`string`, `number`, `boolean`, `duration`). 

```cant
---
kind: skill
version: 1
---

# A quantified capability: strict types, default values, no markdown ambiguity
skill oc-deploy(target: string, env: string = "staging", force: boolean = false):
  description: "Executes deployments against the target environment"
  tier: "core"
  provider: "claude-code"
```

### 3. `BOOT.md` & `BOOTSTRAP.md` ➔ The Deterministic Initialization Pipeline
**The Legacy Concept:** "When you wake up, read the environment, look at these folders, and figure out what's going on." This wastes expensive tokens and introduces hallucination risks during startup.
**The CANT Quantification:** Initialization requires **zero LLM involvement**. It is quantified as a Layer 3 `pipeline`. Pipelines are purely deterministic, execute directly on the host OS, and statically forbid LLM sessions or discretion (Rules P01-P05). Command injection is structurally impossible (Rule P06).

```cant
---
kind: hook
version: 1
---

on SessionStart:
  # BOOTSTRAP quantified: Pure compute pipeline. No AI allowed.
  pipeline system-boot:
    step check-node:
      command: "node"
      args: ["--version"]
      timeout: 10s

    step init-workspace:
      command: "mkdir"
      args: ["-p", ".openclaw/memory"]
      condition: check-node.exitCode == 0
      timeout: 5s

  # Context injected only after deterministic success
  if system-boot.init-workspace.exitCode == 0:
    session "Digest initial workspace state"
      context: [system-boot]
  else:
    throw "Boot sequence halted: Environment validation failed."
```

### 4. `HEARTBEAT.md` ➔ Temporal Orchestration & Bounded Loops
**The Legacy Concept:** A cron job wakes the agent up, forces it to read `HEARTBEAT.md`, and asks, "Is there anything you should do right now?" (Runaway token usage, infinite loops).
**The CANT Quantification:** We decouple data-gathering from cognition. A `workflow` uses a deterministic `pipeline` to gather state data *first* (cheap, fast). Then, it uses a bounded `repeat` loop (capped by Rule W10) and an AI-evaluated `choice` block to determine if cognition is actually required.

```cant
---
kind: workflow
version: 1
---

workflow autonomous-heartbeat(max_cycles: number = 24):
  repeat max_cycles:
    # 1. Deterministic observation (0 LLM tokens spent)
    pipeline monitor:
      step fetch-alerts:
        command: "pagerduty-cli"
        args: ["alerts", "list", "--status", "triggered"]
        timeout: 15s

    # 2. Only invoke the LLM if the deterministic check finds something
    if monitor.fetch-alerts.exitCode == 0:
      
      # 3. Cognitive routing via Multi-Option AI Selection
      choice **severity of the triggered alerts**:
        option "critical":
          /action @ops-lead #P0 "Immediate triage required"
          session "Draft incident response plan"
        option "warning":
          /info @all "Non-critical alert logged"
        option "none":
          session "Continue background idle"
```

### 5. `USER.md` ➔ Context Bindings & Approval Gates
**The Legacy Concept:** A file outlining the human handler's preferences ("My name is Admin, please ask me before you deploy to production"). 
**The CANT Quantification:** User preferences are quantified into strongly typed `let` bindings or `config` imports. Crucially, "asking the user" is replaced by strict **Approval Gates**. Human context is quantified by explicit checkpoints where execution is natively suspended by the runtime, awaiting cryptographic token validation (`/approve {token}`).

```cant
---
kind: workflow
version: 1
---

@import "./config/user-prefs.cant" as user

workflow destructive-operation(target: string):
  let assessment = session "Analyze impact of modifying ${target}"
  
  # Human context quantified: The LLM cannot bypass an Approval Gate (Rule P03/W01)
  approve:
    message: "AI assessment complete. Destructive action queued for ${target}. Proceed?"
    expires: 2h

  # This only executes if the human replies with `/approve {token}`
  pipeline execute:
    step modify:
      command: "terraform"
      args: ["apply", "-target", target, "-auto-approve"]
      timeout: 600s
```

### 6. `AGENTS.md` ➔ The Distributed Topology Graph
**The Legacy Concept:** A master document listing all agents, asking the LLM to read the "org chart" and figure out who to talk to.
**The CANT Quantification:** Distributed, strictly-typed files organized via `@import` topologies. The CANT parser statically resolves dependencies, prevents circular imports (Rule S03), and blocks permission escalation across boundaries (Rule S12). 

```cant
---
kind: workflow
version: 1
---

# The Topology is explicitly imported, forming a static DAG
@import "./agents/security-scanner.cant" as scanner
@import "./agents/style-checker.cant" as styler

workflow swarm-review(pr_url: string):
  pipeline fetch-pr:
    step fetch:
      command: "gh"
      args: ["pr", "diff", pr_url]
      timeout: 30s
      
  # Parallel sub-agent routing (replaces LLM guesswork)
  parallel settle:
    sec_audit = session: scanner
      context: [fetch-pr]
    style_audit = session: styler
      context: [fetch-pr]
      
  if **critical flaws found in either review**:
    /blocked T{pr_url} #review-failed
    output verdict = "blocked"
```

---

### Summary of the Paradigm Shift

By moving OpenClaw templates into the CANT DSL, you achieve **Verifiable Agency**:
1. **LSP Diagnostics:** `AGENTS.md` typos used to silently fail in the LLM's brain. Now, `cant-lsp` flags `Rule S01: Unresolved reference` instantly in your IDE.
2. **Security by Default:** Bootstrapping and tool executions are stripped of shell injection risks (Rule P06). The LLM cannot hallucinate an arbitrary `sh -c` command.
3. **Token Efficiency:** You only inject prose (`prompt: "..."`, `**discretion**`) exactly when `session` or `choice` is called. The LLM isn't carrying `BOOTSTRAP.md` in its context window while trying to write code.
4. **Determinism:** The line between *what the system does* (Layer 3 Pipelines) and *what the AI thinks* (Layer 3 Sessions/Discretion) is mathematically separated in the AST.
