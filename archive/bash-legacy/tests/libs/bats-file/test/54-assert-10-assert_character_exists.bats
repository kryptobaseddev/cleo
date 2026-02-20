#!/usr/bin/env bats

load 'test_helper'
fixtures 'exist'

setup () {
  bats_sudo mknod ${TEST_FIXTURE_ROOT}/dir/test_device c 89 1
}
teardown () {
    rm -f ${TEST_FIXTURE_ROOT}/dir/test_device
}

# Correctness
@test 'assert_character_exists() <file>: returns 0 if <file> character special file exists' {
  local -r file="${TEST_FIXTURE_ROOT}/dir/test_device"
  run assert_character_exists "$file"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 0 ]
}

@test 'assert_character_exists() <file>: returns 1 and displays path if <file> character special file does not exist' {
  local -r file="${TEST_FIXTURE_ROOT}/dir/file"
  run assert_character_exists "$file"
  [ "$status" -eq 1 ]
  [ "${#lines[@]}" -eq 3 ]
  [ "${lines[0]}" == '-- character special file does not exist --' ]
  [ "${lines[1]}" == "path : $file" ]
  [ "${lines[2]}" == '--' ]
}

# Transforming path
@test 'assert_character_exists() <file>: replace prefix of displayed path' {
  local -r BATSLIB_FILE_PATH_REM="#${TEST_FIXTURE_ROOT}"
  local -r BATSLIB_FILE_PATH_ADD='..'
  run assert_character_exists "${TEST_FIXTURE_ROOT}/nodir"
  [ "$status" -eq 1 ]
  [ "${#lines[@]}" -eq 3 ]
  [ "${lines[0]}" == '-- character special file does not exist --' ]
  [ "${lines[1]}" == "path : ../nodir" ]
  [ "${lines[2]}" == '--' ]
}

@test 'assert_character_exists() <file>: replace suffix of displayed path' {
  local -r BATSLIB_FILE_PATH_REM='%file.does_not_exists'
  local -r BATSLIB_FILE_PATH_ADD='..'
  run assert_character_exists "${TEST_FIXTURE_ROOT}/nodir"
  [ "$status" -eq 1 ]
  [ "${#lines[@]}" -eq 3 ]
  [ "${lines[0]}" == '-- character special file does not exist --' ]
  [ "${lines[1]}" == "path : ${TEST_FIXTURE_ROOT}/nodir" ]
  [ "${lines[2]}" == '--' ]
}

@test 'assert_character_exists() <file>: replace infix of displayed path' {
  local -r BATSLIB_FILE_PATH_REM='nodir'
  local -r BATSLIB_FILE_PATH_ADD='..'
  run assert_character_exists "${TEST_FIXTURE_ROOT}/nodir"
  [ "$status" -eq 1 ]
  [ "${#lines[@]}" -eq 3 ]
  [ "${lines[0]}" == '-- character special file does not exist --' ]
  [ "${lines[1]}" == "path : ${TEST_FIXTURE_ROOT}/.." ]
  [ "${lines[2]}" == '--' ]
}
