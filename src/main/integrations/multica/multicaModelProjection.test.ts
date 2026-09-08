import { describe, expect, test } from 'vitest';

import { getMulticaModelDiscoveryKind, projectMulticaAgentCatalog } from './multicaModelProjection';

const agents = [
  {
    id: 'main',
    name: 'Main Agent',
    model: 'custom0/deepseek-v4-flash',
    enabled: true,
  },
  {
    id: 'research',
    name: 'Research Agent',
    model: 'nvidia/minimaxai/minimax-m3',
    enabled: true,
  },
  { id: 'disabled', name: 'Disabled', model: 'provider/disabled', enabled: false },
  { id: 'justdo-scheduler', name: 'Scheduler', model: 'provider/internal', enabled: true },
];

describe('Multica model projection', () => {
  test('recognizes only the two model-discovery command shapes', () => {
    expect(getMulticaModelDiscoveryKind(['config', 'get', 'agents.list', '--json'])).toBe('config');
    expect(getMulticaModelDiscoveryKind(['agents', 'list', '--json'])).toBe('registry');
    expect(
      getMulticaModelDiscoveryKind(['config', 'get', 'models.providers', '--json']),
    ).toBeNull();
  });

  test('projects enabled JustDo Agents without exposing managed internal agents', () => {
    const configEntries = JSON.parse(projectMulticaAgentCatalog(agents, 'config')) as Array<{
      id: string;
      model: { primary: string };
      identity: { name: string };
    }>;
    const registryEntries = JSON.parse(projectMulticaAgentCatalog(agents, 'registry')) as Array<{
      id: string;
      name: string;
      model: string;
    }>;

    expect(configEntries).toHaveLength(2);
    expect(configEntries.map(entry => entry.id)).toEqual(['main', 'research']);
    expect(configEntries.map(entry => entry.model.primary)).toEqual([
      'custom0/deepseek-v4-flash',
      'nvidia/minimaxai/minimax-m3',
    ]);
    expect(configEntries[0]).toMatchObject({ identity: { name: 'Main Agent' } });
    expect(configEntries.some(entry => 'default' in entry)).toBe(false);
    expect(registryEntries.map(entry => entry.name)).toEqual(['Main Agent', 'Research Agent']);
    expect(JSON.stringify({ configEntries, registryEntries })).not.toMatch(/scheduler|disabled/i);
  });
});
