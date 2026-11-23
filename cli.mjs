import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clearToken, credentialStatus, formats, history, home, Problem, saveSettings, saveToken, settings } from './core/state.mjs';
import { channelId, source } from './core/source.mjs';
import { prepareExport, preview, runExport, runJob } from './core/export.mjs';
import { jobStatus, launchJob, listJobs, pauseJob, saveJobFile } from './core/jobs.mjs';
import { jsonFields } from './core/archive.mjs';
import { importProfiles, maxImportBytes, profiles } from './core/profiles.mjs';

const help = [
  'Discord Exporter 0.2.0',
  '',
  'Usage: discord-export <command> [options] [--print-json]',
  '',
  '  doctor                     Show runtime, credential source and local settings',
  '  schema                     Describe commands, options and JSON contract',
  '  check                      Verify the Discord bot identity',
  '  guilds                     List Discord servers',
  '  channels --guild ID        List server channels and active threads',
  '  preview --channel ID       Read up to four recent messages',
  '  export --channel ID        Export one or more channels (repeat --channel)',
  '  export --guild ID          Export the whole server including accessible archived threads',
  '  jobs                       List durable export jobs',
  '  status --job ID            Read state and progress',
  '  pause --job ID             Request a checkpointed pause',
  '  resume --job ID            Continue a paused or failed job',
  '  history                    List up to 100 local export receipts',
  '  config                     Read saved export defaults',
  '  config --file PATH         Apply defaults from a JSON file',
  '  profiles                   List saved bot profiles',
  '  auth-import                Read one or more bot tokens from redirected stdin',
  '  auth-save                  Set the legacy bot token from redirected stdin',
  '  auth-clear                 Remove the saved Windows credential',
  '',
  'Source options: --profile ID selects the bot for check, guilds, channels, preview or export.',
  '                 --demo uses fictional data.',
  'Export options: --format html|jsonl|markdown|json, --output DIRECTORY,',
  '  --since YYYY-MM-DD, --until YYYY-MM-DD, --contains TEXT, --limit COUNT,',
  '  --after-id ID, --attachments, --no-attachments, --attachment-mib N, --budget-mib N.',
  '  Repeat --format to write multiple outputs. Set --fields LIST for optional archive details.',
  '  Use --name FOLDER to name the bundle or --background to detach an export or resume.',
  '  Use channels --archived to include accessible archived threads in discovery.',
  'Dates are inclusive UTC. A limit selects the newest matches per channel.',
  'A Discord channel or message URL is accepted where a channel ID is expected.',
].join('\n');

const specs = {
  doctor: [], schema: [], history: [], profiles: [], config: ['file'], 'auth-save': [], 'auth-clear': [], 'auth-import': [],
  jobs: [], status: ['job'], pause: ['job'], resume: ['job', 'background', 'quiet'], worker: ['job', 'quiet'],
  check: ['demo', 'profile'], guilds: ['demo', 'profile'], channels: ['demo', 'guild', 'archived', 'profile'], preview: ['demo', 'channel', 'profile'],
  export: ['demo', 'profile', 'channel', 'guild', 'format', 'output', 'since', 'until', 'contains', 'limit', 'name', 'fields', 'background',
    'after-id', 'attachments', 'no-attachments', 'attachment-mib', 'budget-mib', 'quiet'],
};
const typeOf = key => ['demo', 'attachments', 'no-attachments', 'quiet', 'help', 'print-json', 'background', 'archived'].includes(key) ? 'boolean' : 'string';
const specFor = key => ({ type: typeOf(key), ...(['channel', 'format'].includes(key) ? { multiple: true } : {}) });
const args = process.argv.slice(2);
const json = args.includes('--print-json');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const { signal } = controller;

function number(value, name) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Problem('INVALID_OPTIONS', name + ' requires a nonnegative integer.', 2);
  return Number(value);
}

function showProgress(event) {
  const ratio = event.total ? event.completed + '/' + event.total : '—';
  const name = event.channel ? ' #' + event.channel.name.replace(/[\x00-\x1F\x7F]/g, '') : '';
  process.stderr.write('[' + ratio + '] ' + event.stage + name + ' · ' + event.messages + ' messages\n');
}

