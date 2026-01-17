#!/usr/bin/env bash
# Schema Diff Analyzer - Enhanced with MINOR/MAJOR automation
# Classify schema changes and generate migration code

set -euo pipefail

# Analyze schema change and classify as PATCH/MINOR/MAJOR
# Args: $1 = old schema JSON, $2 = new schema JSON
analyze_schema_change() {
    local old_schema="$1"
    local new_schema="$2"

    # Extract key differences
    local old_required new_required

    old_required=$(echo "$old_schema" | jq -r '.properties.tasks.items.required // [] | join(",")')
    new_required=$(echo "$new_schema" | jq -r '.properties.tasks.items.required // [] | join(",")')

    # Check for new required fields
    if [[ "$new_required" != "$old_required" ]]; then
        local added_required
        added_required=$(comm -13 <(echo "$old_required" | tr ',' '\n' | sort) <(echo "$new_required" | tr ',' '\n' | sort))
        if [[ -n "$added_required" ]]; then
            echo "major|new_required_field|$added_required"
            return
        fi
    fi

    # Check for constraint relaxations (PATCH)
    local relaxations=$(jq -c -n --argjson old "$old_schema" --argjson new "$new_schema" '
        def find_relaxations:
            [
                ($new | paths(scalars) as $p | select($p[-1] == "maxLength") | {
                    path: $p,
                    old: ($old | getpath($p)),
                    new: ($new | getpath($p))
                } | select(.new > .old))
            ] as $max_increases |

            [
                ($new | paths(scalars) as $p | select($p[-1] == "minLength") | {
                    path: $p,
                    old: ($old | getpath($p)),
                    new: ($new | getpath($p))
                } | select(.new < .old))
            ] as $min_decreases |

            {
                maxLength: $max_increases,
                minLength: $min_decreases,
                count: (($max_increases | length) + ($min_decreases | length))
            };

        find_relaxations
    ')

    local relaxation_count=$(echo "$relaxations" | jq -r '.count')

    if [[ "$relaxation_count" -gt 0 ]]; then
        echo "patch|constraint_relaxation|$relaxations"
        return
    fi

    # Check for new optional fields (MINOR) - WITH TYPE DETECTION
    local new_fields_with_types=$(jq -c -n --argjson old "$old_schema" --argjson new "$new_schema" '
        # Get new field names
        (($new.properties.tasks.items.properties | keys) - ($old.properties.tasks.items.properties | keys)) as $new_keys |

        # For each new field, extract type and default value
        $new_keys | map({
            name: .,
            type: $new.properties.tasks.items.properties[.].type,
            default: $new.properties.tasks.items.properties[.].default // null
        })
    ')

    if [[ "$(echo "$new_fields_with_types" | jq -r 'length')" -gt 0 ]]; then
        echo "minor|new_optional_field|$new_fields_with_types"
        return
    fi

    # Check for removed fields (MAJOR) - WITH TYPE INFO
    local removed_fields_with_types=$(jq -c -n --argjson old "$old_schema" --argjson new "$new_schema" '
        # Get removed field names
        (($old.properties.tasks.items.properties | keys) - ($new.properties.tasks.items.properties | keys)) as $removed_keys |

        # For each removed field, extract type info
        $removed_keys | map({
            name: .,
            type: $old.properties.tasks.items.properties[.].type
        })
    ')

    if [[ "$(echo "$removed_fields_with_types" | jq -r 'length')" -gt 0 ]]; then
        echo "major|removed_field|$removed_fields_with_types"
        return
    fi

    # Default: minor change
    echo "minor|unknown_change|null"
}

# Generate default value based on type
get_default_value() {
    local field_type="$1"
    local schema_default="$2"
    
    # Use schema default if provided
    if [[ "$schema_default" != "null" ]]; then
        echo "$schema_default"
        return
    fi
    
    # Otherwise use type-appropriate defaults
    case "$field_type" in
        string)
            echo '""'
            ;;
        number|integer)
            echo '0'
            ;;
        boolean)
            echo 'false'
            ;;
        array)
            echo '[]'
            ;;
        object)
            echo '{}'
            ;;
        *)
            echo 'null'
            ;;
    esac
}

# Generate migration function code
# Args: $1 = file type, $2 = version, $3 = change classification (type|kind|data)
generate_migration_function() {
    local file_type="$1"
    local version="$2"
    local change_classification="$3"

    # Parse classification: "type|kind|data"
    local change_type=$(echo "$change_classification" | cut -d'|' -f1)
    local change_kind=$(echo "$change_classification" | cut -d'|' -f2)
    local change_data=$(echo "$change_classification" | cut -d'|' -f3-)

    local func_name="migrate_${file_type}_to_${version//./_}"
    local date_now=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

    case "$change_type" in
        patch)
            # Pure relaxation - version bump only
            cat <<EOF
