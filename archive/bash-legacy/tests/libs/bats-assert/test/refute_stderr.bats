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
@test "refute_stderr() <unexpected>: returns 0 if <unexpected> does not equal \`\$stderr'" {
  run --separate-stderr echo_err 'b'
  run refute_stderr 'a'
  assert_test_pass
}

@test "refute_stderr() <unexpected>: returns 1 and displays details if <unexpected> equals \`\$stderr'" {
  run --separate-stderr echo_err 'a'
  run refute_stderr 'a'

  assert_test_fail <<'ERR_MSG'

-- stderr equals, but it was expected to differ --
stderr : a
--
ERR_MSG
}

@test 'refute_stderr(): succeeds if stderr is empty' {
  run --separate-stderr echo_err ''
  run refute_stderr

  assert_test_pass
}

@test 'refute_stderr(): fails if stderr is non-empty' {
  run --separate-stderr echo_err 'a'
  run refute_stderr

  assert_test_fail <<'ERR_MSG'

-- stderr non-empty, but expected no stderr --
stderr : a
--
ERR_MSG
}

@test 'refute_stderr() - : reads <unexpected> from STDIN' {
  run --separate-stderr echo_err '-'
  run refute_stderr - <<INPUT
b
INPUT

  assert_test_pass
}

@test 'refute_stderr() --stdin : reads <unexpected> from STDIN' {
  run --separate-stderr echo_err '--stdin'
  run refute_stderr --stdin <<INPUT
b
INPUT

  assert_test_pass
}

# Output formatting
@test 'refute_stderr() <unexpected>: displays details in multi-line format if necessary' {
  run --separate-stderr printf_err 'a 0\na 1'
  run refute_stderr $'a 0\na 1'

  assert_test_fail <<'ERR_MSG'

-- stderr equals, but it was expected to differ --
stderr (2 lines):
  a 0
  a 1
--
ERR_MSG
}

# Options
@test 'refute_stderr() <unexpected>: performs literal matching by default' {
  run --separate-stderr echo_err 'a'
  run refute_stderr '*'
  assert_test_pass
}


#
# Partial matching: `-p' and `--partial'
#

# Options
@test 'refute_stderr() -p <partial>: enables partial matching' {
  run --separate-stderr echo_err 'abc'
  run refute_stderr -p 'd'
  assert_test_pass
}

@test 'refute_stderr() --partial <partial>: enables partial matching' {
  run --separate-stderr echo_err 'abc'
  run refute_stderr --partial 'd'
  assert_test_pass
}

# Correctness
@test "refute_stderr() --partial <partial>: returns 0 if <partial> is not a substring in \`\$stderr'" {
  run --separate-stderr printf_err 'a\nb\nc'
  run refute_stderr --partial 'd'
  assert_test_pass
}

@test "refute_stderr() --partial <partial>: returns 1 and displays details if <partial> is a substring in \`\$stderr'" {
  run --separate-stderr echo_err 'a'
  run refute_stderr --partial 'a'

  assert_test_fail <<'ERR_MSG'

-- stderr should not contain substring --
substring : a
stderr    : a
--
ERR_MSG
}

# Output formatting
@test 'refute_stderr() --partial <partial>: displays details in multi-line format if necessary' {
  run --separate-stderr printf_err 'a 0\na 1'
  run refute_stderr --partial 'a'

  assert_test_fail <<'ERR_MSG'

-- stderr should not contain substring --
substring (1 lines):
  a
stderr (2 lines):
  a 0
  a 1
--
ERR_MSG
}


#
# Regular expression matching: `-e' and `--regexp'
#

# Options
@test 'refute_stderr() -e <regexp>: enables regular expression matching' {
  run --separate-stderr echo_err 'abc^d'
  run refute_stderr -e '^d'
  assert_test_pass
}

@test 'refute_stderr() --regexp <regexp>: enables regular expression matching' {
  run --separate-stderr echo_err 'abc'
  run refute_stderr --regexp '^d'
  assert_test_pass
}

# Correctness
@test "refute_stderr() --regexp <regexp>: returns 0 if <regexp> does not match \`\$stderr'" {
  run --separate-stderr printf_err 'a\nb\nc'
  run refute_stderr --regexp '.*d.*'
  assert_test_pass
}

@test "refute_stderr() --regexp <regexp>: returns 1 and displays details if <regexp> matches \`\$stderr'" {
  run --separate-stderr echo_err 'a'
  run refute_stderr --regexp '.*a.*'

  assert_test_fail <<'ERR_MSG'

-- regular expression should not match stderr --
regexp : .*a.*
stderr : a
--
ERR_MSG
}

# Output formatting
@test 'refute_stderr() --regexp <regexp>: displays details in multi-line format if necessary' {
  run --separate-stderr printf_err 'a 0\na 1'
  run refute_stderr --regexp '.*a.*'

  assert_test_fail <<'ERR_MSG'

-- regular expression should not match stderr --
regexp (1 lines):
  .*a.*
stderr (2 lines):
  a 0
  a 1
--
ERR_MSG
}

# Error handling
@test 'refute_stderr() --regexp <regexp>: returns 1 and displays an error message if <regexp> is not a valid extended regular expression' {
  run refute_stderr --regexp '[.*'

  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >=3) )); then
    [[ "$output" =~ "invalid regular expression "([^$'\n']+) ]]
    assert_test_fail <<ERR_MSG

-- ERROR: refute_stderr --
invalid regular expression ${BASH_REMATCH[1]}
--
ERR_MSG
  else
    assert_test_fail <<'ERR_MSG'

-- ERROR: refute_stderr --
Invalid extended regular expression: `[.*'
--
ERR_MSG
  fi
}


#
# Common
#

@test "refute_stderr(): \`--partial' and \`--regexp' are mutually exclusive" {
  run refute_stderr --partial --regexp

  assert_test_fail <<'ERR_MSG'

-- ERROR: refute_stderr --
`--partial' and `--regexp' are mutually exclusive
--
ERR_MSG
}

@test "refute_stderr(): \`--' stops parsing options" {
  run --separate-stderr echo_err '--'
  run refute_stderr -- '-p'
  assert_test_pass
}
