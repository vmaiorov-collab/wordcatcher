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

  function extractClient(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const base = doc.createElement('base');
    base.href = pageUrl;
    doc.head.prepend(base);
    const art = new Readability(doc).parse();
    if (!art || !art.content) return null;

    const content = new DOMParser().parseFromString(art.content, 'text/html');
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const blocks = [];
    content.querySelectorAll('h1,h2,h3,h4,p,li').forEach((el) => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const tag = el.tagName.toLowerCase();
      if (tag === 'h1') return;
      if (!blocks.length && /^h\d$/.test(tag)) {
        const t = norm(art.title || '');
        const h = norm(text);
        if (t && h && (t.includes(h) || h.includes(t))) return;
      }
      blocks.push({ type: tag === 'p' || tag === 'li' ? 'p' : 'h', text });
    });
    // a login wall or cookie page is not an article: it has a line or two of text
    const wordCount = blocks.reduce((n, b) => n + b.text.split(/\s+/).length, 0);
    if (blocks.filter((b) => b.type === 'p').length < 2 || wordCount < 50) return null;
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
      let t = chunk
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
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
    if (blocks.length < 2) return null;
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

  async function translate(text) {
    const key = lang + '|' + text.toLowerCase();
    if (trCache.has(key)) return trCache.get(key);
    let t;
    const s = await serverJson('/api/translate', { q: text, from: 'en', to: lang });
    if (s) {
      if (!s.ok) throw new Error(s.data.error || 'Ошибка перевода');
      t = s.data.translation;
    } else {
      const r = await fetch('https://api.mymemory.translated.net/get?' + new URLSearchParams({ q: text, langpair: 'en|' + lang }));
      const d = await r.json();
      t = d && d.responseData && d.responseData.translatedText;
      if (!t || Number(d.responseStatus) !== 200 || /MYMEMORY WARNING/i.test(t)) {
        throw new Error('Сервис перевода недоступен или исчерпан дневной лимит.');
      }
      if (text === text.toLowerCase()) t = t.toLowerCase();
    }
    trCache.set(key, t);
    return t;
  }

  function closePopup() {
    popupToken++;
    popup.classList.add('hidden');
    clearActive();
  }

  function positionPopup() {
    if (!anchor) return;
    const w = 280;
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
    const tr = $('#pop-tr');
    tr.className = 'pop-tr';
    if (c.status === 'loading') { tr.textContent = 'Перевожу…'; tr.classList.add('loading'); }
    else if (c.status === 'error') { tr.textContent = c.error; tr.classList.add('err'); }
    else tr.textContent = c.tr;

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
    current = { text, key, context, tr: '', status: 'loading', error: '' };
    popup.classList.remove('hidden');

    const existing = words.find((w) => w.key === key && w.lang === lang);
    if (existing) {
      current.tr = existing.tr;
      current.status = 'ok';
      renderPopup();
      return;
    }
    renderPopup();
    try {
      const tr = await translate(text);
      if (token !== popupToken) return;
      current.tr = tr;
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

  $('#pop-speak').addEventListener('click', () => {
    if (!current || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(current.text);
    u.lang = 'en-US';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });

  function addWord(c) {
    if (words.some((w) => w.key === c.key && w.lang === lang)) return;
    words.unshift({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      key: c.key, text: c.text, tr: c.tr, context: c.context || '', lang, src: currentSrc,
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
  function renderWords() {
    const q = $('#search').value.trim().toLowerCase();
    const list = words.filter((w) => !q || w.key.includes(q) || w.tr.toLowerCase().includes(q));
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
      <li>
        <div class="wl-word">${esc(w.text)}</div>
        <div class="wl-tr">${esc(w.tr)}</div>
        ${w.context ? `<div class="wl-ctx">${esc(w.context)}</div>` : ''}
        <div class="wl-side">
          <span class="wl-meta">${esc(meta)}</span>
          <span class="dots" title="Освоено на ${level} из 3" aria-label="Освоено на ${level} из 3">${dots}</span>
          <button class="wl-del icon" data-id="${esc(w.id)}" title="Удалить" aria-label="Удалить">${ICON_X}</button>
        </div>
      </li>`;
    }).join('');
  }

  function plural(n, forms) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
    return forms[2];
  }

  $('#search').addEventListener('input', renderWords);
  $('#word-list').addEventListener('click', (e) => {
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
  const pool = () => words.filter((w) => w.lang === lang);

  function quizIntro() {
    quiz = null;
    const n = pool().length;
    area.innerHTML = n
      ? `<div class="empty"><h3>Готов?</h3><p>В словаре ${n} ${plural(n, ['слово', 'слова', 'слов'])} для этого языка. Выбери режим и начни раунд.</p></div>`
      : `<div class="empty"><h3>Для квиза нужны слова</h3><p>Открой статью и нажми на несколько слов: они сразу появятся здесь.</p></div>`;
  }

  $('#quiz-start').addEventListener('click', startQuiz);

  function startQuiz() {
    const p = pool();
    const mode = $('#quiz-mode').value;
    const dir = $('#quiz-dir').value;
    if (!p.length) return quizIntro();
    if (mode === 'choice' && p.length < 2) {
      area.innerHTML = '<div class="empty"><h3>Нужно хотя бы два слова</h3><p>Для выбора ответа должно быть из чего выбирать. Добавь ещё слов или переключись на карточки.</p></div>';
      return;
    }
    const queue = p
      .map((w) => ({ w, s: w.right - w.wrong + Math.random() * 2.5 }))
      .sort((a, b) => a.s - b.s)
      .slice(0, 10)
      .map((x) => x.w);
    quiz = { mode, dir, queue, i: 0, score: 0, revealed: false, answered: false, options: [] };
    renderQuiz();
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

    if (quiz.mode === 'cards') {
      area.innerHTML = progress + `
        <div class="q-card" id="qc"><div>${esc(front(w))}</div>
        ${quiz.revealed
          ? `<div class="ans">${esc(back(w))}</div>${w.context ? `<div class="ctx">${esc(w.context)}</div>` : ''}`
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
      <div class="q-card" style="cursor:default"><div>${esc(front(w))}</div></div>
      <div class="opts">${quiz.options.map((o, i) => `<button class="opt" data-id="${esc(o.id)}"><b>${i + 1}</b><span>${esc(back(o))}</span></button>`).join('')}</div>
      <div class="q-next hidden" id="next-row"><button id="next">Дальше</button></div>
      <div class="q-keys">Клавиши 1–4 выбирают ответ, пробел ведёт дальше</div>`;
  }

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
    renderQuiz();
  }

  area.addEventListener('click', (e) => {
    if (!quiz) return;
    if (e.target.closest('#again')) return startQuiz();
    const w = quiz.queue[quiz.i];
    if (!w) return;

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
    if (!quiz || !$('#view-quiz').classList.contains('active')) return;
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
  updateCount(); // reading must never rewrite the saved list
  const saved = store.get('wc_article', null);
  renderArticle(saved && saved.blocks ? saved : DEMO);
})();
