import { describe, expect, it } from 'vitest';

import {
	CORTADEL_APP_NAME,
	DEFAULT_BASE_URL,
	compact,
	cortadelRequest,
	getCortadelBaseUrl,
} from '../shared/transport';
import { createFakeContext } from './helpers';

describe('base URL handling', () => {
	it('strips trailing slashes', async () => {
		const ctx = createFakeContext({ credentials: { baseUrl: 'https://app.cortadel.ai///' } });
		expect(await getCortadelBaseUrl(ctx as any)).toBe('https://app.cortadel.ai');
	});

	it('falls back to a local self-hosted server when blank', async () => {
		const ctx = createFakeContext({ credentials: { baseUrl: '   ' } });
		expect(await getCortadelBaseUrl(ctx as any)).toBe(DEFAULT_BASE_URL);
	});
});

describe('compact', () => {
	it('drops undefined, null, blank strings and empty arrays but keeps false and zero', () => {
		expect(
			compact({
				a: undefined,
				b: null,
				c: '   ',
				d: [],
				keptFalse: false,
				keptZero: 0,
				keptText: 'x',
				keptArray: ['y'],
			}),
		).toEqual({ keptFalse: false, keptZero: 0, keptText: 'x', keptArray: ['y'] });
	});

	it('drops an empty object — what n8n hands back for an untouched JSON field', () => {
		expect(compact({ metadata: {}, text: 'hi' })).toEqual({ text: 'hi' });
	});

	it('keeps an object that has any key at all', () => {
		expect(compact({ metadata: { source: 'n8n' } })).toEqual({ metadata: { source: 'n8n' } });
		expect(compact({ metadata: { nested: {} } })).toEqual({ metadata: { nested: {} } });
	});
});

describe('cortadelRequest', () => {
	it('routes through the credential-aware helper and tags the user agent', async () => {
		const ctx = createFakeContext({ responses: [{ ok: true }] });
		const result = await cortadelRequest<{ ok: boolean }>(ctx as any, {
			method: 'POST',
			url: '/api/v1/memories/search',
			body: { query: 'x' },
		});

		expect(result).toEqual({ ok: true });
		expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
		expect(ctx.requests[0].credentialType).toBe('cortadelApi');
		expect(ctx.requests[0].headers?.['User-Agent']).toContain(CORTADEL_APP_NAME);
	});

	it('never sends undefined query-string values', async () => {
		const ctx = createFakeContext({ responses: [{}] });
		await cortadelRequest(ctx as any, {
			method: 'GET',
			url: '/api/v1/memories',
			qs: { user_id: 'e2e-n8n-cortadel', app_id: undefined, page: 1 },
		});
		expect(ctx.requests[0].qs).toEqual({ user_id: 'e2e-n8n-cortadel', page: 1 });
	});

	it('wraps a raw transport failure with the failing route', async () => {
		const ctx = createFakeContext({ responses: [new Error('socket hang up')] });
		await expect(
			cortadelRequest(ctx as any, { method: 'GET', url: '/api/health' }),
		).rejects.toThrow();
	});
});
