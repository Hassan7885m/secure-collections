import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.3";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_SITE_HOST         = Deno.env.get("DEFAULT_SITE_HOST") || "hassan.skillyweb.com";
const WP_TOGGLE_URL             = Deno.env.get("WP_TOGGLE_URL")!;
const WP_HMAC_SECRET            = Deno.env.get("WP_HMAC_SECRET")!;

type ToggleBody = { enabled: boolean; site_host?: string };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function requireBearer(req: Request) {
  const a = req.headers.get("authorization") || "";
  const t = a.toLowerCase().startsWith("bearer ") ? a.slice(7) : "";
  if (t !== SUPABASE_SERVICE_ROLE_KEY) return json(401, { ok:false, error:"unauthorized" });
  return null;
}
async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

serve(async (req) => {
  if (req.method !== "POST") {
    return json(200, { ok:true, fn:"collections-toggle" });
  }

  // Admin-only
  const unauth = requireBearer(req);
  if (unauth) return unauth;

  let body: ToggleBody;
  try { body = await req.json(); } catch { return json(400, { ok:false, error:"invalid_json" }); }
  if (typeof body.enabled !== "boolean") return json(400, { ok:false, error:"enabled_boolean_required" });

  const site_host = body.site_host || DEFAULT_SITE_HOST;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession:false } });

  // 1) Update Supabase settings
  const { error: e1 } = await supabase
    .from("site_settings")
    .update({ collections_enabled: body.enabled, updated_at: new Date().toISOString() })
    .eq("site_host", site_host);
  if (e1) return json(500, { ok:false, error:e1.message });

  // 2) Mirror to WordPress (HMAC, timestamped)
  const payload = { enabled: body.enabled, site_host };
  const ts = Math.floor(Date.now()/1000).toString();
  const toSign = `${ts}.${JSON.stringify(payload)}`;
  const sig = await hmacHex(WP_HMAC_SECRET, toSign);

  const wpRes = await fetch(WP_TOGGLE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sc-timestamp": ts,
      "x-sc-signature": sig,
    },
    body: JSON.stringify(payload),
  });

  const text = await wpRes.text();
  if (!wpRes.ok) {
    return json(502, { ok:false, wp_status: wpRes.status, wp_body: text });
  }

  return json(200, { ok:true, mirrored:true, wp_status: wpRes.status });
});
