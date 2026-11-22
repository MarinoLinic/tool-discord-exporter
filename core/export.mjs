import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as tick } from 'node:timers/promises';
import { Problem, record, settingsValues } from './state.mjs';
import { channelId, isId, normalizeMessage, source } from './source.mjs';
import { createTranscript } from './formats.mjs';

const epoch = 1420070400000;
function dateValue(value, name) {
  if (!value) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value))
    throw new Problem('INVALID_DATE', name + ' must use YYYY-MM-DD.', 2);
  const ms = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value)
    throw new Problem('INVALID_DATE', name + ' is not a real date.', 2);
  return ms;
}

export function exportOptions(input, defaults) {
  const config = settingsValues({ ...defaults, ...input });
  const selected = Array.isArray(input.channels) ? [...new Set(input.channels.map(channelId))] : [];
  if (!selected.length || selected.length > 50)
    throw new Problem('INVALID_CHANNEL', 'Select between 1 and 50 channels.', 2);
  const since = dateValue(input.since, 'Start date');
  const until = dateValue(input.until, 'End date');
  if (since !== null && until !== null && since > until)
    throw new Problem('INVALID_DATE', 'Start date must be on or before the end date.', 2);
  if (input.afterId && (!isId(input.afterId) || selected.length !== 1))
    throw new Problem('INVALID_CHANNEL', 'An after-message ID requires exactly one channel.', 2);
  const contains = input.contains ?? '';
  if (typeof contains !== 'string' || contains.length > 300)
    throw new Problem('INVALID_OPTIONS', 'Search text must be 300 characters or fewer.', 2);
  return { ...config, channels: selected, since, until: until === null ? null : until + 86_400_000,
    contains: contains.trim(), afterId: input.afterId || null, mode: input.mode ?? 'discord' };
}

export async function preview(mode, id, signal) {
  const provider = await source(mode, signal);
  const channel = await provider.channel(channelId(id));
  const rows = await provider.page(channel.id, { limit: 4 });
  return rows.map(row => normalizeMessage(row, channel)).reverse();
}

function safeName(value) {
  return String(value).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 64) || 'file';
}

