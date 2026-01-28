#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  codex-subagent.sh [spawn] [options] [PROMPT]
  codex-subagent.sh status [--id ID] [--outdir DIR]
  codex-subagent.sh heartbeat [--id ID] [--outdir DIR]
  codex-subagent.sh collect --id ID [--outdir DIR]
  codex-subagent.sh stop --id ID [--outdir DIR]

Spawn options:
  --id ID             Optional agent id (default: nanoid)
  --outdir DIR        Output directory (default: .codex-subagents)
  --cd DIR            Working directory for Codex (default: current dir)
  --model MODEL       Codex model (optional)
  --sandbox MODE      Sandbox mode (read-only|workspace-write|danger-full-access)
  --approval POLICY   Approval policy (untrusted|on-failure|on-request|never)
  --yolo              Alias for --dangerously-bypass-approvals-and-sandbox
  --full-auto         Alias for --full-auto
  --cleo              Enforce CLEO protocol usage (requires SUBAGENT PROTOCOL in prompt)
  --require-protocol  Fail if prompt lacks "SUBAGENT PROTOCOL"
  --cleo-task TASK_ID Generate prompt via `cleo orchestrator spawn <task-id> --json`
  --cleo-template NAME Optional template for cleo spawn
  --foreground        Run in foreground (wait for completion)
  --timeout SECONDS   Kill agent if still running after timeout
  --heartbeat-interval SECONDS  Update heartbeat file while running
  --task-json JSON    Task payload (passed verbatim to subagent)
  --task-file FILE    Task payload file (JSON)
  --task-json-append  Append JSON to prompt (default when prompt exists)
  --task-json-replace Replace prompt with JSON-only prompt
  --worktree          Create git worktree per agent
  --repo DIR          Git repo root (defaults to --cd or current dir)
  --branch-prefix STR Branch prefix for worktrees (default: codex)
  --worktree-base DIR Worktree base dir (default: <repo>/.codex-worktrees)
  --                  Treat remaining args as prompt (can include leading dashes)

If PROMPT is omitted or '-', the prompt is read from stdin.
USAGE
}

