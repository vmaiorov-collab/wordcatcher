// Loaded before app.js inside the Android app only. Connects the web app to the native side:
// page loading without third-party readers, system text-to-speech, saving files, "Share" from a browser.
(function () {
  'use strict';
  var native = window.WordcatcherNative;
  if (!native) return;

  // Articles are fetched by the app itself (see MainActivity.fetchPage), then extracted locally.
  window.WC_PROXY = '/native/fetch';

  // ---------- text-to-speech (WebView has no working speechSynthesis) ----------
  var pending = new Map();
  var seq = 0;
  window.SpeechSynthesisUtterance = function (text) {
    this.text = String(text == null ? '' : text);
    this.lang = 'en-US';
    this.rate = 1;
    this.voice = null;
    this.onend = null;
    this.onerror = null;
  };
  var synth = {
    getVoices: function () { return []; },
    speak: function (u) {
      var id = String(++seq);
      pending.set(id, u);
      native.speak(u.text, Number(u.rate) || 1, id);
    },
    cancel: function () {
      pending.clear();
      native.stopSpeaking();
    },
  };
  try {
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  } catch (e) { /* keep the built-in one */ }
  window.__wcTtsDone = function (id, ok) {
    var u = pending.get(id);
    if (!u) return;
    pending.delete(id);
    var f = ok ? u.onend : u.onerror;
    if (typeof f === 'function') f({});
  };

  // ---------- downloads (<a download> with a blob: address does nothing in a WebView) ----------
  var blobs = new Map();
  var createUrl = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var u = createUrl(obj);
    if (obj instanceof Blob) {
      blobs.set(u, obj);
      if (blobs.size > 20) blobs.delete(blobs.keys().next().value);
    }
    return u;
  };
  var anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var blob = this.hasAttribute('download') ? blobs.get(this.href) : null;
    if (!blob) return anchorClick.call(this);
    blobs.delete(this.href);
    var name = this.getAttribute('download') || 'wordcatcher.txt';
    var type = (blob.type || 'text/plain').split(';')[0];
    blob.text().then(function (text) {
      if (type === 'text/csv') text = '\uFEFF' + text; // text() drops the byte-order mark Excel needs for Cyrillic
      native.saveFile(name, type, text);
    });
  };

  // ---------- "Share" from a browser ----------
  function showRead() {
    var tab = document.querySelector('#tabs button[data-view="read"]');
    if (tab) tab.click();
  }
  function submit(form) {
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }
  // The native side calls these after the page has loaded.
  window.__wcOpenUrl = function (url) {
    showRead();
    document.getElementById('url').value = url;
    submit(document.getElementById('url-form'));
  };
  window.__wcOpenText = function (text) {
    showRead();
    document.getElementById('paste-text').value = text;
    submit(document.getElementById('paste-form'));
  };

  // The bookmarklet is a desktop-browser feature; in the app "Share → Wordcatcher" replaces it.
  var css = document.createElement('style');
  css.textContent = '#bookmarklet{display:none!important}';
  document.documentElement.appendChild(css);
})();
