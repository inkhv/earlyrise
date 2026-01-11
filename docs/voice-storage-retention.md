# Voice storage retention (Supabase)

## What we store today
- The API receives voice as `audio_base64` (OGG/Opus) for `/bot/checkin/voice`.
- By default, we **do not store audio files** in Supabase (only `checkins` + `voice_transcripts`).

## Optional: store voice audio in Supabase Storage
### 1) Create Storage bucket
- Create a **private** bucket (recommended name: `earlyrise-voice`).

### 2) Configure environment (API)
- `VOICE_STORAGE_BUCKET=earlyrise-voice`
- `VOICE_STORAGE_RETENTION_HOURS=24` (optional, default `24`)

### 3) Cleanup (keep max ~1 day)
Call admin maintenance endpoint (requires `x-admin-token`):

```bash
curl -X POST "http://127.0.0.1:3001/admin/maintenance/cleanup-voice-storage" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: <ADMIN_DASHBOARD_TOKEN>" \
  -d '{"dry_run": false}'
```

You can put it on a daily cron on the server.


