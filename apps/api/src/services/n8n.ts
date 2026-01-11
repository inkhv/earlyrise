export type N8nCuratorResponse = {
  reply?: string;
  transcript?: string;
  confidence?: number | null;
  raw?: any;
};

export async function postJson(
  url: string,
  body: unknown,
  timeoutMs = 25000
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}


