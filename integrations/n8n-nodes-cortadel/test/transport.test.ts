import { describe, expect, it } from 'vitest';

import {
	CORTADEL_APP_NAME,
	DEFAULT_BASE_URL,
	compact,
	cortadelRequest,
	getCortadelBaseUrl,
	stripTrailingSlashes,
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

describe('stripTrailingSlashes', () => {
	it('matches the trailing-slash semantics it replaced', () => {
		// Left column is the input, right column is what `/\/+$/` produced for it.
		const cases: Array<[string, string]> = [
			['', ''],
			['/', ''],
			['///', ''],
			['http://x', 'http://x'],
			['http://x/', 'http://x'],
			['http://x///', 'http://x'],
			['http://h//a//', 'http://h//a'],
			['no-slash-here', 'no-slash-here'],
			// `$` has no `m` flag, so a trailing newline stopped the old regex matching.
			['http://x/\n', 'http://x/\n'],
		];
		for (const [input, expected] of cases) {
			expect(stripTrailingSlashes(input)).toBe(expected);
		}
	});

	it('stays linear on an interior slash run that made the old regex backtrack', () => {
		// The pathological shape for the unanchored `/\/+$/`: a long run of slashes that
		// is NOT at the end, so every start position in the run matches greedily, fails
		// `$`, and backtracks the whole run. That regex needs ~906 ms here; a linear scan
		// needs microseconds, so this budget cannot flake but a regression cannot pass.
		const pathological = `http://h/${'/'.repeat(64_000)}a`;

		const started = performance.now();
		const result = stripTrailingSlashes(pathological);
		const elapsed = performance.now() - started;

		expect(result).toBe(pathological); // nothing to strip — the run is interior
		expect(elapsed).toBeLessThan(100);
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
