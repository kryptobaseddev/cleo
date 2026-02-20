# CLAUDE.md Quick Reference Card

## File Locations (Load Order)
```
1. /Library/Application Support/ClaudeCode/CLAUDE.md  (Enterprise)
2. ~/.claude/CLAUDE.md                                 (User global)
3. ./CLAUDE.md or ./.claude/CLAUDE.md                 (Project shared)
4. ./CLAUDE.local.md                                   (Project personal - gitignored)
5. ./subdir/CLAUDE.md                                  (On-demand when accessing subdir)
```

## Size Limits
| Metric | Limit |
|--------|-------|
| Target lines | < 60 |
| Maximum lines | < 100 |
| Absolute ceiling | 300 |
| Available instruction budget | ~100-150 (Claude Code uses ~50) |

## Must Include
✓ Build/dev/test commands
✓ Critical file locations  
✓ Non-obvious conventions
✓ Verification steps
✓ Branch/commit conventions (if non-standard)

## Never Include
✗ API keys, credentials, secrets
✗ Lengthy code examples
✗ Generic coding standards
✗ Full documentation
✗ Anything a linter should handle
✗ **Time estimates** (hours/days/weeks)

## Import Syntax
```markdown
@docs/architecture.md           # Relative path
@~/personal-prefs.md            # Home directory
@README.md                      # With context reference
```
- Max depth: 5 levels
- Ignored inside code blocks

## Quick Add Shortcut
Press `#` during session to add memory:
```
# Always run typecheck before commits
```

## Emphasis Keywords
- `**IMPORTANT**:` - Should follow
- `**CRITICAL**:` - Must follow
- `**NEVER**:` - Hard boundaries
- `**REQUIRED**:` - Mandatory actions

## Template Structure
```markdown
# Project Name

## Stack
[3-5 key technologies]

## Commands
[5-7 most used commands]

## Structure
[High-level directory map]

## Rules
[3-5 critical rules with emphasis]

## Docs
[@imports for detailed docs]
```

## Maintenance Rhythm
- **Daily**: Add friction points with #
- **Weekly**: Remove stale, consolidate duplicates
- **Monthly**: Run through prompt improver
- **Per PR**: Review CLAUDE.md changes

## Time Estimates — PROHIBITED
- **Never** provide hours/days/weeks estimates
- LLMs cannot track time or predict duration
- LLMs inherit human biases (don't improve accuracy)
- METR study: AI made devs 19% *slower*
- Use scope/complexity/dependencies instead
- Relative sizing OK: small/medium/large

## Anti-Pattern Checklist
□ Not a kitchen sink (< 100 lines?)
□ Not aspirational (actually used?)
□ Not duplicating README
□ Not a style guide (use linters)
□ No unused imports
□ No accumulated hotfixes
□ No time estimates anywhere

## When to Use Subfolder CLAUDE.md
✓ Monorepo with different stacks
✓ Multi-language projects
✓ Legacy vs. modern code sections
✓ Generated code directories

## Commands Reference
```bash
/init           # Generate initial CLAUDE.md
/memory         # Edit memory files
/clear          # Reset conversation
/compact        # Compress context
```

## Key Principle
> Everything in CLAUDE.md affects EVERY session.
> High leverage = High scrutiny.
> When in doubt, leave it out.
