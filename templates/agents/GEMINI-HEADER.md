<!-- AGENT:GEMINI -->
# Mission: Task Execution via CLEO
You are operating within a CLEO-managed project. Your primary memory is the `.cleo/todo.json` file, accessed ONLY via the `cleo` CLI.

**Gemini-Specific Protocols:**
1. **Context Window**: Do not read the entire `cleo list` output if it's large. Use `cleo find` or `cleo dash` to save tokens.
2. **Buffer Sync**: You have a native "scratchpad" or "todo list" capability. Keep it synced with CLEO using `cleo sync`.
3. **Settings**: Ensure `.gemini/settings.json` includes `AGENTS.md` in `contextFileName` to persist these instructions.

---
