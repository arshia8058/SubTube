# SubTube on Rubika — design note (2026-11-19)

Status: DESIGN ONLY. No code changed yet. Build proceeds under
DEVELOPMENT_POLICY.md (snapshot, baseline battery, single-purpose
commits, full regression gate, 6-point report).

## Goal
Add a Rubika front-end to the existing SubTube pipeline: a Rubika user
sends a video link to @Muse464Bot, picks subtitle/summary/both, and
receives the Persian SRT — same extraction/translation core, Telegram
side untouched.

## Verified facts (2026-11-19, live)
- Bot exists: @Muse464Bot (title "Muse"), created by Arshia via
  Rubika's BotFather. Token stored in the Secure Vault under connector
  custom.rubika-bot; Muse tests via
  ~/workspace/custom-connectors/custom.rubika-bot/bin/rubika_api.py.
- API: POST https://botapi.rubika.ir/v3/<token>/<method>, JSON body,
  replies {"status":"OK","data":{...}}. Reachable from non-Iran egress
  (this VM). getMe OK; getUpdates OK; sendMessage OK (round-trip with
  Arshia proven: he sent /start + «سلام», bot replied).
- Update delivery: register URLs with updateBotEndpoints {url, type};
  types needed: ReceiveUpdate (messages) and ReceiveInlineMessage
  (inline button taps). No secret header exists — protect the webhook
  path with an unguessable token segment, fail closed.
- Update shape: {type: StartedBot|NewMessage|..., chat_id: "b0...",
  new_message: {message_id (string), text, sender_id, sender_type}}.
  All Rubika IDs are STRINGS (Telegram's are integers).
- Sending files: requestSendFile {type:"File"} → upload URL → upload
  bytes → file_id → sendFile {chat_id, file_id}. (Libraries report a
  ~50 MB cap; SRTs are far below it.)
- Messages: sendMessage {chat_id, text, inline_keypad}, editMessageText,
  deleteMessage, setCommands {bot_commands} all exist.

## Architecture seam (from the 2026-11-19 index.js review)
- Add createRubikaClient(token) beside createTelegramClient (line 175),
  exposing the same verbs the pipeline uses (send text, edit text,
  send file, answer tap) so processVideoJob/deliverSrt stay shared.
- New routes: POST /rubika/update and POST /rubika/inline behind a
  secret path segment. Normalize Rubika updates into the existing
  internal flow: same choice prompt (pend: KV, 30 min), same queue
  (buildQueueMessage gains platform:"rubika" + string chatId), same
  consumer; the consumer picks the reply client by platform.
- Delivery ladder for Rubika: sendFile flow → the existing /f/
  download-link message (unchanged rung). Never dump SRT text in chat
  (standing rule, all platforms).
- Progress: Rubika editMessageText allows the same simplified
  title + bar + percent message; web progress page unchanged.

## Identity / data (decision required at build time, policy step 1)
users/jobs/user_stats are keyed by telegram_id and the code treats it
as a Telegram integer in places. Rubika chat_ids are strings. Before
writing any code, audit every query touching telegram_id and choose:
(a) namespace Rubika identities as text keys in the same tables, or
(b) a parallel lightweight mapping for Rubika. Do NOT silently coerce.

## Buttons
Choice prompt via inline_keypad (rows of simple buttons with ids).
Taps arrive as ReceiveInlineMessage updates carrying the button id —
map ids to the same srt/sum/both modes; pending-choice KV entries get
a platform prefix so Telegram and Rubika tokens can never collide.
Retranslate/generate offer buttons: same mapping, phase 2 if needed.

## Secrets & deployment
- RUBIKA_BOT_TOKEN must become a Worker secret. Muse cannot move the
  vault value into the Worker (surrogates only work on Muse's own
  egress). Arshia adds it once in the Cloudflare dashboard
  (subtube-bot → Settings → Variables and Secrets) — guided step.
- After deploy: register both endpoints via updateBotEndpoints to the
  live Worker URLs; verify with a real message from Arshia's Rubika.

## First build step (before any feature code)
Prove Worker → botapi.rubika.ir egress: a temporary DIAG_TOKEN-gated
probe in the Worker that calls getMe with the secret and returns the
status. My VM's egress working does NOT prove Cloudflare's does. If
the Worker cannot reach Rubika, stop and rethink (no silent fallback).

## Risks
- Rubika rate limits undocumented — keep the Telegram-side pacing
  habits (few, chunky messages; progress edits throttled).
- Rubika webhook retries/timeouts unknown — handlers must be fast:
  enqueue only, exactly like the Telegram webhook.
- Zero Regression Policy invariants all apply; the Telegram webhook
  stays fail-closed and callback_query stays in allowed_updates.
