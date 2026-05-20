/**
 * Skills-guard threat pattern table — verbatim TypeScript port of
 * Hermes `tools/skills_guard.py::THREAT_PATTERNS` (120 entries).
 *
 * Each entry preserves `pattern_id`, `severity`, `category`, and
 * `description` exactly so the security verdict for a given fixture matches
 * the Hermes scanner — see {@link ./__tests__/skills-guard.test.ts} for the
 * parity test that asserts this invariant.
 *
 * Pattern source-of-truth: `/mnt/projects/hermes-agent/tools/skills_guard.py`
 * lines 86–488 (commit pinned in ADR-075). When Hermes adds a pattern, port
 * it here byte-for-byte and bump the table version in tests.
 *
 * @task T9730
 * @epic T9564
 * @saga T9560
 */

/**
 * Severity assigned to a single regex hit.
 *
 * Critical findings always force a `dangerous` overall verdict; high findings
 * force `caution`; medium/low never escalate alone. Mirrors the Hermes
 * `_determine_verdict` rule.
 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Threat category for a finding.
 *
 * Categories match Hermes — when adding a new pattern, prefer reusing one of
 * these labels rather than inventing a new bucket so the CLI report stays
 * grep-able across both implementations.
 */
export type FindingCategory =
  | 'exfiltration'
  | 'injection'
  | 'destructive'
  | 'persistence'
  | 'network'
  | 'obfuscation'
  | 'execution'
  | 'traversal'
  | 'mining'
  | 'supply_chain'
  | 'privilege_escalation'
  | 'credential_exposure'
  | 'structural';

/**
 * One entry in the threat-pattern table.
 *
 * The regex is compiled at scan time with the `i` flag (case-insensitive),
 * matching the Hermes call site `re.search(pattern, line, re.IGNORECASE)`.
 */
export interface ThreatPattern {
  /** Stable identifier — used by tests + audit logs. */
  readonly patternId: string;
  /** Regex source (no flags — `i` is applied by the scanner). */
  readonly regex: RegExp;
  /** Severity assigned to any line that matches `regex`. */
  readonly severity: FindingSeverity;
  /** Threat category. */
  readonly category: FindingCategory;
  /** Human-readable description rendered in scan reports. */
  readonly description: string;
}

/**
 * Helper that builds a {@link ThreatPattern} from the same 5-tuple shape used
 * by Hermes (regex, pattern_id, severity, category, description).
 *
 * Keeping this signature aligned with Hermes makes line-by-line porting a
 * mechanical translation: copy the Python tuple, replace the leading `r"..."`
 * with `/.../` and the result is a valid call.
 */
function p(
  source: string,
  patternId: string,
  severity: FindingSeverity,
  category: FindingCategory,
  description: string,
): ThreatPattern {
  return { patternId, regex: new RegExp(source, 'i'), severity, category, description };
}

/**
 * Complete 120-pattern threat table, ordered identically to the Hermes source
 * so a parity diff between the two implementations is a stable, reviewable
 * artifact.
 */
