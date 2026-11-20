# SubTube — Zero Regression Policy (دستورالعمل دائمی توسعه)

Adopted 2026-11-15 at Arshia's instruction. This policy governs EVERY future
change to this project. Speed never outranks keeping healthy features healthy.

## Golden rule
No healthy feature may break because of a new feature or a bug fix.

## Before any change
1. Read the whole module being touched and identify its dependents
   (search every caller of shared functions before editing them).
2. Snapshot the current code: `cp index.js index_backup_<date>_<slug>.js`.
3. Run the full offline battery and record the baseline (must be all green
   before starting; if something is already red, report it, don't bury it).
4. State the risk surface: which features could this change affect?

## Change discipline
- Small, single-purpose changes; never bundle independent features.
- Don't touch unrelated files. Don't delete existing code without a reason.
- Module contracts stay stable: translation (ID-based matching), extraction
  (normalizeCues choke point), SRT generation, progress tracking, storage
  keys — changing a shared contract requires checking all consumers first.

## After any change (the regression gate — all required before "done")
1. `node --check index.js`
2. Rebuild the test bundle and run ALL suites:
   test_translation, test_coarena, test_multilang, test_keypool,
   test_gemini_order, test_units, test_srtfix, test_choice, test_progress
3. Deploy, then live gates: health endpoint, webhook 401 without secret,
   diag 401 without token.
4. A real end-to-end check with the diag (mode=cues / mode=fulltest) on the
   standard videos: u2MfX-J1_zo (short), e7fnVYzW8Ko (long),
   POHIwXGSd88 (auto-captions). SRT stats must stay: 0 overlaps,
   0 non-monotonic, max 2 lines, max 42 chars/line.
5. If any test fails: fix the new change. Never hide a failure, never
   declare completion with a red suite.

## Mandatory report after each change
1. What changed and why. 2. Which files. 3. What could be affected.
4. Which tests ran. 5. Did a regression occur? 6. Are all previous
tests still green?

## Rollback
Git was initialized in this folder on 2026-11-15 (first commit = the
all-green baseline of that day). One commit per feature/fix, per section 7
of the policy. The dated `index_backup_*.js` snapshots remain on disk as a
second safety net (gitignored, never overwritten). `.diag_token` and the
deploy/settings snapshots are gitignored and must never be committed.

## Protected invariants (never silently change)
- Translation model: coarena / gemini-4-argon (D1 settings) — only on
  Arshia's explicit request.
- Gemini-path candidate order: gemini-3.1-flash-lite first (his choice since 2026-11-18; fastest in the live probe).
- Cache key versions (cap2:, fa2:) — bump, never repurpose.
- Webhook allowed_updates must include callback_query (buttons depend on it).
- /_diag stays DIAG_TOKEN-gated; webhook stays fail-closed.
