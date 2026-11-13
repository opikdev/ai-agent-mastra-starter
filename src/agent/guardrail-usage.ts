import {
  type MastraModelConfig,
  ModelRouterLanguageModel,
  type ModelRouterModelId,
} from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import type { Usage } from './budget.ts';
import { type GuardrailMonitor, guardrailMonitorKey } from './context.ts';

type ModelStream = Awaited<ReturnType<ModelRouterLanguageModel['doGenerate']>>['stream'];

// The router types usage as AI SDK v2 numbers, but passes on the provider's v3 objects.
type TokenCount =
  | number
  | { total?: number | undefined; cacheRead?: number | undefined; cacheWrite?: number | undefined }
  | undefined;

function count(value: TokenCount, field: 'total' | 'cacheRead' | 'cacheWrite'): number {
  if (typeof value === 'number') return field === 'total' ? value : 0;
  return value?.[field] ?? 0;
}

export function usageOf(usage: { inputTokens?: TokenCount; outputTokens?: TokenCount }): Usage {
  return {
    inputTokens: count(usage.inputTokens, 'total'),
    outputTokens: count(usage.outputTokens, 'total'),
    cacheReadInputTokens: count(usage.inputTokens, 'cacheRead'),
    cacheWriteInputTokens: count(usage.inputTokens, 'cacheWrite'),
  };
}

/**
 * Drops the request and response bodies an AI SDK error carries, which hold the user's message,
 * because Mastra prints the detector's errors to the console.
 */
function scrub(error: unknown): unknown {
  if (error instanceof Error) {
    for (const field of ['requestBodyValues', 'responseBody', 'data']) {
      if (field in error) Object.assign(error, { [field]: undefined });
    }
  }
  return error;
}

function counted(stream: ModelStream, monitor: GuardrailMonitor): ModelStream {
  return stream.pipeThrough(
    new TransformStream({
      transform(part, controller) {
        if (part.type === 'finish') monitor.record(usageOf(part.usage));
        if (part.type === 'error') monitor.failed(scrub(part.error));
        controller.enqueue(part);
      },
    }),
  );
}

/** Mastra's model for an ID, reporting each call's tokens and failures to one run's monitor. */
class MonitoredModel extends ModelRouterLanguageModel {
  readonly #monitor: GuardrailMonitor;

  constructor(id: ModelRouterModelId, monitor: GuardrailMonitor) {
    super(id);
    this.#monitor = monitor;
  }

  async #watch<T extends { stream: ModelStream }>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      return { ...result, stream: counted(result.stream, this.#monitor) };
    } catch (error) {
      this.#monitor.failed(scrub(error));
      throw error;
    }
  }

  override doGenerate(options: Parameters<ModelRouterLanguageModel['doGenerate']>[0]) {
    return this.#watch(() => super.doGenerate(options));
  }

  override doStream(options: Parameters<ModelRouterLanguageModel['doStream']>[0]) {
    return this.#watch(() => super.doStream(options));
  }
}

/**
 * The guardrail's model, resolved per run. Mastra drops the guardrail's usage and doesn't say
 * when its call failed, so each call reports both to the monitor in that run's request context.
 * Runs without one, such as evals, use the plain model.
 */
export function monitoredGuardrailModel(id: string): MastraModelConfig {
  const model = ({ requestContext }: { requestContext: RequestContext }) => {
    const monitor = requestContext.get(guardrailMonitorKey) as GuardrailMonitor | undefined;
    return monitor ? new MonitoredModel(id as ModelRouterModelId, monitor) : id;
  };
  // The detector's options type leaves out dynamic models, but the agent inside it resolves them.
  return model as unknown as MastraModelConfig;
}
