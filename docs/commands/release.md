# cleo release - Release Management

Manage releases for roadmap tracking. Track planned, active, and shipped releases with associated tasks and changelog generation.

## Synopsis

```bash
cleo release <subcommand> [options]
```

## Subcommands

### create

Create a new planned release.

```bash
cleo release create <version> [--target-date DATE] [--tasks ID,ID,...] [--notes "text"]
```

**Options:**
- `<version>` - Semantic version (e.g., v0.65.0)
- `--target-date DATE` - Target release date (YYYY-MM-DD)
- `--tasks ID,ID,...` - Initial task IDs to include
- `--notes "text"` - Release notes or description

**Example:**
```bash
cleo release create v0.65.0 --target-date 2026-02-01
cleo release create v0.66.0 --tasks T2058,T2089 --notes "Schema updates"
```

### plan

Add tasks to an existing release.

```bash
cleo release plan <version> --tasks ID,ID,...
```

**Options:**
- `<version>` - Release version to modify
- `--tasks ID,ID,...` - Task IDs to add

**Example:**
```bash
cleo release plan v0.65.0 --tasks T2059,T2060,T2061
```

### ship

Mark a release as shipped.

```bash
cleo release ship <version> [--notes "text"]
```

**Options:**
- `<version>` - Release version to ship
- `--notes "text"` - Final release notes

**Example:**
```bash
cleo release ship v0.65.0 --notes "Schema 2.8.0 with metadata fields"
```

### list

List all releases.

```bash
cleo release list [--status STATUS]
```

**Options:**
- `--status STATUS` - Filter by status (planned, active, released)

**Output:**
```json
{
  "releases": [
    {
      "version": "v0.65.0",
      "status": "released",
      "taskCount": 19,
      "releasedAt": "2026-01-23T07:37:27Z"
    }
  ]
}
```

### show

Show details for a specific release.

```bash
cleo release show <version>
```

**Example:**
```bash
cleo release show v0.65.0
```

**Output:**
```json
{
  "release": {
    "version": "v0.65.0",
    "status": "released",
    "targetDate": "2026-02-01",
    "releasedAt": "2026-01-23T07:37:27Z",
    "tasks": ["T2058", "T2059", "T2060"],
    "notes": "Schema 2.8.0 release"
  }
}
```

### changelog

Generate changelog from release tasks.

```bash
cleo release changelog <version> [--format FORMAT]
```

**Options:**
- `<version>` - Release version
- `--format FORMAT` - Output format (markdown, json)

**Example:**
```bash
cleo release changelog v0.65.0
```

**Output (markdown):**
```markdown
## [v0.65.0] - 2026-01-23

### Features
- Add updatedAt field to todo.schema.json (T2059)
- Add relates array field for non-blocking relationships (T2060)

### Bug Fixes
- No bug fixes

### Other Changes
- Create lib/task-mutate.sh centralized mutation library (T2067)
```

## Release Lifecycle

```
planned → active → released
```

| Status | Description |
|--------|-------------|
| `planned` | Release is planned, not yet started |
| `active` | Release is in active development |
| `released` | Release has been shipped |

## Schema

Releases are stored in `todo.json` under `project.releases`:

```json
{
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "status": "released",
        "targetDate": "2026-02-01",
        "releasedAt": "2026-01-23T07:37:27Z",
        "tasks": ["T2058", "T2059"],
        "notes": "Release notes here"
      }
    ]
  }
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 4 | Release not found |
| 6 | Validation error |
| 101 | Release already exists |

## See Also

- [CHANGELOG.md](../../CHANGELOG.md) - Project changelog
- [Migration Guide](../migration/v2.8.0-migration-guide.md) - Schema 2.8.0 migration
- [Schema Documentation](../schema/) - Field definitions