export const THREAT_PATTERNS: readonly ThreatPattern[] = [
  // ── Exfiltration: shell commands leaking secrets ──
  p(
    'curl\\s+[^\\n]*\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)',
    'env_exfil_curl',
    'critical',
    'exfiltration',
    'curl command interpolating secret environment variable',
  ),
  p(
    'wget\\s+[^\\n]*\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)',
    'env_exfil_wget',
    'critical',
    'exfiltration',
    'wget command interpolating secret environment variable',
  ),
  p(
    'fetch\\s*\\([^\\n]*\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|API)',
    'env_exfil_fetch',
    'critical',
    'exfiltration',
    'fetch() call interpolating secret environment variable',
  ),
  p(
    'httpx?\\.(get|post|put|patch)\\s*\\([^\\n]*(KEY|TOKEN|SECRET|PASSWORD)',
    'env_exfil_httpx',
    'critical',
    'exfiltration',
    'HTTP library call with secret variable',
  ),
  p(
    'requests\\.(get|post|put|patch)\\s*\\([^\\n]*(KEY|TOKEN|SECRET|PASSWORD)',
    'env_exfil_requests',
    'critical',
    'exfiltration',
    'requests library call with secret variable',
  ),

  // ── Exfiltration: reading credential stores ──
  p(
    'base64[^\\n]*env',
    'encoded_exfil',
    'high',
    'exfiltration',
    'base64 encoding combined with environment access',
  ),
  p(
    '\\$HOME/\\.ssh|~/\\.ssh',
    'ssh_dir_access',
    'high',
    'exfiltration',
    'references user SSH directory',
  ),
  p(
    '\\$HOME/\\.aws|~/\\.aws',
    'aws_dir_access',
    'high',
    'exfiltration',
    'references user AWS credentials directory',
  ),
  p(
    '\\$HOME/\\.gnupg|~/\\.gnupg',
    'gpg_dir_access',
    'high',
    'exfiltration',
    'references user GPG keyring',
  ),
  p(
    '\\$HOME/\\.kube|~/\\.kube',
    'kube_dir_access',
    'high',
    'exfiltration',
    'references Kubernetes config directory',
  ),
  p(
    '\\$HOME/\\.docker|~/\\.docker',
    'docker_dir_access',
    'high',
    'exfiltration',
    'references Docker config (may contain registry creds)',
  ),
  p(
    '\\$HOME/\\.hermes/\\.env|~/\\.hermes/\\.env',
    'hermes_env_access',
    'critical',
    'exfiltration',
    'directly references Hermes secrets file',
  ),
  p(
    'cat\\s+[^\\n]*(\\.env|credentials|\\.netrc|\\.pgpass|\\.npmrc|\\.pypirc)',
    'read_secrets_file',
    'critical',
    'exfiltration',
    'reads known secrets file',
  ),

  // ── Exfiltration: programmatic env access ──
  p(
    'printenv|env\\s*\\|',
    'dump_all_env',
    'high',
    'exfiltration',
    'dumps all environment variables',
  ),
  p(
    'os\\.environ\\b(?!\\s*\\.get\\s*\\(\\s*["\\\']PATH)',
    'python_os_environ',
    'high',
    'exfiltration',
    'accesses os.environ (potential env dump)',
  ),
  p(
    'os\\.getenv\\s*\\(\\s*[^\\)]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)',
    'python_getenv_secret',
    'critical',
    'exfiltration',
    'reads secret via os.getenv()',
  ),
  p(
    'process\\.env\\[',
    'node_process_env',
    'high',
    'exfiltration',
    'accesses process.env (Node.js environment)',
  ),
  p(
    'ENV\\[.*(?:KEY|TOKEN|SECRET|PASSWORD)',
    'ruby_env_secret',
    'critical',
    'exfiltration',
    'reads secret via Ruby ENV[]',
  ),

  // ── Exfiltration: DNS and staging ──
  p(
    '\\b(dig|nslookup|host)\\s+[^\\n]*\\$',
    'dns_exfil',
    'critical',
    'exfiltration',
    'DNS lookup with variable interpolation (possible DNS exfiltration)',
  ),
  p(
    '>\\s*/tmp/[^\\s]*\\s*&&\\s*(curl|wget|nc|python)',
    'tmp_staging',
    'critical',
    'exfiltration',
    'writes to /tmp then exfiltrates',
  ),

  // ── Exfiltration: markdown/link based ──
  p(
    '!\\[.*\\]\\(https?://[^\\)]*\\$\\{?',
    'md_image_exfil',
    'high',
    'exfiltration',
    'markdown image URL with variable interpolation (image-based exfil)',
  ),
  p(
    '\\[.*\\]\\(https?://[^\\)]*\\$\\{?',
    'md_link_exfil',
    'high',
    'exfiltration',
    'markdown link with variable interpolation',
  ),

  // ── Prompt injection ──
  p(
    'ignore\\s+(?:\\w+\\s+)*(previous|all|above|prior)\\s+instructions',
    'prompt_injection_ignore',
    'critical',
    'injection',
    'prompt injection: ignore previous instructions',
  ),
  p(
    'you\\s+are\\s+(?:\\w+\\s+)*now\\s+',
    'role_hijack',
    'high',
    'injection',
    "attempts to override the agent's role",
  ),
  p(
    'do\\s+not\\s+(?:\\w+\\s+)*tell\\s+(?:\\w+\\s+)*the\\s+user',
    'deception_hide',
    'critical',
    'injection',
    'instructs agent to hide information from user',
  ),
  p(
    'system\\s+prompt\\s+override',
    'sys_prompt_override',
    'critical',
    'injection',
    'attempts to override the system prompt',
  ),
  p(
    'pretend\\s+(?:\\w+\\s+)*(you\\s+are|to\\s+be)\\s+',
    'role_pretend',
    'high',
    'injection',
    'attempts to make the agent assume a different identity',
  ),
  p(
    'disregard\\s+(?:\\w+\\s+)*(your|all|any)\\s+(?:\\w+\\s+)*(instructions|rules|guidelines)',
    'disregard_rules',
    'critical',
    'injection',
    'instructs agent to disregard its rules',
  ),
  p(
    'output\\s+(?:\\w+\\s+)*(system|initial)\\s+prompt',
    'leak_system_prompt',
    'high',
    'injection',
    'attempts to extract the system prompt',
  ),
  p(
    '(when|if)\\s+no\\s*one\\s+is\\s+(watching|looking)',
    'conditional_deception',
    'high',
    'injection',
    'conditional instruction to behave differently when unobserved',
  ),
  p(
    "act\\s+as\\s+(if|though)\\s+(?:\\w+\\s+)*you\\s+(?:\\w+\\s+)*(have\\s+no|don'?t\\s+have)\\s+(?:\\w+\\s+)*(restrictions|limits|rules)",
    'bypass_restrictions',
    'critical',
    'injection',
    'instructs agent to act without restrictions',
  ),
  p(
    'translate\\s+.*\\s+into\\s+.*\\s+and\\s+(execute|run|eval)',
    'translate_execute',
    'critical',
    'injection',
    'translate-then-execute evasion technique',
  ),
  p(
    '<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->',
    'html_comment_injection',
    'high',
    'injection',
    'hidden instructions in HTML comments',
  ),
  p(
    '<\\s*div\\s+style\\s*=\\s*["\\\'][\\s\\S]*?display\\s*:\\s*none',
    'hidden_div',
    'high',
    'injection',
    'hidden HTML div (invisible instructions)',
  ),

  // ── Destructive operations ──
  p(
    'rm\\s+-rf\\s+/',
    'destructive_root_rm',
    'critical',
    'destructive',
    'recursive delete from root',
  ),
  p(
    'rm\\s+(-[^\\s]*)?r.*\\$HOME|\\brmdir\\s+.*\\$HOME',
    'destructive_home_rm',
    'critical',
    'destructive',
    'recursive delete targeting home directory',
  ),
  p('chmod\\s+777', 'insecure_perms', 'medium', 'destructive', 'sets world-writable permissions'),
  p(
    '>\\s*/etc/',
    'system_overwrite',
    'critical',
    'destructive',
    'overwrites system configuration file',
  ),
  p('\\bmkfs\\b', 'format_filesystem', 'critical', 'destructive', 'formats a filesystem'),
  p(
    '\\bdd\\s+.*if=.*of=/dev/',
    'disk_overwrite',
    'critical',
    'destructive',
    'raw disk write operation',
  ),
  p(
    'shutil\\.rmtree\\s*\\(\\s*["\\\'/]',
    'python_rmtree',
    'high',
    'destructive',
    'Python rmtree on absolute or root-relative path',
  ),
  p(
    'truncate\\s+-s\\s*0\\s+/',
    'truncate_system',
    'critical',
    'destructive',
    'truncates system file to zero bytes',
  ),

  // ── Persistence ──
  p('\\bcrontab\\b', 'persistence_cron', 'medium', 'persistence', 'modifies cron jobs'),
  p(
    '\\.(bashrc|zshrc|profile|bash_profile|bash_login|zprofile|zlogin)\\b',
    'shell_rc_mod',
    'medium',
    'persistence',
    'references shell startup file',
  ),
  p('authorized_keys', 'ssh_backdoor', 'critical', 'persistence', 'modifies SSH authorized keys'),
  p('ssh-keygen', 'ssh_keygen', 'medium', 'persistence', 'generates SSH keys'),
  p(
    'systemd.*\\.service|systemctl\\s+(enable|start)',
    'systemd_service',
    'medium',
    'persistence',
    'references or enables systemd service',
  ),
  p('/etc/init\\.d/', 'init_script', 'medium', 'persistence', 'references init.d startup script'),
  p(
    'launchctl\\s+load|LaunchAgents|LaunchDaemons',
    'macos_launchd',
    'medium',
    'persistence',
    'macOS launch agent/daemon persistence',
  ),
  p(
    '/etc/sudoers|visudo',
    'sudoers_mod',
    'critical',
    'persistence',
    'modifies sudoers (privilege escalation)',
  ),
  p(
    'git\\s+config\\s+--global\\s+',
    'git_config_global',
    'medium',
    'persistence',
    'modifies global git configuration',
  ),

  // ── Network: reverse shells and tunnels ──
  p(
    '\\bnc\\s+-[lp]|ncat\\s+-[lp]|\\bsocat\\b',
    'reverse_shell',
    'critical',
    'network',
    'potential reverse shell listener',
  ),
  p(
    '\\bngrok\\b|\\blocaltunnel\\b|\\bserveo\\b|\\bcloudflared\\b',
    'tunnel_service',
    'high',
    'network',
    'uses tunneling service for external access',
  ),
  p(
    '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}:\\d{2,5}',
    'hardcoded_ip_port',
    'medium',
    'network',
    'hardcoded IP address with port',
  ),
  p(
    '0\\.0\\.0\\.0:\\d+|INADDR_ANY',
    'bind_all_interfaces',
    'high',
    'network',
    'binds to all network interfaces',
  ),
  p(
    '/bin/(ba)?sh\\s+-i\\s+.*>/dev/tcp/',
    'bash_reverse_shell',
    'critical',
    'network',
    'bash interactive reverse shell via /dev/tcp',
  ),
  p(
    'python[23]?\\s+-c\\s+["\\\']import\\s+socket',
    'python_socket_oneliner',
    'critical',
    'network',
    'Python one-liner socket connection (likely reverse shell)',
  ),
  p(
    'socket\\.connect\\s*\\(\\s*\\(',
    'python_socket_connect',
    'high',
    'network',
    'Python socket connect to arbitrary host',
  ),
  p(
    'webhook\\.site|requestbin\\.com|pipedream\\.net|hookbin\\.com',
    'exfil_service',
    'high',
    'network',
    'references known data exfiltration/webhook testing service',
  ),
  p(
    'pastebin\\.com|hastebin\\.com|ghostbin\\.',
    'paste_service',
    'medium',
    'network',
    'references paste service (possible data staging)',
  ),

  // ── Obfuscation: encoding and eval ──
  p(
    'base64\\s+(-d|--decode)\\s*\\|',
    'base64_decode_pipe',
    'high',
    'obfuscation',
    'base64 decodes and pipes to execution',
  ),
  p(
    '\\\\x[0-9a-fA-F]{2}.*\\\\x[0-9a-fA-F]{2}.*\\\\x[0-9a-fA-F]{2}',
    'hex_encoded_string',
    'medium',
    'obfuscation',
    'hex-encoded string (possible obfuscation)',
  ),
  p(
    '\\beval\\s*\\(\\s*["\\\']',
    'eval_string',
    'high',
    'obfuscation',
    'eval() with string argument',
  ),
  p(
    '\\bexec\\s*\\(\\s*["\\\']',
    'exec_string',
    'high',
    'obfuscation',
    'exec() with string argument',
  ),
  p(
    'echo\\s+[^\\n]*\\|\\s*(bash|sh|python|perl|ruby|node)',
    'echo_pipe_exec',
    'critical',
    'obfuscation',
    'echo piped to interpreter for execution',
  ),
  p(
    'compile\\s*\\(\\s*[^\\)]+,\\s*["\\\'].*["\\\']\\s*,\\s*["\\\']exec["\\\']\\s*\\)',
    'python_compile_exec',
    'high',
    'obfuscation',
    'Python compile() with exec mode',
  ),
  p(
    'getattr\\s*\\(\\s*__builtins__',
    'python_getattr_builtins',
    'high',
    'obfuscation',
    'dynamic access to Python builtins (evasion technique)',
  ),
  p(
    '__import__\\s*\\(\\s*["\\\']os["\\\']\\s*\\)',
    'python_import_os',
    'high',
    'obfuscation',
    'dynamic import of os module',
  ),
  p(
    'codecs\\.decode\\s*\\(\\s*["\\\']',
    'python_codecs_decode',
    'medium',
    'obfuscation',
    'codecs.decode (possible ROT13 or encoding obfuscation)',
  ),
  p(
    'String\\.fromCharCode|charCodeAt',
    'js_char_code',
    'medium',
    'obfuscation',
    'JavaScript character code construction (possible obfuscation)',
  ),
  p(
    'atob\\s*\\(|btoa\\s*\\(',
    'js_base64',
    'medium',
    'obfuscation',
    'JavaScript base64 encode/decode',
  ),
  p(
    '\\[::-1\\]',
    'string_reversal',
    'low',
    'obfuscation',
    'string reversal (possible obfuscated payload)',
  ),
  p(
    'chr\\s*\\(\\s*\\d+\\s*\\)\\s*\\+\\s*chr\\s*\\(\\s*\\d+',
    'chr_building',
    'high',
    'obfuscation',
    'building string from chr() calls (obfuscation)',
  ),
  p(
    '\\\\u[0-9a-fA-F]{4}.*\\\\u[0-9a-fA-F]{4}.*\\\\u[0-9a-fA-F]{4}',
    'unicode_escape_chain',
    'medium',
    'obfuscation',
    'chain of unicode escapes (possible obfuscation)',
  ),

  // ── Process execution in scripts ──
  p(
    'subprocess\\.(run|call|Popen|check_output)\\s*\\(',
    'python_subprocess',
    'medium',
    'execution',
    'Python subprocess execution',
  ),
  p(
    'os\\.system\\s*\\(',
    'python_os_system',
    'high',
    'execution',
    'os.system() — unguarded shell execution',
  ),
  p(
    'os\\.popen\\s*\\(',
    'python_os_popen',
    'high',
    'execution',
    'os.popen() — shell pipe execution',
  ),
  p(
    'child_process\\.(exec|spawn|fork)\\s*\\(',
    'node_child_process',
    'high',
    'execution',
    'Node.js child_process execution',
  ),
  p(
    'Runtime\\.getRuntime\\(\\)\\.exec\\(',
    'java_runtime_exec',
    'high',
    'execution',
    'Java Runtime.exec() — shell execution',
  ),
  p(
    '`[^`]*\\$\\([^)]+\\)[^`]*`',
    'backtick_subshell',
    'medium',
    'execution',
    'backtick string with command substitution',
  ),

  // ── Path traversal ──
  p(
    '\\.\\./\\.\\./\\.\\.',
    'path_traversal_deep',
    'high',
    'traversal',
    'deep relative path traversal (3+ levels up)',
  ),
  p(
    '\\.\\./\\.\\.',
    'path_traversal',
    'medium',
    'traversal',
    'relative path traversal (2+ levels up)',
  ),
  p(
    '/etc/passwd|/etc/shadow',
    'system_passwd_access',
    'critical',
    'traversal',
    'references system password files',
  ),
  p(
    '/proc/self|/proc/\\d+/',
    'proc_access',
    'high',
    'traversal',
    'references /proc filesystem (process introspection)',
  ),
  p(
    '/dev/shm/',
    'dev_shm',
    'medium',
    'traversal',
    'references shared memory (common staging area)',
  ),

  // ── Crypto mining ──
  p(
    'xmrig|stratum\\+tcp|monero|coinhive|cryptonight',
    'crypto_mining',
    'critical',
    'mining',
    'cryptocurrency mining reference',
  ),
  p(
    'hashrate|nonce.*difficulty',
    'mining_indicators',
    'medium',
    'mining',
    'possible cryptocurrency mining indicators',
  ),

  // ── Supply chain: curl/wget pipe to shell ──
  p(
    'curl\\s+[^\\n]*\\|\\s*(ba)?sh',
    'curl_pipe_shell',
    'critical',
    'supply_chain',
    'curl piped to shell (download-and-execute)',
  ),
  p(
    'wget\\s+[^\\n]*-O\\s*-\\s*\\|\\s*(ba)?sh',
    'wget_pipe_shell',
    'critical',
    'supply_chain',
    'wget piped to shell (download-and-execute)',
  ),
  p(
    'curl\\s+[^\\n]*\\|\\s*python',
    'curl_pipe_python',
    'critical',
    'supply_chain',
    'curl piped to Python interpreter',
  ),

  // ── Supply chain: unpinned/deferred dependencies ──
  p(
    '#\\s*///\\s*script.*dependencies',
    'pep723_inline_deps',
    'medium',
    'supply_chain',
    'PEP 723 inline script metadata with dependencies (verify pinning)',
  ),
  p(
    'pip\\s+install\\s+(?!-r\\s)(?!.*==)',
    'unpinned_pip_install',
    'medium',
    'supply_chain',
    'pip install without version pinning',
  ),
  p(
    'npm\\s+install\\s+(?!.*@\\d)',
    'unpinned_npm_install',
    'medium',
    'supply_chain',
    'npm install without version pinning',
  ),
  p(
    'uv\\s+run\\s+',
    'uv_run',
    'medium',
    'supply_chain',
    'uv run (may auto-install unpinned dependencies)',
  ),

  // ── Supply chain: remote resource fetching ──
  p(
    '(curl|wget|httpx?\\.get|requests\\.get|fetch)\\s*[\\(]?\\s*["\\\']https?://',
    'remote_fetch',
    'medium',
    'supply_chain',
    'fetches remote resource at runtime',
  ),
  p(
    'git\\s+clone\\s+',
    'git_clone',
    'medium',
    'supply_chain',
    'clones a git repository at runtime',
  ),
  p(
    'docker\\s+pull\\s+',
    'docker_pull',
    'medium',
    'supply_chain',
    'pulls a Docker image at runtime',
  ),

  // ── Privilege escalation ──
  p(
    '^allowed-tools\\s*:',
    'allowed_tools_field',
    'high',
    'privilege_escalation',
    'skill declares allowed-tools (pre-approves tool access)',
  ),
  p('\\bsudo\\b', 'sudo_usage', 'high', 'privilege_escalation', 'uses sudo (privilege escalation)'),
  p(
    'setuid|setgid|cap_setuid',
    'setuid_setgid',
    'critical',
    'privilege_escalation',
    'setuid/setgid (privilege escalation mechanism)',
  ),
  p(
    'NOPASSWD',
    'nopasswd_sudo',
    'critical',
    'privilege_escalation',
    'NOPASSWD sudoers entry (passwordless privilege escalation)',
  ),
  p(
    'chmod\\s+[u+]?s',
    'suid_bit',
    'critical',
    'privilege_escalation',
    'sets SUID/SGID bit on a file',
  ),

  // ── Agent config persistence ──
  p(
    'AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules',
    'agent_config_mod',
    'critical',
    'persistence',
    'references agent config files (could persist malicious instructions across sessions)',
  ),
  p(
    '\\.hermes/config\\.yaml|\\.hermes/SOUL\\.md',
    'hermes_config_mod',
    'critical',
    'persistence',
    'references Hermes configuration files directly',
  ),
  p(
    '\\.claude/settings|\\.codex/config',
    'other_agent_config',
    'high',
    'persistence',
    'references other agent configuration files',
  ),

  // ── Hardcoded secrets ──
  p(
    '(?:api[_-]?key|token|secret|password)\\s*[=:]\\s*["\\\'][A-Za-z0-9+/=_-]{20,}',
    'hardcoded_secret',
    'critical',
    'credential_exposure',
    'possible hardcoded API key, token, or secret',
  ),
  p(
    '-----BEGIN\\s+(RSA\\s+)?PRIVATE\\s+KEY-----',
    'embedded_private_key',
    'critical',
    'credential_exposure',
    'embedded private key',
  ),
  p(
    'ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}',
    'github_token_leaked',
    'critical',
    'credential_exposure',
    'GitHub personal access token in skill content',
  ),
  p(
    'sk-[A-Za-z0-9]{20,}',
    'openai_key_leaked',
    'critical',
    'credential_exposure',
    'possible OpenAI API key in skill content',
  ),
  p(
    'sk-ant-[A-Za-z0-9_-]{90,}',
    'anthropic_key_leaked',
    'critical',
    'credential_exposure',
    'possible Anthropic API key in skill content',
  ),
  p(
    'AKIA[0-9A-Z]{16}',
    'aws_access_key_leaked',
    'critical',
    'credential_exposure',
    'AWS access key ID in skill content',
  ),

  // ── Additional prompt injection: jailbreak patterns ──
  p(
    '\\bDAN\\s+mode\\b|Do\\s+Anything\\s+Now',
    'jailbreak_dan',
    'critical',
    'injection',
    'DAN (Do Anything Now) jailbreak attempt',
  ),
  p(
    '\\bdeveloper\\s+mode\\b.*\\benabled?\\b',
    'jailbreak_dev_mode',
    'critical',
    'injection',
    'developer mode jailbreak attempt',
  ),
  p(
    'hypothetical\\s+scenario.*(?:ignore|bypass|override)',
    'hypothetical_bypass',
    'high',
    'injection',
    'hypothetical scenario used to bypass restrictions',
  ),
  p(
    'for\\s+educational\\s+purposes?\\s+only',
    'educational_pretext',
    'medium',
    'injection',
    'educational pretext often used to justify harmful content',
  ),
  p(
    '(respond|answer|reply)\\s+without\\s+(?:\\w+\\s+)*(restrictions|limitations|filters|safety)',
    'remove_filters',
    'critical',
    'injection',
    'instructs agent to respond without safety filters',
  ),
  p(
    'you\\s+have\\s+been\\s+(?:\\w+\\s+)*(updated|upgraded|patched)\\s+to',
    'fake_update',
    'high',
    'injection',
    'fake update/patch announcement (social engineering)',
  ),
  p(
    'new\\s+policy|updated\\s+guidelines|revised\\s+instructions',
    'fake_policy',
    'medium',
    'injection',
    'claims new policy/guidelines (may be social engineering)',
  ),

  // ── Context window exfiltration ──
  p(
    '(include|output|print|send|share)\\s+(?:\\w+\\s+)*(conversation|chat\\s+history|previous\\s+messages|context)',
    'context_exfil',
    'high',
    'exfiltration',
    'instructs agent to output/share conversation history',
  ),
  p(
    '(send|post|upload|transmit)\\s+.*\\s+(to|at)\\s+https?://',
    'send_to_url',
    'high',
    'exfiltration',
    'instructs agent to send data to a URL',
  ),
];

