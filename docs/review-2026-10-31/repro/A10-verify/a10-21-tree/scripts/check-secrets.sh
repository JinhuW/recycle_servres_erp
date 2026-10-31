#!/bin/sh
# Refuse to let a live credential reach a commit.
#
#   scripts/check-secrets.sh            # scan what git would commit
#   scripts/check-secrets.sh --all      # scan every tracked file too
#
# This tree sits next to real ones: a Facebook session that costs a human login
# with a 2FA code, the vault key that decrypts every account in the fleet, and
# bearer tokens for the coordinator. .gitignore already excludes all of them,
# but .gitignore only protects a path nobody force-adds and nobody renames, and
# a secret in a git history is not something you quietly take back out.
#
# Two independent checks, because they fail differently:
#   1. Paths that must never be tracked, whatever they are named.
#   2. Content that looks like a real secret, wherever it turns up.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STATUS=0

# What to scan: the staged set by default, every tracked file with --all, or
# exactly the paths given. The explicit form is what the drill in
# scripts/tests/test-check-secrets.sh uses to prove this still catches a real secret —
# a scanner is only worth having if someone has watched it fail.
case "${1:-}" in
    --all)  FILES=$(git ls-files); shift ;;
    # --relative: this tree is trackers/facebook/ in the ERP monorepo, and the
    # path rules below are written relative to it.
    "")     FILES=$(git diff --cached --name-only --relative --diff-filter=ACMR) ;;
    -*)     echo "usage: $0 [--all | <file>...]" >&2; exit 2 ;;
    *)      FILES="$*" ;;
esac
[ -n "$FILES" ] || { echo "  nothing staged; nothing to check"; exit 0; }

# -- 1. paths ---------------------------------------------------------------
for f in $FILES; do
    case "$f" in
        configs/secrets.env.example) ;;   # the template, and it holds no values
        configs/secrets.env|configs/secrets.env.*|configs/sessions/*|*.meta.json|\
        cookies.txt|cookies.json|fb_state*.json|*.pem|*.key|*.db|*.sqlite*)
            echo "  REFUSED: $f is a credential path and must never be tracked" >&2
            STATUS=1
            ;;
    esac
done

# -- 2. content -------------------------------------------------------------
# Shapes, not a wordlist: a name like FB_PASSWORD next to an actual value, and
# the fixed prefixes of the token formats this project handles.
#
# Test fixtures are excluded. A suite needs a password-shaped string on every
# other line, and a scanner that cries wolf on all of them is one people learn
# to pass with --no-verify — which is worse than not having it. Real secrets do
# not live in tests; they live in configs, scripts and deploy files, which is
# what is scanned.
SCAN_FILES=$(printf '%s\n' $FILES \
    | grep -vE '(^|/)tests?/|(^|/)test_[^/]*\.py$|(^|/)conftest\.py$' || true)

# Deliberate exceptions, all of them public:
#   JBSWY3DPEHPK3PXP / GEZDG... — the pyotp and RFC 6238 example secrets.
#   pragma: allowlist secret    — an explicit, greppable opt-out for a line a
#                                 human has looked at and vouched for.
ALLOWED='pragma: allowlist secret|JBSWY3DPEHPK3PXP|GEZDGNBVGY3TQOJQ'
# A quoted ALL_CAPS token is the NAME of a secret, not one.
ENV_NAME='[=:][[:space:]]*["'"'"'][A-Z][A-Z0-9_]+["'"'"']'
# Placeholders the committed templates and docs are full of.
PLACEHOLDER='\$\{[A-Za-z_]|change-me|xxxxx|placeholder|<[a-z-]+>|\.\.\.|example\.com|your-|sk-or-v1-\.'

scan() {
    [ -n "$SCAN_FILES" ] || return 0
    grep -nEI "$1" $SCAN_FILES 2>/dev/null \
        | grep -vE "$ALLOWED" \
        | grep -vE "$PLACEHOLDER" \
        | grep -vE "$ENV_NAME" \
        || true
}

report() {
    found=$(scan "$2")
    if [ -n "$found" ]; then
        echo "  REFUSED: $1" >&2
        echo "$found" | sed 's/^/      /' >&2
        echo "      (if this is not a real secret, append: pragma: allowlist secret)" >&2
        STATUS=1
    fi
}

# The value must be QUOTED — an unquoted right-hand side is an expression or a
# variable reference (POSTGRES_PASSWORD = random_password.postgres.result), not
# a literal — and must not itself be an ALL_CAPS env var name, which is what a
# constant holding the NAME of a secret looks like (ENV_SECRET =
# "RS_WORKER_TOKEN_SECRET").
report "an assigned password / token / secret" \
    '(PASSWORD|TOKEN|SECRET|API_KEY|VAULT_KEY)[A-Z_]*[[:space:]]*[=:][[:space:]]*["'"'"'][^"'"'"']{16,}["'"'"']'
report "an OpenRouter / OpenAI key" 'sk-(or-v1-|proj-)?[A-Za-z0-9]{20,}'
report "a Telegram bot token" '[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}'
# Both spellings. Playwright's storage_state nests the cookie name as the VALUE
# of a "name" key — {"name": "xs", "value": "..."} — which the flat form below
# does not match at all; that is how a session file slipped past the first
# version of this check.
report "a Facebook session cookie (storage_state form)" \
    '"name"[[:space:]]*:[[:space:]]*"(xs|c_user|datr)"'
report "a Facebook session cookie" '"(xs|c_user|datr)"[[:space:]]*:[[:space:]]*"[^"]{8,}'

[ "$STATUS" -eq 0 ] && echo "  no credentials in $(printf '%s\n' $FILES | wc -l | tr -d ' ') file(s)"
exit $STATUS
