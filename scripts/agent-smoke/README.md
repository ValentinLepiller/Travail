# Native agents smoke

`node scripts/agent-smoke/run.mjs --out .logs/harness/agent-smoke`

Uses the existing Effect App Server client and native harness profile. `--codex /path/to/candidate` overrides only the executable; `--settings /path/to/settings.json` selects a native profile. `--home /path/to/codex-home` selects the credential source; otherwise use that profile's home or `.t3/harness/codex`, never implicitly `~/.codex`. Without a settings file, the normal harness bootstrap supplies it in temporary state. No dependency installation or native protocol reimplementation.

Requires the existing native ChatGPT `auth.json`. Its private snapshot and all Codex/workspace state remain temporary and are removed. There is no login flow, paid API fallback, business task, file command, connector or browser action. The run consumes native ChatGPT/Codex allowance and takes at most 180 seconds plus process cleanup (`--timeout-ms` accepts 120000–180000).

Exit 0 requires one distinct child born and completed in native collaboration/activity events, its own completed history containing the child marker, then the parent's final completed result returning both markers. Parent text claiming delegation is insufficient. Normal durable threads live only in the temporary Codex home; `ephemeral:true` changes native forking/history behavior. The workspace must remain empty and no external action may be observed. Exit 1 means native proof failed; exit 2 means local/profile/auth prerequisites were unavailable. The stable receipt is `summary.json`; no credentials, account details, raw requests or transcripts are logged. This proves native spawning and result return, separately from MT cross-project coordination and voice.

Criteria tests: `./node_modules/.bin/vp test run scripts/agent-smoke/proof.test.mjs`.
