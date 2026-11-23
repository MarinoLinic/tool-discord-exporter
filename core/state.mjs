import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const home = resolve(process.env.DISCORD_EXPORTER_HOME || join(process.env.LOCALAPPDATA || homedir(), 'DiscordExporter'));
export const formats = ['html', 'jsonl', 'markdown', 'json'];
const credential = join(home, 'bot.dpapi');
export const defaults = {
  output: join(home, 'exports'), format: 'html', limit: 0,
  attachments: false, embeds: true, attachmentMiB: 25, budgetMiB: 256, showPreview: true,
};

export class Problem extends Error {
  constructor(code, message, exit = 1) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

export async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export async function renameStateFile(temporary, destination) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(temporary, destination); }
    catch (error) {
      const sharingViolation = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (!sharingViolation || attempt === 6) throw error;
      await delay(12 * 2 ** attempt);
    }
  }
}

export async function atomic(path, content) {
  await mkdir(home, { recursive: true });
  const temporary = join(home, randomUUID() + '.tmp');
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  await renameStateFile(temporary, path);
}

export function settingsValues(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Problem('INVALID_OPTIONS', 'Settings must be a JSON object.', 2);
  const value = Object.fromEntries(Object.keys(defaults).map(key => [key, input[key] ?? defaults[key]]));
  if (typeof value.output !== 'string' || !isAbsolute(value.output) || !formats.includes(value.format))
    throw new Problem('INVALID_OPTIONS', 'Choose an absolute output folder and a supported format.', 2);
  for (const [key, min, max] of [['limit', 0, 10_000_000], ['attachmentMiB', 1, 1024], ['budgetMiB', 1, 16384]]) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new Problem('INVALID_OPTIONS', key + ' must be an integer from ' + min + ' to ' + max + '.', 2);
  }
  if (['attachments', 'embeds', 'showPreview'].some(key => typeof value[key] !== 'boolean'))
    throw new Problem('INVALID_OPTIONS', 'Expected true or false for attachment, embed, and preview settings.', 2);
  return value;
}

export async function settings() {
  const saved = await readOptional(join(home, 'settings.json'));
  return settingsValues(saved ? JSON.parse(saved) : {});
}

export const saveSettings = async input => {
  const value = settingsValues(input);
  await atomic(join(home, 'settings.json'), JSON.stringify(value, null, 2) + '\n');
  return value;
};

export function validateToken(token) {
  if (typeof token !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token.trim()) || token.length > 256)
    throw new Problem('INVALID_TOKEN', 'Enter a Discord bot token from the Developer Portal.', 2);
  return token.trim();
}

export function protect(input, decrypt = false) {
  if (process.platform !== 'win32')
    throw new Problem('UNSUPPORTED', 'Saved credentials require Windows. Set DISCORD_BOT_TOKEN in the process environment.');
  const method = decrypt
    ? '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputValue),$null,$scope))'
    : '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($inputValue),$null,$scope))';
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser; $inputValue=[Console]::In.ReadToEnd().Trim(); [Console]::Write(" + method + ")";
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000,
    });
    let result = '';
    child.stdout.setEncoding('utf8').on('data', value => { result += value; });
    const failure = () => reject(new Problem('VAULT_ERROR', 'Windows could not access the saved credential for this account.'));
    child.on('error', failure);
    child.stdin.on('error', failure);
    child.on('close', code => code === 0 && result ? resolve(result) : failure());
    child.stdin.end(input);
  });
}

export async function credentialStatus() {
  const saved = Boolean((await readOptional(credential))?.trim());
  return { saved, source: process.env.DISCORD_BOT_TOKEN?.trim() ? 'environment' : saved ? 'windows' : 'none' };
}

export async function savedToken() {
  const encrypted = await readOptional(credential);
  return encrypted?.trim() ? validateToken(await protect(encrypted, true)) : '';
}

export async function botToken() {
  const injected = process.env.DISCORD_BOT_TOKEN?.trim();
  return injected ? validateToken(injected) : await savedToken();
}
export const saveToken = async token => atomic(credential, await protect(validateToken(token)));
export const clearToken = async () => atomic(credential, '');

export async function record(manifest) {
  const dir = join(home, 'history');
  await mkdir(dir, { recursive: true });
  await atomic(join(dir, manifest.jobId + '.json'), JSON.stringify(manifest));
}

export async function history() {
  const dir = join(home, 'history');
  const files = await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const latest = files.filter(file => /^\d{8}T\d{9}Z-[a-f\d]{8}\.json$/.test(file)).sort().reverse().slice(0, 100);
  return await Promise.all(latest.map(async file => JSON.parse(await readFile(join(dir, file), 'utf8'))));
}
