import { describe, expect, it } from 'vitest';

import { CortadelApi } from '../credentials/CortadelApi.credentials';
import { CORTADEL_CREDENTIALS } from '../shared/transport';

describe('CortadelApi credential', () => {
	const credential = new CortadelApi();

	it('uses the credential name every node references', () => {
		expect(credential.name).toBe(CORTADEL_CREDENTIALS);
		expect(credential.name).toBe('cortadelApi');
	});

	it('exposes base URL and API key, defaulting to a local self-hosted server', () => {
		const names = credential.properties.map((p) => p.name);
		expect(names).toEqual(['baseUrl', 'apiKey']);

		const baseUrl = credential.properties.find((p) => p.name === 'baseUrl');
		expect(baseUrl?.default).toBe('http://localhost:3001');
		expect(baseUrl?.required).toBe(true);

		const apiKey = credential.properties.find((p) => p.name === 'apiKey');
		expect(apiKey?.typeOptions?.password).toBe(true);
		// Optional: self-hosted Cortadel can run with authentication disabled.
		expect(apiKey?.required).toBeUndefined();
	});

	// These drive the real `authenticate` function the way n8n's CredentialsHelper does
	// (`credentials-helper.ts` calls `credentialType.authenticate(credentials, requestOptions)`),
	// so they assert behaviour rather than restating the class's own literals.
	const authenticate = credential.authenticate as (
		credentials: Record<string, unknown>,
		requestOptions: { url: string; headers?: Record<string, unknown> },
	) => Promise<{ url: string; headers?: Record<string, unknown> }>;

	it('sends the key as a bearer token', async () => {
		const result = await authenticate(
			{ baseUrl: 'http://localhost:3001', apiKey: 'e2e-not-a-real-key' },
			{ url: '/api/health' },
		);
		expect(result.headers?.Authorization).toBe('Bearer e2e-not-a-real-key');
	});

	it('omits the header entirely when no key is configured', async () => {
		for (const apiKey of ['', '   ', undefined]) {
			const result = await authenticate({ baseUrl: 'http://localhost:3001', apiKey }, {
				url: '/api/health',
			});
			// Not `Authorization: ""` — the header must not be present at all, because
			// some reverse proxies reject an empty Authorization value outright.
			expect(Object.keys(result.headers ?? {})).not.toContain('Authorization');
		}
	});

	it('preserves headers the caller already set', async () => {
		const result = await authenticate(
			{ apiKey: 'e2e-not-a-real-key' },
			{ url: '/api/health', headers: { 'User-Agent': 'n8n-nodes-cortadel/0.1.0' } },
		);
		expect(result.headers?.['User-Agent']).toBe('n8n-nodes-cortadel/0.1.0');
		expect(result.headers?.Authorization).toBe('Bearer e2e-not-a-real-key');
	});

	it('tests the credential against GET /api/health', () => {
		expect(credential.test.request.baseURL).toBe('={{ $credentials.baseUrl }}');
		expect(credential.test.request.url).toBe('/api/health');
		expect(credential.test.request.method).toBe('GET');
	});
});
