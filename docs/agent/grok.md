# Grok CLI (xAI) — консультант и кодер команды

Grok CLI — coding-агент от xAI (локально 1.0.30). В команде — **четвёртый
внешний ревьюер/кодер** рядом с Codex/Kimi/GLM: сильный кодер + самый большой контекст в панели (500K)
+ свежий веб (X/поиск). Есть профиль Paseo `lead-grok`; как консультант/кодер он не подменяет лида, который загрузил `paseo-team`.

## Установка / окружение (эта машина, verified 2026-07-15)
- Бинарь: `~/.grok/bin/grok` / `grok` в PATH (1.0.30); Windows-обёртка также проверяет `~/.grok/bin/grok.exe`.
  Обёртка `.claude/scripts/grok.sh` резолвит сама (PATH → `~/.grok/bin/`). Установка: `https://x.ai/cli`.
- Auth: **OIDC-сессия grok.com** в `~/.grok/auth.json` (подписка SuperGrok, флэт-квота — НЕ metered xAI API).
  Протухла → интерактивно `grok login`. Альтернатива для API-billing: env `XAI_API_KEY` (НЕ наш путь).
- Конфиг: `~/.grok/config.toml` (user) / `.grok/settings.json` (project). `grok inspect` — что он видит
  (skills/plugins/hooks/MCP подхватывает из репо сам, включая AGENTS.md).

## Модели (кэш `~/.grok/models_cache.json`)
| id | ctx | что это |
|---|---|---|
| `grok-4.6` | | основной coding-агент — ДЕФОЛТ CLI (`~/.grok/config.toml` `models.default`) и профилей Paseo |
| `grok-4.5` | **500K** | ещё в `models_cache.json`; обёртка `.claude/scripts/grok.sh` по-прежнему пинит его |
| `grok-composer-2.5-fast` | 200K | Cursor Composer — быстрые bounded-правки |

`grok-4.6` — дефолт CLI (`default_reasoning_effort = xhigh`). `grok-4.5` поддерживает `low|medium|high`; `high` — максимум и обёртка фиксирует его явно через
`--reasoning-effort high`. Composer не поддерживает effort-флаг и работает на своём нативном режиме.

## Канонический вызов (наш путь — через обёртку)
```bash
# read/review/research консульт И write-режим (full access, авто-аппрув):
BRIEF="$(rtk cat .grok_brief.md)"; bash .claude/scripts/grok.sh -p "$BRIEF" > .grok_verdict.md 2>&1
# модель побыстрее для bounded-правок:
GROK_MODEL=grok-composer-2.5-fast bash .claude/scripts/grok.sh -p "..."
```
Обёртка = `grok -m grok-4.5 --reasoning-effort high --always-approve -p "<prompt>"` + резолв бинаря + evidence-token для fleet
(тот же контракт, что glm.sh: токен пишется только при exit 0 + маркер `AGENT_FLEET_REPORT_JSON`).

Полезные сырые флаги (проходят сквозь обёртку после `-p "..."`):
- `--output-format json|streaming-json` — структурный вывод; `--json-schema '{...}'` — форс-схема.
- `--worktree [имя]` / `--worktree-ref <ref>` — писать в отдельном git-worktree (наша worktree-дисциплина).
- `--max-turns N`, `--check` (self-verify loop), `--best-of-n N` (N параллельных попыток, headless).
- `--agents` / `--no-subagents` — native Grok subagents поддержаны и по умолчанию включены. Каждый child
  получает RTK + anti-recursion + evidence-контракт; если будущий runtime уберёт capability, явно работаем
  последовательно без имитации параллельности.
- `grok agent stdio|serve` — программный ACP-режим (для интеграций, не для консультов).

## Гочи (verified 2026-07-08)
1. **PATH**: `command -v grok` пуст в наших шеллах — только через обёртку или полный путь.
2. **MCP-шум в stderr**: `ERROR Failed to spawn MCP server 'telegram': program not found` — grok
   подхватывает MCP-конфиг хоста и не может поднять часть серверов. Безвредно, ран продолжается;
   не парсить stderr как фейл.
3. **`-p` завершается чисто** (в отличие от `kimi -p`) — обёртка-поллер не нужна, `TaskOutput block:true` ок.
4. Промпт-структура — как для Codex (docs/agent/codex.md §«Структура промпта»): контекст 1-2 строки →
   находки `file:line` → гипотеза/контракт → номерные вопросы → «terse, <450 words». Полный доступ к репо
   у него есть — большие куски кода inline не нужны, но анти-рекурсивную преамбулу (никакого nested orchestration из worker) ставить ОБЯЗАТЕЛЬНО.
