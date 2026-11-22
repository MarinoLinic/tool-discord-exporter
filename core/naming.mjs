import { basename } from 'node:path';
import { Problem } from './state.mjs';

export function safeName(value, fallback = 'file') {
  const trimmed = String(value ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  if (!trimmed || trimmed === '.' || trimmed === '..') return fallback;
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(trimmed)) return '_' + trimmed;
  return trimmed;
}

export function archiveName(name, id) {
  if (name === undefined || name === null || name === '') return 'discord-' + id;
  if (typeof name !== 'string' || name.length > 100 || safeName(name) !== name || basename(name) !== name)
    throw new Problem('INVALID_OPTIONS', 'Use a folder name up to 100 characters without path separators or reserved characters.', 2);
  return name;
}

export function channelStem(channel) {
  if (!channel.guildName) return 'channel-' + safeName(channel.name).slice(0, 64) + '-' + channel.id;
  const parts = [channel.guildName, channel.category, channel.name].filter(Boolean);
  return parts.map((part, index) => safeName(part).slice(0, index === 0 ? 48 : index === 1 ? 32 : 36)).join(' - ') + ' [' + channel.id + ']';
}
