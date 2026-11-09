import type { AgentContext } from '../agent/context.ts';

export interface AppEnv {
  Variables: {
    requestId: string;
    user: AgentContext;
  };
}
