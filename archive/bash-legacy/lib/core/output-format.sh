#!/usr/bin/env bash
# output-format.sh - Shared output formatting functions
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: none (standalone formatting utilities)
# PROVIDES: load_output_config, supports_color, supports_unicode, get_term_width,
#           resolve_format, format_status, format_priority, progress_bar,
#           colored_output, format_header, format_box

#=== SOURCE GUARD ================================================
[[ -n "${_OUTPUT_FORMAT_LOADED:-}" ]] && return 0
declare -r _OUTPUT_FORMAT_LOADED=1

# ============================================================================
# CONFIGURATION
# ============================================================================

# Configuration file path
OUTPUT_CONFIG_FILE="${OUTPUT_CONFIG_FILE:-.cleo/config.json}"

# Cached configuration values (loaded once per script execution)
declare -g _OUTPUT_CONFIG_LOADED=""
declare -g _OUTPUT_CONFIG_COLOR=""
declare -g _OUTPUT_CONFIG_UNICODE=""
declare -g _OUTPUT_CONFIG_PROGRESS_BARS=""
declare -g _OUTPUT_CONFIG_DATE_FORMAT=""
declare -g _OUTPUT_CONFIG_CSV_DELIMITER=""
declare -g _OUTPUT_CONFIG_COMPACT_TITLES=""
declare -g _OUTPUT_CONFIG_MAX_TITLE_LENGTH=""

# load_output_config - Load output configuration from config file
#
# Reads output.* settings from config.json and caches them.
# Safe to call multiple times - will only read file once.
#
# Returns: 0 (always succeeds, uses defaults if config missing)
load_output_config() {
  # Only load once
  [[ -n "$_OUTPUT_CONFIG_LOADED" ]] && return 0
  _OUTPUT_CONFIG_LOADED="true"

  # Set defaults
  _OUTPUT_CONFIG_COLOR="true"
  _OUTPUT_CONFIG_UNICODE="true"
  _OUTPUT_CONFIG_PROGRESS_BARS="true"
  _OUTPUT_CONFIG_DATE_FORMAT="iso8601"
  _OUTPUT_CONFIG_CSV_DELIMITER=","
  _OUTPUT_CONFIG_COMPACT_TITLES="false"
  _OUTPUT_CONFIG_MAX_TITLE_LENGTH="80"

  # Load from config if available
  if [[ -f "$OUTPUT_CONFIG_FILE" ]] && command -v jq &>/dev/null; then
    local config_color config_unicode config_progress config_date config_csv config_compact config_max

    # Check if keys exist and read them (use 'if .key then .key else "undefined" end' to handle false/null)
    # Support both new (showColor) and old (colorEnabled) field names for backward compatibility
    config_color=$(jq -r 'if .output.showColor != null then .output.showColor elif .output.colorEnabled != null then .output.colorEnabled else "undefined" end' "$OUTPUT_CONFIG_FILE" 2>/dev/null)
    config_unicode=$(jq -r 'if .output.showUnicode != null then .output.showUnicode elif .output.unicodeEnabled != null then .output.unicodeEnabled else "undefined" end' "$OUTPUT_CONFIG_FILE" 2>/dev/null)
    config_progress=$(jq -r 'if .output.showProgressBars != null then .output.showProgressBars elif .output.progressBars != null then .output.progressBars else "undefined" end' "$OUTPUT_CONFIG_FILE" 2>/dev/null)
    config_date=$(jq -r 'if .output.dateFormat != null then .output.dateFormat else "undefined" end' "$OUTPUT_CONFIG_FILE" 2>/dev/null)
    config_csv=$(jq -r 'if .output.csvDelimiter != null then .output.csvDelimiter else "undefined" end' "$OUTPUT_CONFIG_FILE" 2>/dev/null)
    config_compact=$(jq -r 'if .output.showCompactTitles != null then .output.showCompactTitles elif .output.compactTitles != null then .output.compactTitles else "undefined" end' "$OUTPUT_CONFIG_FILE" 2>/dev/null)
    config_max=$(jq -r 'if .output.maxTitleLength != null then .output.maxTitleLength else "undefined" end' "$OUTPUT_CONFIG_FILE" 2>/dev/null)

    # Update cached values if defined (allows boolean false to be set)
    [[ "$config_color" != "undefined" ]] && _OUTPUT_CONFIG_COLOR="$config_color"
    [[ "$config_unicode" != "undefined" ]] && _OUTPUT_CONFIG_UNICODE="$config_unicode"
    [[ "$config_progress" != "undefined" ]] && _OUTPUT_CONFIG_PROGRESS_BARS="$config_progress"
    [[ "$config_date" != "undefined" ]] && _OUTPUT_CONFIG_DATE_FORMAT="$config_date"
    [[ "$config_csv" != "undefined" ]] && _OUTPUT_CONFIG_CSV_DELIMITER="$config_csv"
    [[ "$config_compact" != "undefined" ]] && _OUTPUT_CONFIG_COMPACT_TITLES="$config_compact"
    [[ "$config_max" != "undefined" ]] && _OUTPUT_CONFIG_MAX_TITLE_LENGTH="$config_max"
  fi

  return 0
}

