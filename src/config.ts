import { z } from 'zod';

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

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
    AGENT_MAX_OUTPUT_TOKENS: positive(4096),
    AGENT_RUN_TIMEOUT_MS: positive(120_000),
    AGENT_MEMORY_MESSAGES: positive(20),
    GUARDRAIL_MODEL: z.string().min(1).default('anthropic/claude-haiku-5-5'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    DAILY_TOKEN_BUDGET: positive(500_000),
    RUN_RETENTION_DAYS: positive(30),
    APPROVAL_TTL_HOURS: positive(24),
    CORS_ORIGINS: list,
    TRUST_PROXY: flag,
    RATE_LIMIT_PER_MINUTE: positive(300),
    AGENT_RATE_LIMIT_PER_MINUTE: positive(20),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    OTEL_SERVICE_NAME: z.string().min(1).default('ai-agent-mastra-starter'),
  })
  .refine(
    (env) =>
      env.ANTHROPIC_API_KEY ||
      ![env.AGENT_MODEL, env.GUARDRAIL_MODEL].some((model) => model.startsWith('anthropic/')),
    {
      path: ['ANTHROPIC_API_KEY'],
      message: 'is required for anthropic/ models. Get one at https://platform.claude.com',
    },
  );

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment: ${fields.join('; ')}`);
  }
  return result.data;
}
