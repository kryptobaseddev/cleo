# Handler Interface Pseudocode

Every artifact handler is a triple of Bash functions with a strict contract. This file shows the interface and a full pseudocode example for implementing a new handler.

## The Contract

```bash
{prefix}_validate(artifact_config_json) -> exit 0 | 1
{prefix}_build(artifact_config_json, dry_run) -> exit 0 | 1
{prefix}_publish(artifact_config_json, dry_run) -> exit 0 | 1
```

- `artifact_config_json` is a single entry from `release.artifacts[]`, passed as a JSON string.
- `dry_run` is the literal string `"true"` or `"false"`.
- All three functions return 0 on success, non-zero on failure.
- None of the three MAY print credentials, write credentials to files, or pass credentials via command-line arguments.

## Required Behavior

### validate

- Parse the config JSON.
- Confirm every required tool is available on PATH (`command -v <tool>`).
- Confirm the package manifest exists (`package.json`, `pyproject.toml`, `Cargo.toml`, etc.).
- Confirm the version in the manifest matches the release version.
- Confirm credentials declared as required are present in the environment.
- Return 0 if all checks pass, 1 otherwise.

### build

- Parse the config JSON.
- If `dry_run == "true"`, log the build command and return 0 without running it.
- Otherwise, run the build command and capture stdout/stderr.
- Verify the expected output location exists and is non-empty.
- Compute SHA-256 checksum of every output file and emit it to `stdout` in `<sha256>  <filename>` format.
- Return 0 on success.

### publish

- Parse the config JSON.
- If `dry_run == "true"`, log the publish command and return 0.
- Otherwise, verify credentials are present in the environment.
- Run the publish command.
- Capture the registry response (URL, digest, published timestamp).
- Emit the response as JSON on stdout for the pipeline to capture.
- Return 0 on success.

## Full Pseudocode Example: `my_custom` handler

```bash
# Example: publishing a custom tarball to a private registry.

my_custom_validate() {
    local config="$1"
    local version
    version=$(echo "$config" | jq -r '.version // empty')

    # Tool availability
    if ! command -v tar > /dev/null; then
        echo "ERROR: tar not found on PATH" >&2
        return 1
    fi

    if ! command -v curl > /dev/null; then
        echo "ERROR: curl not found on PATH" >&2
        return 1
    fi

    # Config shape
    if [[ -z "$version" ]]; then
        echo "ERROR: config missing .version" >&2
        return 1
    fi

    local registry
    registry=$(echo "$config" | jq -r '.registry // empty')
    if [[ -z "$registry" ]]; then
        echo "ERROR: config missing .registry" >&2
        return 1
    fi

    # Credential check (env var name only; never echo the value)
    local env_var
    env_var=$(echo "$config" | jq -r '.credentials.envVar // empty')
    if [[ -n "$env_var" ]] && [[ -z "${!env_var:-}" ]]; then
        echo "ERROR: credential env var $env_var not set" >&2
        return 1
    fi

    return 0
}

my_custom_build() {
    local config="$1"
    local dry_run="$2"
    local version
    version=$(echo "$config" | jq -r '.version')
    local output="build/my-project-${version}.tar.gz"

    if [[ "$dry_run" == "true" ]]; then
        echo "[dry-run] would run: tar czf $output --exclude=.git ."
        return 0
    fi

    tar czf "$output" --exclude=.git --exclude=node_modules . || return 1

    if [[ ! -s "$output" ]]; then
        echo "ERROR: build output missing or empty: $output" >&2
        return 1
    fi

    # Emit checksum for the pipeline to capture.
    local digest
    digest=$(sha256sum "$output" | awk '{print $1}')
    echo "${digest}  ${output}"

    return 0
}

my_custom_publish() {
    local config="$1"
    local dry_run="$2"
    local version
    version=$(echo "$config" | jq -r '.version')
    local registry
    registry=$(echo "$config" | jq -r '.registry')
    local env_var
    env_var=$(echo "$config" | jq -r '.credentials.envVar')
    local output="build/my-project-${version}.tar.gz"

    if [[ "$dry_run" == "true" ]]; then
        echo "[dry-run] would POST $output to $registry"
        return 0
    fi

    # NEVER echo or log the credential value itself.
    if [[ -z "${!env_var:-}" ]]; then
        echo "ERROR: credential env var $env_var is unset" >&2
        return 1
    fi

    # Use a header file so the token never appears on the command line.
    local header_file
    header_file=$(mktemp)
    printf "Authorization: Bearer %s\n" "${!env_var}" > "$header_file"

    local response
    response=$(curl -sS -H @"$header_file" \
        -X POST \
        -F "file=@${output}" \
        "${registry}/packages") || {
        rm -f "$header_file"
        return 1
    }

    rm -f "$header_file"

    # Emit structured response for the pipeline.
    echo "$response"

    return 0
}
```

## Registering the Handler

```bash
source lib/release-artifacts.sh
register_artifact_handler "my-custom-type" "my_custom"
```

After registration, a `release.artifacts[]` entry with `"type": "my-custom-type"` will invoke the three functions automatically during the pipeline.

## Testing a Handler

Every new handler MUST ship with BATS tests that cover:

1. `validate` returns 1 on missing tools.
2. `validate` returns 1 on missing config fields.
3. `validate` returns 1 on missing credentials.
4. `build` respects `dry_run`.
5. `build` produces output and emits a valid SHA-256 checksum.
6. `publish` respects `dry_run`.
7. `publish` refuses to run with missing credentials.
8. The full pipeline (`validate` → `build` → `publish` with `dry_run=true`) exits 0 end-to-end.

Tests live in `tests/unit/release-artifacts-*.bats` alongside the existing handlers.
