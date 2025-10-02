import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Get environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface RefreshBaseRequest {
  site_host: string;
  new_base?: string; // Optional: if provided, update Supabase first
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Parse request
    const { site_host, new_base }: RefreshBaseRequest = await req.json();

    if (!site_host) {
      return new Response(
        JSON.stringify({ ok: false, error: 'site_host is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // If new_base provided, update Supabase first
    if (new_base) {
      const { error: updateError } = await supabase
        .from('site_settings')
        .update({ collections_base: new_base })
        .eq('site_host', site_host);

      if (updateError) {
        console.error('Failed to update Supabase:', updateError);
        return new Response(
          JSON.stringify({ ok: false, error: 'Failed to update Supabase', details: updateError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Fetch site settings to get WP credentials
    const { data: settings, error: settingsError } = await supabase
      .from('site_settings')
      .select('wp_url, wp_hmac_secret, collections_base')
      .eq('site_host', site_host)
      .single();

    if (settingsError || !settings) {
      console.error('Failed to fetch site settings:', settingsError);
      return new Response(
        JSON.stringify({ ok: false, error: 'Site not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { wp_url, wp_hmac_secret, collections_base } = settings;

    if (!wp_hmac_secret) {
      return new Response(
        JSON.stringify({ ok: false, error: 'WP HMAC secret not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Prepare HMAC request to WordPress
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({});
    const payload = `${timestamp}.${body}`;

    // Create HMAC signature
    const hmac = createHmac('sha256', wp_hmac_secret);
    hmac.update(payload);
    const signature = hmac.digest('hex');

    // Call WordPress /refresh-base endpoint
    const wpResponse = await fetch(`${wp_url}/wp-json/secure-collections/v1/refresh-base`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sc-timestamp': timestamp.toString(),
        'x-sc-signature': signature,
      },
      body: body
    });

    const wpResult = await wpResponse.json();

    if (!wpResponse.ok || !wpResult.ok) {
      console.error('WordPress refresh failed:', wpResult);
      return new Response(
        JSON.stringify({ 
          ok: false, 
          error: 'WordPress refresh failed', 
          wp_error: wpResult.error || wpResult 
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Success!
    return new Response(
      JSON.stringify({
        ok: true,
        message: 'Collection base refreshed successfully',
        site_host,
        collections_base: wpResult.base || collections_base,
        updated_in_supabase: !!new_base,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in collections-refresh-base:', error);
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
