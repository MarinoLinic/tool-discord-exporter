import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, toNamespacedPath } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as tick } from 'node:timers/promises';
import { formats, Problem, record, settingsValues } from './state.mjs';
import { jobDirectory, jobId, jobStatus, loadJobFile, lockJob, saveJobFile } from './jobs.mjs';
import { archiveName, channelStem } from './naming.mjs';
import { archiveIndex, archiveCss, compactMessage, jsonFields } from './archive.mjs';
import { channelId, isId, normalizeMessage, source } from './source.mjs';
import { createTranscript } from './formats.mjs';
import { profileId, profiles } from './profiles.mjs';

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
  if ((!selected.length && !input.guild) || selected.length > 5000 || (selected.length && input.guild))
    throw new Problem('INVALID_CHANNEL', 'Select up to 5,000 channels or choose an entire server.', 2);
  if (input.guild && !isId(input.guild)) throw new Problem('INVALID_CHANNEL', 'Enter a valid server ID.', 2);
  const selectedFormats = Array.isArray(input.formats) ? [...new Set(input.formats)] : [config.format];
  if (!selectedFormats.length || selectedFormats.some(value => !formats.includes(value)))
    throw new Problem('INVALID_OPTIONS', 'Choose at least one supported format.', 2);
  const fields = input.fields ?? jsonFields.defaults;
  if (!Array.isArray(fields) || fields.some(value => !jsonFields.all.includes(value)))
    throw new Problem('INVALID_OPTIONS', 'Choose supported JSON detail fields.', 2);
  const since = dateValue(input.since, 'Start date');
  const until = dateValue(input.until, 'End date');
  if (since !== null && until !== null && since > until)
    throw new Problem('INVALID_DATE', 'Start date must be on or before the end date.', 2);
  if (input.afterId && (!isId(input.afterId) || selected.length !== 1 || input.guild))
    throw new Problem('INVALID_CHANNEL', 'An after-message ID requires exactly one channel.', 2);
  const contains = input.contains ?? '';
  if (typeof contains !== 'string' || contains.length > 300)
    throw new Problem('INVALID_OPTIONS', 'Search text must be 300 characters or fewer.', 2);
  return { ...config, channels: selected, since, until: until === null ? null : until + 86_400_000,
    contains: contains.trim(), afterId: input.afterId || null, mode: input.mode ?? 'discord', formats: selectedFormats,
    fields: [...new Set(fields)], guild: input.guild ?? null, catalog: Array.isArray(input.catalog) ? input.catalog : [], name: input.name,
    profileId: profileId(input.profileId) };
}

export async function preview(mode, id, signal, auth = {}) {
  return await recentMessages(await source(mode, signal, undefined, auth), id);
}

export async function recentMessages(provider, id) {
  const channel = await provider.channel(channelId(id));
  const rows = await provider.page(channel.id, { limit: 4 });
  return rows.map(row => normalizeMessage(row, channel)).reverse();
}

function safeName(value) {
  return String(value).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'file';
}

function attachmentName(file) {
  const original = safeName(file.name);
  const extension = extname(original);
  const hasExtension = /^\.[a-z\d]{1,10}$/i.test(extension);
  const suffix = hasExtension ? extension : '';
  const base = hasExtension ? original.slice(0, -extension.length) : original;
  const stem = base.slice(0, 64 - suffix.length).replace(/[.-]+$/g, '') || 'file';
  return safeName(file.id).slice(0, 40) + '-' + stem + suffix;
}