5. **Недоверенная папка = НИ ОДНОГО MCP-сервера, молча** (замерено 2026-09-17, grok 1.0.34, Windows).
   Без записи о папке в `~/.grok/trusted_folders.toml` сессия в чекауте пишет в debug-лог
   `folder untrusted: skipping repo-local (project-scoped) MCP server` на каждый сервер из `.mcp.json`,
   а пользовательские копии из `~/.grok/config.toml` несут ТЕ ЖЕ четыре имени и проигрывают слияние
   только что выброшенным записям. Итог: место стартует без серверов и на вопрос отвечает «none».
   На маке доверие выдано интерактивным ответом давным-давно, место Paseo такого вопроса не видит
   никогда — поэтому решение пишет установщик (`installGrokFolderTrust` в
   `ops/bootstrap/install-harness.mjs`), а не рука. Ключ таблицы — строка TOML: на Windows каждый
   обратный слэш УДВОЕН (`[folders."D:\\Terminal\\desktop"]`); одиночный `\T` — недопустимый
   escape, grok проглатывает ошибку разбора и место снова без серверов. Диагностика — только живым
   перечислением из самого места плюс `grok --debug --debug-file <file>`; `grok inspect` показывает
   все четыре сервера и в сломанном случае тоже.

## Лимиты / квота (SuperGrok) — МЕСЯЧНЫЕ кредиты
- Подписка оператора: **SuperGrok** (флэт). Квота = **кредиты на календарный месяц** (не 5h/7d!).
- **`~/.grok/auth.json` (grok 1.0.x, measured 2026-09-14):** один top-level ключ вида
  `https://auth.x.ai::<uuid>`. Bearer — вложенное поле `key` (string), не top-level
  `token`. Соседние поля той же записи: `auth_mode`, `refresh_token`, `expires_at`,
  `oidc_issuer`. Значения не печатать.
- **Эндпоинт жив (verified 2026-09-14, HTTP 200):**
  `GET https://cli-chat-proxy.grok.com/v1/billing` с `Authorization: Bearer <key>`.
  Тело: `{config: {monthlyLimit: {val}, used: {val}, onDemandCap: {val},
  billingPeriodStart, billingPeriodEnd, history[]}}`. Это то, что показывает
  TUI `/usage` (алиас `/cost`). `grok usage <session-id>` — другое: пер-сессионные
  токены на диске, не месячная квота.
- **One-liner (печатает used/limit, токен не эхоится):**
  ```bash
  python3 -c 'import json,os,urllib.request; d=json.load(open(os.path.expanduser("~/.grok/auth.json"))); rec=next(v for k,v in d.items() if str(k).startswith("https://auth.x.ai::")); req=urllib.request.Request("https://cli-chat-proxy.grok.com/v1/billing", headers={"Authorization":"Bearer "+rec["key"]}); c=json.load(urllib.request.urlopen(req))["config"]; print("used %s / %s" % (c["used"]["val"], c["monthlyLimit"]["val"]))'
  ```
  Эндпоинт READ-ONLY; `auth.json` не переписывать. CLI сам освежает `key` при
  использовании. Если 401 — сначала `grok login`, потом повторить чтение.
  Measured 2026-09-14: HTTP 200, schema as above, но `monthlyLimit.val` /
  `used.val` / `onDemandCap.val` все 0 (и `history[]` за июнь–август тоже).
  Соседние пути `/v1/usage`, `/v1/quota`, `/v1/credits` — 404. Если one-liner
  печатает `used 0 / 0`, это ответ сервера, а не протухший токен; человеческий
  остаток квоты смотри в TUI `/usage`.
- **agtop-overlay** рисует по нему честный `mo N% + резет` (провайдер `grok`, disk-cache 5min TTL).
- Если billing token недоступен, статус квоты считается неизвестным; локальные token windows не выдаются
  за billing truth.
- Если Grok начал отвечать 429/`credits`/`usage_pool_exhausted` — зафиксируй точный capacity blocker. Не подменяй Grok другим runtime автоматически; дальнейший reviewer выбирает top-level лид в отдельном явном решении.

## Роль в команде
Grok — второй сильный кодер/reviewer с большим контекстом и свежестью веба
(X/новости/новые API). Локального roster/dispatcher в репозитории нет;
кросс-модельная оркестрация — через Paseo (Svod снят 2026-09-14).
