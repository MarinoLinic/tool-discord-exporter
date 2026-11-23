import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { history, home, Problem, saveSettings, settings } from '../core/state.mjs';
import { importProfiles, profiles, profileToken, removeProfile, renameProfile, replaceProfileToken } from '../core/profiles.mjs';
import { channelId, source } from '../core/source.mjs';
import { prepareExport, recentMessages } from '../core/export.mjs';
import { jobStatus, launchJob, listJobs, pauseJob } from '../core/jobs.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
app.setPath('userData', join(home, 'desktop'));

export async function openDesktop({
  mode = 'discord',
  hidden = false,
  provider = profileId => source(mode, undefined, undefined, { profileId }),
  identify = async token => (await source('discord', undefined, undefined, { token })).identity(),
  writeClipboard = value => clipboard.writeText(value),
} = {}) {
  await app.whenReady();
  const icon = nativeImage.createFromPath(join(root, 'icon.png'));
  const win = new BrowserWindow({
    width: 1320, height: 900, minWidth: 720, minHeight: 620, title: 'Discord Exporter',
    backgroundColor: '#11232b', show: false, autoHideMenuBar: true,
    icon: icon.isEmpty() ? join(root, 'icon.svg') : icon,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  function selectedToken(id) {
    if (!id) throw new Problem('INVALID_PROFILE', 'Choose a bot profile.');
    return profileToken(id);
  }
  const action = {
    init: async () => ({ settings: await settings(), profiles: await profiles(), home, root }),
    profiles,
    saveSettings,
    importProfiles: input => importProfiles(input, identify),
    renameProfile: ({ id, name }) => renameProfile(id, name),
    removeProfile: async id => {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', title: 'Remove bot profile?', message: 'Remove this bot profile?',
        detail: 'Paused jobs that use it will need a token for the same bot before they can resume.',
        buttons: ['Cancel', 'Remove profile'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response !== 1) return false;
      await removeProfile(id);
      return true;
    },
    revealToken: selectedToken,
    copyToken: async id => writeClipboard(await selectedToken(id)),
    replaceToken: ({ id, token }) => replaceProfileToken(id, token, identify),
    check: async id => (await provider(id)).identity(),
    guilds: async id => (await provider(id)).guilds(),
    channels: async ({ profileId, id, archived, generation }) => (await provider(profileId)).catalog(id, { archived, progress: data => {
      if (!win.isDestroyed()) win.webContents.send('archive:progress', { ...data, generation });
    } }),
    channel: async ({ profileId, id }) => (await provider(profileId)).channel(channelId(id)),
    preview: async ({ profileId, id }) => recentMessages(await provider(profileId), id),
    history: async () => (await history()).filter(item => item.source === mode),
    folder: async current => {
      const result = await dialog.showOpenDialog(win, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    },
    copy: writeClipboard,
    openFolder: async jobId => {
      const item = (await action.history()).find(item => item.jobId === jobId);
      if (!item || !isAbsolute(item.output)) throw new Problem('NOT_FOUND', 'This export is no longer in recent history.');
      const directory = await stat(item.output).catch(() => null);
      if (!directory?.isDirectory()) throw new Problem('OPEN_FAILED', 'The export folder has been moved or removed.');
      const error = await shell.openPath(item.output);
      if (error) throw new Problem('OPEN_FAILED', 'Could not open this export folder.');
    },
    export: async input => {
      const job = await prepareExport({ ...input, mode }, await settings());
      return await launchJob(job.id);
    },
    jobs: () => listJobs(mode),
    job: jobStatus,
    pause: pauseJob,
    resume: launchJob,
  };

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
  if (!hidden) win.show();
  return win;
}
