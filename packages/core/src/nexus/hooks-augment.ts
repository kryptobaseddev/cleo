/**
 * Nexus PreToolUse Hook Installer
 *
 * Installs a shell script handler at ~/.cleo/hooks/nexus-augment.sh that intercepts
 * PreToolUse events for Grep/Glob/Read tool calls and injects symbol context via
 * `cleo nexus augment`.
 *
 * Hook output is sent to stderr so it surfaces in tool results without breaking parsing.
 *
 * Hook location: packages/core/src/nexus/hooks-augment.ts (not cleo-os, since it's
 * invoked by the CLI and the shell script is a plain text file, not a harness component).
 *
 * @task T1061
 * @epic T1042
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Install the Nexus augment hook to ~/.cleo/hooks/nexus-augment.sh.
 *
 * Creates the hook directory and writes a shell script that:
 * 1. Extracts the pattern/file argument from PreToolUse event env vars
 * 2. Calls `cleo nexus augment <pattern>`
 * 3. Emits output to stderr for hook injection
 *
 * Idempotent: overwrites existing hook file.
 *
 * @param homedir - User home directory (for ~/.cleo/hooks)
 * @task T1061
 * @epic T1042
 */
export function installNexusAugmentHook(homedir: string): void {
  const hooksDir = join(homedir, '.cleo', 'hooks');
  const hookScript = join(hooksDir, 'nexus-augment.sh');

  // Create hooks directory if it doesn't exist
  mkdirSync(hooksDir, { recursive: true });

  // Shell script that extracts pattern and calls cleo nexus augment
  // The script is idempotent and handles missing nexus.db gracefully
  const scriptContent = `#!/bin/bash
# Nexus PreToolUse Hook Augmenter
# Injects symbol context via cleo nexus augment
#
# @task T1061
# @epic T1042

set -e

# Extract pattern from environment variables set by Claude Code PreToolUse event
# TOOL_NAME contains the tool name (Grep, Glob, Read)
# TOOL_INPUT_* contains the tool arguments

PATTERN=""

case "\${TOOL_NAME}" in
  Grep)
    # Grep pattern is in TOOL_INPUT_pattern
    PATTERN="\${TOOL_INPUT_pattern}"
    ;;
  Glob)
    # Glob pattern is in TOOL_INPUT_pattern
    PATTERN="\${TOOL_INPUT_pattern}"
    ;;
  Read)
    # Read file path is in TOOL_INPUT_file_path — extract basename
    if [[ -n "\${TOOL_INPUT_file_path}" ]]; then
      PATTERN="$(basename "\${TOOL_INPUT_file_path}")"
    fi
    ;;
  *)
    # Unknown tool, skip augmentation
    exit 0
    ;;
esac

# Gracefully skip if no pattern extracted
if [[ -z "\${PATTERN}" ]]; then
  exit 0
fi

# Call cleo nexus augment and emit to stderr
# If cleo is not available or nexus.db is absent, this will exit 0 silently
cleo nexus augment "\${PATTERN}" 2>&1 >&2 || true

exit 0
`;

  writeFileSync(hookScript, scriptContent, { mode: 0o755 });
}
