import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CortadelError } from '@cortadel/sdk';

import {
  DEFAULT_APP_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_MEMORY_HEADER,
  buildClient,
  callSafely,
  filterHits,
  formatMemoryBlock,
  headerAlreadyPresent,
  resolveApiKey,
  resolveBaseUrl,
} from '../src/memory.js';
import { hit } from './helpers.js';

describe('resolveBaseUrl / resolveApiKey', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env['CORTADEL_BASE_URL'];
    delete process.env['CORTADEL_API_KEY'];
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('falls back to the self-hosted default', () => {
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
    expect(resolveApiKey()).toBeUndefined();
  });

  it('reads the environment when nothing is passed', () => {
    process.env['CORTADEL_BASE_URL'] = 'https://app.cortadel.ai';
    process.env['CORTADEL_API_KEY'] = 'env-key';
    expect(resolveBaseUrl()).toBe('https://app.cortadel.ai');
    expect(resolveApiKey()).toBe('env-key');
  });

  it('lets an explicit argument win over the environment', () => {
    process.env['CORTADEL_BASE_URL'] = 'https://app.cortadel.ai';
    process.env['CORTADEL_API_KEY'] = 'env-key';
    expect(resolveBaseUrl('http://elsewhere:3001')).toBe('http://elsewhere:3001');
    expect(resolveApiKey('explicit')).toBe('explicit');
  });
});

describe('buildClient', () => {
  const savedFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it('scopes every request to the user id it was built with', async () => {
    // A Cortadel client is bound to one user id at construction — no method takes one. This is
    // the offline proof that "one client per user" actually reaches the wire.
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const body = init?.body;
      const text = typeof body === 'string' ? body : await new Response(body as BodyInit).text();
      requests.push({ url: String((input as { url?: string })?.url ?? input), body: text });
      return new Response(JSON.stringify({ query: 'q', results: [], total: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await buildClient('e2e-alice', { baseUrl: 'http://localhost:3001' }).search('anything');
    await buildClient('e2e-bob', { baseUrl: 'http://localhost:3001' }).search('anything');

    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toContain('/api/v1/memories/search');
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      user_id: 'e2e-alice',
      app_name: DEFAULT_APP_NAME,
    });
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ user_id: 'e2e-bob' });
  });

  it('rejects a blank user id at construction', () => {
    expect(() => buildClient('')).toThrow(/userId is required/);
  });
});

describe('callSafely', () => {
  it('returns the value on success', async () => {
    const result = await callSafely(async () => 'ok', {
      description: 'search',
      throwOnError: false,
      fallback: 'fallback',
    });
    expect(result).toBe('ok');
  });

  it('degrades to the fallback and warns when nothing observes the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await callSafely(
      async () => {
        throw new CortadelError(503, 'unavailable', 'down');
      },
      { description: 'search', throwOnError: false, fallback: undefined },
    );

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('status=503 code=unavailable');
    warn.mockRestore();
  });

  it('calls onError instead of logging, and still degrades', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: unknown[] = [];
    const failure = new CortadelError(0, 'transport_error', 'Connection refused');

    const result = await callSafely(
      async () => {
        throw failure;
      },
      {
        description: 'addConversation',
        throwOnError: false,
        fallback: 'degraded',
        onError: (error) => {
          seen.push(error);
        },
      },
    );

    expect(result).toBe('degraded');
    expect(seen).toEqual([failure]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('awaits an async onError', async () => {
    const seen: unknown[] = [];
    await callSafely(
      async () => {
        throw new Error('boom');
      },
      {
        description: 'search',
        throwOnError: false,
        fallback: undefined,
        onError: async (error) => {
          await Promise.resolve();
          seen.push(error);
        },
      },
    );
    expect(seen).toHaveLength(1);
  });

  it('propagates when throwOnError is set, after notifying onError', async () => {
    const seen: unknown[] = [];
    await expect(
      callSafely(
        async () => {
          throw new Error('boom');
        },
        {
          description: 'search',
          throwOnError: true,
          fallback: undefined,
          onError: (error) => {
            seen.push(error);
          },
        },
      ),
    ).rejects.toThrow('boom');
    expect(seen).toHaveLength(1);
  });

  it('does not let a throwing onError replace the failure it was told about', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await callSafely(
      async () => {
        throw new Error('original');
      },
      {
        description: 'search',
        throwOnError: false,
        fallback: 'still-degraded',
        onError: () => {
          throw new Error('telemetry is down too');
        },
      },
    );

    expect(result).toBe('still-degraded');
    expect(warn.mock.calls[0]![0]).toContain('telemetry is down too');
    warn.mockRestore();
  });
});

describe('filterHits', () => {
  it('keeps everything when no minimum is set', () => {
    expect(filterHits([hit('a', 0.1), hit('b', 0.9)])).toHaveLength(2);
  });

  it('drops hits below the minimum', () => {
    const kept = filterHits([hit('low', 0.1), hit('high', 0.9)], 0.5);
    expect(kept.map((h) => h.content)).toEqual(['high']);
  });

  it('keeps hits the server ranked but did not score', () => {
    const kept = filterHits([hit('unscored', null), hit('low', 0.1)], 0.5);
    expect(kept.map((h) => h.content)).toEqual(['unscored']);
  });
});

describe('formatMemoryBlock', () => {
  it('numbers the hits under the header', () => {
    const block = formatMemoryBlock([hit('uses Neovim'), hit('ships on Fridays')]);
    expect(block.startsWith(DEFAULT_MEMORY_HEADER)).toBe(true);
    expect(block).toContain('1. uses Neovim');
    expect(block).toContain('2. ships on Fridays');
  });

  it('returns an empty string when nothing survives', () => {
    expect(formatMemoryBlock([])).toBe('');
    expect(formatMemoryBlock([hit('   ')])).toBe('');
  });

  it('accepts a custom header', () => {
    expect(formatMemoryBlock([hit('x')], '## Recalled')).toContain('## Recalled');
  });
});

describe('headerAlreadyPresent', () => {
  it('spots the header anywhere in the haystack', () => {
    expect(headerAlreadyPresent('# Mem', ['nope', 'prefix # Mem suffix'])).toBe(true);
  });

  it('ignores non-strings', () => {
    expect(headerAlreadyPresent('# Mem', [undefined, 42, { a: 1 }, ['# Mem']])).toBe(false);
  });
});
