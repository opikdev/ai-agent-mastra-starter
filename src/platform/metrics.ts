import { metrics } from '@opentelemetry/api';
import { project } from './project.ts';

/**
 * Run and token metrics, named after the OpenTelemetry GenAI semantic conventions where they
 * have one. With no meter provider registered, which is when telemetry is off, they do nothing.
 */
export function createRunMetrics(model: string) {
  const meter = metrics.getMeter(project.name, project.version);
  const tokens = meter.createHistogram('gen_ai.client.token.usage', {
    unit: '{token}',
    description: 'Tokens per model call, by type',
  });
  const duration = meter.createHistogram('agent.run.duration', {
    unit: 's',
    description: 'How long each run streamed, by its final status',
  });
  const [provider = 'unknown', ...name] = model.split('/');
  const base = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': provider,
    'gen_ai.request.model': name.join('/'),
  };

  return {
    tokens(role: 'agent' | 'guardrail', input: number, output: number) {
      const attributes = { ...base, 'agent.model.role': role };
      if (input > 0) tokens.record(input, { ...attributes, 'gen_ai.token.type': 'input' });
      if (output > 0) tokens.record(output, { ...attributes, 'gen_ai.token.type': 'output' });
    },
    run(status: string, reason: string | null, seconds: number) {
      duration.record(seconds, {
        'agent.run.status': status,
        ...(reason ? { 'agent.run.stop_reason': reason } : {}),
      });
    },
  };
}

export type RunMetrics = ReturnType<typeof createRunMetrics>;
