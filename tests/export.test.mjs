import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const workspace = await mkdtemp(join(tmpdir(), 'discord-exporter-test-'));
process.env.DISCORD_EXPORTER_HOME = join(workspace, 'app');
process.env.DISCORD_BOT_TOKEN = 'fixture.for.mocked-api';
const { prepareExport, runExport, runJob } = await import('../core/export.mjs');
const { jobStatus } = await import('../core/jobs.mjs');
const { channelId } = await import('../core/source.mjs');
const { firstDemoChannel } = await import('../fixtures/discord-demo.mjs');
const { defaults, history, saveSettings, settings, saveToken, savedToken, clearToken } = await import('../core/state.mjs');
after(() => rm(workspace, { recursive: true, force: true }));

test('CLI produces one JSON envelope and exposes a separate history receipt', async () => {
  const invoke = (...args) => spawnSync(process.execPath, ['cli.mjs', ...args, '--print-json'], { encoding: 'utf8' });
  const exportRun = invoke('export', '--demo', '--channel', firstDemoChannel, '--format', 'jsonl', '--contains', 'maps', '--output', workspace);
  assert.equal(exportRun.status, 0, exportRun.stderr);
  const { result } = JSON.parse(exportRun.stdout);
  assert.equal(result.messageCount, 1);
  const row = JSON.parse(await readFile(join(result.output, result.channels[0].file), 'utf8'));
  assert.equal(row.channelId, firstDemoChannel);
  assert.match(row.content, /scanned maps/);
  assert.match(exportRun.stderr, /messages/);
  assert.equal((await history())[0].jobId, result.jobId);
  assert.equal(JSON.parse(invoke('schema').stdout).result.version, 1);
  assert.equal(invoke('export').status, 2);
  assert.equal(JSON.parse(invoke('export').stdout).error.code, 'INVALID_CHANNEL');
  const metadata = invoke('doctor').stdout;
  assert.equal(metadata.includes(process.env.DISCORD_BOT_TOKEN), false);
});

test('validates Discord links, UTC date boundaries and newest matching limit', async () => {
  const id = channelId('https://discord.com/channels/1200000000000000001/' + firstDemoChannel);
  assert.equal(id, firstDemoChannel);
  assert.throws(() => channelId('https://example.com/channels/1/' + firstDemoChannel));
  const options = { channels: [id], mode: 'demo', output: workspace, format: 'json' };
  await assert.rejects(runExport({ ...options, since: '2026-02-31' }, defaults), { code: 'INVALID_DATE' });
  const result = await runExport({ ...options, since: '2026-11-18', until: '2026-11-18', limit: 2 }, defaults);
  const content = JSON.parse(await readFile(join(result.output, result.channels[0].file), 'utf8'));
  const { authors } = JSON.parse(await readFile(join(result.output, content.authorsFile), 'utf8'));
  assert.deepEqual(content.messages.map(message => authors[message.authorId].displayName), ['June Ellis', 'Mina Park']);
  assert.ok(content.messages.every(row => !row.author && !row.embeds && !row.channelId));
  assert.ok(result.channels[0].stoppedAtLimit);
  assert.ok(BigInt(result.channels[0].newestId) > BigInt(result.channels[0].oldestId));
});

