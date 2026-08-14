import type {
	IAuthenticate,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Credential for a Cortadel server — hosted (`https://app.cortadel.ai`) or
 * self-hosted (`docker compose up` → `http://localhost:3001`).
 *
 * The API key is optional on purpose: a self-hosted Cortadel with an empty
 * `Auth:Secret` leaves every REST endpoint open.
 *
 * That optionality is why `authenticate` is the **function** form rather than the
 * declarative `IAuthenticateGeneric` one. The declarative form can only ever set a
 * header, so a blank key still puts `Authorization: ` (empty value) on every
 * request — accepted by Cortadel, but rejected outright by some reverse proxies.
 * The function form can omit the header entirely. n8n supports both:
 * `packages/cli/src/credentials-helper.ts` `authenticate()` branches on
 * `typeof credentialType.authenticate === 'function'` first, and the function
 * branch does not require a workflow/node context (the declarative one does).
 */
export class CortadelApi implements ICredentialType {
	name = 'cortadelApi';

	displayName = 'Cortadel API';

	icon: Icon = 'file:cortadel.svg';

	documentationUrl = 'https://github.com/cortadel/cortadel';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:3001',
			required: true,
			placeholder: 'https://app.cortadel.ai',
			description:
				'Base URL of the Cortadel server. Use https://app.cortadel.ai for the hosted service, or http://localhost:3001 for a local docker compose up.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Sent as Authorization: Bearer &lt;key&gt;. Leave blank for a self-hosted server that runs with authentication disabled.',
		},
	];

	authenticate: IAuthenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const apiKey = typeof credentials.apiKey === 'string' ? credentials.apiKey.trim() : '';
		if (apiKey) {
			requestOptions.headers = {
				...requestOptions.headers,
				Authorization: `Bearer ${apiKey}`,
			};
		}
		return requestOptions;
	};

	/**
	 * `GET /api/health` is the only unauthenticated-safe, parameter-free endpoint in
	 * the public contract (every `/api/v1/memories*` route requires a `user_id`).
	 *
	 * Caveat worth knowing: Cortadel answers 503 with a `HealthResponse` body when a
	 * dependency is degraded, so this test reports failure against a *reachable but
	 * degraded* server. That is a server-health signal, not necessarily a bad key.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.baseUrl }}',
			url: '/api/health',
			method: 'GET',
		},
	};
}
