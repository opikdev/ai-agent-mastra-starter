import {
  type MastraModelConfig,
  ModelRouterLanguageModel,
  type ModelRouterModelId,
} from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import { guardrailUsageKey, type UsageRecorder } from './context.ts';

type ModelStream = Awaited<ReturnType<ModelRouterLanguageModel['doGenerate']>>['stream'];

// The router types usage as AI SDK v2 numbers, but passes on the provider's v3 `{ total }` objects.
type TokenCount = number | { total?: number | undefined } | undefined;

function tokens(count: TokenCount): number {
  return typeof count === 'number' ? count : (count?.total ?? 0);
}

function counted(stream: ModelStream, record: UsageRecorder): ModelStream {
  return stream.pipeThrough(
    new TransformStream({
      transform(part, controller) {
        if (part.type === 'finish') {
          record({
            inputTokens: tokens(part.usage.inputTokens),
            outputTokens: tokens(part.usage.outputTokens),
          });
        }
        controller.enqueue(part);
      },
    }),
  );
}

/** Mastra's model for an ID, reporting each call's tokens to one run's recorder. */
class CountedModel extends ModelRouterLanguageModel {
  readonly #record: UsageRecorder;

  constructor(id: ModelRouterModelId, record: UsageRecorder) {
    super(id);
    this.#record = record;
  }

  override async doGenerate(options: Parameters<ModelRouterLanguageModel['doGenerate']>[0]) {
    const result = await super.doGenerate(options);
    return { ...result, stream: counted(result.stream, this.#record) };
  }

  override async doStream(options: Parameters<ModelRouterLanguageModel['doStream']>[0]) {
    const result = await super.doStream(options);
    return { ...result, stream: counted(result.stream, this.#record) };
  }
}

/**
 * The guardrail's model, resolved per run. Mastra drops the guardrail's usage, so each call
 * reports its tokens to the recorder in that run's request context. Runs without one, such as
 * evals, use the plain model.
 */
export function countedGuardrailModel(id: string): MastraModelConfig {
  const model = ({ requestContext }: { requestContext: RequestContext }) => {
    const record = requestContext.get(guardrailUsageKey) as UsageRecorder | undefined;
    return record ? new CountedModel(id as ModelRouterModelId, record) : id;
  };
  // The detector's options type leaves out dynamic models, but the agent inside it resolves them.
  return model as unknown as MastraModelConfig;
}
