import crypto from 'crypto';

const PROVIDER_PREFIX = 'agent_eval_';
const MANAGED_BY = 'agent-eval-multica';

type AppConfig = Record<string, unknown> & {
  providers?: Record<string, unknown>;
};

export interface MulticaEvaluationModelInput {
  requestId: string;
  model: string;
  apiBase: string;
  apiKey: string;
  protocol?: string;
}

export interface MulticaEvaluationModelRegistration {
  config: AppConfig;
  providerId: string;
  modelRef: string;
}

const validateInput = (input: MulticaEvaluationModelInput): URL => {
  if (!input.requestId.trim() || !input.model.trim() || !input.apiKey.trim()) {
    throw new Error('The evaluation provider configuration is incomplete.');
  }
  if (input.protocol && input.protocol !== 'openai_compatible') {
    throw new Error(`JustDo does not support evaluation provider protocol "${input.protocol}".`);
  }
  let url: URL;
  try {
    url = new URL(input.apiBase.trim());
  } catch {
    throw new Error('The evaluation provider base URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The evaluation provider base URL must be an HTTP(S) URL without credentials.');
  }
  return url;
};

export function addMulticaEvaluationModel(
  current: AppConfig,
  input: MulticaEvaluationModelInput,
): MulticaEvaluationModelRegistration {
  const url = validateInput(input);
  const model = input.model.trim();
  const providerId = `${PROVIDER_PREFIX}${crypto
    .createHash('sha256')
    .update(input.requestId.trim())
    .digest('hex')
    .slice(0, 16)}`;
  return {
    config: {
      ...current,
      providers: {
        ...(current.providers ?? {}),
        [providerId]: {
          enabled: true,
          apiKey: input.apiKey.trim(),
          baseUrl: url.toString().replace(/\/$/, ''),
          apiFormat: 'openai',
          // Unknown provider displayName values become the OpenClaw provider ID.
          // Keep it equal to the map key so sessions.patch resolves this exact ref.
          displayName: providerId,
          models: [{ id: model, name: model, supportsImage: false }],
          managedBy: MANAGED_BY,
          createdAt: Date.now(),
        },
      },
    },
    providerId,
    modelRef: `${providerId}/${model}`,
  };
}

export function removeMulticaEvaluationModel(
  current: AppConfig,
  providerId: string,
): AppConfig {
  const providers = { ...(current.providers ?? {}) };
  const provider = providers[providerId];
  if (
    provider &&
    typeof provider === 'object' &&
    !Array.isArray(provider) &&
    (provider as { managedBy?: unknown }).managedBy === MANAGED_BY
  ) {
    delete providers[providerId];
  }
  return { ...current, providers };
}

export function removeAllMulticaEvaluationModels(current: AppConfig): AppConfig {
  const providers = { ...(current.providers ?? {}) };
  for (const [providerId, provider] of Object.entries(providers)) {
    if (
      providerId.startsWith(PROVIDER_PREFIX) &&
      provider &&
      typeof provider === 'object' &&
      !Array.isArray(provider) &&
      (provider as { managedBy?: unknown }).managedBy === MANAGED_BY
    ) {
      delete providers[providerId];
    }
  }
  return { ...current, providers };
}
