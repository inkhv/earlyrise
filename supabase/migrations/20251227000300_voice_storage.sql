-- Optional: store voice audio in Supabase Storage and keep pointer in DB

alter table public.voice_transcripts
  add column if not exists audio_storage_bucket text,
  add column if not exists audio_storage_path text,
  add column if not exists audio_mime text,
  add column if not exists audio_bytes int;


