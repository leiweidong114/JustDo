import type Database from 'better-sqlite3';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import type { ExternalSessionStatus } from '../../../shared/multica';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawChannelSessionSync';
import {
  decodeBridgeLines,
  encodeBridgeMessage,
  getMulticaBridgeEndpoint,
  MULTICA_BRIDGE_METADATA_FILE,
  MULTICA_BRIDGE_PROTOCOL_VERSION,
  type MulticaBridgeMetadata,
  type MulticaBridgeRequest,
  type MulticaBridgeResponse,
  parseMulticaBridgeArgv,
  sanitizeMulticaBridgeEnvironment,
} from './multicaBridgeProtocol';
import {
  MulticaExternalSessionStore,
  rewriteMulticaAgentSessionArgs,
} from './multicaExternalSessions';
import { getMulticaModelDiscoveryKind, projectMulticaAgentCatalog } from './multicaModelProjection';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_STDOUT_CAPTURE_BYTES = 4 * 1024 * 1024;
const OPENCLAW_TIMEOUT_GRACE_MS = 250;
const BUNDLED_RUNTIME_VERSION_PATTERN = /\b(20\d{2}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const LOG_PREFIX = '[MulticaBridge]';

const describeBridgeArgv = (
  argv: readonly string[],
): { command: string; argumentCount: number; messageBytes: number } => {
  const messageIndex = argv.indexOf('--message');
  return {
    command: argv[0] ?? 'unknown',
    argumentCount: argv.length,
    messageBytes:
      messageIndex >= 0 && typeof argv[messageIndex + 1] === 'string'
        ? Buffer.byteLength(argv[messageIndex + 1], 'utf8')
        : 0,
  };
};

export function normalizeMulticaVersionProbeOutput(stdout: string): string | null {
  const version = stdout.match(BUNDLED_RUNTIME_VERSION_PATTERN)?.[1];
  return version ? `${PRODUCT_NAME} ${version}\n` : null;
}

export function resolveMulticaEvaluationModelRef(
  database: Database.Database,
  requestedModel: string,
): string {
  const normalized = requestedModel.trim();
  if (!normalized) throw new Error('The evaluation model is empty.');

  const row = database.prepare("SELECT value FROM kv WHERE key = 'app_config'").get() as
    { value?: string } | undefined;
  let config: Record<string, unknown> = {};
  try {
    config = row?.value ? (JSON.parse(row.value) as Record<string, unknown>) : {};
  } catch {
    throw new Error('JustDo model configuration is invalid.');
  }
  const providers =
    config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
      ? (config.providers as Record<string, unknown>)
      : {};
  const enabledModelRefs: string[] = [];
  for (const [providerId, candidate] of Object.entries(providers)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const provider = candidate as { enabled?: boolean; models?: unknown[] };
    if (provider.enabled === false || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
      const entry = model as { id?: unknown; enabled?: boolean };
      if (entry.enabled !== false && typeof entry.id === 'string' && entry.id.trim()) {
        enabledModelRefs.push(`${providerId}/${entry.id.trim()}`);
      }
    }
  }
  if (normalized.includes('/')) {
    if (enabledModelRefs.includes(normalized)) return normalized;
    throw new Error(
      `Model "${normalized}" is not enabled in JustDo. Configure it in JustDo before running the evaluation.`,
    );
  }
  const matches = enabledModelRefs.filter(
    modelRef => modelRef.slice(modelRef.indexOf('/') + 1) === normalized,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `Model "${normalized}" is not enabled in JustDo. Configure it in JustDo before running the evaluation.`,
    );
  }
  throw new Error(
    `Model "${normalized}" exists under multiple JustDo providers. Pass a provider-qualified model such as "${matches[0]}".`,
  );
}

export const classifyMulticaRunStatus = (input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
  resolved: boolean;
}): ExternalSessionStatus => {
  const terminalTimeout =
    /(?:\b(?:agent|request|operation|command)\s+timed out\b|\btimed out after\b|context deadline exceeded)/i.test(
      input.stderr,
    );
  if (input.timedOut || terminalTimeout) return 'timeout';
  if (input.signal) return 'cancelled';
  return input.code === 0 && input.resolved ? 'completed' : 'error';
};

