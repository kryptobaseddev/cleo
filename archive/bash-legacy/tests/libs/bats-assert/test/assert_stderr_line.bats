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


###############################################################################
# Containing a line
###############################################################################

#
# Literal matching
#

# Correctness
@test "assert_stderr_line() <expected>: returns 0 if <expected> is a line in \`\${stderr_lines[@]}'" {
  run --separate-stderr printf_err 'a\nb\nc'
  run assert_stderr_line 'b'
  assert_test_pass
}

@test "assert_stderr_line() <expected>: returns 1 and displays details if <expected> is not a line in \`\${stderr_lines[@]}'" {
  run --separate-stderr echo_err 'b'
  run assert_stderr_line 'a'

  assert_test_fail <<'ERR_MSG'

-- stderr does not contain line --
line   : a
stderr : b
--
ERR_MSG
}

# stderr formatting
@test "assert_stderr_line() <expected>: displays \`\$stderr' in multi-line format if it is longer than one line" {
  run --separate-stderr printf_err 'b 0\nb 1'
  run assert_stderr_line 'a'

  assert_test_fail <<'ERR_MSG'

-- stderr does not contain line --
line : a
stderr (2 lines):
  b 0
  b 1
--
ERR_MSG
}

# Options
@test 'assert_stderr_line() <expected>: performs literal matching by default' {
  run --separate-stderr echo_err 'a'
  run assert_stderr_line '*'

  assert_test_fail <<'ERR_MSG'

-- stderr does not contain line --
line   : *
stderr : a
--
ERR_MSG
}


#
# Partial matching: `-p' and `--partial'
#

# Options
@test 'assert_stderr_line() -p <partial>: enables partial matching' {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line -p 'b'
  assert_test_pass
}

@test 'assert_stderr_line() --partial <partial>: enables partial matching' {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --partial 'b'
  assert_test_pass
}

# Correctness
@test "assert_stderr_line() --partial <partial>: returns 0 if <partial> is a substring in any line in \`\${stderr_lines[@]}'" {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --partial 'b'
  assert_test_pass
}

@test "assert_stderr_line() --partial <partial>: returns 1 and displays details if <partial> is not a substring in any lines in \`\${stderr_lines[@]}'" {
  run --separate-stderr echo_err 'b'
  run assert_stderr_line --partial 'a'

  assert_test_fail <<'ERR_MSG'

-- no stderr line contains substring --
substring : a
stderr    : b
--
ERR_MSG
}

# stderr formatting
@test "assert_stderr_line() --partial <partial>: displays \`\$stderr' in multi-line format if it is longer than one line" {
  run --separate-stderr printf_err 'b 0\nb 1'
  run assert_stderr_line --partial 'a'

  assert_test_fail <<'ERR_MSG'

-- no stderr line contains substring --
substring : a
stderr (2 lines):
  b 0
  b 1
--
ERR_MSG
}


#
# Regular expression matching: `-e' and `--regexp'
#

# Options
@test 'assert_stderr_line() -e <regexp>: enables regular expression matching' {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line -e '^.b'
  assert_test_pass
}

@test 'assert_stderr_line() --regexp <regexp>: enables regular expression matching' {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --regexp '^.b'
  assert_test_pass
}

# Correctness
@test "assert_stderr_line() --regexp <regexp>: returns 0 if <regexp> matches any line in \`\${stderr_lines[@]}'" {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --regexp '^.b'
  assert_test_pass
}

@test "assert_stderr_line() --regexp <regexp>: returns 1 and displays details if <regexp> does not match any lines in \`\${stderr_lines[@]}'" {
  run --separate-stderr echo_err 'b'
  run assert_stderr_line --regexp '^.a'

  assert_test_fail <<'ERR_MSG'

-- no stderr line matches regular expression --
regexp : ^.a
stderr : b
--
ERR_MSG
}

# stderr formatting
@test "assert_stderr_line() --regexp <regexp>: displays \`\$stderr' in multi-line format if longer than one line" {
  run --separate-stderr printf_err 'b 0\nb 1'
  run assert_stderr_line --regexp '^.a'

  assert_test_fail <<'ERR_MSG'

-- no stderr line matches regular expression --
regexp : ^.a
stderr (2 lines):
  b 0
  b 1
--
ERR_MSG
}


###############################################################################
# Matching single line: `-n' and `--index'
###############################################################################

# Options
@test 'assert_stderr_line() -n <idx> <expected>: matches against the <idx>-th line only' {
  run --separate-stderr printf_err 'a\nb\nc'
  run assert_stderr_line -n 1 'b'
  assert_test_pass
}

@test 'assert_stderr_line() --index <idx> <expected>: matches against the <idx>-th line only' {
  run --separate-stderr printf_err 'a\nb\nc'
  run assert_stderr_line --index 1 'b'
  assert_test_pass
}

