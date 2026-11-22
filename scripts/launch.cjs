const { spawn } = require('node:child_process');
const { join } = require('node:path');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env: environment });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
