// Wordcatcher fetch proxy: returns the HTML of a public article page with CORS headers,
// so the static site (GitHub Pages) can load articles that reader services block.
// Usage: GET https://<worker>/?url=https://www.theguardian.com/...

const ALLOWED_ORIGINS = ['https://vmaiorov-collab.github.io', 'http://localhost:3000'];
const MAX_BYTES = 4 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Vary': 'Origin',
});

const fail = (status, msg, origin) =>
  new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'content-type': 'application/json', ...(origin ? cors(origin) : {}) },
  });

function isBlockedHost(h) {
  h = h.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':') || h.startsWith('[')) return true; // IPv6 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true; // IPv4 literal
  return !h.includes('.');
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) return fail(403, 'Origin not allowed', '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET') return fail(405, 'GET only', origin);

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('url') || ''); } catch { return fail(400, 'Bad url', origin); }
    if (!/^https?:$/.test(target.protocol) || isBlockedHost(target.hostname)) return fail(400, 'Unsupported url', origin);

    let r;
    try {
      r = await fetch(target.href, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow',
        cf: { cacheTtl: 300 },
      });
    } catch { return fail(502, 'Could not reach the site', origin); }

    const type = r.headers.get('content-type') || '';
    if (!r.ok) return fail(r.status, 'The site answered ' + r.status, origin);
    if (!/text\/html|application\/xhtml/i.test(type)) return fail(415, 'Not an HTML page', origin);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return fail(413, 'Page too large', origin);
    return new Response(buf, { status: 200, headers: { 'content-type': type, 'X-Final-Url': r.url, ...cors(origin) } });
  },
};
