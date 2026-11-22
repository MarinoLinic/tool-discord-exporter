# Project guidance

- This is a Windows-first, local Discord archive tool. Keep the desktop and CLI on the same `core/` API. The CLI must remain dependency-free on Node 24+ and must work from any working directory.
- Discord access uses the official bot API. Keep tokens out of repository files, shell arguments, stdout, logs, and screenshots. Default to Windows DPAPI for saved credentials and support an injected process variable.
- The repository tracks synthetic fixtures only. Store actual exports and settings outside the checkout by default. Do not inspect real archives when testing.
- Maintain the versioned stdout envelope, JSONL row contract and manifest. Keep IDs as strings, store time as UTC, and use stable original Discord URLs.
- New jobs use a private staging directory and publish once complete. A failed batch must not publish a partial export or modify prior exports. Record attachment skips and source limitations clearly. Do not render Discord text as HTML.
- Start with `npm test`. For UI changes run the actual Electron QA against a new isolated path under `agent-files/trash/project-reviews/tool-discord-exporter/`. See README verification instructions. Update the README captures when a desktop surface materially changes.
- Keep `AI_USAGE.md`, CLI schema, and the canonical skill synchronized. Install the skill under `.codex/skills/discord-exporter/` after changes.