@test 'assert_stderr_line() --index <idx>: returns 1 and displays an error message if <idx> is not an integer' {
  run assert_stderr_line --index 1a

  assert_test_fail <<'ERR_MSG'

-- ERROR: assert_stderr_line --
`--index' requires an integer argument: `1a'
--
ERR_MSG
}


#
# Literal matching
#

# Correctness
@test "assert_stderr_line() --index <idx> <expected>: returns 0 if <expected> equals \`\${stderr_lines[<idx>]}'" {
  run --separate-stderr printf_err 'a\nb\nc'
  run assert_stderr_line --index 1 'b'
  assert_test_pass
}

@test "assert_stderr_line() --index <idx> <expected>: returns 1 and displays details if <expected> does not equal \`\${stderr_lines[<idx>]}'" {
  run --separate-stderr printf_err 'a\nb\nc'
  run assert_stderr_line --index 1 'a'

  assert_test_fail <<'ERR_MSG'

-- line differs --
index    : 1
expected : a
actual   : b
--
ERR_MSG
}

# Options
@test 'assert_stderr_line() --index <idx> <expected>: performs literal matching by default' {
  run --separate-stderr printf_err 'a\nb\nc'
  run assert_stderr_line --index 1 '*'

  assert_test_fail <<'ERR_MSG'

-- line differs --
index    : 1
expected : *
actual   : b
--
ERR_MSG
}


#
# Partial matching: `-p' and `--partial'
#

# Options
@test 'assert_stderr_line() --index <idx> -p <partial>: enables partial matching' {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --index 1 -p 'b'
  assert_test_pass
}

@test 'assert_stderr_line() --index <idx> --partial <partial>: enables partial matching' {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --index 1 --partial 'b'
  assert_test_pass
}

# Correctness
@test "assert_stderr_line() --index <idx> --partial <partial>: returns 0 if <partial> is a substring in \`\${stderr_lines[<idx>]}'" {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --index 1 --partial 'b'
  assert_test_pass
}

@test "assert_stderr_line() --index <idx> --partial <partial>: returns 1 and displays details if <partial> is not a substring in \`\${stderr_lines[<idx>]}'" {
  run --separate-stderr printf_err 'b 0\nb 1'
  run assert_stderr_line --index 1 --partial 'a'

  assert_test_fail <<'ERR_MSG'

-- line does not contain substring --
index     : 1
substring : a
line      : b 1
--
ERR_MSG
}


#
# Regular expression matching: `-e' and `--regexp'
#

# Options
@test 'assert_stderr_line() --index <idx> -e <regexp>: enables regular expression matching' {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --index 1 -e '^.b'
  assert_test_pass
}

@test 'assert_stderr_line() --index <idx> --regexp <regexp>: enables regular expression matching' {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --index 1 --regexp '^.b'
  assert_test_pass
}

# Correctness
@test "assert_stderr_line() --index <idx> --regexp <regexp>: returns 0 if <regexp> matches \`\${stderr_lines[<idx>]}'" {
  run --separate-stderr printf_err 'a\n_b_\nc'
  run assert_stderr_line --index 1 --regexp '^.b'
  assert_test_pass
}

@test "assert_stderr_line() --index <idx> --regexp <regexp>: returns 1 and displays details if <regexp> does not match \`\${stderr_lines[<idx>]}'" {
  run --separate-stderr printf_err 'a\nb\nc'
  run assert_stderr_line --index 1 --regexp '^.a'

  assert_test_fail <<'ERR_MSG'

-- regular expression does not match line --
index  : 1
regexp : ^.a
line   : b
--
ERR_MSG
}


###############################################################################
# Common
###############################################################################

@test "assert_stderr_line(): \`--partial' and \`--regexp' are mutually exclusive" {
  run assert_stderr_line --partial --regexp

  assert_test_fail <<'ERR_MSG'

-- ERROR: assert_stderr_line --
`--partial' and `--regexp' are mutually exclusive
--
ERR_MSG
}

@test 'assert_stderr_line() --regexp <regexp>: returns 1 and displays an error message if <regexp> is not a valid extended regular expression' {
  run assert_stderr_line --regexp '[.*'

  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >=3) )); then
    [[ "$output" =~ "invalid regular expression "([^$'\n']+) ]]
    assert_test_fail <<ERR_MSG

-- ERROR: assert_stderr_line --
invalid regular expression ${BASH_REMATCH[1]}
--
ERR_MSG
  else
    assert_test_fail <<'ERR_MSG'

-- ERROR: assert_stderr_line --
Invalid extended regular expression: `[.*'
--
ERR_MSG
  fi
}

@test "assert_stderr_line(): \`--' stops parsing options" {
  run --separate-stderr printf_err 'a\n-p\nc'
  run assert_stderr_line -- '-p'
  assert_test_pass
}