const readTimeoutMs = (argv: readonly string[]): number | null => {
  const index = argv.indexOf('--timeout');
  if (index < 0) return null;
  const seconds = Number(argv[index + 1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1_000 + OPENCLAW_TIMEOUT_GRACE_MS, 2_147_483_647);
};

export interface MulticaBridgeServerOptions {
  userDataPath: string;
  getEngineManager: () => OpenClawEngineManager;
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  ensureCoworkRuntime: () => Promise<{ phase: string; message?: string }>;
  getDatabase: () => import('better-sqlite3').Database;
  provisionEvaluationModel?: (input: {
    requestId: string;
    model: string;
    apiBase: string;
    apiKey: string;
    protocol?: string;
  }) => Promise<{ providerId: string; modelRef: string }>;
  releaseEvaluationModel?: (providerId: string) => Promise<void>;
  onSessionsChanged: () => void;
}

const writeResponse = (socket: net.Socket, response: MulticaBridgeResponse): void => {
  if (!socket.destroyed) socket.write(encodeBridgeMessage(response));
};

const terminateProcessTree = (child: ChildProcess): void => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => child.kill());
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
};

export class MulticaBridgeServer {
  private server: net.Server | null = null;
  private readonly children = new Set<ChildProcess>();
  private readonly activeCoworkSessions = new Set<string>();
  private token = '';

  constructor(private readonly options: MulticaBridgeServerOptions) {}

  get running(): boolean {
    return Boolean(this.server?.listening);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const bridgeDir = path.join(this.options.userDataPath, 'multica');
    fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(bridgeDir, 0o700);
    } catch {
      // Windows ACLs are inherited from the per-user app-data directory.
    }

