#!/usr/bin/env bats

load test_helper

setup_file() {
  bats_require_minimum_version 1.5.0
}

echo_err() {
  echo "$@" >&2
}

printf_err() {
  # shellcheck disable=2059
  printf "$@" >&2
}

#
# Literal matching
#

# Correctness
@test "assert_stderr() <expected>: returns 0 if <expected> equals \`\$stderr'" {
  run --separate-stderr echo_err 'a'
  run assert_stderr 'a'
  assert_test_pass
}

@test "assert_stderr() <expected>: returns 1 and displays details if <expected> does not equal \`\$stderr'" {
  run --separate-stderr echo_err 'b'
  run assert_stderr 'a'

  assert_test_fail <<'ERR_MSG'

-- stderr differs --
expected : a
actual   : b
--
ERR_MSG
}

@test 'assert_stderr(): succeeds if stderr is non-empty' {
  run --separate-stderr echo_err 'a'
  run assert_stderr

  assert_test_pass
}

@test 'assert_stderr(): fails if stderr is empty' {
  run --separate-stderr echo_err ''
  run assert_stderr

  assert_test_fail <<'ERR_MSG'

-- no stderr --
expected non-empty stderr, but stderr was empty
--
ERR_MSG
}

@test 'assert_stderr() - : reads <expected> from STDIN' {
  run --separate-stderr echo_err 'a'
  run assert_stderr - <<STDIN
a
STDIN

  assert_test_pass
}

@test 'assert_stderr() --stdin : reads <expected> from STDIN' {
  run --separate-stderr echo_err 'a'
  run assert_stderr --stdin <<STDIN
a
STDIN

  assert_test_pass
}

# stderr formatting
@test "assert_stderr() <expected>: displays details in multi-line format if \`\$stderr' is longer than one line" {
  run --separate-stderr printf_err 'b 0\nb 1'
  run assert_stderr 'a'

  assert_test_fail <<'ERR_MSG'

-- stderr differs --
expected (1 lines):
  a
actual (2 lines):
  b 0
  b 1
--
ERR_MSG
}

@test 'assert_stderr() <expected>: displays details in multi-line format if <expected> is longer than one line' {
  run --separate-stderr echo_err 'b'
  run assert_stderr $'a 0\na 1'

  assert_test_fail <<'ERR_MSG'

-- stderr differs --
expected (2 lines):
  a 0
  a 1
actual (1 lines):
  b
--
ERR_MSG
}

# Options
@test 'assert_stderr() <expected>: performs literal matching by default' {
  run --separate-stderr echo_err 'a'
  run assert_stderr '*'

  assert_test_fail <<'ERR_MSG'

-- stderr differs --
expected : *
actual   : a
--
ERR_MSG
}


#
# Partial matching: `-p' and `--partial'
#

@test 'assert_stderr() -p <partial>: enables partial matching' {
  run --separate-stderr echo_err 'abc'
  run assert_stderr -p 'b'
  assert_test_pass
}

@test 'assert_stderr() --partial <partial>: enables partial matching' {
  run --separate-stderr echo_err 'abc'
  run assert_stderr --partial 'b'
  assert_test_pass
}

# Correctness
@test "assert_stderr() --partial <partial>: returns 0 if <partial> is a substring in \`\$stderr'" {
  run --separate-stderr printf_err 'a\nb\nc'
  run assert_stderr --partial 'b'
  assert_test_pass
}

@test "assert_stderr() --partial <partial>: returns 1 and displays details if <partial> is not a substring in \`\$stderr'" {
  run --separate-stderr echo_err 'b'
  run assert_stderr --partial 'a'

  assert_test_fail <<'ERR_MSG'

-- stderr does not contain substring --
substring : a
stderr    : b
--
ERR_MSG
}

# stderr formatting
@test "assert_stderr() --partial <partial>: displays details in multi-line format if \`\$stderr' is longer than one line" {
  run --separate-stderr printf_err 'b 0\nb 1'
  run assert_stderr --partial 'a'

  assert_test_fail <<'ERR_MSG'

-- stderr does not contain substring --
substring (1 lines):
  a
stderr (2 lines):
  b 0
  b 1
--
ERR_MSG
}

@test 'assert_stderr() --partial <partial>: displays details in multi-line format if <partial> is longer than one line' {
  run --separate-stderr echo_err 'b'
  run assert_stderr --partial $'a 0\na 1'

  assert_test_fail <<'ERR_MSG'

-- stderr does not contain substring --
substring (2 lines):
  a 0
  a 1
stderr (1 lines):
  b
--
ERR_MSG
}


#
# Regular expression matching: `-e' and `--regexp'
#

@test 'assert_stderr() -e <regexp>: enables regular expression matching' {
  run --separate-stderr echo_err 'abc'
  run assert_stderr -e '^a'
  assert_test_pass
}

@test 'assert_stderr() --regexp <regexp>: enables regular expression matching' {
  run --separate-stderr echo_err 'abc'
  run assert_stderr --regexp '^a'
  assert_test_pass
}

# Correctness
@test "assert_stderr() --regexp <regexp>: returns 0 if <regexp> matches \`\$stderr'" {
  run --separate-stderr printf_err 'a\nb\nc'
  run assert_stderr --regexp '.*b.*'
  assert_test_pass
}

@test "assert_stderr() --regexp <regexp>: returns 1 and displays details if <regexp> does not match \`\$stderr'" {
  run --separate-stderr echo_err 'b'
  run assert_stderr --regexp '.*a.*'

  assert_test_fail <<'ERR_MSG'

-- regular expression does not match stderr --
regexp : .*a.*
stderr : b
--
ERR_MSG
}

# stderr formatting
@test "assert_stderr() --regexp <regexp>: displays details in multi-line format if \`\$stderr' is longer than one line" {
  run --separate-stderr printf_err 'b 0\nb 1'
  run assert_stderr --regexp '.*a.*'

  assert_test_fail <<'ERR_MSG'

-- regular expression does not match stderr --
regexp (1 lines):
  .*a.*
stderr (2 lines):
  b 0
  b 1
--
ERR_MSG
}

@test 'assert_stderr() --regexp <regexp>: displays details in multi-line format if <regexp> is longer than one line' {
  run --separate-stderr echo_err 'b'
  run assert_stderr --regexp $'.*a\nb.*'

  assert_test_fail <<'ERR_MSG'

-- regular expression does not match stderr --
regexp (2 lines):
  .*a
  b.*
stderr (1 lines):
  b
--
ERR_MSG
}

# Error handling
@test 'assert_stderr() --regexp <regexp>: returns 1 and displays an error message if <regexp> is not a valid extended regular expression' {
  run assert_stderr --regexp '[.*'

  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >=3) )); then
    [[ "$output" =~ "invalid regular expression "([^$'\n']+) ]]
    assert_test_fail <<ERR_MSG

-- ERROR: assert_stderr --
invalid regular expression ${BASH_REMATCH[1]}
--
ERR_MSG
  else
    assert_test_fail <<'ERR_MSG'

-- ERROR: assert_stderr --
Invalid extended regular expression: `[.*'
--
ERR_MSG
  fi
}


#
# Common
#

@test "assert_stderr(): \`--partial' and \`--regexp' are mutually exclusive" {
  run assert_stderr --partial --regexp

  assert_test_fail <<'ERR_MSG'

-- ERROR: assert_stderr --
`--partial' and `--regexp' are mutually exclusive
--
ERR_MSG
}

@test "assert_stderr(): \`--' stops parsing options" {
  run --separate-stderr echo_err '-p'
  run assert_stderr -- '-p'
  assert_test_pass
}
