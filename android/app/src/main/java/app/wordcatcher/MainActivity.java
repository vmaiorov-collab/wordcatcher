package app.wordcatcher;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The Wordcatcher web app (docs/ in the repository, packed into assets/www) in a WebView,
 * plus what a browser page cannot do: loading article pages directly (no CORS, no reader
 * service), system text-to-speech, saving the CSV export and receiving "Share" from a browser.
 */
public class MainActivity extends Activity {
    // Reserved by Google for serving local app content; requests to it never leave the device.
    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/";
    private static final int MAX_PAGE_BYTES = 6 * 1024 * 1024;
    private static final int REQ_SAVE = 1;
    private static final Pattern URL_RE = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);
    private static final Pattern CHARSET_RE = Pattern.compile("charset\\s*=\\s*[\"']?([\\w.:-]+)", Pattern.CASE_INSENSITIVE);

    private WebView web;
    private String userAgent = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
    private boolean pageReady;
    private String pendingScript; // a shared link that arrived before the page finished loading

    private TextToSpeech tts;
    private volatile boolean ttsReady;

    private byte[] pendingSave;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        if (!night && Build.VERSION.SDK_INT >= 27) {
            View decor = getWindow().getDecorView();
            decor.setSystemUiVisibility(decor.getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }

        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.bg));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the word list lives in localStorage
        s.setMediaPlaybackRequiresUserGesture(false); // pronunciation starts after an async lookup
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // Present as a regular mobile Chrome, to the sites as well as to the translation services.
        userAgent = s.getUserAgentString().replace("; wv)", ")").replaceAll(" Version/\\d+\\.\\d+", "");
        s.setUserAgentString(userAgent);

        web.addJavascriptInterface(new Bridge(), "WordcatcherNative");
        web.setWebChromeClient(new WebChromeClient()); // alert / confirm / prompt dialogs
        web.setWebViewClient(new Client());

        tts = new TextToSpeech(this, status -> {
            if (status != TextToSpeech.SUCCESS) return;
            tts.setLanguage(Locale.US);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { ttsDone(id, true); }
                @Override public void onError(String id) { ttsDone(id, false); }
                @Override public void onStop(String id, boolean interrupted) { ttsDone(id, false); }
            });
            ttsReady = true;
        });

        if (savedInstanceState == null) handleShare(getIntent());
        web.loadUrl(HOME);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShare(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (tts != null) tts.stop();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        web.destroy();
        super.onDestroy();
    }

    // ---------- "Share" from a browser ----------

    private void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        CharSequence extra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (extra == null) return;
        String text = extra.toString().trim();
        if (text.isEmpty()) return;
        // Browsers share "Title https://…" or just the link; a longer text without a link is the article itself.
        Matcher m = URL_RE.matcher(text);
        String script = m.find() && text.length() < 2000
                ? "window.__wcOpenUrl&&__wcOpenUrl(" + JSONObject.quote(m.group()) + ")"
                : "window.__wcOpenText&&__wcOpenText(" + JSONObject.quote(text) + ")";
        if (pageReady) web.evaluateJavascript(script, null);
        else pendingScript = script;
    }

    // ---------- the page ----------

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (HOST.equals(u.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u)); // article sources etc. open in the browser
            } catch (Exception e) { /* nothing can open it */ }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            pageReady = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            if (pendingScript != null) {
                String script = pendingScript;
                pendingScript = null;
                view.evaluateJavascript(script, null);
            }
        }

        // Runs on a background thread, so the blocking network call for /native/fetch is fine here.
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String path = u.getPath() == null ? "/" : u.getPath();
            // Readability comes from a CDN on the website; the app carries its own copy.
            if ("cdn.jsdelivr.net".equals(u.getHost()) && path.endsWith("/Readability.js")) {
                return asset("native/Readability.js");
            }
            if (!HOST.equals(u.getHost())) return null;
            if (path.equals("/native/fetch")) return fetchPage(u.getQueryParameter("url"));
            if (path.startsWith("/native/")) return asset(path.substring(1));
            if (path.startsWith("/api/")) return error(404, "Not Found"); // no Node server here: the page falls back to direct calls
            if (path.equals("/") || path.equals("/index.html")) return index();
            return asset("www" + path);
        }
    }

    private static WebResourceResponse error(int status, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason, null,
                new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    private WebResourceResponse asset(String path) {
        if (path.contains("..")) return error(404, "Not Found");
        try {
            return new WebResourceResponse(mime(path), "utf-8", getAssets().open(path));
        } catch (IOException e) {
            return error(404, "Not Found");
        }
    }

    // index.html with the native shim placed before every other script.
    private WebResourceResponse index() {
        try (InputStream in = getAssets().open("www/index.html")) {
            String html = new String(readAll(in, MAX_PAGE_BYTES), StandardCharsets.UTF_8)
                    .replaceFirst("<head>", "<head>\n  <script src=\"native/shim.js\"></script>");
            return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        } catch (IOException e) {
            return error(404, "Not Found");
        }
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > max) throw new IOException("too large");
        }
        return out.toByteArray();
    }

    // ---------- article pages ----------

    // Downloads the article page the way a browser would and hands its HTML (as UTF-8) to the web app,
    // which extracts the article with Readability. Only public http(s) addresses are allowed.
    private WebResourceResponse fetchPage(String address) {
        HttpURLConnection c = null;
        try {
            URL url = new URL(address);
            for (int hop = 0; ; hop++) {
                String proto = url.getProtocol();
                if (!"https".equals(proto) && !"http".equals(proto)) return error(400, "Unsupported url");
                InetAddress a = InetAddress.getByName(url.getHost());
                if (a.isLoopbackAddress() || a.isAnyLocalAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress()) {
                    return error(400, "Unsupported url");
                }
                c = (HttpURLConnection) url.openConnection();
                c.setInstanceFollowRedirects(false); // followed by hand: each hop is checked, http → https works
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                c.setRequestProperty("User-Agent", userAgent);
                c.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
                c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
                int status = c.getResponseCode();
                if (status >= 300 && status < 400 && status != 304) {
                    String location = c.getHeaderField("Location");
                    c.disconnect();
                    if (location == null || hop >= 6) return error(502, "Bad Gateway");
                    url = new URL(url, location);
                    continue;
                }
                if (status < 200 || status > 299) {
                    int safe = status >= 400 && status <= 599 ? status : 502;
                    return error(safe, "The site answered " + status);
                }
                String type = c.getContentType() == null ? "" : c.getContentType();
                if (!type.isEmpty() && !type.contains("html")) return error(415, "Not an HTML page");
                byte[] body;
                try (InputStream in = c.getInputStream()) {
                    body = readAll(in, MAX_PAGE_BYTES);
                }
                byte[] utf8 = new String(body, charsetOf(type, body)).getBytes(StandardCharsets.UTF_8);
                Map<String, String> headers = new HashMap<>();
                headers.put("X-Final-Url", url.toString());
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse("text/html", "utf-8", 200, "OK", headers, new ByteArrayInputStream(utf8));
            }
        } catch (Exception e) {
            return error(502, "Could not reach the site");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // The encoding from the Content-Type header, else from a <meta> near the top of the page, else UTF-8.
    private static Charset charsetOf(String contentType, byte[] body) {
        String head = new String(body, 0, Math.min(body.length, 4096), StandardCharsets.ISO_8859_1);
        for (String source : new String[] { contentType, head }) {
            Matcher m = CHARSET_RE.matcher(source);
            if (!m.find()) continue;
            try {
                return Charset.forName(m.group(1));
            } catch (Exception e) { /* unknown name: try the next source */ }
        }
        return StandardCharsets.UTF_8;
    }

    // ---------- called from the page (native/shim.js), on a background thread ----------

    private class Bridge {
        @JavascriptInterface
        public void speak(String text, double rate, String id) {
            if (!ttsReady || text == null || text.trim().isEmpty()) {
                ttsDone(id, false);
                return;
            }
            if (text.length() > 3500) text = text.substring(0, 3500);
            tts.setSpeechRate((float) Math.max(0.5, Math.min(2.0, rate)));
            if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) ttsDone(id, false);
        }

        @JavascriptInterface
        public void stopSpeaking() {
            if (ttsReady) tts.stop();
        }

        @JavascriptInterface
        public void saveFile(String name, String mimeType, String text) {
            byte[] data = text.getBytes(StandardCharsets.UTF_8);
            runOnUiThread(() -> {
                pendingSave = data;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(mimeType == null || mimeType.isEmpty() ? "text/plain" : mimeType)
                        .putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (Exception e) {
                    pendingSave = null;
                    Toast.makeText(MainActivity.this, "Не удалось открыть выбор папки", Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private void ttsDone(String id, boolean ok) {
        runOnUiThread(() -> web.evaluateJavascript(
                "window.__wcTtsDone&&__wcTtsDone(" + JSONObject.quote(id) + "," + ok + ")", null));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SAVE) return;
        byte[] bytes = pendingSave;
        pendingSave = null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null || bytes == null) return;
        try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
            out.write(bytes);
            Toast.makeText(this, "Файл сохранён", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Не удалось сохранить файл", Toast.LENGTH_LONG).show();
        }
    }
}
