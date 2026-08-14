/**
 * End-to-end through the real runner.
 *
 * The Cortadel boundary is a fake client and the model boundary is a fake `Model`, so these tests
 * drive a genuine `run()` with no network, no server and no keys — and observe what the runner
 * actually sent. This is the proof that the two seams are real: if `Session` or
 * `callModelInputFilter` changed shape upstream, these fail rather than passing on a mock.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  Agent,
  Usage,
  run,
  setTracingDisabled,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents';

import { CortadelSession } from '../src/session.js';
import { DEFAULT_MEMORY_HEADER } from '../src/memory.js';
import { FakeCortadelClient, SESSION_ID, USER_ID, asClient, hit } from './helpers.js';

class FakeModel implements Model {
  readonly calls: ModelRequest[] = [];

  constructor(private readonly replies: string[] = ['Understood.']) {}

  get lastInstructions(): string | undefined {
    return this.calls[this.calls.length - 1]?.systemInstructions;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const text = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)]!;
    return {
      usage: new Usage(),
      output: [
        {
          id: `msg-${this.calls.length}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text }],
        },
      ],
    };
  }

  getStreamedResponse(): AsyncIterable<StreamEvent> {
    throw new Error('FakeModel is non-streaming.');
  }
}

beforeAll(() => {
  // The SDK's tracing exporter posts to OpenAI. Off, so the suite cannot touch a network even on
  // a machine that happens to have OPENAI_API_KEY set.
  setTracingDisabled(true);
});

describe('run() with session.runOptions()', () => {
  it('recalls before the model call and persists after the turn', async () => {
    const client = new FakeCortadelClient({ hits: [hit('Alice uses Neovim')] });
    const model = new FakeModel(['You use Neovim.']);
    const agent = new Agent({ name: 'Assistant', instructions: 'You are helpful.', model });
    const session = new CortadelSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      client: asClient(client),
      awaitPersist: true,
    });

    const result = await run(agent, 'What editor do I use?', session.runOptions());

    expect(result.finalOutput).toBe('You use Neovim.');

    // (1) recall-before-model: the block reached the model, keyed on the user's question.
    expect(client.searches.map((search) => search.query)).toEqual(['What editor do I use?']);
    expect(model.lastInstructions).toContain('You are helpful.');
    expect(model.lastInstructions).toContain(DEFAULT_MEMORY_HEADER);
    expect(model.lastInstructions).toContain('1. Alice uses Neovim');

    // (2) persist-after-turn: the whole exchange was distilled into Cortadel.
    expect(client.conversations).toHaveLength(1);
    expect(client.conversations[0]!.messages).toEqual([
      { role: 'user', content: 'What editor do I use?' },
      { role: 'assistant', content: 'You use Neovim.' },
    ]);
    expect(client.conversations[0]!.options).toMatchObject({ sessionId: SESSION_ID });
  });

  it('never writes the injected block back into history, even in input mode', async () => {
    const client = new FakeCortadelClient({ hits: [hit('Alice uses Neovim')] });
    const agent = new Agent({
      name: 'Assistant',
      instructions: 'You are helpful.',
      model: new FakeModel(['You use Neovim.']),
    });
    const session = new CortadelSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      client: asClient(client),
      awaitPersist: true,
      injectAs: 'input',
    });

    await run(agent, 'What editor do I use?', session.runOptions());

    // The TypeScript runner persists whatever the filter produced (`persistedItems` /
    // `sourceMatchKinds: 'injected'`), so the session has to strip its own block on the way in.
    const history = await session.getItems();
    expect(JSON.stringify(history)).not.toContain(DEFAULT_MEMORY_HEADER);
    expect(history).toHaveLength(2);
    for (const conversation of client.conversations) {
      expect(JSON.stringify(conversation.messages)).not.toContain(DEFAULT_MEMORY_HEADER);
    }
  });

  it('recalls freshly on every turn in input mode, without accumulating blocks', async () => {
    const client = new FakeCortadelClient({ hits: [hit('Alice uses Neovim')] });
    const model = new FakeModel(['Noted.', 'You use Neovim.']);
    const agent = new Agent({ name: 'Assistant', instructions: 'You are helpful.', model });
    const session = new CortadelSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      client: asClient(client),
      awaitPersist: true,
      injectAs: 'input',
    });

    await run(agent, 'Remember I ship on Fridays.', session.runOptions());
    await run(agent, 'What editor do I use?', session.runOptions());

    // Two turns, two searches — the guard did not misfire on a leftover block.
    expect(client.searches.map((search) => search.query)).toEqual([
      'Remember I ship on Fridays.',
      'What editor do I use?',
    ]);

    const secondInput = model.calls[1]!.input;
    const serialized = JSON.stringify(secondInput);
    expect(serialized.split(DEFAULT_MEMORY_HEADER).length - 1).toBe(1);
  });

  it('carries history across turns, and context does not accumulate memories', async () => {
    const client = new FakeCortadelClient({ hits: [hit('Alice uses Neovim')] });
    const model = new FakeModel(['Noted.', 'You use Neovim.']);
    const agent = new Agent({ name: 'Assistant', instructions: 'You are helpful.', model });
    const session = new CortadelSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      client: asClient(client),
      awaitPersist: true,
    });

    await run(agent, 'Remember I ship on Fridays.', session.runOptions());
    await run(agent, 'What editor do I use?', session.runOptions());

    // Turn two saw turn one's exchange.
    const secondInput = model.calls[1]!.input;
    expect(Array.isArray(secondInput) ? secondInput.length : 0).toBeGreaterThan(1);

    // The block appears exactly once per model call — it is rebuilt, never accumulated.
    const occurrences = (model.lastInstructions ?? '').split(DEFAULT_MEMORY_HEADER).length - 1;
    expect(occurrences).toBe(1);

    expect(client.conversations).toHaveLength(2);
  });

  it('keeps the run alive when Cortadel is down for the whole turn', async () => {
    const client = new FakeCortadelClient({ failWith: new Error('Connection refused') });
    const model = new FakeModel(['Answered anyway.']);
    const agent = new Agent({ name: 'Assistant', instructions: 'You are helpful.', model });
    const session = new CortadelSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      client: asClient(client),
      awaitPersist: true,
      onError: () => {},
    });

    const result = await run(agent, 'What editor do I use?', session.runOptions());

    expect(result.finalOutput).toBe('Answered anyway.');
    expect(model.lastInstructions).toBe('You are helpful.');
  });

  it('stores but does not recall when only `session` is passed', async () => {
    const client = new FakeCortadelClient({ hits: [hit('Alice uses Neovim')] });
    const model = new FakeModel(['Fine.']);
    const agent = new Agent({ name: 'Assistant', instructions: 'You are helpful.', model });
    const session = new CortadelSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      client: asClient(client),
      awaitPersist: true,
    });

    await run(agent, 'What editor do I use?', { session });

    expect(client.searches).toEqual([]);
    expect(model.lastInstructions).toBe('You are helpful.');
    expect(client.conversations).toHaveLength(1);
  });
});
