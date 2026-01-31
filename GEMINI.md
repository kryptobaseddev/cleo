<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
# CLEO Project Development Guide

For comprehensive repository guidelines, see @CLAUDE.md for:
- Project overview and core mission
- Project structure and architecture principles
- Build, test, and development commands
- Coding style and naming conventions
- Critical rules and constraints
- Testing guidelines
- Commit and PR guidelines
- Key files and entry points
- Validation and error handling
- Protocol enforcement
- Version management

## Gemini-Specific Notes

### Agent Interaction Rules (CRITICAL)
When acting as an agent within this codebase:
1. **NEVER edit data files directly**: Do not modify `.cleo/*.json` files manually. ALWAYS use CLI commands.
2. **Validate State**: Before assuming task state, run `cleo list` or `cleo exists <ID>`.
3. **Check Exit Codes**: Respect non-zero exit codes - they indicate validation failures.
4. **No Time Estimates**: Use `size` (small/medium/large) instead.
