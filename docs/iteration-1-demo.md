# Iteration demo: publish v2 without redeploy, keep old sessions, roll back
Instance: http://localhost:8090 · 2026-09-18T11:09:59.500Z

Active version before: v1. Schema fingerprint: 2165016e63d28352eee109b743575bbf6ebda07fea6d4a7d47381ff11d78d79d
✅ old session starts on the active version — session 6ba62c42 on v1, variant A, at "priorities"
✅ v2 published at runtime — upload: created, active now v2
✅ schema unchanged by publish — fingerprint equal
✅ new session starts on the new version — v2, 10 steps in variant A
✅ old session still pinned after publish — reloaded: v1, still at "priorities"
✅ old session finishes on its own version — result "balanced" computed with v1 rules

— generating 150 synthetic sessions (npm run traffic) —
✅ synthetic traffic accepted and dashboard matches its ground truth — 150 sessions, --verify OK
✅ rollback restores the previous version for new sessions — v2 → v1
✅ session started before rollback finishes on its version — result "meeting_heavy" on v2
✅ new session after rollback starts on the old version — v1
✅ schema unchanged after publish + rollback — 2165016e63d28352eee109b743575bbf6ebda07fea6d4a7d47381ff11d78d79d
✅ analytics of v1 kept (started never decreases) — started 150 → 152, reached result 71 → 73
✅ analytics of v2 present after rollback — started 152, reached result 63
✅ v1: drop-offs + reached + in progress = started (every variant) — holds
✅ v2: drop-offs + reached + in progress = started (every variant) — holds

ALL CHECKS PASSED (15 checks)
