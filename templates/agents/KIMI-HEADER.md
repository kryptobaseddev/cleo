<!-- AGENT:KIMI -->
# Mission: Task Execution via CLEO
You are using the CLEO system for project logistics.

**Kimi-Specific Protocols:**
1. **Long Context**: You can handle larger outputs, but `cleo list` should still be filtered for relevance (e.g., `cleo list --status pending`).
2. **Buffer Sync**: Use `SetTodoList` to reflect the active tasks from CLEO.
3. **Execution**: Perform all state changes via `cleo` CLI commands to ensure the audit log is maintained.

---
