import { describe, expect, it } from 'vitest';
import {
  containsSecret,
  redact,
  redactJsonText,
  redactSecretFields,
  redactWithFlag,
} from '../redact.js';

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

  it('redacts GitHub tokens (ghp_/gho_/ghs_/ghu_/ghr_ and github_pat_)', () => {
    for (const token of [
      `ghp_${'A'.repeat(36)}`,
      `gho_${'b'.repeat(36)}`,
      `ghs_${'C1'.repeat(18)}`,
      `github_pat_${'D1'.repeat(11)}_${'e2'.repeat(29)}f`,
    ]) {
      const out = redact(`token ${token} end`);
      expect(out).not.toContain(token.slice(0, 8));
      expect(out).toContain('[REDACTED]');
    }
  });

  it('leaves github_pat_-prefixed snake_case identifiers alone', () => {
    for (const ident of [
      'github_pat_config_loader_value_for_tests',
      'const github_pat_rotation_policy_enabled_flag = true',
    ]) {
      expect(redact(ident)).toBe(ident);
    }
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

describe('redactSecretFields / redactJsonText (audit payloads, T13855)', () => {
  const R = '[REDACTED]';

  it.each([
    ['token'],
    ['refreshToken'],
    ['ownerAuthToken'],
    ['apiKey'],
    ['api_key'],
    ['password'],
    ['passwd'],
    ['passphrase'],
    ['client_secret'],
    ['credential'],
    ['credentials'],
    ['Authorization'],
    ['privateKey'],
    ['access_key'],
    ['codeVerifier'],
  ])('redacts a string under the secret-named field %s', (key) => {
    expect(redactSecretFields({ provider: 'github', [key]: 'plain-value-1' })).toEqual({
      provider: 'github',
      [key]: R,
    });
  });

  it('redacts secret fields at any depth, inside arrays too', () => {
    expect(
      redactSecretFields({ tokens: { accessToken: 'a1b2c3' }, list: [{ secret: 's' }] }),
    ).toEqual({
      tokens: { accessToken: R },
      list: [{ secret: R }],
    });
  });

  it('redacts a known credential shape under a non-secret field name', () => {
    const value = `gho_${'a'.repeat(36)}`;
    expect(redactSecretFields({ value })).toEqual({ value: R });
  });

  it('keeps non-secret fields, numbers and booleans, and returns the same object', () => {
    const input = {
      taskId: 'T1',
      tokenId: 'tok_1',
      maxTokens: 100,
      idempotencyKey: 'idem-1',
      keyword: 'auth',
      hasCredentials: true,
      key: 'llm.model',
    };
    expect(redactSecretFields(input)).toBe(input);
  });

  it('redactJsonText scrubs JSON and leaves clean text byte for byte', () => {
    expect(redactJsonText('{"provider":"github","token":"gho_gate"}')).toBe(
      '{"provider":"github","token":"[REDACTED]"}',
    );
    const clean = '{ "taskId": "T1" }';
    expect(redactJsonText(clean)).toBe(clean);
  });

  it('redactJsonText runs plain (non-JSON) text through redact', () => {
    expect(redactJsonText('failed with Bearer abc.def')).toBe('failed with [REDACTED]');
  });
});

describe('audit text survives path-shaped non-secrets (T13859)', () => {
  it.each([
    ['process.env'],
    ['Fix id_rsa docs'],
    ['llm.anthropic.key'],
  ])('keeps the non-secret string %s byte for byte', (text) => {
    const json = JSON.stringify({ title: text, note: text });
    expect(redactJsonText(json)).toBe(json);
    expect(redactJsonText(text)).toBe(text);
  });

  it('keeps .env.example inside a files list', () => {
    const json = JSON.stringify({ files: ['.env.example', 'src/index.ts'] });
    expect(redactJsonText(json)).toBe(json);
  });

  it('is idempotent: redacting its own output changes nothing', () => {
    const once = redactJsonText(
      JSON.stringify({
        token: 'abc',
        argv: 'cleo x --token=xyz',
        url: 'https://u:pw@host/x',
        headers: [{ name: 'Authorization', value: 'token abc' }],
      }),
    );
    expect(redactJsonText(once)).toBe(once);
  });
});

describe('audit secrets outside secret-named fields (T13860)', () => {
  const R = '[REDACTED]';

  it('redacts value when the sibling key names a secret (config set)', () => {
    expect(redactSecretFields({ key: 'cloud.apiToken', value: 'plain-value-1' })).toEqual({
      key: 'cloud.apiToken',
      value: R,
    });
  });

  it('redacts value when the sibling name names a secret (header arrays)', () => {
    expect(
      redactSecretFields({ headers: [{ name: 'Authorization', value: 'plain-value-1' }] }),
    ).toEqual({ headers: [{ name: 'Authorization', value: R }] });
  });

  it('keeps value when the sibling key is not a secret', () => {
    const input = { key: 'ui.theme', value: 'dark' };
    expect(redactSecretFields(input)).toBe(input);
  });

  it('redacts a GitHub-style Authorization: token header in text', () => {
    expect(redactJsonText('sent Authorization: token abc123 upstream')).toBe(
      `sent Authorization: token ${R} upstream`,
    );
  });

  it('redacts a URL userinfo password', () => {
    expect(redactSecretFields({ remote: 'https://me:hunter2@example.com/repo.git' })).toEqual({
      remote: `https://me:${R}@example.com/repo.git`,
    });
  });

  it.each([
    [
      'cleo service connect --token xyz9 --provider github',
      `cleo service connect --token ${R} --provider github`,
    ],
    ['cleo service connect --token=xyz9', `cleo service connect --token=${R}`],
  ])('redacts an argv token flag in %s', (argv, expected) => {
    expect(redactSecretFields({ argv })).toEqual({ argv: expected });
  });
});
