'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

let testExitCode = 1;
let restoreExitCode = 1;

try {
  const test = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  if (test.error) {
    console.error(`[test] Failed to start Vitest: ${test.error.message}`);
  }
  testExitCode = typeof test.status === 'number' ? test.status : 1;
} finally {
  console.log('[test] Restoring native modules for the Electron runtime...');
  const restore = spawnSync(
    process.execPath,
    [path.join(__dirname, 'rebuild-electron-native.cjs')],
    { cwd: root, stdio: 'inherit', shell: false },
  );
  if (restore.error) {
    console.error(`[test] Failed to restore Electron native modules: ${restore.error.message}`);
  }
  restoreExitCode = typeof restore.status === 'number' ? restore.status : 1;
}

process.exitCode = testExitCode || restoreExitCode;
