// minimal handler so Supabase can deploy the function
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(() =>
  new Response(JSON.stringify({ ok: true, fn: "collections-upsert" }), {
    headers: { "content-type": "application/json" },
  })
);
