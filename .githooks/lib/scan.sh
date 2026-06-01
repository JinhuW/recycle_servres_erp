#!/usr/bin/env bash
# Shared scan helpers for the git hooks in ../. Sourced, never executed directly.
# No external dependencies — pure git + grep so a fresh clone needs no install.

# Git's well-known empty-tree object; a valid diff base when nothing better exists.
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904

c_red() { printf '\033[1;31m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[1;33m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_dim() { printf '\033[2m%s\033[0m\n'   "$*"; }

# emit_added <diff-selector...>
# Prints "<file>\t<added-line>" for every added (+) line in changed text files.
# Selector is e.g. `--cached` (staged) or `<base> <tip>` (a push range).
emit_added() {
  local f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    git diff -U0 "$@" -- "$f" 2>/dev/null \
      | { grep -E '^\+[^+]' || true; } \
      | sed 's/^\+//' \
      | while IFS= read -r content; do
          printf '%s\t%s\n' "$f" "$content"
        done
  done < <(git diff --name-only --diff-filter=ACM "$@" 2>/dev/null)
}

# Detection patterns (matched case-insensitively). The last, generic
# KEYWORD=value rule is the noisy one; _SCAN_ALLOW below filters its placeholders.
_SECRET_RES=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'A(KIA|SIA)[0-9A-Z]{16}'
  '\bsk-[A-Za-z0-9]{20,}'
  '\bxox[baprs]-[A-Za-z0-9-]{10,}'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
  '(SECRET|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+_.=-]{12,}'
)
# Lines that look like a secret but are dev defaults / placeholders / env refs.
_SCAN_ALLOW='change[-_ ]?me|example|placeholder|dummy|sample|redacted|your[-_]|xxxx|fake|process\.env|import\.meta\.env|\$\{|<[A-Za-z_]|dev-[a-z]|test[-_][a-z]'

# scan_secrets — reads emit_added output on stdin; returns 1 if any secret found.
scan_secrets() {
  local violations=0 file content re
  while IFS=$'\t' read -r file content; do
    case "$file" in .githooks/*) continue ;; esac          # don't flag our own regexes
    case "$content" in *"pragma: allowlist secret"*|*"gitleaks:allow"*) continue ;; esac
    printf '%s' "$content" | grep -Eiq -e "$_SCAN_ALLOW" && continue
    for re in "${_SECRET_RES[@]}"; do
      if printf '%s' "$content" | grep -Eiq -e "$re"; then
        c_red "  ✗ possible secret — $file"
        c_dim "      ${content:0:100}"
        violations=$((violations + 1))
        break
      fi
    done
  done
  [ "$violations" -gt 0 ] && return 1 || return 0
}

# High-signal dangerous-code patterns (command injection, raw SQL, XSS sink,
# TLS bypass). Kept tight to stay low-false-positive; mark reviewed lines `nosec`.
_STATIC_CODE_RE='\.(ts|tsx|js|jsx|mjs|cjs|sql)$'
_STATIC_RES=(
  '\beval[[:space:]]*\('
  '\bnew[[:space:]]+Function[[:space:]]*\('
  '\.unsafe[[:space:]]*\('
  'dangerouslySetInnerHTML'
  'NODE_TLS_REJECT_UNAUTHORIZED[[:space:]]*=[[:space:]]*["'"'"']?0'
  '\bexec(Sync)?[[:space:]]*\([^)]*`[^`]*\$\{'
)

# scan_static — reads emit_added output on stdin; returns 1 if a risky pattern found.
scan_static() {
  local violations=0 file content re
  while IFS=$'\t' read -r file content; do
    case "$file" in .githooks/*) continue ;; esac
    printf '%s\n' "$file" | grep -Eq -e "$_STATIC_CODE_RE" || continue
    case "$content" in *"nosec"*) continue ;; esac
    for re in "${_STATIC_RES[@]}"; do
      if printf '%s' "$content" | grep -Eq -e "$re"; then
        c_red "  ✗ risky pattern — $file"
        c_dim "      ${content:0:100}"
        violations=$((violations + 1))
        break
      fi
    done
  done
  [ "$violations" -gt 0 ] && return 1 || return 0
}
