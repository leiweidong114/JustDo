import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { MulticaHttpBridgeServer } from './multicaHttpBridgeServer';

const roots: string[] = [];

afterEach(async () => {
  delete process.env.JUSTDO_MULTICA_HTTP_HOST;
  delete process.env.JUSTDO_MULTICA_HTTP_PORT;
  delete process.env.JUSTDO_MULTICA_HTTP_TOKEN;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Multica HTTP bridge', () => {
  test('refuses non-loopback binding without an explicit token', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-http-'));
    roots.push(root);
    process.env.JUSTDO_MULTICA_HTTP_HOST = '0.0.0.0';
    process.env.JUSTDO_MULTICA_HTTP_PORT = '43129';
    const server = new MulticaHttpBridgeServer(root);
    await expect(server.start()).rejects.toThrow('JUSTDO_MULTICA_HTTP_TOKEN');
  });

  test('starts loopback health endpoint and writes protected metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-http-'));
    roots.push(root);
    process.env.JUSTDO_MULTICA_HTTP_PORT = '43130';
    const server = new MulticaHttpBridgeServer(root);
    await server.start();
    try {
      const response = await fetch('http://127.0.0.1:43130/v1/health');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', protocol: 1 });
      const metadata = JSON.parse(
        fs.readFileSync(path.join(root, 'multica', 'http-bridge.json'), 'utf8'),
      ) as { token: string };
      expect(metadata.token.length).toBeGreaterThan(32);
    } finally {
      await server.stop();
    }
  });
});
