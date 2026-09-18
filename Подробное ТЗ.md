# Funnel Runtime — план (Этап 1, сверен с TZ.md и funnel-v1/v2/v3.json)

## Context
Тестовое задание (TZ.md): платформа для многошаговых воронок, у которых есть версии, A/B, события, аналитика и rollback.
В папке лежат `TZ.md`, `funnel-v1.json`, `funnel-v2.json`, `funnel-v3.json`; git ещё не инициализирован; Node 22.22, npm 10, Docker есть.
Критерии оценки: работоспособность 25%, версии/rollback 20%, события/аналитика 20%, продукт 20%, агентский процесс 15%.

**Согласовано:** откат не трогает начатые сессии (они дописываются на своей версии); хостинг — Fly.io + volume;
конфиги **не редактируются** и лежат там же, в корне репозитория.

| Итерация | Конфиги | Что демонстрируем |
|---|---|---|
| 1 | v1 (seed) → v2 | рантайм, A/B, события, аналитика; публикация v2 без деплоя, закрепление версии, rollback v2→v1 |
| 2 | v3 | новая ветка, у B удалён экран, новое событие; старые v1/v2-сессии работают; rollback без ручных изменений схемы БД |

## 0. Разбор конфигов (проверено скриптом по реальным файлам)

| | v1 | v2 | v3 |
|---|---|---|---|
| Типы шагов | info, number, single-select, multi-select, result | те же | те же |
| Операторы условий | `eq`, `in` (+ `any`/`all`) | + `gte` | + `contains` (по массиву multi-select) |
| Шагов у A / B | 9 / 9 (другой порядок) | 10 / 10 | 11 / **10: у B нет `tool_count`** |
| Условные шаги (`visibleWhen`) | `office_days` ← work_mode in [hybrid, office] | то же | + **`security_constraints` ← priorities contains "compliance"** |
| Новые результаты | 4 (+ default `balanced`) | + `meeting_heavy` (meeting_hours ≥ 15) | + `regulated_scale` (compliance + strict/regulated) |
| События | 7 базовых | те же 7 | + **`recommendation_expanded`** {result_id, action, source} |
| experiment.id | …-v1 | …-v2 | …-v3 |
| Ключи сообщений валидации | required, min, max, minSelections, maxSelections | те же | те же |

Выводы, которые влияют на код:
- Реестр компонентов покрывает ровно 5 типов, это достаточно для всех трёх версий. Операторы движка: `eq, neq, in, not_in, gt, gte, lt, lte, contains, exists` и композиция `all/any/not`. Всё, что нужно для v1–v3, работает без изменения кода.
- Ответы хранятся по ключу `input.name` (он совпадает с `step.id`); условия ссылаются на `answer` = input name.
- В каждом варианте всех версий `visibleWhen` ссылается только на шаг, который идёт **раньше**. Это правило я делаю проверкой валидатора при публикации.
- Для сообщений валидации нужен fallback. У `priorities` нет ключа `required`, есть только `minSelections`, а у number-шагов нет сообщения про целое число (`step: 1`).
  Цепочка такая: конкретный ключ → родственный ключ → общий текст.
- Поле `status: "draft"` в v2/v3 **игнорируется**: жизненный цикл версии (загружена или активна) хранит сервер, а не файл.
- `releaseNote` есть только в v2/v3, поэтому zod-схема принимает его как необязательное поле и пропускает неизвестные поля (passthrough).
- Результат рисует и валидирует сервер: у `result`-шага есть `loadingTitle / errorTitle / retryLabel`. Экран результата
  ждёт ответ сервера и умеет показать ошибку с кнопкой повтора.
- CTA во всех версиях имеет `action: "expand_recommendation"`: кнопка раскрывает список `recommendations` на экране результата.
  В v3 именно в этот момент должно отправляться новое событие `recommendation_expanded` (см. §6.3).
- Продуктовое наблюдение для README: `team_size`, `office_days`, `tool_count` **не участвуют ни в одном resultRule** ни в одной версии.
  Вариант B в v3 убирает как раз `tool_count`, то есть проверяет гипотезу «вопрос, который не влияет на результат, только увеличивает отвал».

## 1. Модель данных (SQLite, better-sqlite3)

