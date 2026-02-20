#!/usr/bin/env bats

load 'test_helper'
fixtures 'exist'

setup () {
  touch ${TEST_FIXTURE_ROOT}/dir/owner ${TEST_FIXTURE_ROOT}/dir/notowner
  # There is PATH addition to /usr/sbin which won't come by default on bash3
  # on macOS
  chown_path=$(PATH="$PATH:/usr/sbin" command -v chown 2>/dev/null)
  bats_sudo "$chown_path" root ${TEST_FIXTURE_ROOT}/dir/owner
  bats_sudo "$chown_path" daemon ${TEST_FIXTURE_ROOT}/dir/notowner
}

teardown () {
  bats_sudo rm -f ${TEST_FIXTURE_ROOT}/dir/owner ${TEST_FIXTURE_ROOT}/dir/notowner
}

# Correctness
@test 'assert_not_file_owner() <file>: returns 0 if <file> user is not the owner' {
  local -r owner="daemon"
  local -r file="${TEST_FIXTURE_ROOT}/dir/owner"
  run assert_not_file_owner "$owner" "$file"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 0 ]
}

@test 'assert_not_file_owner() <file>: returns 1 and displays path if <file> user root is the owner of the file, but it was expected not to be' {
  local -r owner="root"
  local -r file="${TEST_FIXTURE_ROOT}/dir/owner"
  run assert_not_file_owner "$owner" "$file"
  [ "$status" -eq 1 ]
  [ "${#lines[@]}" -eq 3 ]
  [ "${lines[0]}" == '-- user root is the owner of the file, but it was expected not to be --' ]
  [ "${lines[1]}" == "path : $file" ]
  [ "${lines[2]}" == '--' ]
}


# Transforming path
@test 'assert_not_file_owner() <file>: replace prefix of displayed path' {
  local -r BATSLIB_FILE_PATH_REM="#${TEST_FIXTURE_ROOT}"
  local -r BATSLIB_FILE_PATH_ADD='..'
  local -r owner="root"
  local -r file="${TEST_FIXTURE_ROOT}/dir/owner"
  run assert_not_file_owner "$owner" "$file"
  [ "$status" -eq 1 ]
  [ "${#lines[@]}" -eq 3 ]
  [ "${lines[0]}" == '-- user root is the owner of the file, but it was expected not to be --' ]
  [ "${lines[1]}" == "path : ../dir/owner" ]
  [ "${lines[2]}" == '--' ]
}

@test 'assert_not_file_owner() <file>: replace suffix of displayed path' {
  local -r BATSLIB_FILE_PATH_REM='%dir/owner'
  local -r BATSLIB_FILE_PATH_ADD='..'
  local -r owner="root"
  local -r file="${TEST_FIXTURE_ROOT}/dir/owner"
  run assert_not_file_owner "$owner" "$file"
  [ "$status" -eq 1 ]
  [ "${#lines[@]}" -eq 3 ]
  [ "${lines[0]}" == '-- user root is the owner of the file, but it was expected not to be --' ]
  [ "${lines[1]}" == "path : ${TEST_FIXTURE_ROOT}/.." ]
  [ "${lines[2]}" == '--' ]
}

@test 'assert_not_file_owner() <file>: replace infix of displayed path' {
  local -r BATSLIB_FILE_PATH_REM='dir/owner'
  local -r BATSLIB_FILE_PATH_ADD='..'
  local -r owner="root"
  local -r file="${TEST_FIXTURE_ROOT}/dir/owner"
  run assert_not_file_owner "$owner" "$file"
  [ "$status" -eq 1 ]
  [ "${#lines[@]}" -eq 3 ]
  [ "${lines[0]}" == '-- user root is the owner of the file, but it was expected not to be --' ]
  [ "${lines[1]}" == "path : ${TEST_FIXTURE_ROOT}/.." ]
  [ "${lines[2]}" == '--' ]
}
