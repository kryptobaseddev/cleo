# P2-2: Duplicate Labels Fix

## Problem
Using `--labels bug,bug,bug` stored duplicate labels in task metadata, which inflated label statistics and created data inconsistencies.

## Root Cause
The label parsing logic in `add-task.sh` and `update-task.sh` accepted comma-separated labels without deduplication or normalization, allowing the same label to appear multiple times in the labels array.

## Solution
Implemented a `normalize_labels()` function in `/mnt/projects/claude-todo/lib/validation.sh` that:
1. Splits comma-separated labels
2. Trims whitespace from each label
3. Removes empty entries
4. Sorts labels alphabetically
5. Removes duplicates using `sort -u`
6. Rejoins into a comma-separated string

## Implementation

### Files Modified

#### 1. `/mnt/projects/claude-todo/lib/validation.sh`
Added the `normalize_labels()` function after the `timestamp_to_epoch()` function:

```bash
# Deduplicate and normalize labels
# Args: $1 = comma-separated labels string
# Returns: deduplicated, sorted labels string
normalize_labels() {
    local labels_input="$1"

    # Handle empty input
    if [[ -z "$labels_input" ]]; then
        echo ""
        return 0
    fi

    # Split by comma, trim whitespace, sort, deduplicate, rejoin
    echo "$labels_input" | \
        tr ',' '\n' | \
        sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
        grep -v '^$' | \
        sort -u | \
        tr '\n' ',' | \
        sed 's/,$//'
}

export -f normalize_labels
```

#### 2. `/mnt/projects/claude-todo/scripts/add-task.sh`
Added label normalization before validation (after line 437):

```bash
# Normalize labels to remove duplicates
if [[ -n "$LABELS" ]]; then
  LABELS=$(normalize_labels "$LABELS")
fi
```

#### 3. `/mnt/projects/claude-todo/scripts/update-task.sh`
Added label normalization for both `--labels` and `--set-labels` options (after line 438):

```bash
# Normalize labels to remove duplicates
if [[ -n "$LABELS_TO_ADD" ]]; then
  LABELS_TO_ADD=$(normalize_labels "$LABELS_TO_ADD")
fi
if [[ -n "$LABELS_TO_SET" ]]; then
  LABELS_TO_SET=$(normalize_labels "$LABELS_TO_SET")
fi
```

## Testing

### Test Cases Verified
1. **Duplicate labels**: `bug,bug,bug` → `bug`
2. **Mixed duplicates**: `bug,feature,bug,security,feature` → `bug,feature,security`
3. **Whitespace handling**: `bug, feature , bug,  security` → `bug,feature,security`
4. **Update with --labels**: Appending duplicate labels normalizes correctly
5. **Update with --set-labels**: Replacing with duplicate labels normalizes correctly
6. **Empty input**: Returns empty string
7. **Single label**: `bug` → `bug`

### Benefits
- Prevents duplicate label storage
- Prevents label statistics inflation
- Maintains data consistency
- Alphabetically sorted labels for easier reading
- Whitespace trimmed for cleaner data

## Behavior Examples

### Before Fix
```bash
$ claude-todo add "Test task" --labels bug,bug,bug
# Stored: ["bug", "bug", "bug"]  ❌ Inflates stats
```

### After Fix
```bash
$ claude-todo add "Test task" --labels bug,bug,bug
# Stored: ["bug"]  ✅ Correct unique labels
```

## Backwards Compatibility
- Existing tasks with duplicate labels remain in the JSON files
- New tasks and updates automatically normalize labels
- No breaking changes to CLI interface
- No migration required

## Future Enhancements
- Consider adding a `claude-todo normalize` command to clean up existing duplicate labels in historical data
- Add validation warning if user attempts to add duplicate labels (informational only)

## Status
✅ **COMPLETE** - All tests passing, fix deployed
