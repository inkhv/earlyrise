import { env } from "../config.js";

async function storageFetch(path: string, init: { method: string; headers?: Record<string, string>; body?: any }) {
  const url = `${env.SUPABASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers: Record<string, string> = {
    // IMPORTANT:
    // Supabase may issue service role keys in `sb_secret_...` form (not JWT).
    // Storage API accepts these via `apikey` header, while `Authorization: Bearer` expects JWT and fails.
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    ...(init.headers || {})
  };
  const res = await fetch(url, { method: init.method, headers, body: init.body });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, text, json };
}

export async function storageUploadObject(params: {
  bucket: string;
  path: string;
  bytes: Uint8Array;
  contentType: string;
  upsert: boolean;
}) {
  const p = `/storage/v1/object/${encodeURIComponent(params.bucket)}/${params.path
    .split("/")
    .map((x) => encodeURIComponent(x))
    .join("/")}`;
  return await storageFetch(p, {
    method: "POST",
    headers: {
      "Content-Type": params.contentType || "application/octet-stream",
      "x-upsert": params.upsert ? "true" : "false"
    },
    body: params.bytes
  });
}

export async function storageListObjects(params: { bucket: string; prefix: string; limit: number; offset: number }) {
  const p = `/storage/v1/object/list/${encodeURIComponent(params.bucket)}`;
  return await storageFetch(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: params.prefix, limit: params.limit, offset: params.offset })
  });
}

export async function storageDeleteObject(params: { bucket: string; path: string }) {
  const p = `/storage/v1/object/${encodeURIComponent(params.bucket)}/${params.path
    .split("/")
    .map((x) => encodeURIComponent(x))
    .join("/")}`;
  return await storageFetch(p, { method: "DELETE" });
}

function toIsoDateUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function maybeStoreVoiceAudio(params: {
  checkin_id: string;
  checkin_at_utc: string;
  audio_base64: string;
  audio_mime: string;
}): Promise<{ bucket: string; path: string; bytes: number } | null> {
  const bucket = env.VOICE_STORAGE_BUCKET?.trim();
  if (!bucket) return null;
  if (!params.audio_base64) return null;
  try {
    const bytes = new Uint8Array(Buffer.from(params.audio_base64, "base64"));
    const date = toIsoDateUTC(new Date(params.checkin_at_utc));
    const ext = params.audio_mime.includes("ogg") ? "ogg" : params.audio_mime.includes("mpeg") ? "mp3" : "bin";
    const path = `voice/${date}_${params.checkin_id}.${ext}`;
    const up = await storageUploadObject({
      bucket,
      path,
      bytes,
      contentType: params.audio_mime || "application/octet-stream",
      upsert: true
    });
    if (!up.ok) {
      // Do not fail check-in if storage upload fails
      return null;
    }
    return { bucket, path, bytes: bytes.byteLength };
  } catch {
    return null;
  }
}

export async function cleanupVoiceStorage(params: { dry_run: boolean }): Promise<{ attempted: number; deleted: number; errors: number }> {
  const bucket = env.VOICE_STORAGE_BUCKET?.trim();
  if (!bucket) {
    const err: any = new Error("VOICE_STORAGE_BUCKET is not configured");
    err.statusCode = 501;
    throw err;
  }
  const retentionH = Number(env.VOICE_STORAGE_RETENTION_HOURS || "24");
  const retentionMs = (Number.isFinite(retentionH) && retentionH > 0 ? retentionH : 24) * 3600_000;
  const cutoff = Date.now() - retentionMs;

  let attempted = 0;
  let deleted = 0;
  let errors = 0;

  const limit = 1000;
  for (let offset = 0; offset < 50_000; offset += limit) {
    const list = await storageListObjects({ bucket, prefix: "voice", limit, offset });
    if (!list.ok) throw new Error(`storage_list_failed: ${list.status} ${list.text || ""}`);
    const items: any[] = Array.isArray(list.json) ? list.json : [];
    if (items.length === 0) break;
    const toDelete: string[] = [];
    for (const it of items) {
      const created = Date.parse(String(it.created_at || it.updated_at || ""));
      if (!Number.isFinite(created)) continue;
      if (created < cutoff) {
        attempted += 1;
        toDelete.push(`voice/${it.name}`);
      }
    }
    if (toDelete.length > 0) {
      if (!params.dry_run) {
        for (const pth of toDelete) {
          const rm = await storageDeleteObject({ bucket, path: pth });
          if (!rm.ok) errors += 1;
          else deleted += 1;
        }
      }
    }
    // Stop early if the list is ordered and we already reached non-expired items (best-effort).
    const oldestKept = items.find((it: any) => {
      const created = Date.parse(String(it.created_at || it.updated_at || ""));
      return Number.isFinite(created) && created >= cutoff;
    });
    if (oldestKept) break;
  }

  return { attempted, deleted: params.dry_run ? 0 : deleted, errors };
}


