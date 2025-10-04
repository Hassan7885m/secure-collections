import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const HMAC_SECRET = Deno.env.get('WP_HMAC_SECRET') || '';

/**
 * Secure Collections - Resolve Edge Function
 * 
 * Handles two operations:
 * 1. 'config' - Returns site settings (collections_enabled, maintenance_message)
 * 2. 'render' - Returns collection data for rendering on WordPress
 * 
 * NOTE: collections_base is now managed in WordPress admin, not here
 */

Deno.serve(async (req) => {
  // Verify HMAC authentication
  const timestamp = req.headers.get('x-sc-timestamp');
  const signature = req.headers.get('x-sc-signature');
  
  if (!timestamp || !signature) {
    return new Response(JSON.stringify({ 
      ok: false, 
      error: 'Missing authentication headers' 
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Verify timestamp (5 minute window)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return new Response(JSON.stringify({ 
      ok: false, 
      error: 'Request timestamp expired' 
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Get request body
  const body = await req.text();
  
  // Verify HMAC signature
  const encoder = new TextEncoder();
  const keyData = encoder.encode(HMAC_SECRET);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const messageData = encoder.encode(timestamp + '.' + body);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, messageData);
  const computedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  if (computedSignature !== signature) {
    return new Response(JSON.stringify({ 
      ok: false, 
      error: 'Invalid signature' 
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Parse request
  const data = JSON.parse(body);
  const { op, slug, site_host } = data;
  
  // Create Supabase client
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
  
  try {
    // Operation: Get site configuration
    if (op === 'config') {
      const { data: settings, error } = await supabase
        .from('site_settings')
        .select('collections_enabled, maintenance_message')
        .eq('site_host', site_host)
        .single();
      
      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
        throw error;
      }
      
      return new Response(JSON.stringify({
        ok: true,
        settings: {
          collections_enabled: settings?.collections_enabled ?? true,
          maintenance_message: settings?.maintenance_message ?? null
          // collections_base removed - now set in WordPress admin
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Operation: Get collection for rendering
    if (op === 'render') {
      // Get site settings
      const { data: settings } = await supabase
        .from('site_settings')
        .select('collections_enabled')
        .eq('site_host', site_host)
        .single();
      
      // Get collection data
      const { data: collection, error } = await supabase
        .from('collections')
        .select('*')
        .eq('site_host', site_host)
        .eq('slug', slug)
        .eq('status', 'published')
        .single();
      
      if (error || !collection) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'Collection not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({
        ok: true,
        settings: {
          collections_enabled: settings?.collections_enabled ?? true
        },
        collection: collection
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Unknown operation
    return new Response(JSON.stringify({
      ok: false,
      error: 'Unknown operation'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      ok: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