nanoid() {
  local alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'
  local size="${1:-21}"
  local id=""
  while [[ ${#id} -lt $size ]]; do
    id+=$(LC_ALL=C tr -dc "$alphabet" < /dev/urandom | head -c $((size - ${#id})))
  done
  printf '%s' "$id"
}

now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

subcmd="spawn"
if [[ $# -gt 0 ]]; then
  case "$1" in
    spawn|status|heartbeat|collect|stop)
      subcmd="$1"; shift;;
  esac
fi

id=""
outdir=".codex-subagents"
workdir="$PWD"
model=""
sandbox=""
approval=""
mode=""
detach="true"
task_json=""
task_file=""
task_json_mode="auto"
require_protocol="false"
cleo_mode="false"
cleo_task=""
cleo_template=""
timeout_seconds=""
heartbeat_interval=""
worktree="false"
repo=""
branch_prefix="codex"
worktree_base=""

prompt=""
stdin_prompt=""
extra_args=()

case "$subcmd" in
  status|heartbeat|collect|stop)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -h|--help) usage; exit 0;;
        --id) id="$2"; shift 2;;
        --outdir) outdir="$2"; shift 2;;
        *) echo "Unknown option: $1" >&2; exit 2;;
      esac
    done
    ;;
  spawn)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -h|--help) usage; exit 0;;
        --id) id="$2"; shift 2;;
        --outdir) outdir="$2"; shift 2;;
        --cd) workdir="$2"; shift 2;;
        --model) model="$2"; shift 2;;
        --sandbox) sandbox="$2"; shift 2;;
        --approval) approval="$2"; shift 2;;
        --yolo) mode="yolo"; shift;;
        --full-auto) mode="full-auto"; shift;;
        --cleo) cleo_mode="true"; shift;;
        --require-protocol) require_protocol="true"; shift;;
        --cleo-task) cleo_task="$2"; shift 2;;
        --cleo-template) cleo_template="$2"; shift 2;;
        --foreground) detach="false"; shift;;
        --timeout) timeout_seconds="$2"; shift 2;;
        --heartbeat-interval) heartbeat_interval="$2"; shift 2;;
        --task-json) task_json="$2"; shift 2;;
        --task-file) task_file="$2"; shift 2;;
        --task-json-append) task_json_mode="append"; shift;;
        --task-json-replace) task_json_mode="replace"; shift;;
        --worktree) worktree="true"; shift;;
        --repo) repo="$2"; shift 2;;
        --branch-prefix) branch_prefix="$2"; shift 2;;
        --worktree-base) worktree_base="$2"; shift 2;;
        --)
          shift
          if [[ $# -gt 0 ]]; then
            prompt="$*"
          fi
          break
          ;;
        *)
          if [[ -z "$prompt" ]]; then
            prompt="$1"
          else
            extra_args+=("$1")
          fi
          shift
          ;;
      esac
    done
    ;;
esac

mkdir -p "$outdir"

if [[ "$subcmd" == "spawn" ]]; then
  if [[ "$cleo_mode" == "true" ]]; then
    require_protocol="true"
  fi

  if [[ -n "$task_file" ]]; then
    task_json="$(cat "$task_file")"
  fi

  if [[ ! -t 0 ]]; then
    stdin_prompt="$(cat)"
  fi
fi

index_file="$outdir/index.tsv"

get_pid_by_id() {
  local target="$1"
  awk -F'\t' -v id="$target" '($1==id){print $2}' "$index_file" 2>/dev/null | tail -n 1
}

get_field_by_id() {
  local target="$1"
  local field="$2"
  awk -F'\t' -v id="$target" -v f="$field" '($1==id){print $f}' "$index_file" 2>/dev/null | tail -n 1
}

case "$subcmd" in
  status)
    if [[ ! -f "$index_file" ]]; then
      echo "no agents"
      exit 0
    fi
    if [[ -n "$id" ]]; then
      pid="$(get_pid_by_id "$id")"
      started="$(get_field_by_id "$id" 3)"
      wdir="$(get_field_by_id "$id" 4)"
      branch="$(get_field_by_id "$id" 7)"
      hb_file="$outdir/$id.heartbeat"
      hb="$(test -f "$hb_file" && cat "$hb_file" || echo "-")"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        alive="alive"
      else
        alive="dead"
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$pid" "$alive" "$started" "$hb" "$wdir" "$branch"
    else
      while IFS=$'\t' read -r cid cpid cstart cdir clast crepo cbranch; do
        hb_file="$outdir/$cid.heartbeat"
        hb="$(test -f "$hb_file" && cat "$hb_file" || echo "-")"
        if [[ -n "$cpid" ]] && kill -0 "$cpid" 2>/dev/null; then
          alive="alive"
        else
          alive="dead"
        fi
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$cid" "$cpid" "$alive" "$cstart" "$hb" "$cdir" "$cbranch"
      done < "$index_file"
    fi
    exit 0
    ;;
  heartbeat)
    if [[ -z "$id" ]]; then
      if [[ ! -f "$index_file" ]]; then
        echo "no agents"
        exit 0
      fi
      while IFS=$'\t' read -r cid cpid _; do
        if [[ -n "$cpid" ]] && kill -0 "$cpid" 2>/dev/null; then
          echo "$(now_utc)" > "$outdir/$cid.heartbeat"
        fi
      done < "$index_file"
      exit 0
    fi
    pid="$(get_pid_by_id "$id")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$(now_utc)" > "$outdir/$id.heartbeat"
      echo "$id"
      exit 0
    fi
    echo "not running: $id" >&2
    exit 1
    ;;
  collect)
    if [[ -z "$id" ]]; then
      echo "--id required" >&2
      exit 2
    fi
    lastfile="$(get_field_by_id "$id" 5)"
    if [[ -n "$lastfile" && -f "$lastfile" ]]; then
      cat "$lastfile"
      exit 0
    fi
    echo "no output yet: $id" >&2
    exit 1
    ;;
  stop)
    if [[ -z "$id" ]]; then
      echo "--id required" >&2
      exit 2
    fi
    pid="$(get_pid_by_id "$id")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "$id"
      exit 0
    fi
    echo "not running: $id" >&2
    exit 1
    ;;
esac

if [[ -n "$stdin_prompt" && -z "$prompt" ]]; then
  prompt="$stdin_prompt"
fi

if [[ -z "$id" ]]; then
  id="$(nanoid)"
fi

if [[ -n "$cleo_task" ]]; then
  if [[ -n "$prompt" || -n "$stdin_prompt" ]]; then
    echo "Cannot combine --cleo-task with prompt/stdin" >&2
    exit 2
  fi
  cleo_mode="true"
  require_protocol="true"
  if ! command -v jq >/dev/null 2>&1; then
    echo "jq required for --cleo-task (not found)" >&2
    exit 2
  fi
  spawn_args=(orchestrator spawn "$cleo_task" --json)
  if [[ -n "$cleo_template" ]]; then
    spawn_args+=(--template "$cleo_template")
  fi
  spawn_json=$(cleo "${spawn_args[@]}")
  prompt=$(printf '%s' "$spawn_json" | jq -r '.result.prompt')
  if [[ -z "$prompt" || "$prompt" == "null" ]]; then
    echo "Failed to extract prompt from cleo spawn output" >&2
    exit 2
  fi
