# Project guidance

- This is a Windows-first, local Discord archive tool. Keep the desktop and CLI on the same `core/` API. The CLI must remain dependency-free on Node 24+ and must work from any working directory.
- Discord access uses the official bot API. Keep tokens out of repository files, shell arguments, stdout, logs, and screenshots. Default to Windows DPAPI for saved credentials and support an injected process variable.
- The repository tracks synthetic fixtures only. Store actual exports and settings outside the checkout by default. Do not inspect real archives when testing.
- Maintain the versioned stdout envelope, JSONL row contract, compact JSON v2 and manifest. Keep IDs as strings and times in UTC. Compact JSON resolves author IDs through `authors.json` and uses bundle-relative media paths.
- New jobs use private SQLite checkpoints and a sibling staging directory. Detached workers lock their job and publish once complete. Preserve partial state for resume and never overwrite an existing named archive. Query official permissions before a whole-server run and record inaccessible channels, listing warnings, and attachment skips. Escape Discord text and allow offline assets only in transcript embeds.
- Start with `npm test`. For UI changes run the actual Electron QA against a new isolated path under `agent-files/trash/project-reviews/tool-discord-exporter/`. See README verification instructions. Update the README captures when a desktop surface materially changes.
- Keep `AI_USAGE.md`, CLI schema, and the canonical skill synchronized. Install the skill under `.codex/skills/discord-exporter/` after changes.
