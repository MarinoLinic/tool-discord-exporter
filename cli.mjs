import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clearToken, credentialStatus, formats, history, home, Problem, saveSettings, saveToken, settings } from './core/state.mjs';
import { channelId, demoGuild, source } from './core/source.mjs';
import { preview, runExport } from './core/export.mjs';

const help = [
  'Discord Exporter 0.1.0',
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
  '  history                    List up to 100 local export receipts',
  '  config                     Read saved export defaults',
  '  config --file PATH         Apply defaults from a JSON file',
  '  auth-save                  Read a bot token from redirected stdin',
  '  auth-clear                 Remove the saved Windows credential',
  '',
  'Source options: --demo for check, guilds, channels, preview or export.',
  'Export options: --format html|jsonl|markdown|json, --output DIRECTORY,',
  '  --since YYYY-MM-DD, --until YYYY-MM-DD, --contains TEXT, --limit COUNT,',
  '  --after-id ID, --attachments, --no-attachments, --attachment-mib N, --budget-mib N.',
  'Dates are inclusive UTC. A limit selects the newest matches per channel.',
  'A Discord channel or message URL is accepted where a channel ID is expected.',
].join('\n');

const specs = {
  doctor: [], schema: [], history: [], config: ['file'], 'auth-save': [], 'auth-clear': [],
  check: ['demo'], guilds: ['demo'], channels: ['demo', 'guild'], preview: ['demo', 'channel'],
  export: ['demo', 'channel', 'format', 'output', 'since', 'until', 'contains', 'limit',
    'after-id', 'attachments', 'no-attachments', 'attachment-mib', 'budget-mib', 'quiet'],
};
const typeOf = key => ['demo', 'attachments', 'no-attachments', 'quiet', 'help', 'print-json'].includes(key) ? 'boolean' : 'string';
const specFor = key => ({ type: typeOf(key), ...(key === 'channel' ? { multiple: true } : {}) });
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

async function dispatch(command, flags) {
  const mode = flags.demo ? 'demo' : 'discord';
  if (command === 'schema') return {
    version: 1, stdout: 'One JSON object with --print-json. Progress and human errors use stderr.',
    success: { ok: true, command: 'string', result: 'object or array' },
    failure: { ok: false, command: 'string or null', error: { code: 'string', message: 'string' } },
    exitCodes: { 0: 'success', 1: 'operation failed', 2: 'invalid usage or runtime', 130: 'canceled' },
    commands: Object.fromEntries(Object.entries(specs).map(([name, keys]) => [name, Object.fromEntries(keys.map(key => [key, specFor(key)]))])),
    formats, settings: await settings(), example: ['export', '--demo', '--channel', '1200000000000000010', '--format', 'jsonl', '--print-json'],
  };
  if (command === 'doctor') return { node: process.versions.node, platform: process.platform, home, credential: await credentialStatus(), settings: await settings() };
  if (command === 'history') return await history();
  if (command === 'config') return flags.file
    ? await saveSettings({ ...await settings(), ...JSON.parse((await readFile(resolve(flags.file), 'utf8')).replace(/^\uFEFF/, '')) })
    : await settings();
  if (command === 'auth-clear') { await clearToken(); return await credentialStatus(); }
  if (command === 'auth-save') {
    if (process.stdin.isTTY) throw new Problem('INVALID_OPTIONS', 'Supply the token through redirected stdin or use Settings.', 2);
    let token = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      token += chunk;
      if (token.length > 512) throw new Problem('INVALID_TOKEN', 'Input exceeded the token size limit.', 2);
    }
    await saveToken(token.trim());
    return await credentialStatus();
  }
  if (command === 'preview') {
    if (flags.channel?.length !== 1) throw new Problem('INVALID_CHANNEL', 'Preview requires exactly one --channel.', 2);
    return await preview(mode, channelId(flags.channel[0]), signal);
  }
  if (command === 'export') {
    const config = await settings();
    if (flags.attachments && flags['no-attachments'])
      throw new Problem('INVALID_OPTIONS', 'Choose only one attachment mode.', 2);
    return await runExport({
      channels: flags.channel, mode,
      format: flags.format ?? config.format,
      output: flags.output ? resolve(flags.output) : config.output,
      since: flags.since, until: flags.until, contains: flags.contains, afterId: flags['after-id'],
      limit: number(flags.limit, '--limit') ?? config.limit,
      attachments: flags.attachments ?? (flags['no-attachments'] ? false : config.attachments),
      attachmentMiB: number(flags['attachment-mib'], '--attachment-mib') ?? config.attachmentMiB,
      budgetMiB: number(flags['budget-mib'], '--budget-mib') ?? config.budgetMiB,
    }, config, { signal, progress: event => {
      if (!flags.quiet) process.stderr.write('[' + (event.completed + 1) + '/' + event.total + '] ' +
        event.stage + ' #' + event.channel.name.replace(/[\x00-\x1F\x7F]/g, '') + ' · ' + event.matched + ' matches\n');
    } });
  }
  const provider = await source(mode, signal);
  if (command === 'check') return await provider.identity();
  if (command === 'guilds') return await provider.guilds();
  if (command === 'channels') {
    if (!flags.guild && !flags.demo) throw new Problem('INVALID_OPTIONS', 'Provide --guild ID.', 2);
    return await provider.channels(flags.guild ?? demoGuild);
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
    else if (command === 'export') {
      console.log('Saved ' + result.messageCount + ' messages to ' + result.output);
      for (const warning of result.warnings) console.error(warning);
    } else console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  const canceled = signal.aborted || error.name === 'AbortError';
  const code = canceled ? 'CANCELED' : error instanceof Problem ? error.code : error.code ?? 'FAILED';
  const message = canceled ? 'Export canceled.' : error.message;
  process.exitCode = canceled ? 130 : error.exit ?? 1;
  if (json) console.log(JSON.stringify({ ok: false, command: command ?? null, error: { code, message } }));
  else console.error(code + ': ' + message);
}
