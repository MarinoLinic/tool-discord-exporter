const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const ui = { mode: 'demo', tab: 'export', channels: [], selected: new Map(), collapsed: new Set(), generation: 0, previewVersion: 0, busy: false };
const formatChoices = [
  ['html', 'HTML', 'Readable archive', 'file'], ['jsonl', 'JSONL', 'AI and scripts', 'terminal'],
  ['markdown', 'Markdown', 'Portable text', 'lines'], ['json', 'JSON', 'Structured data', 'code'],
];
const fields = [
  ['attachments', 'Attachment references'], ['replies', 'Reply links'], ['edits', 'Edit timestamps'],
  ['embeds', 'Link previews'], ['reactions', 'Reactions'], ['mentions', 'Mention IDs'],
  ['stickers', 'Stickers'], ['polls', 'Polls'], ['metadata', 'Message flags'],
];
const defaultFields = new Set(['attachments', 'replies', 'edits']);
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
    input.type = 'checkbox';
    input.name = 'format';
    input.value = name;
    input.setAttribute('aria-label', title);
    input.title = description;
    label.append(input, icon(glyph), el('b', title), el('small', description));
    return label;
  }));
  $('#default-format').replaceChildren(...formatChoices.map(([value, name]) => choice(name, value)));
  $('#detail-options').replaceChildren(...fields.map(([key, title]) => {
    const label = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.value = key;
    input.checked = defaultFields.has(key);
    label.append(input, title);
    return label;
  }));
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
  for (const input of $$('input[name=format]')) input.checked = input.value === config.format || (config.format === 'html' && input.value === 'json');
  $('#default-attachments').checked = $('#attachments').checked = config.attachments;
  $('#file-cap').value = config.attachmentMiB;
  $('#job-cap').value = config.budgetMiB;
  $('#show-preview').checked = config.showPreview;
  $('#attachment-note').textContent = config.attachmentMiB + ' MiB per file · ' + config.budgetMiB + ' MiB per job';
  $('#show-message-preview').hidden = !config.showPreview;
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
  if (tab === 'history') void guarded(renderJobs)();
  if (tab === 'automation') renderCommand();
  if (tab === 'settings') void guarded(async () => displayCredentials(await call('status')))();
}

const isThread = item => [10, 11, 12].includes(item.type);
function visibleChannels() {
  const search = $('#channel-search').value.trim().toLowerCase();
  const scope = $('#channel-scope').value;
  const available = new Map([...ui.channels, ...(ui.manual?.values() ?? [])].map(item => [item.id, item]));
  return [...available.values()].filter(item =>
    (scope === 'all' || isThread(item) === (scope === 'threads')) &&
    (!search || [item.name, item.category, item.parentName, item.id].join(' ').toLowerCase().includes(search)));
}

function setSelected(rows, selected) {
  const adds = rows.filter(row => !ui.selected.has(row.id)).length;
  if (selected && ui.selected.size + adds > 5000) {
    notice('Select up to 5,000 channels or narrow the filter.', true);
    return;
  }
  for (const row of rows) {
    if (selected) ui.selected.set(row.id, row);
    else ui.selected.delete(row.id);
  }
  renderChannels();
  updateSelection();
}

function checkState(input, items) {
  const count = items.filter(item => ui.selected.has(item.id)).length;
  input.checked = items.length > 0 && count === items.length;
  input.indeterminate = count > 0 && count < items.length;
  input.disabled = !items.length || ui.busy;
  return count;
}

