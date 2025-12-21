# C.L.E.O. Transition & Multi-Agent Support Plan

**Goal:** Decouple `claude-todo` from Claude-specific branding, rebrand to **CLEO (Comprehensive Logistics & Execution Orchestrator)**, and introduce multi-agent support for Gemini, Kimi, and Codex.

**Target Version:** v1.0.0
**Current Status:** PAUSED (Completing v0.24.x pre-requisites on `main`)

---

## 0. Phase 0: Pre-Requisites (Main Branch)
**Objective:** Ensure the core system is stable and feature-complete before the rebranding refactor.

*   **Hierarchy System**: Ensure `maxSiblings` and `maxDepth` logic is solid (T328 series).
*   **Archive Enhancements**: Complete the smart archive system (T429 series).
*   **Analysis Engine**: Finish "Smart Analyze" (T542).
*   **Compliance**: Ensure "LLM-Agent-First" spec v3.0 compliance (T481 series).

---

## 1. Executive Summary

C.L.E.O. acts as the persistent memory and logistics layer for *any* CLI-based AI agent. The transition involves:
1.  **Rebranding**: `claude-todo` → `cleo`.
2.  **Generalization**: Abstracting `.claude/` directories to `.cleo/`.
3.  **Multi-Agent Ecosystem**: Native support for **concurrent** agents (Claude, Gemini, Kimi, Codex) interacting with the same project.

## 2. Architectural Changes

### A. Configuration Schema Expansion (`schemas/config.schema.json`)

We will add an `agents` section (plural) to support multiple active agents.

```json
"agents": {
  "type": "object",
  "properties": {
    "active": {
      "type": "array",
      "items": { "type": "string", "enum": ["claude", "gemini", "codex", "kimi"] },
      "default": ["claude"],
      "description": "List of active agents enabled for this project."
    },
    "configs": {
      "type": "object",
      "properties": {
        "claude": { "type": "object", "properties": { "docsFile": { "const": "CLAUDE.md" } } },
        "gemini": { "type": "object", "properties": { "docsFile": { "const": "AGENTS.md" } } },
        "kimi": { "type": "object", "properties": { "docsFile": { "const": "INSTRUCTIONS.md" } } },
        "codex": { "type": "object", "properties": { "docsFile": { "const": "INSTRUCTIONS.md" } } }
      }
    }
  }
}
```

### B. Directory Structure & Naming

*   **Global Home**: `~/.claude-todo` → `~/.cleo`
*   **Project Directory**: `.claude/` → `.cleo/`
*   **Legacy Fallback**: Legacy agents might still look for `.claude/`. We may consider symlinking `.claude` -> `.cleo` during the transition period if strictly necessary, but preferably we update the agents' instruction files to look in `.cleo`.

## 3. Implementation Steps

### Phase 1: Templating & Branding (Immediate)

1.  **Create `templates/AGENT-INJECTION.md`**: Generic CLEO instructions.
2.  **Create Agent-Specific Headers**:
    *   `templates/agents/GEMINI-HEADER.md`
    *   `templates/agents/CODEX-HEADER.md`
    *   `templates/agents/KIMI-HEADER.md`

### Phase 2: Core Library Updates (Config & Logging)
*   Refactor `config.sh` and `logging.sh` to support `CLEO_*` env vars and remove hardcoded "claude" references.

### Phase 3: Initialization & Installation (`install.sh`, `init.sh`)

**Crucial Change**: Installation and Initialization are now **Multi-Select**.

1.  **Update `scripts/install.sh`**:
    *   **Interactive Selection**: "Which agents do you use? [x] Claude [ ] Gemini [x] Kimi"
    *   **Global Config**: Write enabled agents to `~/.cleo/config.json`.
    *   **Path Setup**: Ensure paths like `.gemini/`, `.kimi/` are known/created if standard.

2.  **Update `scripts/init.sh`**:
    *   **Loop Processing**: Iterate through all enabled agents in `agents.active`.
    *   **Gemini Logic**:
        *   Check/Create `.gemini/settings.json`.
        *   Update `contextFileName` to include `AGENTS.md`.
        *   Inject/Append to `AGENTS.md`.
    *   **Claude Logic**:
        *   Inject/Append to `CLAUDE.md`.
    *   **Kimi Logic**:
        *   Inject/Append to `INSTRUCTIONS.md`.

### Phase 4: Sync System Generalization (Buffer Sync)

The `sync` command will be refactored to support concurrent syncing for multiple active agents.

*   **`cleo sync --inject`**:
    *   Iterates through all active agents.
    *   **Claude**: Updates TodoWrite (if session active).
    *   **Gemini**: Updates `<!-- CLEO-STATE -->` block in `AGENTS.md`.
    *   **Kimi**: Updates `SetTodoList` call or text block in `INSTRUCTIONS.md`.

*   **`cleo sync --extract`**:
    *   Accepts `--source <agent>` flag (defaulting to the one detected or specified).
    *   Extracts task completions from that specific agent's buffer and updates the persistent `todo.json`.

## 4. Multi-Agent CLI Experience

The same project can support a user switching between agents:

| Feature | Claude Code | Gemini CLI | Kimi / Codex |
| :--- | :--- | :--- | :--- |
| **Command** | `claude-todo` / `ct` | `cleo` | `cleo` |
| **Context** | `CLAUDE.md` | `AGENTS.md` | `INSTRUCTIONS.md` |
| **Sync** | `ct sync` (TodoWrite) | `cleo sync` (Context File) | `cleo sync` (Context File/API) |

## 5. Verification Plan

*   **Mock Project**: `/mnt/projects/cleo-testing`
*   **Test Cases**:
    1.  **Multi-Agent Init**: Run `cleo init` with Claude + Gemini enabled. Verify *both* `CLAUDE.md` and `AGENTS.md` are updated.
    2.  **Gemini Config**: Verify `.gemini/settings.json` is correctly patched using `jq`.
    3.  **Sync Broadcasting**: Verify `cleo sync --inject` updates the state in *all* relevant docs files simultaneously.

---

## 6. Q&A Clarifications

### Q1: Can I have Claude AND Gemini active?
**Answer**: Yes. `cleo init` will check your config (or flags) and update *both* `CLAUDE.md` and `AGENTS.md` (and `.gemini/settings.json`). This allows you to switch agents mid-project and have both fully context-aware.

### Q2: How does `install.sh` work?
**Answer**: It asks you once (globally). "Select your agents: [Claude, Gemini]". This sets your global default. When you run `cleo init` in a new project, it defaults to these, but you can override with flags.

### Q3: What about the `sync` command?
**Answer**: It becomes a broadcaster. `cleo sync --inject` pushes the current `active` tasks to *all* configured agent buffers/context files, ensuring every agent has the latest state.
