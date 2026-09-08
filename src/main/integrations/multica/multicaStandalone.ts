import fs from 'fs';
import path from 'path';

import { runMulticaBridgeClient } from './multicaBridgeClient';
import { MulticaBridgeServer, type MulticaBridgeServerOptions } from './multicaBridgeServer';

/** A short-lived authenticated relay for CLI invocations without a desktop host.
 * Uses the same runtime, session persistence and request validation as the UI relay.
 * A unique endpoint avoids changing the running desktop's bridge metadata.
 */
export async function runMulticaStandalone(
  options: MulticaBridgeServerOptions,
  argv: string[],
): Promise<number> {
  const parent = path.join(options.userDataPath, 'multica');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'cli-'));
  const server = new MulticaBridgeServer({ ...options, userDataPath: directory });
  try {
    await server.start();
    return await runMulticaBridgeClient(directory, argv);
  } finally {
    await server.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
