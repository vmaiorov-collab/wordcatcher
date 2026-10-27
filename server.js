const express = require('express');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || ''; // optional: raises the free daily limit

// ---------- helpers ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('That does not look like a valid link.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http/https links are supported.');
  const { address } = await dns.lookup(url.hostname);
  if (isPrivateIp(address)) throw new Error('Links to local or private addresses are not allowed.');
  return url;
}

// Skip tracking pixels, icons and logos by their file path, not by words inside names ("silicon").
const JUNK_IMG = /(^|[\/_.-])(pixel|spacer|blank|1x1|tracking|beacon|sprite|logo|icons?|avatar|favicon|emoji)([\/_.-]|$)/i;

function absUrl(u, base) {
  try {
    const x = new URL(u, base);
    if (x.protocol === 'http:') x.protocol = 'https:'; // http images are blocked on an https page
    return x.protocol === 'https:' ? x.href : '';
  } catch {
    return '';
  }
}

const usableImage = (src) => !!src && !/\.svg(\?|$)/i.test(src) && !JUNK_IMG.test(src.split('?')[0]);

// From a srcset take the smallest picture that is at least 800px wide, else the largest.
function pickSrcset(set) {
  const items = set
    .split(/,\s+/)
    .map((x) => x.trim().split(/\s+/))
    .filter((a) => a[0])
    .map(([u, d]) => ({
      u,
      w: /w$/.test(d || '') ? parseInt(d, 10) : /x$/.test(d || '') ? parseFloat(d) * 400 : 0,
    }));
  if (!items.length) return '';
  const big = items.filter((i) => i.w >= 800).sort((a, b) => a.w - b.w)[0];
  return (big || items.sort((a, b) => b.w - a.w)[0]).u;
}

function imageBlock(img, caption, base) {
  const attr = (n) => img.getAttribute(n) || '';
  const raw = [pickSrcset(attr('srcset') || attr('data-srcset')), attr('data-src'), attr('data-lazy-src'), attr('data-original'), attr('src')].find(
    (c) => c && !/^data:/i.test(c)
  );
  const src = raw ? absUrl(raw, base) : '';
  if (!usableImage(src)) return null;
  const w = parseInt(attr('width'), 10) || 0;
  const h = parseInt(attr('height'), 10) || 0;
  if ((w && w < 120) || (h && h < 80)) return null;
  return { type: 'img', src, alt: attr('alt').trim(), caption: (caption || '').replace(/\s+/g, ' ').trim(), w, h };
}

const imgStem = (u) => u.split('?')[0].split('/').pop().replace(/(\.[a-z0-9]+)+$/i, '');

function extractArticle(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl, virtualConsole: new VirtualConsole() });
  const meta = dom.window.document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
  const metaImg = ((meta && meta.getAttribute('content')) || '').trim();
  const article = new Readability(dom.window.document).parse();
  if (!article || !article.content) return null;

  const content = new JSDOM(article.content).window.document;
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const blocks = [];
  content.querySelectorAll('h1,h2,h3,h4,p,li,figure,img').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'figure' || tag === 'img') {
      if (tag === 'img' && el.closest('figure')) return; // handled with its figure
      const img = tag === 'img' ? el : el.querySelector('img');
      if (!img) return;
      const cap = tag === 'figure' ? (el.querySelector('figcaption') || {}).textContent || '' : '';
      const b = imageBlock(img, cap, pageUrl);
      if (b) blocks.push(b);
      return;
    }
    if (el.closest('figure')) return; // captions travel with their picture
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (tag === 'h1') return; // the title is shown separately
    if (!blocks.some((b) => b.type !== 'img') && /^h\d$/.test(tag)) {
      // Readability turns the page h1 into h2; drop it if it repeats the title
      const t = norm(article.title || '');
      const h = norm(text);
      if (t && h && (t.includes(h) || h.includes(t))) return;
    }
    blocks.push({ type: tag === 'p' || tag === 'li' ? 'p' : 'h', text });
  });
  // a login wall or cookie page is not an article: it has a line or two of text
  const wordCount = blocks.reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0), 0);
  if (blocks.filter((b) => b.type === 'p').length < 2 || wordCount < 50) return null;

  // the main picture usually sits outside the article body: take it from the page's share image
  const lead = metaImg ? absUrl(metaImg, pageUrl) : '';
  if (usableImage(lead) && !blocks.slice(0, 3).some((b) => b.type === 'img' && imgStem(b.src) === imgStem(lead))) {
    blocks.unshift({ type: 'img', src: lead, alt: (article.title || '').trim(), caption: '', w: 0, h: 0, lead: true });
  }

  return {
    title: (article.title || '').trim(),
    byline: (article.byline || '').trim(),
    site: (article.siteName || new URL(pageUrl).hostname).trim(),
    blocks,
  };
}

// ---------- API ----------

app.get('/api/article', async (req, res) => {
  try {
    const url = await assertPublicUrl(req.query.url);
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`The site responded with status ${r.status}. Try pasting the text instead.`);
    const html = await r.text();
    const article = extractArticle(html, r.url || url.href);
    if (!article) throw new Error('Could not find an article on that page. Try pasting the text instead.');
    res.json(article);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to load the article.' });
  }
});