async function attachment(file, folder, counts, options, signal, fetcher) {
  const max = Math.min(options.attachmentMiB * 1048576, options.budgetMiB * 1048576 - counts.bytes);
  const skip = status => { counts.skipped++; return { ...file, status }; };
  if (!options.attachments) return { ...file, status: 'reference' };
  const fixture = options.mode === 'demo' ? (await import('../fixtures/discord-demo.mjs')).attachmentFixture(file.id) : null;
  if (options.mode === 'demo' && !fixture) return skip('sample');
  if (max <= 0 || (Number.isFinite(file.size) && file.size > max)) return skip('size-limit');
  let url;
  try { url = new URL(file.url); } catch { return skip('unsupported-url'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
      !url.pathname.startsWith('/attachments/')) return skip('unsupported-url');
  const name = attachmentName(file);
  const dir = join(folder, 'assets');
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, '.attachment-' + safeName(file.id) + '.part');
  let bytes = 0;
  let exceeded = false;
  try {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    const response = fixture
      ? new Response(await readFile(fixture))
      : await fetcher(url, { redirect: 'error', signal: requestSignal });
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
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary), { signal: requestSignal });
    await rename(temporary, join(dir, name));
    counts.bytes += bytes;
    counts.downloaded++;
    return { ...file, size: bytes, path: 'assets/' + name, status: 'downloaded' };
  } catch (error) {
    await rm(temporary, { force: true });
    signal.throwIfAborted();
    if (['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EEXIST'].includes(error.code)) throw error;
    return skip(exceeded ? 'size-limit' : 'unavailable');
  }
}


const folderNames = { html: 'HTML', json: 'JSON', jsonl: 'JSONL', markdown: 'Markdown' };

