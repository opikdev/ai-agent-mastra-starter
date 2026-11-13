import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  NOTES_API_URL: 'http://notes.test',
  ANTHROPIC_API_KEY: 'sk-test',
};

describe('loadConfig', () => {
  it('defaults to Sonnet 5.5 with Haiku 5.5 guardrails and safe limits', () => {
    expect(loadConfig(required)).toMatchObject({
      AGENT_MODEL: 'anthropic/claude-sonnet-5-5',
      GUARDRAIL_MODEL: 'anthropic/claude-haiku-5-5',
      AGENT_MAX_STEPS: 8,
      AGENT_MAX_OUTPUT_TOKENS: 16_000,
      AGENT_RUN_TIMEOUT_MS: 120_000,
      AGENT_RUN_TOKEN_LIMIT: 100_000,
      AGENT_MAX_CONCURRENT_RUNS: 3,
      GUARDRAIL_ON_ERROR: 'block',
      DAILY_TOKEN_BUDGET: 500_000,
      DATABASE_POOL_MAX: 10,
      RUN_RETENTION_DAYS: 30,
      APPROVAL_TTL_HOURS: 24,
      THREAD_RETENTION_DAYS: 90,
      TRUST_PROXY_HOPS: 0,
      CORS_ORIGINS: [],
      DOCS_ENABLED: false,
      SHUTDOWN_DRAIN_SECONDS: 5,
      SHUTDOWN_TIMEOUT_SECONDS: 30,
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: false,
    });
  });

  it('treats empty variables as unset, as `KEY=` in .env and Compose send them', () => {
    const config = loadConfig({
      ...required,
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      CORS_ORIGINS: '',
      AGENT_MAX_STEPS: '',
      DOCS_ENABLED: '',
    });
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(config.AGENT_MAX_STEPS).toBe(8);
    expect(config.DOCS_ENABLED).toBe(false);
  });

  it('loads the values shipped in .env.example, given a key', () => {
    const shipped = parseEnv(readFileSync('.env.example', 'utf8'));
    expect(() => loadConfig({ ...shipped, ANTHROPIC_API_KEY: 'sk-test' })).not.toThrow();
  });

  it('asks for a key when .env.example is used as it is', () => {
    const shipped = parseEnv(readFileSync('.env.example', 'utf8'));
    expect(() => loadConfig(shipped)).toThrow(/ANTHROPIC_API_KEY: is required/);
  });

  it('parses lists and proxy hops', () => {
    const config = loadConfig({
      ...required,
      CORS_ORIGINS: 'https://a.test, https://b.test',
      TRUST_PROXY_HOPS: '2',
    });
    expect(config.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
    expect(config.TRUST_PROXY_HOPS).toBe(2);
  });

  it.each(['true', 'false', ''])('tells you how to replace TRUST_PROXY=%s', (value) => {
    expect(() => loadConfig({ ...required, TRUST_PROXY: value })).toThrow(
      'TRUST_PROXY was replaced by TRUST_PROXY_HOPS. Set TRUST_PROXY_HOPS=1 for the old behavior.',
    );
  });

  it.each(['debug', 'info', 'warn', 'error', 'silent'])('accepts LOG_LEVEL=%s', (level) => {
    expect(loadConfig({ ...required, LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
  });

  it.each(['trace', 'fatal', 'INFO'])('rejects LOG_LEVEL=%s', (level) => {
    expect(() => loadConfig({ ...required, LOG_LEVEL: level })).toThrow(/LOG_LEVEL/);
  });

  it('parses the pool size', () => {
    expect(loadConfig({ ...required, DATABASE_POOL_MAX: '25' }).DATABASE_POOL_MAX).toBe(25);
  });

  it.each(['0', '-1', '2.5', 'many'])('rejects a pool size of %s', (value) => {
    expect(() => loadConfig({ ...required, DATABASE_POOL_MAX: value })).toThrow(
      /DATABASE_POOL_MAX/,
    );
  });

  it('needs no Anthropic key when no model is from Anthropic', () => {
    const env = {
      ...required,
      ANTHROPIC_API_KEY: undefined,
      AGENT_MODEL: 'openai/gpt-6',
      GUARDRAIL_MODEL: 'off',
    };
    expect(loadConfig(env).AGENT_MODEL).toBe('openai/gpt-6');
  });

  it.each([
    ['DATABASE_URL', { ...required, DATABASE_URL: undefined }],
    ['NOTES_API_URL', { ...required, NOTES_API_URL: undefined }],
    ['ANTHROPIC_API_KEY', { ...required, ANTHROPIC_API_KEY: undefined }],
    ['AGENT_MAX_STEPS', { ...required, AGENT_MAX_STEPS: '0' }],
    ['APPROVAL_TTL_HOURS', { ...required, APPROVAL_TTL_HOURS: '0' }],
    ['GUARDRAIL_ON_ERROR', { ...required, GUARDRAIL_ON_ERROR: 'ignore' }],
    ['AGENT_RUN_TOKEN_LIMIT', { ...required, AGENT_RUN_TOKEN_LIMIT: '600000' }],
    ['SHUTDOWN_TIMEOUT_SECONDS', { ...required, SHUTDOWN_TIMEOUT_SECONDS: '1' }],
    ['DOCS_ENABLED', { ...required, DOCS_ENABLED: 'maybe' }],
    ['TRUST_PROXY_HOPS', { ...required, TRUST_PROXY_HOPS: '-1' }],
    ['TRUST_PROXY_HOPS', { ...required, TRUST_PROXY_HOPS: '1.5' }],
    ['TRUST_PROXY_HOPS', { ...required, TRUST_PROXY_HOPS: 'true' }],
  ])('names %s when it is missing or invalid', (name, env) => {
    expect(() => loadConfig(env)).toThrow(name);
  });
});
