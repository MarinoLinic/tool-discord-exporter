import { Problem } from '../core/state.mjs';

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
const channels = sample.map(([name], i) => ({ id: String(base + BigInt(i)), guildId: demoGuild,
  guildName: guild.name, categoryId: i < 4 ? 'research' : 'general', category: i < 4 ? 'Research' : 'General',
  name, type: i === 3 ? 11 : 0, parentId: i === 3 ? String(base) : null, archived: i === 3 }));
export const firstDemoChannel = channels[0].id;
export const demoAttachmentId = '1200000000000000999';
const names = ['Mina Park', 'Elias Reed', 'June Ellis'];
const fixtures = new Map(channels.map((channel, i) => [channel.id, sample[i][1].map(([name, content], j) => ({
  id: String(base + 100n + BigInt(i * 10 + j)),
  timestamp: new Date(Date.UTC(2026, 10, 18, 10, 12 + j * 17)).toISOString(),
  author: { id: String(base + 200n + BigInt(names.indexOf(name))), username: name },
  content, attachments: i === 0 && j === 2 ? [{
    id: demoAttachmentId, filename: 'Harbor Survey.png', size: 18000,
    url: 'https://cdn.discordapp.com/attachments/1200000000000000010/1200000000000000999/Harbor-Survey.png',
    content_type: 'image/png', description: 'Fictional survey sketch',
  }] : [], embeds: [], type: 0,
})).reverse()]));

export function demoSource() {
  return {
    identity: async () => ({ id: '1200000000000000000', name: 'Sample bot' }),
    guilds: async () => [guild],
    channels: async id => {
      if (id !== demoGuild) throw new Problem('NOT_FOUND', 'That server is outside the sample archive.');
      return channels;
    },
    catalog: async () => ({ guild, channels, inaccessible: [], warnings: [] }),
    channel: async id => {
      const match = channels.find(item => item.id === id);
      if (!match) throw new Problem('NOT_FOUND', 'That channel is outside the sample archive.');
      return match;
    },
    page: async (id, query) => (fixtures.get(id) ?? []).filter(item =>
      (!query.before || BigInt(item.id) < BigInt(query.before)) &&
      (!query.after || BigInt(item.id) > BigInt(query.after))).slice(0, query.limit),
  };
}

export function attachmentFixture(id) {
  return id === demoAttachmentId ? new URL('./harbor-survey.png', import.meta.url) : null;
}