```
funnel_versions   -- неизменяемые снимки конфигов, только INSERT
  funnel_id TEXT, version INTEGER, PK(funnel_id, version)   -- из полей funnelId / version файла
  config_json TEXT   -- конфиг ровно в том виде, как пришёл
  config_hash TEXT   -- sha256 канонического JSON: тот же контент = no-op, другой контент с тем же номером = 409
  experiment_id TEXT, release_note TEXT, created_at INTEGER

funnel_active     -- указатель: на какой версии создаются новые сессии
  funnel_id TEXT PK, version INTEGER, updated_at

release_log       -- журнал (только INSERT): аудит и основа для rollback
  id INTEGER PK AUTOINCREMENT, funnel_id, action ('publish'|'rollback'), from_version, to_version, actor, created_at

sessions
  id TEXT PK (uuid, генерирует сервер)
  funnel_id, funnel_version, experiment_id, variant, assignment ('hash'|'override')   -- после создания не меняются
  utm_source, utm_medium, utm_campaign, utm_content, utm_term                         -- first touch
  state_json TEXT  -- {answers, history[], currentStepId}; сырые ответы хранятся ТОЛЬКО здесь (session.persistAnswers=true)
  state_rev INTEGER, status ('active'|'completed'), result_id, created_at, updated_at, expires_at (session.ttlHours = 72)

events
  event_id TEXT PK, session_id, name, step_id NULL
  funnel_id, funnel_version, experiment_id, variant   -- проставляет СЕРВЕР из sessions
  utm_source, utm_medium, utm_campaign                -- копия из сессии для фильтров
  client_ts, server_ts INTEGER(ms), seq INTEGER NULL  -- seq = счётчик событий внутри сессии на клиенте
  properties_json TEXT                                -- только свойства из whitelist события в конфиге версии
  INDEX (funnel_id, funnel_version, variant), (session_id, seq), (name), (utm_campaign)

ingest_log          -- одна строка на пачку: accepted / duplicates / rejected + коды причин (без payload)
schema_migrations   -- миграции применяются автоматически при старте; руками ничего не запускаем
```

**Как схема переживает v3 без DDL и без потери аналитики** (проверяется в итерации 2):
1. v3 = одна новая строка в `funnel_versions`. Шаг `security_constraints`, результат `regulated_scale` и оператор `contains` живут внутри JSON.
2. Сессии v1 и v2 ссылаются на свою `(funnel_id, version)`. Публикация и откат меняют только `funnel_active`; версии не удаляются и не перезаписываются.
3. B без `tool_count`: список шагов для аналитики строится из конфига **выбранной версии и варианта**. A и B сравниваются по `step_id`,
   для отсутствующего у варианта шага показывается «—», а не 0%.
4. `recommendation_expanded`: имя хранится как TEXT, свойства в JSON. Допустимость проверяется по `events.allowed` **версии сессии**,
   поэтому от v3-сессии событие принимается, а от v1/v2-сессии отклоняется (`event_not_allowed_for_version`).
   Дашборд выводит блок «прочие события» (уникальные сессии по каждому имени), который строится из данных, без хардкода.
5. У каждой версии свой experiment.id, поэтому A/B считается внутри версии и сравнение не смешивает эксперименты.
6. Доказательство: `npm run db:schema-hash` (sha256 от `sqlite_master`) до и после каждой публикации/отката, значения записываются в WORKLOG.

## 2. Структура репозитория (npm workspaces, TypeScript strict)

```
funnel-v1.json, funnel-v2.json, funnel-v3.json   -- оригиналы, не трогаем (в README есть sha256 для проверки)
packages/shared/   -- типы, zod-схема конфига и события, движок: evaluateCondition, resolveVariant, getVisibleSteps,
                      nextStep/prevStep, progress, validateAnswer, effectiveAnswers, computeResult; validateConfig
apps/server/       -- Fastify + zod, better-sqlite3, migrations; модули versions, sessions, events, analytics;
                      в проде отдаёт собранный фронт через @fastify/static со SPA fallback (один контейнер)
apps/web/          -- Vite + React + react-router: /f/:funnelId, /admin, /admin/analytics; / → /f/workstyle-planner
scripts/           -- traffic.ts, publish.ts (загрузка и публикация через HTTP API), schema-hash.ts
tests/fixtures/    -- только битые конфиги для негативных тестов валидатора (dangling id, ссылка вперёд, неизвестный тип)
WORKLOG.md, README.md, Dockerfile, fly.toml
```
tsconfig.base: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; ESLint `no-explicit-any: error`. Тесты: Vitest.
Интеграционные тесты идут через `fastify.inject` на `:memory:` SQLite, реальные конфиги читаются из корня.

