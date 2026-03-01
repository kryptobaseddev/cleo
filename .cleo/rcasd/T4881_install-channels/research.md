# T4881: Installation Channels and Dev Runtime Isolation -- Research

**Date**: 2026-02-25
**Task**: T4883
**Epic**: T4881
**Type**: Research
**Status**: complete

## Problem

Contributors frequently run a globally installed CLEO binary while editing source in a local repository. This creates a source/runtime mismatch and invalidates dogfooding feedback.

## Findings

1. `npx` execution is ephemeral and does not guarantee persistent global CLI install.
2. Global npm install (`npm i -g`) executes compiled package artifacts, not local TypeScript source.
3. Local source edits require rebuild of package output before runtime behavior changes.
4. Provider MCP configurations amplify confusion when multiple profiles point to different channels.
5. Current installer paths contain duplicate symlink logic and should be consolidated under `installer/lib/link.sh`.
6. Production installer references to scripts under `/dev` or `/dev/archived` are unsafe and must be removed.
7. Raw `npm link` follows package bin mappings and can expose `cleo`/`ct`; it does not guarantee `cleo-dev` isolation by itself.

## Required Runtime Modes

- Stable: default user runtime
- Beta: prerelease runtime for controlled validation
- Dev: contributor-local runtime with isolation

## Recommendation

Adopt explicit channel contracts and isolate dev runtime by default (`cleo-dev`, `~/.cleo-dev`, `cleo-dev` MCP server), with no `ct` alias in dev mode.

Enforce contributor setup via channel-aware installer dev mode (`./install.sh --dev`) when strict isolation is required.
