const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const ui = { mode: 'demo', tab: 'export', channels: [], selected: new Map(), generation: 0, previewVersion: 0, busy: false };
const formatChoices = [
  ['html', 'HTML', 'Readable archive', 'file'], ['jsonl', 'JSONL', 'AI and scripts', 'terminal'],
  ['markdown', 'Markdown', 'Portable text', 'lines'], ['json', 'JSON', 'Structured data', 'code'],
];
const pages = { export: 'New export', history: 'Export history', settings: 'Settings', automation: 'Automation' };
const labels = { none: 'No token', environment: 'Environment', windows: 'Token saved' };

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}
async function call(name, value) {
  const result = await window.archive.call(name, value);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
}
function notice(message = '', error = false) {
  const node = $('#notice');
  node.hidden = !message;
  node.dataset.error = error;
  node.textContent = message;
}
function guarded(fn) {
  return async event => {
    try { await fn(event); }
    catch (error) { notice(error.message, true); }
  };
}
function on(id, event, fn) { $(id).addEventListener(event, guarded(fn)); }
function hideToken() {
  $('#revealed').value = '';
  $('#revealed').hidden = true;
  $('#reveal-token').textContent = 'Reveal saved token';
  clearTimeout(ui.revealTimer);
}

function choice(name, value) {
  const option = el('option', name);
  option.value = value;
  return option;
}
function renderFormats() {
  $('#formats').replaceChildren(...formatChoices.map(([name, title, description, glyph]) => {
    const label = el('label', undefined, 'format');
    const input = el('input');
    input.type = 'radio';
    input.name = 'format';
    input.value = name;
    input.setAttribute('aria-label', title);
    label.append(input, icon(glyph), el('b', title), el('small', description));
    return label;
  }));
  $('#default-format').replaceChildren(...formatChoices.map(([value, name]) => choice(name, value)));
}
function displayCredentials(status) {
  ui.credential = status;
  $('#credential-badge').textContent = labels[status.source];
  $('#reveal-token').disabled = !status.saved;
  $('#clear-token').disabled = !status.saved;
  $('#check-token').disabled = status.source === 'none';
  $('#credential-source').textContent = status.source === 'environment'
    ? 'DISCORD_BOT_TOKEN takes precedence for this process.'
    : 'Windows encrypts the saved token for your Windows account.';
}
function applyDefaults(config) {
  ui.config = config;
  $('#default-output').value = $('#output').value = config.output;
  $('#default-limit').value = $('#limit').value = config.limit || '';
  $('#default-format').value = config.format;
  $('input[name=format][value="' + config.format + '"]').checked = true;
  $('#default-attachments').checked = $('#attachments').checked = config.attachments;
  $('#file-cap').value = config.attachmentMiB;
  $('#job-cap').value = config.budgetMiB;
  $('#show-preview').checked = config.showPreview;
  $('#attachment-note').textContent = config.attachmentMiB + ' MiB per file · ' + config.budgetMiB + ' MiB per job';
  $('#preview-panel').hidden = !config.showPreview;
}
function showTab(tab) {
  ui.tab = tab;
  hideToken();
  notice();
  for (const node of $$('[data-tab]')) {
    if (node.dataset.tab === tab) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
  for (const page of $$('[data-page]')) page.hidden = page.dataset.page !== tab;
  $('#breadcrumb').replaceChildren('Workspace ', el('span', '/'), ' ' + pages[tab]);
  window.scrollTo(0, 0);
  if (tab === 'history') void guarded(renderHistory)();
  if (tab === 'automation') renderCommand();
  if (tab === 'settings') void guarded(async () => displayCredentials(await call('status')))();
}

function renderChannels() {
  const search = $('#channel-search').value.trim().toLowerCase();
  const list = $('#channel-list');
  list.replaceChildren();
  const available = new Map([...ui.channels, ...ui.selected.values()].map(item => [item.id, item]));
  let group;
  for (const item of available.values()) {
    const category = item.category || 'Other channels';
    if (search && !(item.name + ' ' + category + ' ' + item.id).toLowerCase().includes(search)) continue;
    if (group !== category) { group = category; list.append(el('div', group, 'category')); }
    const label = el('label', undefined, 'channel');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = ui.selected.has(item.id);
    checkbox.disabled = ui.busy;
    checkbox.setAttribute('aria-label', item.name);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (ui.selected.size >= 50) {
          checkbox.checked = false;
          notice('Select up to 50 channels per export.', true);
          return;
        }
        ui.selected.set(item.id, item);
      } else ui.selected.delete(item.id);
      updateSelection();
    });
    const hash = el('span', [10, 11, 12].includes(item.type) ? '↳' : '#', 'hash');
    hash.setAttribute('aria-hidden', 'true');
    label.append(checkbox, hash, el('span', item.name));
    list.append(label);
  }
  if (!list.childElementCount) list.append(el('p', ui.loading ? 'Loading channels…' : search ? 'No channels match.' : 'Choose a server or add a channel link.', 'empty'));
}

