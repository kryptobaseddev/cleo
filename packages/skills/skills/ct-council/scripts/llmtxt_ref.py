#!/usr/bin/env python3
"""
llmtxt_ref.py — fetch an llmtxt overview for use as a Council evidence-pack item.

The llmtxt.my service provides progressive-disclosure document overviews that
compress long external docs (library refs, API specs, ADRs) into 60–80% fewer
tokens, letting the Council ground in external material without blowing out the
evidence pack when five advisor subagents each receive it.

Usage:
  llmtxt_ref.py <slug>[@<version>]
  llmtxt_ref.py <slug> --no-cache
  llmtxt_ref.py <slug> --json
  llmtxt_ref.py <slug> --raw       # suppress the evidence-pack header

Output (stdout):
  Markdown-formatted overview, ready to paste into a Phase 0 evidence pack.

Auth:
  Public documents: no auth required (anonymous mode handled server-side).
  Private/org documents: set LLMTXT_API_KEY (Bearer token, prefix 'llmtxt_').

Rate limits (anonymous, per-IP): 60 reads/min. The wrapper honors
  x-ratelimit-remaining / x-ratelimit-reset / retry-after headers and surfaces
  warnings on stderr.

Cache:
  ~/.cache/council/llmtxt/<slug>/<version>.md   (immutable — indefinite)
  ~/.cache/council/llmtxt/<slug>/_latest.md     (60s TTL)

Override cache location with COUNCIL_CACHE_DIR; override API base with
LLMTXT_API_BASE (default: https://api.llmtxt.my).

Exit codes:
  0 — success, overview printed
  1 — network / service error
  2 — not found (404) or not accessible without auth
  3 — invalid slug format / usage error
"""

from __future__ import annotations

import argparse
import http.cookiejar as cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API_BASE = os.environ.get("LLMTXT_API_BASE", "https://api.llmtxt.my")
CACHE_DIR = Path(os.environ.get(
    "COUNCIL_CACHE_DIR",
    str(Path.home() / ".cache" / "council" / "llmtxt"),
))
COOKIE_JAR_PATH = CACHE_DIR.parent / "cookies.txt"
LATEST_TTL_SECONDS = 60
TIMEOUT = 30

SLUG_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")


def parse_ref(ref: str) -> tuple[str, str | None]:
    """Parse a <slug> or <slug>@<version> reference. Raises ValueError on malformed slug."""
    if "@" in ref:
        slug, version = ref.split("@", 1)
        if not version:
            raise ValueError(f"Empty version in reference: {ref!r}")
    else:
        slug, version = ref, None
    if not SLUG_PATTERN.match(slug):
        raise ValueError(
            f"Invalid slug format: {slug!r}. "
            "Expected lowercase alphanumeric with dashes, 1–64 chars, no leading/trailing dash."
        )
    return slug, version


def cache_path(slug: str, version: str | None) -> Path:
    """Return the cache path for (slug, version). No filesystem side effects."""
    if version:
        # Sanitize version for filename safety without altering the slug.
        safe_version = re.sub(r"[^a-zA-Z0-9._-]", "_", version)
        return CACHE_DIR / slug / f"{safe_version}.md"
    return CACHE_DIR / slug / "_latest.md"


def cache_is_fresh(path: Path, immutable: bool) -> bool:
    """True if the cached file exists and (if mutable) is newer than LATEST_TTL_SECONDS."""
    if not path.exists():
        return False
    if immutable:
        return True
    age = time.time() - path.stat().st_mtime
    return age < LATEST_TTL_SECONDS


def _build_opener() -> urllib.request.OpenerDirector:
    """Build a URL opener with persistent cookie jar so anonymous sessions survive invocations."""
    jar = cookiejar.MozillaCookieJar(str(COOKIE_JAR_PATH))
    if COOKIE_JAR_PATH.exists():
        try:
            jar.load(ignore_discard=True)
        except Exception:
            # Corrupt cookie file — ignore and overwrite on next save.
            pass
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return opener


