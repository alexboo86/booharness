# .claude/hooks — retired

Все хук-скрипты этого каталога сняты 2026-07-28 (партия 3 аудита контракта):
ни один не был подключён ни в одном settings-файле, их работу несут RTK
(PreToolUse → нативный `rtk hook claude`, поставленный `rtk init`), `npm run
check:commit` / `check:push` / `check:deletions` и `.githooks/*`.

Каталог сохранён: его оверлеят `start-worktree.sh` и сканирует
`scripts/audit-rule-sensors.mjs` (not in this kit) (dormant-hook отчёт). Новый хук добавляй
только вместе с записью в settings и строкой в
[docs/agent/harness-allowlist.md](../../docs/agent/harness-allowlist.md).

Бывший `provision-worktree-codeintel.sh` не удалён, а переехал в
`ops/bootstrap/` и подключён через `session-start.mjs` (сид `.codegraph`
в worktree из главного чекаута).
