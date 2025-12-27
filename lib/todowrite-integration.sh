#!/bin/bash
# todowrite-integration.sh - TodoWrite Integration Library
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: none (standalone grammar transformation)
# PROVIDES: convert_to_active_form, map_status_to_todowrite, map_status_from_todowrite,
#           task_to_todowrite, export_to_todowrite, apply_grammar_rules,
#           VERB_TO_ACTIVE, STATUS_TO_TODOWRITE, STATUS_FROM_TODOWRITE
#
# Grammar transformation and format conversion for Claude Code's TodoWrite integration

#=== SOURCE GUARD ================================================
[[ -n "${_TODOWRITE_INTEGRATION_LOADED:-}" ]] && return 0
declare -r _TODOWRITE_INTEGRATION_LOADED=1

# Disable strict mode for associative array lookups
set +u

# -----------------------------------------------------------------------------
# VERB LOOKUP TABLE
# -----------------------------------------------------------------------------
# Top 100+ task verbs with hand-verified present continuous forms.
# Format: ["imperative"]="Present continuous"
# -----------------------------------------------------------------------------
declare -A VERB_TO_ACTIVE=(
    # Common development verbs
    ["add"]="Adding"
    ["analyze"]="Analyzing"
    ["apply"]="Applying"
    ["build"]="Building"
    ["check"]="Checking"
    ["clarify"]="Clarifying"
    ["clean"]="Cleaning"
    ["cleanup"]="Cleaning up"
    ["configure"]="Configuring"
    ["connect"]="Connecting"
    ["consolidate"]="Consolidating"
    ["convert"]="Converting"
    ["copy"]="Copying"
    ["create"]="Creating"
    ["debug"]="Debugging"
    ["decouple"]="Decoupling"
    ["define"]="Defining"
    ["delete"]="Deleting"
    ["deploy"]="Deploying"
    ["design"]="Designing"
    ["detect"]="Detecting"
    ["develop"]="Developing"
    ["disable"]="Disabling"
    ["document"]="Documenting"
    ["download"]="Downloading"
    ["enable"]="Enabling"
    ["enhance"]="Enhancing"
    ["ensure"]="Ensuring"
    ["establish"]="Establishing"
    ["evaluate"]="Evaluating"
    ["examine"]="Examining"
    ["execute"]="Executing"
    ["expand"]="Expanding"
    ["export"]="Exporting"
    ["extend"]="Extending"
    ["extract"]="Extracting"
    ["finalize"]="Finalizing"
    ["find"]="Finding"
    ["finish"]="Finishing"
    ["fix"]="Fixing"
    ["format"]="Formatting"
    ["generate"]="Generating"
    ["handle"]="Handling"
    ["identify"]="Identifying"
    ["implement"]="Implementing"
    ["import"]="Importing"
    ["improve"]="Improving"
    ["include"]="Including"
    ["initialize"]="Initializing"
    ["inspect"]="Inspecting"
    ["install"]="Installing"
    ["integrate"]="Integrating"
    ["investigate"]="Investigating"
    ["launch"]="Launching"
    ["load"]="Loading"
    ["log"]="Logging"
    ["maintain"]="Maintaining"
    ["manage"]="Managing"
    ["merge"]="Merging"
    ["migrate"]="Migrating"
    ["modify"]="Modifying"
    ["monitor"]="Monitoring"
    ["move"]="Moving"
    ["normalize"]="Normalizing"
    ["optimize"]="Optimizing"
    ["organize"]="Organizing"
    ["parse"]="Parsing"
    ["patch"]="Patching"
    ["perform"]="Performing"
    ["plan"]="Planning"
    ["prepare"]="Preparing"
    ["prevent"]="Preventing"
    ["process"]="Processing"
    ["protect"]="Protecting"
    ["provide"]="Providing"
    ["publish"]="Publishing"
    ["query"]="Querying"
    ["read"]="Reading"
    ["rebuild"]="Rebuilding"
    ["reduce"]="Reducing"
    ["refactor"]="Refactoring"
    ["release"]="Releasing"
    ["reload"]="Reloading"
    ["remove"]="Removing"
    ["rename"]="Renaming"
    ["reorganize"]="Reorganizing"
    ["repair"]="Repairing"
    ["replace"]="Replacing"
    ["report"]="Reporting"
    ["research"]="Researching"
    ["reset"]="Resetting"
    ["resolve"]="Resolving"
    ["restore"]="Restoring"
    ["restructure"]="Restructuring"
    ["retrieve"]="Retrieving"
    ["return"]="Returning"
    ["review"]="Reviewing"
    ["revise"]="Revising"
    ["rewrite"]="Rewriting"
    ["run"]="Running"
    ["save"]="Saving"
    ["scan"]="Scanning"
    ["schedule"]="Scheduling"
    ["search"]="Searching"
    ["secure"]="Securing"
    ["send"]="Sending"
    ["separate"]="Separating"
    ["set"]="Setting"
    ["setup"]="Setting up"
    ["simplify"]="Simplifying"
    ["solve"]="Solving"
    ["sort"]="Sorting"
    ["split"]="Splitting"
    ["standardize"]="Standardizing"
    ["start"]="Starting"
    ["stop"]="Stopping"
    ["store"]="Storing"
    ["streamline"]="Streamlining"
    ["structure"]="Structuring"
    ["stub"]="Stubbing"
    ["submit"]="Submitting"
    ["support"]="Supporting"
    ["sync"]="Syncing"
    ["synchronize"]="Synchronizing"
    ["test"]="Testing"
    ["trace"]="Tracing"
    ["track"]="Tracking"
    ["transfer"]="Transferring"
    ["transform"]="Transforming"
    ["translate"]="Translating"
    ["troubleshoot"]="Troubleshooting"
    ["try"]="Trying"
    ["unify"]="Unifying"
    ["uninstall"]="Uninstalling"
    ["update"]="Updating"
    ["upgrade"]="Upgrading"
    ["upload"]="Uploading"
    ["use"]="Using"
    ["validate"]="Validating"
    ["verify"]="Verifying"
    ["view"]="Viewing"
    ["watch"]="Watching"
    ["wrap"]="Wrapping"
    ["write"]="Writing"
)

