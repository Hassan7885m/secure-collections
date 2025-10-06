import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.3";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_SITE_HOST         = Deno.env.get("DEFAULT_SITE_HOST")!;
const WP_PUSH_URL               = Deno.env.get("WP_PUSH_URL")!;
const WP_HMAC_SECRET            = Deno.env.get("WP_HMAC_SECRET")!;

type PublishInput = { slug: string; site_host?: string };

function requireBearer(req: Request) {
  const a = req.headers.get("authorization") || "";
  const t = a.toLowerCase().startsWith("bearer ") ? a.slice(7) : "";
  if (t !== SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ok:false,error:"unauthorized"}), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }
  return null;
}

async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  const b = new Uint8Array(sig);
  return Array.from(b).map(x => x.toString(16).padStart(2,"0")).join("");
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok:true, fn:"collections-publish" }), {
      headers: { "content-type":"application/json" },
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
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession:false } });

  // 1) Load collection
  const { data: col, error } = await supabase
    .from("collections")
    .select("*")
    .eq("site_host", site_host)
    .eq("slug", input.slug)
    .maybeSingle();

  if (error) return new Response(JSON.stringify({ ok:false, error:error.message }), { status:500, headers:{ "content-type":"application/json" }});
  if (!col)    return new Response(JSON.stringify({ ok:false, error:"collection_not_found" }), { status:404, headers:{ "content-type":"application/json" }});

  // 2) Build payload
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
    product_ids: col.assigned_product_ids || [],
    sort_by: col.sort_by || "popularity",
    paginate: col.paginate || 24,
    version: col.version || 1,
    updated_at: col.updated_at,
  };
  const body = JSON.stringify(payload);

  // 3) HMAC sign with timestamp
  const ts = Math.floor(Date.now() / 1000).toString(); // seconds
  const toSign = `${ts}.${body}`;
  const sig = await hmacHex(WP_HMAC_SECRET, toSign);

  const headers = {
    "content-type": "application/json",
    "x-sc-timestamp": ts,
    "x-sc-signature": sig,
  };

  // 4) Push to WordPress
  const res = await fetch(WP_PUSH_URL, { method:"POST", headers, body });
  const text = await res.text();

  // 5) Log result
  await supabase.from("push_log").insert({
    slug: col.slug,
    version_pushed: col.version ?? 1,
    http_status: res.status,
    response_body: (() => { try { return JSON.parse(text); } catch { return { text }; } })(),
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ ok:false, wp_status:res.status, wp_body:text }), {
      status: 502, headers: { "content-type":"application/json" },
    });
  }

  // 6) Mark published
  await supabase
    .from("collections")
    .update({ status:"published", updated_at:new Date().toISOString() })
    .eq("site_host", site_host)
    .eq("slug", input.slug);

  return new Response(JSON.stringify({ ok:true, pushed:true, wp_status:res.status }), {
    headers: { "content-type":"application/json" },
  });
});
