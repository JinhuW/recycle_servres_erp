#!/bin/sh
# Prove check-secrets.sh still catches a real secret, and still lets the
# committed templates through.
#
# A credential scanner that has never been watched to fail is indistinguishable
# from one that matches nothing — and the second version of check-secrets.sh
# WAS that: it missed a Playwright storage_state file entirely, because real
# session JSON nests the cookie name as the value of a "name" key and the
# pattern only knew the flat form. Hence this.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$ROOT/scripts/check-secrets.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILURES=0

ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# refuses <name> <file> — the scanner must reject this file.
refuses() {
    if sh "$CHECK" "$2" >/dev/null 2>&1; then fail "$1 (was allowed)"; else ok "$1"; fi
}

# allows <name> <file> — the scanner must accept this file.
allows() {
    if sh "$CHECK" "$2" >/dev/null 2>&1; then ok "$1"; else fail "$1 (was refused)"; fi
}

# -- things that must be refused -------------------------------------------
printf 'api_key = "sk-or-v1-9f3ab21c77de40bb91cc02e4d8a7b6f5e1c3"\n' > "$WORK/openrouter.toml"
refuses "an OpenRouter key" "$WORK/openrouter.toml"

printf 'telegram = "8123456789:AAH7xQ2vLpR3nT9kZmW4dYc8FbGh1JsKlPo"\n' > "$WORK/telegram.toml"
refuses "a Telegram bot token" "$WORK/telegram.toml"

printf 'FB_PASSWORD = "hunter2-actually-my-real-password"\n' > "$WORK/password.toml"
refuses "an assigned password" "$WORK/password.toml"

# The shape rs-session actually writes.
printf '{"cookies":[{"name":"xs","value":"42%%3AqRt8vXmZ%%3A%%3A2%%3A1755000000"}]}\n' \
    > "$WORK/storage_state.json"
refuses "a Playwright storage_state session" "$WORK/storage_state.json"

printf '{"xs": "42%%3AqRt8vXmZ%%3A%%3A2%%3A1755000000"}\n' > "$WORK/flat_cookies.json"
refuses "a flat cookie jar" "$WORK/flat_cookies.json"

# -- things that must be allowed -------------------------------------------
# Every line here is the shape of something already committed in this repo.
cat > "$WORK/fine.toml" <<'INNER'
api_key = "${OPENROUTER_API_KEY}"
password = "change-me-to-a-long-random-string"
ENV_SECRET = "RS_WORKER_TOKEN_SECRET"
vault_ref = random_password.postgres.result
demo_totp = "JBSWY3DPEHPK3PXP"
legacy = "kept-for-now-really-long-value"  # pragma: allowlist secret
INNER
allows "placeholders, env names, RFC vectors and allowlisted lines" "$WORK/fine.toml"

allows "the committed secrets.env template" "$ROOT/configs/secrets.env.example"

# The suites are full of password-shaped fixtures and must not trip it.
allows "the coordinator test suite" "$(git -C "$ROOT" ls-files 'rs_coordinator/tests/*.py' | tr '\n' ' ')"

if [ "$FAILURES" -ne 0 ]; then
    echo "$FAILURES check-secrets assertion(s) failed" >&2
    exit 1
fi
echo "  check-secrets: all assertions passed"
