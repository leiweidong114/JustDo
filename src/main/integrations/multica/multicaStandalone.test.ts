import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), client: vi.fn(), options: [] as { userDataPath: string }[],
}));
vi.mock('./multicaBridgeClient', () => ({ runMulticaBridgeClient: mocks.client }));
vi.mock('./multicaBridgeServer', () => ({
  MulticaBridgeServer: class {
    constructor(options: { userDataPath: string }) { mocks.options.push(options); }
    start = mocks.start;
    stop = mocks.stop;
  },
}));
import { runMulticaStandalone } from './multicaStandalone';
import type { MulticaBridgeServerOptions } from './multicaBridgeServer';

describe('standalone CLI lifecycle', () => {
  test.each([false, true])('isolates desktop metadata and cleans up, failure=%s', async fail => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'JustDo CLI 中文 '));
    mocks.options.length = 0;
    mocks.start.mockReset().mockResolvedValue(undefined);
    mocks.stop.mockReset().mockResolvedValue(undefined);
    mocks.client.mockReset();
    if (fail) mocks.client.mockRejectedValue(new Error('runtime failed'));
    else mocks.client.mockResolvedValue(0);
    const desktop = path.join(root, 'multica', 'bridge.json');
    fs.mkdirSync(path.dirname(desktop));
    fs.writeFileSync(desktop, 'unchanged-desktop-metadata');
    try {
      const result = runMulticaStandalone({ userDataPath: root } as MulticaBridgeServerOptions, ['--version']);
      if (fail) await expect(result).rejects.toThrow('runtime failed');
      else await expect(result).resolves.toBe(0);
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(mocks.stop).toHaveBeenCalledOnce();
      const directory = mocks.options[0].userDataPath;
      expect(directory).not.toBe(root);
      expect(mocks.client).toHaveBeenCalledWith(directory, ['--version']);
      expect(fs.existsSync(directory)).toBe(false);
      expect(fs.readFileSync(desktop, 'utf8')).toBe('unchanged-desktop-metadata');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
