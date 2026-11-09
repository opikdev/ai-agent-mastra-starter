import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { PostgresStore } from '@mastra/pg';
import type pg from 'pg';
import type { Config } from '../config.ts';
import { logRedactions, logSerializers } from '../platform/logger.ts';
import { agentId, createNotesAssistant } from './notes-assistant.ts';

/** Mastra keeps memory threads and approval snapshots in this schema. */
export const mastraSchema = 'mastra';

type AgentConfig = Pick<
  Config,
  | 'AGENT_MODEL'
  | 'GUARDRAIL_MODEL'
  | 'AGENT_MEMORY_MESSAGES'
  | 'LOG_LEVEL'
  | 'OTEL_EXPORTER_OTLP_ENDPOINT'
  | 'OTEL_SERVICE_NAME'
>;

function observability(config: AgentConfig) {
  if (!config.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  return new Observability({
    configs: {
      otel: {
        serviceName: config.OTEL_SERVICE_NAME,
        exporters: [
          new OtelExporter({
            provider: {
              custom: { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT, protocol: 'http/json' },
            },
          }),
        ],
      },
    },
  });
}

export function createStore(pool: pg.Pool, init = false) {
  return new PostgresStore({ id: 'mastra', pool, schemaName: mastraSchema, disableInit: !init });
}

export function createMastra(config: AgentConfig, pool: pg.Pool) {
  // Mastra's debug logs include model text and tool results, so they're never on.
  const level =
    config.LOG_LEVEL === 'warn' || config.LOG_LEVEL === 'error' ? config.LOG_LEVEL : 'info';
  const tracing = observability(config);
  const mastra = new Mastra({
    agents: {
      [agentId]: createNotesAssistant({
        model: config.AGENT_MODEL,
        guardrailModel: config.GUARDRAIL_MODEL,
        memoryMessages: config.AGENT_MEMORY_MESSAGES,
      }),
    },
    storage: createStore(pool),
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : new PinoLogger({
            name: 'mastra',
            level,
            prettyPrint: false,
            redact: logRedactions,
            serializers: logSerializers,
          }),
    ...(tracing ? { observability: tracing } : {}),
  });
  return { mastra, agent: mastra.getAgent(agentId) };
}

export type Assistant = ReturnType<typeof createMastra>['agent'];
