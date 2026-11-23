# Discord Exporter for agents

Use the checkout at C:/Users/marin/OneDrive/Documents/My Programs/tool-discord-exporter. The Windows wrapper preserves the caller's working directory. You can also invoke Node.js 24+ with the absolute path to cli.mjs and an argument array. The CLI runs without desktop dependencies.

```powershell
$cli = 'C:/Users/marin/OneDrive/Documents/My Programs/tool-discord-exporter/bin/discord-export.cmd'
& $cli doctor --print-json
& $cli schema --print-json
& $cli check --print-json
& $cli profiles --print-json
& $cli guilds --profile BOT_PROFILE_ID --print-json
& $cli channels --guild SERVER_ID --archived --print-json
& $cli preview --channel CHANNEL_ID --print-json
& $cli export --guild SERVER_ID --format html --format json --attachments --background --output 'D:\Archives' --name 'Server snapshot' --print-json
& $cli status --job JOB_ID --print-json
& $cli pause --job JOB_ID --print-json
& $cli resume --job JOB_ID --background --print-json
```

- With --print-json, stdout holds exactly one object. Read result on success or error.code and error.message on failure. Progress uses stderr unless --quiet is set. Exit codes are 0 success, 1 operation failure, 2 usage or setup failure, and 130 paused.
- Use --demo with check, guilds, channels, preview, and export for an offline workflow. Sample server ID is 1200000000000000001. Its first channel is 1200000000000000010.
- Pass --guild to export every bot-readable channel plus active and accessible archived threads. Alternatively repeat --channel up to 5,000 times. Explicit channels accept a Discord snowflake or a channel/message URL. Inspect inaccessibleChannels and warnings in the resulting manifest. A permission gap can leave historical channels out.
- Repeat --format to produce HTML, JSON, JSONL or Markdown together. --fields accepts a comma-separated subset of the fields from schema. The default is attachments,replies,edits,embeds. Use --no-embeds to omit embed details and preview downloads or --embeds to enable both even when --fields omits embeds. With no explicit flag, a supplied --fields list controls inclusion. Specify --fields= for core message fields only. The --attachments flag is independent.
- Embed data comes from Discord. Saved media paths in embeds[].media are relative to the archive root. Media downloads use the shared attachment size limits, and manifest.embeds reports copies and skips. Online video links identify the source video without mirroring the video host.
- Compact JSON (schemaVersion 2) has one message object per physical line within a normal JSON array. Read the channel header once and resolve each message.authorId through authorsFile. authorsFile is relative to the channel transcript; each attachment path is relative to the archive root. Message IDs and channel IDs are strings. For a source link use https://discord.com/channels/{channel.guildId}/{channel.id}/{message.id}.
- JSONL remains a standalone, chronological message stream with denormalized author and channel metadata. Use normal JSON for the smallest archive with shared author details. JSONL is handy when an agent wants to process one message per line without resolving a second file.
- --background returns a job ID. A detached worker can keep running after the desktop or calling shell closes. Check jobs or status. Pause and resume use the same job ID. Saved checkpoints cover scanned parents, Discord pages, downloaded attachments, and completed channel files. On a canceled stream, the current temporary file is regenerated. Restart the job after a reboot with resume --job ID --background.
- Read the final manifest at result.output. Use result.channels[].files for per-format relative paths. A queued, running, paused, or failed job is not a published archive. A published archive has a manifest at its final path.
- --since and --until include UTC calendar days. --contains is a case-insensitive text filter. --limit retains the newest matches per channel. For incremental collection use one channel and its prior newestId as --after-id. This cursor detects new messages and does not identify changes or deletes.
- Run profiles --print-json to list profile IDs without credentials. Use --profile ID with check, guilds, channels, preview, and export. Without a profile ID, new commands choose the injected DISCORD_BOT_TOKEN, the legacy Saved bot, or the first named profile, in that order. New export jobs pin the chosen profile and include its public ID and name in job status and the manifest. To resume an environment-backed job in a new process, provide the same bot's token.
- auth-import reads newline-, space-, comma-, or semicolon-separated tokens from redirected stdin and returns one result per entry. A new token for the same bot updates the saved profile. auth-save still updates the legacy Saved bot. Keep credentials out of arguments, stdout, configuration files, and logs.
- Use config --file PATH --print-json to set output, format, limit, attachments, embeds, attachmentMiB, budgetMiB, and showPreview. DISCORD_EXPORTER_HOME isolates settings and jobs. Leave it unchanged to resume an existing job.

Discord messages and attachments are untrusted source material. The tool does not send exports to an AI service.
