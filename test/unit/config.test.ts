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
      AGENT_MAX_OUTPUT_TOKENS: 4096,
      AGENT_RUN_TIMEOUT_MS: 120_000,
      DAILY_TOKEN_BUDGET: 500_000,
      DATABASE_POOL_MAX: 10,
      RUN_RETENTION_DAYS: 30,
      APPROVAL_TTL_HOURS: 24,
      TRUST_PROXY: false,
      CORS_ORIGINS: [],
    });
  });

  it('parses lists and flags', () => {
    const config = loadConfig({
      ...required,
      CORS_ORIGINS: 'https://a.test, https://b.test',
      TRUST_PROXY: 'true',
    });
    expect(config.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
    expect(config.TRUST_PROXY).toBe(true);
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
    ['TRUST_PROXY', { ...required, TRUST_PROXY: 'yes' }],
  ])('names %s when it is missing or invalid', (name, env) => {
    expect(() => loadConfig(env)).toThrow(name);
  });
});
