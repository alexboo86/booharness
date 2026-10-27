# RTK — Rust Token Killer (справочник команды)

**Что это:** CLI-прокси, сжимающий вывод shell-команд на 60-90% ДО попадания в
контекст агента. Один Rust-бинарь, <10ms оверхеда. Установлен глобально
(`brew install rtk`, 0.43.0). Проверка: `rtk --version` / `rtk gain`.

## Как это работает у нас

- **Claude Code (лид):** глобальный PreToolUse:Bash-хук (`rtk hook claude`)
  ПРОЗРАЧНО переписывает bash-команды в `rtk <cmd>` — ничего вручную звать не надо.
  Пример: `git status` → `rtk git status`, `cargo test` → `rtk cargo test`.
- **Команда (Codex/Kimi/Grok/GLM):** хука нет — зовите `rtk` ЯВНО на тяжёлых
  read-командах (см. ниже). Это их вклад в токен-экономику при ревью/ресёрче.

## Что префиксить вручную (команда) / что хук делает сам (Claude)

```bash
rtk git status | rtk git diff | rtk git log -n 20   # компактный git
rtk cargo test | rtk pytest | rtk go test           # тесты: только фейлы (-90%)
rtk tsc --noEmit -p tsconfig.app.json               # tsc: сгруппированные ошибки
rtk grep "pattern" .   |  rtk rg "pattern" .         # поиск: сгруппировано по файлам
rtk read file.rs       |  rtk read file.rs -l aggressive  # умное чтение / только сигнатуры
rtk ls . | rtk tree | rtk find -name '*.rs'         # дерево/листинг
```

## Мета-команды (всегда напрямую)

```bash
rtk gain            # сколько токенов сэкономлено
rtk gain --graph    # ASCII-график за 30 дней
rtk discover        # упущенные возможности (скан истории Claude Code)
rtk proxy <cmd>     # RAW-выполнение БЕЗ фильтрации (для дебага/точного вывода)
```

## Безопасность (важно — не ломать)

Хук префиксит и мутирующие команды (`git commit`/`git push`), НО наши guard'ы
захаржены под `rtk `:
- `git-commit-guard.sh` — pathspec-дисциплина цела и на `rtk git commit`
  (bare/`-a`/`--amend`/`git add -A` блокируются).
- `branch-guard.sh` — force-push блок цел и на `rtk git push --force`.
- `deploy-gate`/`secret-guard`/`destructive-guard` — rtk deploy.sh/rm не трогает,
  видят raw-строку → не задеты.

Коммит-дисциплина без изменений: явный pathspec `git commit -m "..." -- <пути>`,
`git commit -F msgfile` при спецсимволах. RAW-выхлоп при нужде: `rtk proxy <cmd>`.

## Откат

```bash
rtk init -g --uninstall     # снять глобальный хук Claude
# бэкапы settings.json: ~/.claude/settings.json.pre-rtk.bak и ...settings.json.bak
```
