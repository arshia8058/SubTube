# SubTube — YouTube Subtitle Translator Telegram Bot (to Persian)

**SubTube** is an open-source Telegram bot: send it a YouTube link, it extracts the
video's subtitles, translates them into Persian, and sends back a ready-to-use
**SRT** file — with an optional **Persian summary** of the video. Everything runs
on **Cloudflare Workers**: no server to maintain.

Persian README (main): [README.md](README.md) · Full Persian docs live in [`docs/`](docs/).

## How it works

1. You send a YouTube link (up to 3 links in one message).
2. Inline buttons ask: **subtitle only**, **summary only**, or **both**.
3. The job runs in a Cloudflare Queue (webhook background work is killed after
   ~30s, so the queue consumer — with a 15-minute budget — does the real work),
   with a live progress message in Telegram and a per-job web progress page.
4. Subtitles are extracted, translated to Persian, and delivered as an `.srt` file.

## Features

- Multi-route subtitle extraction: Supadata API first, then direct YouTube
  routes (watch page, Innertube, timedtext) and public Invidious instances
- Source-language detection; non-English videos supported; ready-made Persian
  captions pass through untranslated with a note to the user
- Three translation engines with automatic fallback: **Coarena**
  (OpenAI-compatible) → **Google Gemini** → **Google Translate**
- Two-key Coarena pool with automatic failover on quota/auth errors
- ID-based translation contract: every cue carries a global ID and a chunk is
  only accepted if the returned ID set matches exactly — cue order and timing
  can never scramble; a final validation pass refuses to ship a broken file
- Live progress in Telegram + a per-job web page (`/p/<token>`)
- 48-hour translation cache in KV; repeat links answer instantly
- Three-step file delivery ladder (download link → direct upload → text chunks)
  for days when Telegram's media ingress is degraded
- Per-user hourly rate limit, duplicate-job guard, `/cancel` support
- Commands: `/start` `/translate` `/status` `/history` `/usage` `/stats`
  `/help` `/about` `/cancel`

## Tech stack

Cloudflare Workers (JavaScript ES modules) · Queues · D1 (SQLite) · KV ·
Telegram Bot API · Supadata · Coarena · Google Gemini · Google Translate

## Quick start

```bash
git clone https://github.com/arshia8058/SubTube.git
cd SubTube
npm install
npx wrangler login
npx wrangler d1 create subtube-db
npx wrangler kv namespace create SUBTITLE_CACHE
npx wrangler queues create subtube-jobs
npx wrangler d1 execute subtube-db --remote --file=migrations/schema.sql
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler deploy
```

Then register the Telegram webhook (remember `callback_query` in
`allowed_updates`, or the mode-selection buttons will not work) and send your
bot a link. The full step-by-step guide (in Persian) is
[`docs/INSTALL_FA.md`](docs/INSTALL_FA.md); configuration and every environment
variable are documented in [`docs/CONFIG_FA.md`](docs/CONFIG_FA.md).

## Repository layout

- `src/index.js` — the complete Worker source, published exactly as it runs
  (a bundled single module; internal sections are marked with `// src/...`
  comments that map to the original modules)
- `migrations/schema.sql` — the D1 schema, reconstructed from the actual
  queries in the code (`users`, `jobs`, `user_stats`, `settings`)
- `tests/` — 12 offline test suites; run `node tests/make_test_bundle.mjs`
  first, then each `tests/test_*.mjs`
- `tools/deploy.py` — an alternative, sanitized deploy helper using the
  Cloudflare API directly (Wrangler is the recommended path)
- `docs/` — architecture, installation, configuration, APIs, troubleshooting (Persian)

## Security

No real keys or tokens are — or may ever be — committed. All secrets are set
through Cloudflare Secrets. See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The project's golden rule is
**zero regression**: the full test battery must be green before and after
every change.

## License

[MIT](LICENSE)