    const endpoint = getMulticaBridgeEndpoint(this.options.userDataPath);
    if (process.platform !== 'win32') {
      try {
        fs.rmSync(endpoint, { force: true });
      } catch {
        // listen() below will report a useful error if the stale socket remains.
      }
    }
    this.token = crypto.randomBytes(32).toString('base64url');
    const server = net.createServer(socket => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(endpoint, 0o600);
      } catch {
        // Some file systems do not expose POSIX modes.
      }
    }
    const metadata: MulticaBridgeMetadata = {
      version: MULTICA_BRIDGE_PROTOCOL_VERSION,
      endpoint,
      token: this.token,
      pid: process.pid,
    };
    const metadataPath = path.join(bridgeDir, MULTICA_BRIDGE_METADATA_FILE);
    const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, metadataPath);
    try {
      fs.chmodSync(metadataPath, 0o600);
    } catch {
      // Windows ACLs are inherited from the per-user app-data directory.
    }
    console.log(`${LOG_PREFIX} Relay is ready.`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const child of this.children) terminateProcessTree(child);
    this.children.clear();
    await Promise.allSettled(
      [...this.activeCoworkSessions].map(sessionId =>
        this.options.getCoworkEngineRouter().stopSession(sessionId, { bestEffort: true }),
      ),
    );
    this.activeCoworkSessions.clear();
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const bridgeDir = path.join(this.options.userDataPath, 'multica');
    fs.rmSync(path.join(bridgeDir, MULTICA_BRIDGE_METADATA_FILE), { force: true });
    if (process.platform !== 'win32') {
      fs.rmSync(getMulticaBridgeEndpoint(this.options.userDataPath), { force: true });
    }
  }

  private accept(socket: net.Socket): void {
    let buffer = '';
    let started = false;
    let child: ChildProcess | null = null;
    socket.on('data', chunk => {
      if (started) return;
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        writeResponse(socket, { type: 'error', message: 'Bridge request is too large.' });
        socket.end();
        return;
      }
      let decoded: ReturnType<typeof decodeBridgeLines>;
      try {
        decoded = decodeBridgeLines(buffer);
      } catch {
        writeResponse(socket, { type: 'error', message: 'Bridge request is invalid.' });
        socket.end();
        return;
      }
      buffer = decoded.remainder;
      if (decoded.messages.length === 0) return;
      started = true;
      void this.runRequest(decoded.messages[0] as MulticaBridgeRequest, socket).then(value => {
        child = value;
      });
    });
    socket.once('close', () => {
      if (child) terminateProcessTree(child);
    });
  }

  private async runRequest(
    request: MulticaBridgeRequest,
    socket: net.Socket,
  ): Promise<ChildProcess | null> {
    const argvAllowed =
      Array.isArray(request.argv) &&
      Boolean(parseMulticaBridgeArgv([PRODUCT_NAME, ...request.argv], true));
    if (
      request.type !== 'request' ||
      request.version !== MULTICA_BRIDGE_PROTOCOL_VERSION ||
      request.token !== this.token ||
      !argvAllowed
    ) {
      writeResponse(socket, { type: 'error', message: 'Bridge request was rejected.' });
      console.warn(`${LOG_PREFIX} Rejected a bridge request.`, {
        reason:
          request.type !== 'request'
            ? 'type'
            : request.version !== MULTICA_BRIDGE_PROTOCOL_VERSION
              ? 'version'
              : request.token !== this.token
                ? 'authentication'
                : 'command',
        command: Array.isArray(request.argv) ? (request.argv[0] ?? 'unknown') : 'invalid',
        argumentCount: Array.isArray(request.argv) ? request.argv.length : 0,
      });
      socket.end();
      return null;
    }

    try {
      const requestSummary = describeBridgeArgv(request.argv);
      console.info(`${LOG_PREFIX} Request accepted.`, requestSummary);
      const cwd = path.resolve(request.cwd || this.options.userDataPath);
      if (!fs.statSync(cwd).isDirectory())
        throw new Error('The requested working directory is invalid.');
      const engineManager = this.options.getEngineManager();
      const argv = [...request.argv];
      const versionProbe = argv.length === 1 && argv[0] === '--version';
      const runtimeVersion = versionProbe ? engineManager.getStatus().version : null;
      if (runtimeVersion) {
        writeResponse(socket, {
          type: 'stdout',
          data: Buffer.from(
            `${PRODUCT_NAME} ${runtimeVersion.replace(/^v/, '')}\n`,
            'utf8',
          ).toString('base64'),
        });
        writeResponse(socket, { type: 'exit', code: 0 });
        socket.end();
        console.info(`${LOG_PREFIX} Version probe answered without starting the runtime.`, {
          command: requestSummary.command,
        });
        return null;
      }
      const modelDiscoveryKind = getMulticaModelDiscoveryKind(argv);
      if (modelDiscoveryKind) {
        const output = projectMulticaAgentCatalog(
          this.options.getCoworkStore().listAgents(),
          modelDiscoveryKind,
        );
        writeResponse(socket, {
          type: 'stdout',
          data: Buffer.from(output, 'utf8').toString('base64'),
        });
        writeResponse(socket, { type: 'exit', code: 0 });
        socket.end();
        return null;
      }
      if (argv[0] === 'agent') {
        const requestEnvironment = sanitizeMulticaBridgeEnvironment(request.env || {});
        await this.runCoworkAgentRequest(
          request.requestId,
          argv,
          cwd,
          requestEnvironment,
          socket,
        );
        return null;
      }
      const cli = await engineManager.buildCliEnvironment();
      const bufferedProbe = versionProbe;

      const requestEnvironment = sanitizeMulticaBridgeEnvironment(request.env || {});
      const env: NodeJS.ProcessEnv = {
        ...cli.env,
        ...requestEnvironment,
        ELECTRON_RUN_AS_NODE: '1',
      };
      const executable = env.JUSTDO_ELECTRON_PATH || process.execPath;
      const child = spawn(executable, [cli.openclawEntry, ...argv], {
        cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.info(`${LOG_PREFIX} Runtime process started.`, {
        command: requestSummary.command,
        pid: child.pid ?? null,
      });
      this.children.add(child);
      if (socket.destroyed) terminateProcessTree(child);
      else socket.once('close', () => terminateProcessTree(child));
      let stdoutCapture = Buffer.alloc(0);
      let stderrCapture = Buffer.alloc(0);
      let timedOut = false;
      const timeoutMs = readTimeoutMs(argv);
      const timeoutTimer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            terminateProcessTree(child);
          }, timeoutMs)
        : null;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutCapture = Buffer.concat([stdoutCapture, chunk]);
        if (stdoutCapture.byteLength > MAX_STDOUT_CAPTURE_BYTES) {
          stdoutCapture = stdoutCapture.subarray(
            stdoutCapture.byteLength - MAX_STDOUT_CAPTURE_BYTES,
          );
        }
        if (!bufferedProbe) {
          writeResponse(socket, { type: 'stdout', data: chunk.toString('base64') });
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrCapture = Buffer.concat([stderrCapture, chunk]);
        if (stderrCapture.byteLength > MAX_STDOUT_CAPTURE_BYTES) {
          stderrCapture = stderrCapture.subarray(
            stderrCapture.byteLength - MAX_STDOUT_CAPTURE_BYTES,
          );
        }
        if (!versionProbe) {
          writeResponse(socket, { type: 'stderr', data: chunk.toString('base64') });
        }
      });
      child.once('error', error => {
        console.warn(`${LOG_PREFIX} Runtime process failed to start.`, {
          command: requestSummary.command,
          category: error.name,
        });
        writeResponse(socket, { type: 'error', message: error.message });
      });
      child.once('exit', (code, signal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.children.delete(child);
        let responseCode = typeof code === 'number' ? code : signal ? 130 : 1;
        if (versionProbe) {
          const normalized = normalizeMulticaVersionProbeOutput(stdoutCapture.toString('utf8'));
          const output = normalized ?? stdoutCapture.toString('utf8');
          if (output) {
            writeResponse(socket, {
              type: 'stdout',
              data: Buffer.from(output, 'utf8').toString('base64'),
            });
          }
          if (code !== 0 && stderrCapture.length > 0) {
            writeResponse(socket, {
              type: 'stderr',
              data: stderrCapture.toString('base64'),
            });
          }
        }
        console.info(`${LOG_PREFIX} Runtime process finished.`, {
          command: requestSummary.command,
          code,
          signal,
          timedOut,
          stdoutBytes: stdoutCapture.byteLength,
          stderrBytes: stderrCapture.byteLength,
        });
        writeResponse(socket, {
          type: 'exit',
          code: responseCode,
          ...(signal ? { signal } : {}),
        });
        socket.end();
      });
      return child;
    } catch (error) {
      console.warn(`${LOG_PREFIX} Request failed before runtime completion.`, {
        category: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      });
      writeResponse(socket, {
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : `${PRODUCT_NAME} bridge failed to run the bundled Agent runtime.`,
      });
      socket.end();
      return null;
    }
  }

  private async runCoworkAgentRequest(
    requestId: string,
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    socket: net.Socket,
  ): Promise<void> {
    const promptIndex = argv.indexOf('--message');
    const prompt = promptIndex >= 0 ? (argv[promptIndex + 1] ?? '') : '';
    if (!prompt.trim()) throw new Error('Multica agent request is missing a message.');

    const agentIndex = argv.indexOf('--agent');
    const agentId = agentIndex >= 0 ? argv[agentIndex + 1]?.trim() || 'main' : 'main';
    const store = this.options.getCoworkStore();
    const agent = store.getAgent(agentId);
    if (!agent) {
      throw new Error(
        `JustDo Agent "${agentId}" was not found. Configure that Agent in JustDo and pass its ID as Multica's model.`,
      );
    }

    const skillIds = this.discoverWorkspaceSkillIds(cwd);
    const externalStore = new MulticaExternalSessionStore(this.options.getDatabase(), store);
    const rewritten = rewriteMulticaAgentSessionArgs(argv, externalStore, cwd, skillIds);
    if (!rewritten)
      throw new Error('Multica agent request could not be mapped to a JustDo session.');
    const binding = rewritten.binding;
    const sessionKey = buildManagedSessionKey(binding.coworkSessionId, agentId);
    externalStore.updateRun(binding, 'running', binding.coworkSessionId, sessionKey);
    this.options.onSessionsChanged();

    const router = this.options.getCoworkEngineRouter();
    const messageCountBeforeRun = store.getSession(binding.coworkSessionId)?.messages.length ?? 0;
    const startedAt = Date.now();
    let timedOut = false;
    let disconnected = socket.destroyed;
    const stopSession = (): void => {
      void router
        .stopSession(binding.coworkSessionId, { bestEffort: true })
        .catch((): void => undefined);
    };
    const onSocketClose = (): void => {
      disconnected = true;
      stopSession();
    };
    socket.once('close', onSocketClose);
    this.activeCoworkSessions.add(binding.coworkSessionId);

    const timeoutMs = readTimeoutMs(argv);
    let timeoutTimer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      if (!timeoutMs) return;
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stopSession();
        reject(
          new Error(`JustDo agent timed out after ${timeoutMs - OPENCLAW_TIMEOUT_GRACE_MS} ms.`),
        );
      }, timeoutMs);
    });

    let temporaryProviderId: string | null = null;
    try {
      const requestedModel = env.AGENT_EVAL_PROVIDER_MODEL?.trim();
      let modelRef: string | null = null;
      if (requestedModel) {
        const apiBase = env.AGENT_EVAL_PROVIDER_BASE_URL?.trim();
        const apiKey = env.LITELLM_API_KEY?.trim();
        if (apiBase && apiKey && this.options.provisionEvaluationModel) {
          const registration = await this.options.provisionEvaluationModel({
            requestId,
            model: requestedModel,
            apiBase,
            apiKey,
            protocol: env.AGENT_EVAL_PROVIDER_PROTOCOL?.trim(),
          });
          temporaryProviderId = registration.providerId;
          modelRef = registration.modelRef;
        } else {
          // A direct JustDo launcher invocation may intentionally rely on a
          // model already configured by the user. Agent Eval requests always
          // include their authenticated adapter endpoint and must use it even
          // when a same-named model exists in JustDo; otherwise the run can
          // silently bypass LiteLLM/model verification or inherit a stale
          // custom provider reference.
          modelRef = resolveMulticaEvaluationModelRef(
            this.options.getDatabase(),
            requestedModel,
          );
        }
      }

      // Provision the run-scoped provider before starting the Gateway. A stale
      // disabled provider in the previously generated openclaw.json can make
      // the Gateway fail authentication before the evaluation model is ever
      // applied; provisioning first rewrites that config with a usable model.
      const runtimeStatus = await this.options.ensureCoworkRuntime();
      if (runtimeStatus.phase !== 'running') {
        throw new Error(runtimeStatus.message || 'JustDo Cowork runtime is not ready.');
      }

      if (requestedModel && modelRef) {
        const modelResult = await router.patchSessionModel(
          binding.coworkSessionId,
          modelRef,
          agentId,
        );
        if ('error' in modelResult) {
          throw new Error(
            `JustDo could not apply evaluation model "${requestedModel}": ${modelResult.error}`,
          );
        }
      }
      const runPromise = binding.created
        ? router.startSession(binding.coworkSessionId, prompt, {
            skillIds,
            confirmationMode: 'modal',
            workspaceRoot: cwd,
            agentId,
          })
        : router.continueSession(binding.coworkSessionId, prompt, { skillIds });
      await (timeoutMs ? Promise.race([runPromise, timeoutPromise]) : runPromise);
      if (disconnected) throw new Error('Multica client disconnected from the JustDo session.');

      const session = store.getSession(binding.coworkSessionId);
      const assistant = session?.messages
        .slice(messageCountBeforeRun)
        .filter(message => message.type === 'assistant' && message.content.trim())
        .at(-1);
      if (!assistant) throw new Error('JustDo completed without an assistant response.');

      const result = {
        payloads: [{ text: assistant.content }],
        meta: {
          durationMs: Date.now() - startedAt,
          agentMeta: {
            sessionId: binding.coworkSessionId,
            sessionKey,
            model: assistant.modelName || agent.model,
          },
        },
      };
      writeResponse(socket, {
        type: 'stdout',
        data: Buffer.from(`${JSON.stringify(result)}\n`, 'utf8').toString('base64'),
      });
      externalStore.updateRun(binding, 'completed', binding.coworkSessionId, sessionKey);
      writeResponse(socket, { type: 'exit', code: 0 });
      socket.end();
    } catch (error) {
      if (timedOut || disconnected) {
        await router
          .stopSession(binding.coworkSessionId, { bestEffort: true })
          .catch((): void => undefined);
      }
      externalStore.updateRun(
        binding,
        timedOut ? 'timeout' : disconnected ? 'cancelled' : 'error',
        binding.coworkSessionId,
        sessionKey,
      );
      throw error;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      socket.off('close', onSocketClose);
      this.activeCoworkSessions.delete(binding.coworkSessionId);
      this.options.onSessionsChanged();
      if (temporaryProviderId && this.options.releaseEvaluationModel) {
        await this.options.releaseEvaluationModel(temporaryProviderId).catch(error => {
          console.warn(`${LOG_PREFIX} Failed to clean up a temporary evaluation model.`, {
            category: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
          });
        });
      }
    }
  }

  private discoverWorkspaceSkillIds(cwd: string): string[] {
    const skillsDirectory = path.join(cwd, 'skills');
    try {
      return fs
        .readdirSync(skillsDirectory, { withFileTypes: true })
        .filter(
          entry =>
            entry.isDirectory() &&
            fs.existsSync(path.join(skillsDirectory, entry.name, 'SKILL.md')),
        )
        .map(entry => entry.name)
        .sort();
    } catch {
      return [];
    }
  }
}
