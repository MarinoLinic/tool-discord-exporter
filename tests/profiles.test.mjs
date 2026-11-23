import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const folder = await mkdtemp(join(tmpdir(), 'discord-exporter-profiles-'));
process.env.DISCORD_EXPORTER_HOME = folder;
const { importProfiles, profiles, profileToken, renameProfile, removeProfile, replaceProfileToken } = await import('../core/profiles.mjs');
const { saveToken, defaults } = await import('../core/state.mjs');
const { prepareExport, runJob } = await import('../core/export.mjs');
after(() => rm(folder, { recursive: true, force: true }));

test('imports multiple encrypted profiles, preserves legacy credentials, and pins a named profile for the worker', { skip: process.platform !== 'win32' }, async () => {
  const first = '1200000000000000301';
  const second = '1200000000000000302';
  const one = 'fixture.first.named-bot';
  const two = 'fixture.second.named-bot';
  const rotated = 'fixture.first.rotated-bot';
  await saveToken('fixture.legacy.named-bot');
  const identify = async token => token === two ? { id: second, name: 'Second Bot' } : { id: first, name: 'First Bot' };
  const added = await importProfiles([one, two, one, 'bad'].join('\n'), identify);
  assert.deepEqual(added.map(row => row.status), ['added', 'added', 'duplicate', 'failed']);
  assert.equal(await profileToken(first), one);
  assert.equal(await profileToken(second), two);
  assert.equal(await profileToken('default'), 'fixture.legacy.named-bot');
  const disk = await readFile(join(folder, 'profiles', first + '.json'), 'utf8');
  assert.ok(!disk.includes(one));
  await renameProfile(first, 'Research');
  assert.equal((await importProfiles(rotated, identify))[0].status, 'updated');
  await assert.rejects(replaceProfileToken(first, two, identify), { code: 'PROFILE_CHANGED' });
  await replaceProfileToken(first, one, identify);
  assert.equal(await profileToken(first), one);
  await replaceProfileToken(first, rotated, identify);
  assert.equal((await profiles()).find(row => row.id === first).name, 'Research');
  await assert.rejects(profileToken('../bot'), { code: 'INVALID_PROFILE' });

  const channel = '1200000000000000010';
  const job = await prepareExport({ channels: [channel], output: folder, profileId: first }, defaults);
  assert.equal(job.botProfile.id, first);
  process.env.DISCORD_BOT_TOKEN = 'fixture.other.named-bot';
  const fetcher = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bot ' + rotated);
    if (new URL(url).pathname.endsWith('/messages')) return Response.json([]);
    return Response.json({ id: channel, guild_id: second, type: 0, name: 'profile-specific' });
  };
  const manifest = await runJob(job.id, { fetcher });
  assert.equal(manifest.botProfile.id, first);
  await removeProfile(first);
  await assert.rejects(profileToken(first), { code: 'PROFILE_NOT_FOUND' });
  assert.equal(await profileToken(second), two);
  assert.equal(await profileToken('default'), 'fixture.legacy.named-bot');
});
