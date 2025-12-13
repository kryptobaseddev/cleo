# CLI Output Reference

Comprehensive reference for all output formats available in claude-todo CLI.

---

## Table of Contents

1. [Output Formats Overview](#output-formats-overview)
2. [Format Specifications](#format-specifications)
3. [Short Flags Reference](#short-flags-reference)
4. [Color Control](#color-control)
5. [Use Cases by Format](#use-cases-by-format)
6. [Format Comparison Matrix](#format-comparison-matrix)

---

## Output Formats Overview

Claude-todo supports multiple output formats for different use cases:

| Format | Purpose | Best For |
|--------|---------|----------|
| `text` | Human-readable terminal output | Interactive CLI use, viewing tasks |
| `json` | Structured data with metadata | API integration, complex parsing |
| `jsonl` | Streaming JSON (one per line) | Log processing, streaming tools |
| `csv` | Comma-separated values | Spreadsheet import, data analysis |
| `tsv` | Tab-separated values | Unix tools, data processing |
| `markdown` | Formatted checklists | Documentation, GitHub issues |
| `table` | ASCII table layout | Reports, compact viewing |

---

## Format Specifications

### TEXT Format (Default)

**Use Case**: Human-readable terminal output with colors and formatting

**Characteristics**:
- Color-coded status indicators
- Priority badges
- Grouped by priority (unless `--flat`)
- Emoji icons for visual scanning
- Respects `NO_COLOR` environment variable

**Example**:
```
📋 Active Tasks (3)

🔴 CRITICAL Priority

[active] Implement authentication
  ID: T002
  Priority: high
  Files: src/auth/jwt.ts, src/middleware/auth.ts
  Labels: backend, security
  Created: 2025-12-05T09:30:00Z

🟡 MEDIUM Priority

[pending] Fix navigation bug
  ID: T001
  Priority: medium
  Created: 2025-12-05T10:00:00Z

[pending] Add user dashboard
  ID: T003
  Priority: medium
  Labels: frontend, ui
  Created: 2025-12-05T10:15:00Z
```

**Commands Supporting TEXT**:
- `list` (default)
- `stats`
- `validate`
- `archive --dry-run`

---

### JSON Format

**Use Case**: Machine-readable structured data with metadata envelope

**Characteristics**:
- `_meta` envelope with version, timestamp, and filter info
- Complete task objects
- Suitable for API responses
- Preserves all task fields

**Example**:
```json
{
  "_meta": {
    "version": "2.1.0",
    "timestamp": "2025-12-12T10:00:00Z",
    "count": 3,
    "filtered": true,
    "filters": {
      "status": ["pending", "active"],
      "priority": ["high"]
    }
  },
  "tasks": [
    {
      "id": "T002",
      "title": "Implement authentication",
      "status": "active",
      "priority": "high",
      "description": "Add JWT-based auth",
      "files": ["src/auth/jwt.ts", "src/middleware/auth.ts"],
      "labels": ["backend", "security"],
      "createdAt": "2025-12-05T09:30:00Z",
      "updatedAt": "2025-12-05T10:00:00Z"
    },
    {
      "id": "T001",
      "title": "Fix navigation bug",
      "status": "pending",
      "priority": "medium",
      "labels": [],
      "createdAt": "2025-12-05T10:00:00Z"
    }
  ]
}
```

**Commands Supporting JSON**:
- `list --format json`
- `export --format json`
- `add --format json` (returns created task)
- `stats --format json`

**jq Integration Examples**:
```bash
# Extract task IDs
claude-todo list -f json | jq -r '.tasks[].id'

# Filter by label in jq
claude-todo list -f json | jq '.tasks[] | select(.labels | contains(["backend"]))'

# Count tasks by status
claude-todo list -f json | jq '.tasks | group_by(.status) | map({status: .[0].status, count: length})'
```

---

### JSONL Format (JSON Lines)

**Use Case**: Streaming JSON, one object per line (no array wrapper)

**Characteristics**:
- One JSON object per line
- No metadata envelope
- Ideal for streaming processors
- Compatible with Unix line-oriented tools
- Each line is valid JSON

**Example**:
```
{"id":"T001","title":"Fix navigation bug","status":"pending","priority":"medium","labels":[],"createdAt":"2025-12-05T10:00:00Z"}
{"id":"T002","title":"Implement authentication","status":"active","priority":"high","files":["src/auth/jwt.ts"],"labels":["backend","security"],"createdAt":"2025-12-05T09:30:00Z"}
{"id":"T003","title":"Add user dashboard","status":"pending","priority":"medium","labels":["frontend","ui"],"createdAt":"2025-12-05T10:15:00Z"}
```

**Commands Supporting JSONL**:
- `list --format jsonl`
- `export --format jsonl`

**Use Cases**:
```bash
# Stream processing with jq
claude-todo list -f jsonl | jq -c 'select(.priority == "high")'

# Log file analysis
cat tasks.jsonl | grep '"status":"active"'

# Pipe to other tools
claude-todo list -f jsonl | parallel --pipe process-task.sh

# Append to log file
claude-todo list -f jsonl >> task-history.jsonl
```

---

### CSV Format

**Use Case**: Spreadsheet import, data analysis, Excel compatibility

**Characteristics**:
- RFC 4180 compliant
- Proper escaping of quotes and commas
- Array fields joined with semicolons
- Header row by default
- UTF-8 encoding

**Example**:
```csv
id,title,status,priority,labels,files,createdAt
T001,"Fix navigation bug",pending,medium,"","",2025-12-05T10:00:00Z
T002,"Implement authentication",active,high,"backend;security","src/auth/jwt.ts;src/middleware/auth.ts",2025-12-05T09:30:00Z
T003,"Add user dashboard",pending,medium,"frontend;ui","",2025-12-05T10:15:00Z
```

**Commands Supporting CSV**:
- `list --format csv`
- `export --format csv`
- `stats --format csv`

**Options**:
- `--no-header`: Omit header row
- `--delimiter <char>`: Custom delimiter (default: `,`)

**Use Cases**:
```bash
# Export to Excel-compatible CSV
claude-todo list -f csv > tasks.csv

# Custom delimiter (pipe-separated)
claude-todo list -f csv --delimiter '|' > tasks.psv

# Import to PostgreSQL
claude-todo list -f csv | psql -c "COPY tasks FROM STDIN CSV HEADER"

# No header for scripts
claude-todo list -f csv --no-header | while IFS=, read -r id title status; do
  echo "Task $id: $title ($status)"
done
```

---

### TSV Format

**Use Case**: Unix tools, tab-delimited data processing

**Characteristics**:
- Tab-separated values
- No quoting needed (tabs escaped)
- Unix-friendly format
- Header row by default

**Example**:
```tsv
id	title	status	priority	labels	files	createdAt
T001	Fix navigation bug	pending	medium			2025-12-05T10:00:00Z
T002	Implement authentication	active	high	backend;security	src/auth/jwt.ts;src/middleware/auth.ts	2025-12-05T09:30:00Z
T003	Add user dashboard	pending	medium	frontend;ui		2025-12-05T10:15:00Z
```

**Commands Supporting TSV**:
- `list --format tsv`
- `export --format tsv`

**Use Cases**:
```bash
# Cut columns with cut command
claude-todo list -f tsv | cut -f1,2,3

# AWK processing
claude-todo list -f tsv | awk -F'\t' '$3 == "active" {print $2}'

# Sort by priority
claude-todo list -f tsv --no-header | sort -t$'\t' -k4

# Import to SQLite
.import "|claude-todo list -f tsv" tasks
```

---

### Markdown Format

**Use Case**: Documentation, GitHub issues, checklists

**Characteristics**:
- GitHub-flavored markdown
- Checkbox lists
- Status indicators
- Priority badges
- Links to task IDs (if configured)

**Example**:
```markdown
## Active Tasks

### 🔴 High Priority

- [x] **T002** Implement authentication `active`
  - Labels: backend, security
  - Files: src/auth/jwt.ts, src/middleware/auth.ts
  - Created: 2025-12-05

### 🟡 Medium Priority

- [ ] **T001** Fix navigation bug `pending`
  - Created: 2025-12-05

- [ ] **T003** Add user dashboard `pending`
  - Labels: frontend, ui
  - Created: 2025-12-05
```

**Commands Supporting Markdown**:
- `list --format markdown`
- `export --format markdown`

**Use Cases**:
```bash
# Export to README
claude-todo list -f markdown > TODO.md

# GitHub issue template
claude-todo list -s pending -f markdown | gh issue create --title "Sprint Tasks" --body-file -

# Documentation generation
echo "# Project Tasks" > docs/tasks.md
claude-todo list -f markdown >> docs/tasks.md
```

---

### Table Format

**Use Case**: Compact terminal viewing, reports

**Characteristics**:
- ASCII box-drawing characters
- Fixed-width columns
- Truncation for long fields
- Clean alignment

**Example**:
```
┌──────┬──────────────────────────┬─────────┬──────────┬─────────────────┐
│ ID   │ Title                    │ Status  │ Priority │ Labels          │
├──────┼──────────────────────────┼─────────┼──────────┼─────────────────┤
│ T001 │ Fix navigation bug       │ pending │ medium   │                 │
│ T002 │ Implement authentication │ active  │ high     │ backend,security│
│ T003 │ Add user dashboard       │ pending │ medium   │ frontend,ui     │
└──────┴──────────────────────────┴─────────┴──────────┴─────────────────┘
```

**Commands Supporting Table**:
- `list --format table`

**Use Cases**:
```bash
# Quick overview
claude-todo list -f table

# Report generation
claude-todo list -s active -f table > report.txt

# Email reports
claude-todo stats --format table | mail -s "Weekly Report" team@example.com
```

---

## Short Flags Reference

### Common Short Flags

| Short | Long | Commands | Description |
|-------|------|----------|-------------|
| `-s` | `--status` | list, add, update | Filter by or set task status |
| `-p` | `--priority` | list, add, update | Filter by or set task priority |
| `-l` | `--label/--labels` | list, add, update | Filter by or set labels |
| `-f` | `--format` | list, export | Output format |
| `-v` | `--verbose` | list | Show all task details |
| `-c` | `--compact` | list | Compact one-line view |
| `-q` | `--quiet` | list, add, export | Suppress informational messages |
| `-h` | `--help` | all | Show command help |

### Flag Combinations

```bash
# High-priority backend tasks in JSON
claude-todo list -p high -l backend -f json

# Compact view of pending tasks
claude-todo list -s pending -c

# Quiet CSV export
claude-todo export -f csv -q > tasks.csv

# Verbose table view
claude-todo list -v -f table

# Multiple filters with short flags
claude-todo list -s active -p critical -l security -f json
```

---

## Color Control

### NO_COLOR Standard

Claude-todo follows the [NO_COLOR](https://no-color.org/) standard:

```bash
# Disable all colors
export NO_COLOR=1
claude-todo list

# Or per-command
NO_COLOR=1 claude-todo list
```

### FORCE_COLOR

Force colors even when stdout is not a TTY (useful for CI/CD with color-aware loggers):

```bash
# Force colors
export FORCE_COLOR=1
claude-todo list | tee output.log

# Or per-command
FORCE_COLOR=1 claude-todo list > report.txt
```

### Color Detection Logic

1. If `NO_COLOR` is set → **colors disabled**
2. If `FORCE_COLOR` is set → **colors enabled**
3. If stdout is not a TTY → **colors disabled**
4. Otherwise → **colors enabled**

### Color Palette

**Status Colors**:
- 🟢 `pending` - Green
- 🔵 `active` - Blue
- 🟡 `blocked` - Yellow
- ⚫ `done` - Gray

**Priority Colors**:
- 🔴 `critical` - Red (bold)
- 🟠 `high` - Orange
- 🟡 `medium` - Yellow
- 🟢 `low` - Green

---

## Use Cases by Format

### Interactive CLI Usage
**Format**: `text` (default)
```bash
claude-todo list
claude-todo list -s active
```

### API Integration
**Format**: `json`
```bash
# RESTful API response
curl -s http://localhost:3000/tasks | jq '._meta.count'

# Webhook payload
claude-todo list -f json | curl -X POST -H "Content-Type: application/json" -d @- https://webhook.site/...
```

### Log Processing
**Format**: `jsonl`
```bash
# Stream to log aggregator
claude-todo list -f jsonl | logger -t claude-todo

# Real-time monitoring
tail -f tasks.jsonl | jq -c 'select(.priority == "critical")'
```

### Spreadsheet Analysis
**Format**: `csv`
```bash
# Excel import
claude-todo list -f csv > tasks.csv

# Google Sheets import
claude-todo export -f csv | gsheet-import --sheet "Tasks"
```

### Unix Pipeline Processing
**Format**: `tsv`
```bash
# AWK processing
claude-todo list -f tsv | awk -F'\t' '$3 == "active" {print $2}'

# Cut specific columns
claude-todo list -f tsv | cut -f1,2,4
```

### Documentation Generation
**Format**: `markdown`
```bash
# Project README
claude-todo list -f markdown > docs/TASKS.md

# GitHub wiki
claude-todo list -s pending -f markdown | gh api repos/{owner}/{repo}/wiki/pages -F title="Tasks" -F body=@-
```

### Terminal Reports
**Format**: `table`
```bash
# Daily standup
claude-todo list -s active -f table

# Team dashboard
watch -n 60 'claude-todo list -f table'
```

---

## Format Comparison Matrix

| Feature | TEXT | JSON | JSONL | CSV | TSV | Markdown | Table |
|---------|------|------|-------|-----|-----|----------|-------|
| Human-readable | ✅ | ❌ | ❌ | ⚠️ | ⚠️ | ✅ | ✅ |
| Machine-parsable | ❌ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| Color support | ✅ | ❌ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ |
| Streaming-friendly | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Excel compatible | ❌ | ❌ | ❌ | ✅ | ⚠️ | ❌ | ❌ |
| Unix tools friendly | ❌ | ⚠️ | ✅ | ⚠️ | ✅ | ❌ | ❌ |
| GitHub rendering | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ⚠️ |
| Metadata envelope | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Array field support | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ |

**Legend**:
- ✅ Full support
- ⚠️ Partial support / with limitations
- ❌ Not supported

---

## Best Practices

### Format Selection Guidelines

**Choose TEXT when**:
- Viewing tasks interactively in terminal
- You need colors for quick visual scanning
- Output is for human consumption

**Choose JSON when**:
- Building APIs or web services
- Need metadata about the query
- Parsing with jq or other JSON tools
- Integrating with JavaScript/TypeScript

**Choose JSONL when**:
- Streaming large datasets
- Appending to log files
- Processing line-by-line
- Need simple parallelization

**Choose CSV when**:
- Importing to Excel/Google Sheets
- Data analysis in R or Python pandas
- Need maximum compatibility
- Sharing data with non-technical users

**Choose TSV when**:
- Using Unix tools (cut, awk, sort)
- Need simple columnar data
- Avoiding CSV escaping complexity
- Working with tab-delimited databases

**Choose Markdown when**:
- Creating documentation
- GitHub issues or wiki pages
- Project README files
- Checklist-style viewing

**Choose Table when**:
- Quick terminal overview
- Generating text reports
- Fixed-width output needed
- Compact viewing in small terminals

### Performance Considerations

**Format Processing Speed** (fastest to slowest):
1. JSONL (streaming, minimal overhead)
2. TSV (simple tab split)
3. TEXT (color processing)
4. CSV (RFC 4180 escaping)
5. JSON (full envelope)
6. Table (box drawing, alignment)
7. Markdown (formatting, grouping)

**Memory Usage** (lightest to heaviest):
1. JSONL (line-by-line)
2. TSV (minimal structure)
3. CSV (escaping overhead)
4. TEXT (color codes)
5. JSON (full object tree)
6. Table (alignment buffer)
7. Markdown (multi-pass formatting)

---

## Examples and Recipes

### Integration Patterns

#### API Response
```bash
#!/bin/bash
# api-endpoint.sh - Return JSON for API
echo "Content-Type: application/json"
echo ""
claude-todo list -f json -q
```

#### Daily Report Email
```bash
#!/bin/bash
# daily-report.sh - Email team report
{
  echo "Daily Task Report"
  echo "================="
  echo ""
  claude-todo list -s active -f table
  echo ""
  claude-todo stats --period 1
} | mail -s "Daily Report" team@example.com
```

#### Spreadsheet Export
```bash
#!/bin/bash
# export-to-sheets.sh - Google Sheets export
claude-todo list -f csv | \
  gsheet-import \
    --spreadsheet "Team Tasks" \
    --sheet "Current Sprint" \
    --replace
```

#### Log Aggregation
```bash
#!/bin/bash
# log-tasks.sh - Send to centralized logging
claude-todo list -f jsonl | \
  while read -r task; do
    echo "$task" | \
      curl -X POST \
        -H "Content-Type: application/json" \
        -d @- \
        https://logs.example.com/tasks
  done
```

#### Database Import
```sql
-- import-tasks.sql - PostgreSQL import
CREATE TABLE tasks (
  id VARCHAR(10),
  title TEXT,
  status VARCHAR(20),
  priority VARCHAR(20),
  labels TEXT,
  created_at TIMESTAMP
);

\copy tasks FROM PROGRAM 'claude-todo list -f csv --no-header' CSV
```

---

## Troubleshooting

### Colors Not Working

**Problem**: Colors not displayed in terminal

**Solutions**:
```bash
# Check if NO_COLOR is set
echo $NO_COLOR
unset NO_COLOR

# Check if stdout is a TTY
[ -t 1 ] && echo "TTY" || echo "Not a TTY"

# Force colors
FORCE_COLOR=1 claude-todo list
```

### CSV Escaping Issues

**Problem**: CSV fields with commas not properly quoted

**Solution**: Claude-todo follows RFC 4180 strictly. If issues persist:
```bash
# Use TSV instead
claude-todo list -f tsv

# Or custom delimiter
claude-todo list -f csv --delimiter '|'
```

### JSONL Parsing Errors

**Problem**: Cannot parse JSONL as regular JSON

**Solution**: JSONL is line-oriented, not a JSON array:
```bash
# Process line-by-line
while read -r line; do
  echo "$line" | jq '.'
done < tasks.jsonl

# Or use jq compact mode
cat tasks.jsonl | jq -c '.'
```

### Large Output Performance

**Problem**: Slow rendering with many tasks

**Solutions**:
```bash
# Use limit flag
claude-todo list --limit 100 -f text

# Use streaming format
claude-todo list -f jsonl | head -n 50

# Use compact view
claude-todo list -c
```

---

## Related Documentation

- [Usage Guide](usage.md) - Complete command reference
- [Configuration](configuration.md) - Output format settings
- [Export Guide](export.md) - Detailed export options

---

**Last Updated**: 2025-12-12
**Version**: 2.1.0
