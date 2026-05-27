# Contributing to LAFS Protocol

Thank you for your interest in contributing to the LLM-Agent-First Specification (LAFS) protocol. Whether you are fixing a typo, adding conformance checks, or proposing spec changes, your contributions help strengthen the standard for LLM-agent interoperability.

## Types of contributions

- **Spec changes** -- Improvements or additions to the canonical protocol spec (`lafs.md`)
- **Reference implementation** -- Enhancements to the TypeScript validation and conformance toolkit in `src/`
- **Fixtures** -- New valid/invalid fixture files for conformance testing
- **Conformance checks** -- New validators and their associated test cases
- **Documentation** -- Improvements to docs, README, or inline comments
- **Bug reports and feature requests** -- Filed as GitHub issues

## Development setup

```bash
# Clone the repository
git clone https://github.com/kryptobaseddev/cleo.git
cd cleo/packages/lafs

# Install dependencies
pnpm install

# Run tests
pnpm test

# Type-check
pnpm run typecheck
```

## Making changes

1. Fork the repository and create a feature branch from `main`.
2. Make your changes with clear, focused commits.
3. Ensure all tests pass (`pnpm test`) and the project type-checks (`pnpm run typecheck`).
4. Submit a pull request with a clear description of the change and its motivation.

Keep pull requests focused on a single concern. If you are fixing a bug and also refactoring nearby code, prefer separate PRs.

## Spec changes (RFC process)

Changes to the canonical spec (`lafs.md`) follow an RFC-style process:

1. **Open an issue** describing the proposed change, its rationale, and its impact on existing consumers.
2. **Discussion** -- Maintainers and community members review the proposal. Expect questions about backward compatibility, adoption-tier impact, and edge cases.
3. **Draft PR** -- Once the issue reaches rough consensus, submit a PR with the spec diff and any required schema, fixture, or tooling updates.
4. **Review** -- All spec changes must be reviewed and approved by at least one maintainer.
5. **Merge** -- After approval, the change is merged and the spec version is updated accordingly.

### Compatibility rules

- Spec changes MUST maintain backward compatibility within a major version.
- Breaking changes require a new major version bump.
- Additive changes (new optional fields, new error codes) are permitted in minor versions.

## Conformance check contributions

When adding new conformance checks:

- Include fixture files for both valid and invalid cases in `fixtures/`.
- Include test cases in `tests/` that exercise the new check.
- Document which adoption tier the check belongs to (see `lafs.md` for tier definitions).
- Ensure the check integrates with the existing CLI (`src/cli.ts`).

## Code of conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/) code of conduct. By participating, you agree to uphold a welcoming, inclusive, and respectful environment for everyone.

## License

By contributing to this project, you agree that your contributions will be licensed under the [MIT License](./LICENSE), the same license that covers the project.
