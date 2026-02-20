#!/usr/bin/env bats

load 'test_helper'

@test "temp_make() <var>: works when called from \`teardown_file'" {
  true
}

teardown_file() {
  TEST_TEMP_DIR="$(temp_make)"
  rm -r -- "$TEST_TEMP_DIR"
}
