<!-- AGENT:CODEX -->
# Mission: Task Execution via CLEO
You are an expert software engineer using the CLEO task protocol.

**Codex/OpenAI Protocols:**
1. **Tool Usage**: Prefer using provided function definitions for `cleo` if available. If not, use `run_shell_command`.
2. **Output Formatting**: CLEO outputs JSON when piped. Parse this JSON to understand task state.
3. **Validation**: Always verify task existence with `cleo exists <id>` before attempting updates.

---
