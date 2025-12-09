# Changelog

All notable changes to the claude-todo system will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2025-12-09

### Added
- **update-task.sh**: New command to update existing task fields
  - Scalar fields: `--title`, `--status`, `--priority`, `--description`, `--phase`, `--blocked-by`
  - Array fields with append-by-default: `--labels`, `--files`, `--acceptance`, `--depends`, `--notes`
  - Replace mode: `--set-labels`, `--set-files`, `--set-acceptance`, `--set-depends`
  - Clear mode: `--clear-labels`, `--clear-files`, `--clear-acceptance`, `--clear-depends`
- **CLI routing**: Added `update` command to main CLI wrapper
- **Documentation**: Full update-task.sh section in usage.md, CLAUDE.md, README.md

### Changed
- **install.sh**: Added update command to CMD_MAP and CMD_DESC arrays
- **Help output**: Update command now appears in `claude-todo help`

## [0.3.1] - 2025-12-06

### Changed
- **Checksum behavior**: Changed from blocking to detection-only (INFO log instead of ERROR + exit)
- **Multi-writer support**: CLI now works seamlessly with TodoWrite tool modifications
- **Documentation reorganization**: Moved ARCHITECTURE.md, SYSTEM-DESIGN-SUMMARY.md, MIGRATION-SYSTEM-SUMMARY.md to docs/
- **README.md**: Added badges, table of contents, improved structure for open source

### Fixed
- **complete-task.sh**: No longer fails when TodoWrite modifies todo.json
- **Cross-references**: Updated all internal doc links after file moves
- **Field naming**: Fixed snake_case to camelCase in docs (createdAt, completedAt)

### Updated
- **DATA-FLOW-DIAGRAMS.md**: Revised checksum flow diagram to reflect detection-only behavior
- **design-principles.md**: Added architectural decision for checksum behavior
- **INDEX.md**: Added missing docs (migration-guide.md, ENHANCEMENT-todowrite-integration.md)

## [0.3.0] - 2025-12-06

### Added
- **Checksum verification diagram**: Visual workflow in DATA-FLOW-DIAGRAMS.md
- **Log format versioning**: `formatVersion` field in log schema for future compatibility
- **Template documentation**: README.md documenting placeholder contract ({{PROJECT_NAME}}, {{TIMESTAMP}}, {{CHECKSUM}})
- **activeForm documentation**: Explained auto-derived field in design-principles.md

### Changed
- **archive.sh help**: Comprehensive explanation of --force vs --all behavior with examples
- **stats.sh help**: Added JSON output structure documentation
- **Performance targets**: Clarified as design goals, not verified benchmarks
- **Error messages**: Updated troubleshooting.md to match actual [ERROR] format
- **Archive metadata**: Fixed schema-reference.md (sessionId/cycleTimeDays are optional)
- **INDEX.md**: Added design-principles.md to Architecture section

### Verified
- Session protocol in WORKFLOW.md is fully implemented (session, focus, log commands)
- All 7 test suites passing
- CI/CD pipeline functional

## [0.2.6] - 2025-12-06

### Added
- **Date filtering**: `--since` and `--until` options for list-tasks.sh
- **Sorting**: `--sort` option (status, priority, createdAt, title) and `--reverse` flag
- **Test coverage**: New tests for session, focus, export, and migrate commands (7 total test suites)
- **CI/CD**: GitHub Actions workflow with test, lint, JSON validation, and install jobs
- **CONTRIBUTING.md**: Comprehensive contribution guidelines for open source

### Changed
- Documentation fully aligned with implemented features

## [0.2.5] - 2025-12-05

### Added
- CHANGELOG.md for version tracking

## [0.2.4] - 2025-12-06

### Changed
- Install script now auto-upgrades without prompts when newer version available
- Same version shows "already up to date" instead of prompting
- Downgrade requires confirmation (safety check)

### Fixed
- Readonly variable conflict in stats.sh (`LOG_FILE` → `STATS_LOG_FILE`)

## [0.2.3] - 2025-12-06

### Fixed
- Stats command failed due to readonly variable conflict with logging.sh

## [0.2.2] - 2025-12-06

### Added
- Platform compatibility layer (`lib/platform-compat.sh`)
  - Cross-platform support for Linux, macOS, Windows/WSL
  - Tool detection with helpful error messages
  - Cross-platform date/time, file operations, random generation
- Schema migration system (`lib/migrate.sh`, `scripts/migrate.sh`)
  - Safe version upgrades with automatic backup and rollback
  - Version checking integrated with validation
  - `claude-todo migrate status/check/run` commands
- `--force` flag to install.sh for non-interactive upgrades
- `migrate` command to CLI wrapper

### Fixed
- Documentation: archive.sh options (removed non-existent `--days`, `--verbose`)
- Documentation: complete-task.sh options (only `--skip-archive` exists)
- Documentation: config field names updated to camelCase throughout
- Documentation: log entry structure in QUICK-REFERENCE.md
- Documentation: PATH setup clarified in installation.md

## [0.2.1] - 2025-12-05

### Added
- TodoWrite integration for Claude Code
- `claude-todo export --format todowrite` command
- Grammar transformation library for activeForm generation
- Export to JSON and Markdown formats

## [0.2.0] - 2025-12-05

### Changed
- CLI works immediately after install (symlinks in ~/.local/bin)
- No shell restart required for Claude Code

### Fixed
- PATH configuration for immediate use

## [0.1.0] - 2025-12-05

### Added
- Initial release with centralized versioning
- Core task management (add, complete, list, archive)
- Session management (start, end, status)
- Focus tracking (set, clear, note)
- Validation with anti-hallucination checks
- Automatic backups
- Statistics and reporting

## [0.0.1] - 2025-12-05

### Added
- Initial project structure
- JSON schemas for todo, config, archive, log
- Basic CLI wrapper
