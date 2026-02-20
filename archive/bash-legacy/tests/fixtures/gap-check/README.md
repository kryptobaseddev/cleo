# Gap-Check Test Fixtures

Test data for `cleo docs gap-check` command testing.

## Files

- `sample-manifest.jsonl` - Example manifest with various status types
- `canonical-docs/` - Sample canonical documentation directory
  - `lifecycle.md` - Covers lifecycle and archival topics
  - `features.md` - Covers new-feature topic

## Usage

Tests use these fixtures to verify:
- Topic coverage detection
- Gap identification
- Status filtering (review vs complete)
- Epic/task filtering via linked_tasks

## Scenarios

1. **Full Coverage**: T002 has topics covered in canonical-docs/lifecycle.md
2. **Partial Coverage**: T003 has "new-feature" covered but "undocumented" missing
3. **Multi-Epic**: T002/T003 linked to T100, T005 linked to T200
4. **Status Filtering**: Only "review" status should be checked
