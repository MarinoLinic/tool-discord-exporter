export const jsonFields = {
  defaults: ['attachments', 'replies', 'edits', 'embeds'],
  all: ['attachments', 'replies', 'edits', 'embeds', 'reactions', 'mentions', 'stickers', 'polls', 'metadata'],
};

const esc = text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const safeUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};
const assetUrl = path => path.split('/').map(encodeURIComponent).join('/');
const anchor = (url, label) => '<a href="' + esc(url) + '" rel="noreferrer">' + esc(label) + '</a>';
const optional = (target, field, value) => { if (value && (!Array.isArray(value) || value.length)) target[field] = value; };

export function compactMessage(row, selected) {
  const fields = new Set(selected);
  const message = { id: row.id, timestamp: row.timestamp };
  if (row.author) message.authorId = row.author.id;
  if (row.content) message.content = row.content;
  if (fields.has('replies')) optional(message, 'replyTo', row.replyTo);
  if (fields.has('edits')) optional(message, 'editedTimestamp', row.editedTimestamp);
  if (fields.has('attachments')) optional(message, 'attachments', row.attachments.map(file => {
    const { id, name, size, path, url, status, contentType, description } = file;
    const entry = { id, name, size, status, ...(path ? { path } : { url }) };
    optional(entry, 'contentType', contentType);
    optional(entry, 'description', description);
    return entry;
  }));
  if (fields.has('embeds')) optional(message, 'embeds', row.embeds);
  if (fields.has('reactions')) optional(message, 'reactions', row.reactions.map(entry => ({
    emoji: entry.emoji?.name || '', ...(entry.emoji?.id ? { id: entry.emoji.id } : {}), count: entry.count,
  })));
  if (fields.has('mentions')) optional(message, 'mentions', row.mentions.map(user => user.id));
  if (fields.has('stickers')) optional(message, 'stickers', row.stickers.map(({ id, name }) => ({ id, name })));
  if (fields.has('polls')) optional(message, 'poll', row.poll);
  if (fields.has('metadata')) {
    optional(message, 'type', row.type);
    optional(message, 'flags', row.flags);
    optional(message, 'pinned', row.pinned);
  }
  return message;
}

