import { describe, expect, it } from 'vitest';
import { containsSecret, redact, redactWithFlag } from '../redact.js';

describe('redact (superset of both prior credential scrubbers)', () => {
  it('redacts Anthropic API keys (sk-ant-…)', () => {
    const out = redact('The key is sk-ant-api03-AAABBBCCCDDDEEEFFFGGGHHH-xxx and that is it');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts generic and OpenAI sk- keys', () => {
    expect(redact('sk-proj-abcdefghijklmnopqrstuvwxyz123')).toBe('[REDACTED]');
    expect(redact('token sk-abcdefghijklmnopqrstuvwxyz0123456789')).toContain('[REDACTED]');
  });

  it('redacts Slack bot tokens (xoxb-…) — coverage previously only on the plugin path', () => {
    const out = redact('slack: xoxb-1234-5678-abcdEFGHijklMNOP');
    expect(out).not.toContain('xoxb-1234');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens in Authorization headers', () => {
    expect(redact('Authorization: Bearer abc.def-ghi_jkl=')).toContain('[REDACTED]');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dummysignaturevalue';
    expect(redact(`token ${jwt}`)).not.toContain('eyJhbGci');
  });

  it('preserves the env var name and redacts only the value', () => {
    const out = redact('export ANTHROPIC_API_KEY=sk-ant-api03-XXXYYYZZZ123456789');
    expect(out).toContain('ANTHROPIC_API_KEY');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-ant');
  });

  it('redacts secret-looking file paths', () => {
    const out = redact('Loading key from ~/.ssh/id_rsa for authentication');
    expect(out).toContain('[REDACTED_PATH]');
  });

  it('redacts hex secrets and JSON password fields', () => {
    expect(redact('key=0123456789abcdef0123456789abcdef')).toContain('[REDACTED]');
    expect(redact('{"password":"hunter2secret"}')).toContain('[REDACTED]');
  });

  it('leaves clean content untouched', () => {
    const clean = 'This is a completely normal message with no secrets.';
    expect(redact(clean)).toBe(clean);
  });

  it('passes undefined through unchanged (optional-field scrubbing)', () => {
    expect(redact(undefined)).toBeUndefined();
  });
});

describe('redactWithFlag', () => {
  it('reports redacted=true when a pattern matched', () => {
    const { content, redacted } = redactWithFlag('key sk-ant-api03-AAABBBCCCDDDEEEFFFGGGHHH1');
    expect(redacted).toBe(true);
    expect(content).toContain('[REDACTED]');
  });

  it('reports redacted=false and returns the input verbatim when nothing matched', () => {
    const raw = 'nothing secret here';
    const { content, redacted } = redactWithFlag(raw);
    expect(redacted).toBe(false);
    expect(content).toBe(raw);
  });
});

describe('containsSecret', () => {
  it('detects a secret without mutating the input', () => {
    expect(containsSecret('Authorization: Bearer abc.def-ghi')).toBe(true);
    expect(containsSecret('xoxb-1234-5678-abcdEFGH')).toBe(true);
  });

  it('returns false for clean content', () => {
    expect(containsSecret('just an ordinary log line')).toBe(false);
  });
});