# get_output_config - Get a specific output configuration value
#
# Args:
#   $1 - Configuration key (color, unicode, progressBars, dateFormat, csvDelimiter, compactTitles, maxTitleLength)
#        Supports both new (showColor, showUnicode, showProgressBars, showCompactTitles)
#        and old (colorEnabled, unicodeEnabled, progressBars, compactTitles) field names
#
# Returns: Configuration value
get_output_config() {
  local key="$1"

  # Ensure config is loaded
  load_output_config

  case "$key" in
    color|colorEnabled|showColor)                echo "$_OUTPUT_CONFIG_COLOR" ;;
    unicode|unicodeEnabled|showUnicode)          echo "$_OUTPUT_CONFIG_UNICODE" ;;
    progressBars|showProgressBars)               echo "$_OUTPUT_CONFIG_PROGRESS_BARS" ;;
    dateFormat)                                  echo "$_OUTPUT_CONFIG_DATE_FORMAT" ;;
    csvDelimiter)                                echo "$_OUTPUT_CONFIG_CSV_DELIMITER" ;;
    compactTitles|showCompactTitles)             echo "$_OUTPUT_CONFIG_COMPACT_TITLES" ;;
    maxTitleLength)                              echo "$_OUTPUT_CONFIG_MAX_TITLE_LENGTH" ;;
    *)                                           echo "" ;;
  esac
}

# ============================================================================
# FEATURE DETECTION
# ============================================================================

# detect_color_support - Check if color output is supported
#
# Priority order:
# 1. NO_COLOR env var -> disable colors (respects standard)
# 2. FORCE_COLOR env var -> enable colors
# 3. Config output.showColor (or old output.colorEnabled) -> respect setting
# 4. TTY check + tput colors >= 8 -> enable colors
#
# Returns: 0 if colors supported, 1 if not
detect_color_support() {
  # NO_COLOR standard takes precedence
  [[ -n "${NO_COLOR:-}" ]] && return 1

  # FORCE_COLOR override
  [[ -n "${FORCE_COLOR:-}" ]] && return 0

  # Check configuration setting
  local config_color
  config_color=$(get_output_config "color")
  [[ "$config_color" == "false" ]] && return 1

  # Check if stdout is a terminal and tput supports colors
  if [[ -t 1 ]] && command -v tput &>/dev/null; then
    local num_colors
    num_colors=$(tput colors 2>/dev/null || echo 0)
    [[ "$num_colors" -ge 8 ]] && return 0
  fi

  return 1
}