function updateSelection() {
  $('#selection-count').textContent = ui.selected.size + ' selected';
  $('#submit-export').disabled = !ui.selected.size || ui.busy;
  $('#copy-export').disabled = !ui.selected.size || ui.busy;
  renderCommand();
  if (ui.config.showPreview) void guarded(renderPreview)();
}

async function loadChannels(id, autoselect = false) {
  const generation = ++ui.generation;
  ui.loading = true;
  ui.channels = [];
  renderChannels();
  try {
    const channels = id ? await call('channels', { mode: ui.mode, id }) : [];
    if (generation !== ui.generation) return;
    ui.channels = channels;
    if (autoselect && channels.length) ui.selected.set(channels[0].id, channels[0]);
  } catch (error) { if (generation === ui.generation) notice(error.message, true); }
  finally {
    if (generation === ui.generation) {
      ui.loading = false;
      renderChannels();
      updateSelection();
    }
  }
}

async function selectSource(mode) {
  if (ui.busy) return;
  const generation = ++ui.generation;
  ui.mode = mode;
  document.querySelector("#job").hidden = true;
  ui.selected.clear();
  ui.channels = [];
  ui.loading = true;
  $('#channel-search').value = $('#channel-link').value = '';
  $('#guild').replaceChildren(choice('Loading…', ''));
  $('#demo-mode').setAttribute('aria-pressed', String(mode === 'demo'));
  $('#live-mode').setAttribute('aria-pressed', String(mode === 'discord'));
  $('#source-tag').textContent = mode === 'demo' ? 'Fictional sample data' : 'Discord bot connection';
  notice();
  renderChannels();
  updateSelection();
  try {
    const guilds = await call('guilds', mode);
    if (generation !== ui.generation) return;
    $('#guild').replaceChildren(...(guilds.length ? guilds.map(item => choice(item.name, item.id)) : [choice('No servers', '')]));
    await loadChannels(guilds[0]?.id, mode === 'demo');
  } catch (error) {
    if (generation !== ui.generation) return;
    ui.loading = false;
    $('#guild').replaceChildren(choice('No server selected', ''));
    renderChannels();
    notice(error.message, true);
  }
}

const timeFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
async function renderPreview() {
  const version = ++ui.previewVersion;
  const channel = [...ui.selected.values()].at(-1);
  const pane = $('#message-preview');
  $('#preview-channel').textContent = channel ? '#' + channel.name + ' · Latest messages · UTC' : '';
  pane.replaceChildren(el('p', channel ? 'Loading messages…' : 'Select a channel to see recent messages.', 'empty'));
  if (!channel) return;
  try {
    const rows = await call('preview', { mode: ui.mode, id: channel.id });
    if (version !== ui.previewVersion) return;
    pane.replaceChildren(...rows.map(message => {
      const name = message.author?.displayName ?? 'Unknown author';
      const initials = name.split(/\s+/).slice(0, 2).map(word => [...word][0] ?? '').join('').toUpperCase();
      const row = el('article', undefined, 'message');
      const avatar = el('span', initials, 'avatar');
      avatar.dataset.tone = (Number(message.author?.id?.slice(-2)) || 0) % 3;
      avatar.setAttribute('aria-hidden', 'true');
      const text = el('div');
      const time = el('time', timeFormat.format(new Date(message.timestamp)));
      time.dateTime = message.timestamp;
      text.append(el('strong', name), time, el('p', message.content || (message.attachments.length ? 'Attachment only' : 'No text returned')));
      if (message.attachments.length) text.append(el('p', message.attachments.length + ' attachment(s)'));
      row.append(avatar, text);
      return row;
    }));
    if (!rows.length) pane.append(el('p', 'No recent messages were returned. Check channel history permissions if you expected messages.', 'empty'));
  } catch (error) {
    if (version === ui.previewVersion) pane.replaceChildren(el('p', error.message, 'empty'));
  }
}