def _save_cookies(opener: urllib.request.OpenerDirector) -> None:
    for handler in opener.handlers:
        if isinstance(handler, urllib.request.HTTPCookieProcessor):
            jar = handler.cookiejar
            if isinstance(jar, cookiejar.MozillaCookieJar):
                COOKIE_JAR_PATH.parent.mkdir(parents=True, exist_ok=True)
                try:
                    jar.save(ignore_discard=True)
                except Exception:
                    pass
            return


def fetch_overview(slug: str, version: str | None, timeout: int = TIMEOUT) -> str:
    """Fetch overview from api.llmtxt.my. Raises LookupError for 404, RuntimeError otherwise.

    Uses a persistent cookie jar so anonymous sessions (better-auth anonymous plugin,
    24h TTL) survive across invocations. For private/org documents, set LLMTXT_API_KEY.
    """
    url = f"{API_BASE}/api/documents/{slug}/overview"
    if version:
        url += f"?version={version}"
    req = urllib.request.Request(url, headers={"User-Agent": "council-skill/1.0"})
    api_key = os.environ.get("LLMTXT_API_KEY")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")

    opener = _build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            remaining = resp.headers.get("x-ratelimit-remaining")
            if remaining and remaining.isdigit() and int(remaining) == 0:
                reset = resp.headers.get("x-ratelimit-reset", "unknown")
                print(f"⚠️  llmtxt rate limit exhausted; resets at {reset}.", file=sys.stderr)
            _save_cookies(opener)
            return body
    except urllib.error.HTTPError as e:
        # Even on error, the server may have set an anonymous session cookie.
        _save_cookies(opener)
        if e.code == 404:
            raise LookupError(f"Document not found or not accessible: {slug}") from e
        if e.code == 429:
            try:
                payload = json.loads(e.read().decode("utf-8"))
                retry = payload.get("retryAfter", e.headers.get("retry-after", "unknown"))
            except Exception:
                retry = e.headers.get("retry-after", "unknown")
            raise RuntimeError(f"Rate limited by api.llmtxt.my; retry after {retry}s") from e
        if e.code in (401, 403):
            raise RuntimeError(
                f"HTTP {e.code}: {e.reason}. "
                "Document requires auth — set LLMTXT_API_KEY (Bearer llmtxt_<43-char-token>)."
            ) from e
        raise RuntimeError(f"HTTP {e.code}: {e.reason}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}") from e


def get_overview(slug: str, version: str | None = None, use_cache: bool = True) -> str:
    """Cache-aware read. Returns the overview body as markdown."""
    path = cache_path(slug, version)
    immutable = version is not None
    if use_cache and cache_is_fresh(path, immutable):
        return path.read_text()
    body = fetch_overview(slug, version)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    return body


def format_for_evidence_pack(slug: str, version: str | None, body: str) -> str:
    """Wrap the overview body with an evidence-pack-friendly header."""
    ref = f"llmtxt:{slug}" + (f"@{version}" if version else "")
    return f"<!-- evidence-pack item: `{ref}` -->\n\n{body.rstrip()}\n"


def main():
    parser = argparse.ArgumentParser(
        description="Fetch an llmtxt overview for a Council evidence pack.",
    )
    parser.add_argument("ref", help="Document reference: <slug> or <slug>@<version>")
    parser.add_argument("--no-cache", action="store_true", help="Bypass the local cache.")
    parser.add_argument("--json", action="store_true", help="Emit the raw API response.")
    parser.add_argument("--raw", action="store_true", help="Suppress the evidence-pack header.")
    args = parser.parse_args()

    try:
        slug, version = parse_ref(args.ref)
    except ValueError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(3)

    try:
        body = get_overview(slug, version, use_cache=not args.no_cache)
    except LookupError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(2)
    except RuntimeError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(1)

    if args.json or args.raw:
        print(body)
    else:
        print(format_for_evidence_pack(slug, version, body))


if __name__ == "__main__":
    main()