# detect_unicode_support - Check if Unicode/UTF-8 is supported
#
# Priority order:
# 1. LC_ALL takes precedence over LANG (if LC_ALL has UTF-8, use it)
# 2. LC_ALL=C or LANG=C -> disables Unicode (POSIX locale)
# 3. Config output.showUnicode (or old output.unicodeEnabled) -> respect setting if false
# 4. LANG/LC_ALL environment variables for UTF-8 encoding
#
# Note: NO_COLOR is about colors, not Unicode. We don't disable Unicode for NO_COLOR.
#
# Returns: 0 if Unicode supported, 1 if not
detect_unicode_support() {
  # LC_ALL takes precedence over LANG (per POSIX locale hierarchy)
  # If LC_ALL has UTF-8, return success even if LANG=C
  if [[ -n "${LC_ALL:-}" ]]; then
    [[ "${LC_ALL}" =~ UTF-8 ]] && return 0
    [[ "${LC_ALL}" == "C" || "${LC_ALL}" == "POSIX" ]] && return 1
  fi

  # Check LANG for C/POSIX locale (only if LC_ALL didn't match)
  [[ "${LANG:-}" == "C" || "${LANG:-}" == "POSIX" ]] && return 1

  # Check configuration setting
  local config_unicode
  config_unicode=$(get_output_config "unicode")
  [[ "$config_unicode" == "false" ]] && return 1

  # Check environment for UTF-8 support
  [[ "${LANG:-}" =~ UTF-8 ]] || [[ "${LC_ALL:-}" =~ UTF-8 ]]
}

# get_terminal_width - Get current terminal width
#
# Priority order:
# 1. COLUMNS env var
# 2. tput cols
# 3. Default 80
#
# Returns: Terminal width in columns
get_terminal_width() {
  local width="${COLUMNS:-}"

  if [[ -z "$width" ]] && command -v tput &>/dev/null; then
    width=$(tput cols 2>/dev/null || echo "")
  fi

  # Default to 80 if still empty
  [[ -z "$width" ]] && width=80

  echo "$width"
}

# ============================================================================
# FORMAT RESOLUTION
# ============================================================================

# validate_format - Check if a format value is valid
#
# Args:
#   $1 - Format value to validate
#   $2 - Comma-separated list of valid formats (default: "text,json")
#
# Returns: 0 if valid, 1 if invalid
# Outputs: Error message to stderr if invalid
validate_format() {
  local format="$1"
  local valid_formats="${2:-human,json,text}"

  # Check if format is in the valid list
  if [[ ",$valid_formats," == *",$format,"* ]]; then
    return 0
  else
    echo "[ERROR] Invalid format: '$format'. Valid formats: $valid_formats" >&2
    return 1
  fi
}

# resolve_format - Determine output format with priority hierarchy
#
# Priority order (CLI > env > config > JSON default):
# 1. CLI argument (highest priority)
# 2. CLEO_FORMAT environment variable
# 3. config.output.defaultFormat from config.json
# 4. JSON default (LLM-Agent-First):
#    - JSON is always the default output format
#    - Use --human flag for human-readable text output
#
# Args:
#   $1 - CLI format argument (optional)
#   $2 - Validate format (true/false, default: false) - set to true to error on invalid
#   $3 - Valid formats for validation (default: "text,json")
#
# Returns: Resolved format name
resolve_format() {
  local cli_format="${1:-}"
  local do_validate="${2:-false}"
  local valid_formats="${3:-human,json,text}"

  local resolved_format=""

  # CLI argument takes precedence
  if [[ -n "$cli_format" ]]; then
    resolved_format="$cli_format"
  # Environment variable
  elif [[ -n "${CLEO_FORMAT:-}" ]]; then
    resolved_format="$CLEO_FORMAT"
  # Config file setting (if jq available and config exists)
  elif command -v jq &>/dev/null && [[ -f ".cleo/config.json" ]]; then
    resolved_format=$(jq -r '.output.defaultFormat // empty' .cleo/config.json 2>/dev/null)
  fi

  # Default fallback: JSON (LLM-Agent-First)
  # Per LLM-Agent-First philosophy, agents are the primary consumer.
  # JSON output by default enables seamless agent integration.
  # Developers use --human when they need human-readable text output.
  if [[ -z "$resolved_format" ]]; then
    resolved_format="json"
  fi

  # Normalize "human" to "text" for backward compatibility
  # flags.sh uses --human → "human", but legacy scripts check for "text"
  # This ensures --human works with all existing case statements
  if [[ "$resolved_format" == "human" ]]; then
    resolved_format="text"
  fi

  # Validate if requested
  if [[ "$do_validate" == "true" ]]; then
    if ! validate_format "$resolved_format" "$valid_formats"; then
      exit 1
    fi
  fi

  echo "$resolved_format"
}

