import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import { invokeMulticaBridge } from './multicaBridgeClient';
import { parseMulticaBridgeArgv, sanitizeMulticaBridgeEnvironment } from './multicaBridgeProtocol';

const MAX_BODY_BYTES = 70 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 48 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 5000;
const DEFAULT_PORT = 43128;

interface HttpInvocationBody {
  argv?: unknown;
  cwd?: unknown;
  env?: unknown;
  workspaceFiles?: unknown;
  configContent?: unknown;
}

interface TransferFile { data: string; mode?: number }

export interface MulticaHttpBridgeMetadata {
  version: 1;
  host: string;
  port: number;
  token: string;
  pid: number;
}

const isLoopbackHost = (host: string): boolean =>
  ['127.0.0.1', '::1', 'localhost'].includes(host.trim().toLowerCase());

const jsonResponse = (response: http.ServerResponse, status: number, body: unknown): void => {
  const value = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': value.byteLength,
    'Cache-Control': 'no-store',
  });
  response.end(value);
};

const safeRelativePath = (value: string): string | null => {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  const parts = normalized.split('/');
  return parts.some(part => !part || part === '.' || part === '..') ? null : normalized;
};

const rewritePathStrings = (value: unknown, source: string, target: string): unknown => {
  if (typeof value === 'string') return value.replaceAll(source, target);
  if (Array.isArray(value)) return value.map(item => rewritePathStrings(item, source, target));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewritePathStrings(item, source, target)]),
    );
  }
  return value;
};

const writeTransferredWorkspace = (
  root: string,
  rawFiles: unknown,
): void => {
  if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
    throw new Error('invalid_workspace_files');
  }
  const entries = Object.entries(rawFiles);
  if (entries.length > MAX_WORKSPACE_FILES) throw new Error('workspace_file_limit_exceeded');
  let total = 0;
  for (const [rawPath, rawFile] of entries) {
    const relative = safeRelativePath(rawPath);
    if (!relative || !rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) {
      throw new Error('invalid_workspace_file');
    }
    const transfer = rawFile as Partial<TransferFile>;
    if (typeof transfer.data !== 'string') throw new Error('invalid_workspace_file');
    const data = Buffer.from(transfer.data, 'base64');
    total += data.byteLength;
    if (total > MAX_WORKSPACE_BYTES) throw new Error('workspace_size_limit_exceeded');
    const destination = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data, { mode: transfer.mode ?? 0o600 });
  }
};

const readTransferredWorkspace = (root: string): Record<string, TransferFile> => {
  const result: Record<string, TransferFile> = {};
  let total = 0;
  let count = 0;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      if (count > MAX_WORKSPACE_FILES) throw new Error('workspace_file_limit_exceeded');
      const data = fs.readFileSync(absolute);
      total += data.byteLength;
      if (total > MAX_WORKSPACE_BYTES) throw new Error('workspace_size_limit_exceeded');
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      result[relative] = { data: data.toString('base64'), mode: fs.statSync(absolute).mode & 0o777 };
    }
  };
  walk(root);
  return result;
};

export class MulticaHttpBridgeServer {
  private server: http.Server | null = null;
  private metadataPath = '';

  constructor(private readonly userDataPath: string) {}

