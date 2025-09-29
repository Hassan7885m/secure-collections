import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.3";

const PROJECT_URL = Deno.env.get("PROJECT_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const DEFAULT_SITE_HOST = Deno.env.get("DEFAULT_SITE_HOST") || "hassan.skillyweb.com";

const WOO_BASE_URL = Deno.env.get("WOO_BASE_URL")!;
const WOO_CK = Deno.env.get("WOO_CK")!;
const WOO_CS = Deno.env.get("WOO_CS")!;

type ResolveInput = {
  slug: string;
  site_host?: string;
};

type WooProduct = { id: number; sku: string };

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

async function fetchWooBySku(sku: string): Promise<WooProduct | null> {
  // /wp-json/wc/v3/products?sku=<sku>
  const url = new URL("/wp-json/wc/v3/products", WOO_BASE_URL);
  url.searchParams.set("sku", sku);
  url.searchParams.set("consumer_key", WOO_CK);
  url.searchParams.set("consumer_secret", WOO_CS);

  const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
  if (!res.ok) {
    console.warn("Woo error", sku, res.status);
    return null;
  }
  const arr = (await res.json()) as WooProduct[];
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: true, fn: "collections-resolve" }), {
      headers: { "content-type": "application/json" },
    });
  }

  const unauth = requireBearer(req);
  if (unauth) return unauth;

  let body: ResolveInput;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!body?.slug) {
    return new Response(JSON.stringify({ ok: false, error: "slug_required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const site_host = body.site_host || DEFAULT_SITE_HOST;

  const supabase = createClient(PROJECT_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 1) Load collection
  const { data: col, error: getErr } = await supabase
    .from("collections")
    .select("*")
    .eq("site_host", site_host)
    .eq("slug", body.slug)
    .maybeSingle();

  if (getErr) {
    return new Response(JSON.stringify({ ok: false, error: getErr.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  if (!col) {
    return new Response(JSON.stringify({ ok: false, error: "collection_not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const skus: string[] = Array.isArray(col.assigned_skus) ? col.assigned_skus : [];
  if (!skus.length) {
    // Nothing to resolve; clear any previous IDs
    await supabase
      .from("collections")
      .update({ assigned_product_ids: [], updated_at: new Date().toISOString() })
      .eq("site_host", site_host)
      .eq("slug", body.slug);
    return new Response(JSON.stringify({ ok: true, count: 0, missing: [] }), {
      headers: { "content-type": "application/json" },
    });
  }

  // 2) Resolve each SKU → Woo product id
  const foundIds: number[] = [];
  const missing: string[] = [];

  // Serial to keep it simple & avoid Woo rate limits. You can parallelize later.
  for (const sku of skus) {
    try {
      const prod = await fetchWooBySku(sku);
      if (prod?.id) foundIds.push(prod.id);
      else missing.push(sku);
      // small delay to be gentle with Woo
      await new Promise((r) => setTimeout(r, 120));
    } catch {
      missing.push(sku);
    }
  }

  // 3) Save result
  const { error: updErr } = await supabase
    .from("collections")
    .update({
      assigned_product_ids: foundIds,
      updated_at: new Date().toISOString(),
    })
    .eq("site_host", site_host)
    .eq("slug", body.slug);

  if (updErr) {
    return new Response(JSON.stringify({ ok: false, error: updErr.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ ok: true, count: foundIds.length, missing, ids: foundIds }),
    { headers: { "content-type": "application/json" } }
  );
});
