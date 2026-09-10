import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/050-inherit-parent-session-model.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
  };

const temporaryRoots: string[] = [];

const FIXTURE_SOURCE = `
function resolveGatewaySessionStoreTarget() { return { storePath: "session.json", storeKeys: ["parent"] }; }
function loadSessionStore() { return { parent: globalThis.parentEntry }; }
function resolveStoreEntryByKeys(store, keys) { return store[keys[0]]; }
function resolveAgentConfig() { return {}; }
function resolveSubagentModelAndThinkingPlan(value) { return value; }
async function spawnSubagentDirect(params, ctx) {
  const cfg = {};
  const requesterAgentId = ctx.requesterAgentId;
  const targetAgentId = params.targetAgentId ?? requesterAgentId;
  const modelOverride = params.model;
  const spawnedByKey = ctx.agentSessionKey;
  // justdo-parent-session-identity: bind lineage to the parent generation visible at spawn admission.
  let justDoParentSessionId;
  try {
    const justDoParentTarget = resolveGatewaySessionStoreTarget({ cfg, key: spawnedByKey });
    const justDoParentEntry = resolveStoreEntryByKeys(
      loadSessionStore(justDoParentTarget.storePath, { clone: false }),
      justDoParentTarget.storeKeys
    );
    if (typeof justDoParentEntry?.sessionId === "string" && justDoParentEntry.sessionId.trim()) {
      justDoParentSessionId = justDoParentEntry.sessionId.trim();
    }
  } catch {}
  const plan = resolveSubagentModelAndThinkingPlan({
    cfg,
    targetAgentId,
    requesterAgentConfig: resolveAgentConfig(cfg, requesterAgentId),
    targetAgentConfig: resolveAgentConfig(cfg, targetAgentId),
    modelOverride,
    thinkingOverrideRaw: params.thinking
  });
  return { modelOverride: plan.modelOverride, parentSessionId: justDoParentSessionId };
}
module.exports = { spawnSubagentDirect };
`;

function createRuntime(bundle = false): { root: string; sourcePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-parent-model-'));
  temporaryRoots.push(root);
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const sourcePath = path.join(distDir, 'openclaw-tools.js');
  fs.writeFileSync(sourcePath, FIXTURE_SOURCE, 'utf8');
  if (bundle) fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), FIXTURE_SOURCE, 'utf8');
  return { root, sourcePath };
}

function loadRuntime(sourcePath: string): {
  spawnSubagentDirect: (
    params: { model?: string; targetAgentId?: string },
    ctx: { requesterAgentId: string; agentSessionKey: string },
  ) => Promise<{ modelOverride?: string; parentSessionId?: string }>;
} {
  const fixtureModule = { exports: {} } as {
    exports: {
      spawnSubagentDirect: (
        params: { model?: string; targetAgentId?: string },
        ctx: { requesterAgentId: string; agentSessionKey: string },
      ) => Promise<{ modelOverride?: string; parentSessionId?: string }>;
    };
  };
  const loadFixture = new Function('module', 'exports', fs.readFileSync(sourcePath, 'utf8'));
  loadFixture(fixtureModule, fixtureModule.exports);
  return fixtureModule.exports;
}

afterEach(() => {
  delete (globalThis as { parentEntry?: unknown }).parentEntry;
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenClaw v2026.7.1-2 parent session model inheritance', () => {
  test('inherits the persisted parent model for a same-agent native child', async () => {
    const { root, sourcePath } = createRuntime();
    patch.applyPatch(root);
    patch.verifyPatch(root);
    (globalThis as { parentEntry?: unknown }).parentEntry = {
      sessionId: 'parent-id',
      providerOverride: 'agent_eval_temporary',
      modelOverride: 'oc/big-pickle',
    };

    await expect(
      loadRuntime(sourcePath).spawnSubagentDirect(
        {},
        { requesterAgentId: 'main', agentSessionKey: 'agent:main:justdo:run' },
      ),
    ).resolves.toEqual({
      modelOverride: 'agent_eval_temporary/oc/big-pickle',
      parentSessionId: 'parent-id',
    });
  });

  test('keeps explicit model precedence and does not override a different target agent', async () => {
    const { root, sourcePath } = createRuntime();
    patch.applyPatch(root);
    (globalThis as { parentEntry?: unknown }).parentEntry = {
      providerOverride: 'run-provider',
      modelOverride: 'run-model',
    };
    const runtime = loadRuntime(sourcePath);

    await expect(
      runtime.spawnSubagentDirect(
        { model: 'explicit/model' },
        { requesterAgentId: 'main', agentSessionKey: 'parent' },
      ),
    ).resolves.toMatchObject({ modelOverride: 'explicit/model' });
    await expect(
      runtime.spawnSubagentDirect(
        { targetAgentId: 'research' },
        { requesterAgentId: 'main', agentSessionKey: 'parent' },
      ),
    ).resolves.toMatchObject({ modelOverride: undefined });
  });

  test('patches source and bundle atomically and is byte-stable', () => {
    const { root, sourcePath } = createRuntime(true);
    expect(patch.applyPatch(root)).toEqual([
      path.join('dist', 'openclaw-tools.js'),
      'gateway-bundle.mjs',
    ]);
    patch.verifyPatch(root);
    const once = fs.readFileSync(sourcePath);
    expect(patch.applyPatch(root)).toEqual([]);
    expect(fs.readFileSync(sourcePath)).toEqual(once);
  });

  test('rejects partial and ambiguous artifacts', () => {
    const partial = createRuntime();
    fs.appendFileSync(partial.sourcePath, '\nlet justDoParentSessionModel;\n');
    expect(() => patch.applyPatch(partial.root)).toThrow(/partial artifact/);

    const ambiguous = createRuntime();
    fs.appendFileSync(ambiguous.sourcePath, `\n${FIXTURE_SOURCE}\n`);
    expect(() => patch.applyPatch(ambiguous.root)).toThrow(/anchor count is 2/);
  });
});
