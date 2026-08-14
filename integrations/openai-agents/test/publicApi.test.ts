/**
 * The package's public surface. A rename that breaks a documented import fails here.
 */

import { describe, expect, it } from 'vitest';

import * as pkg from '../src/index.js';
import { CortadelSession, cortadelMemoryTools, DEFAULT_APP_NAME } from '../src/index.js';
import { FakeCortadelClient, SESSION_ID, USER_ID, asClient } from './helpers.js';

describe('public exports', () => {
  it('exports exactly the documented value surface', () => {
    expect(Object.keys(pkg).sort()).toEqual(
      [
        'CortadelSession',
        'DEFAULT_APP_NAME',
        'DEFAULT_BASE_URL',
        'DEFAULT_MEMORY_HEADER',
        'buildClient',
        'cortadelMemoryTools',
        'formatMemoryBlock',
      ].sort(),
    );
  });

  it('names the integration after its published package for access logging', () => {
    expect(DEFAULT_APP_NAME).toBe('cortadel-openai-agents');
  });

  it('gives CortadelSession the whole Session interface', () => {
    const session = new CortadelSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      client: asClient(new FakeCortadelClient()),
    });

    for (const method of ['getSessionId', 'getItems', 'addItems', 'popItem', 'clearSession']) {
      expect(typeof (session as unknown as Record<string, unknown>)[method]).toBe('function');
    }
    for (const method of ['flush', 'close', 'tools', 'runOptions']) {
      expect(typeof (session as unknown as Record<string, unknown>)[method]).toBe('function');
    }
    expect(typeof session.callModelInputFilter).toBe('function');
  });

  it('produces real function tools from the standalone factory', () => {
    const tools = cortadelMemoryTools({ client: asClient(new FakeCortadelClient()) });
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.type).toBe('function');
    }
  });
});
