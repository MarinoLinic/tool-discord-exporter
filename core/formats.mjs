import { htmlTranscript } from './archive.mjs';

const safeUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; }
  catch { return ''; }
};
const attachmentLink = file => file.path ? file.path : safeUrl(file.url);
const authorName = message => message.author?.displayName ?? 'Unknown author';
const label = channel => '#' + channel.name;
const md = value => String(value ?? '').replace(/[\\\x60*_[\]{}<>#+!|&]/g, '\\$&');
const block = text => String(text).split(/\r?\n/).map(line => '> ' + md(line)).join('\n');

export function createTranscript(format, channel, source, options = {}) {
  if (format === 'jsonl') return { extension: 'jsonl', header: '', footer: '',
    row: message => JSON.stringify(message) + '\n' };
  if (format === 'json') return {
    extension: 'json',
    header: '{"schemaVersion":2,"source":' + JSON.stringify(source) + ',"channel":' + JSON.stringify(channel) +
      ',"authorsFile":' + JSON.stringify((options.prefix || '') + 'authors.json') + ',"messages":[\n',
    footer: '\n]}\n', row: (message, index) => (index ? ',\n' : '') + JSON.stringify(options.compactMessage(message, options.fields)),
  };
  if (format === 'markdown') return {
    extension: 'md', header: '# ' + md(label(channel)) + '\n\n' + (source === 'demo' ? 'Sample archive\n\n' : ''),
    footer: '',
    row: message => '### ' + md(authorName(message)) + ' · [' + message.timestamp + '](' + message.url + ')\n\n' +
      (message.replyTo ? 'Reply to message ' + message.replyTo + '\n\n' : '') +
      (message.content ? block(message.content) + '\n\n' : '') +
      message.attachments.map(file => {
        const href = attachmentLink(file).replace(/[()<>\s]/g, char => encodeURIComponent(char));
        return '- ' + (href ? '[' + md(file.name) + '](' + href + ')' : md(file.name)) + ' · ' + file.status + '\n';
      }).join('') + (message.attachments.length ? '\n' : ''),
  };
  return htmlTranscript(channel, source, options);
}
