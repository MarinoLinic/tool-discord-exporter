import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { home, Problem } from './state.mjs';

const root = join(home, 'jobs');
export const jobPattern = /^\d{8}T\d{9}Z-[\da-f]{8}$/;
export const jobId = () => new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);

export function jobDirectory(id) {
  if (!jobPattern.test(id)) throw new Problem('INVALID_JOB', 'Enter a valid export job ID.', 2);
  return join(root, id);
}

export async function saveJobFile(id, file, value) {
  const dir = jobDirectory(id);
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, (file === 'status' ? 'status' : randomUUID()) + '.tmp');
  await writeFile(temporary, JSON.stringify(value) + '\n');
  await rename(temporary, join(dir, file + '.json'));
}

export async function loadJobFile(id, file) {
  try { return JSON.parse(await readFile(join(jobDirectory(id), file + '.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Problem('JOB_NOT_FOUND', 'No saved job with that ID.', 2);
    throw error;
  }
}

export function lockJob(id) {
  const db = new DatabaseSync(join(jobDirectory(id), 'worker.sqlite'), { timeout: 0 });
  try { db.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    db.close();
    if (error.errcode === 5 || error.errcode === 6) throw new Problem('JOB_RUNNING', 'This export is already running.');
    throw error;
  }
  return () => { db.exec('ROLLBACK'); db.close(); };
}

async function readStatus(id, mode) {
  const [config, status] = await Promise.all([loadJobFile(id, 'job'), loadJobFile(id, 'status')]);
  if (mode && config.options.mode !== mode) return null;
  if (status.state === 'running' || status.state === 'queued') {
    let release;
    try { release = lockJob(id); }
    catch (error) { if (error.code === 'JOB_RUNNING') return status; throw error; }
    release();
    if (config.output && await stat(join(config.output, 'manifest.json')).then(x => x.isFile(), () => false)) {
      const manifest = JSON.parse(await readFile(join(config.output, 'manifest.json'), 'utf8'));
      if (manifest.jobId === id) return { ...status, state: 'completed', manifest };
    }
    if (status.state === 'queued' && Date.now() - Date.parse(status.updatedAt) < 8000) return status;
    return { ...status, state: 'paused', detail: 'Worker stopped. Resume to continue.' };
  }
  return status;
}
export const jobStatus = id => readStatus(id);

export async function listJobs(mode) {
  const dirs = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return (await Promise.all(dirs.filter(id => jobPattern.test(id)).sort().reverse().slice(0, 100)
    .map(id => readStatus(id, mode).catch(error => { if (error.code === 'JOB_NOT_FOUND') return null; throw error; })))).filter(Boolean);
}

export async function launchJob(id) {
  const status = await readStatus(id);
  if (status.state === 'completed') return status;
  if (status.state === 'running') throw new Problem('JOB_RUNNING', 'This export is already running.');
  await saveJobFile(id, 'control', { pause: false });
  // The worker uses Node directly from a CLI, or Electron's Node mode from the desktop.
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const env = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(process.execPath, [cli, 'worker', '--job', id, '--quiet'], {
    detached: true, windowsHide: true, stdio: 'ignore', env,
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return { ...status, workerPid: child.pid };
}

export async function pauseJob(id) {
  const status = await readStatus(id);
  if (!['running', 'queued'].includes(status.state)) return status;
  await saveJobFile(id, 'control', { pause: true });
  return status;
}
