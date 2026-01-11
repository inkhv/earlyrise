# earlyrise (MVP)

MVP платформа челленджа ранних подъёмов для Telegram:
- `apps/bot` — grammY bot (тонкий клиент)
- `apps/api` — Fastify API (вся бизнес‑логика)
- `apps/web` — Next.js Admin UI (и будущая Mini App)
- `supabase/` — миграции, seed
- `deploy/` — docker compose (staging/prod)
- `docs/` — спецификации (бот, админка, алгоритмы)

> ВАЖНО: этот репозиторий рассчитан на **Node.js 20+**.

## Быстрый старт (локально)

1) Установи `pnpm` и Node 20+.
2) Установи зависимости:

```bash
pnpm i
```


4) Запусти dev:

```bash
pnpm dev
```

## Supabase

Схема БД лежит в `supabase/migrations/`.  
Seed: `pnpm supabase:seed`.

## Deploy (VPS, systemd + server-side autodeploy)

На VPS настроен systemd timer, который раз в минуту подтягивает `main` из GitHub и перезапускает сервисы при появлении нового коммита.
См. `deploy/README.md`.

## Voice → n8n (STT/feedback)

Если OpenAI на VPS блокируется по региону, API может вызывать n8n по `N8N_WEBHOOK_URL` и ждать JSON:
- `transcript`: string
- `confidence`: number|null (опционально)
- `reply`: string (опционально; если нет — API отправит fallback-ответ)

Рекомендации:
- Используй **production** webhook URL (не `webhook-test`) и активируй workflow в n8n.
- Чтобы всегда предпочитать n8n (без попытки OpenAI на VPS), поставь `VOICE_PROVIDER=n8n`.

## Specs
- Bot spec (включая механику напарников): `docs/bot-spec.md`
- AI-куратор: `docs/ai-curator-scenario.md`
- Сценарии теста до 08-01: `docs/test-scenarios-jan8.md`
- Оплата (MVP): `docs/payments-mvp.md`


