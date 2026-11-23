import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const folder = await mkdtemp(join(tmpdir(), 'discord-exporter-embeds-'));
process.env.DISCORD_EXPORTER_HOME = folder;
process.env.DISCORD_BOT_TOKEN = 'fixture.embeds.mocked-api';
const { runExport, exportOptions } = await import('../core/export.mjs');
const { defaults } = await import('../core/state.mjs');
after(() => rm(folder, { recursive: true, force: true }));

test('embeds default to on, including for earlier profiles, and explicit choices take precedence', () => {
  const options = { channels: ['1200000000000000010'] };
  assert.ok(exportOptions(options, defaults).fields.includes('embeds'));
  assert.ok(!exportOptions({ ...options, embeds: undefined }, { ...defaults, embeds: false }).embeds);
  assert.ok(!exportOptions({ ...options, embeds: false, fields: ['embeds'] }, defaults).fields.includes('embeds'));
  assert.ok(!exportOptions({ ...options, fields: [] }, defaults).embeds);
  assert.ok(exportOptions({ ...options, embeds: true, fields: [] }, defaults).fields.includes('embeds'));
});

test('default export downloads allowed preview media once and renders it offline in every format', async () => {
  const channel = '1200000000000000010';
  const guild = '1200000000000000001';
  const thumbnail = 'https://i.ytimg.com/vi/video-ident/hqdefault.jpg';
  const proxy = 'https://images-ext-1.discordapp.net/external/test-thumbnail';
  const clip = 'https://cdn.discordapp.com/attachments/123/456/clip.mp4';
  const player = 'https://www.youtube.com/embed/video-ident';
  const forbidden = 'https://untrusted.invalid/image.png';
  const embed = {
    title: 'A <survey> video', type: 'video', url: 'https://www.youtube.com/watch?v=video-ident',
    provider: { name: 'YouTube' }, thumbnail: { url: thumbnail, proxy_url: proxy }, video: { url: player },
  };
  const rows = [
    { id: '1200000000000000011', timestamp: '2026-09-10T13:00:00Z', content: 'One', embeds: [embed] },
    { id: '1200000000000000012', timestamp: '2026-09-10T13:01:00Z', content: 'Two', embeds: [
      embed, { title: 'Hosted clip', video: { url: clip } }, { title: 'External image', image: { url: forbidden } },
    ] },
  ];
  const downloaded = [];
  const fetcher = async (input, init) => {
    const url = new URL(input);
    if (url.hostname !== 'discord.com') {
      assert.equal(init.headers, undefined);
      assert.equal(init.redirect, 'error');
      downloaded.push(url.href);
      if (url.href === proxy) return new Response('missing', { status: 404 });
      if (url.href === thumbnail) return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } });
      if (url.href === clip) return new Response('video', { headers: { 'Content-Type': 'video/mp4' } });
      assert.fail('Unexpected embed media request.');
    }
    if (url.pathname.endsWith('/users/@me')) return Response.json({ id: guild, username: 'Test bot', bot: true });
    if (url.pathname.endsWith('/messages')) return Response.json(rows);
    return Response.json({ id: channel, guild_id: guild, name: 'embeds', type: 0 });
  };
  const options = { channels: [channel], output: folder, formats: ['html', 'json', 'jsonl', 'markdown'] };
  const manifest = await runExport(options, defaults, { fetcher });
  assert.equal(manifest.embeds.included, true);
  assert.deepEqual(manifest.embeds, { included: true, downloaded: 2, skipped: 1, bytes: 10 });
  assert.deepEqual(new Set(downloaded), new Set([proxy, thumbnail, clip]));
  assert.equal(downloaded.length, 3);
  const read = async format => readFile(join(manifest.output, manifest.channels[0].files[format]), 'utf8');
  const data = JSON.parse(await read('json'));
  const image = data.messages[0].embeds[0].media.thumbnail.path;
  assert.match(image, /^assets\/embeds\/embed-[a-f0-9]+\.jpg$/);
  assert.equal(await readFile(join(manifest.output, image), 'utf8'), 'image');
  assert.equal(data.messages[1].embeds[0].media.thumbnail.path, image);
  assert.equal(data.messages[1].embeds[2].media.image.status, 'unsupported-url');
  assert.equal(JSON.parse((await read('jsonl')).split('\n')[0]).embeds[0].media.thumbnail.path, image);
  const html = await read('html');
  assert.ok(html.includes('src="../' + image + '"'));
  assert.match(html, /A &lt;survey&gt; video/);
  assert.match(html, /<video controls/);
  assert.doesNotMatch(html, /<iframe|src="https:\/\//);
  assert.ok((await read('markdown')).includes('../' + image));
  const disabled = await runExport({ ...options, embeds: false }, defaults, { fetcher });
  assert.equal(downloaded.length, 3);
  assert.equal(disabled.embeds.included, false);
  for (const format of ['json', 'jsonl']) {
    const text = await readFile(join(disabled.output, disabled.channels[0].files[format]), 'utf8');
    assert.doesNotMatch(text, /"embeds":\[/);
  }
});
