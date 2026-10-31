import subprocess, sys, pathlib, os
root = pathlib.Path(sys.argv[1])
M = [
 ("M1 pacer.acquire after claim", "src/loops/poll.ts",
  "  await pacer.acquire();\n\n  const claimed = await claimDueSubreddits(sql, workerId);\n  if (claimed.length === 0) return false;\n",
  "  const claimed = await claimDueSubreddits(sql, workerId);\n  if (claimed.length === 0) return false;\n  await pacer.acquire();\n", ["tests/poll.test.ts"]),
 ("M2 candidate review also when live flagged", "src/loops/evaluate.ts",
  "candidateVerdict?.isTarget\n      && !evaluation.isTarget", "candidateVerdict?.isTarget", ["tests/pipeline.test.ts"]),
 ("M3 later copy alerted while earlier copy unsent", "src/loops/notify.ts",
  "    if (copy) {\n      // Parking", "    if (false && copy) {\n      // Parking", ["tests/pipeline.test.ts"]),
 ("M4 poll never clears backoff on success", "src/loops/poll.ts",
  "  pacer.recordSuccess();\n", "", ["tests/poll.test.ts","tests/pacing.test.ts"]),
 ("M5 claimPosts ignores next_retry_at", "src/claims.ts",
  "          AND next_retry_at <= NOW()\n          AND (claimed_at IS NULL\n               OR claimed_at < NOW() - make_interval(secs => ${CLAIM_TTL_SECONDS}))\n        ORDER BY next_retry_at",
  "          AND (claimed_at IS NULL\n               OR claimed_at < NOW() - make_interval(secs => ${CLAIM_TTL_SECONDS}))\n        ORDER BY next_retry_at", ["tests/claims.test.ts","tests/pipeline.test.ts"]),
 ("M6 runner lets an iteration throw kill the loop", "src/loops/runner.ts",
  "      } catch (e) {\n", "      } catch (e) {\n        throw e;\n", ["tests"]),
 ("M7 notify drops the requiresRecipients guard", "src/loops/notify.ts",
  "if (deps.alerts.requiresRecipients && settings.telegramChatIds.length === 0)", "if (false)", ["tests/pipeline.test.ts"]),
 ("M8 dedup ignores the 72h window in SQL and pure check", "src/dedup.ts",
  "  if (Math.abs(a.postedAt.getTime() - b.postedAt.getTime()) > DUPLICATE_WINDOW_HOURS * 3600_000) {\n    return false;\n  }\n", "", ["tests/dedup.test.ts","tests/pipeline.test.ts"]),
 ("F1 fix: requeue only failed posts (should PASS)", "src/claims.ts",
  "     WHERE reddit_id = ${redditId}\n    RETURNING reddit_id", "     WHERE reddit_id = ${redditId} AND status = 'failed'\n    RETURNING reddit_id", ["tests/claims.test.ts","tests/api.test.ts"]),
]
env = dict(os.environ, TEST_DATABASE_URL="postgres://postgres:review@127.0.0.1:55691/postgres", VITEST_MAX_FORKS="2")
for name, f, old, new, tests in M:
    p = root/f; src = p.read_text()
    assert src.count(old) == 1, (name, src.count(old))
    p.write_text(src.replace(old, new))
    try:
        r = subprocess.run(["npx","vitest","run",*tests], cwd=root, env=env, capture_output=True, text=True, timeout=300)
        out = r.stdout + r.stderr
        summ = [l.strip() for l in out.splitlines() if l.strip().startswith(("Tests ","Test Files"))]
        fails = [l.strip() for l in out.splitlines() if l.strip().startswith(("×","FAIL"))][:6]
        print(f"{name}: {'SURVIVED (tests pass)' if r.returncode==0 else 'KILLED'} | {' / '.join(summ)}")
        for l in fails: print("    ", l[:200])
    finally:
        p.write_text(src)