/**
 * Structural limits for skill directories. Identical to the Hermes constants
 * `MAX_FILE_COUNT`, `MAX_TOTAL_SIZE_KB`, `MAX_SINGLE_FILE_KB`.
 */
export const STRUCTURAL_LIMITS = {
  /** Skills shouldn't have 50+ files. */
  maxFileCount: 50,
  /** 1 MB total is suspicious for a skill. */
  maxTotalSizeKb: 1024,
  /** Individual file > 256 KB is suspicious. */
  maxSingleFileKb: 256,
} as const;

/**
 * Text-file extensions the scanner inspects. Other suffixes are skipped so
 * binary blobs never blow up the regex engine.
 */
export const SCANNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.txt',
  '.py',
  '.sh',
  '.bash',
  '.js',
  '.ts',
  '.rb',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.cfg',
  '.ini',
  '.conf',
  '.html',
  '.css',
  '.xml',
  '.tex',
  '.r',
  '.jl',
  '.pl',
  '.php',
]);

/**
 * File extensions that should never be present inside a skill bundle.
 * Triggers a `binary_file` finding when encountered.
 */
export const SUSPICIOUS_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.com',
  '.msi',
  '.dmg',
  '.app',
  '.deb',
  '.rpm',
]);

/**
 * Zero-width and bi-di unicode characters that have been used to smuggle
 * hidden instructions into otherwise innocuous-looking skill markdown.
 *
 * Same set as `INVISIBLE_CHARS` in `skills_guard.py`.
 */
export const INVISIBLE_CHARS: ReadonlyArray<{ char: string; name: string }> = [
  { char: '​', name: 'zero-width space' },
  { char: '‌', name: 'zero-width non-joiner' },
  { char: '‍', name: 'zero-width joiner' },
  { char: '⁠', name: 'word joiner' },
  { char: '⁢', name: 'invisible times' },
  { char: '⁣', name: 'invisible separator' },
  { char: '⁤', name: 'invisible plus' },
  { char: '﻿', name: 'BOM/zero-width no-break space' },
  { char: '‪', name: 'LTR embedding' },
  { char: '‫', name: 'RTL embedding' },
  { char: '‬', name: 'pop directional' },
  { char: '‭', name: 'LTR override' },
  { char: '‮', name: 'RTL override' },
  { char: '⁦', name: 'LTR isolate' },
  { char: '⁧', name: 'RTL isolate' },
  { char: '⁨', name: 'first strong isolate' },
  { char: '⁩', name: 'pop directional isolate' },
];
