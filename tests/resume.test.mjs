import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const workspace = await mkdtemp(join(tmpdir(), 'discord-exporter-resume-'));
process.env.DISCORD_EXPORTER_HOME = join(workspace, 'home');
process.env.DISCORD_BOT_TOKEN = 'fixture.for.mocked-api';
const { prepareExport, runJob } = await import('../core/export.mjs');
const { jobStatus } = await import('../core/jobs.mjs');
const { defaults } = await import('../core/state.mjs');
const { source } = await import('../core/source.mjs');
after(() => rm(workspace, { recursive: true, force: true }));

test('a paused export resumes after the saved page with no duplicate messages', async () => {
  const guild = '1200000000000000001';
  const channel = '1200000000000000010';
  const rows = Array.from({ length: 142 }, (_, i) => ({
    id: String(1200000000000001000n + BigInt(i)), timestamp: '2026-08-13T00:00:00Z', type: 0,
    author: { id: guild, username: 'Test author' }, content: 'Example ' + i,
  })).reverse();
  const cursors = [];
  let currentBot = guild;
  const fetcher = async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/users/@me')) return Response.json({ id: currentBot, username: 'Test bot', bot: true });
    if (!url.pathname.endsWith('/messages')) return Response.json({ id: channel, guild_id: guild, name: 'checkpoint', type: 0 });
    const before = url.searchParams.get('before');
    cursors.push(before);
    return Response.json(rows.filter(row => BigInt(row.id) < BigInt(before)).slice(0, 100));
  };
  const job = await prepareExport({ channels: [channel], output: workspace, name: 'Resume sample', formats: ['html', 'json'] }, defaults);
  const pause = new AbortController();
  await assert.rejects(runJob(job.id, { fetcher, signal: pause.signal, progress: status => {
    if (status.stage === 'fetch' && status.matched === 100) pause.abort();
  } }), { code: 'PAUSED' });
  assert.equal((await jobStatus(job.id)).state, 'paused');
  assert.equal(cursors.length, 1);
  assert.equal((await jobStatus(job.id)).botProfile.id, 'environment');
  currentBot = channel;
  await assert.rejects(runJob(job.id, { fetcher }), { code: 'PROFILE_CHANGED' });
  assert.equal(cursors.length, 1);
  currentBot = guild;
  const manifest = await runJob(job.id, { fetcher });
  assert.equal(manifest.messageCount, 142);
  assert.deepEqual(cursors.slice(1), [rows[99].id]);
  const json = JSON.parse(await readFile(join(manifest.output, manifest.channels[0].files.json), 'utf8'));
  assert.deepEqual(json.messages.map(row => row.id), rows.map(row => row.id).reverse());
  assert.equal((await jobStatus(job.id)).state, 'completed');
});

test('archive discovery lists readable categories, active and archived threads, and skips private channels', async () => {
  const guild = '1200000000000000001';
  const user = '1200000000000000002';
  const category = '1200000000000000003';
  const parent = '1200000000000000004';
  const denied = '1200000000000000005';
  const active = '1200000000000000006';
  const thread = '1200000000000000007';
  const requests = [];
  const fetcher = async input => {
    const url = new URL(input);
    const route = url.pathname.split('/v10')[1];
    requests.push(route + url.search);
    if (route === '/users/@me') return Response.json({ id: user, bot: true, username: 'Test bot' });
    if (route === '/guilds/' + guild) return Response.json({ id: guild, name: 'Test guild', roles: [{ id: guild, permissions: '66560' }] });
    if (route.endsWith('/members/' + user)) return Response.json({ roles: [] });
    if (route.endsWith('/channels')) return Response.json([{ id: category, name: 'Sources', type: 4 },
      { id: parent, name: 'notes', type: 0, parent_id: category },
      { id: denied, name: 'private', type: 0, permission_overwrites: [{ id: guild, deny: '1024', allow: '0', type: 0 }] }]);
    if (route.endsWith('/threads/active')) return Response.json({ threads: [{ id: active, name: 'Active', parent_id: parent, type: 11 }] });
    if (route.endsWith('/threads/archived/public')) return Response.json({ threads: [
      { id: thread, name: 'Archived', parent_id: parent, type: 11, thread_metadata: { archived: true } },
    ], has_more: false });
    if (route.endsWith('/threads/archived/private')) return Response.json({ threads: [], has_more: false });
    return new Response(null, { status: 404 });
  };
  const provider = await source('discord', undefined, fetcher);
  let restored;
  const catalog = await provider.catalog(guild, { archived: true, progress: (_, checkpoint) => { restored = checkpoint; } });
  assert.deepEqual(new Set(catalog.channels.map(item => item.id)), new Set([parent, active, thread]));
  assert.equal(catalog.channels.find(item => item.id === thread).category, 'Sources');
  assert.deepEqual(catalog.inaccessible.map(item => item.id), [denied]);
  const archivedRequests = () => requests.filter(route => route.includes('/archived/')).length;
  assert.equal(archivedRequests(), 2);
  assert.equal((await provider.catalog(guild, { archived: true, restore: restored })).channels.length, 3);
  assert.equal(archivedRequests(), 2);
});
