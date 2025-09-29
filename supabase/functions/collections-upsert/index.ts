POST https://<PR>.functions.supabase.co/collections-upsert
Authorization: Bearer <SERVICE_ROLE_KEY>
Content-Type: application/json

{
  "slug": "summer-sunglasses",
  "site_host": "hassan.skillyweb.com",
  "title": "Summer Sunglasses",
  "h1": "Summer Sunglasses",
  "meta_title": "Summer Sunglasses — Hassan",
  "meta_description": "Curated styles…",
  "canonical": "https://hassan.skillyweb.com/collections/summer-sunglasses",
  "description_html": "<p>Beach-ready shades.</p>",
  "faq": [{"q":"Shipping?","a":"Worldwide."}],
  "assigned_skus": ["SUN123","SUN456"],
  "sort_by": "popularity",
  "paginate": 24
}