## 3. Движок и рендер без хардкода экранов
- `resolveVariant(config, v)` собирает эффективную воронку: `stepSequence` варианта плюс deep-merge `stepOverrides[id]` в шаги
  и `resultOverrides[id]` в результаты. Частичный override, например у `priorities` только title и helperText, сохраняет остальные поля.
- Видимость шага определяется так: условия нет, либо `visibleWhen` истинно на **эффективных ответах**. Если ответа ещё нет, лист условия ложен.
  **Эффективные ответы** — это ответы только тех шагов, которые сейчас видимы и входят в sequence варианта. Пример: пользователь
  выбрал compliance, ответил на `security_constraints`, вернулся и снял compliance. Ответ остаётся в state (восстановится,
  если выбрать compliance снова), но не участвует ни в результате, ни в прогрессе.
- Следующий шаг — первый видимый дальше по sequence. Назад — pop из `history`.
- Прогресс = позиция среди видимых шагов, типы которых не входят в `progress.excludeTypes` (info, result).
  Когда открывается ветка, знаменатель честно растёт на 1 (выбрали compliance → 8 вопросов вместо 7). ТЗ требует считать только доступные шаги.
- Валидация: number проверяет required, min, max, кратность `step`; single-select — required и значение из options;
  multi-select — min/maxSelections и значения из options. Одна и та же функция работает на клиенте и на сервере.
- `computeResult`: первое сработавшее правило из `resultRules`, иначе `defaultResultId`.
- Валидатор при загрузке версии (при ошибке 422, активная версия не меняется): id в каждом `stepSequence` существуют; последний шаг
  имеет тип `result`; overrides ссылаются на существующие шаги и результаты; `resultRules[].resultId` и `defaultResultId` существуют;
  `visibleWhen` ссылается на input, который идёт раньше в **каждом** варианте; тип и оператор известны; веса > 0.
  Сверено: v1, v2 и v3 проходят все проверки.

## 4. Сессии, состояние, back/refresh
- `POST /api/sessions {funnelId, utm, variantOverride?}` создаёт сессию на **активной** версии и возвращает
  `{sessionId, version, variant, config: resolved, state}`. Внутри той же транзакции сервер пишет `session_started`.
- `GET /api/sessions/:id` отдаёт конфиг **закреплённой** версии и state. Если сессия истекла (72 ч), возвращается 410 и клиент создаёт новую.
- `PUT /api/sessions/:id/state {answers, history, currentStepId, rev}`: сервер валидирует ответы по закреплённой версии тем же движком
  и проверяет, что `currentStepId` достижим. При несовпадении `rev` (вторая вкладка) возвращает 409 и серверный state.
- `POST /api/sessions/:id/result` считает result_id на сервере, помечает сессию completed и возвращает результат с учётом variant override.
- Клиент: `sessionId` и копия state лежат в localStorage по ключу funnelId. Шаг хранится в URL (`?step=`, pushState).
  Кнопка «назад» браузера (popstate) на шаг из `history` работает как Back и отправляет `back_clicked`. Недостижимый `?step=` игнорируется.
  Refresh или повторное открытие: GET сессии и продолжение с `currentStepId`.

## 5. A/B
- `bucket = sha256(experiment_id + ':' + session_id) mod Σweight`, дальше выбор по весам (50/50). Результат пишется в `sessions.variant`.
  После refresh вариант читается из БД и заново не вычисляется.
- Override `?<experiment.overrideQueryParam>=B` (в конфигах это `variant`) принимается только при создании сессии и только для
  варианта из конфига. Если уже есть живая сессия с другим вариантом, создаётся **новая** сессия, старая не мутирует.
  Такие сессии помечаются `assignment=override` и по умолчанию исключаются из A/B-сравнения (переключатель на дашборде).

## 6. События

### 6.1 Схема (поля payload совпадают с `events.baseProperties` конфига)
`event_id (uuid), session_id, name, client_timestamp (ISO), funnel_id, funnel_version, experiment_id, variant, step_id,
utm_source, utm_medium, utm_campaign, seq?, properties{}`. `server_timestamp` ставит сервер.

