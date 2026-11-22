const escape = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const safeUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; }
  catch { return ''; }
};
const attachmentLink = file => file.path ? file.path : safeUrl(file.url);
const authorName = message => message.author?.displayName ?? 'Unknown author';
const label = channel => '#' + channel.name;
const md = value => String(value ?? '').replace(/[\\\x60*_[\]{}<>#+!|&]/g, '\\$&');
const block = text => String(text).split(/\r?\n/).map(line => '> ' + md(line)).join('\n');

export function createTranscript(format, channel, source) {
  if (format === 'jsonl') return { extension: 'jsonl', header: '', footer: '',
    row: message => JSON.stringify(message) + '\n' };
  if (format === 'json') return {
    extension: 'json',
    header: '{"schemaVersion":1,"source":' + JSON.stringify(source) + ',"channel":' + JSON.stringify(channel) + ',"messages":[\n',
    footer: '\n]}\n', row: (message, index) => (index ? ',\n' : '') + JSON.stringify(message),
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
  return {
    extension: 'html',
    header: '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>' +
      escape(label(channel)) + ' · Discord Exporter</title><style>body{margin:0;background:#102129;color:#f2f3ef;font:16px/1.55 system-ui}main{max-width:800px;margin:auto;padding:54px 24px}header{border-bottom:1px solid #35515b;padding-bottom:24px}h1{font-size:clamp(30px,6vw,56px);margin:0;color:#edcf91;line-height:1.1;overflow-wrap:anywhere}small, time{color:#aebfc1}article{border-bottom:1px solid #35515b;padding:21px 0;overflow-wrap:anywhere}p{white-space:pre-wrap;margin:8px 0}a{color:#f1d29b}article>a{margin-left:12px;font-size:13px}ul{padding-left:20px}</style><main><header><small>' +
      (source === 'demo' ? 'SAMPLE ARCHIVE' : 'DISCORD ARCHIVE') + '</small><h1>' + escape(label(channel)) +
      '</h1><small>Channel ' + escape(channel.id) + ' · UTC</small></header>',
    footer: '</main></html>\n',
    row: message => '<article id="m-' + escape(message.id) + '"><strong>' + escape(authorName(message)) +
      '</strong><a rel="noreferrer" href="' + escape(message.url) + '"><time>' + escape(message.timestamp) + '</time></a>' +
      (message.replyTo ? '<p><a href="#m-' + escape(message.replyTo) + '">Reply to ' + escape(message.replyTo) + '</a></p>' : '') +
      '<p>' + escape(message.content) + '</p>' + (message.attachments.length ? '<ul>' + message.attachments.map(file => {
        const href = attachmentLink(file);
        return '<li>' + (href ? '<a rel="noreferrer" ' + (file.path ? 'download ' : '') + 'href="' + escape(href) + '">' + escape(file.name) + '</a>' : escape(file.name)) + ' · ' + escape(file.status) + '</li>';
      }).join('') + '</ul>' : '') + '</article>\n',
  };
}
