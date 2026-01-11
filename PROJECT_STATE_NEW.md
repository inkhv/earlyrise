# PROJECT_STATE (current) — EarlyRise bot/api

## Repo / scope
- Working scope: работаем только внутри `THE BREAK TO AWAKE/`.
- Monorepo: `UPDATE/main folder/earlyrise/`
  - `apps/api` (Fastify), `apps/bot` (grammY), `supabase/`, `deploy/`, `packages/…`
- Context minimization: сначала смотрим сюда, затем точечные чтения (`grep`/узкие файлы), избегаем больших открытий.

## Бот (grammY)
- Расположение: `apps/bot`
- Запуск: systemd `earlyrise-bot` на VPS
- Guard-уровень в `bot.ts` перехватывает команды в личке и даёт мгновенный ответ + вызовы API:
  - `/start`: приветствие + upsert `/bot/upsert-user`
  - `/me`: запрос `/bot/me/:id`, вывод профиля
  - `/settz`: парс GMT±hh[:mm], POST `/bot/set-timezone`, ответ таймзоной
  - `/join`: POST `/bot/join` с аргументом (фикс/`flex`), ответ с режимом
  - `/trial`: POST `/bot/trial/claim`, ответ статусом
  - `/pay`: POST `/bot/pay/create`, ответ ссылкой или ошибкой
- В `dm.ts` сохранены штатные обработчики + `hears` для команд, чтобы работать даже без bot_command entity.
- Групповой поток: учёт `+` без ответов в чате, напоминание в DM при needs_voice.
- Порядок DM check-in (text/voice): curator reply → anti-cheat вопрос → после правильного ответа — “Засчитано ✅”.
- Anti-cheat: checkin создаётся в статусе `pending`, засчитывается только после успешного ответа.

## API (Fastify)
- Расположение: `apps/api`
- Systemd: `earlyrise-api`, `/health` доступен на `127.0.0.1:3001/health`
- Основные эндпоинты, задействованные ботом: `/bot/upsert-user`, `/bot/me/:id`, `/bot/set-timezone`, `/bot/join`, `/bot/trial/claim`, `/bot/pay/create`, `/bot/checkin/voice`, `/bot/checkin/dm_text`, `/bot/checkin/plus`.

## VPS
- Host: `root@194.67.84.159`
- Services: `earlyrise-api`, `earlyrise-bot`
- Deploy: `deploy/scripts/deploy.sh` (pnpm i --frozen-lockfile; tsc builds)

## Deploy: GitHub → VPS (актуальный метод)
- **Source of truth**: GitHub repo `inkhv/earlyrise`, ветка `main` (`origin`: `https://github.com/inkhv/earlyrise.git`).
- **Важно**: на VPS попадёт **только то**, что **закоммичено и запушено** в `origin/main`.
  - Если локально ты видишь новые фичи, а бот на VPS “старый” — сначала проверь `git status` (есть ли незакоммиченные/неотслеживаемые изменения) и убедись, что они реально в `main`.
- **Что делает деплой на VPS**: pull → build → restart:
  - `bash /opt/earlyrise/deploy/scripts/run-deploy.sh`
  - Внутри: `deploy/scripts/deploy.sh` (pnpm i; сборка), затем `systemctl restart earlyrise-api earlyrise-bot`
- **Примечание про “GitHub Actions деплой”**:
  - В этой репе **нет** `/.github/workflows/*` → значит деплой “через GitHub” на практике означает: **push в `main` → деплой на VPS** (скриптом выше), либо workflows лежат/настроены вне этой папки.
- **Как быстро сверить версию (SHA)**:
  - GitHub `main`:
    - `git ls-remote https://github.com/inkhv/earlyrise.git refs/heads/main`
  - VPS:
    - `ssh root@194.67.84.159 "cd /opt/earlyrise && git rev-parse --short HEAD"`
  - Если SHA разные — VPS не накатил последнюю версию `main`.
