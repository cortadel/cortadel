import { describe, expect, it } from 'vitest';
import type { AgentInputItem } from '@openai/agents';

import { itemRole, itemText, lastUserIndex, lastUserText, messagePairs } from '../src/items.js';
import { assistantMessage, userMessage } from './helpers.js';

describe('itemRole', () => {
  it('reads the shorthand message shape', () => {
    expect(itemRole({ role: 'user', content: 'hi' })).toBe('user');
  });

  it('reads the expanded message shape', () => {
    expect(itemRole({ type: 'message', role: 'system', content: 'be nice' })).toBe('system');
  });

  it('rejects non-message items', () => {
    expect(itemRole({ type: 'function_call', name: 'x', callId: 'c', arguments: '{}' })).toBeUndefined();
    expect(itemRole({ type: 'reasoning', content: [] })).toBeUndefined();
  });

  it('rejects things that are not objects', () => {
    expect(itemRole('hi')).toBeUndefined();
    expect(itemRole(null)).toBeUndefined();
    expect(itemRole(['a'])).toBeUndefined();
  });
});

describe('itemText', () => {
  it('returns trimmed string content', () => {
    expect(itemText({ role: 'user', content: '  hello  ' })).toBe('hello');
  });

  it('flattens multi-part content and keeps only text parts', () => {
    expect(
      itemText({
        role: 'user',
        content: [
          { type: 'input_text', text: 'line one' },
          { type: 'input_image', image: 'data:...' },
          { type: 'input_text', text: 'line two' },
        ],
      }),
    ).toBe('line one\nline two');
  });

  it('reads assistant output_text and skips refusals', () => {
    expect(
      itemText({
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: 'answer' },
          { type: 'refusal', refusal: 'no' },
        ],
      }),
    ).toBe('answer');
  });

  it('returns empty for an image-only turn', () => {
    expect(itemText({ role: 'user', content: [{ type: 'input_image', image: 'x' }] })).toBe('');
  });

  it('returns empty for items with no content', () => {
    expect(itemText({ type: 'function_call', name: 'x' })).toBe('');
    expect(itemText(undefined)).toBe('');
  });
});

describe('messagePairs', () => {
  it('keeps only user and assistant messages that carry text', () => {
    const items: AgentInputItem[] = [
      { role: 'system', content: 'be nice' },
      userMessage('what editor do I use?'),
      { type: 'function_call', name: 'lookup', callId: 'c1', arguments: '{}' } as AgentInputItem,
      assistantMessage('Neovim.'),
      { role: 'user', content: [{ type: 'input_image', image: 'x' }] },
    ];

    expect(messagePairs(items)).toEqual([
      { role: 'user', text: 'what editor do I use?' },
      { role: 'assistant', text: 'Neovim.' },
    ]);
  });

  it('handles an empty or missing list', () => {
    expect(messagePairs([])).toEqual([]);
    expect(messagePairs(undefined)).toEqual([]);
  });
});

describe('lastUserIndex / lastUserText', () => {
  it('finds the most recent user message with text', () => {
    const items: AgentInputItem[] = [
      userMessage('first'),
      assistantMessage('reply'),
      userMessage('second'),
    ];
    expect(lastUserIndex(items)).toBe(2);
    expect(lastUserText(items)).toBe('second');
  });

  it('skips a trailing user message that carries no text', () => {
    const items: AgentInputItem[] = [
      userMessage('the real question'),
      { role: 'user', content: [{ type: 'input_image', image: 'x' }] },
    ];
    expect(lastUserIndex(items)).toBe(0);
    expect(lastUserText(items)).toBe('the real question');
  });

  it('returns undefined when there is no user message', () => {
    expect(lastUserIndex([assistantMessage('hi')])).toBeUndefined();
    expect(lastUserText([assistantMessage('hi')])).toBeUndefined();
  });
});