# ============================================================================
# STATUS FORMATTING
# ============================================================================

# status_color - Get ANSI color code for task status
#
# Color mapping:
# - pending: 37 (dim white)
# - active: 96 (bright cyan)
# - blocked: 33 (yellow)
# - done: 32 (green)
# - cancelled: 31 (red)
#
# Args:
#   $1 - Status value (pending|active|blocked|done|cancelled)
#
# Returns: ANSI color code number
status_color() {
  local status="$1"

  case "$status" in
    pending)   echo "37" ;;  # dim white
    active)    echo "96" ;;  # bright cyan
    blocked)   echo "33" ;;  # yellow
    done)      echo "32" ;;  # green
    cancelled) echo "31" ;;  # red
    *)         echo "0"  ;;  # default/reset
  esac
}

# status_symbol - Get symbol for task status
#
# Unicode symbols:
# - pending: ○ (white circle)
# - active: ◉ (fisheye)
# - blocked: ⊗ (circled times)
# - done: ✓ (check mark)
# - cancelled: ✗ (ballot x)
#
# ASCII fallback:
# - pending: -
# - active: *
# - blocked: x
# - done: +
# - cancelled: X
#
# Args:
#   $1 - Status value (pending|active|blocked|done|cancelled)
#   $2 - Use unicode (true|false, default: true)
#
# Returns: Status symbol character
status_symbol() {
  local status="$1"
  local unicode="${2:-true}"

  if [[ "$unicode" == "true" ]]; then
    case "$status" in
      pending)   echo "○" ;;
      active)    echo "◉" ;;
      blocked)   echo "⊗" ;;
      done)      echo "✓" ;;
      cancelled) echo "✗" ;;
      *)         echo "?" ;;
    esac
  else
    case "$status" in
      pending)   echo "-" ;;
      active)    echo "*" ;;
      blocked)   echo "x" ;;
      done)      echo "+" ;;
      cancelled) echo "X" ;;
      *)         echo "?" ;;
    esac
  fi
}

# ============================================================================
# PRIORITY FORMATTING
# ============================================================================

# priority_color - Get ANSI color code for task priority
#
# Color mapping:
# - critical: 91 (bright red)
# - high: 93 (bright yellow)
# - medium: 94 (bright blue)
# - low: 90 (bright black/dim gray)
#
# Args:
#   $1 - Priority value (critical|high|medium|low)
#
# Returns: ANSI color code number
priority_color() {
  local priority="$1"

  case "$priority" in
    critical) echo "91" ;;  # bright red
    high)     echo "93" ;;  # bright yellow
    medium)   echo "94" ;;  # bright blue
    low)      echo "90" ;;  # bright black (dim gray)
    *)        echo "0"  ;;  # default/reset
  esac
}

# priority_symbol - Get symbol for task priority
#
# Emoji symbols:
# - critical: 🔴 (red circle)
# - high: 🟡 (yellow circle)
# - medium: 🔵 (blue circle)
# - low: ⚪ (white circle)
#
# ASCII fallback:
# - critical: !
# - high: H
# - medium: M
# - low: L
#
# Args:
#   $1 - Priority value (critical|high|medium|low)
#   $2 - Use unicode (true|false, default: true)
#
# Returns: Priority symbol character(s)
priority_symbol() {
  local priority="$1"
  local unicode="${2:-true}"

  if [[ "$unicode" == "true" ]]; then
    case "$priority" in
      critical) echo "🔴" ;;
      high)     echo "🟡" ;;
      medium)   echo "🔵" ;;
      low)      echo "⚪" ;;
      *)        echo "⚫" ;;
    esac
  else
    case "$priority" in
      critical) echo "!" ;;
      high)     echo "H" ;;
      medium)   echo "M" ;;
      low)      echo "L" ;;
      *)        echo "?" ;;
    esac
  fi
}

# ============================================================================
# PROGRESS VISUALIZATION
# ============================================================================

