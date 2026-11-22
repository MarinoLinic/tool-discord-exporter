import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { clearToken, credentialStatus, history, home, Problem, saveSettings, savedToken, saveToken, settings } from '../core/state.mjs';
import { channelId, source } from '../core/source.mjs';
import { preview, runExport } from '../core/export.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const qa = process.argv.includes('--qa');
const qaOutput = process.env.DISCORD_EXPORTER_QA;
if (qa && (!qaOutput || !isAbsolute(qaOutput) || home !== resolve(qaOutput, 'state') || process.env.DISCORD_BOT_TOKEN)) {
  console.error('Desktop QA requires an isolated state directory and no Discord token.');
  app.exit(2);
}
app.setPath('userData', join(home, 'desktop'));
let win, active;
const action = {
  init: async () => ({ settings: await settings(), credential: await credentialStatus(), home, root }),
  status: credentialStatus,
  saveSettings,
  saveToken: async token => { await saveToken(token); return await credentialStatus(); },
  clearToken: async () => { await clearToken(); return await credentialStatus(); },
  revealToken: savedToken,
  check: async () => (await source('discord')).identity(),
  guilds: async mode => (await source(mode)).guilds(),
  channels: async ({ mode, id }) => (await source(mode)).channels(id),
  channel: async ({ mode, id }) => (await source(mode)).channel(channelId(id)),
  preview: async ({ mode, id }) => preview(mode, id),
  history,
  folder: async current => {
    const result = await dialog.showOpenDialog(win, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  },
  copy: value => clipboard.writeText(value),
  openFolder: async jobId => {
    const item = (await history()).find(item => item.jobId === jobId);
    if (!item || !isAbsolute(item.output)) throw new Problem('NOT_FOUND', 'This export is no longer in recent history.');
    const directory = await stat(item.output).catch(() => null);
    if (!directory?.isDirectory()) throw new Problem('OPEN_FAILED', 'The export folder has been moved or removed.');
    const error = await shell.openPath(item.output);
    if (error) throw new Problem('OPEN_FAILED', 'Could not open this export folder.');
  },
  export: async input => {
    if (active) throw new Problem('BUSY', 'An export is running.');
    active = new AbortController();
    try {
      return await runExport(input, await settings(), {
        signal: active.signal,
        progress: data => { if (win && !win.isDestroyed()) win.webContents.send('archive:progress', data); },
      });
    } finally { active = undefined; }
  },
  cancel: () => { active?.abort(); },
};

if (!qa && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => active?.abort());
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
    win.on('close', event => {
      if (!active) return;
      event.preventDefault();
      active.abort();
    });
    await win.loadFile(join(here, 'index.html'));
    if (qa) {
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
        await win.webContents.executeJavaScript("document.querySelector('#tab-export').click()");
        win.setContentSize(900, 760);
        await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,300))');
        const horizontalOverflow = await win.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth');
        if (horizontalOverflow) throw new Error('Compact layout has horizontal overflow.');
        await writeFile(join(destination, 'compact.png'), (await win.capturePage()).toPNG());
        const archive = await runExport({ mode: 'demo', channels: ['1200000000000000010'],
          format: 'html', output: join(destination, 'sample-output') }, await settings());
        const reader = new BrowserWindow({ width: 880, height: 740, show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        try {
          await reader.loadFile(join(archive.output, archive.channels[0].file));
          const messages = await reader.webContents.executeJavaScript('document.querySelectorAll("article").length');
          if (messages !== 4) throw new Error('Rendered transcript message count mismatch.');
          await writeFile(join(destination, 'transcript.png'), (await reader.capturePage()).toPNG());
        } finally { reader.destroy(); }
        await writeFile(join(destination, 'ui-check.json'), JSON.stringify(evidence, null, 2));
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    } else win.show();
  }).catch(error => { console.error(error); app.exit(1); });
}
