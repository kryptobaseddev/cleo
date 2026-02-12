#!/usr/bin/env bats

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test
    export GENERATOR_SCRIPT="${FIXTURES_DIR}/generate-large-dataset.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

source_graph_cache() {
    source "${LIB_DIR}/tasks/graph-cache.sh" 2>/dev/null || true
}

measure_ms() {
    local start end duration_ms
    start=$(date +%s%N 2>/dev/null || date +%s)
    "$@" >/dev/null 2>&1
    end=$(date +%s%N 2>/dev/null || date +%s)
    if [[ ${#start} -gt 10 ]]; then
        duration_ms=$(( (end - start) / 1000000 ))
    else
        duration_ms=$(( (end - start) * 1000 ))
    fi
    echo "$duration_ms"
}

generate_task_dataset() {
    local count="${1:-100}"
    local density="${2:-0.3}"
    if [[ -x "$GENERATOR_SCRIPT" ]]; then
        bash "$GENERATOR_SCRIPT" "$count" "$density" > "$TODO_FILE"
        _update_fixture_checksum "$TODO_FILE"
    else
        create_complex_deps
    fi
}

skip_if_slow_env() {
    if [[ -n "${CI:-}" ]]; then
        skip "Skipping in CI"
    fi
}

@test "add task invalidates cache checksum" {
    create_linear_chain
    local cs1 cs2
    cs1=$(sha256sum "$TODO_FILE" | cut -d' ' -f1)
    run bash "$ADD_SCRIPT" "New task" --depends T001
    assert_success
    cs2=$(sha256sum "$TODO_FILE" | cut -d' ' -f1)
    [ "$cs1" != "$cs2" ]
}

@test "update task invalidates cache checksum" {
    create_independent_tasks
    local cs1 cs2
    cs1=$(sha256sum "$TODO_FILE" | cut -d' ' -f1)
    run bash "$UPDATE_SCRIPT" T002 --depends T001
    assert_success
    cs2=$(sha256sum "$TODO_FILE" | cut -d' ' -f1)
    [ "$cs1" != "$cs2" ]
}

@test "complete task invalidates cache checksum" {
    create_linear_chain
    local cs1 cs2
    cs1=$(sha256sum "$TODO_FILE" | cut -d' ' -f1)
    run bash "$COMPLETE_SCRIPT" T001 --skip-notes
    assert_success
    cs2=$(sha256sum "$TODO_FILE" | cut -d' ' -f1)
    [ "$cs1" != "$cs2" ]
}

@test "deps on generated dataset works" {
    generate_task_dataset 50 0.4
    local out
    out=$(bash "$DEPS_SCRIPT" --format json 2>&1)
    echo "$out" | jq -e '.success == true'
}

@test "deps 100 tasks under 2s" {
    generate_task_dataset 100 0.3
    bash "$DEPS_SCRIPT" --format json >/dev/null 2>&1 || true
    local dur
    dur=$(measure_ms bash "$DEPS_SCRIPT" --format json)
    echo "# 100 tasks: ${dur}ms" >&3
    [ "$dur" -lt 2000 ]
}

@test "deps 500 tasks under 15s" {
    skip_if_slow_env
    generate_task_dataset 500 0.3
    local dur
    dur=$(measure_ms bash "$DEPS_SCRIPT" --format json)
    echo "# 500 tasks: ${dur}ms" >&3
    [ "$dur" -lt 15000 ]
}

@test "cached lookup not slower than cold" {
    generate_task_dataset 200 0.4
    rm -rf .cleo/.cache 2>/dev/null || true
    local cold warm
    cold=$(measure_ms bash "$DEPS_SCRIPT" --format json)
    warm=$(measure_ms bash "$DEPS_SCRIPT" --format json)
    echo "# Cold: ${cold}ms, Warm: ${warm}ms" >&3
    [ "$warm" -le "$((cold + 200))" ]
}

@test "cache rebuild under 2s for 500 tasks" {
    skip_if_slow_env
    generate_task_dataset 500 0.3
    rm -rf .cleo/.cache 2>/dev/null || true
    local dur
    dur=$(measure_ms bash "$DEPS_SCRIPT" --format json)
    echo "# Rebuild: ${dur}ms" >&3
    [ "$dur" -lt 2000 ]
}

@test "deps 1000 tasks under 30s" {
    skip_if_slow_env
    generate_task_dataset 1000 0.2
    local dur
    dur=$(measure_ms bash "$DEPS_SCRIPT" --format json)
    echo "# 1000 tasks: ${dur}ms" >&3
    [ "$dur" -lt 30000 ]
}

@test "scaling is sub-linear" {
    skip_if_slow_env
    local prev=0
    for size in 50 100 200; do
        generate_task_dataset "$size" 0.3
        rm -rf .cleo/.cache 2>/dev/null || true
        local dur
        dur=$(measure_ms bash "$DEPS_SCRIPT" --format json)
        echo "# $size tasks: ${dur}ms" >&3
        if [ "$prev" -gt 0 ]; then
            [ "$dur" -lt "$((prev * 6))" ]
        fi
        prev=$dur
    done
}

@test "deep chains work" {
    generate_task_dataset 30 0.0
    for i in $(seq 2 30); do
        local tid pid
        tid=$(printf "T%03d" "$i")
        pid=$(printf "T%03d" "$((i-1))")
        bash "$UPDATE_SCRIPT" "$tid" --depends "$pid" >/dev/null 2>&1 || true
    done
    local out
    out=$(bash "$DEPS_SCRIPT" --format json 2>&1)
    echo "$out" | jq -e '.success == true'
}

@test "minimal todo works" {
    generate_task_dataset 5 0.0
    local out
    out=$(bash "$DEPS_SCRIPT" --format json 2>&1)
    echo "$out" | jq -e '.success == true'
}

@test "no deps works" {
    generate_task_dataset 20 0.0
    local out
    out=$(bash "$DEPS_SCRIPT" --format json 2>&1)
    echo "$out" | jq -e '.success == true'
}

@test "orphan ID is graceful" {
    generate_task_dataset 10 0.3
    bash "$DEPS_SCRIPT" T999 --format json 2>/dev/null || true
}

@test "circular deps prevented" {
    create_linear_chain
    run bash "$UPDATE_SCRIPT" T001 --depends T003
    assert_failure
}

@test "cache stats valid JSON" {
    create_complex_deps
    source_graph_cache
    ensure_graph_cache "$TODO_FILE" || true
    local s
    s=$(graph_cache_stats)
    echo "$s" | jq -e 'has("initialized")'
}

@test "invalidation rebuilds cache" {
    create_complex_deps
    source_graph_cache
    ensure_graph_cache "$TODO_FILE" || true
    [ "$_GRAPH_CACHE_VALID" = "true" ]
    invalidate_graph_cache "$TODO_FILE" || true
    [ "$_GRAPH_CACHE_INITIALIZED" = "true" ]
}

@test "forward deps correct" {
    create_complex_deps
    source_graph_cache
    ensure_graph_cache "$TODO_FILE" || true
    local d
    d=$(get_forward_deps "T003")
    [[ "$d" == *T001* ]]
    [[ "$d" == *T002* ]]
}

@test "reverse deps correct" {
    create_complex_deps
    source_graph_cache
    ensure_graph_cache "$TODO_FILE" || true
    local d
    d=$(get_reverse_deps "T001")
    [[ "$d" == *T003* ]]
}

@test "forward graph JSON valid" {
    create_complex_deps
    source_graph_cache
    ensure_graph_cache "$TODO_FILE" || true
    get_forward_graph_json | jq -e 'type == "object"'
}

@test "reverse graph JSON valid" {
    create_complex_deps
    source_graph_cache
    ensure_graph_cache "$TODO_FILE" || true
    get_reverse_graph_json | jq -e 'type == "object"'
}

@test "forward count correct" {
    create_complex_deps
    source_graph_cache
    ensure_graph_cache "$TODO_FILE" || true
    local c
    c=$(get_forward_dep_count "T003")
    [ "$c" -eq 2 ]
}

@test "reverse count correct" {
    create_complex_deps
    source_graph_cache
    ensure_graph_cache "$TODO_FILE" || true
    local c
    c=$(get_reverse_dep_count "T001")
    [ "$c" -ge 1 ]
}
