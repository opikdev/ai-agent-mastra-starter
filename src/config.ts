import { z } from 'zod';

const list = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const atLeastZero = (fallback: number) => z.coerce.number().int().min(0).default(fallback);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    DATABASE_URL: z.url(),
    DATABASE_STATEMENT_TIMEOUT_MS: positive(5000),
    DATABASE_POOL_MAX: positive(10),
    NOTES_API_URL: z.url(),
    NOTES_API_TIMEOUT_MS: positive(5000),
    AGENT_MODEL: z.string().min(1).default('anthropic/claude-sonnet-5-5'),
    AGENT_MAX_STEPS: positive(8),
    AGENT_MAX_OUTPUT_TOKENS: positive(16_000),
    AGENT_RUN_TIMEOUT_MS: positive(120_000),
    AGENT_RUN_TOKEN_LIMIT: positive(100_000),
    AGENT_MAX_CONCURRENT_RUNS: positive(3),
    AGENT_MEMORY_MESSAGES: positive(20),
    GUARDRAIL_MODEL: z.string().min(1).default('anthropic/claude-haiku-5-5'),
    GUARDRAIL_ON_ERROR: z.enum(['block', 'allow']).default('block'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    DAILY_TOKEN_BUDGET: positive(500_000),
    RUN_RETENTION_DAYS: positive(30),
    THREAD_RETENTION_DAYS: atLeastZero(90),
    APPROVAL_TTL_HOURS: positive(24),
    CORS_ORIGINS: list,
    TRUST_PROXY_HOPS: atLeastZero(0),
    RATE_LIMIT_PER_MINUTE: positive(300),
    AGENT_RATE_LIMIT_PER_MINUTE: positive(20),
    DOCS_ENABLED: z.stringbool().default(false),
    SHUTDOWN_DRAIN_SECONDS: atLeastZero(5),
    SHUTDOWN_TIMEOUT_SECONDS: positive(30),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    OTEL_SERVICE_NAME: z.string().min(1).default('ai-agent-mastra-starter'),
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: z.stringbool().default(false),
  })
  .refine(
    (env) =>
      env.ANTHROPIC_API_KEY ||
      ![env.AGENT_MODEL, env.GUARDRAIL_MODEL].some((model) => model.startsWith('anthropic/')),
    {
      path: ['ANTHROPIC_API_KEY'],
      message: 'is required for anthropic/ models. Get one at https://platform.claude.com',
    },
  )
  .refine((env) => env.AGENT_RUN_TOKEN_LIMIT <= env.DAILY_TOKEN_BUDGET, {
    path: ['AGENT_RUN_TOKEN_LIMIT'],
    message: 'must be at most DAILY_TOKEN_BUDGET, or no run could start',
  })
  .refine((env) => env.SHUTDOWN_TIMEOUT_SECONDS * 1000 >= env.DATABASE_STATEMENT_TIMEOUT_MS, {
    path: ['SHUTDOWN_TIMEOUT_SECONDS'],
    message: 'must be at least DATABASE_STATEMENT_TIMEOUT_MS, so requests in flight can finish',
  });

export type Config = z.infer<typeof envSchema>;

/** An empty variable, such as `KEY=` in `.env` or Compose's `${KEY:-}`, counts as unset. */
function withoutEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.TRUST_PROXY !== undefined) {
    throw new Error(
      'TRUST_PROXY was replaced by TRUST_PROXY_HOPS. Set TRUST_PROXY_HOPS=1 for the old behavior.',
    );
  }
  const result = envSchema.safeParse(withoutEmpty(env));
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment: ${fields.join('; ')}`);
  }
  return result.data;
}