async function attachment(file, folder, counts, options, signal, fetcher) {
  const max = Math.min(options.attachmentMiB * 1048576, options.budgetMiB * 1048576 - counts.bytes);
  const skip = status => { counts.skipped++; return { ...file, status }; };
  if (!options.attachments) return { ...file, status: 'reference' };
  if (options.mode === 'demo') return skip('sample');
  if (max <= 0 || (Number.isFinite(file.size) && file.size > max)) return skip('size-limit');
  let url;
  try { url = new URL(file.url); } catch { return skip('unsupported-url'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
      !url.pathname.startsWith('/attachments/')) return skip('unsupported-url');
  const name = safeName(file.id) + '-' + safeName(file.name);
  const dir = join(folder, 'assets');
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, randomUUID() + '.part');
  let bytes = 0;
  let exceeded = false;
  try {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    const response = await fetcher(url, { redirect: 'error', signal: requestSignal });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return skip('http-' + response.status);
    }
    if (Number(response.headers.get('Content-Length')) > max) {
      await response.body.cancel();
      return skip('size-limit');
    }
    const meter = new Transform({
      transform(chunk, _, callback) {
        bytes += chunk.length;
        if (bytes > max) { exceeded = true; callback(new Error('Size limit')); }
        else callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx' }), { signal: requestSignal });
    await rename(temporary, join(dir, name));
    counts.bytes += bytes;
    counts.downloaded++;
    return { ...file, path: 'assets/' + name, status: 'downloaded' };
  } catch (error) {
    await rm(temporary, { force: true });
    signal.throwIfAborted();
    if (['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EEXIST'].includes(error.code)) throw error;
    return skip(exceeded ? 'size-limit' : 'unavailable');
  }
}

export async function runExport(input, defaults, hooks = {}) {
  const { signal = new AbortController().signal, progress = () => {}, fetcher = fetch } = hooks;
  const options = exportOptions(input, defaults);
  const provider = await source(options.mode, signal, fetcher);
  const { DatabaseSync } = await import('node:sqlite');
  const startedAt = new Date().toISOString();
  const jobId = startedAt.replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
  const output = join(options.output, 'discord-' + jobId);
  const staging = join(options.output, '.discord-' + jobId + '.incomplete');
  const scratch = await mkdtemp(join(tmpdir(), 'discord-exporter-'));
  let db;
  let staged = false;
  const results = [];
  const warnings = new Set();
  const counts = { downloaded: 0, skipped: 0, bytes: 0 };
  try {
    db = new DatabaseSync(join(scratch, 'messages.sqlite'));
    db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, row TEXT NOT NULL)');
    const insert = db.prepare('INSERT OR IGNORE INTO messages VALUES (?, ?)');
    const ascending = db.prepare('SELECT row FROM messages ORDER BY length(id), id');
    await mkdir(options.output, { recursive: true });
    await mkdir(staging);
    staged = true;
    for (const id of options.channels) {
      signal.throwIfAborted();
      const channel = await provider.channel(id);
      db.exec('DELETE FROM messages');
      let cursor = options.mode === 'discord' && options.until && options.until > epoch &&
        options.until < Date.now() ? String(BigInt(options.until - epoch) << 22n) : undefined;
      let matched = 0, scanned = 0, blanks = 0, newest = null, oldest = null;
      let stoppedAtLimit = false;
      progress({ stage: 'fetch', channel, matched, scanned, completed: results.length, total: options.channels.length });
      // An upper bound before Discord existed represents an empty selection.
      while (options.until === null || options.mode !== 'discord' || options.until > epoch) {
        signal.throwIfAborted();
        const rows = await provider.page(id, { limit: 100, ...(cursor ? { before: cursor } : {}) });
        if (!rows.length) break;
        rows.sort((a, b) => BigInt(a.id) === BigInt(b.id) ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1);
        const nextCursor = rows.at(-1).id;
        if (cursor && BigInt(nextCursor) >= BigInt(cursor))
          throw new Problem('PAGINATION_ERROR', 'Discord returned a repeated message page.');
        let stop = false;
        db.exec('BEGIN');
        for (const row of rows) {
          const time = Date.parse(row.timestamp);
          if ((options.since !== null && time < options.since) ||
              (options.afterId && BigInt(row.id) <= BigInt(options.afterId))) { stop = true; break; }
          if (options.until !== null && time >= options.until) continue;
          scanned++;
          if ((row.type === 0 || row.type === 19) && !row.content && !row.attachments?.length && !row.embeds?.length && !row.sticker_items?.length && !row.poll)
            blanks++;
          if (options.contains && !(row.content ?? '').toLowerCase().includes(options.contains.toLowerCase())) continue;
          if (insert.run(row.id, JSON.stringify(normalizeMessage(row, channel))).changes) {
            newest ??= row.id;
            oldest = row.id;
            matched++;
          }
          if (options.limit && matched >= options.limit) { stoppedAtLimit = stop = true; break; }
        }
        db.exec('COMMIT');
        progress({ stage: 'fetch', channel, matched, scanned, completed: results.length, total: options.channels.length });
        if (stop || rows.length < 100) break;
        cursor = nextCursor;
      }
      if (!scanned && options.mode === 'discord' && options.since === null && options.until === null && !options.afterId) warnings.add('Discord returned no messages for at least one channel. Check Read Message History if you expected messages.');
      if (blanks && options.mode === 'discord') warnings.add('Discord returned some standard messages with empty content. Check Message Content intent if text or attachments are missing.');
      if (stoppedAtLimit) warnings.add('A per-channel limit was reached. Earlier matching messages may remain.');
      const writer = createTranscript(options.format, channel, options.mode);
      const file = 'channel-' + safeName(channel.name) + '-' + channel.id + '.' + writer.extension;
      async function* chunks() {
        yield writer.header;
        let i = 0;
        for (const { row } of ascending.iterate()) {
          signal.throwIfAborted();
          const item = JSON.parse(row);
          const files = [];
          for (const file of item.attachments) files.push(await attachment(file, staging, counts, options, signal, fetcher));
          item.attachments = files;
          yield writer.row(item, i++);
          if (i % 200 === 0) {
            progress({ stage: 'write', channel, matched, written: i, scanned, completed: results.length, total: options.channels.length });
            await tick();
          }
        }
        yield writer.footer;
      }
      progress({ stage: 'write', channel, matched, written: 0, scanned, completed: results.length, total: options.channels.length });
      await pipeline(Readable.from(chunks()), createWriteStream(join(staging, file), { flags: 'wx' }), { signal });
      results.push({ channel, file, messages: matched, scanned, oldestId: oldest, newestId: newest, stoppedAtLimit });
    }
    signal.throwIfAborted();
    if (counts.skipped) warnings.add('Some attachments could not be saved. Inspect per-attachment status in the transcripts.');
    const manifest = {
      schemaVersion: 1, jobId, source: options.mode, format: options.format, startedAt,
      finishedAt: new Date().toISOString(), output, messageCount: results.reduce((sum, row) => sum + row.messages, 0),
      selection: { since: input.since || null, until: input.until || null, contains: options.contains || null, afterId: options.afterId, limitPerChannel: options.limit || null },
      channels: results, attachments: counts, warnings: [...warnings],
    };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    signal.throwIfAborted();
    await rename(staging, output);
    staged = false;
    try { await record(manifest); }
    catch { manifest.warnings.push('Files were saved but the local history entry could not be written.'); }
    return manifest;
  } finally {
    db?.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (staged) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
