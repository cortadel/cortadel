import { describe, expect, it, vi } from 'vitest';
import { RunContext, type FunctionTool, type Tool } from '@openai/agents';

import { cortadelMemoryTools } from '../src/tools.js';
import { DEFAULT_APP_NAME } from '../src/memory.js';
import { FakeCortadelClient, asClient, hit, unreachable, USER_ID } from './helpers.js';

function fnTool(tools: Tool[], name: string): FunctionTool<unknown, any, any> {
  const found = tools.find((candidate) => candidate.type === 'function' && candidate.name === name);
  if (!found || found.type !== 'function') {
    throw new Error(`no function tool named ${name}`);
  }
  return found;
}

function invoke(tool: FunctionTool<unknown, any, any>, args: unknown): Promise<unknown> {
  return tool.invoke(new RunContext(), JSON.stringify(args));
}

describe('tool registration and schema', () => {
  it('exposes the canonical tool names', () => {
    const tools = cortadelMemoryTools({ client: asClient(new FakeCortadelClient()) });
    expect(tools.map((tool) => (tool.type === 'function' ? tool.name : tool.type))).toEqual([
      'search_memory',
      'add_memories',
    ]);
  });

  it('declares a strict JSON schema derived from the Zod parameters', () => {
    const tools = cortadelMemoryTools({ client: asClient(new FakeCortadelClient()) });

    const search = fnTool(tools, 'search_memory');
    expect(search.strict).toBe(true);
    expect(search.parameters).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    });
    expect(search.description).toContain('long-term memory');

    const add = fnTool(tools, 'add_memories');
    expect(add.parameters).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    });
  });
});

describe('construction and user-id scoping', () => {
  it('requires either a user id or a pre-built client', () => {
    expect(() => cortadelMemoryTools()).toThrow(/either userId or a pre-built client/);
  });

  it('refuses both, because a client is already scoped', () => {
    expect(() =>
      cortadelMemoryTools({ userId: USER_ID, client: asClient(new FakeCortadelClient()) }),
    ).toThrow(/not both/);
  });
});

describe('search_memory', () => {
  it('returns numbered hits and forwards the search options', async () => {
    const client = new FakeCortadelClient({ hits: [hit('uses Neovim'), hit('ships Fridays')] });
    const tools = cortadelMemoryTools({
      client: asClient(client),
      topK: 3,
      searchMode: 'vector',
      rerank: 'cross_encoder',
      sessionId: 'e2e-scoped-session',
    });

    const output = await invoke(fnTool(tools, 'search_memory'), { query: 'what do I use?' });

    expect(output).toBe('1. uses Neovim\n2. ships Fridays');
    expect(client.searches).toEqual([
      {
        query: 'what do I use?',
        options: {
          topK: 3,
          mode: 'vector',
          rerank: 'cross_encoder',
          sessionId: 'e2e-scoped-session',
        },
      },
    ]);
  });

  it('defaults topK to the Cortadel SDK default of 10', async () => {
    const client = new FakeCortadelClient();
    const tools = cortadelMemoryTools({ client: asClient(client) });
    await invoke(fnTool(tools, 'search_memory'), { query: 'q' });
    expect(client.searches[0]!.options).toMatchObject({ topK: 10, mode: 'hybrid' });
  });

  it('applies minScore', async () => {
    const client = new FakeCortadelClient({ hits: [hit('weak', 0.1), hit('strong', 0.9)] });
    const tools = cortadelMemoryTools({ client: asClient(client), minScore: 0.5 });
    expect(await invoke(fnTool(tools, 'search_memory'), { query: 'q' })).toBe('1. strong');
  });

  it('says so when there is nothing to recall', async () => {
    const tools = cortadelMemoryTools({ client: asClient(new FakeCortadelClient()) });
    expect(await invoke(fnTool(tools, 'search_memory'), { query: 'q' })).toBe(
      'No relevant memories found.',
    );
  });

  it('degrades to a model-visible string when Cortadel is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tools = cortadelMemoryTools({ client: asClient(unreachable()) });
    expect(await invoke(fnTool(tools, 'search_memory'), { query: 'q' })).toBe(
      'Memory is currently unavailable. Answer without it.',
    );
    warn.mockRestore();
  });

  it('propagates the failure when throwOnError is set', async () => {
    const tools = cortadelMemoryTools({ client: asClient(unreachable()), throwOnError: true });
    await expect(invoke(fnTool(tools, 'search_memory'), { query: 'q' })).rejects.toThrow(
      'Connection refused',
    );
  });

  it('reports the failure to onError', async () => {
    const seen: unknown[] = [];
    const tools = cortadelMemoryTools({
      client: asClient(unreachable()),
      onError: (error) => {
        seen.push(error);
      },
    });
    await invoke(fnTool(tools, 'search_memory'), { query: 'q' });
    expect(seen).toHaveLength(1);
  });
});

describe('add_memories', () => {
  it('stores the fact tagged with the integration app name', async () => {
    const client = new FakeCortadelClient();
    const tools = cortadelMemoryTools({ client: asClient(client) });

    expect(await invoke(fnTool(tools, 'add_memories'), { text: 'Alice uses Neovim.' })).toBe(
      'Stored.',
    );
    expect(client.adds).toEqual([
      { text: 'Alice uses Neovim.', options: { app: DEFAULT_APP_NAME } },
    ]);
  });

  it('reports a deduplicated write honestly', async () => {
    const client = new FakeCortadelClient({ addEvent: 'SKIP_DUPLICATE' });
    const tools = cortadelMemoryTools({ client: asClient(client) });
    expect(await invoke(fnTool(tools, 'add_memories'), { text: 'again' })).toBe(
      'Already remembered; nothing new stored.',
    );
  });

  it('surfaces any other pipeline event', async () => {
    const client = new FakeCortadelClient({ addEvent: 'SUPERSEDE' });
    const tools = cortadelMemoryTools({ client: asClient(client) });
    expect(await invoke(fnTool(tools, 'add_memories'), { text: 'newer fact' })).toBe(
      'Stored (event: SUPERSEDE).',
    );
  });

  it('degrades when Cortadel is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tools = cortadelMemoryTools({ client: asClient(unreachable()) });
    expect(await invoke(fnTool(tools, 'add_memories'), { text: 'x' })).toBe(
      'Memory is currently unavailable; nothing was stored.',
    );
    warn.mockRestore();
  });
});
