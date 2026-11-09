import type { AgentContext } from '../agent/tools.ts';

export interface AppEnv {
  Variables: {
    requestId: string;
    user: AgentContext;
  };
}
