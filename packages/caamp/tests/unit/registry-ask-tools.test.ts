/**
 * T12482 — provider ask-tool map (human-in-the-loop structured questions).
 * T13419 — re-audited against current harness docs and binaries.
 */
import { describe, expect, it } from 'vitest';
import {
  getAllProviders,
  getProviderAskTool,
  HITL_REQUEST_FALLBACK,
  PROVIDER_ASK_TOOLS,
} from '../../src/core/registry/providers.js';

describe('PROVIDER_ASK_TOOLS (T12482)', () => {
  it('has an entry for every registry provider', () => {
    const missing = getAllProviders()
      .map((p) => p.id)
      .filter((id) => !Object.hasOwn(PROVIDER_ASK_TOOLS, id));
    expect(missing).toEqual([]);
  });

  it('has no entry for an id the registry does not know', () => {
    const ids = new Set(getAllProviders().map((p) => p.id));
    expect(Object.keys(PROVIDER_ASK_TOOLS).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('names a tool exactly when status is native, and always cites a source', () => {
    for (const [id, entry] of Object.entries(PROVIDER_ASK_TOOLS)) {
      expect(entry.source.length, id).toBeGreaterThan(0);
      if (entry.status === 'native') {
        expect(entry.toolName, id).toBeTruthy();
      } else {
        expect(entry.toolName, id).toBeNull();
        expect(entry.additionalToolNames, id).toBeUndefined();
      }
    }
  });

  it.each([
    ['claude-code', 'AskUserQuestion'],
    ['codex', 'request_user_input'],
    ['gemini-cli', 'ask_user'],
    ['copilot-cli', 'ask_user'],
    ['opencode', 'question'],
    ['kimi', 'AskUserQuestion'],
    ['cursor', 'AskQuestion'],
    ['cline', 'ask_followup_question'],
    ['roo', 'ask_followup_question'],
    // T13419 re-audit (2026-10-10)
    ['kilo-code', 'question'],
    ['vscode', 'vscode_askQuestions'],
    ['github-copilot', 'vscode_askQuestions'],
    ['qwen-code', 'ask_user_question'],
    ['continue', 'AskQuestion'],
    ['antigravity', 'ask_question'],
  ])('%s -> %s', (id, tool) => {
    expect(getProviderAskTool(id).toolName).toBe(tool);
  });

  it('records alternate names a transcript scan must also recognise (T13419)', () => {
    expect(getProviderAskTool('codex').additionalToolNames).toEqual(['request_user_input_async']);
    expect(getProviderAskTool('kilo-code').additionalToolNames).toEqual(['ask_followup_question']);
    expect(getProviderAskTool('zed').status).toBe('none');
  });

  it('resolves aliases to the canonical provider', () => {
    const r = getProviderAskTool('claude');
    expect(r.providerId).toBe('claude-code');
    expect(r.toolName).toBe('AskUserQuestion');
  });

  it('falls back to hitl.request for providers without a known tool', () => {
    for (const id of ['pi', 'aider', 'not-a-provider']) {
      const r = getProviderAskTool(id);
      expect(r.toolName).toBeNull();
      expect(r.fallback).toBe(HITL_REQUEST_FALLBACK);
    }
    expect(getProviderAskTool('not-a-provider').status).toBe('unknown');
    expect(HITL_REQUEST_FALLBACK.operation).toBe('hitl.request');
    expect(HITL_REQUEST_FALLBACK.fields).toEqual(['question', 'options', 'recommended']);
    expect(HITL_REQUEST_FALLBACK.optionFields).toEqual(['label', 'description']);
  });
});
