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

function extractArticle(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl, virtualConsole: new VirtualConsole() });
  const article = new Readability(dom.window.document).parse();
  if (!article || !article.content) return null;

  const content = new JSDOM(article.content).window.document;
  const blocks = [];
  content.querySelectorAll('h1,h2,h3,h4,p,li').forEach((el) => {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'h1') return; // the title is shown separately
    if (!blocks.length && /^h\d$/.test(tag)) {
      // Readability turns the page h1 into h2; drop it if it repeats the title
      const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const t = norm(article.title || '');
      const h = norm(text);
      if (t && h && (t.includes(h) || h.includes(t))) return;
    }
    blocks.push({ type: tag === 'p' || tag === 'li' ? 'p' : 'h', text });
  });
  if (!blocks.length) return null;

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
    if (cache.has(key)) return res.json({ translation: cache.get(key) });

    const params = new URLSearchParams({ q, langpair: `${from}|${to}` });
    if (MYMEMORY_EMAIL) params.set('de', MYMEMORY_EMAIL);
    const r = await fetch(`https://api.mymemory.translated.net/get?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    let t = data && data.responseData && data.responseData.translatedText;
    if (!t || Number(data.responseStatus) !== 200 || /MYMEMORY WARNING/i.test(t)) {
      throw new Error('Translation service is unavailable or the daily limit is reached.');
    }
    // MyMemory sometimes echoes upper-case when the query was upper-case
    if (q === q.toLowerCase()) t = t.toLowerCase();
    cache.set(key, t);
    res.json({ translation: t });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Translation failed.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Wordcatcher is running: http://localhost:${PORT}`));
}

module.exports = { extractArticle, isPrivateIp };
