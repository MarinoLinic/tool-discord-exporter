import { app } from 'electron';
import { openDesktop } from './runtime.mjs';

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window;
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  openDesktop().then(value => { window = value; }).catch(error => { console.error(error); app.exit(1); });
}