function renderChannels() {
  const list = $('#channel-list');
  const focus = list.contains(document.activeElement) ? document.activeElement.dataset.focus : '';
  const scrollTop = list.scrollTop;
  const filtered = visibleChannels();
  const groups = new Map();
  const search = Boolean($('#channel-search').value.trim());
  $('#select-all-label').textContent = search || $('#channel-scope').value !== 'all' ? 'Select all results' : 'Select all listed';
  checkState($('#select-all'), filtered);
  $('#clear-selection').disabled = !ui.selected.size;
  for (const item of filtered) {
    const key = item.categoryId || 'uncategorized';
    if (!groups.has(key)) groups.set(key, { name: item.category || 'Uncategorized', rows: [] });
    groups.get(key).rows.push(item);
  }
  const fragment = document.createDocumentFragment();
  for (const [key, { name, rows }] of groups) {
    const group = el('div', undefined, 'category-line');
    const fold = el('button', ui.collapsed.has(key) ? '▸' : '▾', 'fold');
    fold.type = 'button';
    fold.dataset.focus = 'fold-' + key;
    fold.setAttribute('aria-label', (ui.collapsed.has(key) ? 'Expand ' : 'Collapse ') + name);
    fold.setAttribute('aria-expanded', String(!ui.collapsed.has(key)));
    fold.addEventListener('click', () => {
      if (ui.collapsed.has(key)) ui.collapsed.delete(key);
      else ui.collapsed.add(key);
      renderChannels();
    });
    const label = el('label', undefined, 'category-select');
    const check = el('input');
    check.type = 'checkbox';
    check.dataset.focus = 'category-' + key;
    check.setAttribute('aria-label', 'Select ' + name + ' category');
    const count = checkState(check, rows);
    check.addEventListener('change', () => setSelected(rows, check.checked));
    label.append(check, el('span', name));
    group.append(fold, label, el('small', count + ' / ' + rows.length));
    fragment.append(group);
    if (ui.collapsed.has(key) && !search) continue;
    for (const item of rows) {
      const thread = isThread(item);
      const row = el('label', undefined, 'channel' + (thread ? ' thread' : ''));
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = ui.selected.has(item.id);
      checkbox.disabled = ui.busy;
      checkbox.dataset.focus = 'channel-' + item.id;
      checkbox.setAttribute('aria-label', item.name);
      checkbox.addEventListener('change', () => setSelected([item], checkbox.checked));
      const hash = el('span', thread ? '↳' : item.type === 2 ? '◖' : '#', 'hash');
      hash.setAttribute('aria-hidden', 'true');
      row.append(checkbox, hash, el('span', item.name, 'channel-name'));
      if (thread) row.append(el('span', item.archived ? 'Archived thread' : 'Thread', 'thread-type'));
      row.title = item.parentName ? item.parentName + ' → ' + item.name : item.name;
      fragment.append(row);
    }
  }
  list.replaceChildren(fragment);
  if (!list.childElementCount) list.append(el('p', ui.loading ? 'Loading channels…' : search ? 'No channels or threads match.' : 'Choose a server or add a channel link.', 'empty'));
  list.scrollTop = scrollTop;
  if (focus) [...list.querySelectorAll('[data-focus]')].find(item => item.dataset.focus === focus)?.focus({ preventScroll: true });
}

function updateSelection() {
  $('#selection-count').textContent = ui.selected.size + ' selected';
  const ready = ui.selected.size > 0 && inputOptions().formats.length > 0;
  $('#submit-export').disabled = !ready || ui.busy;
  $('#copy-export').disabled = !ready;
  $('#show-message-preview').disabled = !ui.selected.size;
  renderCommand();
}

async function loadChannels(id, autoselect = false, archived = false) {
  const generation = ++ui.generation;
  const prior = [...ui.channels];
  ui.loading = true;
  if (!archived) { ui.channels = []; ui.collapsed.clear(); }
  $('#load-archived').disabled = true;
  $('#catalog-status').textContent = archived ? 'Looking for archived threads…' : 'Loading channels…';
  renderChannels();
  try {
    const result = id ? await call('channels', { mode: ui.mode, id, archived, generation }) : { channels: [], inaccessible: [], warnings: [] };
    if (generation !== ui.generation) return;
    ui.channels = result.channels;
    if (autoselect && result.channels.length) ui.selected.set(result.channels[0].id, result.channels[0]);
    const before = new Set(prior.map(item => item.id));
    if (archived && prior.length && prior.every(item => ui.selected.has(item.id))) {
      for (const item of result.channels) if (!before.has(item.id)) ui.selected.set(item.id, item);
    }
    const threads = result.channels.filter(isThread).length;
    const textChannels = result.channels.length - threads;
    $('#catalog-status').textContent = textChannels + (textChannels === 1 ? ' channel · ' : ' channels · ') + threads +
      (threads === 1 ? ' thread' : ' threads') +
      (archived ? ' · Archived checked' : ui.mode === 'discord' ? ' · Active threads only' : '') +
      (result.inaccessible.length ? ' · ' + result.inaccessible.length + ' unavailable' : '');
    if (result.warnings.length) notice(result.warnings.length + ' archived thread listings were unavailable.', true);
  } catch (error) {
    if (generation === ui.generation) { notice(error.message, true); $('#catalog-status').textContent = 'Channel listing unavailable.'; }
  } finally {
    if (generation === ui.generation) {
      ui.loading = false;
      $('#load-archived').disabled = !id || ui.mode === 'demo';
      renderChannels();
      updateSelection();
    }
  }
}

