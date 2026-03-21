/**
 * E2E test: injection chain validation after init.
 *
 * Verifies the new AGENTS.md hub injection architecture:
 * 1. Provider files (CLAUDE.md, GEMINI.md) reference @AGENTS.md
 * 2. Project AGENTS.md references @~/.agents/AGENTS.md (global hub)
 * 3. Global ~/.agents/AGENTS.md references @~/.cleo/templates/CLEO-INJECTION.md
 * 4. No references to @.cleo/templates/AGENT-INJECTION.md anywhere
 * 5. No CLEO:START markers anywhere (CAAMP uses CAAMP:START/END)
 *
 * Since CAAMP functions depend on actual provider installations,
 * they are mocked via vi.mock to isolate the init logic.
 *
 * @task T4694
 * @epic T4663
 */
export {};
//# sourceMappingURL=injection-chain.test.d.ts.map
