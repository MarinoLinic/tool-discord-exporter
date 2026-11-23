import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomic, clearToken, credentialStatus, home, Problem, protect, readOptional, savedToken, saveToken, validateToken } from './state.mjs';

const directory = join(home, 'profiles');
const isBotId = value => typeof value === 'string' && /^\d{17,20}$/.test(value) && BigInt(value) < 1n << 64n;
export const maxImportBytes = 50 * 257;

export function profileId(value) {
  if (value === undefined || value === null) return null;
  if (value === 'default' || value === 'environment' || isBotId(value)) return value;
  throw new Problem('INVALID_PROFILE', 'Choose a bot profile from Settings or list profiles in the CLI.', 2);
}

function file(id) { return join(directory, id + '.json'); }
function labelFile(id) { return join(directory, id + '.label'); }
async function readProfile(id) {
  const saved = await readOptional(file(id));
  if (!saved) return null;
  const profile = JSON.parse(saved);
  return { ...profile, name: (await readOptional(labelFile(id))) ?? profile.botName };
}
async function saveProfile(profile) {
  await mkdir(directory, { recursive: true });
  await atomic(file(profile.id), JSON.stringify(profile) + '\n');
}
function publicProfile({ id, botName, name }) { return { id, name, botName, kind: 'saved' }; }

export async function profiles() {
  const entries = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const named = await Promise.all(entries.filter(entry => entry.endsWith('.json') && isBotId(entry.slice(0, -5)))
    .map(entry => readProfile(entry.slice(0, -5))));
  const result = named.filter(item => item?.encrypted).map(publicProfile).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const status = await credentialStatus();
  if (status.saved) result.unshift({ id: 'default', name: 'Saved bot', kind: 'legacy' });
  if (status.source === 'environment') result.unshift({ id: 'environment', name: 'Environment bot', kind: 'environment' });
  return result;
}

export async function resolveProfile(value) {
  return profileId(value) ?? (await profiles())[0]?.id ?? null;
}

async function requireNamed(id) {
  if (!isBotId(id)) throw new Problem('INVALID_PROFILE', 'Choose a named bot profile.', 2);
  const profile = await readProfile(id);
  if (!profile?.encrypted) throw new Problem('PROFILE_NOT_FOUND', 'This bot profile was removed. Import a token for the same bot to restore it.');
  return profile;
}

export async function profileToken(value) {
  const id = await resolveProfile(value);
  if (!id) return '';
  if (id === 'environment') {
    const token = process.env.DISCORD_BOT_TOKEN?.trim();
    if (!token) throw new Problem('MISSING_TOKEN', 'Set DISCORD_BOT_TOKEN to use the environment bot.');
    return validateToken(token);
  }
  if (id === 'default') {
    const token = await savedToken();
    if (!token) throw new Problem('MISSING_TOKEN', 'The saved bot is no longer configured.');
    return token;
  }
  return validateToken(await protect((await requireNamed(id)).encrypted, true));
}

export async function importProfiles(input, identify) {
  if (typeof input !== 'string' || input.length > maxImportBytes)
    throw new Problem('INVALID_TOKEN', 'Paste up to 50 Discord bot tokens at a time.', 2);
  const tokens = input.trim().split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 50)
    throw new Problem('INVALID_TOKEN', 'Paste between 1 and 50 Discord bot tokens.', 2);
  const seenTokens = new Set();
  const seenBots = new Set();
  const results = [];
  for (const [index, raw] of tokens.entries()) {
    const entry = index + 1;
    if (seenTokens.has(raw)) { results.push({ entry, status: 'duplicate' }); continue; }
    seenTokens.add(raw);
    let identity, token;
    try {
      token = validateToken(raw);
      identity = await identify(token);
      if (!isBotId(identity?.id) || typeof identity.name !== 'string')
        throw new Problem('AUTH_FAILED', 'Discord did not return a valid bot identity.');
    } catch (error) {
      results.push({ entry, status: 'failed', code: error instanceof Problem ? error.code : 'CHECK_FAILED' });
      continue;
    }
    if (seenBots.has(identity.id)) { results.push({ entry, status: 'duplicate' }); continue; }
    const previous = await readProfile(identity.id);
    const profile = {
      id: identity.id,
      botName: identity.name,
      encrypted: await protect(token),
    };
    await saveProfile(profile);
    seenBots.add(identity.id);
    results.push({ entry, status: previous?.encrypted ? 'updated' : 'added', profile: publicProfile(profile) });
  }
  return results;
}

export async function renameProfile(id, value) {
  const profile = await requireNamed(id);
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name))
    throw new Problem('INVALID_PROFILE', 'Use a profile name between 1 and 60 characters.', 2);
  await atomic(labelFile(profile.id), name);
}

export async function replaceProfileToken(id, input, identify) {
  if (id === 'environment') throw new Problem('INVALID_PROFILE', 'Update DISCORD_BOT_TOKEN outside the app.');
  if (id !== 'default') await requireNamed(id);
  const token = validateToken(input);
  const identity = await identify(token);
  if (!isBotId(identity?.id) || typeof identity.name !== 'string')
    throw new Problem('AUTH_FAILED', 'Discord did not return a valid bot identity.');
  if (id === 'default') return await saveToken(token);
  if (identity.id !== id) throw new Problem('PROFILE_CHANGED', 'This token belongs to a different Discord bot. Import it as a separate profile.');
  await saveProfile({ id, botName: identity.name, encrypted: await protect(token) });
}

export async function removeProfile(id) {
  if (id === 'default') return await clearToken();
  const profile = await requireNamed(id);
  await saveProfile({ ...profile, encrypted: null });
}
