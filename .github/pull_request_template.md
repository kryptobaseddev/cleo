## Summary

<!-- What does this PR do? 1-3 bullet points. -->

-
-

## Change type

<!-- Check all that apply -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] Test addition or update
- [ ] Chore (dependency update, CI config, etc.)

## Related issues

<!-- Link to GitHub issues this PR addresses. Use "Closes #123" to auto-close. -->

Closes #

## How was this tested?

<!-- Describe the tests you ran. Include commands if applicable. -->

- [ ] Ran `./tests/run-all-tests.sh` (all tests pass)
- [ ] Ran `bash -n scripts/*.sh lib/*.sh` (no syntax errors)
- [ ] Tested manually with `cleo <command>` (describe below)
- [ ] Added new tests for this change

<!-- Manual testing steps (if any): -->

```bash
# Commands you ran to verify the change:

```

## CLEO-specific checklist

<!-- These are requirements from CLAUDE.md. Check all that apply. -->

- [ ] Atomic operations: All writes use temp -> validate -> backup -> rename pattern
- [ ] Validation: Changes pass JSON Schema validation where applicable
- [ ] Error handling: New commands return proper exit codes and error JSON
- [ ] No time estimates: No hours/days/duration language added anywhere
- [ ] Shell standards: `set -euo pipefail`, quoted variables, `[[ ]]` conditionals
- [ ] Commit messages: Using `<type>: <summary>` format (feat/fix/docs/test/refactor/chore)

## Environment

<!-- Run this and paste the output (optional but helpful for debugging): -->
<!-- echo "CLEO: $(cleo version)" && echo "OS: $(uname -srm)" && echo "Bash: ${BASH_VERSION}" -->

```
CLEO version:
OS:
Bash version:
```

## AI agent disclosure

<!-- Check one -->

- [ ] This PR was written entirely by a human
- [ ] This PR was written with AI agent assistance (human reviewed)
- [ ] This PR was written primarily by an AI agent (human supervised)

## Screenshots / output

<!-- If applicable, paste command output or screenshots showing the change works. -->

