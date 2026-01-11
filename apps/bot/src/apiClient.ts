export type ApiResponse<T = any> = { status: number; ok: boolean; json: T | null; text: string };

export function createApiClient(baseUrl: string) {
  return async function api<T = any>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  };
}