# progress_bar - Generate ASCII progress bar
#
# Generates a progress bar like: [████████░░] 80%
#
# Uses:
# - Unicode filled: █ (U+2588 FULL BLOCK)
# - Unicode empty: ░ (U+2591 LIGHT SHADE)
# - ASCII fallback: = for filled, - for empty
#
# Args:
#   $1 - Current value
#   $2 - Total value
#   $3 - Bar width in characters (default: 20)
#   $4 - Use unicode (true|false, default: true)
#
# Returns: Formatted progress bar string
progress_bar() {
  local current="$1"
  local total="$2"
  local width="${3:-20}"
  local unicode="${4:-true}"

  # Handle negative current value
  [[ "$current" -lt 0 ]] && current=0

  # Avoid division by zero
  if [[ "$total" -eq 0 ]]; then
    if [[ "$unicode" == "true" ]]; then
      printf "[%s] %3d%%" "$(printf '░%.0s' $(seq 1 "$width"))" 0
    else
      printf "[%s] %3d%%" "$(printf -- '-%.0s' $(seq 1 "$width"))" 0
    fi
    return
  fi

  local percent=$((current * 100 / total))
  local filled=$((current * width / total))

  # Cap filled at width (prevents overflow at 100%)
  [[ "$filled" -gt "$width" ]] && filled=$width

  local empty=$((width - filled))

  # Ensure at least 0 and no negative values
  [[ "$filled" -lt 0 ]] && filled=0
  [[ "$empty" -lt 0 ]] && empty=0

  # Generate filled and empty portions
  local filled_str=""
  local empty_str=""

  if [[ "$unicode" == "true" ]]; then
    [[ "$filled" -gt 0 ]] && filled_str=$(printf '█%.0s' $(seq 1 "$filled"))
    [[ "$empty" -gt 0 ]] && empty_str=$(printf '░%.0s' $(seq 1 "$empty"))
    printf "[%s%s] %3d%%" "$filled_str" "$empty_str" "$percent"
  else
    [[ "$filled" -gt 0 ]] && filled_str=$(printf '=%.0s' $(seq 1 "$filled"))
    [[ "$empty" -gt 0 ]] && empty_str=$(printf -- '-%.0s' $(seq 1 "$empty"))
    printf "[%s%s] %3d%%" "$filled_str" "$empty_str" "$percent"
  fi
}

# ============================================================================
# BOX DRAWING
# ============================================================================

# draw_box - Return box-drawing characters
#
# Unicode box-drawing:
# - TL: ╭ (U+256D BOX DRAWINGS LIGHT ARC DOWN AND RIGHT)
# - TR: ╮ (U+256E BOX DRAWINGS LIGHT ARC DOWN AND LEFT)
# - BL: ╰ (U+2570 BOX DRAWINGS LIGHT ARC UP AND RIGHT)
# - BR: ╯ (U+256F BOX DRAWINGS LIGHT ARC UP AND LEFT)
# - H: ─ (U+2500 BOX DRAWINGS LIGHT HORIZONTAL)
# - V: │ (U+2502 BOX DRAWINGS LIGHT VERTICAL)
#
# ASCII fallback:
# - Corners: +
# - Horizontal: -
# - Vertical: |
#
# Args:
#   $1 - Character type: TL|TR|BL|BR|H|V
#   $2 - Use unicode (true|false, default: true)
#
# Returns: Box-drawing character
draw_box() {
  local type="$1"
  local unicode="${2:-true}"

  if [[ "$unicode" == "true" ]]; then
    case "$type" in
      TL) echo "╭" ;;
      TR) echo "╮" ;;
      BL) echo "╰" ;;
      BR) echo "╯" ;;
      H)  echo "─" ;;
      V)  echo "│" ;;
      *)  echo "?" ;;
    esac
  else
    case "$type" in
      TL|TR|BL|BR) echo "+" ;;
      H)           echo "-" ;;
      V)           echo "|" ;;
      *)           echo "?" ;;
    esac
  fi
}

# ============================================================================
# OUTPUT HELPERS
# ============================================================================