export async function prepareExport(input, defaults) {
  const options = exportOptions(input, defaults);
  const available = options.mode === 'discord' ? await profiles() : [];
  const profile = options.profileId ? available.find(row => row.id === options.profileId) : available[0];
  if (options.mode === 'discord' && !profile)
    throw new Problem('PROFILE_NOT_FOUND', 'Choose a configured Discord bot profile before starting an export.');
  options.profileId = profile?.id ?? options.profileId;
  const id = jobId();
  const name = archiveName(options.name, id);
  const output = join(options.output, name);
  const exists = await stat(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (exists) throw new Problem('OUTPUT_EXISTS', 'An archive already exists at this location. Choose a different folder name.');
  const status = { id, name, state: 'queued', stage: 'prepare', completed: 0, total: options.channels.length, messages: 0, updatedAt: new Date().toISOString(), output };
  if (profile) status.botProfile = { id: profile.id, name: profile.name };
  await saveJobFile(id, 'job', { options, id, output, name, startedAt: status.updatedAt, botProfile: status.botProfile,
    selection: { since: input.since || null, until: input.until || null, contains: options.contains || null, afterId: options.afterId, limitPerChannel: options.limit || null } });
  await saveJobFile(id, 'control', { pause: false });
  await saveJobFile(id, 'status', status);
  return status;
}

function quoteSql(item) { return JSON.stringify(item); }

export async function runExport(input, defaults, hooks = {}) {
  const job = await prepareExport(input, defaults);
  return await runJob(job.id, hooks);
}

export async function runJob(id, hooks = {}) {
  const { signal: requested = new AbortController().signal, progress = () => {}, fetcher = fetch } = hooks;
  const config = await loadJobFile(id, 'job');
  const { options, output, startedAt, name, selection } = config;
  const oldStatus = await jobStatus(id);
  if (oldStatus.state === 'completed') return oldStatus.manifest;
  const release = lockJob(id);
  const pause = new AbortController();
  const signal = AbortSignal.any([requested, pause.signal]);
  const watch = setInterval(async () => {
    try { if ((await loadJobFile(id, 'control')).pause) pause.abort(); }
    catch { /* A transient read failure must not stop a job. */ }
  }, 600);
  watch.unref();
  const staging = join(options.output, '.discord-' + id + '.incomplete');
  const storePath = join(jobDirectory(id), 'checkpoint.sqlite');
  let db;
  let status = { ...oldStatus, state: 'running', stage: 'prepare' };
  let lastUpdate = 0;
  async function report(patch, force = false) {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    progress(status);
    if (force || Date.now() - lastUpdate >= 325) {
      await saveJobFile(id, 'status', status);
      lastUpdate = Date.now();
    }
  }
  try {
    await report({ detail: '', error: null }, true);
    const legacyProfile = process.env.DISCORD_BOT_TOKEN?.trim() ? 'environment' : 'default';
    const provider = await source(options.mode, signal, fetcher, { profileId: options.profileId ?? legacyProfile });
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(storePath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.exec(
      'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, info TEXT NOT NULL, checkpoint TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS messages (channel TEXT, id TEXT, row TEXT NOT NULL, PRIMARY KEY(channel,id));' +
      'CREATE TABLE IF NOT EXISTS authors (id TEXT PRIMARY KEY, info TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, data TEXT NOT NULL);'
    );
    const metaGet = db.prepare('SELECT value FROM metadata WHERE key=?');
    const metaSet = db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)');
    if (options.mode === 'discord' && ['default', 'environment'].includes(options.profileId)) {
      const { id: currentBot } = await provider.identity();
      const expectedBot = metaGet.get('botId')?.value;
      if (expectedBot && expectedBot !== currentBot)
        throw new Problem('PROFILE_CHANGED', 'This job was started by a different bot. Restore that bot token before resuming.');
      if (!expectedBot) metaSet.run('botId', currentBot);
    }
    const getCheckpoint = db.prepare('SELECT checkpoint FROM channels WHERE id=?');
    const saveCheckpoint = db.prepare('UPDATE channels SET checkpoint=? WHERE id=?');
    const saveChannel = db.prepare('INSERT OR IGNORE INTO channels VALUES (?,?,?)');
    const insert = db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?)');
    const readRows = db.prepare('SELECT row FROM messages WHERE channel=? ORDER BY length(id), id');
    const saveAuthor = db.prepare('INSERT OR IGNORE INTO authors VALUES (?,?)');
    const lookupAsset = db.prepare('SELECT data FROM assets WHERE id=?');
    const saveAsset = db.prepare('INSERT OR REPLACE INTO assets VALUES (?,?)');
    let catalog = metaGet.get('catalog')?.value;
    if (catalog) catalog = JSON.parse(catalog);
    else {
      if (options.guild) {
        await report({ stage: 'discover' }, true);
        const discovery = metaGet.get('discovery')?.value;
        catalog = await provider.catalog(options.guild, { archived: true, restore: discovery ? JSON.parse(discovery) : null,
          progress: (event, checkpoint) => {
            metaSet.run('discovery', quoteSql(checkpoint));
            return report({ stage: 'discover', scan: event, completed: event.completed, total: event.total });
          } });
      } else {
        const known = new Map(options.catalog.filter(row => row && typeof row === 'object').map(row => [row.id, row]));
        const channels = [];
        for (const channel of options.channels) {
          signal.throwIfAborted();
          channels.push(known.get(channel) ?? await provider.channel(channel));
        }
        catalog = { guild: null, channels, warnings: [], inaccessible: [] };
      }
      if (!catalog.channels.length) throw new Problem('NO_CHANNELS', 'No readable channels were found.');
      metaSet.run('catalog', quoteSql(catalog));
    }
    const start = Date.parse(startedAt);
    const initialCursor = options.mode === 'discord' && (options.until ?? start) > epoch
      ? String(BigInt(Math.min(options.until ?? start, start) - epoch) << 22n) : null;
    const initialCheckpoint = { cursor: initialCursor, fetchDone: false, matched: 0, scanned: 0, blank: 0, newest: null, oldest: null, stoppedAtLimit: false };
    for (const channel of catalog.channels) saveChannel.run(channel.id, quoteSql(channel), quoteSql(initialCheckpoint));
    await mkdir(staging, { recursive: true });
    const multi = options.formats.length > 1;
    if (multi) for (const format of options.formats) await mkdir(join(staging, folderNames[format]), { recursive: true });
    const warnings = new Set(catalog.warnings);
    // Normalize checkpointed filenames from older workers. Use the exact Windows path for names ending in a dot.
    const fixes = [];
    for (const { data } of db.prepare('SELECT data FROM assets').iterate()) {
      const file = JSON.parse(data);
      const nextPath = 'assets/' + attachmentName(file);
      if (file.status === 'downloaded' && file.path !== nextPath) fixes.push({ file, nextPath });
    }
    if (fixes.length) {
      db.exec('BEGIN');
      const affected = new Set();
      const getReferences = db.prepare("SELECT DISTINCT m.channel FROM messages m, json_each(m.row,'$.attachments') f WHERE json_extract(f.value,'$.id')=?");
      for (const { file, nextPath } of fixes) {
        signal.throwIfAborted();
        const oldFile = toNamespacedPath(join(staging, file.path));
        const newFile = toNamespacedPath(join(staging, nextPath));
        try { await rename(oldFile, newFile); }
        catch (error) {
          if (error.code !== 'ENOENT' || !await stat(newFile).then(value => value.isFile() && value.size === file.size, () => false)) throw error;
        }
        saveAsset.run(file.id, quoteSql({ ...file, path: nextPath }));
        for (const row of getReferences.iterate(file.id)) affected.add(row.channel);
      }
      for (const channel of affected) {
        const cp = JSON.parse(getCheckpoint.get(channel).checkpoint);
        delete cp.result;
        saveCheckpoint.run(quoteSql(cp), channel);
      }
      db.exec('COMMIT');
    }
    const counts = { downloaded: 0, skipped: 0, bytes: 0 };
    for (const { data } of db.prepare('SELECT data FROM assets').iterate()) {
      const file = JSON.parse(data);
      if (file.status === 'downloaded') { counts.downloaded++; counts.bytes += file.size; }
      else if (file.status !== 'reference') counts.skipped++;
    }
    const results = [];
    const inaccessible = [...catalog.inaccessible];
    let messages = 0;
    await report({ stage: 'fetch', completed: 0, total: catalog.channels.length, messages: 0 }, true);
    for (const channel of catalog.channels) {
      signal.throwIfAborted();
      const channelID = channel.id;
      const cp = JSON.parse(getCheckpoint.get(channelID).checkpoint);
      if (cp.result) {
        results.push(cp.result);
        messages += cp.result.messages;
        continue;
      }
      if (cp.skipped) { inaccessible.push(cp.skipped); continue; }
      const reportChannel = (patch, force = false) => report({
        channel, completed: results.length + inaccessible.length - catalog.inaccessible.length,
        total: catalog.channels.length, messages: messages + cp.matched, matched: cp.matched, scanned: cp.scanned,
        attachments: { ...counts }, ...patch,
      }, force);
      await reportChannel({ stage: cp.fetchDone ? 'write' : 'fetch', written: 0 }, true);
      try {
        while (!cp.fetchDone) {
          signal.throwIfAborted();
          const rows = options.until !== null && options.mode === 'discord' && options.until <= epoch
            ? [] : await provider.page(channelID, { limit: 100, ...(cp.cursor ? { before: cp.cursor } : {}) });
          rows.sort((a, b) => BigInt(a.id) === BigInt(b.id) ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1);
          const next = rows.at(-1)?.id;
          if (next && cp.cursor && BigInt(next) >= BigInt(cp.cursor))
            throw new Problem('PAGINATION_ERROR', 'Discord returned a repeated message page.');
          db.exec('BEGIN');
          for (const row of rows) {
            const time = Date.parse(row.timestamp);
            if ((options.since !== null && time < options.since) ||
                (options.afterId && BigInt(row.id) <= BigInt(options.afterId))) { cp.fetchDone = true; break; }
            if (options.until !== null && time >= options.until) continue;
            cp.scanned++;
            if ((row.type === 0 || row.type === 19) && !row.content && !row.attachments?.length && !row.embeds?.length && !row.sticker_items?.length && !row.poll) cp.blank++;
            if (options.contains && !(row.content ?? '').toLowerCase().includes(options.contains.toLowerCase())) continue;
            const normalized = normalizeMessage(row, channel);
            if (insert.run(channelID, row.id, quoteSql(normalized)).changes) {
              cp.newest ??= row.id;
              cp.oldest = row.id;
              cp.matched++;
              if (normalized.author) saveAuthor.run(normalized.author.id, quoteSql(normalized.author));
            }
            if (options.limit && cp.matched >= options.limit) { cp.stoppedAtLimit = cp.fetchDone = true; break; }
          }
          cp.fetchDone ||= rows.length < 100;
          cp.cursor = next ?? cp.cursor;
          saveCheckpoint.run(quoteSql(cp), channelID);
          db.exec('COMMIT');
          await reportChannel({ stage: 'fetch' });
        }
      } catch (error) {
        if (!options.guild || !['ACCESS_DENIED', 'NOT_FOUND'].includes(error.code)) throw error;
        cp.skipped = { id: channelID, name: channel.name, reason: error.code };
        saveCheckpoint.run(quoteSql(cp), channelID);
        inaccessible.push(cp.skipped);
        continue;
      }

      // Resolve attachment copies once before writing any format.
      if (options.attachments && !cp.mediaDone) {
        let written = 0;
        const pending = new Map();
        async function download(file, messageID) {
          let stored = await attachment(file, staging, counts, options, signal, fetcher);
          if (/^http-(?:401|403|404)$/.test(stored.status) && provider.message) {
            const fresh = await provider.message(channelID, messageID).catch(error => {
              if (['NOT_FOUND', 'ACCESS_DENIED'].includes(error.code)) return null;
              throw error;
            });
            const replacement = fresh?.attachments?.find(entry => entry.id === file.id);
            if (replacement?.url && replacement.url !== file.url) {
              counts.skipped--;
              stored = await attachment({ ...file, url: replacement.url }, staging, counts, options, signal, fetcher);
            }
          }
          saveAsset.run(file.id, quoteSql(stored));
        }
        async function flush() {
          const errors = await Promise.allSettled([...pending.values()].map(({ file, messageID }) => download(file, messageID)));
          pending.clear();
          const failed = errors.find(result => result.status === 'rejected');
          if (failed) throw failed.reason;
          await reportChannel({ stage: 'media', written });
        }
        // Keep four CDN transfers in flight only while the remaining budget can safely fit four full-size files.
        const slots = () => counts.bytes + 4 * options.attachmentMiB * 1048576 <= options.budgetMiB * 1048576 ? 4 : 1;
        for (const { row } of readRows.iterate(channelID)) {
          signal.throwIfAborted();
          const item = JSON.parse(row);
          for (const file of item.attachments) {
            if (lookupAsset.get(file.id) || pending.has(file.id)) continue;
            pending.set(file.id, { file, messageID: item.id });
            if (pending.size >= slots()) await flush();
          }
          if (++written % 200 === 0) await tick();
        }
        if (pending.size) await flush();
        cp.mediaDone = true;
        saveCheckpoint.run(quoteSql(cp), channelID);
      }
      const files = {};
      for (const format of options.formats) {
        await reportChannel({ stage: 'write', format, written: 0 }, true);
        const writer = createTranscript(format, channel, options.mode, { fields: options.fields, prefix: multi ? '../' : '', compactMessage });
        const filename = channelStem(channel) + '.' + writer.extension;
        const file = multi ? folderNames[format] + '/' + filename : filename;
        const temporary = join(staging, '.transcript-' + channelID + '-' + format + '.part');
        async function* chunks() {
          yield writer.header;
          let i = 0;
          for (const { row } of readRows.iterate(channelID)) {
            signal.throwIfAborted();
            const item = JSON.parse(row);
            item.attachments = item.attachments.map(ref => {
              const row = lookupAsset.get(ref.id);
              return row ? JSON.parse(row.data) : { ...ref, status: 'reference' };
            });
            yield writer.row(item, i++);
            if (i % 200 === 0) {
              await reportChannel({ stage: 'write', format, written: i });
              await tick();
            }
          }
          yield writer.footer;
        }
        await pipeline(Readable.from(chunks()), createWriteStream(temporary), { signal });
        await rename(temporary, join(staging, file));
        files[format] = file;
      }
      const result = { channel, file: files[options.formats[0]], files, messages: cp.matched, scanned: cp.scanned, oldestId: cp.oldest,
        newestId: cp.newest, stoppedAtLimit: cp.stoppedAtLimit, blank: cp.blank };
      cp.result = result;
      saveCheckpoint.run(quoteSql(cp), channelID);
      results.push(result);
      messages += result.messages;
      await reportChannel({ stage: 'write', messages }, true);
    }
    if (counts.skipped) warnings.add('Some attachments were unavailable or above configured limits. See attachment status.');
    if (results.some(value => value.blank) && options.mode === 'discord') warnings.add('Some standard messages returned empty content. Confirm the bot has Message Content intent if substantial text is missing.');
    if (results.some(value => !value.scanned) && options.mode === 'discord' && !selection.since && !selection.until && !selection.afterId)
      warnings.add('Discord returned no messages for some readable channels.');
    if (results.some(value => value.stoppedAtLimit)) warnings.add('A per-channel limit was reached; earlier matching messages may remain.');
    if (inaccessible.length) warnings.add('Some channels were excluded because the bot could not read them. See inaccessibleChannels.');
    if (!results.length) throw new Problem('NO_CHANNELS', 'No readable channels were exported.');
    await report({ stage: 'publish', completed: catalog.channels.length, total: catalog.channels.length, messages }, true);
    signal.throwIfAborted();
    if (options.formats.includes('json')) {
      const authors = db.prepare('SELECT info FROM authors ORDER BY id').iterate();
      async function* authorChunks() {
        yield '{"schemaVersion":1,"authors":{';
        let sep = '';
        for (const { info } of authors) {
          const { id, ...details } = JSON.parse(info);
          yield sep + quoteSql(id) + ':' + quoteSql(details);
          sep = ',\n';
        }
        yield '}}\n';
      }
      await pipeline(Readable.from(authorChunks()), createWriteStream(join(staging, 'authors.json')), { signal });
    }
    if (options.formats.includes('html')) {
      await writeFile(join(staging, 'archive.css'), archiveCss);
      await writeFile(join(staging, 'index.html'), archiveIndex(name, results, catalog.guild));
    }
    const manifest = {
      schemaVersion: 2, jobId: id, name, source: options.mode, format: options.formats[0], formats: options.formats,
      startedAt, finishedAt: new Date().toISOString(), output, messageCount: messages, selection, guild: catalog.guild,
      jsonFields: options.fields, channels: results, attachments: counts, warnings: [...warnings], inaccessibleChannels: inaccessible,
      ...(config.botProfile ? { botProfile: config.botProfile } : {}),
    };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    signal.throwIfAborted();
    if (await stat(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      throw new Problem('OUTPUT_EXISTS', 'An archive already exists at this location. It was left untouched.');
    }
    await rename(staging, output);
    await record(manifest).catch(() => {});
    await report({ stage: 'done', state: 'completed', manifest, detail: 'Archive ready.' }, true);
    // Only remove the owned scratch database after the published receipt is durable.
    db.close();
    db = undefined;
    for (const suffix of ['', '-wal', '-shm']) await rm(storePath + suffix, { force: true }).catch(() => {});
    return manifest;
  } catch (error) {
    const stopping = signal.aborted || error.name === 'AbortError';
    await report({ state: stopping ? 'paused' : 'failed', error: stopping ? null : { code: error.code ?? 'FAILED', message: error.message },
      detail: stopping ? 'Paused. Saved progress is ready to resume.' : error.message }, true).catch(() => {});
    if (stopping) throw new Problem('PAUSED', 'Export paused. Resume with job ' + id + '.', 130);
    throw error;
  } finally {
    clearInterval(watch);
    db?.close();
    release();
  }
}
