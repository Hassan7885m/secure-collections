// supabase/functions/collections-upsert/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.3";

type UpsertBody = {
  slug: string;
  site_host?: string;
  title?: string;
  h1?: string;
  meta_title?: string;
  meta_description?: string;
  canonical?: string;
  description_html?: string;
  faq?: Array<{ q: string; a: string }>;
  rules?: unknown;
  assigned_skus?: string[];
  sort_by?: "popularity" | "rating" | "price_asc" | "price_desc" | "newest";
  paginate?: number;
};

const PROJECT_URL = Deno.env.get("PROJECT_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const DEFAULT_SITE_HOST = Deno.env.get("DEFAULT_SITE_HOST") || "hassan.skillyweb.com";

// Optional: simple auth so only callers who know the service key can hit this.
// If you prefer, replace this with a separate ADMIN_FUNCTION_KEY secret.
function requireBearer(req: Request) {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.toLowerCase().startsWith("bearer ")
    ? hdr.slice(7)
    : "";
  if (!token || token !== SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: true, fn: "collections-upsert" }), {
      headers: { "content-type": "application/json" },
    });
  }

  // Require auth
  const unauth = requireBearer(req);
  if (unauth) return unauth;

  let body: UpsertBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!body?.slug || typeof body.slug !== "string") {
    return new Response(JSON.stringify({ ok: false, error: "slug_required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const site_host = body.site_host || DEFAULT_SITE_HOST;

  const supabase = createClient(PROJECT_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Build the row to upsert. Status remains draft here.
  const row = {
    site_host,
    slug: body.slug,
    title: body.title ?? null,
    h1: body.h1 ?? null,
    meta_title: body.meta_title ?? null,
    meta_description: body.meta_description ?? null,
    canonical: body.canonical ?? null,
    description_html: body.description_html ?? null,
    faq: body.faq ?? null,
    rules: body.rules ?? null,
    assigned_skus: body.assigned_skus ?? null,
    sort_by: body.sort_by ?? "popularity",
    paginate: body.paginate ?? 24,
    status: "draft" as const,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("collections")
    .upsert(row, { onConflict: "site_host,slug" })
    .select()
    .maybeSingle();

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  });
});