async function dispatch(command, flags) {
  const mode = flags.demo ? 'demo' : 'discord';
  if (command === 'schema') return {
    version: 1, stdout: 'One JSON object with --print-json. Progress and human errors use stderr.',
    success: { ok: true, command: 'string', result: 'object or array' },
    failure: { ok: false, command: 'string or null', error: { code: 'string', message: 'string' } },
    exitCodes: { 0: 'success', 1: 'operation failed', 2: 'invalid usage or runtime', 130: 'canceled' },
    commands: Object.fromEntries(Object.entries(specs).map(([name, keys]) => [name, Object.fromEntries(keys.map(key => [key, specFor(key)]))])),
    formats, fields: jsonFields, settings: await settings(), example: ['export', '--demo', '--channel', '1200000000000000010', '--format', 'jsonl', '--print-json'],
  };
  if (command === 'doctor') return { node: process.versions.node, platform: process.platform, home, credential: await credentialStatus(), settings: await settings() };
  if (command === 'history') return await history();
  if (command === 'profiles') return await profiles();
  if (command === 'jobs') return await listJobs();
  if (['status', 'pause', 'resume', 'worker'].includes(command)) {
    if (!flags.job) throw new Problem('INVALID_JOB', 'Provide --job ID.', 2);
    if (command === 'status') return await jobStatus(flags.job);
    if (command === 'pause') return await pauseJob(flags.job);
    if (flags.background) return await launchJob(flags.job);
    if (command === 'resume') {
      await jobStatus(flags.job);
      await saveJobFile(flags.job, 'control', { pause: false });
    }
    return await runJob(flags.job, { signal, progress: flags.quiet ? undefined : showProgress });
  }
  if (command === 'config') return flags.file
    ? await saveSettings({ ...await settings(), ...JSON.parse((await readFile(resolve(flags.file), 'utf8')).replace(/^\uFEFF/, '')) })
    : await settings();
  if (command === 'auth-clear') { await clearToken(); return await credentialStatus(); }
  if (command === 'auth-save' || command === 'auth-import') {
    if (process.stdin.isTTY) throw new Problem('INVALID_OPTIONS', 'Supply bot tokens through redirected stdin or use Settings.', 2);
    let input = '';
    const limit = command === 'auth-save' ? 512 : maxImportBytes;
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > limit) throw new Problem('INVALID_TOKEN', 'Input exceeded the token size limit.', 2);
    }
    if (command === 'auth-import') return await importProfiles(input, async token => (await source('discord', signal, undefined, { token })).identity());
    await saveToken(input.trim());
    return await credentialStatus();
  }
  if (command === 'preview') {
    if (flags.channel?.length !== 1) throw new Problem('INVALID_CHANNEL', 'Preview requires exactly one --channel.', 2);
    return await preview(mode, channelId(flags.channel[0]), signal, { profileId: flags.profile });
  }
  if (command === 'export') {
    const config = await settings();
    if (flags.attachments && flags['no-attachments'])
      throw new Problem('INVALID_OPTIONS', 'Choose only one attachment mode.', 2);
    const options = {
      channels: flags.channel, guild: flags.guild, mode, name: flags.name, profileId: flags.profile,
      format: flags.format?.[0] ?? config.format, formats: flags.format,
      fields: flags.fields === undefined ? undefined : flags.fields.split(',').map(value => value.trim()).filter(Boolean),
      output: flags.output ? resolve(flags.output) : config.output,
      since: flags.since, until: flags.until, contains: flags.contains, afterId: flags['after-id'],
      limit: number(flags.limit, '--limit') ?? config.limit,
      attachments: flags.attachments ?? (flags['no-attachments'] ? false : config.attachments),
      attachmentMiB: number(flags['attachment-mib'], '--attachment-mib') ?? config.attachmentMiB,
      budgetMiB: number(flags['budget-mib'], '--budget-mib') ?? config.budgetMiB,
    };
    if (flags.background) return await launchJob((await prepareExport(options, config)).id);
    return await runExport(options, config, { signal, progress: flags.quiet ? undefined : showProgress });
  }
  const provider = await source(mode, signal, undefined, { profileId: flags.profile });
  if (command === 'check') return await provider.identity();
  if (command === 'guilds') return await provider.guilds();
  if (command === 'channels') {
    if (!flags.guild && !flags.demo) throw new Problem('INVALID_OPTIONS', 'Provide --guild ID.', 2);
    const guild = flags.guild ?? (await import('./fixtures/discord-demo.mjs')).demoGuild;
    return flags.archived ? await provider.catalog(guild, { archived: true }) : await provider.channels(guild);
  }
}

let command;
try {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Problem('RUNTIME', 'Install Node.js 24 or later.', 2);
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(
      [...new Set(['help', 'print-json', ...Object.values(specs).flat()])].map(key => [key, specFor(key)])) });
  } catch (error) { throw new Problem('INVALID_OPTIONS', error.message, 2); }
  const { positionals, values } = parsed;
  command = positionals[0];
  if (values.help || !args.length) {
    console.log(json ? JSON.stringify({ ok: true, command: 'help', result: { help } }) : help);
  } else {
    if (!Object.hasOwn(specs, command ?? '') || positionals.length !== 1)
      throw new Problem('INVALID_COMMAND', 'Use --help to see available commands.', 2);
    for (const key of Object.keys(values)) {
      if (key !== 'print-json' && !specs[command].includes(key))
        throw new Problem('INVALID_OPTIONS', '--' + key + ' is unavailable for ' + command + '.', 2);
    }
    const result = await dispatch(command, values);
    if (json) console.log(JSON.stringify({ ok: true, command, result }));
    else if (result.messageCount !== undefined) {
      console.log('Saved ' + result.messageCount + ' messages to ' + result.output);
      for (const warning of result.warnings) console.error(warning);
    } else console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  const canceled = signal.aborted || error.name === 'AbortError';
  const code = canceled && error.code !== 'PAUSED' ? 'CANCELED' : error instanceof Problem ? error.code : error.code ?? 'FAILED';
  const message = canceled && error.code !== 'PAUSED' ? 'Export paused.' : error.message;
  process.exitCode = canceled ? 130 : error.exit ?? 1;
  if (json) console.log(JSON.stringify({ ok: false, command: command ?? null, error: { code, message } }));
  else console.error(code + ': ' + message);
}
