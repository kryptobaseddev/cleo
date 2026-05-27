# Security Policy

## Supported Versions

Security fixes are prioritized for the latest minor release line.

## Reporting a Vulnerability

If you find a security issue:

1. Do not open a public GitHub issue.
2. Report privately through GitHub Security Advisories for this repository.
3. Include:
   - affected command or API surface
   - reproduction steps
   - potential impact
   - suggested mitigation (if available)

## Response Targets

- Initial triage: within 3 business days.
- Risk classification and remediation plan: within 7 business days.

## Disclosure Process

- We validate and reproduce the issue.
- We prepare and test a fix.
- We publish a patched release and advisory.
- We credit reporters unless anonymity is requested.

## Scope

This includes:

- CLI command execution and output contracts
- provider config mutation paths
- lock file handling and filesystem writes
- dependency and CI pipeline integrity
