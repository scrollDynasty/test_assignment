# Iteration demo: publish v3 without redeploy, keep old sessions, roll back

> **Что это.** Отчёт команды `npm run demo:iteration -- --config funnel-v3.json --traffic 150` на том же
> production-образе и той же базе, что итерация 1. Сценарий: публикация v3 (новая ветка, шаг убран у варианта B, новое
> событие) без ручной правки схемы БД → старая сессия v1 доходит до результата по правилам v1 → трафик → откат v3 → v1,
> и сессия, начатая на v3 до отката, заканчивает на v3; отпечаток схемы до и после одинаковый, аналитика v1–v3 на
> месте. ✅ — автоматическая проверка.

Instance: http://localhost:8090 · 2026-09-18T11:19:03.405Z

Active version before: v1. Schema fingerprint: 2165016e63d28352eee109b743575bbf6ebda07fea6d4a7d47381ff11d78d79d
✅ old session starts on the active version — session 9e32cc4d on v1, variant A, at "priorities"
✅ v3 published at runtime — upload: created, active now v3
✅ schema unchanged by publish — fingerprint equal
✅ new session starts on the new version — v3, 10 steps in variant B
✅ old session still pinned after publish — reloaded: v1, still at "priorities"
✅ old session finishes on its own version — result "balanced" computed with v1 rules

— generating 150 synthetic sessions (npm run traffic) —
✅ synthetic traffic accepted and dashboard matches its ground truth — 150 sessions, --verify OK
✅ rollback restores the previous version for new sessions — v3 → v1
✅ session started before rollback finishes on its version — result "meeting_heavy" on v3
✅ new session after rollback starts on the old version — v1
✅ schema unchanged after publish + rollback — 2165016e63d28352eee109b743575bbf6ebda07fea6d4a7d47381ff11d78d79d
✅ analytics of v1 kept (started never decreases) — started 153 → 155, reached result 73 → 75
✅ analytics of v2 kept (started never decreases) — started 152 → 152, reached result 63 → 63
✅ analytics of v3 present after rollback — started 152, reached result 76
✅ v3 variant A: analytics steps follow the config — intro › team_size › work_mode › priorities › security_constraints › timezone_span › office_days › meeting_hours › async_maturity › tool_count › result
✅ v3 variant B: analytics steps follow the config — intro › work_mode › meeting_hours › timezone_span › team_size › async_maturity › priorities › security_constraints › office_days › result
✅ new event "recommendation_expanded" collected for v3 — 47 sessions ({"A":15,"B":32})
✅ new event "recommendation_expanded" absent from v1 — none — older sessions never send it
✅ v1: drop-offs + reached + in progress = started (every variant) — holds
✅ v3: drop-offs + reached + in progress = started (every variant) — holds

ALL CHECKS PASSED (20 checks)
