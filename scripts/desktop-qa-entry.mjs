import { app, BrowserWindow } from 'electron';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { home, Problem, saveToken, settings } from '../core/state.mjs';
import { source } from '../core/source.mjs';
import { prepareExport, runExport, runJob } from '../core/export.mjs';
import { jobStatus } from '../core/jobs.mjs';
import { openDesktop } from '../desktop/runtime.mjs';

const destination = process.env.DISCORD_EXPORTER_QA;
const empty = process.argv.includes('--unconfigured');
const tokens = new Map([
  ['sample.first.bot-token', { id: '1200000000000000301', name: 'Field Notes Bot' }],
  ['sample.first.rotated-token', { id: '1200000000000000301', name: 'Field Notes Bot' }],
  ['sample.second.bot-token', { id: '1200000000000000302', name: 'Reading Room Bot' }],
]);

async function verifyDesktop() {
  if (!destination || !isAbsolute(destination) || home !== resolve(destination, 'state') || process.env.DISCORD_BOT_TOKEN)
    throw new Error('Desktop QA requires an isolated state directory and no Discord token.');
  await mkdir(destination, { recursive: true });
  if (empty) {
    const win = await openDesktop({ hidden: true });
    const evidence = await win.webContents.executeJavaScript(`(async () => {
      const status = document.querySelector('#catalog-status');
      for (let i = 0; i < 60 && !status.textContent.includes('Add a Discord bot token'); i++)
        await new Promise(resolve => setTimeout(resolve, 50));
      return status.textContent.includes('Add a Discord bot token') && document.querySelector('#submit-export').disabled;
    })()`);
    if (!evidence) throw new Error('Unconfigured desktop did not show Discord setup guidance.');
    await win.capturePage();
    await writeFile(join(destination, 'unconfigured.png'), (await win.capturePage()).toPNG());
    return;
  }

  await saveToken('sample.legacy.bot-token');
  let copied = '';
  const win = await openDesktop({
    mode: 'demo', hidden: true,
    writeClipboard: value => { copied = value; },
    identify: token => {
      if (!tokens.has(token)) throw new Problem('AUTH_FAILED', 'Discord rejected the bot token.');
      return tokens.get(token);
    },
    provider: async id => {
      const base = await source('demo');
      if (id !== '1200000000000000302') return base;
      return { ...base, guilds: async () => (await base.guilds()).map(guild => ({ ...guild, name: 'Reading Room Server' })) };
    },
  });
  const script = await readFile(fileURLToPath(new URL('./desktop-qa.cjs', import.meta.url)), 'utf8');
  const evidence = await win.webContents.executeJavaScript(script);
  if (copied !== 'sample.first.rotated-token') throw new Error('Copy did not use the saved replacement token.');
  for (const [name, selector] of [['workspace', '#tab-export'], ['settings', '#tab-settings'], ['automation', '#tab-automation'], ['history', '#tab-history']]) {
    await win.webContents.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').click(); new Promise(r=>setTimeout(r,250))');
    await win.capturePage();
    await writeFile(join(destination, name + '.png'), (await win.capturePage()).toPNG());
  }
  await win.webContents.executeJavaScript("document.querySelector('#tab-export').click(); document.querySelector('.json-details').scrollIntoView({block:'center'}); new Promise(r=>setTimeout(r,300))");
  await win.capturePage();
  await writeFile(join(destination, 'details.png'), (await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript("window.scrollTo(0,0); document.querySelector('#show-message-preview').click(); new Promise(r=>setTimeout(r,400))");
  await win.capturePage();
  await writeFile(join(destination, 'preview.png'), (await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.querySelector('#preview-panel button').click(); document.querySelector('.json-details').open=false; window.scrollTo(0,0)");
  win.setContentSize(900, 760);
  await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,300))');
  const horizontalOverflow = await win.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth');
  if (horizontalOverflow) throw new Error('Compact layout has horizontal overflow.');
  await writeFile(join(destination, 'compact.png'), (await win.capturePage()).toPNG());
  const archive = await runExport({ mode: 'demo', channels: ['1200000000000000010'],
    format: 'html', attachments: true, output: join(destination, 'sample-output') }, await settings());
  const reader = new BrowserWindow({ width: 880, height: 740, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await reader.loadFile(join(archive.output, archive.channels[0].file));
    const messages = await reader.webContents.executeJavaScript('document.querySelectorAll("article").length');
    if (messages !== 4) throw new Error('Rendered transcript message count mismatch.');
    const imageLoaded = await reader.webContents.executeJavaScript("new Promise(resolve=>{const img=document.querySelector('.file img'); if(!img) resolve(false); else { img.loading='eager'; img.decode().then(()=>resolve(img.naturalWidth>0),()=>resolve(false)); }})");
    if (!imageLoaded) throw new Error('Offline attachment did not render.');
    const color = await reader.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor");
    if (color !== 'rgb(34, 38, 44)') throw new Error('Offline archive stylesheet did not load.');
    await writeFile(join(destination, 'transcript.png'), (await reader.capturePage()).toPNG());
    await reader.loadFile(join(archive.output, 'index.html'));
    if (!(await reader.webContents.executeJavaScript("document.querySelector('.directory li a') !== null")))
      throw new Error('Offline channel directory is missing.');
    await reader.capturePage();
    await writeFile(join(destination, 'directory.png'), (await reader.capturePage()).toPNG());
  } finally { reader.destroy(); }
  win.setContentSize(1305, 780);
  const pause = new AbortController();
  const example = await prepareExport({ mode: 'demo', guild: '1200000000000000001', formats: ['html','json'],
    name: 'Field Archive checkpoint', output: join(destination, 'sample-output') }, await settings());
  try {
    await runJob(example.id, { signal: pause.signal, progress: status => {
      if (status.stage === 'write' && status.completed >= 2) pause.abort();
    } });
  } catch (error) { if (error.code !== 'PAUSED') throw error; }
  await win.webContents.executeJavaScript("document.querySelector('#tab-history').click(); new Promise(r=>setTimeout(r,400))");
  await win.capturePage();
  await writeFile(join(destination, 'paused.png'), (await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('#running-list button')).find(b=>b.textContent==='Resume').click()");
  let resumed;
  for (let i = 0; i < 25; i++) {
    resumed = await jobStatus(example.id);
    if (resumed.state === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (resumed.state !== 'completed' || resumed.manifest.messageCount !== 10) throw new Error('Desktop resume did not finish the checkpointed job.');
  await writeFile(join(destination, 'ui-check.json'), JSON.stringify({ ...evidence, offlineMedia: true, resumed: resumed.manifest.messageCount }, null, 2));
}

verifyDesktop().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
