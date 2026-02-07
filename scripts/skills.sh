#!/usr/bin/env bash
###CLEO
# command: skills
# category: maintenance
# synopsis: Skill management: list, discover, validate, info, install
# relevance: medium
# flags: --format,--json,--human,--quiet,--category,--tier,--global
# exits: 0,1,2,4
# json-output: true
# note: Manage CLEO skills: discovery, validation, installation
###END
#
# skills.sh - Skill Management Command
#
# Manage CLEO skills: list, discover, validate, info, install.
# Uses agent-config.sh for skill path resolution and manifest.json for metadata.
#
# Usage:
#   cleo skills list [--agent AGENT] [--global]
#   cleo skills search QUERY [--source SOURCE]
#   cleo skills discover
#   cleo skills validate SKILL
#   cleo skills info SKILL
#   cleo skills install SKILL [--agent AGENT] [--global]
#
set -euo pipefail

# ============================================================================
# Setup
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Check for lib in source directory (dev mode) or installed location
if [[ -d "${SCRIPT_DIR}/../lib" ]]; then
  LIB_DIR="${SCRIPT_DIR}/../lib"
else
  LIB_DIR="$CLEO_HOME/lib"
fi

VERSION="$(cat "$CLEO_HOME/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "0.0.0")"

# Source libraries
source "$LIB_DIR/logging.sh" 2>/dev/null || true
source "$LIB_DIR/output-format.sh" 2>/dev/null || true
source "$LIB_DIR/exit-codes.sh" 2>/dev/null || true
source "$LIB_DIR/flags.sh" 2>/dev/null || true
source "$LIB_DIR/config.sh" 2>/dev/null || true
source "$LIB_DIR/agent-config.sh" 2>/dev/null || true
source "$LIB_DIR/skill-validate.sh" 2>/dev/null || true
source "$LIB_DIR/skill-discovery.sh" 2>/dev/null || true
source "$LIB_DIR/error-json.sh" 2>/dev/null || true
source "$LIB_DIR/skillsmp.sh" 2>/dev/null || true

# Command metadata
COMMAND_NAME="skills"
COMMAND_VERSION="1.0.0"

# Initialize flag defaults
init_flag_defaults 2>/dev/null || true

# Defaults
SUBCOMMAND=""
SKILL_NAME=""
AGENT_ID=""
GLOBAL_FLAG=""
SOURCE="local"
SEARCH_QUERY=""

# Paths
PROJECT_SKILLS_DIR="skills"
MANIFEST_FILE="${PROJECT_SKILLS_DIR}/manifest.json"
MP_SKILLS_DIR="${PROJECT_SKILLS_DIR}/mp"
MP_REGISTRY_FILE="${MP_SKILLS_DIR}/installed.json"

# ============================================================================
# Usage
# ============================================================================

usage() {
  cat << 'EOF'
cleo skills - Skill management and discovery

USAGE
  cleo skills list [--agent AGENT] [--global]
  cleo skills search QUERY [--mp]
  cleo skills discover
  cleo skills validate SKILL
  cleo skills info SKILL
  cleo skills install SKILL [--mp] [--global]
  cleo skills installed                    # List marketplace-installed skills
  cleo skills update [SKILL]               # Check/apply updates for marketplace skills

SUBCOMMANDS
  list             List installed skills (project by default)
  search QUERY     Search for skills (local or marketplace with --mp)
  discover         Scan and discover available skills
  validate SKILL   Validate skill against protocol
  info SKILL       Show skill details from manifest
  install SKILL    Install skill to agent directory
  installed        List skills installed from marketplace
  update           Check for updates to marketplace skills

OPTIONS
  --agent AGENT    Target agent (claude-code, cursor, gemini, etc.)
  --global         Use global skills directory instead of project
  --mp             Search/install from marketplace (agentskills.in, 100K+ skills)
  --all            Search both local and marketplace
  --format FORMAT  Output format: text | json (default: text, auto-json when piped)
  --json           Shortcut for --format json
  --human          Shortcut for --format text
  -h, --help       Show this help message

EXAMPLES
  cleo skills list                          # List project skills
  cleo skills list --agent cursor           # List cursor's installed skills
  cleo skills list --global                 # List global skills
  cleo skills search "research"             # Search local skills
  cleo skills search "rust cli" --mp        # Search marketplace (100K+ skills)
  cleo skills search "orchestrator" --all   # Search both sources
  cleo skills discover                      # Find available skills
  cleo skills info ct-orchestrator          # Show skill details
  cleo skills validate ct-research-agent    # Validate skill
  cleo skills install ct-orchestrator --agent cursor  # Install local to cursor
  cleo skills install @wshobson/rust-async-patterns --mp  # Install from marketplace
  cleo skills installed                     # Show marketplace-installed skills
  cleo skills update                        # Check all for updates
  cleo skills update rust-async-patterns    # Check specific skill

NOTES
  - Skills are stored in skills/ (project) or ~/.cleo/skills/ (global)
  - Agent-specific skills are in agent config directories (e.g., ~/.claude/skills/)
  - Manifest file (skills/manifest.json) is the single source of truth
EOF
  exit "$EXIT_SUCCESS"
}

# ============================================================================
# Helper Functions
# ============================================================================

# Get colors for output
get_colors() {
  if detect_color_support 2>/dev/null; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m'
  else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' DIM='' NC=''
  fi
}

# Get all skills from manifest
get_manifest_skills() {
  if [[ ! -f "$MANIFEST_FILE" ]]; then
    echo "[]"
    return
  fi
  jq -r '.skills // []' "$MANIFEST_FILE" 2>/dev/null || echo "[]"
}

# Get skill info from manifest
get_skill_from_manifest() {
  local skill_name="$1"
  if [[ ! -f "$MANIFEST_FILE" ]]; then
    echo "{}"
    return
  fi
  jq -r --arg name "$skill_name" '.skills[] | select(.name == $name)' "$MANIFEST_FILE" 2>/dev/null || echo "{}"
}

# Check if skill directory exists
skill_dir_exists() {
  local skill_name="$1"
  [[ -d "${PROJECT_SKILLS_DIR}/${skill_name}" ]]
}