fi

if [[ "$worktree" == "true" ]]; then
  if [[ -z "$repo" ]]; then
    repo="$(git -C "$workdir" rev-parse --show-toplevel 2>/dev/null || true)"
  fi
  if [[ -z "$repo" ]]; then
    echo "worktree requested but no git repo found" >&2
    exit 2
  fi
  if [[ -z "$worktree_base" ]]; then
    worktree_base="$repo/.codex-worktrees"
  fi
  mkdir -p "$worktree_base"
  branch="$branch_prefix/$id"
  workdir="$worktree_base/$id"
  git -C "$repo" worktree add -b "$branch" "$workdir" >/dev/null
fi

if [[ ${#extra_args[@]} -gt 0 ]]; then
  echo "Unexpected extra args: ${extra_args[*]}" >&2
  exit 2
fi

if [[ -z "$prompt" && -z "$task_json" ]]; then
  echo "No prompt provided (use stdin, PROMPT arg, or --task-json/--cleo-task)" >&2
  exit 2
fi

if [[ -n "$task_json" ]]; then
  echo "$task_json" > "$outdir/$id.task.json"
  case "$task_json_mode" in
    replace)
      prompt=$(cat <<EOF
You are a Codex subagent. You MUST follow the task JSON exactly and only execute actions described there.
Task JSON:
$task_json
EOF
)
      ;;
    append)
      prompt=$(cat <<EOF
$prompt

## TASK JSON (STRICT)
$task_json
EOF
)
      ;;
    auto)
      if [[ -n "$prompt" ]]; then
        prompt=$(cat <<EOF
$prompt

## TASK JSON (STRICT)
$task_json
EOF
)
      else
        prompt=$(cat <<EOF
You are a Codex subagent. You MUST follow the task JSON exactly and only execute actions described there.
Task JSON:
$task_json
EOF
)
      fi
      ;;
    *)
      echo "Unknown task_json_mode: $task_json_mode" >&2
      exit 2
      ;;
  esac
fi

if [[ "$require_protocol" == "true" ]]; then
  if command -v rg >/dev/null 2>&1; then
    if ! printf '%s' "$prompt" | rg -q "SUBAGENT PROTOCOL"; then
      echo "Prompt missing required SUBAGENT PROTOCOL block" >&2
      exit 2
    fi
  else
    if ! printf '%s' "$prompt" | grep -q "SUBAGENT PROTOCOL"; then
      echo "Prompt missing required SUBAGENT PROTOCOL block" >&2
      exit 2
    fi
  fi
fi

jsonl="$outdir/$id.jsonl"
stderr="$outdir/$id.stderr"
last="$outdir/$id.last.json"
prompt_file="$outdir/$id.prompt.txt"

printf '%s' "$prompt" > "$prompt_file"

cmd=(codex exec --json --output-last-message "$last" --cd "$workdir" --skip-git-repo-check)

if [[ -n "$model" ]]; then
  cmd+=(--model "$model")
fi

if [[ -n "$sandbox" ]]; then
  cmd+=(--sandbox "$sandbox")
fi

if [[ -n "$approval" ]]; then
  cmd+=(--ask-for-approval "$approval")
fi

case "$mode" in
  yolo)
    cmd+=(--dangerously-bypass-approvals-and-sandbox)
    ;;
  full-auto)
    cmd+=(--full-auto)
    ;;
  "")
    ;;
  *)
    echo "Unknown mode: $mode" >&2
    exit 2
    ;;
 esac

if [[ ${#extra_args[@]} -gt 0 ]]; then
  cmd+=("${extra_args[@]}")
fi

if [[ "$detach" == "true" ]]; then
  nohup "${cmd[@]}" < "$prompt_file" >"$jsonl" 2>"$stderr" &
  pid=$!
else
  "${cmd[@]}" < "$prompt_file" >"$jsonl" 2>"$stderr" &
  pid=$!
fi

printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$pid" "$(now_utc)" "$workdir" "$last" "$repo" "${branch:-}" >> "$index_file"

if [[ -n "$heartbeat_interval" ]]; then
  (
    while kill -0 "$pid" 2>/dev/null; do
      echo "$(now_utc)" > "$outdir/$id.heartbeat"
      sleep "$heartbeat_interval"
    done
  ) &
fi

if [[ -n "$timeout_seconds" ]]; then
  (
    sleep "$timeout_seconds"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "$(now_utc)" > "$outdir/$id.timeout"
    fi
  ) &
fi

if [[ "$detach" == "true" ]]; then
  echo "$id"
else
  wait "$pid"
  echo "$id"
fi
