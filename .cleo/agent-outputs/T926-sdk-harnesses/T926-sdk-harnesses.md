# T926 — E1g cleo-sandbox harnesses: claude-sdk + openai-sdk + kimi

## Summary

Three SDK-based harnesses delivered under `/mnt/projects/cleo-sandbox/harnesses/`.

## Harnesses

### claude-sdk
- **SDK**: `@anthropic-ai/sdk`
- **Model**: `claude-3-5-haiku-20241022`
- **Env var**: `ANTHROPIC_API_KEY`
- **Files**: `Dockerfile`, `drive.mjs`, `README.md`

### openai-sdk
- **SDK**: `openai`
- **Model**: `gpt-4o-mini`
- **Env var**: `OPENAI_API_KEY`
- **Files**: `Dockerfile`, `drive.mjs`, `README.md`

### kimi
- **SDK**: `openai` (with `baseURL: "https://api.moonshot.ai/v1"`)
- **Model**: `moonshot-v1-8k`
- **Env var**: `MOONSHOT_API_KEY`
- **Files**: `Dockerfile`, `drive.mjs`, `README.md`

## Pattern (identical across all three)

1. Validate API key env var
2. Instantiate SDK client
3. Send one chat message asking model to identify `cleo init`
4. Run `cleo init` via `execFileSync` in an isolated tmpdir
5. Assert `.cleo/` exists
6. Cleanup tmpdir in `finally`

## Acceptance criteria

- [x] `harnesses/claude-sdk/` exists with Dockerfile + README + drive.mjs
- [x] `harnesses/openai-sdk/` exists with Dockerfile + README + drive.mjs
- [x] `harnesses/kimi/` exists with Dockerfile + README + drive.mjs

## Artifact log

`/mnt/projects/cleo-sandbox/artifacts/T926-sdk-harnesses.log`
