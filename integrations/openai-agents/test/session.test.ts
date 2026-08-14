import { describe, expect, it, vi } from 'vitest';
import { MemorySession, RunContext, type AgentInputItem } from '@openai/agents';

import { CortadelSession } from '../src/session.js';
import {
  FakeCortadelClient,
  SESSION_ID,
  USER_ID,
  asClient,
  assistantMessage,
  unreachable,
  userMessage,
} from './helpers.js';

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

describe('construction', () => {
  it('requires a session id and a user id', () => {
    expect(() => new CortadelSession({ sessionId: '', userId: USER_ID })).toThrow(
      /sessionId is required/,
    );
    expect(() => new CortadelSession({ sessionId: SESSION_ID, userId: '' })).toThrow(
      /userId is required/,
    );
  });

  it('rejects an unknown injection site', () => {
    expect(() =>
      makeSession(new FakeCortadelClient(), { injectAs: 'nowhere' as 'input' }),
    ).toThrow(/must be "instructions" or "input"/);
  });

  it('builds its own client per user when none is supplied', () => {
    const alice = new CortadelSession({ sessionId: SESSION_ID, userId: 'e2e-alice' });
    const bob = new CortadelSession({ sessionId: SESSION_ID, userId: 'e2e-bob' });
    expect(alice.userId).toBe('e2e-alice');
    expect(bob.userId).toBe('e2e-bob');
    // One client per user id — a Cortadel client is bound to one user at construction.
    expect(alice.client).not.toBe(bob.client);
  });
});

describe('Session interface — history is delegated verbatim', () => {
  it('returns the id it was constructed with', async () => {
    await expect(makeSession(new FakeCortadelClient()).getSessionId()).resolves.toBe(SESSION_ID);
  });

  it('reads and writes through to the transcript, mixing in no memories', async () => {
    const transcript = new MemorySession({ sessionId: SESSION_ID });
    const session = makeSession(new FakeCortadelClient(), { transcript });

    await session.addItems([userMessage('hello'), assistantMessage('hi')]);

    expect(await session.getItems()).toEqual(await transcript.getItems());
    expect(await session.getItems()).toHaveLength(2);
  });

  it('honours the limit argument', async () => {
    const session = makeSession(new FakeCortadelClient());
    await session.addItems([userMessage('one'), assistantMessage('two')]);
    expect(await session.getItems(1)).toHaveLength(1);
  });

  it('clears the transcript but leaves Cortadel alone', async () => {
    const client = new FakeCortadelClient();
    const session = makeSession(client);

    await session.addItems([userMessage('hello'), assistantMessage('hi')]);
    await session.flush();
    await session.clearSession();

    expect(await session.getItems()).toEqual([]);
    // The conversation still reached Cortadel; clearing a chat window is not "forget the user".
    expect(client.conversations).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('waits for the assistant before writing the exchange', async () => {
    const client = new FakeCortadelClient();
    const session = makeSession(client, { awaitPersist: true });

    await session.addItems([userMessage('what editor do I use?')]);
    expect(client.conversations).toHaveLength(0);

    await session.addItems([assistantMessage('Neovim.')]);
    expect(client.conversations).toHaveLength(1);
    expect(client.conversations[0]!.messages).toEqual([
      { role: 'user', content: 'what editor do I use?' },
      { role: 'assistant', content: 'Neovim.' },
    ]);
  });

  it('carries the session id, tags and project into ConversationOptions', async () => {
    const client = new FakeCortadelClient();
    const session = makeSession(client, {
      awaitPersist: true,
      tags: ['support'],
      project: 'e2e-project',
    });

    await session.addItems([userMessage('q'), assistantMessage('a')]);

    expect(client.conversations[0]!.options).toEqual({
      sessionId: SESSION_ID,
      tags: ['support'],
      project: 'e2e-project',
    });
  });

  it('drops non-message plumbing rather than storing it', async () => {
    const client = new FakeCortadelClient();
    const session = makeSession(client, { awaitPersist: true });

    await session.addItems([
      userMessage('q'),
      { type: 'function_call', name: 'lookup', callId: 'c1', arguments: '{}' } as AgentInputItem,
      assistantMessage('a'),
    ]);

    expect(client.conversations[0]!.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('fires and forgets by default, and flush() is the synchronisation point', async () => {
    const client = new FakeCortadelClient();
    const session = makeSession(client);

    await session.addItems([userMessage('q'), assistantMessage('a')]);
    await session.flush();

    expect(client.conversations).toHaveLength(1);
  });

  it('drains background writes on close()', async () => {
    const client = new FakeCortadelClient();
    const session = makeSession(client);

    await session.addItems([userMessage('q'), assistantMessage('a')]);
    await session.close();

    expect(client.conversations).toHaveLength(1);
  });

  it('stores nothing when store is off', async () => {
    const client = new FakeCortadelClient();
    const session = makeSession(client, { store: false, awaitPersist: true });

    await session.addItems([userMessage('q'), assistantMessage('a')]);
    await session.flush();

    expect(client.conversations).toEqual([]);
  });

  it('keeps the agent running when the write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = makeSession(unreachable(), { awaitPersist: true });

    await expect(
      session.addItems([userMessage('q'), assistantMessage('a')]),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('propagates a write failure when throwOnError is set', async () => {
    const session = makeSession(unreachable(), { awaitPersist: true, throwOnError: true });
    await expect(session.addItems([userMessage('q'), assistantMessage('a')])).rejects.toThrow(
      'Connection refused',
    );
  });

  it('drops the batch after a failure rather than retrying it forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new FakeCortadelClient({ failWith: new Error('down') });
    const session = makeSession(client, { awaitPersist: true });

    await session.addItems([userMessage('q1'), assistantMessage('a1')]);
    client.failWith = undefined;
    await session.addItems([userMessage('q2'), assistantMessage('a2')]);

    expect(client.conversations).toHaveLength(2);
    expect(client.conversations[1]!.messages.map((message) => message.content)).toEqual([
      'q2',
      'a2',
    ]);
    warn.mockRestore();
  });
});

describe('popItem', () => {
  it('rewinds history and drops the matching unflushed message', async () => {
    const client = new FakeCortadelClient();
    const session = makeSession(client, { awaitPersist: true });

    await session.addItems([userMessage('a mistake')]);
    const popped = await session.popItem();

    expect(popped).toEqual(userMessage('a mistake'));
    expect(await session.getItems()).toEqual([]);

    // The rewound turn must never reach Cortadel.
    await session.addItems([userMessage('the real question'), assistantMessage('the answer')]);
    expect(client.conversations[0]!.messages.map((message) => message.content)).toEqual([
      'the real question',
      'the answer',
    ]);
  });

  it('returns undefined on an empty transcript', async () => {
    await expect(makeSession(new FakeCortadelClient()).popItem()).resolves.toBeUndefined();
  });
});

describe('tools()', () => {
  it('inherits the session client and its recall settings', async () => {
    const client = new FakeCortadelClient();
    const session = makeSession(client, { topK: 4, scopeRecallToSession: true });

    const tools = session.tools();
    expect(tools.map((tool) => (tool.type === 'function' ? tool.name : tool.type))).toEqual([
      'search_memory',
      'add_memories',
    ]);

    const search = tools[0]!;
    if (search.type !== 'function') {
      throw new Error('expected a function tool');
    }
    await search.invoke(new RunContext(), JSON.stringify({ query: 'what do I use?' }));

    expect(client.searches[0]!.options).toMatchObject({
      topK: 4,
      sessionId: SESSION_ID,
    });
  });
});