- **Каноничный поток релиза (минимум кликов)**:
  - локально: `git status` должен быть чистый → `git commit` → `git push origin main`
  - на VPS: `bash /opt/earlyrise/deploy/scripts/run-deploy.sh`
  - проверка: `journalctl -u earlyrise-bot -n 120 --no-pager`

## Supabase
- Project ref: `axbzuqdnqzjxnejmvtny`
- Миграции: `20251227000100_standard_mvp.sql`, `20251227000300_voice_storage.sql` применены
- Storage: bucket `earlyrise-voice`, retention 24h (cron в VPS)

## Оплата (T‑Банк) — webhook через n8n (если API не публичный)
- Проблема: `earlyrise-api` слушает локально/за firewall, и Т‑Банк не может достучаться до `POST /payments/webhook`.
- Решение: указать **`TBANK_NOTIFICATION_URL`** как **webhook n8n**, чтобы Т‑Банк слал уведомления в n8n.
  - В API `POST /bot/pay/create` будет отдавать `NotificationURL=TBANK_NOTIFICATION_URL` (если задан), иначе использует `PUBLIC_BASE_URL + /payments/webhook`.
- В n8n поток:
  - Webhook (принимает тело уведомления Т‑Банка)
  - (опционально) валидация `Token` по алгоритму T‑Bank (sha256 конкатенации + Password)
  - Update в Supabase таблицы `payments`: найти по `provider_payment_id = "tbank:<PaymentId>"`, поставить `status = paid|failed|pending` по `Status`
  - После этого бот начнёт видеть оплату, т.к. доступ проверяется по таблице `payments` (status='paid').
- Важно по безопасности: секреты (`TBANK_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY`) держать в **Secrets n8n**, не в payload.

## AI / n8n
- Voice webhook: POST в `N8N_WEBHOOK_URL` с `event=earlyrise_voice_checkin`, `mode="voice"`, payload включает текст транскрипта + метаданные.
- Text webhook: POST в `N8N_TEXT_WEBHOOK_URL` (fallback: `N8N_WEBHOOK_URL`) с `event=earlyrise_text_checkin`, `mode="text"`.
- В промптах/узлах различаем `mode=text/voice`, чтобы не путать сценарии.

## Админ / обслуживание
- `POST /admin/reset/today` (x-admin-token) — сброс DM check-in за сегодня.
- `POST /admin/maintenance/cleanup-voice-storage` — ежедневная чистка Storage (cron на VPS).

## Что важно помнить
- Команды в личке теперь всегда отвечают на верхнем уровне; это снижает риск “тихих” ошибок.
- Для расширения: новые команды добавлять аналогично — либо через guard (быстрый ответ + API), либо через `command/hears` в `dm.ts`, не дублируя логику.
- Secrets хранятся в `deploy/env.production` (локально и на VPS, gitignored); не переносить без запроса.

## Текущий функционал бота (актуально)
- **Личка (DM)**:
  - **/start**: приветствие + upsert пользователя (`POST /bot/upsert-user`).
  - **/me**: профиль/статистика (`GET /bot/me/:id`).
  - **/settz**: установка таймзоны по `GMT±hh[:mm]` или геопозиции (DM ждёт location после `/settz`).
  - **/join**: вступление в челлендж (`/join HH:MM` или `flex`).
  - **Чек‑ин текстом**: обычный текст в личку → `POST /bot/checkin/dm_text` → кураторский ответ + античит.
  - **Чек‑ин голосом**: voice в личку → `POST /bot/checkin/voice` → N8N (STT+reply) + античит.
  - **Античит**: вопрос после чек‑ина, ответ текстом → `POST /bot/anti-cheat/solve` → “Засчитано ✅”.
- **Группа**:
  - **“+”** в группе (не команда) → `POST /bot/checkin/plus` (бот **молчит в группе**).
  - Если `needs_voice=true`, бот шлёт DM‑напоминание “жду голосовое…”.
  - Важно: DM‑напоминание от “+” имеет **in‑memory дедуп** (`plusReminderSent`) и сбрасывается перезапуском `earlyrise-bot`.

