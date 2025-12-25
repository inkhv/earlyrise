/**
 * Simple seed script using Supabase REST (PostgREST).
 *
 * Required env vars:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 *
 * What it seeds:
 * - one global settings row (if missing)
 * - one draft challenge row (if none exist)
 *
 * Notes:
 * - Works without pnpm (run via `node supabase/seed/seed.mjs`)
 * - Works on Node versions without global fetch (fallback to http/https).
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

async function requestJson(url, { method = "GET", headers = {}, body } = {}) {
  const hasFetch = typeof globalThis.fetch === "function";
  if (hasFetch) {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) {
      throw new Error(`${method} ${url} failed: ${res.status} ${res.statusText}\n${text}`);
    }
    return json;
  }

  // Fallback for Node < 18 (no global fetch)
  const { URL } = await import("node:url");
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const httpMod = await import(isHttps ? "node:https" : "node:http");

  const payload = body ?? null;
  const reqHeaders = { ...headers };
  if (payload && !reqHeaders["Content-Length"]) {
    reqHeaders["Content-Length"] = Buffer.byteLength(payload);
  }

  return await new Promise((resolve, reject) => {
    const req = httpMod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        headers: reqHeaders
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`${method} ${url} failed: ${res.statusCode}\n${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sb(path, { method = "GET", body } = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    apikey: SERVICE_ROLE,
    Authorization: `Bearer ${SERVICE_ROLE}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };
  return await requestJson(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function nowPlusDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

async function main() {
  // settings: ensure one global row exists
  const settings = await sb("/settings?scope=eq.global&select=id", { method: "GET" });
  if (!settings?.length) {
    await sb("/settings", {
      method: "POST",
      body: [
        {
          scope: "global",
          challenge_active: true,
          voice_feedback_enabled: true,
          checkin_window_minutes: 30,
          pricing_mode: "credits",
          pricing_json: {
            currency: "EUR",
            base_price: 20,
            tiers: [
              { participants: 10, credit: 2 },
              { participants: 20, credit: 5 },
              { participants: 40, credit: 10 }
            ]
          }
        }
      ]
    });
    console.log("Seeded: settings (global)");
  } else {
    console.log("Skip: settings (global) already exists");
  }

  // challenges: ensure at least one draft exists
  const challenges = await sb("/challenges?select=id&limit=1", { method: "GET" });
  if (!challenges?.length) {
    await sb("/challenges", {
      method: "POST",
      body: [
        {
          title: "EarlyRise Challenge (Draft)",
          starts_at: nowPlusDays(1),
          ends_at: nowPlusDays(15),
          status: "draft",
          rules_snapshot: {
            checkin_window_minutes: 30,
            note: "Draft rules snapshot"
          }
        }
      ]
    });
    console.log("Seeded: challenges (draft)");
  } else {
    console.log("Skip: challenge already exists");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


