# Codex CLI — консультант (НЕ тимлид)

> Часть свода правил агента. Корень — [CLAUDE.md](../../CLAUDE.md).
> **Читать когда:** собираешься консультироваться с Codex / спавнить его для second opinion.
> Длинная форма правила #16 контракта оператора.

## Роль и дисциплина

Консультируйся с Codex на **любой развилке** — запускай из папки проекта, без таймаутов (он думает долго), до 10 итераций, находите вместе лучшее решение.

**НО:** Codex — твой консультант и помощник, **НЕ тимлид**. Лид — ты. Codex:
- технически может читать код (PowerShell tools), НО на Windows часто падает с `CryptUnprotectData failed` — на практике отвечает из того, что ты прислал в brief'е;
- не имеет live state приложения;
- не знает существующую инфраструктуру, если ты её не описал в промпте.

Принимать его verdict «как есть» и идти имплементировать — **ошибка**. Перед тем как принять рекомендацию:
1. **проверь её сам в коде** — Codex мог не знать (или не смочь прочитать), что половина инфраструктуры уже существует;
2. **критический анализ** — какие риски / edge cases он не учёл;
3. **добавь свои findings**, которые он не мог увидеть (model variance, reversibility, cost delta, atomic dependencies, operator preferences из handoff'ов).

При повторных раундах **отправляй конкретные excerpts кода + handoff context** в brief'е, не полагайся на sandbox-чтение. Codex полезен для архитектурных раундов, design review и sanity checks. **Финальное решение — твоё**, на основе ТВОЕГО анализа кода + его consultation.

Codex полезен не только для механики, но и для **second opinion**. Pattern: спавнить Codex в `Bash run_in_background:true` с конкретным architectural question, пока главная сессия делает implementation; Codex пишет в output-файл, ты интегрируешь советы.

## Правильный синтаксис вызова (проверено 2026-05-19)

Иначе процесс виснет навсегда или работает без web search.

```bash
# Stdin pipe (длинные промпты из файла):
rtk cat /d/Terminal/desktop/.codex_prompt.md | codex exec \
  --ignore-user-config \
  -c web_search=live \
  -c model_reasoning_effort=high \
  -o /d/Terminal/desktop/.codex_verdict.md \
  - > /d/Terminal/desktop/.codex_output.md 2>&1

# Inline (короткие):
codex exec --ignore-user-config -c web_search=live "промпт текстом" < /dev/null 2>&1 | tail -50
```

**Обязательные флаги (проверено эмпирически):**
- `-m gpt-6.1-sol` — **пин модели GPT-6.1 Sol** на effort `high`: основной воркер codex с 2026-09-29 (решение оператора; прежде `gpt-6-sol` с 2026-09-22, memory #10512, `gpt-6-astra` с 2026-09-07, до того `gpt-5.6-sol`). Через Pi 0.99.0 (провайдер `openai-codex`) модель отвечает на Mac и win, хотя её нет в каталоге Pi: Pi пишет `Model "gpt-6.1-sol" not found for provider "openai-codex". Using custom model id.` и берёт метаданные модели провайдера по умолчанию (272K). Нативный codex-cli 0.158.0 получал `400 The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.`; с 0.159.0 (обновлён на Mac и win 2026-09-29) native smoke проходит. Сам CLI по умолчанию всё ещё берёт `gpt-6-astra` (`codex app-server` `model/list`, codex-cli 0.155.1), поэтому пин **ОБЯЗАТЕЛЕН вместе с `--ignore-user-config`:** тот пропускает `config.toml`, где стоит `model = "gpt-6-sol"`, и без явного `-m` codex падает на встроенный дефолт. orch берёт sol + high сам (`ops/orchestrator/src/providers/codex.ts`).
- `--ignore-user-config` — пропускает `$CODEX_HOME/config.toml` с MCP servers. Без него Linear MCP падает с `rmcp transport: AuthRequired` И **обрывает reasoning loop** до того как codex выдаст verdict. Известная регрессия Win sandbox. **Побочка:** заодно теряется `model`/`model_reasoning_effort` из конфига → пинь их флагами (`-m gpt-6.1-sol -c model_reasoning_effort=high`).
- **Код-интеллект и `--ignore-user-config` (2026-07-14, verified live):** флаг глушит и MCP-сервер поиска. Явно выбирай code-intel инструменты (`probe`/`ast-grep`) в промпте — скрытый пользовательский конфиг не считается доступным.
- `-c web_search=live` — **ФОРСИТ live web search**. Без явного указания при `--ignore-user-config` web_search может быть disabled. Operator (2026-05-19) explicitly требует web research для архитектурных consults — без поиска Codex работает только из training data (≤ Jan 2026).
- `model_reasoning_effort=high` — **дефолт консультов по докам OpenAI (operator 2026-07-19)**. Лестница Sol (live-probe 2026-07-19): `low<medium<high<xhigh<max<ultra`, `minimal`=HTTP 400. `max`/`ultra` — по явному запросу оператора. Terra children: `default`/`worker`=`medium`, `explorer`=`high` (.codex/agents/*.toml = SSOT).
- `-o <file>` — пишет ТОЛЬКО final agent message в отдельный файл (чище чем парсить full transcript).
- `- > /d/.../.codex_output.md 2>&1` — full transcript (для debug). Stdin pipe `- ` обязателен когда prompt из файла, чтобы codex не висел на EOF.

**DO NOT use:**
- `-c features.web_search=true` — deprecated (codex >= v0.130).
- Bare `codex exec "prompt"` без `< /dev/null` — висит навсегда ожидая stdin EOF.
- Default `codex exec` без `--ignore-user-config` на Windows — Linear MCP падает.

**WRITE / coding-режим (Codex ПРАВИТ файлы — рендеры/мокапы/bounded-кодинг), проверено 2026-06-24:**
Read-only консульт выше **НЕ может писать файлы** (`--ignore-user-config` + дефолтная песочница → read-only →
`apply_patch` отклоняется). Для write-задач — **БЕЗ ПЕСОЧНИЦЫ** (оператор: никакого сандбокса для команды):
```bash
rtk cat brief.md | codex exec --ignore-user-config --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check - > out.md 2>&1
```
- `--dangerously-bypass-approvals-and-sandbox` — **ключевой флаг**: полностью выключает песочницу И approvals,
  Codex пишет в любой путь без запроса. Verified 2026-06-27 (PROOF_OK write-тест прошёл).
- `--skip-git-repo-check` — не ругаться, если cwd вне git.
- ⛔ НЕ использовать `-s workspace-write` / `-c windows.sandbox=elevated` / `--full-auto` — любой оставляет
  песочницу, а на этой машине Win-elevated-песочница ПАДАЕТ с `windows sandbox failed: CryptUnprotectData
  failed: 2148073483` → **ноль правок** (инцидент 2026-06-27, прежний «канон» был сломан). Канон write =
  строка выше. Если managed write path недоступен, остановись и сообщи точный blocker; другой execution path не подставляй. См.
  [[reference-codex-write-mode-invocation]].

**Когда `web_search=live` ОБЯЗАТЕЛЬНО (operator mandate 2026-05-19):**
- Архитектурные consultations про методологии / best practices (Wyckoff, SMC, Steidlmayer, Order Flow)
- Library / framework recommendations (current best version, deprecations)
- Verify operator's hypothesis vs canonical literature
- Любой research, где training data может быть устаревшая
- Если Codex выдаёт verdict БЕЗ ссылок на источники — он не искал, и operator не примет ответ

**Окружение:**
- **Win**: codex CLI установлен глобально, `where codex` → `<home>\AppData\Roaming\npm\codex.cmd`. Запуск из любой папки.
- **Mac**: по SSH для offload (cluster-решение 2026-06-05, см. [environment.md](environment.md)). _Примечание: в старом codex-блоке стояло «Codex local-only»; cluster-doc 2026-06-05 новее и явно разрешает Mac offload по SSH. При сомнении уточни у оператора._
- Codex sandbox иногда падает на Windows с `CryptUnprotectData` при попытке live-grep файлов. **Передавай готовый контекст в промпте** (excerpts кода, file:line, log snippets), не проси Codex самому читать файлы.

## Дисциплина сессий (токен-экономика, operator 2026-07-19)

Аудит 17–19.07: 119 top-level rollouts за 2 дня, 536M input — большинство одноразовые one-shot
сессии, каждая заново платит bootstrap (конфиг+контекст). Правила:
- **Батчинг:** 3–6 связанных вопросов в ОДИН бриф, не шесть отдельных вызовов.
- **Resume в рамках темы:** продолжение той же темы — `codex exec resume --last "<follow-up>"`
  (контекст и кеш сессии переиспользуются), НЕ новый `codex exec`.
- **Mega-thread запрещён:** тема сменилась ИЛИ сессия перевалила ~80–120K контекста — новая сессия.
- **Quota-стоп:** codex-квота >70% — только critical-вопросы (архитектура/data-integrity), рутину
  держит лид или Sonnet worker.
- Цель: 119 → 30–40 rollouts/2 дня. Применяется и к Desktop-сессиям оператора.

**Структура промпта** для эффективной консультации:
1. Контекст (1-2 строки — проект, что произошло)
2. Конкретные находки с file:line ссылками
3. Твоё текущее предложение / hypothesis
4. Numbered questions (3-5 штук, конкретные)
5. Constraints: «Be terse, under N words, just judgment»