async function selectSource(mode) {
  if (ui.busy) return;
  const generation = ++ui.generation;
  ui.mode = mode;
  ui.selected.clear();
  ui.manual = new Map();
  ui.collapsed.clear();
  $('#channel-scope').value = 'all';
  $('#catalog-status').textContent = '';
  $('#load-archived').disabled = true;
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
      if (message.attachments.length) text.append(el('p', message.attachments.length + (message.attachments.length === 1 ? ' attachment' : ' attachments')));
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
    mode: ui.mode, channels: [...ui.selected.keys()], catalog: [...ui.selected.values()],
    formats: $$('input[name=format]:checked').map(input => input.value),
    fields: $$('#detail-options input:checked').map(input => input.value), name: $('#archive-name').value.trim(),
    since: $('#since').value, until: $('#until').value, contains: $('#contains').value, limit: Number($('#limit').value),
    attachments: $('#attachments').checked, output: $('#output').value,
    attachmentMiB: ui.config.attachmentMiB, budgetMiB: ui.config.budgetMiB,
  };
}
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
function command() {
  if (!ui.config) return '';
  const config = inputOptions();
  if (!config.channels.length || !config.formats.length) return '';
  const args = ['node', quote(ui.root + '\\cli.mjs'), 'export'];
  if (config.mode === 'demo') args.push('--demo');
  for (const id of config.channels) args.push('--channel=' + id);
  for (const format of config.formats) args.push('--format=' + format);
  args.push(quote('--fields=' + config.fields.join(',')));
  for (const [flag, value] of [['name', config.name], ['output', config.output], ['since', config.since],
    ['until', config.until], ['contains', config.contains], ['limit', config.limit],
    ['attachment-mib', config.attachmentMiB], ['budget-mib', config.budgetMiB]]) {
    if (value !== '') args.push(quote('--' + flag + '=' + value));
  }
  args.push(config.attachments ? '--attachments' : '--no-attachments', '--background', '--print-json');
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
  head.append(...['Archive', 'Formats', 'Messages', 'Saved (UTC)', ''].map(value => el('div', value)));
  target.replaceChildren(head, ...rows.map(job => {
    const row = el('div', undefined, 'history-row');
    const names = job.channels.slice(0, 2).map(value => '#' + value.channel.name).join(', ');
    const name = el('div', job.guild?.name ?? (names + (job.channels.length > 2 ? ' +' + (job.channels.length - 2) : '')));
    name.append(el('small', job.name || (job.source === 'demo' ? 'Sample archive' : 'Discord')));
    row.append(name, el('code', (job.formats || [job.format]).join(' + ').toUpperCase()), el('div', job.messageCount),
      el('div', timeFormat.format(new Date(job.finishedAt))), openButton(job.jobId));
    return row;
  }));
}

function busy(value) {
  ui.busy = value;
  $('#submit-export').lastElementChild.textContent = value ? 'Starting…' : 'Start export';
  renderChannels();
  updateSelection();
}

