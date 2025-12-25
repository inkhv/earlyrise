# План до первых тестов в Telegram — earlyrise (MVP)

Цель: довести текущий репозиторий до состояния, когда можно:
- поднять `api` + `bot`,
- создать/активировать челлендж,
- вступить в челлендж из Telegram,
- сделать текстовый чек‑ин в окно,
- увидеть изменения настроек из админки,
- (опционально) прогнать механику напарников.

## 1) Что уже есть (текущее состояние)

### Структура
- ✅ `apps/api` (Fastify) — есть `/health`, часть `admin/*`, часть `bot/*`
- ✅ `apps/bot` (grammY) — есть `/start`, `/me`, `/settz`, заглушки под check-in
- ✅ `packages/shared`, `packages/telegram`, `packages/stt-nhn`
- ✅ `supabase` миграции + seed
- ✅ Миграции под напарников + спецификация `docs/bot-spec.md`

### Критические пробелы (мешают первым тестам)
- ❌ Нет `apps/web` (админка не реализована)
- ❌ Нет `ChallengeService` / `CheckinService` (join/checkin не записываются в БД)
- ❌ Нет логики «окна чек‑ина» (таймзона + settings)
- ❌ Voice pipeline в боте пока заглушка (можно сделать позже, но лучше хотя бы fallback)
- ❌ Pricing / wallet credits не реализованы (можно отложить до 2-й итерации)
- ❌ Buddy flow пока только в БД/спеке (нет API/UI)
- ❌ Нет deploy/CI/CD (можно после первых тестов)

## 2) Минимальный объём для первых тестов (MVP-0)

### MUST (без этого тесты бессмысленны)
1) **Active challenge**: хранение + выбор текущего активного
2) **Join**: `/join` создаёт participation
3) **Check-in text**: сообщение → проверка окна → запись `checkins`
4) **Settings toggles**: `challenge_active`, `checkin_window_minutes`, `voice_feedback_enabled`
5) **Admin просмотр**: список пользователей + карточка пользователя (то, что уже частично есть в API)

### SHOULD (усилит тесты, но можно на следующий день)
6) **Voice check-in** (минимум): скачать voice, конвертировать, если нет NHN ключей — сохранить пустой transcript и отправить “fallback feedback”.

### LATER (после первых тестов)
7) Pricing credits + webhook stub с записью событий
8) Buddy system полностью (если не успеваем — хотя бы ручное назначение)
9) CI/CD + Docker Compose staging/prod

## 3) Подробный план по шагам (до первых тестов)

### День 1 — “сквозной сценарий: join + text check-in”
- API:
  - добавить таблицу/логику **active challenge** (берём `challenges.status='active'`)
  - `POST /bot/join` (telegram_user_id → participation)
  - `POST /bot/checkin/text` (telegram_user_id + raw_text)
  - `GET /bot/me/:telegramUserId` расширить: активный челлендж + participation
  - `GET/POST /admin/settings` уже есть — добавить `GET /admin/settings` (чтобы web мог читать)
- Bot:
  - `/join` вызывает `/bot/join`
  - `message:text` вызывает `/bot/checkin/text` и показывает результат (accepted/rejected + причина)

### День 2 — “админка v0 + настройки влияют на поведение”
- Web (Next.js admin):
  - `/login` (Supabase Auth)
  - `/settings` (тумблеры + сохранение через API)
  - `/users` (таблица + поиск + export csv через `GET /admin/users?format=csv`)
  - `/users/[id]` (profile card через `GET /admin/users/:id`)

### День 3 — “voice check-in (минимум)”
- Bot:
  - download voice (`packages/telegram`)
  - конвертация ffmpeg (в контейнере позже; локально можно пропустить и принять ogg)
  - вызов API `POST /bot/checkin/voice` с file metadata + (опционально) transcript
- API:
  - VoiceService: если NHN ключей нет → transcript="" + confidence=0
  - записать `checkins` + `voice_transcripts`
  - FeedbackService: rule-based “короткий фидбек”

### День 4+ — “напарники (если нужно до теста)”
- API:
  - `POST /bot/buddy/request` (wake_time_local)
  - `POST /admin/buddy/assign` (ручное назначение)
  - `POST /admin/buddy/unpair`
  - enforce rule: выбыл один → выбыл оба
- Bot:
  - команда `/buddy` (или кнопки): “подобрать напарника”
  - уведомления о паре/лист ожидания
- Web:
  - на карточке пользователя: блок “Buddy” + кнопки assign/unpair

## 4) Чек-лист “первые тесты готовы”, когда:
- ✅ в Supabase есть 1 активный challenge
- ✅ в Telegram: /start → /settz → /join → текст → чек‑ин записался в БД
- ✅ admin: видит пользователя, чек‑ины, participation
- ✅ settings: смена `checkin_window_minutes` реально меняет поведение бота
- ✅ (опционально) voice: голосовое не ломает поток и даёт фидбек


