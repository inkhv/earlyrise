export type NhnSttResult = {
  transcript: string;
  confidence?: number;
  raw?: unknown;
};

export type NhnSttConfig = {
  appKey?: string;
  secretKey?: string;
  endpoint?: string;
};

/**
 * NHN STT client (HTTP).
 *
 * MVP behavior:
 * - If keys are missing, returns a safe fallback with empty transcript.
 * - This keeps the system "it just works" locally without paid integration.
 */
export async function transcribeWithNhn(
  audioBuffer: Uint8Array,
  cfg: NhnSttConfig,
): Promise<NhnSttResult> {
  const appKey = cfg.appKey?.trim();
  const secretKey = cfg.secretKey?.trim();

  if (!appKey || !secretKey) {
    return { transcript: "", confidence: 0, raw: { skipped: true, reason: "missing_keys" } };
  }

  const endpoint =
    cfg.endpoint?.trim() || "https://api.nhncloudservice.com/stt/v1/recognize"; // placeholder endpoint

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-NHN-APPKEY": appKey,
      "X-NHN-SECRET": secretKey,
      "Content-Type": "application/octet-stream"
    },
    body: audioBuffer
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    // fail closed but not fatal for bot: return empty transcript
    return { transcript: "", confidence: 0, raw: { error: true, status: res.status, body: json } };
  }

  // NOTE: actual NHN response shape may differ; map defensively
  const transcript = (json?.transcript || json?.text || "").toString();
  const confidence = typeof json?.confidence === "number" ? json.confidence : undefined;
  return { transcript, confidence, raw: json };
}






