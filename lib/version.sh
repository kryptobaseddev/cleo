#!/usr/bin/env bash
# Version management for cleo
#
# LAYER: 0 (Foundation)
# DEPENDENCIES: none
# PROVIDES: get_version, _get_version_file, CLEO_VERSION

#=== SOURCE GUARD ================================================
[[ -n "${_VERSION_LOADED:-}" ]] && return 0
declare -r _VERSION_LOADED=1

# Determine the base directory (works for both installed and dev)
_get_version_file() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")" && pwd)"

  # Check if running from installed location
  if [[ -f "${CLEO_HOME:-$HOME/.cleo}/VERSION" ]]; then
    echo "${CLEO_HOME:-$HOME/.cleo}/VERSION"
  # Check if running from repo (lib/../VERSION)
  elif [[ -f "$script_dir/../VERSION" ]]; then
    echo "$script_dir/../VERSION"
  # Check if running from scripts dir (scripts/../VERSION)
  elif [[ -f "$script_dir/../VERSION" ]]; then
    echo "$script_dir/../VERSION"
  else
    echo ""
  fi
}

get_version() {
  local version_file
  version_file="$(_get_version_file)"

  if [[ -n "$version_file" && -f "$version_file" ]]; then
    cat "$version_file" | tr -d '[:space:]'
  else
    echo "unknown"
  fi
}

# Export for use in scripts
CLEO_VERSION="$(get_version)"