| Событие | Когда отправляет клиент | step_id | properties |
|---|---|---|---|
| session_started | сервер при создании сессии, event_id = uuid v5(session_id) | null | — |
| step_viewed | шаг отрисован (в том числе повторно после back или refresh) | шаг | step_type, visible_step_index, visible_step_count |
| answer_submitted | нажали «Далее» с валидным ответом | шаг | answer_kind (`single_select`/`multi_select`/`number`), только если `privacy.allowAnswerKinds` |
| step_completed | переход вперёд с **интерактивного** шага (так сказано в trigger конфига, поэтому для intro не отправляется) | шаг | next_step_id |
| back_clicked | Back в UI или в браузере | шаг, с которого ушли | destination_step_id |
| result_viewed | результат отрисован | result | result_id |
| cta_clicked | клик по CTA | result | result_id, action |
| recommendation_expanded (v3) | после CTA раскрылись рекомендации | result | result_id, action, source=`result_cta` |

### 6.2 Приём: `POST /api/events {events:[…]}` (≤100 штук, иначе 413)
- Всегда отвечает 200 с результатом по каждому событию: `accepted | duplicate | rejected{reason}`. Одно битое событие не валит пачку.
- Порядок проверок: zod → сессия существует → `name` есть в `events.allowed` **версии сессии** → `step_id` есть в конфиге версии →
  funnel_version и variant совпадают с сессией. Валидные события вставляются одной транзакцией.
- `INSERT … ON CONFLICT(event_id) DO NOTHING`, **без upsert**: первая запись побеждает, ретрай с другим payload ничего не перезаписывает.
  Повтор пачки после таймаута возвращает `duplicate` и счётчики не меняет.
- Приватность (`privacy.storeRawAnswers:false`): properties режутся по whitelist события, значений ответов в событиях нет.
  Сырые ответы живут только в `sessions.state_json` (это разрешает `session.persistAnswers:true`), аналитика эту колонку не читает.
- Клиентский outbox в localStorage: отправка пачкой раз в 2 с, при 10 событиях или на `visibilitychange` (fetch keepalive),
  ретраи с backoff. Событие удаляется из outbox только после ответа сервера. Итог: at-least-once доставка плюс дедуп на сервере.
- **Клиент отправляет событие, только если оно есть в `events.allowed` версии своей сессии.** Благодаря этому код с новым
  событием безопасен для старых сессий.

### 6.3 Новое событие v3 и «публикация без передеплоя» (согласовано: код события пишем во 2-й итерации)
Итерация 1 делается так, будто v3 ещё не видели: кода под `recommendation_expanded` в ней нет.
Базе и серверу `recommendation_expanded` ничего не стоит: они его примут. Но **момент отправки** («после CTA раскрылись рекомендации»)
знает только код фронтенда, и конфиг этого не описывает. Честный путь (expand/contract):
① небольшой деплой фронта, который отправляет `recommendation_expanded` при раскрытии, но только если событие разрешено версией.
Для текущих v1/v2 это no-op → ② **публикация v3 через админку без деплоя** → старые сессии не затронуты.

## 7. Версии и откат
- `POST /api/admin/funnels/:id/versions` загружает конфиг (через форму в админке или `npm run publish -- funnel-v2.json`) и валидирует.
- `POST …/versions/:v/publish` делает версию активной: `funnel_active` и `release_log` пишутся в одной транзакции. Повторная публикация активной версии — no-op.
- `POST …/rollback` отменяет последнюю публикацию: активной становится `from_version` последнего неотменённого publish, в журнал пишется запись rollback.
  Сценарии: v1→v2→rollback = v1; v1→v3→rollback = v1.
- Начатые сессии дописываются на своей версии, новые создаются на активной.
- Админ-роуты требуют `ADMIN_TOKEN` (заголовок). При пустой БД на старте v1 загружается и публикуется как seed.

## 8. Аналитика (везде уникальные сессии; фильтры: версия, utm_campaign, «включать override»)
- **Импликации** (устойчивость к потерянным и опоздавшим событиям): просмотр шага = есть `step_viewed` ∪ `answer_submitted` ∪ `step_completed` по шагу;
  результат достигнут = есть `result_viewed` ∪ `cta_clicked`. Так CTR не может превысить 100%, если result_viewed потерялся.
