import { setTimeout as delay } from 'node:timers/promises';
import { Problem, validateToken } from './state.mjs';
import { profileToken } from './profiles.mjs';

export const isId = value => typeof value === 'string' && /^\d{17,20}$/.test(value) && BigInt(value) < 1n << 64n;
export function channelId(value) {
  if (isId(value)) return value;
  const match = typeof value === 'string' && /^https:\/\/(?:www\.|canary\.|ptb\.)?discord\.com\/channels\/(?:@me|\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/.exec(value.trim());
  if (match && isId(match[1])) return match[1];
  throw new Problem('INVALID_CHANNEL', 'Enter a Discord channel ID or a discord.com channel link.', 2);
}

const api = 'https://discord.com/api/v10';
const channelKinds = new Set([0, 2, 5, 10, 11, 12, 13]);
const threadKinds = new Set([10, 11, 12]);
const forumKinds = new Set([15, 16]);
const historyPermission = 1n << 16n;
const viewPermission = 1n << 10n;
const manageThreads = 1n << 34n;
function normalizeChannel(item, byId = new Map(), guildName = '') {
  const parent = threadKinds.has(item.type) ? byId.get(item.parent_id) : null;
  const categoryId = parent ? parent.parent_id : byId.get(item.parent_id)?.type === 4 ? item.parent_id : null;
  const category = byId.get(categoryId);
  return { id: item.id, name: item.name || item.id, guildId: item.guild_id ?? null, guildName,
    categoryId: categoryId ?? null, category: category?.name ?? '', type: item.type,
    parentId: threadKinds.has(item.type) ? item.parent_id : null, parentName: parent?.name ?? '',
    archived: Boolean(item.thread_metadata?.archived),
    position: parent?.position ?? item.position ?? 0, categoryPosition: category?.position ?? -1 };
}

function channelPermissions(channel, guild, member, roles, userId) {
  const memberRoles = new Set(member.roles);
  let allow = roles.reduce((bits, role) => role.id === guild.id || memberRoles.has(role.id)
    ? bits | BigInt(role.permissions) : bits, 0n);
  if (guild.owner_id === userId || (allow & 8n)) return ~0n;
  const overwrites = channel.permission_overwrites ?? [];
  function apply(list) {
    const grant = list.reduce((bits, entry) => bits | BigInt(entry.allow), 0n);
    const deny = list.reduce((bits, entry) => bits | BigInt(entry.deny), 0n);
    allow = (allow & ~deny) | grant;
  }
  apply(overwrites.filter(entry => entry.id === guild.id));
  apply(overwrites.filter(entry => entry.type === 0 && memberRoles.has(entry.id)));
  apply(overwrites.filter(entry => entry.type === 1 && entry.id === userId));
  return allow;
}

const apiErrors = {
  401: ['AUTH_FAILED', 'Discord rejected the bot token. Check the token in Settings.'],
  403: ['ACCESS_DENIED', 'The bot lacks access. Check View Channel and Read Message History permissions.'],
  404: ['NOT_FOUND', 'Discord could not find that channel or server for this bot.'],
  429: ['RATE_LIMIT', 'Discord is rate limiting this bot. Wait before trying again.'],
};

export async function source(mode, signal, fetcher = fetch, auth = {}) {
  if (mode === 'demo') return (await import('../fixtures/discord-demo.mjs')).demoSource();
  if (mode !== 'discord') throw new Problem('INVALID_OPTIONS', 'Source must be discord or demo.', 2);
  const token = auth.token ? validateToken(auth.token) : await profileToken(auth.profileId);
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
  let currentUser;
  async function identity() {
    const user = currentUser ??= await get('/users/@me');
    if (!user.bot) throw new Problem('AUTH_FAILED', 'Use a bot token from the Discord Developer Portal.');
    return { id: user.id, name: user.username };
  }
  async function catalog(id, { archived = false, progress = () => {}, restore = null } = {}) {
    if (!isId(id)) throw new Problem('INVALID_CHANNEL', 'Invalid server ID.', 2);
    const { id: userId } = await identity();
    const guildPath = '/guilds/' + id;
    const guild = await get(guildPath);
    const member = await get(guildPath + '/members/' + userId);
    const items = await get(guildPath + '/channels');
    const byId = new Map(items.map(item => [item.id, item]));
    const parents = items.filter(item => channelKinds.has(item.type) || forumKinds.has(item.type));
    const perms = new Map(parents.map(item => [item.id, channelPermissions(item, guild, member, guild.roles, userId)]));
    const readable = item => Boolean(((perms.get(item.parentId ?? item.id) ?? 0n) & (viewPermission | historyPermission)) === (viewPermission | historyPermission));
    const inaccessible = [];
    const rows = new Map();
    function add(item) {
      const value = normalizeChannel({ ...item, guild_id: id }, byId, guild.name);
      if (readable(value)) rows.set(value.id, value);
      else inaccessible.push({ id: value.id, name: value.name });
    }
    for (const item of parents) if (channelKinds.has(item.type)) add(item);
    const active = await get(guildPath + '/threads/active');
    for (const item of active.threads) add(item);
    const warnings = [...(restore?.warnings ?? [])];
    if (archived) {
      for (const thread of restore?.threads ?? []) add(thread);
      const finished = new Set(restore?.finished ?? []);
      const savedThreads = new Map((restore?.threads ?? []).map(thread => [thread.id, thread]));
      const candidates = parents.filter(item => [0, 5, 15, 16].includes(item.type) &&
        (perms.get(item.id) & (viewPermission | historyPermission)) === (viewPermission | historyPermission));
      for (const item of candidates) {
        signal?.throwIfAborted();
        if (finished.has(item.id)) continue;
        const routes = [['public', 'timestamp']];
        if (item.type === 0) routes.push(perms.get(item.id) & manageThreads
          ? ['private', 'timestamp'] : ['joined/private', 'id']);
        for (const [route, cursorType] of routes) {
          let cursor;
          const path = '/channels/' + item.id + (route === 'joined/private' ? '/users/@me/threads/archived/' : '/threads/archived/') + route.split('/').at(-1);
          for (;;) {
            let response;
            try { response = await get(path, { limit: 100, ...(cursor ? { before: cursor } : {}) }); }
            catch (error) {
              if (error.code !== 'ACCESS_DENIED' && error.code !== 'NOT_FOUND') throw error;
              warnings.push('Could not list ' + route + ' archived threads for #' + item.name + ' [' + item.id + '].');
              break;
            }
            for (const thread of response.threads) { add(thread); savedThreads.set(thread.id, thread); }
            if (!response.has_more) break;
            const last = response.threads.at(-1);
            const next = cursorType === 'id' ? last?.id : last?.thread_metadata?.archive_timestamp;
            if (!next || next === cursor) {
              warnings.push('Archived thread pagination stopped early for #' + item.name + ' [' + item.id + '].');
              break;
            }
            cursor = next;
          }
        }
        finished.add(item.id);
        await progress({ stage: 'discover', completed: finished.size, total: candidates.length, found: rows.size },
          { finished: [...finished], threads: [...savedThreads.values()], warnings });
      }
    }
    return { guild: { id, name: guild.name }, inaccessible, warnings,
      channels: [...rows.values()].sort((a, b) => a.categoryPosition - b.categoryPosition ||
        a.position - b.position || Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)) || a.name.localeCompare(b.name)) };
  }
  return {
    identity,
    catalog,
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
    channels: async id => (await catalog(id)).channels,
    channel: async id => {
      const item = await get('/channels/' + channelId(id));
      if (!item.guild_id || !channelKinds.has(item.type))
        throw new Problem('UNSUPPORTED_CHANNEL', 'Choose a server channel or thread with message history.');
      return normalizeChannel(item);
    },
    page: async (id, query) => get('/channels/' + channelId(id) + '/messages', query),
    message: async (id, message) => get('/channels/' + channelId(id) + '/messages/' + channelId(message)),
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
    flags: item.flags ?? 0, poll: item.poll ?? null, pinned: Boolean(item.pinned),
  };
}
