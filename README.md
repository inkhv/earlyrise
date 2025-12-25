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

## Deploy (VPS + Docker Compose)

См. `deploy/README.md` (systemd + git pull; Docker можно добавить позже).

## Specs
- Bot spec (включая механику напарников): `docs/bot-spec.md`


