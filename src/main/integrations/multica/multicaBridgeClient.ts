import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import {
  decodeBridgeLines,
  encodeBridgeMessage,
  MULTICA_BRIDGE_METADATA_FILE,
  MULTICA_BRIDGE_PROTOCOL_VERSION,
  type MulticaBridgeMetadata,
  type MulticaBridgeRequest,
  type MulticaBridgeResponse,
  sanitizeMulticaBridgeEnvironment,
} from './multicaBridgeProtocol';

const CONNECT_TIMEOUT_MS = 3_000;

export interface MulticaBridgeInvocationResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}

export async function invokeMulticaBridge(
  userDataPath: string,
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    connectTimeoutMs?: number;
  } = {},
): Promise<MulticaBridgeInvocationResult> {
  const metadataPath = path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as MulticaBridgeMetadata;
  if (
    metadata.version !== MULTICA_BRIDGE_PROTOCOL_VERSION ||
    !metadata.endpoint ||
    !metadata.token
  ) {
    throw new Error(`The running ${PRODUCT_NAME} bridge is incompatible.`);
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(metadata.endpoint);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let buffer = '';
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out connecting to ${PRODUCT_NAME}.`))),
      options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    socket.once('connect', () => {
      clearTimeout(timer);
      const request: MulticaBridgeRequest = {
        type: 'request',
        version: MULTICA_BRIDGE_PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        token: metadata.token,
        argv,
        cwd: options.cwd || process.cwd(),
        env: sanitizeMulticaBridgeEnvironment(options.env ?? process.env),
      };
      socket.write(encodeBridgeMessage(request));
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let decoded: ReturnType<typeof decodeBridgeLines>;
      try {
        decoded = decodeBridgeLines(buffer);
      } catch {
        finish(() => reject(new Error(`${PRODUCT_NAME} bridge returned invalid data.`)));
        return;
      }
      buffer = decoded.remainder;
      for (const raw of decoded.messages) {
        const message = raw as MulticaBridgeResponse;
        if (message.type === 'stdout') stdout.push(Buffer.from(message.data, 'base64'));
        else if (message.type === 'stderr') stderr.push(Buffer.from(message.data, 'base64'));
        else if (message.type === 'error') finish(() => reject(new Error(message.message)));
        else if (message.type === 'exit') {
          finish(() =>
            resolve({
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
              exitCode: message.code,
              ...(message.signal ? { signal: message.signal } : {}),
            }),
          );
        }
      }
    });
    socket.once('error', error => finish(() => reject(error)));
    socket.once('close', () => {
      if (!settled) finish(() => reject(new Error(`${PRODUCT_NAME} bridge closed early.`)));
    });
  });
}

const writeProcessOutput = (stream: NodeJS.WriteStream, output: string): Promise<void> =>
  new Promise((resolve, reject) =>
    stream.write(output, error => (error ? reject(error) : resolve())),
  );

export async function runMulticaBridgeClient(
  userDataPath: string,
  argv: string[],
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
): Promise<number> {
  const metadataPath = path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE);
  let metadata: MulticaBridgeMetadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as MulticaBridgeMetadata;
  } catch {
    await writeProcessOutput(
      process.stderr,
      `${PRODUCT_NAME} is not running. Start ${PRODUCT_NAME} and keep it open or in the tray.\n`,
    );
    return 69;
  }
  if (
    metadata.version !== MULTICA_BRIDGE_PROTOCOL_VERSION ||
    !metadata.endpoint ||
    !metadata.token
  ) {
    await writeProcessOutput(
      process.stderr,
      `The running ${PRODUCT_NAME} bridge is incompatible. Restart ${PRODUCT_NAME} and try again.\n`,
    );
    return 70;
  }

  return new Promise(resolve => {
    const socket = net.createConnection(metadata.endpoint);
    let settled = false;
    let buffer = '';
    let pendingWrites = 0;
    let requestedExitCode: number | null = null;
    const finishWhenDrained = (): void => {
      if (requestedExitCode === null || pendingWrites > 0 || settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(requestedExitCode);
    };
    const requestFinish = (code: number): void => {
      requestedExitCode ??= code;
      finishWhenDrained();
    };
    const writeOutput = (stream: NodeJS.WriteStream, output: Uint8Array): void => {
      pendingWrites += 1;
      stream.write(output, () => {
        pendingWrites -= 1;
        finishWhenDrained();
      });
    };
    const timer = setTimeout(() => {
      writeOutput(
        process.stderr,
        Buffer.from(`Timed out connecting to the running ${PRODUCT_NAME} bridge.\n`),
      );
      requestFinish(69);
    }, connectTimeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      const request: MulticaBridgeRequest = {
        type: 'request',
        version: MULTICA_BRIDGE_PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        token: metadata.token,
        argv,
        cwd: process.cwd(),
        env: sanitizeMulticaBridgeEnvironment(process.env),
      };
      socket.write(encodeBridgeMessage(request));
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let decoded: ReturnType<typeof decodeBridgeLines>;
      try {
        decoded = decodeBridgeLines(buffer);
      } catch {
        writeOutput(
          process.stderr,
          Buffer.from(`${PRODUCT_NAME} bridge returned an invalid response.\n`),
        );
        requestFinish(70);
        return;
      }
      buffer = decoded.remainder;
      for (const raw of decoded.messages) {
        const message = raw as MulticaBridgeResponse;
        if (message.type === 'stdout' || message.type === 'stderr') {
          const output = Buffer.from(message.data, 'base64');
          writeOutput(message.type === 'stdout' ? process.stdout : process.stderr, output);
        } else if (message.type === 'error') {
          writeOutput(process.stderr, Buffer.from(`${message.message}\n`));
          requestFinish(70);
        } else if (message.type === 'exit') {
          requestFinish(message.code);
        }
      }
    });
    socket.once('error', () => {
      writeOutput(
        process.stderr,
        Buffer.from(
          `${PRODUCT_NAME} is not running. Start ${PRODUCT_NAME} and keep it open or in the tray.\n`,
        ),
      );
      requestFinish(69);
    });
    socket.once('close', () => {
      if (!settled) requestFinish(70);
    });
  });
}
