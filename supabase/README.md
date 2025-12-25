# Supabase (earlyrise)

## Миграции
Все DDL миграции лежат в `supabase/migrations/`.

## Seed
Seed скрипт: `supabase/seed/seed.mjs`

Требуются env:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Запуск из корня monorepo:

```bash
pnpm supabase:seed
```