- **Начали** = distinct `session_started`.
- **По шагам** (порядок из sequence выбранной версии и варианта): просмотрели; прошли (интерактивный шаг — `step_completed`,
  info — есть просмотр любого другого шага с бо́льшим seq); конверсия шага = прошли / просмотрели; охват = просмотрели / начали.
  Условные шаги (`office_days`, `security_constraints`) помечены бейджем «условный», чтобы меньший охват не читался как потеря.
- **Отвал на шаге** = сессии без результата, у которых **последний** просмотренный шаг (по seq → client_ts → server_ts) — этот.
  Отдельная корзина — «ушли до первого экрана». Инвариант: `Σ отвалов + дошли до результата = начали`.
- **Дошли до результата**, **CTR CTA** = distinct cta / distinct дошли, **start→CTA** = distinct cta / начали.
- **Сравнение A/B** внутри выбранной версии: метрики, 95% CI, z-тест двух долей по start→CTA.
- **Сравнение версий**: сводные метрики по v1/v2/v3 в одной таблице (по шагам не сравниваем, у версий разные sequence).
- **Прочие события**: distinct сессии по каждому `name` вне базовых 7 (здесь появится `recommendation_expanded`).
- **Служебное**: сырые события, отброшенные дубли, отклонённые события по причинам (из `ingest_log`).
- Порядок прихода не влияет ни на что, кроме «последнего шага», а тот считается по клиентскому seq. Дубли не проходят PK.

**A/B-гипотеза и метрика (для README):** B начинает с простого вопроса-идентичности (work_mode), тяжёлый числовой ввод (team_size)
переносит ниже, а в v3 ещё и убирает `tool_count`, который не влияет на результат. Результат подаётся как действие
(«See the 30-day action list» / «Open the implementation details»). Ожидаем, что у B выше **start→CTA**.
Почему эта метрика: B влияет **и** на дохождение (порядок и длина), **и** на клик (подача результата). Голый CTR смещён,
потому что считается только по дошедшим. Guardrail — completion (дошли / начали).

## 9. Генератор трафика — `npm run traffic -- --sessions 150 --seed 42 --url http://localhost:3000 [--verify]`
- Работает только через публичное HTTP API. Шаги, опции и диапазоны чисел берёт **из конфига, который вернула сессия**,
  поэтому одинаково работает на v1, v2 и v3.
- Покрытие: 4 кампании (utm_source/medium/campaign), A/B по естественному хешу, случайные ответы (work_mode remote → office_days скрыт;
  compliance в priorities примерно в трети сессий → ветка v3), вероятности отвала по шагам (у B чуть ниже, чтобы разница была видна),
  back примерно в 15% сессий, повторные step_viewed, **повторная отправка целых пачек**, **перемешанные и разнесённые по пачкам события**,
  по одному битому событию в части пачек.
- Генератор ведёт ground truth по тем же определениям и печатает ожидаемые метрики. С `--verify` сверяет их с `/api/admin/analytics`, при расхождении exit 1.

## 10. Тесты
**П.7.1 (итерация 1, на реальных v1/v2):**
1. **Закрепление версии:** сессия на v1 → публикуем v2 → GET отдаёт v1 (нет `meeting_hours`, 9 шагов); state с ответом `meeting_hours`
   отклоняется; события сессии пишутся с version=1; новая сессия создаётся на v2 (10 шагов).
2. **Стабильность A/B:** 20 GET одной сессии дают один вариант; функция назначения детерминирована; на 10 000 id доля B = 50±2%;
   override → `assignment=override`; `?variant=C` игнорируется; override на живой сессии с другим вариантом создаёт новую сессию, старая не меняется.
3. **Дедупликация и batching:** 5 событий → 5 accepted; та же пачка повторно → 5 duplicate, строк по-прежнему 5; 4 валидных + 1 битое → 200,
   4 accepted + 1 rejected с reason; тот же event_id с другим payload не перезаписывает событие; лишнее свойство (например `value`) вырезается.
4. **Публикация и откат:** v1 → загрузка и публикация v2 → rollback → активна v1; новая сессия на v1; **v2-сессия** проходит GET/state/result/events;
   аналитика по v2 до и после отката совпадает; битый конфиг → 422 и активная версия не изменилась; повторная загрузка v2 — no-op; schema-hash не изменился.
