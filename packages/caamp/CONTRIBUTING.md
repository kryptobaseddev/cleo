# Contributing to CAAMP

Thanks for helping improve CAAMP.

## Development Setup

1. Fork and clone the repository.
2. Install dependencies:

```bash
npm ci
```

3. Run validation locally:

```bash
npm run lint
npm test
npm run test:coverage
```

## Branch and PR Workflow

- Create a feature branch from `main`.
- Keep commits focused and small.
- Open a pull request with:
  - problem statement
  - implementation notes
  - validation output

## Coding Guidelines

- Follow existing TypeScript patterns.
- Keep user-facing command output clear and actionable.
- Add tests for every behavior change.
- Update docs whenever commands, flags, or APIs change.

## Task Tracking

CAAMP uses CLEO task IDs for roadmap execution.

- Link code work to task IDs where possible.
- Mark task status as work progresses.
- Record validation notes when closing tasks.

## Commit and Validation Expectations

Before asking for review, ensure:

- `npm run lint` passes
- `npm test` passes
- changed behavior has tests
- docs are updated for user-facing changes

## Security Reporting

Do not file public issues for sensitive vulnerabilities.
Use the process in `SECURITY.md`.
