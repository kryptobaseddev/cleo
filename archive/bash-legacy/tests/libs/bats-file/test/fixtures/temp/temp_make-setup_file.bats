#!/usr/bin/env bats

load 'test_helper'

setup_file() {
  TEST_TEMP_DIR="$(temp_make)"
}

@test "temp_make() <var>: works when called from \`setup_file'" {
  true
}

teardown_file() {
  rm -r -- "$TEST_TEMP_DIR"
}
