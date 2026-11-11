import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Reply =
  | { text: string; thinking?: boolean }
  | { tool: { name: string; input: Record<string, unknown> }; thinking?: boolean }
  | { status: number; error: string };

export type AnthropicRequest = Record<string, unknown> & {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
};

export interface FakeAnthropic {
  url: string;
  /** Agent calls, in order. Guardrail calls go to guardRequests instead. */
  requests: AnthropicRequest[];
  guardRequests: AnthropicRequest[];
  replies: Reply[];
  /** Injection scores for the next guardrail calls. Unscripted calls score 0, and -1 fails. */
  guardScores: number[];
  usage: { input: number; output: number };
  delayMs: number;
  guardDelayMs: number;
  close(): Promise<void>;
}

export const fakeSignature = 'fake-signature-0123456789';

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function blocks(reply: Exclude<Reply, { status: number }>, id: string) {
  const content: Array<{ start: unknown; deltas: unknown[]; final: unknown }> = [];
  if (reply.thinking) {
    content.push({
      start: { type: 'thinking', thinking: '', signature: '' },
      deltas: [{ type: 'signature_delta', signature: fakeSignature }],
      final: { type: 'thinking', thinking: '', signature: fakeSignature },
    });
  }
  if ('text' in reply) {
    content.push({
      start: { type: 'text', text: '' },
      deltas: [{ type: 'text_delta', text: reply.text }],
      final: { type: 'text', text: reply.text },
    });
  } else {
    content.push({
      start: { type: 'tool_use', id, name: reply.tool.name, input: {} },
      deltas: [{ type: 'input_json_delta', partial_json: JSON.stringify(reply.tool.input) }],
      final: { type: 'tool_use', id, name: reply.tool.name, input: reply.tool.input },
    });
  }
  return content;
}

/** A Messages API stand-in. It streams scripted replies, one per agent call, in order. */
export async function startFakeAnthropic(
  replies: Reply[] = [],
  { host = '127.0.0.1', port = 0 } = {},
): Promise<FakeAnthropic> {
  const fake: FakeAnthropic = {
    url: '',
    requests: [],
    guardRequests: [],
    replies,
    guardScores: [],
    usage: { input: 100, output: 20 },
    delayMs: 0,
    guardDelayMs: 0,
    close: async () => {},
  };

  const server = createServer(async (req, res) => {
    const body = JSON.parse((await read(req)) || '{}') as AnthropicRequest;
    const usage = { input_tokens: fake.usage.input, output_tokens: fake.usage.output };

    if ((body.output_config as { format?: unknown } | undefined)?.format) {
      fake.guardRequests.push(body);
      if (fake.guardDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, fake.guardDelayMs));
      }
      const score = fake.guardScores.shift() ?? 0;
      if (score < 0) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'down' } }));
        return;
      }
      const verdict = {
        categories: score > 0 ? [{ type: 'injection', score }] : null,
        reason: score > 0 ? 'Tries to override the instructions.' : null,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `msg_guard_${fake.guardRequests.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: JSON.stringify(verdict) }],
          stop_reason: 'end_turn',
          usage,
        }),
      );
      return;
    }

    fake.requests.push(body);
    if (fake.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
    // A caller that gave up during the delay must not take the reply scripted for the next one.
    if (res.destroyed) return;
    const reply = fake.replies.shift() ?? { text: 'OK.' };
    if ('status' in reply) {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'api_error', message: reply.error } }),
      );
      return;
    }

    const id = `toolu_${fake.requests.length}`;
    const content = blocks(reply, id);
    const stopReason = 'text' in reply ? 'end_turn' : 'tool_use';
    const message = { id: `msg_${fake.requests.length}`, type: 'message', role: 'assistant' };

    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...message,
          model: body.model,
          content: content.map((block) => block.final),
          stop_reason: stopReason,
          usage,
        }),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      sse('message_start', {
        type: 'message_start',
        message: { ...message, model: body.model, content: [], stop_reason: null, usage },
      }),
    );
    content.forEach((block, index) => {
      res.write(
        sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: block.start,
        }),
      );
      for (const delta of block.deltas) {
        res.write(sse('content_block_delta', { type: 'content_block_delta', index, delta }));
      }
      res.write(sse('content_block_stop', { type: 'content_block_stop', index }));
    });
    res.write(
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason },
        usage: { output_tokens: usage.output_tokens },
      }),
    );
    res.write(sse('message_stop', { type: 'message_stop' }));
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  fake.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}
