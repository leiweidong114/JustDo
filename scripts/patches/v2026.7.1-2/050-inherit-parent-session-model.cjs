'use strict';

// Capability: native sessions_spawn inherits the requester's run-scoped session model.
// Target: pristine openclaw@2026.7.1-2 after JustDo patch 026 adds parent session lookup.
// Scope: same-agent native children without an explicit model; ACP and explicit overrides are unchanged.
// Safety: only validated persisted provider/model strings are inherited; target-agent policy stays authoritative.
// Remove when: upstream native subagents inherit the effective parent session model by default.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_INHERIT_PARENT_SESSION_MODEL_2026_7_1';
const PARENT_DECLARATION = 'let justDoParentSessionId;';
const PATCHED_PARENT_DECLARATION = `// ${CONTRACT}
  let justDoParentSessionId;
  let justDoParentSessionModel;`;
const PARENT_ID_BLOCK = `if (typeof justDoParentEntry?.sessionId === "string" && justDoParentEntry.sessionId.trim()) {
      justDoParentSessionId = justDoParentEntry.sessionId.trim();
    }`;
const PATCHED_PARENT_ID_BLOCK = `${PARENT_ID_BLOCK}
    const justDoParentProvider = typeof justDoParentEntry?.providerOverride === "string"
      ? justDoParentEntry.providerOverride.trim()
      : "";
    const justDoParentModel = typeof justDoParentEntry?.modelOverride === "string"
      ? justDoParentEntry.modelOverride.trim()
      : "";
    if (justDoParentModel) {
      justDoParentSessionModel = justDoParentProvider
        ? \`\${justDoParentProvider}/\${justDoParentModel}\`
        : justDoParentModel;
    }`;
const PLAN_PATTERN = /const plan = resolveSubagentModelAndThinkingPlan\(\{\r?\n([ \t]*)cfg,\r?\n\1targetAgentId,\r?\n\1requesterAgentConfig: resolveAgentConfig\(cfg, requesterAgentId\),\r?\n\1targetAgentConfig: resolveAgentConfig\(cfg, targetAgentId\),\r?\n\1modelOverride,/;

const MARKERS = [
  'let justDoParentSessionModel;',
  'typeof justDoParentEntry?.providerOverride === "string"',
  'typeof justDoParentEntry?.modelOverride === "string"',
  'targetAgentId === requesterAgentId ? justDoParentSessionModel : void 0',
];

function expectedCopies(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
}

function applyPatch(runtimeDir) {
  const expected = expectedCopies(runtimeDir);
  const files = findFilesContaining(runtimeDir, [
    'async function spawnSubagentDirect(params, ctx) {',
    'const justDoParentTarget = resolveGatewaySessionStoreTarget({ cfg, key: spawnedByKey });',
    'const plan = resolveSubagentModelAndThinkingPlan({',
  ]);
  if (files.length !== expected) {
    throw new Error(`parent session model inheritance target count is ${files.length}, expected ${expected}`);
  }

  const staged = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    const presentMarkers = MARKERS.filter(marker => original.includes(marker));
    if (presentMarkers.length > 0 && presentMarkers.length !== MARKERS.length) {
      throw new Error(
        `parent session model inheritance rejected a partial artifact (${presentMarkers.length}/${MARKERS.length} markers): ${filePath}`,
      );
    }
    if (presentMarkers.length === MARKERS.length) {
      return { filePath, original, updated: original };
    }

    let updated = replaceUnique(
      original,
      PARENT_DECLARATION,
      PATCHED_PARENT_DECLARATION,
      'parent session model declaration',
    );
    updated = replaceUnique(
      updated,
      PARENT_ID_BLOCK,
      PATCHED_PARENT_ID_BLOCK,
      'parent session model lookup',
    );
    updated = replaceUniquePattern(
      updated,
      PLAN_PATTERN,
      (_match, indent) => `const plan = resolveSubagentModelAndThinkingPlan({
${indent}cfg,
${indent}targetAgentId,
${indent}requesterAgentConfig: resolveAgentConfig(cfg, requesterAgentId),
${indent}targetAgentConfig: resolveAgentConfig(cfg, targetAgentId),
${indent}modelOverride: modelOverride ?? (targetAgentId === requesterAgentId ? justDoParentSessionModel : void 0),`,
      'parent session model plan',
    );
    return { filePath, original, updated };
  });

  const changed = [];
  for (const { filePath, original, updated } of staged) {
    if (writeIfChanged(filePath, original, updated)) {
      changed.push(path.relative(runtimeDir, filePath));
    }
  }
  return changed.sort();
}

function verifyPatch(runtimeDir) {
  const expected = expectedCopies(runtimeDir);
  const files = findFilesContaining(runtimeDir, MARKERS);
  if (files.length !== expected) {
    throw new Error('parent session model inheritance targets are incomplete');
  }
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const marker of MARKERS) {
      if (countOccurrences(content, marker) !== 1) {
        throw new Error(`parent session model inheritance marker is ambiguous: ${marker}`);
      }
    }
    if (content.includes('modelOverride: justDoParentSessionModel ?? modelOverride')) {
      throw new Error(`explicit sessions_spawn model no longer has precedence: ${filePath}`);
    }
  }
}

module.exports = { applyPatch, verifyPatch };
