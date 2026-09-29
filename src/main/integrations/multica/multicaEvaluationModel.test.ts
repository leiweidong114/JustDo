import { describe, expect, test } from 'vitest';

import {
  addMulticaEvaluationModel,
  removeAllMulticaEvaluationModels,
  removeMulticaEvaluationModel,
  removeMulticaEvaluationModels,
} from './multicaEvaluationModel';

describe('Multica evaluation model provisioning', () => {
  test('adds and removes a request-scoped OpenAI-compatible provider', () => {
    const existing = { providers: { configured: { enabled: true, models: [] } } };
    const registration = addMulticaEvaluationModel(existing, {
      requestId: 'evaluation-1',
      model: 'glm-4.5-air',
      apiBase: 'http://127.0.0.1:4000/v1/',
      apiKey: 'run-scoped-key',
      protocol: 'openai_compatible',
    });

    expect(registration.modelRef).toBe(`${registration.providerId}/glm-4.5-air`);
    expect(registration.config.providers?.configured).toEqual(existing.providers.configured);
    expect(registration.config.providers?.[registration.providerId]).toEqual(
      expect.objectContaining({
        enabled: true,
        apiKey: 'run-scoped-key',
        baseUrl: 'http://127.0.0.1:4000/v1',
        displayName: registration.providerId,
        managedBy: 'agent-eval-multica',
        models: [{ id: 'glm-4.5-air', name: 'glm-4.5-air', supportsImage: false }],
      }),
    );

    const cleaned = removeMulticaEvaluationModel(registration.config, registration.providerId);
    expect(cleaned.providers).toEqual(existing.providers);

    const restarted = removeAllMulticaEvaluationModels(registration.config);
    expect(restarted.providers).toEqual(existing.providers);
  });

  test('rejects unsupported protocols and credential-bearing URLs', () => {
    expect(() =>
      addMulticaEvaluationModel(
        {},
        {
          requestId: 'evaluation-1',
          model: 'model',
          apiBase: 'https://user:password@example.com/v1',
          apiKey: 'key',
        },
      ),
    ).toThrow('without credentials');
    expect(() =>
      addMulticaEvaluationModel(
        {},
        {
          requestId: 'evaluation-1',
          model: 'model',
          apiBase: 'https://example.com/v1',
          apiKey: 'key',
          protocol: 'anthropic_messages',
        },
      ),
    ).toThrow('does not support');
  });

  test('removes multiple request-scoped providers in one config update', () => {
    const config = {
      providers: {
        configured: { enabled: true },
        agent_eval_one: { managedBy: 'agent-eval-multica' },
        agent_eval_two: { managedBy: 'agent-eval-multica' },
      },
    };

    expect(
      removeMulticaEvaluationModels(config, ['agent_eval_one', 'agent_eval_two']).providers,
    ).toEqual({ configured: { enabled: true } });
  });
});