const hasLetters = (t) => /\p{L}/u.test(t || '');

// Google's public web endpoint (unofficial, no key): good single-word quality plus other meanings.
async function googleTranslate(q, from, to) {
  const p = new URLSearchParams({ client: 'gtx', sl: from, tl: to, q });
  p.append('dt', 't');
  p.append('dt', 'bd');
  const r = await fetch(`https://translate.googleapis.com/translate_a/single?${p}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`google ${r.status}`);
  const d = await r.json();
  const translation = (d[0] || []).map((x) => x[0]).join('').trim();
  if (!hasLetters(translation)) throw new Error('empty');
  const alts = [];
  if (!/\s/.test(q)) {
    (d[1] || []).forEach((g) => (g[1] || []).forEach((a) => {
      if (a.toLowerCase() !== translation.toLowerCase() && !alts.includes(a)) alts.push(a);
    }));
  }
  return { translation, alts: alts.slice(0, 3), by: 'google' };
}

// Same Google engine on another host: works when the first one is rate-limited.
async function googleTranslate2(q, from, to) {
  const p = new URLSearchParams({ client: 'dict-chrome-ex', sl: from, tl: to, q });
  const r = await fetch(`https://clients5.google.com/translate_a/t?${p}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`google2 ${r.status}`);
  const d = await r.json();
  let t = Array.isArray(d) ? d[0] : '';
  if (Array.isArray(t)) t = t[0];
  t = String(t || '').trim();
  if (!hasLetters(t) || t.toLowerCase() === q.toLowerCase()) throw new Error('empty');
  return { translation: t, alts: [], by: 'google' };
}

// MyMemory's top answer for a single word is often junk ("Дафф, Хилари" for "devoted",
// a Wikipedia title), so its candidates are scored instead of trusting the first one.
function pickMyMemory(text, d) {
  const q = text.trim().toLowerCase();
  const lower = text === text.toLowerCase();
  const cands = [{ segment: text, translation: d.responseData && d.responseData.translatedText, 'created-by': '', match: d.responseData && d.responseData.match }]
    .concat(d.matches || []);
  let best = null;
  let bestScore = -Infinity;
  cands.forEach((m) => {
    const t = String(m.translation || '').trim();
    if (!hasLetters(t) || t.toLowerCase() === q) return;
    if (String(m.segment || '').trim().toLowerCase() !== q && Number(m.match) < 0.9) return;
    const by = String(m['created-by'] || '');
    if (/wikipedia/i.test(by)) return;
    let s = Number(m.match) || 0;
    if (by === 'MT!') s += 1;
    s += (Number(m.quality) || 0) / 100;
    if (lower && /(^|[\s,])\p{Lu}\p{Ll}/u.test(t) && !/^\p{Lu}[^,]*$/u.test(t)) s -= 2;
    if (/,/.test(t) && !/\s/.test(q)) s -= 0.5;
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  });
  return best;
}

// Backup. It is a translation memory, so it can answer with stray punctuation: skip such answers.
async function myMemoryTranslate(q, from, to) {
  const params = new URLSearchParams({ q, langpair: `${from}|${to}` });
  if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
  const r = await fetch(`https://api.mymemory.translated.net/get?${params}`, { signal: AbortSignal.timeout(10000) });
  const data = await r.json();
  let t = data && data.responseData && data.responseData.translatedText;
  if (Number(data && data.responseStatus) !== 200 || /MYMEMORY WARNING/i.test(t || '')) {
    throw new Error('Translation service is unavailable or the daily limit is reached.');
  }
  t = pickMyMemory(q, data);
  if (!t) throw new Error('No usable translation came back. Try again.');
  if (q === q.toLowerCase()) t = t.toLowerCase();
  return { translation: t, alts: [], by: 'mymemory' };
}

const cache = new Map();

app.get('/api/translate', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 500);
    const from = String(req.query.from || 'en');
    const to = String(req.query.to || 'ru');
    const langOk = /^[a-z]{2,3}(-[A-Za-z]{2})?$/;
    if (!q) throw new Error('Nothing to translate.');
    if (!langOk.test(from) || !langOk.test(to)) throw new Error('Bad language code.');

    const key = `${from}|${to}|${q.toLowerCase()}`;
    if (cache.has(key)) return res.json(cache.get(key));

    const out =
      (await googleTranslate(q, from, to).catch(() => null)) ||
      (await googleTranslate2(q, from, to).catch(() => null)) ||
      (await myMemoryTranslate(q, from, to));
    if (out.by === 'google') cache.set(key, out); // a backup answer is retried next time
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Translation failed.' });
  }
});

app.use(express.static(path.join(__dirname, 'docs')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Wordcatcher is running: http://localhost:${PORT}`));
}

module.exports = { extractArticle, isPrivateIp, googleTranslate, googleTranslate2, myMemoryTranslate, pickMyMemory };
