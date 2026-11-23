# Argument parsing for release.sh, sourced by it and by
# scripts/tests/test-release-args.sh, so the test never runs a release.
#
# --dry-run is honoured wherever it appears. Anything else that is not the one
# bump argument fails: when the flag was only read in first position,
# `release.sh patch --dry-run` dropped it without a word and cut a real
# release, commit and tag.

# parse_release_args <args...> — set DRY and BUMP, or print why not and
# return 2.
parse_release_args() {
    DRY=""
    BUMP=""
    for arg in "$@"; do
        case "$arg" in
            --dry-run) DRY=1 ;;
            -*)
                echo "error: unknown option '$arg'" >&2
                release_usage
                return 2
                ;;
            *)
                if [ -n "$BUMP" ]; then
                    echo "error: one bump argument only, got '$BUMP' and '$arg'" >&2
                    release_usage
                    return 2
                fi
                BUMP="$arg"
                ;;
        esac
    done
    if [ -z "$BUMP" ]; then
        release_usage
        return 2
    fi
}

release_usage() {
    echo "usage: release.sh [--dry-run] <major|minor|patch|X.Y.Z>" >&2
}
