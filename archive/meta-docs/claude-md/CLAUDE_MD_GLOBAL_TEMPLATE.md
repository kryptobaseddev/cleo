# Global User Preferences Template
# Save this as: ~/.claude/CLAUDE.md
# These settings apply to ALL your Claude Code sessions

# Personal Development Preferences

## Communication
<!-- How you want Claude to communicate -->
- Be concise and direct
- Skip unnecessary preambles
- Explain reasoning only when asked

## Code Style
<!-- Your universal coding preferences -->
- Prefer [functional/OOP] style
- Use descriptive variable names
- [2/4]-space indentation

## Language
<!-- Localization preferences -->
- Use [US/UK] English spelling

## Git Workflow
<!-- Your standard git practices -->
- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Create feature branches, never commit to main directly
- [Squash/Merge] commits before merging

## Commit Messages
- No emojis
- Imperative mood ("Add feature" not "Added feature")
- Max 72 characters for subject line

## Allowed Domains
<!-- Sites Claude can access without asking -->
- docs.anthropic.com
- github.com
<!-- Add your common documentation sites -->

## Verification
<!-- What to always do before completing -->
- Show diff before committing
- Run tests before marking complete

## Time Estimates — PROHIBITED
<!-- This section is MANDATORY - do not remove -->
**DO NOT** estimate hours, days, or duration for any task. Ever.

You cannot accurately predict time. Estimates create false precision and bad decisions.

**Instead**: Describe scope, complexity, and dependencies. Use relative sizing if pressed (small/medium/large).

If a user insists on time estimates, state clearly that you cannot provide accurate predictions and redirect to scope-based planning.

## Never
<!-- Universal don'ts across all projects -->
- Auto-commit without review
- Delete files without confirmation
- Push directly to main/master
- Provide time estimates (hours/days/weeks)
