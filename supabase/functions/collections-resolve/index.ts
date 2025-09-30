// supabase/functions/collections-resolve/index.ts
// Supports: op="config" (HMAC), op="render" (HMAC), op="resolve" (Bearer service_role)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.3";

const PROJECT_URL       = Deno.env.get("PROJECT_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SERVICE_ROLE_KEY")!;
const DEFAULT_SITE_HOST = Deno.env.get("DEFAULT_SITE_HOST") || "";
const WP_HMAC_SECRET    = Deno.env.get("WP_HMAC_SECRET") || "";

// Optional Woo creds for SKU → product ID lookups
const WOO_BASE_URL = Deno.env.get("WOO_BASE_URL") || "";
const WOO_CK       = Deno.env.get("WOO_CK") || "";
const WOO_CS       = Deno.env.get("WOO_CS") || "";

type ResolveInput = {
  op?: "resolve" | "render" | "config";
  slug?: string;
  site_host?: string;
  runtime_resolve?: boolean;
};

type WooProduct = { id: number; sku: string };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ----------------- Auth helpers -----------------

/** Admin-only: Bearer must equal service role key */
function requireBearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7) : "";
  if (token !== SERVICE_ROLE_KEY) return json(401, { ok: false, error: "unauthorized" });
  return null;
}

