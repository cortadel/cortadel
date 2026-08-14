/**
 * The automatic recall-before-model half: `callModelInputFilter`.
 *
 * These tests call the filter exactly the way the runner does — `applyCallModelInputFilter`
 * (`@openai/agents-core/dist/runner/conversation.d.ts`) invokes it with
 * `{ modelData, agent, context }` and uses whatever `ModelInputData` comes back.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  type AgentInputItem,
  type CallModelInputFilterArgs,
  type ModelInputData,
} from '@openai/agents';

import { CortadelSession } from '../src/session.js';
import { DEFAULT_MEMORY_HEADER } from '../src/memory.js';
import {
  FakeCortadelClient,
  SESSION_ID,
  USER_ID,
  asClient,
  assistantMessage,
  hit,
  unreachable,
  userMessage,
} from './helpers.js';

// `Agent<TContext, TOutput>` is invariant in TOutput, so a plain `new Agent(...)` — which is
// `Agent<unknown, "text">` — does not widen to the `Agent<unknown, AgentOutputType>` the filter
// args declare. The runner passes the real agent; the filter never reads it.
const agent = new Agent({ name: 'Test' }) as unknown as CallModelInputFilterArgs['agent'];

function makeSession(
  client: FakeCortadelClient,
  overrides: Partial<ConstructorParameters<typeof CortadelSession>[0]> = {},
): CortadelSession {
  return new CortadelSession({
    sessionId: SESSION_ID,
    userId: USER_ID,
    client: asClient(client),
    ...overrides,
  });
}

function runFilter(session: CortadelSession, modelData: ModelInputData): Promise<ModelInputData> {
  return Promise.resolve(session.callModelInputFilter({ modelData, agent, context: undefined }));
}

const oneTurn: ModelInputData = {
  input: [userMessage('what editor do I use?')],
  instructions: 'You are helpful.',
};

describe('injection into the instructions (the default)', () => {
  it('appends the recalled block to the system prompt', async () => {
    const client = new FakeCortadelClient({ hits: [hit('Alice uses Neovim')] });
    const result = await runFilter(makeSession(client), oneTurn);

    expect(result.instructions).toContain('You are helpful.');
    expect(result.instructions).toContain(DEFAULT_MEMORY_HEADER);
    expect(result.instructions).toContain('1. Alice uses Neovim');
    // The input items are untouched, so nothing synthetic can be persisted as history.
    expect(result.input).toEqual(oneTurn.input);
  });

  it('becomes the whole instruction set when the agent had none', async () => {
    const client = new FakeCortadelClient({ hits: [hit('Alice uses Neovim')] });
    const result = await runFilter(makeSession(client), { input: oneTurn.input });
    expect(result.instructions?.startsWith(DEFAULT_MEMORY_HEADER)).toBe(true);
  });

  it('searches on the latest user message with the session settings', async () => {
    const client = new FakeCortadelClient({ hits: [hit('x')] });
    const session = makeSession(client, {
      topK: 3,
      searchMode: 'vector',
      rerank: 'cross_encoder',
      scopeRecallToSession: true,
    });

    await runFilter(session, {
      input: [userMessage('first'), assistantMessage('reply'), userMessage('the latest question')],
    });

    expect(client.searches).toEqual([
      {
        query: 'the latest question',
        options: {
          topK: 3,
          mode: 'vector',
          rerank: 'cross_encoder',
          sessionId: SESSION_ID,
        },
      },
    ]);
  });

  it('defaults topK to 5 for automatic injection', async () => {
    const client = new FakeCortadelClient({ hits: [hit('x')] });
    await runFilter(makeSession(client), oneTurn);
    expect(client.searches[0]!.options).toMatchObject({ topK: 5, mode: 'hybrid' });
  });

  it('does not scope recall to the session by default', async () => {
    const client = new FakeCortadelClient({ hits: [hit('x')] });
    await runFilter(makeSession(client), oneTurn);
    expect(client.searches[0]!.options?.sessionId).toBeUndefined();
  });

  it('drops hits below minScore', async () => {
    const client = new FakeCortadelClient({ hits: [hit('weak', 0.1), hit('strong', 0.9)] });
    const result = await runFilter(makeSession(client, { minScore: 0.5 }), oneTurn);
    expect(result.instructions).toContain('1. strong');
    expect(result.instructions).not.toContain('weak');
  });
});

describe('injection into the input', () => {
  it('inserts a system message immediately before the latest user message', async () => {
    const client = new FakeCortadelClient({ hits: [hit('Alice uses Neovim')] });
    const session = makeSession(client, { injectAs: 'input' });

    const input: AgentInputItem[] = [
      userMessage('first'),
      assistantMessage('reply'),
      userMessage('the latest question'),
    ];
    const result = await runFilter(session, { input, instructions: 'You are helpful.' });

    expect(result.instructions).toBe('You are helpful.');
    expect(result.input).toHaveLength(4);
    const injected = result.input[2] as { role: string; content: string };
    expect(injected.role).toBe('system');
    expect(injected.content).toContain('1. Alice uses Neovim');
    expect(result.input[3]).toEqual(userMessage('the latest question'));
  });
});

describe('when nothing should be injected', () => {
  it('leaves the call untouched on a turn with no user text', async () => {
    const client = new FakeCortadelClient({ hits: [hit('x')] });
    const modelData: ModelInputData = {
      input: [{ role: 'user', content: [{ type: 'input_image', image: 'x' }] }],
      instructions: 'You are helpful.',
    };

    const result = await runFilter(makeSession(client), modelData);

    expect(result).toBe(modelData);
    expect(client.searches).toEqual([]);
  });

  it('injects nothing when the search comes back empty', async () => {
    const client = new FakeCortadelClient();
    const result = await runFilter(makeSession(client), oneTurn);
    expect(result).toBe(oneTurn);
  });

  it('does not re-inject when the block is already in the instructions', async () => {
    const client = new FakeCortadelClient({ hits: [hit('x')] });
    const modelData: ModelInputData = {
      input: oneTurn.input,
      instructions: `You are helpful.\n\n${DEFAULT_MEMORY_HEADER}\nalready here`,
    };

    const result = await runFilter(makeSession(client), modelData);

    expect(result).toBe(modelData);
    expect(client.searches).toEqual([]);
  });

  it('does not re-inject when the block is already in the input', async () => {
    const client = new FakeCortadelClient({ hits: [hit('x')] });
    const modelData: ModelInputData = {
      input: [
        { role: 'system', content: `${DEFAULT_MEMORY_HEADER}\nalready here` },
        userMessage('what editor do I use?'),
      ],
    };

    expect(await runFilter(makeSession(client), modelData)).toBe(modelData);
    expect(client.searches).toEqual([]);
  });

  it('skips recall entirely when retrieve is off', async () => {
    const client = new FakeCortadelClient({ hits: [hit('x')] });
    expect(await runFilter(makeSession(client, { retrieve: false }), oneTurn)).toBe(oneTurn);
    expect(client.searches).toEqual([]);
  });
});

describe('caching and invalidation', () => {
  it('searches once per unchanged question, however many model calls a turn takes', async () => {
    const client = new FakeCortadelClient({ hits: [hit('x')] });
    const session = makeSession(client);

    await runFilter(session, oneTurn);
    await runFilter(session, oneTurn);

    expect(client.searches).toHaveLength(1);
  });

  it('searches again once the conversation advances', async () => {
    const client = new FakeCortadelClient({ hits: [hit('x')] });
    const session = makeSession(client, { store: false });

    await runFilter(session, oneTurn);
    await session.addItems([assistantMessage('Neovim.')]);
    await runFilter(session, oneTurn);

    expect(client.searches).toHaveLength(2);
  });
});

describe('graceful degradation', () => {
  it('leaves the model call unchanged when Cortadel is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runFilter(makeSession(unreachable()), oneTurn);

    expect(result).toBe(oneTurn);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('reports the failure to onError instead of logging', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: unknown[] = [];
    const session = makeSession(unreachable(), {
      onError: (error) => {
        seen.push(error);
      },
    });

    await runFilter(session, oneTurn);

    expect(seen).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('propagates when throwOnError is set', async () => {
    const session = makeSession(unreachable(), { throwOnError: true });
    await expect(runFilter(session, oneTurn)).rejects.toThrow('Connection refused');
  });
});

describe('runOptions', () => {
  it('installs both halves of automatic memory', () => {
    const session = makeSession(new FakeCortadelClient());
    const options = session.runOptions();

    expect(options.session).toBe(session);
    expect(options.callModelInputFilter).toBe(session.callModelInputFilter);
  });

  it('keeps the filter identity stable across reads', () => {
    const session = makeSession(new FakeCortadelClient());
    expect(session.callModelInputFilter).toBe(session.callModelInputFilter);
  });

  it('copies the caller options rather than mutating them', () => {
    const session = makeSession(new FakeCortadelClient());
    const base = { maxTurns: 5 };
    const options = session.runOptions(base);

    expect(options.maxTurns).toBe(5);
    expect(base).toEqual({ maxTurns: 5 });
  });

  it('warns rather than silently dropping a caller-supplied filter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = makeSession(new FakeCortadelClient());

    const options = session.runOptions({
      callModelInputFilter: ({ modelData }: { modelData: ModelInputData }) => modelData,
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(options.callModelInputFilter).toBe(session.callModelInputFilter);
    warn.mockRestore();
  });
});