# -----------------------------------------------------------------------------
# STATUS MAPPING
# -----------------------------------------------------------------------------
# Maps cleo status values to TodoWrite status values
# -----------------------------------------------------------------------------
declare -A STATUS_TO_TODOWRITE=(
    ["pending"]="pending"
    ["active"]="in_progress"
    ["blocked"]="pending"      # Downgrade: blocker info in persistent only
    ["done"]="completed"
)

# Reverse mapping: TodoWrite status to cleo status
declare -A STATUS_FROM_TODOWRITE=(
    ["pending"]="pending"
    ["in_progress"]="active"
    ["completed"]="done"
)

# -----------------------------------------------------------------------------
# convert_to_active_form
# -----------------------------------------------------------------------------
# Converts imperative task title to present continuous (activeForm)
#
# Arguments:
#   $1 - Task title in imperative form (e.g., "Implement authentication")
#
# Returns:
#   Present continuous form (e.g., "Implementing authentication")
#
# Algorithm:
#   1. Check if first word already ends in "-ing" (already active form)
#   2. Check lookup table for first word
#   3. Apply grammar rules if looks like a verb
#   4. Fallback to "Working on: <title>" for non-verbs
# -----------------------------------------------------------------------------
convert_to_active_form() {
    local title="$1"

    # Handle empty input
    if [[ -z "$title" ]]; then
        echo ""
        return 1
    fi

    # Extract first word (lowercased for lookup)
    local first_word="${title%% *}"
    local first_word_lower="${first_word,,}"
    local rest=""

    # Get rest of title (if more than one word)
    if [[ "$title" == *" "* ]]; then
        rest="${title#* }"
    fi

    # -1. Handle prefix patterns like "BUG:", "FEAT:", "T123:", "OPTIONAL:" etc.
    # These should use the fallback since they're labels, not verbs
    if [[ "$first_word" =~ ^[A-Z0-9._-]+:$ ]] || [[ "$first_word" =~ ^T[0-9]+(\.[0-9]+)?:$ ]]; then
        echo "Working on: ${title}"
        return 0
    fi

    # Strip trailing colon/punctuation for lookup (but preserve original for non-verb fallback)
    local first_word_clean="${first_word_lower%:}"
    first_word_clean="${first_word_clean%.}"

    # 0. Check if first word already ends in "-ing" (already in active form)
    # This prevents "Testing" → "Testinging", "Debugging" → "Debugginging", etc.
    if [[ "${first_word_clean}" =~ ing$ ]] && [[ ${#first_word_clean} -gt 4 ]]; then
        # Already in active form - capitalize and use as-is
        local capitalized="${first_word^}"
        if [[ -n "$rest" ]]; then
            echo "${capitalized} ${rest}"
        else
            echo "${capitalized}"
        fi
        return 0
    fi

    # 1. Check lookup table first (most reliable)
    # Use ${array[$key]+_} pattern to safely check if key exists (avoids unbound variable with set -u)
    if [[ -v "VERB_TO_ACTIVE[$first_word_clean]" ]]; then
        local active_verb="${VERB_TO_ACTIVE[$first_word_clean]}"
        if [[ -n "$rest" ]]; then
            echo "${active_verb} ${rest}"
        else
            echo "${active_verb}"
        fi
        return 0
    fi

    # 2. Check if first word looks like a verb (heuristics)
    # Non-verbs typically: start with uppercase (proper noun), are common nouns, etc.
    # Skip grammar rules for words that are likely NOT verbs
    local is_likely_verb=true

    # Common non-verb first words in task titles (nouns, adjectives, etc.)
    case "$first_word_clean" in
        # Common nouns/adjectives that start task titles
        core|api|ui|ux|db|database|frontend|backend|server|client|user|admin|auth|config|configuration)
            is_likely_verb=false ;;
        data|file|files|module|component|class|function|method|service|controller|model|view)
            is_likely_verb=false ;;
        unit|integration|e2e|performance|security|load|stress|smoke|regression)
            is_likely_verb=false ;;
        bug|feature|issue|task|story|epic|ticket|pr|review|release|version|v1|v2|patch)
            is_likely_verb=false ;;
        new|old|main|primary|secondary|final|initial|temp|temporary|quick|fast|slow|high|medium|low|blocked|pending|active|done|critical|urgent|important)
            is_likely_verb=false ;;
        # If word is very short and not in lookup, probably not a verb
        *)
            if [[ ${#first_word_clean} -le 2 ]]; then
                is_likely_verb=false
            fi
            ;;
    esac

    # 3. Apply grammar transformation rules only if likely a verb
    if [[ "$is_likely_verb" == "true" ]]; then
        local transformed=""
        transformed=$(apply_grammar_rules "$first_word_clean")

        if [[ -n "$transformed" ]]; then
            # Capitalize first letter
            transformed="${transformed^}"
            if [[ -n "$rest" ]]; then
                echo "${transformed} ${rest}"
            else
                echo "${transformed}"
            fi
            return 0
        fi
    fi

    # 4. Fallback: Use title as-is with prefix
    echo "Working on: ${title}"
    return 0
}

# -----------------------------------------------------------------------------
# apply_grammar_rules
# -----------------------------------------------------------------------------
# Applies English grammar rules to convert verb to -ing form
#
# Arguments:
#   $1 - Verb in base form (lowercase)
#
# Returns:
#   Verb in -ing form (lowercase)
#
# Rules applied:
#   1. Verbs ending in 'e': drop 'e', add 'ing' (create → creating)
#   2. Verbs ending in 'ie': replace with 'ying' (tie → tying)
#   3. Verbs ending in consonant after single vowel: double consonant (run → running)
#   4. Default: add 'ing'
# -----------------------------------------------------------------------------
apply_grammar_rules() {
    local verb="$1"
    local length=${#verb}

    # Need at least 2 characters
    if [[ $length -lt 2 ]]; then
        echo "${verb}ing"
        return
    fi

    local last_char="${verb: -1}"
    local second_last="${verb: -2:1}"

    # Rule 2: Verbs ending in 'ie' → replace with 'ying'
    if [[ "${verb: -2}" == "ie" ]]; then
        echo "${verb%ie}ying"
        return
    fi

    # Rule 1: Verbs ending in 'e' (but not 'ee') → drop 'e', add 'ing'
    if [[ "$last_char" == "e" && "$second_last" != "e" ]]; then
        echo "${verb%e}ing"
        return
    fi

    # Rule 3: CVC pattern (consonant-vowel-consonant) → double final consonant
    # Only for single-syllable words or stressed final syllables
    # Simplified: apply to short words (3-4 chars) ending in single consonant after vowel
    if [[ $length -le 4 ]]; then
        if is_consonant "$last_char" && is_vowel "$second_last"; then
            # Don't double w, x, y
            if [[ "$last_char" != "w" && "$last_char" != "x" && "$last_char" != "y" ]]; then
                echo "${verb}${last_char}ing"
                return
            fi
        fi
    fi

    # Rule 4: Default - just add 'ing'
    echo "${verb}ing"
}

# -----------------------------------------------------------------------------
# Helper: Check if character is a vowel
# -----------------------------------------------------------------------------
is_vowel() {
    [[ "$1" =~ [aeiou] ]]
}

# -----------------------------------------------------------------------------
# Helper: Check if character is a consonant
# -----------------------------------------------------------------------------
is_consonant() {
    [[ "$1" =~ [bcdfghjklmnpqrstvwxyz] ]]
}

# -----------------------------------------------------------------------------
# map_status_to_todowrite
# -----------------------------------------------------------------------------
# Maps cleo status to TodoWrite status
#
# Arguments:
#   $1 - cleo status (pending/active/blocked/done)
#
# Returns:
#   TodoWrite status (pending/in_progress/completed)
# -----------------------------------------------------------------------------
map_status_to_todowrite() {
    local status="$1"
    echo "${STATUS_TO_TODOWRITE[$status]:-pending}"
}

# -----------------------------------------------------------------------------
# map_status_from_todowrite
# -----------------------------------------------------------------------------
# Maps TodoWrite status back to cleo status
#
# Arguments:
#   $1 - TodoWrite status (pending/in_progress/completed)
#
# Returns:
#   cleo status (pending/active/done)
# -----------------------------------------------------------------------------
map_status_from_todowrite() {
    local status="$1"
    echo "${STATUS_FROM_TODOWRITE[$status]:-pending}"
}

# -----------------------------------------------------------------------------
# task_to_todowrite
# -----------------------------------------------------------------------------
# Converts a cleo task to TodoWrite format
#
# Arguments:
#   $1 - Task JSON object (from jq)
#
# Returns:
#   TodoWrite JSON object
# -----------------------------------------------------------------------------
task_to_todowrite() {
    local task_json="$1"

    local title=$(echo "$task_json" | jq -r '.title // ""')
    local status=$(echo "$task_json" | jq -r '.status // "pending"')

    local active_form=$(convert_to_active_form "$title")
    local todowrite_status=$(map_status_to_todowrite "$status")

    jq -n \
        --arg content "$title" \
        --arg activeForm "$active_form" \
        --arg status "$todowrite_status" \
        '{content: $content, activeForm: $activeForm, status: $status}'
}

# -----------------------------------------------------------------------------
# export_to_todowrite
# -----------------------------------------------------------------------------
# Exports cleo tasks to TodoWrite format
#
# Arguments:
#   $1 - Path to todo.json
#   $2 - Status filter (optional, comma-separated: "pending,active")
#   $3 - Max tasks (optional, default: 10)
#
# Returns:
#   TodoWrite JSON: { "todos": [...] }
# -----------------------------------------------------------------------------
export_to_todowrite() {
    local todo_file="${1:-.cleo/todo.json}"
    local status_filter="${2:-pending,active}"
    local max_tasks="${3:-10}"

    if [[ ! -f "$todo_file" ]]; then
        echo '{"todos": [], "error": "todo.json not found"}' >&2
        return 1
    fi

    # Build jq filter for status
    local jq_status_filter=""
    IFS=',' read -ra statuses <<< "$status_filter"
    for s in "${statuses[@]}"; do
        if [[ -n "$jq_status_filter" ]]; then
            jq_status_filter="${jq_status_filter} or "
        fi
        jq_status_filter="${jq_status_filter}.status == \"$s\""
    done

    # Extract matching tasks
    local tasks=$(jq -c "[.tasks[] | select($jq_status_filter)] | .[0:$max_tasks]" "$todo_file")

    # Convert each task
    local todowrite_tasks="[]"
    while IFS= read -r task; do
        local title=$(echo "$task" | jq -r '.title // ""')
        local status=$(echo "$task" | jq -r '.status // "pending"')

        local active_form=$(convert_to_active_form "$title")
        local todowrite_status=$(map_status_to_todowrite "$status")

        local todo_item=$(jq -n \
            --arg content "$title" \
            --arg activeForm "$active_form" \
            --arg status "$todowrite_status" \
            '{content: $content, activeForm: $activeForm, status: $status}')

        todowrite_tasks=$(echo "$todowrite_tasks" | jq --argjson item "$todo_item" '. + [$item]')
    done < <(echo "$tasks" | jq -c '.[]')

    # Output final format
    jq -n --argjson todos "$todowrite_tasks" '{todos: $todos}'
}

# -----------------------------------------------------------------------------
# Self-test when run directly
# -----------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "=== TodoWrite Integration Library Self-Test ==="
    echo ""

    echo "Testing convert_to_active_form():"
    echo "  'Implement auth' -> $(convert_to_active_form 'Implement auth')"
    echo "  'Fix bug' -> $(convert_to_active_form 'Fix bug')"
    echo "  'Add feature' -> $(convert_to_active_form 'Add feature')"
    echo "  'Create component' -> $(convert_to_active_form 'Create component')"
    echo "  'Run tests' -> $(convert_to_active_form 'Run tests')"
    echo "  'Write documentation' -> $(convert_to_active_form 'Write documentation')"
    echo "  'Setup environment' -> $(convert_to_active_form 'Setup environment')"
    echo "  'Debug issue' -> $(convert_to_active_form 'Debug issue')"
    echo "  'Optimize performance' -> $(convert_to_active_form 'Optimize performance')"
    echo "  'Refactor module' -> $(convert_to_active_form 'Refactor module')"
    echo ""

    echo "Testing grammar rules (unlisted verbs):"
    echo "  'Configure system' -> $(convert_to_active_form 'Configure system')"
    echo "  'Tie components' -> $(convert_to_active_form 'Tie components')"
    echo "  'Stop service' -> $(convert_to_active_form 'Stop service')"
    echo ""

    echo "Testing bug fixes (T315):"
    echo "  'Core feature A' -> $(convert_to_active_form 'Core feature A')"
    echo "  'Testing task' -> $(convert_to_active_form 'Testing task')"
    echo "  'Debugging session' -> $(convert_to_active_form 'Debugging session')"
    echo "  'API integration' -> $(convert_to_active_form 'API integration')"
    echo "  'UI component' -> $(convert_to_active_form 'UI component')"
    echo "  'Bug fix for login' -> $(convert_to_active_form 'Bug fix for login')"
    echo "  'Running tests' -> $(convert_to_active_form 'Running tests')"
    echo ""

    echo "Testing prefix patterns (colon handling):"
    echo "  'BUG: validation.sh issue' -> $(convert_to_active_form 'BUG: validation.sh issue')"
    echo "  'T328.10: Create docs' -> $(convert_to_active_form 'T328.10: Create docs')"
    echo "  'OPTIONAL: Add feature' -> $(convert_to_active_form 'OPTIONAL: Add feature')"
    echo "  'FEAT: New login page' -> $(convert_to_active_form 'FEAT: New login page')"
    echo "  'Fix: broken tests' -> $(convert_to_active_form 'Fix: broken tests')"
    echo ""

    echo "Testing status mapping:"
    echo "  pending -> $(map_status_to_todowrite 'pending')"
    echo "  active -> $(map_status_to_todowrite 'active')"
    echo "  blocked -> $(map_status_to_todowrite 'blocked')"
    echo "  done -> $(map_status_to_todowrite 'done')"
    echo ""

    echo "=== Self-Test Complete ==="
fi