# print_colored - Print text with ANSI color if supported
#
# Args:
#   $1 - Color code (ANSI number, e.g., 32 for green)
#   $2 - Text to print
#   $3 - Newline (true|false, default: true)
#
# Returns: Colored text (or plain if colors disabled)
print_colored() {
  local color="$1"
  local text="$2"
  local newline="${3:-true}"

  local output=""

  if detect_color_support; then
    output="\033[${color}m${text}\033[0m"
  else
    output="$text"
  fi

  if [[ "$newline" == "true" ]]; then
    echo -e "$output"
  else
    echo -ne "$output"
  fi
}

# print_header - Print section header with box drawing
#
# Generates a header like:
# ╭─────────────────────────╮
# │  📊 Section Title       │
# ╰─────────────────────────╯
#
# Args:
#   $1 - Header text
#   $2 - Width (default: terminal width or 60)
#   $3 - Use unicode (true|false, default: auto-detect)
#
# Returns: Formatted header block
print_header() {
  local text="$1"
  local width="${2:-}"
  local unicode="${3:-}"

  # Auto-detect width
  if [[ -z "$width" ]]; then
    width=$(get_terminal_width)
    # Cap at reasonable max
    [[ "$width" -gt 80 ]] && width=80
  fi

  # Auto-detect unicode
  if [[ -z "$unicode" ]]; then
    detect_unicode_support && unicode="true" || unicode="false"
  fi

  # Get box characters
  local TL=$(draw_box TL "$unicode")
  local TR=$(draw_box TR "$unicode")
  local BL=$(draw_box BL "$unicode")
  local BR=$(draw_box BR "$unicode")
  local H=$(draw_box H "$unicode")
  local V=$(draw_box V "$unicode")

  # Calculate padding
  local text_len=${#text}
  local inner_width=$((width - 4))  # Account for borders and padding
  local padding_total=$((inner_width - text_len))
  local padding_right=$padding_total

  # Ensure non-negative padding
  [[ "$padding_right" -lt 0 ]] && padding_right=0

  # Build horizontal line
  local hline=""
  for ((i=0; i<width-2; i++)); do
    hline="${hline}${H}"
  done

  # Print header
  echo "${TL}${hline}${TR}"
  printf "%s  %s%*s%s\n" "$V" "$text" "$padding_right" "" "$V"
  echo "${BL}${hline}${BR}"
}

# print_task_line - Format single task line with status and colors
#
# Generates output like:
# ◉ [T003] Implement authentication (high)
#
# Args:
#   $1 - Task ID
#   $2 - Task status
#   $3 - Task priority
#   $4 - Task title
#   $5 - Use unicode (true|false, default: auto-detect)
#
# Returns: Formatted task line
print_task_line() {
  local task_id="$1"
  local status="$2"
  local priority="$3"
  local title="$4"
  local unicode="${5:-}"

  # Auto-detect unicode
  if [[ -z "$unicode" ]]; then
    detect_unicode_support && unicode="true" || unicode="false"
  fi

  # Get symbols and colors
  local status_sym=$(status_symbol "$status" "$unicode")
  local status_col=$(status_color "$status")
  local priority_col=$(priority_color "$priority")

  # Build output
  local output=""

  if detect_color_support; then
    # Colored output
    output="\033[${status_col}m${status_sym}\033[0m "
    output+="[\033[1m${task_id}\033[0m] "
    output+="\033[${priority_col}m${title}\033[0m"
    output+=" (\033[${priority_col}m${priority}\033[0m)"
  else
    # Plain output
    output="${status_sym} [${task_id}] ${title} (${priority})"
  fi

  echo -e "$output"
}

# ============================================================================
# DATE FORMATTING
# ============================================================================

# format_date - Format a date/time according to configuration
#
# Respects output.dateFormat configuration:
# - iso8601: Full ISO 8601 format (2025-12-12T10:30:00Z)
# - relative: Relative time (5 minutes ago, 2 days ago)
# - unix: Unix timestamp
# - locale: System locale format
#
# Args:
#   $1 - ISO 8601 date string
#
# Returns: Formatted date string
format_date() {
  local iso_date="$1"
  local format
  format=$(get_output_config "dateFormat")

  case "$format" in
    relative)
      # Calculate relative time
      local now_epoch date_epoch diff
      now_epoch=$(date +%s)
      date_epoch=$(date -d "$iso_date" +%s 2>/dev/null || echo "0")

      if [[ "$date_epoch" -eq 0 ]]; then
        echo "$iso_date"
        return
      fi

      diff=$((now_epoch - date_epoch))

      if [[ "$diff" -lt 60 ]]; then
        echo "just now"
      elif [[ "$diff" -lt 3600 ]]; then
        echo "$((diff / 60)) minutes ago"
      elif [[ "$diff" -lt 86400 ]]; then
        echo "$((diff / 3600)) hours ago"
      elif [[ "$diff" -lt 604800 ]]; then
        echo "$((diff / 86400)) days ago"
      else
        echo "$((diff / 604800)) weeks ago"
      fi
      ;;
    unix)
      date -d "$iso_date" +%s 2>/dev/null || echo "$iso_date"
      ;;
    locale)
      date -d "$iso_date" "+%c" 2>/dev/null || echo "$iso_date"
      ;;
    iso8601|*)
      echo "$iso_date"
      ;;
  esac
}

