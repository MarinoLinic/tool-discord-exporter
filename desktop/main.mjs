import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { clearToken, credentialStatus, history, home, Problem, saveSettings, savedToken, saveToken, settings } from '../core/state.mjs';
import { channelId, source } from '../core/source.mjs';
import { prepareExport, preview, runExport, runJob } from '../core/export.mjs';
import { jobStatus, launchJob, listJobs, pauseJob } from '../core/jobs.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const unconfiguredQa = process.argv.includes('--qa-unconfigured');
const qa = process.argv.includes('--qa') || unconfiguredQa;
const sourceMode = qa && !unconfiguredQa ? 'demo' : 'discord';
const qaOutput = process.env.DISCORD_EXPORTER_QA;
if (qa && (!qaOutput || !isAbsolute(qaOutput) || home !== resolve(qaOutput, 'state') || process.env.DISCORD_BOT_TOKEN)) {
  console.error('Desktop QA requires an isolated state directory and no Discord token.');
  app.exit(2);
}
app.setPath('userData', join(home, 'desktop'));
let win;
const action = {
  init: async () => ({ settings: await settings(), credential: await credentialStatus(), home, root }),
  status: credentialStatus,
  saveSettings,
  saveToken: async token => { await saveToken(token); return await credentialStatus(); },
  clearToken: async () => { await clearToken(); return await credentialStatus(); },
  revealToken: savedToken,
  check: async () => (await source('discord')).identity(),
  guilds: async () => (await source(sourceMode)).guilds(),
  channels: async ({ id, archived, generation }) => (await source(sourceMode)).catalog(id, { archived, progress: data => {
    if (win && !win.isDestroyed()) win.webContents.send('archive:progress', { ...data, generation });
  } }),
  channel: async id => (await source(sourceMode)).channel(channelId(id)),
  preview: async id => preview(sourceMode, id),
  history: async () => (await history()).filter(item => item.source === sourceMode),
  folder: async current => {
    const result = await dialog.showOpenDialog(win, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  },
  copy: value => clipboard.writeText(value),
  openFolder: async jobId => {
    const item = (await action.history()).find(item => item.jobId === jobId);
    if (!item || !isAbsolute(item.output)) throw new Problem('NOT_FOUND', 'This export is no longer in recent history.');
    const directory = await stat(item.output).catch(() => null);
    if (!directory?.isDirectory()) throw new Problem('OPEN_FAILED', 'The export folder has been moved or removed.');
    const error = await shell.openPath(item.output);
    if (error) throw new Problem('OPEN_FAILED', 'Could not open this export folder.');
  },
  export: async input => {
    const job = await prepareExport({ ...input, mode: sourceMode }, await settings());
    return await launchJob(job.id);
  },
  jobs: () => listJobs(sourceMode),
  job: jobStatus,
  pause: pauseJob,
  resume: launchJob,
};

if (!qa && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    const iconPath = join(root, 'icon.svg');
    const icon = nativeImage.createFromPath(join(root, 'icon.png'));
    win = new BrowserWindow({
      width: 1320, height: 900, minWidth: 720, minHeight: 620, title: 'Discord Exporter',
      backgroundColor: '#11232b', show: false, autoHideMenuBar: true, icon: icon.isEmpty() ? iconPath : icon,
      webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    ipcMain.handle('archive:call', async (event, name, input) => {
      if (event.senderFrame !== win.webContents.mainFrame || !Object.hasOwn(action, name))
        return { ok: false, error: { code: 'UNAVAILABLE', message: 'Action unavailable.' } };
      try { return { ok: true, value: await action[name](input) }; }
      catch (error) {
        return { ok: false, error: { code: error.name === 'AbortError' ? 'CANCELED' : error.code ?? 'FAILED',
          message: error.name === 'AbortError' ? 'Export canceled.' : error.message } };
      }
    });
    await win.loadFile(join(here, 'index.html'));
    if (unconfiguredQa) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const evidence = await win.webContents.executeJavaScript(`(async () => {
        const status = document.querySelector('#catalog-status');
        for (let i = 0; i < 60 && !status.textContent.includes('Add a Discord bot token'); i++)
          await new Promise(resolve => setTimeout(resolve, 50));
        return status.textContent.includes('Add a Discord bot token') &&
          !document.body.innerText.includes('Sample archive') &&
          document.querySelector('#submit-export').disabled;
      })()`);
      if (!evidence) throw new Error('Unconfigured desktop did not show Discord setup guidance.');
      await mkdir(qaOutput, { recursive: true });
      await win.capturePage();
      await writeFile(join(qaOutput, 'unconfigured.png'), (await win.capturePage()).toPNG());
      app.exit(0);
    } else if (qa) {
      try {
        const script = await readFile(join(root, 'scripts', 'desktop-qa.cjs'), 'utf8');
        const evidence = await win.webContents.executeJavaScript(script);
        const { writeFile, mkdir } = await import('node:fs/promises');
        const destination = process.env.DISCORD_EXPORTER_QA;
        await mkdir(destination, { recursive: true });
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
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    } else win.show();
  }).catch(error => { console.error(error); app.exit(1); });
}
