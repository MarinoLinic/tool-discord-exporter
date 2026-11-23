import { createHash } from 'node:crypto';

export const embedTypes = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/gif', 'gif'], ['image/webp', 'webp'], ['image/avif', 'avif'],
  ['video/mp4', 'mp4'], ['video/webm', 'webm'], ['video/ogg', 'ogv'],
]);

export function embedMediaUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    const host = url.hostname;
    const path = url.pathname;
    const attachment = /^\/attachments\//.test(path);
    if (host === 'cdn.discordapp.com' && (attachment || /^\/(?:icons|avatars|embed\/avatars)\//.test(path))) return url;
    if (host === 'media.discordapp.net' && (attachment || path.startsWith('/external/'))) return url;
    if (/^images-ext-[12]\.discordapp\.net$/.test(host) && path.startsWith('/external/')) return url;
    if (host === 'i.ytimg.com' && /^\/vi(?:_webp)?\//.test(path)) return url;
  } catch { /* An unavailable URL remains in the original embed metadata. */ }
  return null;
}

export function embedReferences(embed) {
  const result = [];
  for (const role of ['thumbnail', 'image', 'video', 'authorIcon', 'footerIcon']) {
    const value = role === 'authorIcon' ? { url: embed.author?.icon_url, proxy_url: embed.author?.proxy_icon_url }
      : role === 'footerIcon' ? { url: embed.footer?.icon_url, proxy_url: embed.footer?.proxy_icon_url } : embed[role];
    if (!value?.url && !value?.proxy_url) continue;
    const urls = [...new Set([value.proxy_url, value.url].map(url => embedMediaUrl(url)?.href).filter(Boolean))];
    // External video player pages are links; only Discord-hosted or proxied video bytes can be archived.
    if (role === 'video' && !urls.length) continue;
    const url = urls[0] ?? value.url ?? value.proxy_url;
    const mediaClass = role === 'video' ? 'video' : 'image';
    const id = 'embed-' + createHash('sha256').update(mediaClass + ':' + url).digest('hex').slice(0, 32);
    result.push({ role, file: { id, url, urls, mediaClass, kind: 'embed' } });
  }
  return result;
}

export function withSavedEmbedAssets(embed, lookup) {
  const media = {};
  for (const { role, file } of embedReferences(embed)) {
    const asset = lookup(file.id);
    if (!asset) continue;
    media[role] = { status: asset.status, ...(asset.path ? { path: asset.path, contentType: asset.contentType, size: asset.size } : {}) };
  }
  return Object.keys(media).length ? { ...embed, media } : embed;
}
