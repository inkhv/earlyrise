## Deploy (VPS, systemd, versioned via git)

Цель: один “непрерывный поток”, бот работает постоянно, обновляется через `git pull` с возможностью отката по коммиту.

### 0) Предпосылки
- Ubuntu 24.04 на VPS
- Репозиторий `earlyrise` доступен на сервере через `git clone` (public или через SSH deploy key)
- В Supabase уже есть миграции + seed + активный challenge

### 1) Bootstrap на сервере (один раз)
На сервере (под root):

```bash
cd /root
mkdir -p /opt/earlyrise
```

Установи Node.js 20 + pnpm:

```bash
bash /opt/earlyrise/deploy/scripts/install_node20_pnpm.sh
```

Клонируй репозиторий:

```bash
cd /opt
git clone <REPO_URL> earlyrise
cd /opt/earlyrise
```

Создай env-файл для продакшена:
- `deploy/env.production` (НЕ коммитить!)

Используй текущий `deploy/env.production` как источник переменных (на сервере файл лежит в `/opt/earlyrise/deploy/env.production`).

### 2) systemd units
Скопируй юниты:

```bash
cp deploy/systemd/earlyrise-api.service /etc/systemd/system/earlyrise-api.service
cp deploy/systemd/earlyrise-bot.service /etc/systemd/system/earlyrise-bot.service
systemctl daemon-reload
systemctl enable earlyrise-api earlyrise-bot
```

### 3) Первый запуск

```bash
cd /opt/earlyrise
bash deploy/scripts/deploy.sh
systemctl restart earlyrise-api earlyrise-bot
systemctl status earlyrise-api --no-pager
systemctl status earlyrise-bot --no-pager
```

### 4) Обновление (каждый раз)
На сервере:

```bash
cd /opt/earlyrise
git fetch --all
git checkout <commit-or-branch>
bash deploy/scripts/deploy.sh
systemctl restart earlyrise-api earlyrise-bot
```

## GitHub Actions автодеплой (опционально)

Если хочешь автодеплой “push в GitHub → обновилось на сервере”, используй workflow:
- `.github/workflows/deploy.yml`

Нужно добавить secrets в GitHub repo:
- `SSH_HOST` (например `194.67.84.159`)
- `SSH_USER` (например `root`)
- `SSH_PORT` (опционально, по умолчанию `22`)
- `SSH_PRIVATE_KEY` (приватный ключ deploy пользователя)

Важно: `deploy/env.production` находится на сервере и **не коммитится**.

### Логи

```bash
journalctl -u earlyrise-api -n 200 --no-pager
journalctl -u earlyrise-bot -n 200 --no-pager
```


