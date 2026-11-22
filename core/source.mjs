import { setTimeout as delay } from 'node:timers/promises';
import { botToken, Problem } from './state.mjs';

export const isId = value => typeof value === 'string' && /^\d{17,20}$/.test(value) && BigInt(value) < 1n << 64n;
export function channelId(value) {
  if (isId(value)) return value;
  const match = typeof value === 'string' && /^https:\/\/(?:www\.|canary\.|ptb\.)?discord\.com\/channels\/(?:@me|\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/.exec(value.trim());
  if (match && isId(match[1])) return match[1];
  throw new Problem('INVALID_CHANNEL', 'Enter a Discord channel ID or a discord.com channel link.', 2);
}

export const demoGuild = '1200000000000000001';
const base = 1200000000000000010n;
const sample = [
  ['field-notes', [
    ['Mina Park', 'The scanned maps are in the shared drive. I added a short note on how we dated the unlabeled sheets.'],
    ['Elias Reed', 'Great. Let’s keep the original filenames in the index so we can trace every revision.'],
    ['June Ellis', 'I found a second copy of the harbor survey. It has the missing legend and a handwritten reference number.'],
    ['Mina Park', 'I set aside the two uncertain dates for review. The places and coordinates match the field notebook.'],
  ]],
  ['reading-room', [
    ['June Ellis', 'Added the coastal atlas to next week’s reading list. Chapter three has the original survey notes.'],
    ['Elias Reed', 'I’ll bring the printed index. We can compare the station names side by side.'],
  ]],
  ['map-workshop', [
    ['Mina Park', 'The new map includes the inset we discussed. Check the compass rose before we print.'],
    ['June Ellis', 'Looks ready. I’ve left a note on the two mile markers.'],
  ]],
  ['open-questions', [['Elias Reed', 'Does anyone have the original date for the western breakwater sketch?']]],
  ['announcements', [['Mina Park', 'Our next archive review is on Thursday. Bring one source you want to discuss.']]],
];
const guild = { id: demoGuild, name: 'Field Archive' };
const channels = sample.map(([name], i) => ({ id: String(base + BigInt(i)), guildId: demoGuild, category: i < 4 ? 'Research' : 'General', name, type: 0 }));
export const firstDemoChannel = channels[0].id;
const names = ['Mina Park', 'Elias Reed', 'June Ellis'];
const fixtures = new Map(channels.map((channel, i) => [channel.id, sample[i][1].map(([name, content], j) => ({
  id: String(base + 100n + BigInt(i * 10 + j)),
  timestamp: new Date(Date.UTC(2026, 10, 18, 10, 12 + j * 17)).toISOString(),
  author: { id: String(base + 200n + BigInt(names.indexOf(name))), username: name },
  content, attachments: [], embeds: [], type: 0,
})).reverse()]));

const api = 'https://discord.com/api/v10';
const channelKinds = new Set([0, 2, 5, 10, 11, 12, 13]);
const normalizeChannel = (item, categories = new Map()) => ({
  id: item.id, name: item.name || item.id, guildId: item.guild_id ?? null,
  category: categories.get(item.parent_id) ?? '', type: item.type,
});

const apiErrors = {
  401: ['AUTH_FAILED', 'Discord rejected the bot token. Check the token in Settings.'],
  403: ['ACCESS_DENIED', 'The bot lacks access. Check View Channel and Read Message History permissions.'],
  404: ['NOT_FOUND', 'Discord could not find that channel or server for this bot.'],
  429: ['RATE_LIMIT', 'Discord is rate limiting this bot. Wait before trying again.'],
};

export async function source(mode, signal, fetcher = fetch) {
  if (mode === 'demo') return {
    identity: async () => ({ id: '1200000000000000000', name: 'Sample bot' }),
    guilds: async () => [guild],
    channels: async id => {
      if (id !== demoGuild) throw new Problem('NOT_FOUND', 'That server is outside the sample archive.');
      return channels;
    },
    channel: async id => {
      const match = channels.find(item => item.id === id);
      if (!match) throw new Problem('NOT_FOUND', 'That channel is outside the sample archive.');
      return match;
    },
    page: async (id, query) => (fixtures.get(id) ?? []).filter(item =>
      (!query.before || BigInt(item.id) < BigInt(query.before)) &&
      (!query.after || BigInt(item.id) > BigInt(query.after))).slice(0, query.limit),
  };
  if (mode !== 'discord') throw new Problem('INVALID_OPTIONS', 'Source must be discord or demo.', 2);
  const token = await botToken();
  if (!token) throw new Problem('MISSING_TOKEN', 'Add a Discord bot token in Settings or set DISCORD_BOT_TOKEN.', 2);
  async function get(path, query = {}) {
    const url = api + path + '?' + new URLSearchParams(query);
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetcher(url, {
          headers: { Authorization: 'Bot ' + token, 'User-Agent': 'DiscordBot (https://github.com/MarinoLinic/tool-discord-exporter, 0.1.0)' },
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
      } catch {
        signal?.throwIfAborted();
        if (attempt === 4) throw new Problem('NETWORK_ERROR', 'Could not reach the Discord API.');
        await delay(400 * 2 ** attempt, undefined, { signal });
        continue;
      }
      if (response.ok) return await response.json();
      const body = response.status === 429 ? await response.json().catch(() => ({})) : (await response.body?.cancel(), {});
      const retry = Number(body?.retry_after ?? response.headers.get('Retry-After') ?? 1);
      if (attempt < 4 && (response.status >= 500 || (response.status === 429 && Number.isFinite(retry) && retry <= 60))) {
        await delay(response.status === 429 ? Math.max(250, retry * 1000 + 100) : 400 * 2 ** attempt, undefined, { signal });
        continue;
      }
      const [code, message] = apiErrors[response.status] ?? ['DISCORD_ERROR', 'Discord returned HTTP ' + response.status + '.'];
      throw new Problem(code, message);
    }
  }
  return {
    identity: async () => {
      const user = await get('/users/@me');
      if (!user.bot) throw new Problem('AUTH_FAILED', 'Use a bot token from the Discord Developer Portal.');
      return { id: user.id, name: user.username };
    },
    guilds: async () => {
      const guilds = [];
      let after;
      for (;;) {
        const page = await get('/users/@me/guilds', after ? { limit: 200, after } : { limit: 200 });
        guilds.push(...page.map(({ id, name }) => ({ id, name })));
        if (page.length < 200) break;
        const cursor = page.reduce((max, item) => BigInt(item.id) > BigInt(max) ? item.id : max, '0');
        if (cursor === after) throw new Problem('PAGINATION_ERROR', 'Discord returned a repeated server page.');
        after = cursor;
      }
      return guilds.sort((a, b) => a.name.localeCompare(b.name));
    },
    channels: async id => {
      if (!isId(id)) throw new Problem('INVALID_CHANNEL', 'Invalid server ID.', 2);
      const items = await get('/guilds/' + id + '/channels');
      const active = await get('/guilds/' + id + '/threads/active').catch(error => {
        if (error.code === 'ACCESS_DENIED') return { threads: [] };
        throw error;
      });
      const categories = new Map(items.map(item => [item.id, item.name]));
      return [...items, ...active.threads].filter(item => channelKinds.has(item.type))
        .map(item => normalizeChannel({ ...item, guild_id: item.guild_id ?? id }, categories))
        .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    },
    channel: async id => {
      const item = await get('/channels/' + channelId(id));
      if (!item.guild_id || !channelKinds.has(item.type))
        throw new Problem('UNSUPPORTED_CHANNEL', 'Choose a server channel or thread with message history.');
      return normalizeChannel(item);
    },
    page: async (id, query) => get('/channels/' + channelId(id) + '/messages', query),
  };
}

export function normalizeMessage(item, channel) {
  return {
    id: item.id, channelId: channel.id, guildId: channel.guildId,
    timestamp: item.timestamp, editedTimestamp: item.edited_timestamp ?? null,
    url: 'https://discord.com/channels/' + channel.guildId + '/' + channel.id + '/' + item.id,
    type: item.type, content: item.content ?? '',
    author: item.author ? {
      id: item.author.id, username: item.author.username,
      displayName: item.member?.nick ?? item.author.global_name ?? item.author.username,
      bot: Boolean(item.author.bot),
    } : null,
    replyTo: item.message_reference?.message_id ?? null,
    attachments: (item.attachments ?? []).map(file => ({
      id: file.id, name: file.filename, size: file.size, url: file.url,
      contentType: file.content_type ?? null, description: file.description ?? null,
    })),
    embeds: item.embeds ?? [], reactions: item.reactions ?? [],
    stickers: item.sticker_items ?? [], mentions: item.mentions ?? [],
    flags: item.flags ?? 0, poll: item.poll ?? null,
  };
}