export const archiveCss = [
  ':root{color-scheme:dark;--base:#22262c;--rail:#1a1e23;--raised:#2b3038;--line:#3d444e;--ink:#e1e4eb;--muted:#aeb8c8;--aqua:#9bd8d1;--accent:#f0ce91;font:15px/1.5 "Segoe UI",system-ui,sans-serif}',
  '*{box-sizing:border-box}body{margin:0;background:var(--base);color:var(--ink)}a{color:var(--aqua);overflow-wrap:anywhere}a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}',
  '.frame{display:grid;grid-template-columns:225px minmax(0,1fr);min-height:100vh}.rail{position:sticky;top:0;align-self:start;height:100vh;background:var(--rail);border-right:1px solid var(--line);padding:25px 17px}',
  '.identity{display:flex;gap:10px;align-items:center;color:var(--ink);text-decoration:none;font-weight:700}.mark{display:grid;place-items:center;width:33px;height:33px;border-radius:10px;color:#282619;background:var(--accent);font:bold 20px Consolas,monospace;flex:none}',
  '.rail small{display:block;margin:27px 0 8px 3px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.1em}.current{display:block;padding:8px 10px;border-radius:7px;background:#343b47;overflow-wrap:anywhere}.current b,.hash{color:var(--accent)}',
  '.top{position:sticky;top:0;z-index:1;padding:14px 25px;display:flex;align-items:center;justify-content:space-between;gap:14px;background:#292e36;border-bottom:1px solid var(--line)}',
  'h1,h2,p{margin:0}h1{font-size:19px;font-weight:700;overflow-wrap:anywhere}h1 .hash{margin-right:8px}small,.muted{color:var(--muted)}main{min-width:0}',
  '.stream{max-width:980px;margin:0 auto;padding:23px 26px 60px}.day{display:flex;align-items:center;gap:12px;margin:18px 0 17px;color:var(--muted);font-size:12px;font-weight:700}.day:before,.day:after{content:"";height:1px;background:var(--line);flex:1}',
  '.message{display:grid;grid-template-columns:42px minmax(0,1fr);gap:13px;padding:9px 9px;border-radius:8px;scroll-margin-top:71px}.message:hover,.message:target{background:var(--raised)}.message.continued{padding-top:2px}.message time{font-size:11px;color:var(--muted);white-space:nowrap}.time{text-decoration:none;margin-left:8px}',
  '.avatar{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;color:#192b2b;background:#8ecac1;font:650 14px "Segoe UI",sans-serif}.avatar.t1{background:#e5bd84;color:#382919}.avatar.t2{background:#aeb8e5;color:#242a46}.avatar.t3{background:#d8b2bf;color:#352630}',
  '.body{min-width:0}.body .text{white-space:pre-wrap;overflow-wrap:anywhere}.body strong{color:#f6f6f7}.bot{margin-left:7px;border-radius:4px;background:#423a50;color:#efe6fa;padding:1px 5px;font-size:10px;font-weight:700}',
  '.reply,.edited{font-size:12px;color:var(--muted)}.reply{display:block;margin-bottom:3px}.file{display:block;width:fit-content;max-width:100%;padding:8px;border:1px solid var(--line);background:#282d35;border-radius:8px;margin-top:8px}.file img,.file video{display:block;max-width:min(100%,520px);max-height:330px;object-fit:contain;margin-bottom:5px;border-radius:5px}.file audio{max-width:100%}',
  '.embed{max-width:min(100%,560px);width:fit-content;margin-top:8px;padding:11px 14px;background:var(--rail);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:7px;overflow-wrap:anywhere}.embed-provider,.embed-footer{color:var(--muted);font-size:12px}.embed-title{display:block;margin:3px 0 2px;font-weight:700}.embed .text{font-size:14px}.embed img.embed-media,.embed video{display:block;max-width:100%;max-height:290px;object-fit:contain;border-radius:5px;margin-top:8px}.embed-fields{display:grid;gap:7px;margin:7px 0;font-size:13px}.embed-fields dd{margin:0}.embed-fields dt{font-weight:700}.embed-attribution{display:flex;align-items:center;gap:5px}.embed-icon{width:18px;height:18px;border-radius:50%;object-fit:cover}',
  '.chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}.chip{color:var(--ink);font-size:12px;border:1px solid var(--line);background:var(--raised);padding:2px 6px;border-radius:5px}.intro{margin-bottom:15px}.intro h1{font-size:37px;color:var(--accent);margin-bottom:3px}.directory h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:24px 0 5px}',
  '.directory ul{padding:0;list-style:none;margin:0;border-top:1px solid var(--line)}.directory li a{display:flex;gap:14px;justify-content:space-between;text-decoration:none;padding:8px 10px;border-bottom:1px solid var(--line)}.directory li a:hover{background:var(--raised)}.directory li small{white-space:nowrap}',
  '@media(max-width:700px){.frame{display:block}.rail{display:none}.stream{padding:13px 10px 40px}.top{padding:11px 12px}.message{gap:8px;padding-left:2px;grid-template-columns:34px minmax(0,1fr)}.avatar{height:32px;width:32px;font-size:12px}.intro h1{font-size:30px}}',
].join('\n') + '\n';

function htmlStart(title, prefix, current, meta) {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src file: \'self\'; img-src file: \'self\'; media-src file: \'self\'; base-uri \'none\'; form-action \'none\'">' +
    '<title>' + esc(title) + '</title><link rel="stylesheet" href="' + prefix + 'archive.css">' +
    '<div class="frame"><aside class="rail"><a class="identity" href="' + prefix + 'index.html"><span class="mark">#</span>Discord archive</a>' +
    (current ? '<small>' + esc(meta || 'Transcript') + '</small><span class="current"><b>#</b> ' + esc(current) + '</span>' : '') +
    '</aside><main>';
}