# Auto-generated migration: $date_now
# Change: Constraint relaxation (backward compatible)
${func_name}() {
    local file="\$1"
    local target_version="$version"

    echo "  Migrating to v$version: Constraint relaxation (backward compatible)"
    echo "  No data transformation needed"

    # Version-only migration (relaxed constraint, existing data remains valid)
    bump_version_only "\$file" "\$target_version"
}

EOF
            ;;

        minor)
            if [[ "$change_kind" == "new_optional_field" ]]; then
                # NEW: Auto-generate add_field_if_missing calls
                local add_field_calls=""
                
                # Parse field info from JSON array
                local field_count=$(echo "$change_data" | jq -r 'length')
                
                for ((i=0; i<field_count; i++)); do
                    local field_name=$(echo "$change_data" | jq -r ".[$i].name")
                    local field_type=$(echo "$change_data" | jq -r ".[$i].type")
                    local schema_default=$(echo "$change_data" | jq -r ".[$i].default")
                    
                    local default_value=$(get_default_value "$field_type" "$schema_default")
                    
                    add_field_calls+="    add_field_if_missing \"\$file\" \".tasks[].$field_name\" '$default_value' || return 1"$'\n'
                done
                
                cat <<EOF
# Auto-generated migration: $date_now
# Change: New optional field(s) added
${func_name}() {
    local file="\$1"
    local target_version="$version"

    echo "  Migrating to v$version: Adding optional field(s)"

    # Auto-generated field additions
$add_field_calls
    # Update version
    bump_version_only "\$file" "\$target_version"
}

EOF
            else
                # Unknown MINOR change - template with TODO
                cat <<EOF
# Auto-generated migration: $date_now  
# Change: Minor schema change (backward compatible)
${func_name}() {
    local file="\$1"
    local target_version="$version"

    echo "  Migrating to v$version: Minor schema change"

    # TODO: Implement migration logic for change type: $change_kind
    # Data transformation may be needed

    bump_version_only "\$file" "\$target_version"
}

EOF
            fi
            ;;

        major)
            # Enhanced MAJOR with smart TODOs
            local suggested_jq=""
            
            if [[ "$change_kind" == "removed_field" ]]; then
                # Generate smart TODO for field removal
                local field_count=$(echo "$change_data" | jq -r 'length')
                local field_names=$(echo "$change_data" | jq -r '.[].name | @sh' | tr '\n' ',' | sed 's/,$//')
                
                suggested_jq="    # Suggested jq transformation to remove field(s):"$'\n'
                suggested_jq+="    # jq '.tasks[] |= del(.${field_names})' \"\$file\""
            elif [[ "$change_kind" == "new_required_field" ]]; then
                suggested_jq="    # WARNING: New required field requires data for existing tasks"$'\n'
                suggested_jq+="    # Suggested approach:"$'\n'
                suggested_jq+="    # 1. Analyze existing tasks to determine appropriate default"$'\n'
                suggested_jq+="    # 2. Use jq to add field: .tasks[] |= . + {field: \"value\"}"
            else
                suggested_jq="    # Complex change detected - manual review required"
            fi
            
            cat <<EOF
# Auto-generated migration: $date_now
# Change: BREAKING (major schema change)
# ⚠️  WARNING: This migration requires manual implementation
${func_name}() {
    local file="\$1"
    local target_version="$version"

    echo "  ⚠️  MAJOR migration to v$version: Breaking change"
    echo "  ⚠️  Change type: $change_kind"

$suggested_jq

    # TODO: Implement breaking change migration
    # 1. Analyze impact on existing data
    # 2. Implement jq transformation or data migration
    # 3. Test thoroughly before deploying

    # Uncomment after implementing:
    # save_json "\$file" "\$updated_content"
    # bump_version_only "\$file" "\$target_version"
    
    return 1  # Block until implemented
}

EOF
            ;;
    esac
}

# Main execution
if [[ $# -lt 4 ]]; then
    echo "Usage: $0 <old_schema> <new_schema> <file_type> <version>" >&2
    exit 1
fi

OLD_SCHEMA="$1"
NEW_SCHEMA="$2"
FILE_TYPE="$3"
VERSION="$4"

# Analyze the change
CLASSIFICATION=$(analyze_schema_change "$OLD_SCHEMA" "$NEW_SCHEMA")

# Extract change type
CHANGE_TYPE=$(echo "$CLASSIFICATION" | cut -d'|' -f1)

# Generate migration function
generate_migration_function "$FILE_TYPE" "$VERSION" "$CLASSIFICATION"

# Output metadata to stderr
echo "Classification: $CLASSIFICATION" >&2
echo "Change type: $CHANGE_TYPE" >&2
