'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const releaseDir = path.resolve(process.argv[2] || 'release');

function fail(message) {
  throw new Error(`[verify-linux-release] ${message}`);
}

function exactlyOne(suffix) {
  const matches = fs
    .readdirSync(releaseDir)
    .filter(name => name.endsWith(suffix))
    .map(name => path.join(releaseDir, name));
  if (matches.length !== 1) fail(`Expected one ${suffix} artifact, found ${matches.length}.`);
  return matches[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${String(result.stderr || result.stdout || result.error || '').trim()}`);
  }
  return String(result.stdout || '');
}

function requirePaths(root, entries) {
  const missing = entries.filter(entry => !fs.existsSync(path.join(root, entry)));
  if (missing.length) fail(`Missing required files: ${missing.join(', ')}`);
}

if (process.platform !== 'linux') fail('Run this verification on Linux.');
if (!fs.existsSync(releaseDir)) fail(`Release directory does not exist: ${releaseDir}`);

const appImage = exactlyOne('.AppImage');
const deb = exactlyOne('.deb');
const portableAgent = path.join(releaseDir, 'JustDo-agent-linux-x64');
const unpacked = path.join(releaseDir, 'linux-unpacked');
requirePaths(unpacked, [
  'JustDo',
  'JustDo-agent',
  'resources/app.asar',
  'resources/cfmind/package.json',
  'resources/cfmind/runtime-build-info.json',
  'resources/cfmind/gateway-bundle.mjs',
  'resources/cfmind/node_modules/json5/package.json',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
]);
requirePaths(releaseDir, ['JustDo-agent-linux-x64']);

const fileOutput = run('file', [appImage]);
if (!fileOutput.includes('ELF 64-bit')) fail('AppImage is not a 64-bit Linux ELF executable.');
if ((fs.statSync(appImage).mode & 0o111) === 0) fail('AppImage is not executable.');
if ((fs.statSync(portableAgent).mode & 0o111) === 0) fail('Portable Agent launcher is not executable.');

const debListing = run('dpkg-deb', ['--contents', deb]);
for (const required of [
  '/opt/JustDo/JustDo',
  '/opt/JustDo/JustDo-agent',
  '/opt/JustDo/resources/app.asar',
  '/opt/JustDo/resources/cfmind/gateway-bundle.mjs',
  '/opt/JustDo/resources/cfmind/node_modules/json5/package.json',
  '/opt/JustDo/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
]) {
  if (!debListing.includes(required)) fail(`Debian package is missing ${required}.`);
}

const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-appimage-'));
try {
  run(appImage, ['--appimage-extract'], { cwd: extractRoot });
  requirePaths(path.join(extractRoot, 'squashfs-root'), [
    'AppRun',
    'JustDo',
    'JustDo-agent',
    'resources/app.asar',
    'resources/cfmind/gateway-bundle.mjs',
    'resources/cfmind/node_modules/json5/package.json',
  ]);
} finally {
  fs.rmSync(extractRoot, { recursive: true, force: true });
}

const artifacts = [appImage, deb, portableAgent];
const checksums = artifacts.map(file => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return `${digest}  ${path.basename(file)}`;
});
const checksumPath = path.join(releaseDir, 'SHA256SUMS-linux.txt');
fs.writeFileSync(checksumPath, `${checksums.join('\n')}\n`, 'utf8');
console.log(`[verify-linux-release] Verified AppImage, deb, runtime, native module, and Agent launchers.`);
console.log(`[verify-linux-release] Checksums: ${checksumPath}`);
