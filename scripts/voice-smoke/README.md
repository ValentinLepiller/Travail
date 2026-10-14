# Native voice smoke

`node scripts/voice-smoke/run.mjs --out .logs/harness/voice-smoke`

Runs immediate and 12-second synthetic callbacks against the current `CodexVoiceSession`. Requires the existing Codex ChatGPT login, Node 24+, root devDependency `werift`, Python 3, system `libopus`, and `ffmpeg` with `libopus`. Never logs in, installs dependencies, launches a real MT task, or accesses a microphone. It consumes the account's native voice/Codex allowance.

Exit 0 requires WebRTC, one callback per scenario, a completed assistant response containing its arbitrary marker, and non-silent decoded audio received during that response after the callback resolved. Exit 1 means the native proof failed; exit 2 means local prerequisites/imports were unavailable. `summary.json` at the destination is the stable maintenance receipt; per-run summaries and decoded response windows live in `runs/`. No tokens, SDP, raw account details, or raw transcripts are saved.

Use `--scenario immediate` or `--scenario late` for a focused run. `--home /path/to/codex-home` selects the candidate or dedicated home; default `.t3/harness/codex` has no implicit global-home fallback. `--werift-path /absolute/path/to/werift` allows an explicitly provisioned package without installing anything. Each scenario has a 70-second deadline and closes its own native session and encoder. PCM plus the provider transcript is not independent speech recognition or human listening, and does not validate telephone behavior or barge-in.

The RTC gate covers immediate and late result delivery only. Changed instructions, source revisions, and stale-result suppression are covered by `apps/server/src/voice/CodexVoiceSession.test.ts` and `voiceDelegation.test.ts`; these use a fake native server and do not prove live acoustic interruption. The earlier research probe demonstrated a correction while pending on the direct delegation path, which is separate from this native bridge smoke.

`request.wav` is a local Flite-generated transport-check sentence requesting confirmation only; it contains no result marker. The script pads the file with silence before playback so the entire input remains paced by `ffmpeg -re`.

Focused criteria tests: `./node_modules/.bin/vp test run scripts/voice-smoke/result.test.mjs`.