function inputOptions() {
  return {
    mode: ui.mode, channels: [...ui.selected.keys()], format: $('input[name=format]:checked').value,
    since: $('#since').value, until: $('#until').value, contains: $('#contains').value, limit: Number($('#limit').value),
    attachments: $('#attachments').checked, output: $('#output').value,
    attachmentMiB: ui.config.attachmentMiB, budgetMiB: ui.config.budgetMiB,
  };
}
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
function command() {
  if (!ui.config) return '';
  const config = inputOptions();
  if (!config.channels.length) return '';
  const args = ['node', quote(ui.root + '\\cli.mjs'), 'export'];
  if (config.mode === 'demo') args.push('--demo');
  for (const id of config.channels) args.push('--channel=' + id);
  for (const [flag, value] of [['format', config.format], ['output', config.output], ['since', config.since],
    ['until', config.until], ['contains', config.contains], ['limit', config.limit],
    ['attachment-mib', config.attachmentMiB], ['budget-mib', config.budgetMiB]]) {
    if (value !== '') args.push(quote('--' + flag + '=' + value));
  }
  args.push(config.attachments ? '--attachments' : '--no-attachments', '--print-json');
  return args.join(' ');
}
function renderCommand() {
  const text = command();
  $('#command').textContent = text || 'Select at least one channel in New export.';
  $('#automation-copy').disabled = !text;
}
async function copyCommand() {
  const text = command();
  if (text) { await call('copy', text); notice('PowerShell command copied.'); }
}
function openButton(jobId) {
  const button = el('button', 'Open folder', 'ghost');
  button.type = 'button';
  button.addEventListener('click', guarded(() => call('openFolder', jobId)));
  return button;
}
async function renderHistory() {
  const target = $('#history-list');
  const rows = await call('history');
  if (!rows.length) { target.replaceChildren(el('p', 'No exports yet. Run an export to create a bundle.', 'empty')); return; }
  const head = el('div', undefined, 'history-row history-head');
  head.append(...['Channels', 'Format', 'Messages', 'Saved (UTC)', ''].map(value => el('div', value)));
  target.replaceChildren(head, ...rows.map(job => {
    const row = el('div', undefined, 'history-row');
    const name = el('div', job.channels.map(value => '#' + value.channel.name).join(', '));
    name.append(el('small', job.source === 'demo' ? 'Sample archive' : 'Discord'));
    row.append(name, el('code', job.format.toUpperCase()), el('div', job.messageCount),
      el('div', timeFormat.format(new Date(job.finishedAt))), openButton(job.jobId));
    return row;
  }));
}

function busy(value) {
  ui.busy = value;
  for (const selector of ['#demo-mode','#live-mode','#guild','#add-form button','#settings-form button[type=submit]']) $(selector).disabled = value;
  $('#cancel').hidden = !value;
  $('#cancel').disabled = false;
  $('#submit-export').lastElementChild.textContent = value ? 'Exporting…' : 'Export selected';
  renderChannels();
  $('#submit-export').disabled = !ui.selected.size || value;
  $('#copy-export').disabled = !ui.selected.size || value;
}