# ============================================================================
# TITLE FORMATTING
# ============================================================================

# truncate_title - Truncate a title according to configuration
#
# Respects output.showCompactTitles (or old output.compactTitles) and output.maxTitleLength configuration.
#
# Args:
#   $1 - Title string
#   $2 - Optional override for max length
#
# Returns: Truncated title (with ... if truncated)
truncate_title() {
  local title="$1"
  local max_length="${2:-}"

  # Check if truncation is enabled
  local compact
  compact=$(get_output_config "compactTitles")

  if [[ "$compact" != "true" && -z "$max_length" ]]; then
    echo "$title"
    return
  fi

  # Get max length
  if [[ -z "$max_length" ]]; then
    max_length=$(get_output_config "maxTitleLength")
  fi

  if [[ ${#title} -le "$max_length" ]]; then
    echo "$title"
  else
    echo "${title:0:$((max_length - 3))}..."
  fi
}

# ============================================================================
# CSV FORMATTING
# ============================================================================

# get_csv_delimiter - Get the configured CSV delimiter
#
# Returns: CSV delimiter character (default: comma)
get_csv_delimiter() {
  get_output_config "csvDelimiter"
}

# ============================================================================
# PROGRESS BAR CONFIG
# ============================================================================

# progress_bars_enabled - Check if progress bars are enabled
#
# Returns: 0 if enabled, 1 if disabled
progress_bars_enabled() {
  local enabled
  enabled=$(get_output_config "progressBars")
  [[ "$enabled" != "false" ]]
}

# ============================================================================
# TEXT FORMATTING
# ============================================================================

# pluralize - Return singular or plural form based on count
#
# Args:
#   $1 - Count value
#   $2 - Singular form (e.g., "task")
#   $3 - Plural form (optional, defaults to singular + "s")
#
# Returns: Correct form based on count
#
# Examples:
#   pluralize 1 "task"         -> "task"
#   pluralize 5 "task"         -> "tasks"
#   pluralize 1 "entry" "entries" -> "entry"
#   pluralize 3 "entry" "entries" -> "entries"
pluralize() {
  local count="$1"
  local singular="$2"
  local plural="${3:-${singular}s}"
  if [[ "$count" -eq 1 ]]; then
    echo "$singular"
  else
    echo "$plural"
  fi
}

# ============================================================================
# EXPORTS
# ============================================================================

# Export all functions for sourcing by other scripts
export -f load_output_config
export -f get_output_config
export -f detect_color_support
export -f detect_unicode_support
export -f get_terminal_width
export -f validate_format
export -f resolve_format
export -f status_color
export -f status_symbol
export -f priority_color
export -f priority_symbol
export -f progress_bar
export -f draw_box
export -f print_colored
export -f print_header
export -f print_task_line
export -f format_date
export -f truncate_title
export -f get_csv_delimiter
export -f progress_bars_enabled
export -f pluralize
