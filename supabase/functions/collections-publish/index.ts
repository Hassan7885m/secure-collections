import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.3";

const PROJECT_URL = Deno.env.get("PROJECT_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const DEFAULT_SITE_HOST = Deno.env.get("DEFAULT_SITE_HOST")!;

const WP_PUSH_URL = Deno.env.get("WP_PUSH_URL")!;
const WP_HMAC_SECRET = Deno.env.get("WP_HMAC_SECRET") || ""; // if using HMAC
const WP_APP_USER = Deno.env.get("WP_APP_USER") || "";
const WP_APP_PASSWORD = Deno.env.get("WP_APP_PASSWORD") || "";

type PublishInput = { slug: string; site_host?: string };

function requireBearer(req: Request) {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice(7) : "";
  if (!token || token !== SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

function hmacSign(secret: string, body: string) {
  const key = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return key.then(k => crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)))
    .then(sig => {
      const bytes = new Uint8Array(sig);
      return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
    });
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: true, fn: "collections-publish" }), {
      headers: { "content-type": "application/json" },
    });
  }

  const unauth = requireBearer(req);
  if (unauth) return unauth;

  let input: PublishInput;
  try { input = await req.json(); } catch {
    return new Response(JSON.stringify({ ok:false, error:"invalid_json" }), { status:400, headers:{ "content-type":"application/json" }});
  }
  if (!input?.slug) {
    return new Response(JSON.stringify({ ok:false, error:"slug_required" }), { status:400, headers:{ "content-type":"application/json" }});
  }
  const site_host = input.site_host || DEFAULT_SITE_HOST;

  const supabase = createClient(PROJECT_URL, SERVICE_ROLE_KEY, { auth: { persistSession:false } });

  // 1) Load collection
  const { data: col, error } = await supabase
    .from("collections")
    .select("*")
    .eq("site_host", site_host)
    .eq("slug", input.slug)
    .maybeSingle();

  if (error) return new Response(JSON.stringify({ ok:false, error:error.message }), { status:500, headers:{ "content-type":"application/json" }});
  if (!col) return new Response(JSON.stringify({ ok:false, error:"collection_not_found" }), { status:404, headers:{ "content-type":"application/json" }});

  // 2) Build payload for WP
  const payload = {
    slug: col.slug,
    site_host: col.site_host,
    title: col.title,
    h1: col.h1,
    meta_title: col.meta_title,
    meta_description: col.meta_description,
    canonical: col.canonical,
    description_html: col.description_html,
    faq: col.faq,
    product_ids: col.assigned_product_ids || [], // resolved IDs
    sort_by: col.sort_by || "popularity",
    paginate: col.paginate || 24,
    version: col.version || 1,
    updated_at: col.updated_at,
  };
  const bodyStr = JSON.stringify(payload);

  // 3) Prepare auth
  const headers: Record<string,string> = { "content-type": "application/json" };
  if (WP_HMAC_SECRET) {
    const sig = await hmacSign(WP_HMAC_SECRET, bodyStr);
    headers["x-sc-signature"] = sig;
  } else if (WP_APP_USER && WP_APP_PASSWORD) {
    const basic = btoa(`${WP_APP_USER}:${WP_APP_PASSWORD}`);
    headers["authorization"] = `Basic ${basic}`;
  } else {
    return new Response(JSON.stringify({ ok:false, error:"no_wp_auth_configured" }), { status:500, headers:{ "content-type":"application/json" }});
  }

  // 4) Push to WordPress
  const wpRes = await fetch(WP_PUSH_URL, { method:"POST", headers, body: bodyStr });
  const wpText = await wpRes.text();

  // 5) Log push
  await supabase.from("push_log").insert({
    slug: col.slug,
    version_pushed: col.version ?? 1,
    http_status: wpRes.status,
    response_body: (() => { try { return JSON.parse(wpText); } catch { return { text: wpText }; } })(),
  });

  if (!wpRes.ok) {
    return new Response(JSON.stringify({ ok:false, wp_status: wpRes.status, wp_body: wpText }), { status:502, headers:{ "content-type":"application/json" }});
  }

  // 6) Mark published
  await supabase
    .from("collections")
    .update({ status: "published", updated_at: new Date().toISOString() })
    .eq("site_host", site_host)
    .eq("slug", input.slug);

  return new Response(JSON.stringify({ ok:true, pushed:true, wp_status: wpRes.status }), { headers:{ "content-type":"application/json" }});
});
