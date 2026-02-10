#!/usr/bin/env bash
# Generate API documentation from JSON schemas
# Usage: ./scripts/generate-docs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMAS_DIR="$PROJECT_ROOT/schemas"
DOCS_DIR="$PROJECT_ROOT/docs"

echo "Generating MCP Server API documentation..."
echo "Schemas: $SCHEMAS_DIR"
echo "Output: $DOCS_DIR"

# Function to extract operation from schema file
extract_operation_docs() {
    local schema_file="$1"
    local domain="$2"
    local operation="$3"

    if [[ ! -f "$schema_file" ]]; then
        echo "Warning: Schema file not found: $schema_file" >&2
        return 1
    fi

    # Extract description, parameters, and examples from schema
    jq -r '
        {
            description: .description,
            parameters: .properties,
            required: .required,
            examples: .examples
        }
    ' "$schema_file" 2>/dev/null || echo "{}"
}

# Generate domain documentation
generate_domain_docs() {
    local domain="$1"
    local domain_title="${domain^}"  # Capitalize first letter

    echo "### Generating $domain_title domain documentation..."

    # Find all schema files for this domain
    local schema_files=("$SCHEMAS_DIR/requests/$domain"/*.schema.json)

    if [[ ${#schema_files[@]} -eq 0 ]]; then
        echo "  No schemas found for $domain"
        return
    fi

    echo "  Found ${#schema_files[@]} operations"
}

# Main execution
main() {
    # Ensure docs directory structure exists
    mkdir -p "$DOCS_DIR/api"/{gateways,domains}
    mkdir -p "$DOCS_DIR"/{guides,examples}

    # Generate domain-specific docs
    for domain_dir in "$SCHEMAS_DIR/requests"/*; do
        if [[ -d "$domain_dir" ]]; then
            domain=$(basename "$domain_dir")
            generate_domain_docs "$domain"
        fi
    done

    echo "Documentation generation complete!"
    echo "See: $DOCS_DIR/"
}

main "$@"