function textHtml(value) {
  const pieces = String(value ?? '').split(/(https:\/\/[^\s<>"\x60]+)/g);
  return pieces.map((part, index) => {
    if (index % 2 === 0) return esc(part);
    const bare = part.replace(/[.,;!?]+$/, '');
    const safe = safeUrl(bare);
    return safe ? anchor(safe, bare) + esc(part.slice(bare.length)) : esc(part);
  }).join('');
}

function renderFile(file, prefix) {
  const href = file.path ? prefix + assetUrl(file.path) : safeUrl(file.url);
  const path = esc(href);
  const name = esc(file.name);
  let media = '';
  if (file.path && /^image\/(?:gif|jpeg|png|webp|avif)$/i.test(file.contentType))
    media = '<a href="' + path + '"><img loading="lazy" src="' + path + '" alt="' + name + '"></a>';
  if (file.path && /^video\/(?:mp4|webm|ogg)$/i.test(file.contentType))
    media = '<video controls preload="none" src="' + path + '"></video>';
  if (file.path && /^audio\/(?:mpeg|mp4|ogg|wav|webm|flac)$/i.test(file.contentType))
    media = '<audio controls preload="none" src="' + path + '"></audio>';
  return '<div class="file">' + media +
    (href ? '<a href="' + path + '" rel="noreferrer"' + (file.path ? ' download' : '') + '>' + name + '</a>' : name) +
    (file.status !== 'downloaded' ? ' <small>· ' + esc(file.status) + '</small>' : '') + '</div>';
}

function renderEmbed(embed, prefix) {
  const media = embed.media ?? {};
  const url = safeUrl(embed.url) || safeUrl(embed.video?.url);
  const title = embed.title || embed.author?.name || (url && new URL(url).hostname);
  const image = asset => asset?.path && /^image\//.test(asset.contentType) ? esc(prefix + assetUrl(asset.path)) : '';
  const showIcon = asset => image(asset) ? '<img class="embed-icon" src="' + image(asset) + '" alt="" loading="lazy">' : '';
  const attribution = (value, icon) => (value?.name ? '<div class="embed-attribution">' + showIcon(icon) +
    (safeUrl(value.url) ? anchor(safeUrl(value.url), value.name) : esc(value.name)) + '</div>' : '');
  const preview = [...new Set([image(media.image), image(media.thumbnail)].filter(Boolean))]
    .map(path => '<img class="embed-media" src="' + path + '" alt="" loading="lazy">').join('');
  const video = media.video?.path && /^video\//.test(media.video.contentType)
    ? '<video controls preload="none" src="' + esc(prefix + assetUrl(media.video.path)) + '"></video>' : '';
  const fields = (embed.fields ?? []).map(field => '<div><dt>' + esc(field.name) + '</dt><dd class="text">' + textHtml(field.value) + '</dd></div>').join('');
  const description = embed.description ? '<p class="text">' + textHtml(embed.description) + '</p>' : '';
  const provider = embed.provider?.name ? '<div class="embed-provider">' + esc(embed.provider.name) + '</div>' : '';
  const author = embed.author?.name !== title ? attribution(embed.author, media.authorIcon) : '';
  const footer = embed.footer?.text ? '<div class="embed-footer embed-attribution">' + showIcon(media.footerIcon) + esc(embed.footer.text) + '</div>' : '';
  const heading = title ? '<div class="embed-title">' + (url ? anchor(url, title) : esc(title)) + '</div>' : '';
  if (!heading && !description && !fields && !footer && !preview && !video) return '';
  return '<aside class="embed" aria-label="Embed">' + provider + author + heading + description +
    (fields ? '<dl class="embed-fields">' + fields + '</dl>' : '') + video + preview + footer + '</aside>';
}

const dateText = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const timeText = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

export function htmlTranscript(channel, mode, options) {
  const prefix = options.prefix || '';
  const fields = new Set(options.fields ?? jsonFields.defaults);
  let previousDay, previousAuthor, previousTime;
  return {
    extension: 'html',
    header: htmlStart('#' + channel.name, prefix, channel.name, channel.category) +
      '<header class="top"><h1><span class="hash">#</span>' + esc(channel.name) + '</h1><a href="' + prefix +
      'index.html">All channels</a></header><section class="stream"><p class="muted">' +
      esc(mode === 'demo' ? 'Sample transcript · UTC' : (channel.guildName || 'Discord transcript') + ' · UTC') + '</p>',
    footer: '</section></main></div></html>\n',
    row(message) {
      const timestamp = new Date(message.timestamp);
      const validTime = !Number.isNaN(timestamp.valueOf());
      const day = validTime ? timestamp.toISOString().slice(0, 10) : 'Undated';
      const name = message.author?.displayName ?? 'Unknown author';
      const authorId = message.author?.id ?? null;
      const grouped = previousDay === day && previousAuthor === authorId && authorId && !message.replyTo &&
        timestamp.valueOf() - previousTime <= 300_000;
      let markup = previousDay === day ? '' : '<div class="day">' + esc(validTime ? dateText.format(timestamp) : 'Undated') + '</div>';
      previousDay = day;
      previousAuthor = authorId;
      previousTime = timestamp.valueOf();
      const initials = name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toUpperCase();
      const tone = (Number(authorId?.slice(-2)) || 0) % 4;
      markup += '<article class="message' + (grouped ? ' continued' : '') + '" id="m-' + esc(message.id) + '">' +
        (grouped ? '<span></span>' : '<span aria-hidden="true" class="avatar t' + tone + '">' + esc(initials) + '</span>') + '<div class="body">';
      if (message.replyTo && fields.has('replies')) markup += '<a class="reply" href="#m-' + esc(message.replyTo) + '">↪ Reply</a>';
      if (!grouped) {
        markup += '<strong>' + esc(name) + '</strong>' + (message.author?.bot ? '<span class="bot">BOT</span>' : '');
        const url = safeUrl(message.url);
        const time = '<time datetime="' + esc(message.timestamp) + '">' + esc(validTime ? timeText.format(timestamp) : 'Undated') + '</time>';
        markup += url ? '<a class="time" href="' + esc(url) + '" rel="noreferrer" title="View message in Discord">' + time + '</a>' : time;
      }
      if (message.content) markup += '<p class="text">' + textHtml(message.content) +
        (fields.has('edits') && message.editedTimestamp ? ' <span class="edited">(edited)</span>' : '') + '</p>';
      if (fields.has('attachments')) markup += message.attachments.map(file => renderFile(file, prefix)).join('');
      if (fields.has('embeds')) markup += (message.embeds ?? []).map(embed => renderEmbed(embed, prefix)).join('');
      if (fields.has('reactions') && message.reactions.length) markup += '<div class="chips">' +
        message.reactions.map(value => '<span class="chip">' + esc(value.emoji?.name || 'Reaction') + ' ' + esc(value.count) + '</span>').join('') + '</div>';
      return markup + '</div></article>\n';
    },
  };
}

export function archiveIndex(name, results, guild) {
  const groups = new Map();
  for (const entry of results) {
    if (!entry.files.html) continue;
    const category = entry.channel.category || 'Uncategorized';
    const group = groups.get(category) ?? [];
    group.push(entry);
    groups.set(category, group);
  }
  const total = results.reduce((sum, entry) => sum + entry.messages, 0);
  const singleGuild = new Set(results.map(row => row.channel.guildId)).size === 1 ? results[0]?.channel.guildName : '';
  const title = guild?.name || singleGuild || (/^discord-\d{8}T/.test(name) ? 'Discord archive' : name);
  return htmlStart(title, '', '', '') + '<header class="top"><h1>Channel directory</h1><small>Offline archive</small></header>' +
    '<section class="stream directory"><header class="intro"><h1>' + esc(title) + '</h1><p class="muted">' +
    esc(results.length) + (results.length === 1 ? ' channel or thread · ' : ' channels and threads · ') +
    esc(total.toLocaleString('en-US')) + (total === 1 ? ' message' : ' messages') + ' · UTC</p></header>' +
    [...groups].map(([category, rows]) => '<h2>' + esc(category) + '</h2><ul>' +
      rows.map(row => '<li><a href="' + esc(assetUrl(row.files.html)) + '"><span><b class="hash">' +
        (row.channel.parentId ? '↳' : '#') + '</b> ' + esc(row.channel.name) + '</span><small>' + row.messages + ' messages</small></a></li>').join('') +
      '</ul>').join('') + '</section></main></div></html>\n';
}