test('Discord pagination and retry preserve order, escape HTML and download bounded attachments', async () => {
  const guildId = '1200000000000000001';
  const rows = Array.from({ length: 131 }, (_, i) => ({
    id: String(1200000000000001000n + BigInt(i)), timestamp: '2026-09-10T13:00:00Z', type: 0,
    author: { id: guildId, username: '<script>author</script>' },
    content: i === 0 ? '<img onerror="alert(1)">' : 'Message ' + i,
    ...(i === 0 ? { embeds: [{ title: 'Omitted preview', url: 'https://example.com/test' }],
      reactions: [{ emoji: { name: 'Omitted reaction' }, count: 2 }], mentions: [{ id: guildId }] } : {}),
    ...(i === 0 ? { attachments: [
      { id: '1', filename: '../evidence.txt', size: 5, url: 'https://cdn.discordapp.com/attachments/a/b/file' },
      { id: '2', filename: 'blocked.html', size: 5, url: 'https://example.com/attachments/secret' },
      { id: '3', filename: 'A'.repeat(63) + '.png', size: 5, url: 'https://cdn.discordapp.com/attachments/a/b/long' },
    ] } : {}),
  })).reverse();
  let fails = true, requests = 0;
  const fetcher = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'cdn.discordapp.com') {
      assert.equal(init.headers, undefined);
      return new Response('proof');
    }
    assert.equal(url.hostname, 'discord.com');
    assert.match(init.headers.Authorization, /^Bot fixture/);
    assert.equal(init.redirect, 'error');
    if (url.pathname.endsWith('/users/@me')) return Response.json({ id: guildId, username: 'Test bot', bot: true });
    if (!url.pathname.endsWith('/messages')) return Response.json({ id: firstDemoChannel, guild_id: guildId, name: 'evidence', type: 0 });
    if (fails) { fails = false; return Response.json({ retry_after: 0 }, { status: 429 }); }
    requests++;
    const before = url.searchParams.get('before');
    return Response.json(rows.filter(x => !before || BigInt(x.id) < BigInt(before)).slice(0, 100));
  };
  const result = await runExport({ channels: [firstDemoChannel], format: 'html', formats: ['html', 'json'],
    output: workspace, attachments: true, fields: ['attachments'] }, defaults, { fetcher });
  assert.equal(requests, 2);
  assert.equal(result.messageCount, 131);
  assert.deepEqual(result.attachments, { bytes: 10, downloaded: 2, skipped: 1 });
  const text = await readFile(join(result.output, result.channels[0].file), 'utf8');
  assert.match(text, /&lt;img onerror=/);
  assert.doesNotMatch(text, /<script>/);
  assert.ok(text.indexOf('Message 1<') < text.indexOf('Message 130<'));
  assert.equal(await readFile(join(result.output, 'assets', '1-evidence.txt'), 'utf8'), 'proof');
  assert.match(text, /\.\.\/assets\/1-evidence\.txt/);
  const compact = JSON.parse(await readFile(join(result.output, result.channels[0].files.json), 'utf8'));
  assert.equal(compact.schemaVersion, 2);
  assert.equal(compact.authorsFile, '../authors.json');
  assert.equal(compact.messages[0].attachments[0].path, 'assets/1-evidence.txt');
  const longPath = compact.messages[0].attachments[2].path;
  assert.match(longPath, /^assets\/3-A{60}\.png$/);
  assert.equal(await readFile(join(result.output, longPath), 'utf8'), 'proof');
  assert.equal(compact.messages[0].author, undefined);
  assert.equal(compact.messages[0].channelId, undefined);
  assert.equal(compact.messages[0].reactions, undefined);
  assert.equal(compact.messages[0].mentions, undefined);
  assert.equal(compact.messages[0].embeds, undefined);
  assert.doesNotMatch(text, /Omitted preview|Omitted reaction/);
  assert.match(await readFile(join(result.output, 'index.html'), 'utf8'), /HTML\//);
});

test('failed jobs leave no published bundle and do not overwrite existing files', async () => {
  const out = join(workspace, 'failed');
  await assert.rejects(runExport({ channels: [firstDemoChannel, '1200000000000000099'], mode: 'demo', output: out }, defaults), { code: 'NOT_FOUND' });
  assert.deepEqual(await readdir(out).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
});

test('defaults persist and a synthetic Windows credential round-trips without plaintext on disk', { skip: process.platform !== 'win32' }, async () => {
  await saveSettings({ ...defaults, limit: 8 });
  await saveSettings({ ...defaults, limit: 9 });
  assert.equal((await settings()).limit, 9);
  const placeholder = 'example.not.a-secret';
  await saveToken(placeholder);
  assert.equal(await savedToken(), placeholder);
  assert.doesNotMatch(await readFile(join(process.env.DISCORD_EXPORTER_HOME, 'bot.dpapi'), 'utf8'), /not\.a-secret/);
  await clearToken();
  assert.equal(await savedToken(), '');
});