/** Runtime HMAC: verify x-sc-timestamp + x-sc-signature against `${ts}.${rawBody}` */
async function verifyHmacFromHeaders(headers: Headers, rawBody: string) {
  if (!WP_HMAC_SECRET) return json(500, { ok: false, error: "server_missing_hmac_secret" });

  const ts = headers.get("x-sc-timestamp");
  const sig = headers.get("x-sc-signature");
  if (!ts || !sig) return json(401, { ok: false, error: "missing_signature" });

  const now = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 300) {
    return json(401, { ok: false, error: "stale_signature" });
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(WP_HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${rawBody}`));
  const hex = Array.from(new Uint8Array(signed)).map(b => b.toString(16).padStart(2, "0")).join("");

  if (hex !== sig) return json(401, { ok: false, error: "bad_signature" });
  return null;
}

// ----------------- Woo helper -----------------

async function fetchWooBySku(sku: string): Promise<WooProduct | null> {
  if (!WOO_BASE_URL || !WOO_CK || !WOO_CS) return null;
  try {
    const url = new URL("/wp-json/wc/v3/products", WOO_BASE_URL);
    url.searchParams.set("sku", sku);
    url.searchParams.set("consumer_key", WOO_CK);
    url.searchParams.set("consumer_secret", WOO_CS);

    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const arr = (await res.json()) as WooProduct[];
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  } catch {
    return null;
  }
}

// ----------------- Handler -----------------

serve(async (req) => {
  // Health check
  if (req.method !== "POST") {
    return json(200, { ok: true, fn: "collections-resolve" });
  }

  // Read body ONCE (avoid "Body is unusable")
  const raw = await req.text();
  let body: ResolveInput;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const op = body.op || "resolve";
  const site_host = (body.site_host || DEFAULT_SITE_HOST || "").trim();
  if (!site_host) return json(400, { ok: false, error: "site_host_required" });

  const supabase = createClient(PROJECT_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ---------- CONFIG (runtime) ----------
  if (op === "config") {
    const unauth = await verifyHmacFromHeaders(req.headers, raw);
    if (unauth) return unauth;

    const { data: st, error: e } = await supabase
      .from("site_settings")
      .select("collections_enabled, collections_base, maintenance_message")
      .eq("site_host", site_host)
      .maybeSingle();

    if (e) return json(500, { ok: false, error: e.message });
    if (!st) return json(404, { ok: false, error: "settings_not_found" });

    return json(200, { ok: true, settings: st });
  }

  // ---------- RENDER (runtime) ----------
  if (op === "render") {
    const unauth = await verifyHmacFromHeaders(req.headers, raw);
    if (unauth) return unauth;

    // 1) settings
    const { data: st, error: se } = await supabase
      .from("site_settings")
      .select("collections_enabled, collections_base, maintenance_message")
      .eq("site_host", site_host)
      .maybeSingle();

    if (se) return json(500, { ok: false, error: se.message });
    if (!st) return json(404, { ok: false, error: "settings_not_found" });

    // 2) collection
    if (!body.slug) return json(400, { ok: false, error: "slug_required" });

    const { data: col, error: ce } = await supabase
      .from("collections")
      .select("*")
      .eq("site_host", site_host)
      .eq("slug", body.slug)
      .maybeSingle();

    if (ce) return json(500, { ok: false, error: ce.message });
    if (!col) return json(404, { ok: false, error: "collection_not_found" });

    // Optional runtime refresh of product IDs (SKU -> Woo ID)
    if (body.runtime_resolve && Array.isArray(col.assigned_skus) && col.assigned_skus.length) {
      const ids: number[] = [];
      for (const sku of col.assigned_skus) {
        const p = await fetchWooBySku(sku);
        if (p?.id) ids.push(p.id);
        // Small delay to be nice to Woo
        await new Promise(r => setTimeout(r, 80));
      }
      // Update DB (best-effort; ignore error in response)
      await supabase
        .from("collections")
        .update({ assigned_product_ids: ids, updated_at: new Date().toISOString() })
        .eq("site_host", site_host)
        .eq("slug", body.slug);
      (col as any).assigned_product_ids = ids;
    }

    // Minimal payload for WP template
    const payload = {
      slug: col.slug,
      title: col.title,
      h1: col.h1,
      meta_title: col.meta_title,
      meta_description: col.meta_description,
      canonical: col.canonical,
      description_html: col.description_html,
      faq: col.faq ?? [],
      assigned_skus: col.assigned_skus ?? [],
      assigned_product_ids: col.assigned_product_ids ?? [],
      sort_by: col.sort_by ?? "popularity",
      paginate: col.paginate ?? 24,
      status: col.status,
      version: col.version ?? 1,
      updated_at: col.updated_at,
    };

    return json(200, { ok: true, settings: st, collection: payload });
  }

  // ---------- RESOLVE (admin) ----------
  // default op if none given; requires Bearer SERVICE_ROLE_KEY
  const unauth = requireBearer(req);
  if (unauth) return unauth;

  if (!body.slug) return json(400, { ok: false, error: "slug_required" });

  // load collection
  const { data: col, error: ge } = await supabase
    .from("collections")
    .select("*")
    .eq("site_host", site_host)
    .eq("slug", body.slug)
    .maybeSingle();

  if (ge) return json(500, { ok: false, error: ge.message });
  if (!col) return json(404, { ok: false, error: "collection_not_found" });

  const skus: string[] = Array.isArray(col.assigned_skus) ? col.assigned_skus : [];
  if (!skus.length) {
    await supabase
      .from("collections")
      .update({ assigned_product_ids: [], updated_at: new Date().toISOString() })
      .eq("site_host", site_host)
      .eq("slug", body.slug);
    return json(200, { ok: true, count: 0, missing: [], ids: [] });
  }

  const foundIds: number[] = [];
  const missing: string[] = [];

  for (const sku of skus) {
    const prod = await fetchWooBySku(sku);
    if (prod?.id) foundIds.push(prod.id);
    else missing.push(sku);
    await new Promise(r => setTimeout(r, 120));
  }

  const { error: ue } = await supabase
    .from("collections")
    .update({ assigned_product_ids: foundIds, updated_at: new Date().toISOString() })
    .eq("site_host", site_host)
    .eq("slug", body.slug);

  if (ue) return json(500, { ok: false, error: ue.message });

  return json(200, { ok: true, count: foundIds.length, missing, ids: foundIds });
});