  get running(): boolean {
    return Boolean(this.server?.listening);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const host = process.env.JUSTDO_MULTICA_HTTP_HOST?.trim() || '127.0.0.1';
    const configuredPort = Number(process.env.JUSTDO_MULTICA_HTTP_PORT || DEFAULT_PORT);
    const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
      ? configuredPort
      : DEFAULT_PORT;
    const configuredToken = process.env.JUSTDO_MULTICA_HTTP_TOKEN?.trim();
    if (!isLoopbackHost(host) && !configuredToken) {
      throw new Error('JUSTDO_MULTICA_HTTP_TOKEN is required for non-loopback HTTP access.');
    }
    const token = configuredToken || crypto.randomBytes(32).toString('base64url');
    const bridgeDir = path.join(this.userDataPath, 'multica');
    fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
    this.metadataPath = path.join(bridgeDir, 'http-bridge.json');
    const server = http.createServer((request, response) => {
      void this.handle(request, response, token);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const metadata: MulticaHttpBridgeMetadata = {
      version: 1,
      host,
      port,
      token,
      pid: process.pid,
    };
    fs.writeFileSync(this.metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    console.info(`[MulticaHttpBridge] Listening on ${host}:${port}.`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (this.metadataPath) fs.rmSync(this.metadataPath, { force: true });
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    token: string,
  ): Promise<void> {
    if (request.method === 'GET' && request.url === '/v1/health') {
      jsonResponse(response, 200, { status: 'ok', product: PRODUCT_NAME, protocol: 1 });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/invoke') {
      jsonResponse(response, 404, { error: 'not_found' });
      return;
    }
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    const authenticated = supplied.length === token.length && crypto.timingSafeEqual(
      Buffer.from(supplied), Buffer.from(token),
    );
    if (!authenticated) {
      jsonResponse(response, 401, { error: 'unauthorized' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const raw of request) {
        const chunk = Buffer.from(raw);
        size += chunk.byteLength;
        if (size > MAX_BODY_BYTES) throw new Error('request_too_large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HttpInvocationBody;
      const argv = Array.isArray(body.argv) && body.argv.every(value => typeof value === 'string')
        ? body.argv as string[]
        : [];
      if (!parseMulticaBridgeArgv([PRODUCT_NAME, ...argv], true)) {
        jsonResponse(response, 400, { error: 'unsupported_command' });
        return;
      }
      const requestedCwd = typeof body.cwd === 'string' && path.isAbsolute(body.cwd)
        ? body.cwd
        : this.userDataPath;
      const env: Record<string, string> = body.env && typeof body.env === 'object' && !Array.isArray(body.env)
        ? sanitizeMulticaBridgeEnvironment(body.env as NodeJS.ProcessEnv)
        : {};
      if (body.workspaceFiles) {
        const transferRoot = path.join(
          this.userDataPath,
          'multica',
          'http-workspaces',
          crypto.randomUUID(),
        );
        fs.mkdirSync(transferRoot, { recursive: true, mode: 0o700 });
        try {
          writeTransferredWorkspace(transferRoot, body.workspaceFiles);
          if (typeof body.configContent === 'string' && body.configContent) {
            const config = JSON.parse(body.configContent) as unknown;
            const remoteConfig = path.join(transferRoot, '.agent-eval', 'openclaw.json');
            fs.mkdirSync(path.dirname(remoteConfig), { recursive: true });
            fs.writeFileSync(
              remoteConfig,
              JSON.stringify(rewritePathStrings(config, requestedCwd, transferRoot)),
              { mode: 0o600 },
            );
            env.OPENCLAW_CONFIG_PATH = remoteConfig;
          }
          env.OPENCLAW_STATE_DIR = path.join(transferRoot, '.agent-eval', 'openclaw-state');
          fs.mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
          for (const name of ['OPENCLAW_INCLUDE_ROOTS', 'AGENT_EVAL_ARTIFACT_DIR']) {
            if (env[name]) env[name] = env[name].replaceAll(requestedCwd, transferRoot);
          }
          const result = await invokeMulticaBridge(this.userDataPath, argv, {
            cwd: transferRoot,
            env,
          });
          jsonResponse(response, 200, {
            ...result,
            workspaceFiles: readTransferredWorkspace(transferRoot),
          });
        } finally {
          fs.rmSync(transferRoot, { recursive: true, force: true });
        }
        return;
      }
      const result = await invokeMulticaBridge(this.userDataPath, argv, { cwd: requestedCwd, env });
      jsonResponse(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request_failed';
      jsonResponse(response, message === 'request_too_large' ? 413 : 500, { error: message });
    }
  }
}
