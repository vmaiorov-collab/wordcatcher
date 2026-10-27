(() => {
  const $ = (s) => document.querySelector(s);
  const body = $('#body');
  const popup = $('#popup');

  // ---------- storage (cookies/localStorage-style, no accounts) ----------
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
    },
  };

  let words = store.get('wc_words', []);
  let lang = store.get('wc_lang', 'ru');
  let currentSrc = ''; // which article is open: its URL, 'paste' or 'demo'

  const DEMO = {
    src: 'demo',
    title: 'Why the news is the best language teacher',
    site: 'Пример',
    byline: '',
    hint: 'idioms',
    blocks: [
      { type: 'p', text: 'A textbook can teach you what a language sounded like ten years ago. A news article teaches you what people are saying this morning: the new words, the odd idioms, the headlines that bend the rules of grammar.' },
      { type: 'p', text: 'The trick is to stop only at the words that matter. Click one, see what it means, and move on before you lose the thread of the story.' },
    ],
  };

  // header gets a hairline once the page scrolls under it
  window.addEventListener('scroll', () => $('#top').classList.toggle('scrolled', window.scrollY > 8), { passive: true });

  const ICON_CHECK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  const updateCount = () => { $('#count').textContent = words.length; };
  const saveWords = () => { store.set('wc_words', words); updateCount(); };
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  // ---------- tabs ----------
  function showView(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    closePopup();
    if (name === 'words') renderWords();
    if (name === 'quiz') quizIntro();
  }
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) showView(b.dataset.view);
  });

  $('#lang').value = lang;
  $('#lang').addEventListener('change', (e) => {
    lang = e.target.value;
    store.set('wc_lang', lang);
    closePopup();
    renderMargin();
    quizIntro();
  });

  // ---------- loading articles ----------
  function setStatus(msg, isError) {
    const s = $('#status');
    if (!msg) { s.classList.add('hidden'); return; }
    s.textContent = msg;
    s.classList.toggle('error', !!isError);
    s.classList.remove('hidden');
  }

  // Works in two modes:
  //  1) with the Node server (npm start): /api/article and /api/translate are used;
  //  2) on static hosting (GitHub Pages): the page is fetched through the Jina Reader
  //     service (r.jina.ai, CORS-enabled, renders the page like a browser), the article is
  //     extracted with Readability and MyMemory is called directly.
  const READER = 'https://r.jina.ai/';
  const PASTE_HINT = 'Нажми «Вставить текст вместо ссылки» и вставь текст статьи.';

  // Returns { ok, data } if a Wordcatcher server answered, or null on static hosting.
  async function serverJson(path, params) {
    let r;
    try { r = await fetch(path + '?' + new URLSearchParams(params)); } catch { return null; }
    const ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
    if (!ct.includes('application/json')) return null;
    return { ok: r.ok, data: await r.json() };
  }

  // ---------- images ----------
  // Skip tracking pixels, icons and logos by their file path, not by words inside names ("silicon").
  const JUNK_IMG = /(^|[\/_.-])(pixel|spacer|blank|1x1|tracking|beacon|sprite|logo|icons?|avatar|favicon|emoji)([\/_.-]|$)/i;
  const IMG_MD = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

  function absUrl(u, base) {
    try {
      const x = new URL(u, base);
      if (x.protocol === 'http:') x.protocol = 'https:'; // http images are blocked on an https page
      return x.protocol === 'https:' ? x.href : '';
    } catch { return ''; }
  }

  const usableImage = (src) => !!src && !/\.svg(\?|$)/i.test(src) && !JUNK_IMG.test(src.split('?')[0]);

  // From a srcset take the smallest picture that is at least 800px wide, else the largest.
  function pickSrcset(set) {
    const items = set.split(/,\s+/).map((x) => x.trim().split(/\s+/)).filter((a) => a[0]).map(([u, d]) => ({
      u,
      w: /w$/.test(d || '') ? parseInt(d, 10) : /x$/.test(d || '') ? parseFloat(d) * 400 : 0,
    }));
    if (!items.length) return '';
    const big = items.filter((i) => i.w >= 800).sort((a, b) => a.w - b.w)[0];
    return (big || items.sort((a, b) => b.w - a.w)[0]).u;
  }

  function imageBlock(img, caption, base) {
    const attr = (n) => img.getAttribute(n) || '';
    const raw = [pickSrcset(attr('srcset') || attr('data-srcset')), attr('data-src'), attr('data-lazy-src'), attr('data-original'), attr('src')]
      .find((c) => c && !/^data:/i.test(c));
    const src = raw ? absUrl(raw, base) : '';
    if (!usableImage(src)) return null;
    const w = parseInt(attr('width'), 10) || 0;
    const h = parseInt(attr('height'), 10) || 0;
    if ((w && w < 120) || (h && h < 80)) return null;
    return { type: 'img', src, alt: attr('alt').trim(), caption: (caption || '').replace(/\s+/g, ' ').trim(), w, h };
  }

  const imgStem = (u) => u.split('?')[0].split('/').pop().replace(/(\.[a-z0-9]+)+$/i, '');

  function extractClient(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const metaImg = ((doc.querySelector('meta[property="og:image"], meta[name="twitter:image"]') || {}).content || '').trim();
    const base = doc.createElement('base');
    base.href = pageUrl;
    doc.head.prepend(base);
    const art = new Readability(doc).parse();
    if (!art || !art.content) return null;

    const content = new DOMParser().parseFromString(art.content, 'text/html');
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const blocks = [];
    content.querySelectorAll('h1,h2,h3,h4,p,li,figure,img').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'figure' || tag === 'img') {
        if (tag === 'img' && el.closest('figure')) return; // handled with its figure
        const img = tag === 'img' ? el : el.querySelector('img');
        if (!img) return;
        const cap = tag === 'figure' ? ((el.querySelector('figcaption') || {}).textContent || '') : '';
        const b = imageBlock(img, cap, pageUrl);
        if (b) blocks.push(b);
        return;
      }
      if (el.closest('figure')) return; // captions travel with their picture
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (tag === 'h1') return;
      if (!blocks.some((b) => b.type !== 'img') && /^h\d$/.test(tag)) {
        const t = norm(art.title || '');
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
      blocks.unshift({ type: 'img', src: lead, alt: (art.title || '').trim(), caption: '', w: 0, h: 0, lead: true });
    }

    let host = '';
    try { host = new URL(pageUrl).hostname; } catch { /* ignore */ }
    return {
      title: (art.title || '').trim(),
      byline: (art.byline || '').trim(),
      site: (art.siteName || host).trim(),
      blocks,
    };
  }

  // Fallback when the page HTML has no recognisable article: use the reader's own markdown.
  function articleFromMarkdown(md, pageUrl) {
    const title = ((md.match(/^Title:\s*(.+)$/m) || [])[1] || '').trim();
    const at = md.indexOf('Markdown Content:');
    const text = at >= 0 ? md.slice(at + 'Markdown Content:'.length) : md;
    const blocks = [];
    text.split(/\n{2,}/).forEach((chunk) => {
      for (const m of chunk.matchAll(IMG_MD)) {
        const src = absUrl(m[2], pageUrl);
        if (usableImage(src)) blocks.push({ type: 'img', src, alt: m[1].trim(), caption: '', w: 0, h: 0 });
      }
      let t = chunk
        .replace(IMG_MD, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*`>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!t) return;
      const h = t.match(/^#{1,6}\s+(.+)$/);
      if (h) {
        if (h[1].trim() !== title) blocks.push({ type: 'h', text: h[1].trim() });
        return;
      }
      t = t.replace(/^[-+•]\s+/, '');
      if (t.split(' ').length < 6) return; // menus, captions, buttons
      blocks.push({ type: 'p', text: t });
    });
    if (blocks.filter((b) => b.type !== 'img').length < 2) return null;
    let host = '';
    try { host = new URL(pageUrl).hostname; } catch { /* ignore */ }
    return { title, byline: '', site: host.replace(/^www\./, ''), blocks };
  }

  async function readerGet(url, headers) {
    const slow = setTimeout(() => setStatus('Сайт отвечает медленно, подожди ещё немного…'), 7000);
    try {
      return await fetch(READER + url, { headers, signal: AbortSignal.timeout(30000) });
    } finally {
      clearTimeout(slow);
    }
  }

  async function fetchArticle(url) {
    const s = await serverJson('/api/article', { url });
    if (s) {
      if (!s.ok) throw new Error(s.data.error || 'Не удалось загрузить статью.');
      return s.data;
    }
    if (!/^https?:\/\//i.test(url)) throw new Error('Это не похоже на ссылку.');

    let status = 0;
    // 1) the rendered page as HTML, then the same Readability extraction as on the server
    if (typeof Readability !== 'undefined') {
      try {
        const r = await readerGet(url, { 'X-Return-Format': 'html' });
        status = r.status;
        if (r.ok) {
          const a = extractClient(await r.text(), url);
          if (a) return a;
        }
      } catch { /* fall through to markdown */ }
    }
    // 2) the reader's own clean-text version
    try {
      const r = await readerGet(url);
      status = r.status;
      if (r.ok) {
        const a = articleFromMarkdown(await r.text(), url);
        if (a) return a;
      }
    } catch { /* fall through to the error */ }

    if (status === 429) throw new Error('Сервис загрузки сейчас перегружен. Попробуй через минуту. ' + PASTE_HINT);
    if (status === 401 || status === 403 || status === 402) throw new Error('Сайт не отдаёт статью без входа или подписки. ' + PASTE_HINT);
    throw new Error('Не удалось загрузить статью. Проверь ссылку. ' + PASTE_HINT);
  }

  $('#toggle-paste').addEventListener('click', () => $('#paste-form').classList.toggle('hidden'));

  $('#url-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let url = $('#url').value.trim();
    if (!url) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url; // allow "bbc.com/news/…"
    const btn = $('#load-btn');
    btn.disabled = true;
    setStatus('Загружаю статью…');
    try {
      const d = await fetchArticle(url);
      d.src = url;
      setStatus('');
      renderArticle(d);
      store.set('wc_article', d);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('#paste-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#paste-text').value.trim();
    if (!text) return;
    const blocks = text.split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t) => ({ type: 'p', text: t }));
    const d = { src: 'paste', title: 'Вставленный текст', byline: '', site: '', blocks };
    renderArticle(d);
    store.set('wc_article', d);
  });

  function renderArticle(a) {
    closePopup();
    currentSrc = a.src || '';
    const isDemo = currentSrc === 'demo';
    $('#view-read').classList.toggle('is-demo', isDemo);
    $('#view-read').classList.toggle('is-article', !isDemo);
    $('#meta').textContent = [a.site, a.byline].filter(Boolean).join(', ');
    $('#title').textContent = a.title || '';
    body.innerHTML = '';
    const re = /\p{L}+(?:['’-]\p{L}+)*/gu;
    a.blocks.forEach((b) => {
      if (b.type === 'img') {
        const fig = document.createElement('figure');
        fig.className = 'fig' + (b.lead ? ' lead' : '');
        const img = new Image();
        img.alt = b.alt || '';
        img.loading = b.lead ? 'eager' : 'lazy';
        img.decoding = 'async';
        img.setAttribute('referrerpolicy', 'no-referrer'); // many news sites refuse pictures requested with another site's referrer
        if (b.w && b.h) img.style.aspectRatio = b.w + ' / ' + b.h;
        img.addEventListener('error', () => fig.remove());
        img.src = b.src;
        fig.append(img);
        if (b.caption) {
          const c = document.createElement('figcaption');
          c.textContent = b.caption;
          fig.append(c);
        }
        body.append(fig);
        return;
      }
      const el = document.createElement(b.type === 'h' ? 'h3' : 'p');
      el.dataset.text = b.text;
      let last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(b.text))) {
        if (m.index > last) el.append(b.text.slice(last, m.index));
        const s = document.createElement('span');
        s.className = 'w';
        s.textContent = m[0];
        s.dataset.o = m.index;
        el.append(s);
        last = m.index + m[0].length;
      }
      if (last < b.text.length) el.append(b.text.slice(last));
      body.append(el);
    });
    if (isDemo && a.hint) {
      // one slow marker stroke over a single word shows where to click
      const target = [...body.querySelectorAll('.w')].find((s) => s.textContent.toLowerCase() === a.hint);
      if (target) target.classList.add('hint');
    }
    refreshHighlights();
    if (!isDemo) window.scrollTo({ top: 0 });
  }

  function refreshHighlights() {
    const keys = new Set(words.map((w) => w.key));
    body.querySelectorAll('.w').forEach((s) => s.classList.toggle('saved', keys.has(s.textContent.toLowerCase())));
    renderMargin();
  }

  // words saved from the open article, shown beside the text
  function renderMargin() {
    const list = words.filter((w) => w.src === currentSrc && w.lang === lang);
    $('#margin-count').textContent = list.length || '';
    $('#margin-empty').classList.toggle('hidden', list.length > 0);
    $('#margin').classList.toggle('is-empty', list.length === 0);
    $('#margin-list').innerHTML = list.map((w) => `
      <li>
        <div><span class="m-w">${esc(w.text)}</span><span class="m-t">${esc(w.tr)}</span></div>
        <button class="m-x icon" data-id="${esc(w.id)}" title="Убрать из словаря" aria-label="Убрать из словаря">${ICON_X}</button>
      </li>`).join('');
  }

  $('#margin-list').addEventListener('click', (e) => {
    const b = e.target.closest('.m-x');
    if (!b) return;
    words = words.filter((w) => w.id !== b.dataset.id);
    saveWords();
    closePopup();
    refreshHighlights();
  });

  // ---------- selecting words ----------
  function sentenceAround(text, i) {
    const re = /[^.!?]+(?:[.!?]+["”’')]*\s*|$)/g;
    let m;
    while ((m = re.exec(text))) {
      if (i >= m.index && i < m.index + m[0].length) return m[0].trim();
    }
    return text.slice(0, 200);
  }

  body.addEventListener('click', (e) => {
    const sel = window.getSelection();
    const selText = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, ' ').trim() : '';

    if (selText && body.contains(sel.anchorNode)) {
      if (selText.length > 120) return;
      const node = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      const block = node.closest('p,h3');
      let ctx = '';
      if (block) {
        const t = block.dataset.text || '';
        const idx = t.toLowerCase().indexOf(selText.toLowerCase());
        ctx = sentenceAround(t, idx >= 0 ? idx : 0);
      }
      clearActive();
      showPopup(selText, sel.getRangeAt(0).getBoundingClientRect(), ctx);
      return;
    }

    const span = e.target.closest('.w');
    if (!span) return;
    body.querySelectorAll('.w.hint').forEach((h) => h.classList.remove('hint'));
    const block = span.closest('p,h3');
    const ctx = sentenceAround(block.dataset.text || '', Number(span.dataset.o));
    clearActive();
    span.classList.add('active');
    showPopup(span.textContent, span.getBoundingClientRect(), ctx);
  });

  function clearActive() { body.querySelectorAll('.w.active').forEach((s) => s.classList.remove('active')); }

  document.addEventListener('click', (e) => {
    if (popup.classList.contains('hidden')) return;
    if (popup.contains(e.target) || e.target.closest('.w')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && body.contains(sel.anchorNode)) return;
    closePopup();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });
  $('#pop-close').addEventListener('click', closePopup);

  // ---------- popup + translation ----------
  let popupToken = 0;
  let current = null;
  let anchor = null;

  const trCache = new Map();
  const hasLetters = (str) => /\p{L}/u.test(str || '');

  // Google's public web endpoint: accurate for single words and gives other meanings by part of speech.
  async function googleTranslate(text, to) {
    const p = new URLSearchParams({ client: 'gtx', sl: 'en', tl: to, q: text });
    p.append('dt', 't');
    p.append('dt', 'bd');
    const r = await fetch('https://translate.googleapis.com/translate_a/single?' + p, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('google ' + r.status);
    const d = await r.json();
    const main = (d[0] || []).map((x) => x[0]).join('').trim();
    if (!hasLetters(main)) throw new Error('empty');
    const alts = [];
    if (!/\s/.test(text)) {
      (d[1] || []).forEach((g) => (g[1] || []).forEach((a) => {
        if (a.toLowerCase() !== main.toLowerCase() && !alts.includes(a)) alts.push(a);
      }));
    }
    return { tr: main, alts: alts.slice(0, 3), dict: alts.slice(0, 24), by: 'google' };
  }

  // Same Google engine on another host (the one the Chrome dictionary uses): it still works when
  // the first host is rate-limited or blocked by a content blocker. No other meanings here.
  async function googleTranslate2(text, to) {
    const p = new URLSearchParams({ client: 'dict-chrome-ex', sl: 'en', tl: to, q: text });
    const r = await fetch('https://clients5.google.com/translate_a/t?' + p, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('google2 ' + r.status);
    const d = await r.json();
    let t = Array.isArray(d) ? d[0] : '';
    if (Array.isArray(t)) t = t[0];
    t = String(t || '').trim();
    if (!hasLetters(t) || t.toLowerCase() === text.toLowerCase()) throw new Error('empty');
    return { tr: t, alts: [], by: 'google' };
  }

  // The browser's own on-device translator (Translator API): Apple's engine in Safari where it is
  // supported, Google's in Chrome. Nothing goes over the network, so a content blocker can't stop it.
  const deviceTranslators = new Map();
  async function deviceTranslate(text, to) {
    const T = self.Translator;
    if (!T || typeof T.create !== 'function') throw new Error('no translator api');
    let p = deviceTranslators.get(to);
    if (!p) {
      const opts = { sourceLanguage: 'en', targetLanguage: to };
      p = (async () => {
        if (typeof T.availability === 'function' && (await T.availability(opts)) === 'unavailable') throw new Error('unavailable');
        return T.create(opts);
      })();
      deviceTranslators.set(to, p);
      p.catch(() => deviceTranslators.delete(to)); // e.g. the language pack needs a click to download
    }
    const tr = await p;
    let t = String((await tr.translate(text)) || '').trim();
    if (!hasLetters(t) || t.toLowerCase() === text.toLowerCase()) throw new Error('empty');
    if (text === text.toLowerCase() && !/\s/.test(text)) t = t.toLowerCase();
    return { tr: t, alts: [], by: 'device' };
  }
  const isGood = (by) => by === 'google' || by === 'device';

  // Last resort: a translation memory built from other people's texts. For single words its top
  // answer is often junk (a Wikipedia title such as "Дафф, Хилари" for "devoted", a fragment such
  // as "в столбик, стопкой" for "stacked"), so the candidates are scored instead of trusting it.
  function pickMyMemory(text, d) {
    const q = text.trim().toLowerCase();
    const lower = text === text.toLowerCase();
    const cands = [{ segment: text, translation: d.responseData && d.responseData.translatedText, 'created-by': '', match: d.responseData && d.responseData.match }]
      .concat(d.matches || []);
    let best = null, bestScore = -Infinity;
    cands.forEach((m) => {
      const t = String(m.translation || '').trim();
      if (!hasLetters(t) || t.toLowerCase() === q) return; // a stray "." or the word copied back
      if (String(m.segment || '').trim().toLowerCase() !== q && Number(m.match) < 0.9) return; // a different phrase
      const by = String(m['created-by'] || '');
      if (/wikipedia/i.test(by)) return; // article titles, not translations
      let s = Number(m.match) || 0;
      if (by === 'MT!') s += 1; // machine translation of exactly this word
      s += (Number(m.quality) || 0) / 100;
      if (lower && /(^|[\s,])\p{Lu}\p{Ll}/u.test(t) && !/^\p{Lu}[^,]*$/u.test(t)) s -= 2; // "Фамилия, Имя"
      if (/,/.test(t) && !/\s/.test(q)) s -= 0.5; // several words glued together for one word
      if (s > bestScore) { best = t; bestScore = s; }
    });
    return best;
  }

  async function myMemoryTranslate(text, to) {
    const r = await fetch('https://api.mymemory.translated.net/get?' + new URLSearchParams({ q: text, langpair: 'en|' + to }), { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    const top = d && d.responseData && d.responseData.translatedText;
    if (Number(d && d.responseStatus) !== 200 || /MYMEMORY WARNING/i.test(top || '')) throw new Error('quota');
    let t = pickMyMemory(text, d);
    if (!t) throw new Error('empty');
    if (text === text.toLowerCase()) t = t.toLowerCase();
    return { tr: t, alts: [], by: 'mymemory' };
  }

  // googleOnly: used when re-translating saved words, so a weak backup answer never overwrites them.
  async function translate(text, to = lang, googleOnly = false) {
    const key = to + '|' + text.toLowerCase();
    if (trCache.has(key)) return trCache.get(key);
    let res;
    const s = await serverJson('/api/translate', { q: text, from: 'en', to });
    if (s) {
      if (!s.ok) throw new Error(s.data.error || 'Ошибка перевода');
      res = { tr: s.data.translation, alts: s.data.alts || [], by: s.data.by || 'google' };
    } else {
      const tries = [googleTranslate, deviceTranslate, googleTranslate2];
      if (!googleOnly) tries.push(myMemoryTranslate);
      for (const fn of tries) {
        try { res = await fn(text, to); break; } catch { /* try the next service */ }
      }
      if (!res) throw new Error('Не удалось получить перевод. Проверь интернет и нажми «Повторить».');
    }
    if (googleOnly && !isGood(res.by)) throw new Error('no good translator');
    if (isGood(res.by)) trCache.set(key, res); // a backup answer is retried next time
    return res;
  }

  // ---------- translation in context ----------
  // A word alone is ambiguous ("moggy", "soliciting", "the deck is stacked"), so the whole sentence
  // is translated too: once plain, and with the word wrapped in markers (<b>…</b>, […], "…") that
  // Google keeps around the matching Russian words. The marked candidates vote: points for
  // appearing in the plain sentence translation, for matching a dictionary meaning of the word and
  // for agreeing with each other; a transliteration ("Могги" for "moggy") loses points.
  const ctxCache = new Map();
  const TRANSLIT = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'и', z: 'з' };
  const normT = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е').trim();
  const tokens = (x) => normT(x).match(/[\p{L}]+(?:-[\p{L}]+)*/gu) || [];
  // a rough Russian stem: drop the ending (вену/вена → вен, гортани/гортань → горта)
  const stemOf = (t) => t.slice(0, Math.max(3, t.length <= 5 ? t.length - 1 : t.length <= 7 ? t.length - 2 : t.length - 3));

  // does any 4+ letter word of the candidate occur (by its stem) in the text?
  function sharesStem(cand, text) {
    const tt = tokens(text).filter((t) => t.length >= 4); // "к", "на" must not match everything
    return tokens(cand).some((c) => c.length >= 4 && tt.some((t) => t.startsWith(stemOf(c)) || c.startsWith(stemOf(t))));
  }

  function looksCopied(word, cand) {
    const c = normT(cand).replace(/[^\p{L}]/gu, '');
    const w = normT(word).replace(/[^\p{L}]/gu, '');
    if (!c) return true;
    const tr = w.replace(/[a-z]/g, (ch) => TRANSLIT[ch] || ch).replace(/(.)\1+/g, '$1');
    const cc = c.replace(/(.)\1+/g, '$1');
    const near = (a, b) => editDistance(a, b) <= Math.max(1, Math.round(b.length * 0.34));
    return near(cc, w.replace(/(.)\1+/g, '$1')) || near(cc, tr);
  }

  function markIn(sentence, word, open, close) {
    const re = new RegExp('(^|[^\\p{L}])(' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![\\p{L}])', 'iu');
    if (!re.test(sentence)) return null;
    return sentence.replace(re, (m, pre, w) => pre + open + w + close);
  }

  const MARKERS = [
    { open: '<b>', close: '</b>', find: /<b>\s*([^<]+?)\s*<\/b>/i },
    { open: '[', close: ']', find: /\[\s*([^\]]+?)\s*\]/ },
    { open: '"', close: '"', find: /[«"“„]\s*([^»"”“]+?)\s*[»"”]/, skip: /["“”«»‘’]/ },
  ];

  async function translateInContext(text, sentence, to = lang) {
    const base = await translate(text, to);
    const plainSentence = sentence && sentence.replace(/\s+/g, ' ').trim();
    if (!plainSentence || normT(plainSentence) === normT(text) || !/\s/.test(plainSentence)) return base;
    const key = to + '|' + text.toLowerCase() + '|' + plainSentence;
    if (ctxCache.has(key)) return ctxCache.get(key);

    const good = (r) => (r && isGood(r.by) ? r : null);
    const marked = MARKERS.map((m) => (m.skip && m.skip.test(plainSentence) ? null : markIn(plainSentence, text, m.open, m.close)));
    const [plain, ...variants] = await Promise.all([plainSentence, ...marked].map((q) => (q ? translate(q, to).then(good, () => null) : null)));
    if (!plain) return base; // only the backup service answered: it cannot do this

    const cands = [];
    variants.forEach((v, i) => {
      const m = v && v.tr.match(MARKERS[i].find);
      const c = m && (m[1] || m[2] || '').replace(/^[\s,.;:!?—–-]+|[\s,.;:!?—–-]+$/g, '');
      if (!c || !hasLetters(c) || tokens(c).length > 4) return;
      const same = cands.find((x) => normT(x.t) === normT(c));
      if (same) same.s += 1; // another marker found the same words
      else cands.push({ t: c, s: 1 }); // found by a marker: it sits where the word is
    });
    const meanings = [base.tr, ...(base.dict || base.alts || [])];
    // words of the plain sentence translation that are forms of a dictionary meaning
    tokens(plain.tr).forEach((t) => {
      if (t.length >= 4 && meanings.some((m) => sharesStem(t, m)) && !cands.some((x) => sharesStem(x.t, t))) cands.push({ t, s: 0 });
    });
    cands.forEach((c) => {
      if (looksCopied(text, c.t)) { c.s = -100; return; } // "могги" for "moggy" is not a translation
      if (sharesStem(c.t, plain.tr)) c.s += 2;
      if (meanings.some((m) => sharesStem(c.t, m))) c.s += 2;
      c.s += cands.filter((o) => o !== c && o.s > 0 && sharesStem(c.t, o.t)).length;
    });
    cands.sort((a, b) => b.s - a.s);
    const baseCopied = looksCopied(text, base.tr);
    let tr = base.tr;
    // the machine translation of the lone word is not one of its dictionary meanings and is not
    // used in the sentence either ("moggy" → "туманный", dictionary: "киска"): trust the dictionary
    const dict = base.dict || [];
    if (dict.length && !dict.some((m) => normT(m) === normT(base.tr)) && !sharesStem(base.tr, plain.tr)) tr = dict[0];
    if (cands[0] && cands[0].s > -100 && (cands[0].s > 1 || (cands[0].s > 0 && !sharesStem(tr, plain.tr)) || baseCopied)) tr = cands[0].t;
    // a single word in the sentence's case ("гортани") → its dictionary form ("гортань")
    if (tokens(tr).length === 1) {
      const lemma = meanings.filter((m) => m && tokens(m).length <= 2 && sharesStem(tr, m) && tokens(m).some((t) => stemOf(t) === stemOf(tokens(tr)[0]) || tokens(tr)[0].startsWith(stemOf(t))))
        .sort((a, b) => a.length - b.length)[0];
      if (lemma) tr = lemma;
    }
    if (text === text.toLowerCase() && !/^\p{Lu}{2,}/u.test(tr)) tr = tr.charAt(0).toLowerCase() + tr.slice(1);

    const alts = [];
    const baseInDict = !dict.length || dict.some((m) => normT(m) === normT(base.tr));
    [...(baseInDict ? [base.tr] : []), ...(base.alts || [])].forEach((a) => {
      if (a && !sharesStem(a, tr) && normT(a) !== normT(tr) && !looksCopied(text, a) && !alts.some((x) => normT(x) === normT(a))) alts.push(a);
    });
    const res = { tr, alts: alts.slice(0, 3), sentenceTr: plain.tr, by: base.by, cx: 1 };
    ctxCache.set(key, res);
    return res;
  }

  function closePopup() {
    popupToken++;
    stopSpeech();
    popup.classList.add('hidden');
    clearActive();
  }

  function positionPopup() {
    if (!anchor) return;
    const w = popup.offsetWidth || 320;
    const h = popup.offsetHeight;
    let left = anchor.left + anchor.width / 2 - w / 2;
    left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + window.innerWidth - w - 8));
    let top = anchor.bottom + 8;
    if (top + h > window.scrollY + window.innerHeight && anchor.top - h - 8 > window.scrollY) top = anchor.top - h - 8;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  function renderPopup() {
    const c = current;
    $('#pop-word').textContent = c.text;
    $('#pop-ctx').textContent = c.context || '';
    $('#pop-ctx').classList.toggle('hidden', !c.context);
    $('#pop-say-ctx').classList.toggle('hidden', !c.context || c.context.trim().toLowerCase() === c.key);
    const tr = $('#pop-tr');
    tr.className = 'pop-tr';
    if (c.status === 'loading') { tr.textContent = 'Перевожу…'; tr.classList.add('loading'); }
    else if (c.status === 'error') { tr.textContent = c.error; tr.classList.add('err'); }
    else tr.textContent = c.tr;
    const st = $('#pop-sent');
    if (c.status === 'ok' && c.sentenceTr) {
      const safe = esc(c.sentenceTr);
      const hit = tokens(c.tr).filter((t) => t.length >= 3).map(stemOf);
      // bold the words of the chosen meaning inside the sentence translation
      st.innerHTML = '<span class="pop-sent-label">В предложении:</span> ' + (hit.length
        ? safe.replace(/[\p{L}]+(?:-[\p{L}]+)*/gu, (wd) => (hit.some((h) => normT(wd).startsWith(h)) ? '<b>' + wd + '</b>' : wd))
        : safe);
    } else st.textContent = '';
    st.classList.toggle('hidden', !st.textContent);
    const alt = $('#pop-alt');
    alt.textContent = c.status === 'ok' && c.alts && c.alts.length ? 'Ещё: ' + c.alts.join(', ') : '';
    alt.classList.toggle('hidden', !alt.textContent);

    const inList = words.some((w) => w.key === c.key && w.lang === lang);
    $('#pop-state').innerHTML = inList ? ICON_CHECK + 'В словаре' : '';
    const t = $('#pop-toggle');
    t.classList.toggle('hidden', c.status === 'loading');
    t.textContent = c.status === 'error' ? 'Повторить' : inList ? 'Убрать' : 'Добавить';
    positionPopup();
  }

  async function showPopup(text, rect, context) {
    const token = ++popupToken;
    anchor = {
      top: rect.top + window.scrollY,
      bottom: rect.bottom + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
    };
    const key = text.toLowerCase();
    current = { text, key, context, tr: '', alts: [], status: 'loading', error: '' };
    stopSpeech();
    popup.classList.remove('hidden');
    const known = words.find((w) => w.key === key && w.ipa);
    current.ipa = known ? known.ipa : '';
    showPron(current, token);

    let existing = words.find((w) => w.key === key && w.lang === lang);
    if (existing && !hasLetters(existing.tr)) {
      // an old entry saved with a stray "." as its translation: drop it and translate again
      words = words.filter((w) => w !== existing);
      saveWords();
      existing = null;
    }
    if (existing) {
      current.tr = existing.tr;
      current.alts = existing.alts || [];
      current.status = 'ok';
      renderPopup();
      if (existing.v === 3 && context) {
        // the meaning in this sentence, plus the sentence translation
        try {
          const res = await translateInContext(text, context);
          if (token !== popupToken) return;
          if (!existing.cx && (existing.context || '') === context) {
            Object.assign(existing, { tr: res.tr, alts: res.alts, cx: res.cx || 0 });
            saveWords();
            renderMargin();
          }
          current.tr = res.tr;
          current.alts = res.alts;
          current.sentenceTr = res.sentenceTr || '';
          renderPopup();
        } catch { /* keep what is saved */ }
        return;
      }
      if (existing.v !== 3) {
        // saved from the backup service: fix it now if a good translator answers
        try {
          const res = await fixWord(existing);
          if (!res) return;
          saveWords();
          renderMargin();
          if (token !== popupToken) return;
          current.tr = res.tr;
          current.alts = res.alts;
          renderPopup();
        } catch { /* keep what is saved */ }
      }
      return;
    }
    renderPopup();
    try {
      const res = await translateInContext(text, context);
      if (token !== popupToken) return;
      current.tr = res.tr;
      current.alts = res.alts;
      current.by = res.by;
      current.cx = res.cx || 0;
      current.sentenceTr = res.sentenceTr || '';
      current.status = 'ok';
      addWord(current);
      renderPopup();
    } catch (err) {
      if (token !== popupToken) return;
      current.status = 'error';
      current.error = err.message;
      renderPopup();
    }
  }

  $('#pop-toggle').addEventListener('click', () => {
    if (!current) return;
    if (current.status === 'error') {
      const rect = anchor;
      const el = body.querySelector('.w.active');
      showPopup(current.text, el ? el.getBoundingClientRect() : { top: rect.top - window.scrollY, bottom: rect.bottom - window.scrollY, left: rect.left - window.scrollX, width: rect.width }, current.context);
      return;
    }
    const inList = words.some((w) => w.key === current.key && w.lang === lang);
    if (inList) removeWord(current.key); else addWord(current);
    renderPopup();
  });

  // ---------- pronunciation ----------
  // A real recording and transcription from the free Dictionary API (dictionaryapi.dev); when a
  // word has no recording (or for a phrase or sentence) the browser's English voice reads it.
  const ICON_PLAY = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
  const sayBtn = (text) => `<button class="say icon" data-say="${esc(text)}" title="Послушать" aria-label="Послушать">${ICON_PLAY}</button>`;
  const pronCache = new Map();

  function lookupPron(word) {
    const key = word.toLowerCase();
    if (!/^\p{L}+(?:['’-]\p{L}+)*$/u.test(key)) return Promise.resolve(null);
    if (!pronCache.has(key)) {
      pronCache.set(key, (async () => {
        const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(key), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;
        const d = await r.json();
        const ph = (Array.isArray(d) ? d : []).flatMap((e) => [{ text: e.phonetic }, ...(e.phonetics || [])]);
        const withAudio = ph.filter((p) => p.audio);
        const audio = (withAudio.find((p) => /-us\.mp3$/.test(p.audio)) || withAudio.find((p) => /-uk\.mp3$/.test(p.audio)) || withAudio[0] || {}).audio || '';
        const ipa = (ph.find((p) => p.text && p.audio === audio) || ph.find((p) => p.text) || {}).text || '';
        return ipa || audio ? { ipa, audio: audio.replace(/^\/\//, 'https://') } : null;
      })().catch(() => { pronCache.delete(key); return null; }));
    }
    return pronCache.get(key);
  }

  let player = null;
  let playingBtn = null;
  function stopSpeech() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (player) { player.onended = player.onerror = null; player.pause(); player = null; }
    if (playingBtn) playingBtn.classList.remove('playing');
    playingBtn = null;
  }

  function englishVoice() {
    const vs = speechSynthesis.getVoices();
    const en = vs.filter((v) => /^en[-_]/i.test(v.lang));
    return en.find((v) => /^en[-_]US/i.test(v.lang) && /samantha|ava|allison|natural|premium|enhanced|google/i.test(v.name))
      || en.find((v) => /^en[-_]US/i.test(v.lang)) || en.find((v) => /^en[-_]GB/i.test(v.lang)) || en[0] || null;
  }
  if ('speechSynthesis' in window) speechSynthesis.getVoices(); // Safari loads voices lazily

  function ttsSay(text, rate, done) {
    if (!('speechSynthesis' in window)) return done();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    const v = englishVoice();
    if (v) u.voice = v;
    u.rate = rate;
    u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  }

  async function say(text, btn, rate = 0.95) {
    const again = btn && btn === playingBtn;
    stopSpeech();
    if (again) return; // a second press stops it
    playingBtn = btn || null;
    if (btn) btn.classList.add('playing');
    const done = () => { if (playingBtn === btn) stopSpeech(); };
    const p = /\s/.test(text.trim()) ? null : await lookupPron(text.trim());
    if (playingBtn !== (btn || null)) return; // another button was pressed meanwhile
    if (p && p.audio) {
      player = new Audio(p.audio);
      player.onended = done;
      player.onerror = () => { player = null; ttsSay(text, rate, done); };
      player.play().catch(() => { player = null; ttsSay(text, rate, done); });
    } else {
      ttsSay(text, rate, done);
    }
  }

  // speaker buttons in the word list and the quiz
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.say[data-say]');
    if (!b) return;
    e.stopPropagation();
    say(b.dataset.say, b);
  }, true);

  $('#pop-say').addEventListener('click', () => current && say(current.text, $('#pop-say')));
  $('#pop-say-ctx').addEventListener('click', (e) => current && current.context && say(current.context, e.currentTarget, 0.9));

  async function showPron(c, token) {
    $('#pop-ipa').textContent = c.ipa || 'Как читается';
    if (c.ipa) return;
    const p = await lookupPron(c.text);
    if (token !== popupToken || !p || !p.ipa) return;
    c.ipa = p.ipa;
    $('#pop-ipa').textContent = p.ipa;
    const w = words.find((x) => x.key === c.key && x.lang === lang);
    if (w && !w.ipa) { w.ipa = p.ipa; saveWords(); }
    positionPopup();
  }

  function addWord(c) {
    if (words.some((w) => w.key === c.key && w.lang === lang)) return;
    words.unshift({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      key: c.key, text: c.text, ipa: c.ipa || '', tr: c.tr, alts: c.alts || [], cx: c.cx || 0, by: c.by || '', v: isGood(c.by) ? 3 : 2, mm: c.by === 'mymemory' ? 2 : 0, context: c.context || '', lang, src: currentSrc,
      added: Date.now(), right: 0, wrong: 0,
    });
    saveWords();
    refreshHighlights();
  }

  function removeWord(key) {
    words = words.filter((w) => !(w.key === key && w.lang === lang));
    saveWords();
    refreshHighlights();
  }

  // ---------- words list ----------
  let wordsFilter = 'all';
  const ICON_TARGET = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>';
  const visibleWords = () => {
    const q = $('#search').value.trim().toLowerCase();
    return words.filter((w) => (!q || w.key.includes(q) || w.tr.toLowerCase().includes(q)) && (wordsFilter === 'all' || w.check));
  };

  function renderWords() {
    const list = visibleWords();
    const marked = words.filter((w) => w.check).length;
    $('#words-filter').classList.toggle('hidden', words.length === 0);
    $('#f-all').textContent = words.length;
    $('#f-check').textContent = marked;
    document.querySelectorAll('#words-filter .seg button').forEach((b) => b.classList.toggle('on', b.dataset.f === wordsFilter));
    $('#unmark-all').classList.toggle('hidden', marked === 0);
    $('#empty-words').classList.toggle('hidden', words.length > 0);
    $('#words-sub').textContent = words.length
      ? `${words.length} ${plural(words.length, ['слово', 'слова', 'слов'])} из прочитанных статей`
      : 'Слова, на которые ты нажимаешь в тексте, собираются здесь.';

    const where = (src) => {
      if (src === 'paste') return 'вставленный текст';
      if (src === 'demo') return 'пример';
      try { return new URL(src).hostname.replace(/^www\./, ''); } catch { return ''; }
    };
    const when = (t) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');

    $('#word-list').innerHTML = list.map((w) => {
      const level = Math.max(0, Math.min(3, (w.right || 0) - (w.wrong || 0)));
      const dots = [0, 1, 2].map((i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('');
      const meta = [where(w.src), when(w.added)].filter(Boolean).join(', ');
      return `
      <li class="${w.check ? 'marked' : ''}">
        <div class="wl-word">${esc(w.text)}${sayBtn(w.text)}${w.ipa ? `<span class="wl-ipa">${esc(w.ipa)}</span>` : ''}</div>
        <div class="wl-tr">${esc(w.tr)}</div>
        ${w.alts && w.alts.length ? `<div class="wl-alt">Ещё: ${esc(w.alts.join(', '))}</div>` : ''}
        ${w.context ? `<div class="wl-ctx">${esc(w.context)}</div>` : ''}
        <div class="wl-side">
          <button class="wl-check${w.check ? ' on' : ''}" data-id="${esc(w.id)}" aria-pressed="${w.check ? 'true' : 'false'}">${w.check ? ICON_CHECK + 'На проверке' : ICON_TARGET + 'На проверку'}</button>
          <span class="wl-meta">${esc(meta)}</span>
          <span class="dots" title="Освоено на ${level} из 3" aria-label="Освоено на ${level} из 3">${dots}</span>
          <button class="wl-del icon" data-id="${esc(w.id)}" title="Удалить" aria-label="Удалить">${ICON_X}</button>
        </div>
      </li>`;
    }).join('');
    if (!list.length && words.length) {
      $('#word-list').innerHTML = `<li class="wl-none"><div class="empty"><h3>${wordsFilter === 'check' ? 'Нет слов на проверку' : 'Ничего не нашлось'}</h3><p>${wordsFilter === 'check' ? 'Нажми «На проверку» у слов во вкладке «Все», и квиз будет спрашивать только их.' : 'Попробуй другое слово.'}</p></div></li>`;
    }
  }

  document.querySelector('#words-filter .seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    wordsFilter = b.dataset.f;
    renderWords();
  });
  $('#mark-all').addEventListener('click', () => {
    visibleWords().forEach((w) => { w.check = true; });
    saveWords();
    renderWords();
  });
  $('#unmark-all').addEventListener('click', () => {
    words.forEach((w) => { delete w.check; });
    saveWords();
    renderWords();
  });

  function plural(n, forms) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
    return forms[2];
  }

  $('#search').addEventListener('input', renderWords);
  $('#word-list').addEventListener('click', (e) => {
    const c = e.target.closest('.wl-check');
    if (c) {
      const w = words.find((x) => x.id === c.dataset.id);
      if (w) { if (w.check) delete w.check; else w.check = true; saveWords(); renderWords(); }
      return;
    }
    const b = e.target.closest('.wl-del');
    if (!b) return;
    words = words.filter((w) => w.id !== b.dataset.id);
    saveWords();
    refreshHighlights();
    renderWords();
  });
  $('#clear').addEventListener('click', () => {
    if (!words.length || !confirm('Удалить все слова?')) return;
    words = [];
    saveWords();
    refreshHighlights();
    renderWords();
  });
  $('#export').addEventListener('click', () => {
    if (!words.length) return;
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const csv = '﻿' + words.map((w) => [q(w.text), q(w.tr), q(w.context)].join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'wordcatcher.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------- quiz ----------
  const area = $('#quiz-area');
  let quiz = null;
  const allPool = () => words.filter((w) => w.lang === lang);
  const pool = () => ($('#quiz-set').value === 'check' ? allPool().filter((w) => w.check) : allPool());

  const qs = store.get('wc_quiz', {});
  ['set', 'mode', 'dir'].forEach((k) => { if (qs[k]) $('#quiz-' + k).value = qs[k]; });
  function syncQuizControls() {
    const marked = allPool().filter((w) => w.check).length;
    $('#quiz-set').options[0].textContent = `На проверку (${marked})`;
    $('#quiz-set').options[1].textContent = `Все слова (${allPool().length})`;
    $('#quiz-dir').classList.toggle('hidden', $('#quiz-mode').value === 'write'); // typing is always rus → eng
    store.set('wc_quiz', { set: $('#quiz-set').value, mode: $('#quiz-mode').value, dir: $('#quiz-dir').value });
  }
  ['set', 'mode', 'dir'].forEach((k) => $('#quiz-' + k).addEventListener('change', () => { syncQuizControls(); quizIntro(); }));

  function quizIntro() {
    quiz = null;
    syncQuizControls();
    const all = allPool().length;
    const n = pool().length;
    if (!all) {
      area.innerHTML = `<div class="empty"><h3>Для квиза нужны слова</h3><p>Открой статью и нажми на несколько слов: они сразу появятся здесь.</p></div>`;
    } else if (!n) {
      area.innerHTML = `<div class="empty"><h3>Нет слов на проверку</h3><p>Открой «Словарь» и нажми «На проверку» у слов, которые хочешь выучить. Или выбери «Все слова».</p><p style="margin-top:14px"><button class="ghost" id="go-words">Открыть словарь</button></p></div>`;
    } else {
      area.innerHTML = `<div class="empty"><h3>Готов?</h3><p>${$('#quiz-set').value === 'check' ? 'На проверку отмечено' : 'В словаре'} ${n} ${plural(n, ['слово', 'слова', 'слов'])}. Выбери режим и начни раунд.</p></div>`;
    }
  }

  $('#quiz-start').addEventListener('click', startQuiz);

  function startQuiz() {
    const p = pool();
    const mode = $('#quiz-mode').value;
    const dir = $('#quiz-dir').value;
    if (!p.length) return quizIntro();
    if (mode === 'choice' && allPool().length < 2) {
      area.innerHTML = '<div class="empty"><h3>Нужно хотя бы два слова</h3><p>Для выбора ответа должно быть из чего выбирать. Добавь ещё слов или переключись на карточки.</p></div>';
      return;
    }
    const queue = p
      .map((w) => ({ w, s: w.right - w.wrong + Math.random() * 2.5 }))
      .sort((a, b) => a.s - b.s)
      .slice(0, 10)
      .map((x) => x.w);
    quiz = { mode, dir: mode === 'write' ? 'rev' : dir, queue, i: 0, score: 0, revealed: false, answered: false, options: [], hint: 0, typed: '' };
    renderQuiz();
    focusAnswer();
  }

  const front = (w) => (quiz.dir === 'fwd' ? w.text : w.tr);
  const back = (w) => (quiz.dir === 'fwd' ? w.tr : w.text);

  function renderQuiz() {
    if (!quiz) return;
    if (quiz.i >= quiz.queue.length) {
      area.innerHTML = `<div class="q-result"><div class="big">${quiz.score} из ${quiz.queue.length}</div><p>Раунд закончен. Результаты учтены: слова, в которых ты ошибся, вернутся раньше.</p><button id="again">Ещё раунд</button></div>`;
      return;
    }
    const w = quiz.queue[quiz.i];
    const progress = `<div class="q-bar"><span style="width:${(quiz.i / quiz.queue.length) * 100}%"></span></div><div class="q-count">${quiz.i + 1} из ${quiz.queue.length}</div>`;

    if (quiz.mode === 'write') {
      const masked = w.context ? blankOut(w.context, w.text) : '';
      const hintLine = quiz.hint === 0 || quiz.answered ? ''
        : `<div class="hint-line">${quiz.hint >= 1 ? `Начинается на <b>${esc(w.text[0])}</b>, букв: ${w.text.length}` : ''}${quiz.hint >= 2 && masked ? `<br>${masked}` : ''}</div>`;
      let verdict = '';
      if (quiz.answered) {
        verdict = quiz.result === 'right' ? `<div class="q-verdict right">${ICON_CHECK} Верно: <b>${esc(w.text)}</b>${sayBtn(w.text)}</div>`
          : quiz.result === 'close' ? `<div class="q-verdict right">${ICON_CHECK} Почти, правильно пишется <b>${esc(w.text)}</b>${sayBtn(w.text)}</div>`
          : `<div class="q-verdict wrong">Правильно: <b>${esc(w.text)}</b>${sayBtn(w.text)}</div>`;
      }
      area.innerHTML = progress + `
        <div class="q-card q-write"><div>${esc(w.tr)}</div>${hintLine}${quiz.answered && w.context ? `<div class="ctx">${esc(w.context)}</div>` : ''}</div>
        <form class="q-form" id="q-form" autocomplete="off">
          <input id="q-input" type="text" placeholder="Напиши по-английски" aria-label="Ответ по-английски" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(quiz.typed)}" ${quiz.answered ? `readonly class="${quiz.result === 'wrong' ? 'wrong' : 'right'}"` : ''}>
          <button type="submit">${quiz.answered ? 'Дальше' : 'Проверить'}</button>
        </form>
        ${verdict}
        ${quiz.answered ? '' : `<div class="q-sub">${quiz.hint < (w.context ? 2 : 1) ? '<button class="link" id="q-hint">Подсказка</button>' : ''}<button class="link" id="q-skip">Не знаю</button></div>`}
        <div class="q-keys">Enter — проверить и дальше</div>`;
      return;
    }

    if (quiz.mode === 'cards') {
      area.innerHTML = progress + `
        <div class="q-card" id="qc"><div>${esc(front(w))}</div>${quiz.dir === 'fwd' ? sayBtn(w.text) : ''}
        ${quiz.revealed
          ? `<div class="ans">${esc(back(w))}</div>${quiz.dir === 'fwd' ? '' : sayBtn(w.text)}${w.context ? `<div class="ctx">${esc(w.context)}</div>` : ''}`
          : '<small>Нажми на карточку, чтобы увидеть ответ</small>'}
        </div>
        ${quiz.revealed
          ? '<div class="q-actions"><button class="btn-no" data-k="0">Не знал</button><button class="btn-yes" data-k="1">Знал</button></div><div class="q-keys">Клавиши: стрелка влево или 0, стрелка вправо или 1</div>'
          : '<div class="q-keys">Клавиша: пробел</div>'}`;
      return;
    }

    if (!quiz.options.length) {
      const others = shuffle(pool().filter((x) => x.id !== w.id && back(x).toLowerCase() !== back(w).toLowerCase())).slice(0, 3);
      quiz.options = shuffle([w, ...others]);
    }
    area.innerHTML = progress + `
      <div class="q-card" style="cursor:default"><div>${esc(front(w))}</div>${quiz.dir === 'fwd' ? sayBtn(w.text) : ''}</div>
      <div class="opts">${quiz.options.map((o, i) => `<button class="opt" data-id="${esc(o.id)}"><b>${i + 1}</b><span>${esc(back(o))}</span></button>`).join('')}</div>
      <div class="q-next hidden" id="next-row"><button id="next">Дальше</button></div>
      <div class="q-keys">Клавиши 1–4 выбирают ответ, пробел ведёт дальше</div>`;
  }

  // the sentence with the word itself replaced by blanks
  function blankOut(ctx, word) {
    const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'ig');
    return esc(ctx).replace(re, (m) => '<b>' + m[0] + '_'.repeat(Math.max(2, m.length - 1)) + '</b>');
  }

  const normAns = (s) => s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // swapped letters
    }
    return d[a.length][b.length];
  }

  function checkWritten(skip) {
    const w = quiz.queue[quiz.i];
    const input = $('#q-input');
    quiz.typed = skip ? '' : (input ? input.value : '');
    const a = normAns(quiz.typed), t = normAns(w.text);
    if (!skip && !a) return;
    quiz.result = a === t ? 'right' : !skip && t.length >= 5 && editDistance(a, t) === 1 ? 'close' : 'wrong';
    quiz.answered = true;
    grade(w, quiz.result !== 'wrong');
    renderQuiz();
    if (quiz.result === 'wrong') say(w.text, area.querySelector('.q-verdict .say'));
    const btn = area.querySelector('#q-form button');
    if (btn) btn.focus();
  }

  function focusAnswer() {
    const i = $('#q-input');
    if (i && !i.readOnly) i.focus();
  }

  area.addEventListener('submit', (e) => {
    if (e.target.id !== 'q-form' || !quiz) return;
    e.preventDefault();
    if (quiz.answered) { nextQuestion(); focusAnswer(); } else checkWritten(false);
  });
  area.addEventListener('input', (e) => { if (e.target.id === 'q-input' && quiz) quiz.typed = e.target.value; });

  function grade(w, ok) {
    w[ok ? 'right' : 'wrong']++;
    if (ok) quiz.score++;
    saveWords();
  }

  function nextQuestion() {
    quiz.i++;
    quiz.revealed = false;
    quiz.answered = false;
    quiz.options = [];
    quiz.hint = 0;
    quiz.typed = '';
    quiz.result = '';
    renderQuiz();
  }

  area.addEventListener('click', (e) => {
    if (e.target.closest('#go-words')) return showView('words');
    if (!quiz) return;
    if (e.target.closest('#again')) return startQuiz();
    const w = quiz.queue[quiz.i];
    if (!w) return;

    if (quiz.mode === 'write') {
      if (e.target.closest('#q-hint')) { quiz.typed = ($('#q-input') || {}).value || ''; quiz.hint++; renderQuiz(); focusAnswer(); }
      else if (e.target.closest('#q-skip')) checkWritten(true);
      return;
    }

    if (quiz.mode === 'cards') {
      const k = e.target.closest('[data-k]');
      if (k) { grade(w, k.dataset.k === '1'); return nextQuestion(); }
      if (e.target.closest('#qc') && !quiz.revealed) { quiz.revealed = true; renderQuiz(); }
      return;
    }

    if (e.target.closest('#next')) return nextQuestion();
    const opt = e.target.closest('.opt');
    if (!opt || quiz.answered) return;
    quiz.answered = true;
    const ok = opt.dataset.id === w.id;
    grade(w, ok);
    area.querySelectorAll('.opt').forEach((b) => {
      b.disabled = true;
      if (b.dataset.id === w.id) b.classList.add('right');
      else if (b === opt) b.classList.add('wrong');
    });
    $('#next-row').classList.remove('hidden');
  });

  document.addEventListener('keydown', (e) => {
    if (!quiz || quiz.mode === 'write' || !$('#view-quiz').classList.contains('active')) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const w = quiz.queue[quiz.i];
    if (!w) return;
    if (quiz.mode === 'choice') {
      if (/^[1-4]$/.test(e.key) && !quiz.answered) {
        const b = area.querySelectorAll('.opt')[Number(e.key) - 1];
        if (b) b.click();
      } else if ((e.key === 'Enter' || e.key === ' ') && quiz.answered) {
        e.preventDefault();
        nextQuestion();
      }
    } else {
      if ((e.key === ' ' || e.key === 'Enter') && !quiz.revealed) { e.preventDefault(); quiz.revealed = true; renderQuiz(); }
      else if (quiz.revealed && (e.key === 'ArrowRight' || e.key === '1')) { grade(w, true); nextQuestion(); }
      else if (quiz.revealed && (e.key === 'ArrowLeft' || e.key === '0')) { grade(w, false); nextQuestion(); }
    }
  });

  // ---------- init ----------
  // Words not translated by Google (saved by earlier versions, or by the backup service while
  // Google was unreachable) can hold junk such as "дафф, хилари": translate them again with
  // Google only. If Google is still unreachable they stay as they are and are retried next visit.
  // A saved word that did not come from a good translator: try Google or the on-device one; if
  // neither answers, at least re-pick it once with the junk filter (mm: 2), so "дафф, хилари"
  // does not survive. Returns the new translation or null when nothing changed.
  async function fixWord(w) {
    let res = null;
    try {
      res = await translate(w.text, w.lang, true);
    } catch {
      if (w.mm === 2) return null;
      try { res = await myMemoryTranslate(w.text, w.lang); } catch { return null; }
    }
    Object.assign(w, { tr: res.tr, alts: res.alts || [], by: res.by, v: isGood(res.by) ? 3 : 2, mm: isGood(res.by) ? 0 : 2 });
    saveWords();
    renderMargin();
    return res;
  }

  async function upgradeWords() {
    const todo = words.filter((w) => w.v !== 3).slice(0, 40);
    for (const w of todo) {
      if (!(await fixWord(w)) && w.mm !== 2) break; // no network: try again on the next visit
      saveWords();
      renderMargin();
      if ($('#view-words').classList.contains('active')) renderWords();
      await new Promise((r) => setTimeout(r, 150));
    }
    // words saved before translation in context: translate each once by its own sentence
    const old = words.filter((w) => w.v === 3 && !w.cx && w.context && /\s/.test(w.context)).slice(0, 15);
    for (const w of old) {
      try {
        const res = await translateInContext(w.text, w.context, w.lang);
        if (!res.cx) break; // only the backup service answered: try again on the next visit
        Object.assign(w, { tr: res.tr, alts: res.alts, cx: 1 });
      } catch { break; }
      saveWords();
      renderMargin();
      if ($('#view-words').classList.contains('active')) renderWords();
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  updateCount(); // reading must never rewrite the saved list
  const saved = store.get('wc_article', null);
  renderArticle(saved && saved.blocks ? saved : DEMO);
  upgradeWords();
})();