# Discover skills in a directory
discover_skills_in_dir() {
  local dir="$1"
  [[ ! -d "$dir" ]] && echo "[]" && return

  local skills="[]"
  for skill_dir in "$dir"/*; do
    [[ ! -d "$skill_dir" ]] && continue
    local skill_name=$(basename "$skill_dir")

    # Check if SKILL.md exists
    if [[ -f "${skill_dir}/SKILL.md" ]]; then
      skills=$(echo "$skills" | jq --arg name "$skill_name" --arg path "$skill_dir" \
        '. += [{name: $name, path: $path, hasSkillFile: true}]')
    else
      skills=$(echo "$skills" | jq --arg name "$skill_name" --arg path "$skill_dir" \
        '. += [{name: $name, path: $path, hasSkillFile: false}]')
    fi
  done

  echo "$skills"
}

# ============================================================================
# Marketplace Registry Management
# ============================================================================

# Initialize marketplace registry file
init_mp_registry() {
  mkdir -p "$MP_SKILLS_DIR"
  if [[ ! -f "$MP_REGISTRY_FILE" ]]; then
    cat > "$MP_REGISTRY_FILE" << 'EOF'
{
  "$schema": "https://cleo-dev.com/schemas/v1/mp-registry.schema.json",
  "_meta": {
    "schemaVersion": "1.0.0",
    "lastUpdated": null
  },
  "skills": []
}
EOF
  fi
}

# Add skill to marketplace registry
# Args: $1=name, $2=scopedName, $3=version, $4=author, $5=stars, $6=path, $7=repoFullName
add_to_mp_registry() {
  local name="$1" scopedName="$2" version="$3" author="$4" stars="$5" path="$6" repoFullName="$7"

  init_mp_registry

  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Check if skill already exists
  local existing
  existing=$(jq -r --arg name "$name" '.skills[] | select(.name == $name) | .name' "$MP_REGISTRY_FILE" 2>/dev/null || echo "")

  if [[ -n "$existing" ]]; then
    # Update existing entry
    jq --arg name "$name" \
       --arg scopedName "$scopedName" \
       --arg version "$version" \
       --arg author "$author" \
       --argjson stars "$stars" \
       --arg path "$path" \
       --arg repoFullName "$repoFullName" \
       --arg now "$now" \
       '._meta.lastUpdated = $now |
        .skills = [.skills[] | if .name == $name then
          .scopedName = $scopedName | .version = $version | .author = $author |
          .stars = $stars | .path = $path | .repoFullName = $repoFullName | .updatedAt = $now
        else . end]' "$MP_REGISTRY_FILE" > "${MP_REGISTRY_FILE}.tmp" && \
    mv "${MP_REGISTRY_FILE}.tmp" "$MP_REGISTRY_FILE"
  else
    # Add new entry
    jq --arg name "$name" \
       --arg scopedName "$scopedName" \
       --arg version "${version:-unknown}" \
       --arg author "$author" \
       --argjson stars "${stars:-0}" \
       --arg path "$path" \
       --arg repoFullName "$repoFullName" \
       --arg now "$now" \
       '._meta.lastUpdated = $now |
        .skills += [{
          name: $name,
          scopedName: $scopedName,
          version: $version,
          author: $author,
          stars: $stars,
          path: $path,
          repoFullName: $repoFullName,
          installedAt: $now,
          updatedAt: $now
        }]' "$MP_REGISTRY_FILE" > "${MP_REGISTRY_FILE}.tmp" && \
    mv "${MP_REGISTRY_FILE}.tmp" "$MP_REGISTRY_FILE"
  fi
}

# Get installed marketplace skills
get_mp_installed() {
  if [[ -f "$MP_REGISTRY_FILE" ]]; then
    jq -r '.skills // []' "$MP_REGISTRY_FILE" 2>/dev/null || echo "[]"
  else
    echo "[]"
  fi
}

# Check if skill is installed from marketplace
is_mp_installed() {
  local name="$1"
  if [[ -f "$MP_REGISTRY_FILE" ]]; then
    jq -e --arg name "$name" '.skills[] | select(.name == $name)' "$MP_REGISTRY_FILE" >/dev/null 2>&1
    return $?
  fi
  return 1
}

# ============================================================================
# Subcommand: list
# ============================================================================

cmd_list() {
  local output_format="${FORMAT:-text}"

  if [[ -n "$AGENT_ID" ]]; then
    # List agent-specific skills
    local skills_list
    skills_list=$(list_agent_skills "$AGENT_ID" "$GLOBAL_FLAG")

    if [[ "$output_format" == "json" ]]; then
      local skills_array="[]"
      while IFS= read -r skill; do
        [[ -z "$skill" ]] && continue
        skills_array=$(echo "$skills_array" | jq --arg name "$skill" '. += [$name]')
      done <<< "$skills_list"

      jq -nc \
        --argjson skills "$skills_array" \
        --arg agent "$AGENT_ID" \
        --arg global "$GLOBAL_FLAG" \
        --arg version "$VERSION" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $version,
            "command": "skills list",
            "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
          },
          "success": true,
          "agent": $agent,
          "global": ($global == "--global"),
          "count": ($skills | length),
          "skills": $skills
        }'
    else
      get_colors
      local scope="project"
      [[ "$GLOBAL_FLAG" == "--global" ]] && scope="global"
      echo ""
      echo -e "${BOLD}Skills for agent: ${CYAN}${AGENT_ID}${NC} (${scope})${NC}"
      echo ""

      if [[ -z "$skills_list" ]]; then
        echo -e "${YELLOW}No skills installed${NC}"
        echo ""
        return
      fi

      while IFS= read -r skill; do
        [[ -z "$skill" ]] && continue
        echo -e "  ${GREEN}●${NC} $skill"
      done <<< "$skills_list"
      echo ""
    fi
  else
    # List project skills
    local manifest_skills
    manifest_skills=$(get_manifest_skills)

    if [[ "$output_format" == "json" ]]; then
      jq -nc \
        --argjson skills "$manifest_skills" \
        --arg version "$VERSION" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $version,
            "command": "skills list",
            "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
          },
          "success": true,
          "scope": "project",
          "count": ($skills | length),
          "skills": $skills
        }'
    else
      get_colors
      local count
      count=$(echo "$manifest_skills" | jq -r 'length')

      echo ""
      echo -e "${BOLD}Project Skills ($count)${NC}"
      echo ""

      if [[ "$count" -eq 0 ]]; then
        echo -e "${YELLOW}No skills found in manifest${NC}"
        echo ""
        return
      fi

      echo "$manifest_skills" | jq -c '.[]' | while read -r skill; do
        local name version status tier description
        name=$(echo "$skill" | jq -r '.name')
        version=$(echo "$skill" | jq -r '.version // "unknown"')
        status=$(echo "$skill" | jq -r '.status // "unknown"')
        tier=$(echo "$skill" | jq -r '.tier // "?"')
        description=$(echo "$skill" | jq -r '.description // ""')

        # Truncate description
        if [[ ${#description} -gt 60 ]]; then
          description="${description:0:57}..."
        fi

        local status_color="$GREEN"
        [[ "$status" == "deprecated" ]] && status_color="$YELLOW"
        [[ "$status" == "inactive" ]] && status_color="$RED"

        echo -e "  ${status_color}●${NC} ${BOLD}$name${NC} ${DIM}(v$version, tier $tier)${NC}"
        echo -e "     $description"
        echo ""
      done
    fi
  fi
}

# ============================================================================
# Subcommand: search
# ============================================================================

cmd_search() {
  local output_format="${FORMAT:-text}"

  [[ -z "$SEARCH_QUERY" ]] && {
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_INPUT_MISSING" "Search query required" "$EXIT_INVALID_INPUT" true \
        "Usage: cleo skills search QUERY [--source SOURCE]"
    else
      echo "[ERROR] Search query required" >&2
      echo "Usage: cleo skills search QUERY [--source SOURCE]" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
  }

  local local_results="[]"
  local skillsmp_results="[]"

  # Search local skills
  if [[ "$SOURCE" == "local" ]] || [[ "$SOURCE" == "all" ]]; then
    local manifest_skills
    manifest_skills=$(get_manifest_skills)

    # Filter by query (case-insensitive match in name or description)
    local_results=$(echo "$manifest_skills" | jq -c --arg query "$SEARCH_QUERY" '
      map(select(
        (.name | ascii_downcase | contains($query | ascii_downcase)) or
        (.description // "" | ascii_downcase | contains($query | ascii_downcase))
      )) | map(. + {source: "local"})
    ')
  fi

  # Search SkillsMP (agentskills.in - public API, no auth required)
  if [[ "$SOURCE" == "skillsmp" ]] || [[ "$SOURCE" == "all" ]]; then
    # Try to load config (optional - API works without it)
    if declare -f smp_load_config >/dev/null 2>&1; then
      smp_load_config 2>/dev/null || true  # Config is optional
    fi
    # Search SkillsMP API (agentskills.in - public, no auth)
    if declare -f smp_search_skills >/dev/null 2>&1; then
      local smp_response
      if smp_response=$(smp_search_skills "$SEARCH_QUERY" 10 "stars" 2>/dev/null); then
        # Transform SkillsMP results to match local format
        skillsmp_results=$(echo "$smp_response" | jq -c '.skills // [] | map({
          name: .name,
          version: .version,
          description: .description,
          author: .author,
          stars: .stars,
          source: "skillsmp",
          scopedName: .scopedName,
          repoFullName: .repoFullName
        })')
      fi
    fi
  fi

  # Merge results
  local combined_results
  combined_results=$(jq -nc --argjson local "$local_results" --argjson smp "$skillsmp_results" \
    '$local + $smp')

  # Output results
  if [[ "$output_format" == "json" ]]; then
    local local_count skillsmp_count total_count
    local_count=$(echo "$local_results" | jq 'length')
    skillsmp_count=$(echo "$skillsmp_results" | jq 'length')
    total_count=$(echo "$combined_results" | jq 'length')

    jq -nc \
      --arg query "$SEARCH_QUERY" \
      --arg source "$SOURCE" \
      --argjson results "$combined_results" \
      --arg local_count "$local_count" \
      --arg skillsmp_count "$skillsmp_count" \
      --arg total "$total_count" \
      --arg version "$VERSION" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": "skills search",
          "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
        },
        "success": true,
        "query": $query,
        "source": $source,
        "counts": {
          "local": ($local_count | tonumber),
          "skillsmp": ($skillsmp_count | tonumber),
          "total": ($total | tonumber)
        },
        "skills": $results
      }'
  else
    get_colors
    local total_count
    total_count=$(echo "$combined_results" | jq 'length')

    echo ""
    echo -e "${BOLD}Skill Search: ${CYAN}$SEARCH_QUERY${NC} (source: $SOURCE)${NC}"
    echo ""
    echo -e "${DIM}Found $total_count results${NC}"
    echo ""

    if [[ "$total_count" -eq 0 ]]; then
      echo -e "${YELLOW}No skills found matching query${NC}"
      echo ""
      return
    fi

    echo "$combined_results" | jq -c '.[]' | while read -r skill; do
      local name version description source author stars
      name=$(echo "$skill" | jq -r '.name')
      version=$(echo "$skill" | jq -r '.version // "unknown"')
      description=$(echo "$skill" | jq -r '.description // ""')
      source=$(echo "$skill" | jq -r '.source')
      author=$(echo "$skill" | jq -r '.author // ""')
      stars=$(echo "$skill" | jq -r '.stars // ""')

      # Truncate description
      if [[ ${#description} -gt 60 ]]; then
        description="${description:0:57}..."
      fi

      local source_badge=""
      if [[ "$source" == "skillsmp" ]]; then
        source_badge="${CYAN}[SkillsMP]${NC} "
        [[ -n "$author" ]] && source_badge="${source_badge}${DIM}@${author}${NC} "
        [[ -n "$stars" ]] && source_badge="${source_badge}${YELLOW}★${stars}${NC} "
      else
        source_badge="${GREEN}[Local]${NC} "
      fi

      echo -e "  ${source_badge}${BOLD}$name${NC} ${DIM}(v$version)${NC}"
      echo -e "     $description"
      echo ""
    done
  fi
}

# ============================================================================
# Subcommand: discover
# ============================================================================

cmd_discover() {
  local output_format="${FORMAT:-text}"

  # Use skill-discovery.sh library if available
  local project_skills
  if declare -f discover_skills >/dev/null 2>&1; then
    # Use new discovery library with full metadata
    project_skills=$(discover_skills "$PROJECT_SKILLS_DIR" 2>/dev/null) || project_skills="[]"
  else
    # Fallback to old discovery method
    project_skills=$(discover_skills_in_dir "$PROJECT_SKILLS_DIR")
  fi

  # Discover in global directory
  local global_skills="[]"
  if [[ -d "$CLEO_HOME/skills" ]]; then
    if declare -f discover_skills >/dev/null 2>&1; then
      global_skills=$(discover_skills "$CLEO_HOME/skills" 2>/dev/null) || global_skills="[]"
    else
      global_skills=$(discover_skills_in_dir "$CLEO_HOME/skills")
    fi
  fi

  if [[ "$output_format" == "json" ]]; then
    jq -nc \
      --argjson project "$project_skills" \
      --argjson global "$global_skills" \
      --arg version "$VERSION" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": "skills discover",
          "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
        },
        "success": true,
        "project": {
          "count": ($project | length),
          "skills": $project
        },
        "global": {
          "count": ($global | length),
          "skills": $global
        }
      }'
  else
    get_colors
    echo ""
    echo -e "${BOLD}Skill Discovery${NC}"
    echo ""

    local project_count global_count
    project_count=$(echo "$project_skills" | jq -r 'length')
    global_count=$(echo "$global_skills" | jq -r 'length')

    echo -e "${BOLD}Project skills:${NC} $project_count found"
    if [[ "$project_count" -gt 0 ]]; then
      echo "$project_skills" | jq -c '.[]' | while read -r skill; do
        local name version status
        name=$(echo "$skill" | jq -r '.name')
        version=$(echo "$skill" | jq -r '.version // "unknown"')
        status=$(echo "$skill" | jq -r '.status // "unknown"')

        local status_icon="${GREEN}●${NC}"
        [[ "$status" == "discovered" ]] && status_icon="${CYAN}●${NC}"
        [[ "$status" == "deprecated" ]] && status_icon="${YELLOW}●${NC}"

        echo -e "  ${status_icon} $name ${DIM}(v$version)${NC}"
      done
    fi
    echo ""

    echo -e "${BOLD}Global skills:${NC} $global_count found"
    if [[ "$global_count" -gt 0 ]]; then
      echo "$global_skills" | jq -c '.[]' | while read -r skill; do
        local name version status
        name=$(echo "$skill" | jq -r '.name')
        version=$(echo "$skill" | jq -r '.version // "unknown"')
        status=$(echo "$skill" | jq -r '.status // "unknown"')

        local status_icon="${GREEN}●${NC}"
        [[ "$status" == "discovered" ]] && status_icon="${CYAN}●${NC}"
        [[ "$status" == "deprecated" ]] && status_icon="${YELLOW}●${NC}"

        echo -e "  ${status_icon} $name ${DIM}(v$version)${NC}"
      done
    fi
    echo ""
  fi
}

# ============================================================================
# Subcommand: sync
# ============================================================================

cmd_sync() {
  local output_format="${FORMAT:-text}"

  # Check if sync_manifest function is available
  if ! declare -f sync_manifest >/dev/null 2>&1; then
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_DEPENDENCY_MISSING" "skill-discovery.sh library not loaded" \
        "$EXIT_DEPENDENCY_ERROR" true "Ensure lib/skill-discovery.sh is available"
    else
      get_colors
      echo ""
      echo -e "${RED}[ERROR]${NC} skill-discovery.sh library not loaded"
      echo ""
    fi
    exit "$EXIT_DEPENDENCY_ERROR"
  fi

  # Run manifest sync
  local sync_output
  sync_output=$(sync_manifest 2>&1)
  local sync_result=$?

  if [[ $sync_result -eq 0 ]]; then
    if [[ "$output_format" == "json" ]]; then
      jq -nc \
        --arg message "$sync_output" \
        --arg version "$VERSION" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $version,
            "command": "skills sync",
            "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
          },
          "success": true,
          "message": $message
        }'
    else
      get_colors
      echo ""
      echo -e "${GREEN}✓${NC} Manifest sync complete"
      echo ""
      echo "$sync_output"
      echo ""
    fi
  else
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_FILE_ERROR" "Manifest sync failed" "$EXIT_FILE_ERROR" true "$sync_output"
    else
      get_colors
      echo ""
      echo -e "${RED}[ERROR]${NC} Manifest sync failed"
      echo ""
      echo "$sync_output"
      echo ""
    fi
    exit "$EXIT_FILE_ERROR"
  fi
}

# ============================================================================
# Subcommand: validate
# ============================================================================

cmd_validate() {
  local output_format="${FORMAT:-text}"

  [[ -z "$SKILL_NAME" ]] && {
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_INPUT_MISSING" "Skill name required" "$EXIT_INVALID_INPUT" true \
        "Usage: cleo skills validate SKILL"
    else
      echo "[ERROR] Skill name required" >&2
      echo "Usage: cleo skills validate SKILL" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
  }

  # Check if skill exists in manifest
  local skill_info
  skill_info=$(get_skill_from_manifest "$SKILL_NAME")

  if [[ "$skill_info" == "{}" ]]; then
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_NOT_FOUND" "Skill not found in manifest: $SKILL_NAME" "$EXIT_NOT_FOUND" true \
        "Check available skills with: cleo skills list"
    else
      get_colors
      echo ""
      echo -e "${RED}[ERROR]${NC} Skill not found in manifest: $SKILL_NAME"
      echo ""
      echo "Check available skills with: cleo skills list"
      echo ""
    fi
    exit "$EXIT_NOT_FOUND"
  fi

  # Check if skill directory exists
  if ! skill_dir_exists "$SKILL_NAME"; then
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_NOT_FOUND" "Skill directory not found: ${PROJECT_SKILLS_DIR}/${SKILL_NAME}" \
        "$EXIT_NOT_FOUND" true "Skill may need to be downloaded or created"
    else
      get_colors
      echo ""
      echo -e "${RED}[ERROR]${NC} Skill directory not found: ${PROJECT_SKILLS_DIR}/${SKILL_NAME}"
      echo ""
    fi
    exit "$EXIT_NOT_FOUND"
  fi

  # Check if SKILL.md exists
  local skill_file="${PROJECT_SKILLS_DIR}/${SKILL_NAME}/SKILL.md"
  local has_skill_file=false
  [[ -f "$skill_file" ]] && has_skill_file=true

  # Validate using skill-validate.sh if available
  local validation_result="unknown"
  local validation_message="Validation function not available"

  if declare -f skill_exists >/dev/null 2>&1; then
    if skill_exists "$SKILL_NAME"; then
      validation_result="pass"
      validation_message="Skill exists and is registered"
    else
      validation_result="fail"
      validation_message="Skill not recognized by validation library"
    fi
  fi

  if [[ "$output_format" == "json" ]]; then
    jq -nc \
      --arg name "$SKILL_NAME" \
      --argjson info "$skill_info" \
      --argjson hasSkillFile "$has_skill_file" \
      --arg validation "$validation_result" \
      --arg message "$validation_message" \
      --arg version "$VERSION" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": "skills validate",
          "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
        },
        "success": ($validation == "pass"),
        "skill": $name,
        "validation": {
          "result": $validation,
          "message": $message,
          "hasSkillFile": $hasSkillFile
        },
        "info": $info
      }'
  else
    get_colors
    echo ""
    echo -e "${BOLD}Skill Validation: ${CYAN}$SKILL_NAME${NC}"
    echo ""

    if [[ "$validation_result" == "pass" ]]; then
      echo -e "${GREEN}✓${NC} $validation_message"
    else
      echo -e "${YELLOW}⚠${NC} $validation_message"
    fi

    if [[ "$has_skill_file" == "true" ]]; then
      echo -e "${GREEN}✓${NC} SKILL.md exists"
    else
      echo -e "${RED}✗${NC} SKILL.md missing"
    fi

    echo ""
    echo -e "${BOLD}Manifest Info:${NC}"
    echo "$skill_info" | jq -r 'to_entries[] | "  \(.key): \(.value)"' | head -5
    echo ""
  fi
}

# ============================================================================
# Subcommand: info
# ============================================================================

cmd_info() {
  local output_format="${FORMAT:-text}"

  [[ -z "$SKILL_NAME" ]] && {
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_INPUT_MISSING" "Skill name required" "$EXIT_INVALID_INPUT" true \
        "Usage: cleo skills info SKILL"
    else
      echo "[ERROR] Skill name required" >&2
      echo "Usage: cleo skills info SKILL" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
  }

  local skill_info
  skill_info=$(get_skill_from_manifest "$SKILL_NAME")

  if [[ "$skill_info" == "{}" ]]; then
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_NOT_FOUND" "Skill not found: $SKILL_NAME" "$EXIT_NOT_FOUND" true \
        "Check available skills with: cleo skills list"
    else
      get_colors
      echo ""
      echo -e "${RED}[ERROR]${NC} Skill not found: $SKILL_NAME"
      echo ""
    fi
    exit "$EXIT_NOT_FOUND"
  fi

  if [[ "$output_format" == "json" ]]; then
    jq -nc \
      --arg name "$SKILL_NAME" \
      --argjson info "$skill_info" \
      --arg version "$VERSION" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": "skills info",
          "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
        },
        "success": true,
        "skill": $name,
        "info": $info
      }'
  else
    get_colors
    local name version status tier description
    name=$(echo "$skill_info" | jq -r '.name')
    version=$(echo "$skill_info" | jq -r '.version // "unknown"')
    status=$(echo "$skill_info" | jq -r '.status // "unknown"')
    tier=$(echo "$skill_info" | jq -r '.tier // "?"')
    description=$(echo "$skill_info" | jq -r '.description // ""')

    echo ""
    echo -e "${BOLD}Skill: ${CYAN}$name${NC}"
    echo ""
    echo -e "${BOLD}Version:${NC} $version"
    echo -e "${BOLD}Status:${NC}  $status"
    echo -e "${BOLD}Tier:${NC}    $tier"
    echo ""
    echo -e "${BOLD}Description:${NC}"
    echo "$description" | fold -s -w 70 | sed 's/^/  /'
    echo ""

    # Show capabilities if present
    local capabilities
    capabilities=$(echo "$skill_info" | jq -r '.capabilities // {}')
    if [[ "$capabilities" != "{}" ]]; then
      echo -e "${BOLD}Capabilities:${NC}"

      local inputs outputs deps
      inputs=$(echo "$capabilities" | jq -r '.inputs // [] | join(", ")')
      outputs=$(echo "$capabilities" | jq -r '.outputs // [] | join(", ")')
      deps=$(echo "$capabilities" | jq -r '.dependencies // [] | join(", ")')

      [[ -n "$inputs" ]] && echo -e "  ${DIM}Inputs:${NC}  $inputs"
      [[ -n "$outputs" ]] && echo -e "  ${DIM}Outputs:${NC} $outputs"
      [[ -n "$deps" ]] && echo -e "  ${DIM}Depends:${NC} $deps"
      echo ""
    fi

    # Show tags
    local tags
    tags=$(echo "$skill_info" | jq -r '.tags // [] | join(", ")')
    if [[ -n "$tags" ]]; then
      echo -e "${BOLD}Tags:${NC} $tags"
      echo ""
    fi
  fi
}

# ============================================================================
# Subcommand: install
# ============================================================================

cmd_install() {
  local output_format="${FORMAT:-text}"

  [[ -z "$SKILL_NAME" ]] && {
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_INPUT_MISSING" "Skill name required" "$EXIT_INVALID_INPUT" true \
        "Usage: cleo skills install SKILL [--agent AGENT] [--global] [--source SOURCE]"
    else
      echo "[ERROR] Skill name required" >&2
      echo "Usage: cleo skills install SKILL [--agent AGENT] [--global] [--source SOURCE]" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
  }

  # Handle marketplace source (--mp or --source skillsmp)
  if [[ "$SOURCE" == "skillsmp" ]]; then
    # Check if SkillsMP library is available
    if ! declare -f smp_install_skill >/dev/null 2>&1; then
      if [[ "$output_format" == "json" ]]; then
        output_error "$E_DEPENDENCY_MISSING" "SkillsMP library not loaded" \
          "$EXIT_DEPENDENCY_ERROR" true "Ensure lib/skillsmp.sh is available"
      else
        get_colors
        echo ""
        echo -e "${RED}[ERROR]${NC} SkillsMP library not loaded"
        echo ""
      fi
      exit "$EXIT_DEPENDENCY_ERROR"
    fi

    # Try to load config (optional - API works without it)
    if declare -f smp_load_config >/dev/null 2>&1; then
      smp_load_config 2>/dev/null || true  # Config is optional
    fi

    # Validate skill exists in marketplace
    get_colors
    echo ""
    echo "Checking skill availability in SkillsMP..."

    local skill_data
    if ! skill_data=$(smp_get_skill_details "$SKILL_NAME" 2>&1); then
      if [[ "$output_format" == "json" ]]; then
        output_error "$E_NOT_FOUND" "Skill not found in SkillsMP: $SKILL_NAME" \
          "$EXIT_NOT_FOUND" true "Search for available skills with: cleo skillsmp search"
      else
        echo ""
        echo -e "${RED}[ERROR]${NC} Skill not found in SkillsMP: $SKILL_NAME"
        echo ""
        echo "Search for available skills with: cleo skillsmp search"
        echo ""
      fi
      exit "$EXIT_NOT_FOUND"
    fi

    # Determine target directory
    local target_dir
    if [[ "$GLOBAL_FLAG" == "--global" ]]; then
      target_dir="$CLEO_HOME/skills"
    else
      target_dir="$PROJECT_SKILLS_DIR"
    fi

    # Install using SkillsMP library
    echo "Installing from SkillsMP..."
    if smp_install_skill "$SKILL_NAME" "$target_dir" 2>&1; then
      local skill_name scopedName skill_author skill_stars skill_version repo_name
      skill_name=$(echo "$skill_data" | jq -r '.name')
      scopedName=$(echo "$skill_data" | jq -r '.scopedName // ""')
      skill_author=$(echo "$skill_data" | jq -r '.author // ""')
      skill_stars=$(echo "$skill_data" | jq -r '.stars // 0')
      skill_version=$(echo "$skill_data" | jq -r '.version // "unknown"')
      repo_name=$(echo "$skill_data" | jq -r '.repoFullName // ""')
      local install_path="${target_dir}/${skill_name}"

      # Record to marketplace registry
      add_to_mp_registry "$skill_name" "$scopedName" "$skill_version" "$skill_author" "$skill_stars" "$install_path" "$repo_name"

      if [[ "$output_format" == "json" ]]; then
        jq -nc \
          --arg name "$skill_name" \
          --arg scopedName "$scopedName" \
          --arg path "$install_path" \
          --arg global "$GLOBAL_FLAG" \
          --arg source "$SOURCE" \
          --arg version "$VERSION" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
              "format": "json",
              "version": $version,
              "command": "skills install",
              "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
            },
            "success": true,
            "skill": $name,
            "scopedName": $scopedName,
            "source": $source,
            "installedTo": $path,
            "global": ($global == "--global"),
            "tracked": true
          }'
      else
        echo ""
        echo -e "${GREEN}✓${NC} Skill installed from marketplace: ${CYAN}$skill_name${NC}"
        echo ""
        echo -e "${BOLD}Scoped:${NC}   $scopedName"
        echo -e "${BOLD}Path:${NC}     $install_path"
        [[ "$GLOBAL_FLAG" == "--global" ]] && echo -e "${BOLD}Scope:${NC}    global"
        echo -e "${DIM}Tracked in: $MP_REGISTRY_FILE${NC}"
        echo ""
      fi
      exit "$EXIT_SUCCESS"
    else
      if [[ "$output_format" == "json" ]]; then
        output_error "$E_FILE_ERROR" "Failed to install skill from SkillsMP" \
          "$EXIT_FILE_ERROR" true "Check network connection and permissions"
      else
        echo ""
        echo -e "${RED}[ERROR]${NC} Failed to install skill from SkillsMP"
        echo ""
        echo "Check network connection and permissions"
        echo ""
      fi
      exit "$EXIT_FILE_ERROR"
    fi
  fi

  # Local source (existing logic)
  # Validate skill exists in project
  if ! skill_dir_exists "$SKILL_NAME"; then
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_NOT_FOUND" "Skill not found: $SKILL_NAME" "$EXIT_NOT_FOUND" true \
        "Skill directory must exist in ${PROJECT_SKILLS_DIR}/"
    else
      get_colors
      echo ""
      echo -e "${RED}[ERROR]${NC} Skill not found: $SKILL_NAME"
      echo ""
      echo "Skill directory must exist in ${PROJECT_SKILLS_DIR}/"
      echo ""
    fi
    exit "$EXIT_NOT_FOUND"
  fi

  # Require agent for install
  if [[ -z "$AGENT_ID" ]]; then
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_INPUT_MISSING" "Agent ID required for installation" "$EXIT_INVALID_INPUT" true \
        "Usage: cleo skills install SKILL --agent AGENT"
    else
      echo "[ERROR] Agent ID required for installation" >&2
      echo "Usage: cleo skills install SKILL --agent AGENT" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
  fi

  # Get skill path
  local skill_path="${PROJECT_SKILLS_DIR}/${SKILL_NAME}"

  # Install skill
  if install_skill_to_agent "$skill_path" "$AGENT_ID" "$GLOBAL_FLAG"; then
    local target_path
    target_path=$(get_skill_install_path "$SKILL_NAME" "$AGENT_ID" "$GLOBAL_FLAG")

    if [[ "$output_format" == "json" ]]; then
      jq -nc \
        --arg name "$SKILL_NAME" \
        --arg agent "$AGENT_ID" \
        --arg path "$target_path" \
        --arg global "$GLOBAL_FLAG" \
        --arg source "$SOURCE" \
        --arg version "$VERSION" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $version,
            "command": "skills install",
            "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
          },
          "success": true,
          "skill": $name,
          "agent": $agent,
          "source": $source,
          "installedTo": $path,
          "global": ($global == "--global")
        }'
    else
      get_colors
      echo ""
      echo -e "${GREEN}✓${NC} Skill installed: ${CYAN}$SKILL_NAME${NC}"
      echo ""
      echo -e "${BOLD}Agent:${NC}    $AGENT_ID"
      echo -e "${BOLD}Path:${NC}     $target_path"
      [[ "$GLOBAL_FLAG" == "--global" ]] && echo -e "${BOLD}Scope:${NC}    global"
      echo ""
    fi
  else
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_FILE_ERROR" "Failed to install skill" "$EXIT_FILE_ERROR" true \
        "Check that the target directory is writable"
    else
      get_colors
      echo ""
      echo -e "${RED}[ERROR]${NC} Failed to install skill: $SKILL_NAME"
      echo ""
      echo "Check that the target directory is writable"
      echo ""
    fi
    exit "$EXIT_FILE_ERROR"
  fi
}

# ============================================================================
# Subcommand: installed - List marketplace-installed skills
# ============================================================================

cmd_installed() {
  local output_format="${FORMAT:-text}"

  local installed
  installed=$(get_mp_installed)
  local count
  count=$(echo "$installed" | jq 'length')

  if [[ "$output_format" == "json" ]]; then
    jq -nc \
      --argjson skills "$installed" \
      --arg version "$VERSION" \
      --arg registry "$MP_REGISTRY_FILE" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": "skills installed",
          "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
        },
        "success": true,
        "registry": $registry,
        "count": ($skills | length),
        "skills": $skills
      }'
  else
    get_colors
    echo ""
    echo -e "${BOLD}Marketplace-Installed Skills ($count)${NC}"
    echo -e "${DIM}Registry: $MP_REGISTRY_FILE${NC}"
    echo ""

    if [[ "$count" -eq 0 ]]; then
      echo -e "${YELLOW}No marketplace skills installed${NC}"
      echo ""
      echo "Install skills with: cleo skills install @author/skill --mp"
      echo ""
      return
    fi

    echo "$installed" | jq -c '.[]' | while read -r skill; do
      local name scopedName author stars installedAt path
      name=$(echo "$skill" | jq -r '.name')
      scopedName=$(echo "$skill" | jq -r '.scopedName // ""')
      author=$(echo "$skill" | jq -r '.author // "unknown"')
      stars=$(echo "$skill" | jq -r '.stars // 0')
      installedAt=$(echo "$skill" | jq -r '.installedAt // ""')
      path=$(echo "$skill" | jq -r '.path // ""')

      echo -e "  ${GREEN}●${NC} ${BOLD}$name${NC} ${DIM}($scopedName)${NC}"
      echo -e "     ${DIM}★$stars${NC} by ${CYAN}$author${NC}"
      echo -e "     ${DIM}Installed: $installedAt${NC}"
      echo -e "     ${DIM}Path: $path${NC}"
      echo ""
    done
  fi
}

# ============================================================================
# Subcommand: update - Check for updates to marketplace skills
# ============================================================================

cmd_update() {
  local output_format="${FORMAT:-text}"

  # Load SkillsMP functions
  if ! declare -f smp_get_skill_details >/dev/null 2>&1; then
    if [[ "$output_format" == "json" ]]; then
      output_error "$E_DEPENDENCY_MISSING" "SkillsMP library not loaded" \
        "$EXIT_DEPENDENCY_ERROR" true "Ensure lib/skillsmp.sh is available"
    else
      get_colors
      echo ""
      echo -e "${RED}[ERROR]${NC} SkillsMP library not loaded"
      echo ""
    fi
    exit "$EXIT_DEPENDENCY_ERROR"
  fi

  # Try to load config (optional)
  if declare -f smp_load_config >/dev/null 2>&1; then
    smp_load_config 2>/dev/null || true
  fi

  local installed
  installed=$(get_mp_installed)
  local count
  count=$(echo "$installed" | jq 'length')

  if [[ "$count" -eq 0 ]]; then
    if [[ "$output_format" == "json" ]]; then
      jq -nc \
        --arg version "$VERSION" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $version,
            "command": "skills update",
            "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
          },
          "success": true,
          "message": "No marketplace skills installed",
          "updates": []
        }'
    else
      get_colors
      echo ""
      echo -e "${YELLOW}No marketplace skills installed${NC}"
      echo ""
    fi
    return
  fi

  get_colors
  [[ "$output_format" != "json" ]] && {
    echo ""
    echo -e "${BOLD}Checking for updates...${NC}"
    echo ""
  }

  local updates="[]"
  local checked=0

  # Check specific skill if provided
  if [[ -n "$SKILL_NAME" ]]; then
    local skill_info
    skill_info=$(echo "$installed" | jq -r --arg name "$SKILL_NAME" '.[] | select(.name == $name)')

    if [[ -z "$skill_info" ]]; then
      if [[ "$output_format" == "json" ]]; then
        output_error "$E_NOT_FOUND" "Skill not installed: $SKILL_NAME" "$EXIT_NOT_FOUND" true \
          "Run 'cleo skills installed' to see installed marketplace skills"
      else
        echo -e "${RED}[ERROR]${NC} Skill not installed: $SKILL_NAME"
        echo ""
      fi
      exit "$EXIT_NOT_FOUND"
    fi

    installed="[$skill_info]"
    count=1
  fi

  echo "$installed" | jq -c '.[]' | while read -r skill; do
    local name scopedName current_stars
    name=$(echo "$skill" | jq -r '.name')
    scopedName=$(echo "$skill" | jq -r '.scopedName // ""')
    current_stars=$(echo "$skill" | jq -r '.stars // 0')

    [[ "$output_format" != "json" ]] && echo -e "  Checking ${CYAN}$name${NC}..."

    # Get latest info from marketplace
    local latest_info
    if latest_info=$(smp_get_skill_details "$scopedName" 2>/dev/null); then
      local latest_stars
      latest_stars=$(echo "$latest_info" | jq -r '.stars // 0')

      if [[ "$latest_stars" -gt "$current_stars" ]]; then
        [[ "$output_format" != "json" ]] && echo -e "    ${GREEN}↑${NC} Stars: $current_stars → $latest_stars"
        updates=$(echo "$updates" | jq --arg name "$name" --arg old "$current_stars" --arg new "$latest_stars" \
          '. += [{name: $name, field: "stars", old: ($old | tonumber), new: ($new | tonumber)}]')
      else
        [[ "$output_format" != "json" ]] && echo -e "    ${DIM}Up to date${NC}"
      fi
    else
      [[ "$output_format" != "json" ]] && echo -e "    ${YELLOW}Could not check${NC}"
    fi

    checked=$((checked + 1))
  done

  if [[ "$output_format" == "json" ]]; then
    jq -nc \
      --argjson updates "$updates" \
      --arg version "$VERSION" \
      --arg checked "$count" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": "skills update",
          "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
        },
        "success": true,
        "checked": ($checked | tonumber),
        "updates": $updates
      }'
  else
    echo ""
    echo -e "${GREEN}✓${NC} Checked $count skill(s)"
    echo ""
  fi
}

# ============================================================================
# Argument Parsing
# ============================================================================

parse_arguments() {
  # Parse common flags first
  parse_common_flags "$@"
  set -- "${REMAINING_ARGS[@]}"

  # Bridge to legacy variables
  apply_flags_to_globals

  # Handle help flag
  if [[ "$FLAG_HELP" == true ]]; then
    usage
  fi

  # Check for subcommand
  if [[ $# -gt 0 ]]; then
    case $1 in
      list|search|discover|validate|info|install|installed|update)
        SUBCOMMAND="$1"
        shift
        ;;
      --*)
        # Not a subcommand, default to list
        SUBCOMMAND="list"
        ;;
      -*)
        # Not a subcommand, default to list
        SUBCOMMAND="list"
        ;;
      *)
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
          output_error "$E_INPUT_INVALID" "Invalid subcommand: $1" "$EXIT_INVALID_INPUT" true \
            "Valid subcommands: list, search, discover, validate, info, install"
        else
          echo "[ERROR] Invalid subcommand: $1" >&2
          echo "Valid subcommands: list, search, discover, validate, info, install" >&2
        fi
        exit "$EXIT_INVALID_INPUT"
        ;;
    esac
  else
    # No subcommand provided, default to list
    SUBCOMMAND="list"
  fi

  # Parse subcommand-specific arguments
  while [[ $# -gt 0 ]]; do
    case $1 in
      --agent)
        shift
        [[ $# -eq 0 ]] && {
          echo "[ERROR] --agent requires an argument" >&2
          exit "$EXIT_INVALID_INPUT"
        }
        AGENT_ID="$1"
        shift
        ;;
      --global)
        GLOBAL_FLAG="--global"
        shift
        ;;
      --mp)
        SOURCE="skillsmp"
        shift
        ;;
      --all)
        SOURCE="all"
        shift
        ;;
      --source)
        shift
        [[ $# -eq 0 ]] && {
          echo "[ERROR] --source requires an argument" >&2
          exit "$EXIT_INVALID_INPUT"
        }
        SOURCE="$1"
        # Validate source value
        if [[ ! "$SOURCE" =~ ^(local|skillsmp|all)$ ]]; then
          echo "[ERROR] Invalid source: $SOURCE" >&2
          echo "Valid sources: local, skillsmp, all" >&2
          exit "$EXIT_INVALID_INPUT"
        fi
        shift
        ;;
      --*)
        echo "[ERROR] Unknown option: $1" >&2
        echo "Run 'cleo skills --help' for usage" >&2
        exit "$EXIT_INVALID_INPUT"
        ;;
      -*)
        echo "[ERROR] Unknown option: $1" >&2
        echo "Run 'cleo skills --help' for usage" >&2
        exit "$EXIT_INVALID_INPUT"
        ;;
      *)
        # Positional argument (skill name or search query)
        if [[ "$SUBCOMMAND" == "search" ]]; then
          SEARCH_QUERY="$1"
        elif [[ -z "$SKILL_NAME" ]]; then
          SKILL_NAME="$1"
        fi
        shift
        ;;
    esac
  done
}

# ============================================================================
# Main Execution
# ============================================================================

main() {
  parse_arguments "$@"

  # Bridge to legacy variables after parsing
  apply_flags_to_globals

  # Resolve format (TTY-aware auto-detection)
  FORMAT=$(resolve_format "${FORMAT:-}")

  # Normalize format (resolve_format may return "human" which we treat as "text")
  [[ "$FORMAT" == "human" ]] && FORMAT="text"

  # Validate format
  local VALID_FORMATS="text json"
  if ! echo "$VALID_FORMATS" | grep -qw "$FORMAT"; then
    if declare -f output_error >/dev/null 2>&1; then
      output_error "E_INPUT_INVALID" "Invalid format: $FORMAT" "$EXIT_INVALID_INPUT" true \
        "Valid formats: $VALID_FORMATS"
    else
      echo "[ERROR] Invalid format: $FORMAT. Valid formats: $VALID_FORMATS" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
  fi

  # Check required commands
  if ! command -v jq &>/dev/null; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed" \
        "$EXIT_DEPENDENCY_MISSING" true "Install jq: https://stedolan.github.io/jq/download/"
    else
      echo "[ERROR] jq is required but not installed" >&2
    fi
    exit "$EXIT_DEPENDENCY_MISSING"
  fi

  # Execute subcommand
  case "$SUBCOMMAND" in
    list)
      cmd_list
      ;;
    search)
      cmd_search
      ;;
    discover)
      cmd_discover
      ;;
    validate)
      cmd_validate
      ;;
    info)
      cmd_info
      ;;
    install)
      cmd_install
      ;;
    installed)
      cmd_installed
      ;;
    update)
      cmd_update
      ;;
    *)
      echo "[ERROR] Unknown subcommand: $SUBCOMMAND" >&2
      exit "$EXIT_INVALID_INPUT"
      ;;
  esac
}

main "$@"