async function start() {
  const boot = await call('init');
  ui.root = boot.root;
  $('#home').textContent = boot.home;
  renderFormats();
  applyDefaults(boot.settings);
  displayCredentials(boot.credential);
  for (const tab of $$('[data-tab]')) {
    tab.setAttribute('aria-label', pages[tab.dataset.tab]);
    tab.title = pages[tab.dataset.tab];
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  }
  on('#demo-mode', 'click', () => selectSource('demo'));
  on('#live-mode', 'click', () => selectSource('discord'));
  on('#guild', 'change', event => loadChannels(event.target.value));
  on('#channel-search', 'input', renderChannels);
  on('#add-form', 'submit', async event => {
    event.preventDefault();
    if (ui.selected.size >= 50) { notice('Select up to 50 channels per export.', true); return; }
    const link = $('#channel-link').value.trim();
    if (!link) return;
    const generation = ui.generation;
    const channel = await call('channel', { mode: ui.mode, id: link });
    if (generation !== ui.generation) return;
    $('#channel-link').value = '';
    ui.selected.set(channel.id, channel);
    renderChannels();
    updateSelection();
    notice();
  });
  for (const [button, field] of [['#choose-output', '#output'], ['#choose-default', '#default-output']]) {
    on(button, 'click', async () => {
      const path = await call('folder', $(field).value);
      if (path) $(field).value = path;
      renderCommand();
    });
  }
  on('#export-form', 'input', renderCommand);
  on('#copy-export', 'click', copyCommand);
  on('#automation-copy', 'click', copyCommand);
  on('#refresh-history', 'click', renderHistory);
  on('#cancel', 'click', async () => { $('#cancel').disabled = true; await call('cancel'); });
  window.archive.progress(event => {
    $('#job').hidden = false;
    const verb = event.stage === 'fetch' ? 'Reading' : 'Writing';
    $('#job').textContent = verb + ' #' + event.channel.name + ' · ' + event.matched + ' matches · ' + (event.completed + 1) + ' of ' + event.total + ' channels';
  });
  on('#export-form', 'submit', async event => {
    event.preventDefault();
    if (ui.busy || !ui.selected.size) return;
    const options = inputOptions();
    notice();
    busy(true);
    $('#job').hidden = false;
    $('#job').textContent = 'Starting export…';
    try {
      const result = await call('export', options);
      $('#job').replaceChildren(el('div', 'Saved ' + result.messageCount + ' messages across ' + result.channels.length + (result.channels.length === 1 ? ' channel.' : ' channels.')));
      for (const warning of result.warnings) $('#job').append(el('div', warning, 'field-note'));
      $('#job').append(openButton(result.jobId));
      if (ui.tab === 'history') await renderHistory();
    } catch (error) { $('#job').textContent = error.message; }
    finally { busy(false); }
  });
  on('#settings-form', 'submit', async event => {
    event.preventDefault();
    const config = await call('saveSettings', {
      output: $('#default-output').value, format: $('#default-format').value,
      limit: Number($('#default-limit').value), attachments: $('#default-attachments').checked,
      attachmentMiB: Number($('#file-cap').value), budgetMiB: Number($('#job-cap').value), showPreview: $('#show-preview').checked,
    });
    applyDefaults(config);
    updateSelection();
    notice('Export defaults saved.');
  });
  on('#token-form', 'submit', async event => {
    event.preventDefault();
    const field = $('#token');
    const token = field.value;
    field.value = '';
    hideToken();
    displayCredentials(await call('saveToken', token));
    notice('Token encrypted and saved.');
  });
  on('#check-token', 'click', async () => {
    notice('Checking Discord connection…');
    const bot = await call('check');
    notice('Connected as ' + bot.name + '.');
  });
  on('#reveal-token', 'click', async () => {
    if (!$('#revealed').hidden) { hideToken(); return; }
    const token = await call('revealToken');
    if (!token || ui.tab !== 'settings') return;
    $('#revealed').value = token;
    $('#revealed').hidden = false;
    $('#reveal-token').textContent = 'Hide saved token';
    ui.revealTimer = setTimeout(hideToken, 15_000);
  });
  on('#clear-token', 'click', async () => {
    hideToken();
    displayCredentials(await call('clearToken'));
    notice('Saved token cleared.');
  });
  await selectSource('demo');
}
void guarded(start)();
