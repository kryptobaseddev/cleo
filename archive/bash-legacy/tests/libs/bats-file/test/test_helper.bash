# Set variables for easily accessing sub-directories of `./fixtures'.
#
# Globals:
#   BATS_TEST_DIRNAME
#   TEST_FIXTURE_ROOT
#   TEST_RELATIVE_FIXTURE_ROOT
# Arguments:
#   $1 - name of sub-directory
# Returns:
#   none
fixtures() {
  TEST_FIXTURE_ROOT="${BATS_TEST_DIRNAME}/fixtures/$1"
  TEST_RELATIVE_FIXTURE_ROOT=$(bats_trim_filename "${TEST_FIXTURE_ROOT}" TEST_RELATIVE_FIXTURE_ROOT)
}

bats_sudo() {
  local sudo_path=$(command -v sudo 2>/dev/null)
  if [[ "$(whoami)" != 'root' ]] && [ -x "$sudo_path" ]; then
    "$sudo_path" "$@"
  else
    "$@"
  fi
}

export TEST_MAIN_DIR="${BATS_TEST_DIRNAME}/.."
export TEST_DEPS_DIR="${TEST_DEPS_DIR-${TEST_MAIN_DIR}/..}"

# validate that bats-file is safe to use under -u
set -u

# Load dependencies.
bats_load_library 'bats-support'
# Load library.
load '../load'
