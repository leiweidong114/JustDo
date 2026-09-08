export type MulticaModelDiscoveryKind = 'config' | 'registry';

interface ProjectableJustDoAgent {
  id: string;
  name: string;
  model: string;
  enabled: boolean;
}

const CONFIG_DISCOVERY_ARGV = ['config', 'get', 'agents.list', '--json'] as const;
const REGISTRY_DISCOVERY_ARGV = ['agents', 'list', '--json'] as const;
const matchesArgv = (argv: readonly string[], expected: readonly string[]): boolean =>
  argv.length === expected.length && argv.every((value, index) => value === expected[index]);

export function getMulticaModelDiscoveryKind(
  argv: readonly string[],
): MulticaModelDiscoveryKind | null {
  if (matchesArgv(argv, CONFIG_DISCOVERY_ARGV)) return 'config';
  if (matchesArgv(argv, REGISTRY_DISCOVERY_ARGV)) return 'registry';
  return null;
}

export function projectMulticaAgentCatalog(
  agents: readonly ProjectableJustDoAgent[],
  kind: MulticaModelDiscoveryKind,
): string {
  const visibleAgents = agents.filter(
    agent => agent.enabled && agent.id.trim() && agent.id !== 'justdo-scheduler',
  );
  const entries = visibleAgents.map(agent =>
    kind === 'config'
      ? {
          id: agent.id,
          model: { primary: agent.model },
          identity: { name: agent.name },
        }
      : {
          id: agent.id,
          name: agent.name,
          model: agent.model,
        },
  );
  return `${JSON.stringify(entries, null, 2)}\n`;
}