## Архитектура (минимальная карта)
- **apps/bot (grammY)**: тонкий клиент, вся логика в API.
  - Guard команд: `apps/bot/src/bot.ts`
  - DM handlers: `apps/bot/src/handlers/dm.ts`
  - Group “+”: `apps/bot/src/handlers/group.ts`
  - Anti‑cheat client state (pending): `apps/bot/src/flows/antiCheat.ts` (in-memory)
- **apps/api (Fastify)**: бизнес‑логика + Supabase.
  - Основные роуты: `apps/api/src/routes/checkin.ts`
  - Админка/обслуживание: `apps/api/src/routes/admin.ts`
  - N8N helper: `apps/api/src/services/n8n.ts`
- **Supabase**: таблицы `users`, `checkins`, `voice_transcripts`, `anti_cheat_challenges`, и т.д.

## N8N (prod webhook)
- **Voice**: `N8N_WEBHOOK_URL=https://inkhv.app.n8n.cloud/webhook/earlyrise-voice`
- **Text**: `N8N_TEXT_WEBHOOK_URL=https://inkhv.app.n8n.cloud/webhook/earlyrise-text`
- Payload кладёт системный промпт в `prompt.system` и отдаёт ожидаемый JSON:
  - `{ transcript?: string, confidence?: number|null, reply?: string }`
- Системный промпт: `CURATOR_SYSTEM_PROMPT` в `apps/api/src/routes/checkin.ts`

## Прод‑деплой / быстрые команды (VPS)
- **Репа**: `/opt/earlyrise`
- **Сервисы**: `earlyrise-api`, `earlyrise-bot`
- **Быстрый деплой** (pull → build → restart):
  - `bash /opt/earlyrise/deploy/scripts/run-deploy.sh`
- **Сброс “памяти” пользователя за текущий локальный день** (чтобы снова тестировать `+ → voice/text` без ручных SQL):
  - `bash /opt/earlyrise/deploy/scripts/reset-user-today.sh <telegram_user_id>`
  - Скрипт удаляет `checkins` за локальный день + связанные `anti_cheat_challenges`/`voice_transcripts`, проверяет `remaining: 0`, перезапускает `earlyrise-bot` (сброс `plusReminderSent`).
- **Логи**:
  - `journalctl -u earlyrise-api -n 200 --no-pager`
  - `journalctl -u earlyrise-bot -n 200 --no-pager`

## Частые причины “не работает” (диагностика по минимуму)
- **Нет ответа из n8n / пришёл fallback**:
  - Проверить `journalctl -u earlyrise-api` на `calling n8n voice webhook` и `n8n voice response`.
  - Возможна задержка n8n/OpenAI → таймауты в `apps/api/src/routes/checkin.ts` (voice/text вызовы `postJson`).
- **Групповой “+” не шлёт DM**:
  - Бот в группе не отвечает по дизайну; DM зависит от `needs_voice`.
  - Повторные “+” могут не давать DM из‑за `plusReminderSent` (in-memory) → помогает `reset-user-today.sh` (он перезапускает bot).
- **Большие голосовые**:
  - Ограничение body size в Fastify (`apps/api/src/server.ts`, `bodyLimit`) — если видишь 413, увеличивать.

## Для следующего агента: как не раздувать контекст
- Всегда начинать с `PROJECT_STATE_NEW.md`, затем точечно:
  - бот: `apps/bot/src/bot.ts`, `apps/bot/src/handlers/{dm,group}.ts`, `apps/bot/src/flows/antiCheat.ts`
  - api: `apps/api/src/routes/checkin.ts` (весь чек‑ин/anti‑cheat/n8n), `apps/api/src/services/n8n.ts`, `apps/api/src/server.ts`
  - прод: `deploy/env.production`, `deploy/scripts/{deploy.sh,run-deploy.sh,reset-user-today.sh}`
- По симптомам сначала смотреть **логи systemd**, а не читать весь код:
  - `journalctl -u earlyrise-api -n 200 --no-pager`
  - `journalctl -u earlyrise-bot -n 200 --no-pager`