const stages = { prepare: 'Preparing', discover: 'Finding threads', fetch: 'Reading messages', media: 'Saving attachments', write: 'Writing transcripts', publish: 'Publishing' };
const formatCount = value => Number(value || 0).toLocaleString('en-US');
function jobCard(job) {
  const card = el('article', undefined, 'job-card');
  const header = el('header');
  header.append(el('strong', job.name), el('span', job.state === 'running' ? (stages[job.stage] ?? 'Running') : job.state[0].toUpperCase() + job.state.slice(1)));
  card.append(header);
  if (job.state === 'completed') {
    const result = job.manifest;
    card.append(el('p', 'Saved ' + formatCount(result.messageCount) + ' messages across ' + result.channels.length + ' channels and threads.', 'field-note'), openButton(job.id));
    if (result.warnings.length) card.append(el('p', result.warnings.length + ' warnings in manifest.json', 'field-note'));
    return card;
  }
  const progress = el('progress');
  progress.setAttribute('aria-label', 'Export job progress');
  if (job.total > 0) { progress.max = job.total; progress.value = job.completed; }
  card.append(progress);
  const counts = job.scan && job.stage === 'discover' ? job.completed + ' / ' + job.total + ' parent channels checked' :
    (job.total ? job.completed + ' / ' + job.total + ' items complete · ' : '') + formatCount(job.messages) + ' messages';
  card.append(el('p', counts + (job.channel && job.stage !== 'discover' ? ' · #' + job.channel.name : ''), 'field-note'));
  if (job.attachments?.downloaded) card.append(el('p', formatCount(job.attachments.downloaded) + ' attachments · ' +
    (job.attachments.bytes / 1048576).toFixed(1) + ' MiB', 'field-note'));
  if (job.detail) card.append(el('p', job.detail, 'field-note'));
  const running = ['running', 'queued'].includes(job.state);
  const button = el('button', running ? 'Pause' : 'Resume', 'ghost');
  button.type = 'button';
  button.addEventListener('click', guarded(async () => {
    button.disabled = true;
    try {
      await call(running ? 'pause' : 'resume', job.id);
      notice(running ? 'Pausing at the next checkpoint…' : 'Resuming export…');
      await refreshTracking();
    } finally { button.disabled = false; }
  }));
  card.append(button);
  return card;
}

function replaceJobCard(target, jobs) {
  const signature = JSON.stringify(jobs.map(job => [job.id, job.state, job.updatedAt]));
  if (target.dataset.signature === signature) return;
  // Keep keyboard focus on an action while a live counter refreshes.
  if (target.contains(document.activeElement) && target.querySelector('button:focus') && jobs.some(job => job.state === 'running')) return;
  target.dataset.signature = signature;
  target.replaceChildren(...(jobs.length ? jobs.map(jobCard) : [el('p', 'No active or paused exports.', 'empty')]));
}

async function renderJobs() {
  const jobs = await call('jobs');
  const finished = jobs.filter(job => job.state === 'completed').map(job => job.id).join(',');
  replaceJobCard($('#running-list'), jobs.filter(job => job.state !== 'completed'));
  if (ui.finishedJobs !== finished) {
    ui.finishedJobs = finished;
    await renderHistory();
  }
}
async function refreshTracking() {
  if (ui.currentJob) {
    const job = await call('job', ui.currentJob);
    replaceJobCard($('#job'), [job]);
    if (job.state === 'completed' && ui.lastFinished !== job.id) {
      ui.lastFinished = job.id;
      if (ui.tab === 'history') await renderHistory();
    }
  }
  if (ui.tab === 'history') await renderJobs();
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
  on('#channel-scope', 'change', renderChannels);
  on('#select-all', 'change', event => setSelected(visibleChannels(), event.target.checked));
  on('#clear-selection', 'click', () => { ui.selected.clear(); renderChannels(); updateSelection(); });
  on('#load-archived', 'click', () => loadChannels($('#guild').value, false, true));
  on('#show-message-preview', 'click', async () => { $('#preview-panel').showModal(); await renderPreview(); });
  on('#add-form', 'submit', async event => {
    event.preventDefault();
    const link = $('#channel-link').value.trim();
    if (!link) return;
    const generation = ui.generation;
    const channel = await call('channel', { mode: ui.mode, id: link });
    if (generation !== ui.generation) return;
    $('#channel-link').value = '';
    ui.manual.set(channel.id, channel);
    setSelected([channel], true);
    notice();
  });
  for (const [button, field] of [['#choose-output', '#output'], ['#choose-default', '#default-output']]) {
    on(button, 'click', async () => {
      const path = await call('folder', $(field).value);
      if (path) $(field).value = path;
      updateSelection();
    });
  }
  on('#export-form', 'input', updateSelection);
  on('#copy-export', 'click', copyCommand);
  on('#automation-copy', 'click', copyCommand);
  on('#refresh-history', 'click', async () => { await renderJobs(); await renderHistory(); });
  window.archive.progress(event => {
    if (event.stage === 'discover' && event.generation === ui.generation)
      $('#catalog-status').textContent = 'Finding archived threads · ' + event.completed + ' / ' + event.total + ' parent channels';
  });
  setInterval(() => { if (ui.tab === 'history' || (ui.currentJob && ui.lastFinished !== ui.currentJob)) void guarded(refreshTracking)(); }, 1000);
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
      ui.currentJob = result.id;
      await refreshTracking();
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