5. **Аналитика:** фикстура событий с известным ответом (дубли, back, повторные просмотры, скрытый office_days, потерянный result_viewed при
   существующем cta) → точные started, reached, CTR, start→CTA и отвалы по A/B и utm; **инвариантность к перестановке**
   (перемешанный порядок вставки плюс дубли дают идентичный JSON); `Σ отвалов + дошли = начали`.

Плюс unit-тесты движка: все операторы, частичный deep-merge override, видимость, прогресс, effectiveAnswers, fallback сообщений,
`validateConfig` на трёх реальных конфигах и на битых фикстурах.

**Итерация 2 (добавляются вместе с v3):** `security_constraints` виден только при compliance, прогресс 7→8;
у B v3 нет `tool_count` и все шаги проходятся; `regulated_scale` считается; `recommendation_expanded` принимается от v3 и отклоняется от v1/v2;
v1- и v2-сессии, открытые до публикации v3, доходят до конца; rollback v3→v1; schema-hash не изменился; аналитика v1/v2 не изменилась.

## 11. Порядок работы (коммит в conventional commits и запись в WORKLOG после каждого пункта; ★ = стоп и отчёт вам)
0. `chore:` git init, workspaces, tsconfig/eslint/vitest, скелет WORKLOG (решения этого плана).
1. `feat(shared):` типы, zod, движок, validateConfig + unit-тесты. ★
2. `feat(server):` БД, миграции, versions (upload/publish/rollback/seed) + тест 4. ★
3. `feat(server):` sessions (создание, A/B, закрепление, state, result) + тесты 1, 2. ★
4. `feat(web):` рантайм воронки (рендерер 5 типов, back/refresh/URL, экран результата с CTA-раскрытием). ★
5. `feat(events):` приём событий + клиентский outbox + тест 3. ★
6. `feat(analytics):` агрегаты, дашборд + тест 5; админ-страница версий. ★
7. `feat(scripts):` генератор + `--verify`. ★
8. `chore(deploy):` Dockerfile (node:22-bookworm-slim), fly.toml (1 машина, volume `/data`, `DB_PATH`, секрет `ADMIN_TOKEN`).
   Регистрацию и `fly auth login` делаете вы, `fly launch/deploy` выполняю я. ★
9. **Демо итерации 1 на публичном URL:** v1 + 150 сессий → открываю незаконченную v1-сессию → schema-hash → публикую v2 из админки →
   v1-сессия доходит на v1 → +150 сессий на v2 → открываю незаконченную v2-сессию → rollback → она доходит на v2, новые идут на v1 → schema-hash.
   Показываю дашборд, прохожу чек-лист итерации 1. ★
10. `docs:` README (черновик) и самопроверка итерации 1.
11. **Итерация 2 (v3):** `feat(web): recommendation_expanded` (разрешено только версией, деплой) → schema-hash → публикую v3 из админки,
    без деплоя → v1/v2-сессии доходят → тестирую v3 (ветка, B без tool_count, новое событие на дашборде) + тесты итерации 2 →
    rollback → проверка → schema-hash → WORKLOG. ★
12. `docs:` финальный README (таймлайн обеих итераций, sha256 конфигов) и честная самопроверка по TZ.md пункт за пунктом.

**Агентский процесс:** после шага 1 (контракты в `packages/shared` зафиксированы) параллельно работают субагенты в отдельных worktree:
(a) web-рантайм, (b) SQL аналитики + тест 5, (c) генератор трафика. Я интегрирую и проверяю каждый diff. Ревью делает отдельный агент,
которому даю только код и ТЗ. В WORKLOG записываю, что нашло ревью, что я принял или отклонил и почему.

## Verification
- `npm test`, `npm run typecheck`, `npm run lint` зелёные.
- Локально (браузерная панель): A и B через `?variant=`; ветка remote (office_days скрыт); back через UI и через браузер; refresh на середине;
  закрыть и открыть вкладку; невалидный ввод показывает текст из конфига.
- `npm run traffic -- --sessions 150 --verify` → exit 0, скриншот дашборда.
- Итерации 1 и 2 на публичном URL по сценариям из шагов 9 и 11; хеши схемы и результаты записаны в WORKLOG.
