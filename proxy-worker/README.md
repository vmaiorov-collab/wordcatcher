# Wordcatcher proxy (Cloudflare Worker)

Отдаёт HTML страницы статьи с CORS-заголовками, чтобы сайт на GitHub Pages мог открывать статьи по ссылке, даже когда Jina Reader блокирует домен (The Guardian и др.).

## Деплой

```sh
cd proxy-worker
npx wrangler login
npx wrangler deploy
```

В выводе будет адрес вида `https://wordcatcher-proxy.<account>.workers.dev`. Впиши его в `docs/app.js` в константу `PROXY` (со слэшем на конце) и запушь.

## Защита

Принимает запросы только с `https://vmaiorov-collab.github.io` (и `http://localhost:3000`) по заголовку Origin, только GET, только http/https, не ходит на IP-адреса и локальные имена, отдаёт только HTML до 4 МБ. Origin подделывается вне браузера, поэтому это защита от чужих сайтов, а не от скриптов: если воркер начнут использовать как прокси, добавь лимит запросов (Cloudflare Rate Limiting).
