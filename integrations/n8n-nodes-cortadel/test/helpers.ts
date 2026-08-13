import { vi } from 'vitest';

/**
 * Offline test doubles for the two n8n execution contexts this package uses.
 * Nothing here touches the network, the filesystem, or any CORTADEL_* env var.
 */

export interface RecordedRequest {
	credentialType: string;
	method?: string;
	url?: string;
	baseURL?: string;
	body?: unknown;
	qs?: Record<string, unknown>;
	headers?: Record<string, unknown>;
}

export interface FakeContextOptions {
	params?: Record<string, unknown>;
	credentials?: Record<string, unknown>;
	inputData?: Array<{ json: Record<string, unknown> }>;
	continueOnFail?: boolean;
	/** Queue of responses (or thrown errors) returned in order, one per request. */
	responses?: unknown[];
}

export interface FakeContext {
	requests: RecordedRequest[];
	warnings: string[];
	traceInputs: unknown[];
	traceOutputs: unknown[];
	getCredentials: (name: string) => Promise<Record<string, unknown>>;
	getNode: () => Record<string, unknown>;
	getNodeParameter: (name: string, index: number, fallback?: unknown) => unknown;
	getInputData: () => Array<{ json: Record<string, unknown> }>;
	continueOnFail: () => boolean;
	addInputData: (type: string, data: unknown) => { index: number };
	addOutputData: (type: string, index: number, data: unknown) => void;
	logger: { warn: (m: string) => void; error: (m: string) => void; info: (m: string) => void; debug: (m: string) => void };
	helpers: { httpRequestWithAuthentication: ReturnType<typeof vi.fn> };
}

export const TEST_USER = 'e2e-n8n-cortadel';
export const TEST_SESSION = 'e2e-n8n-session-1';

export function createFakeContext(options: FakeContextOptions = {}): FakeContext {
	const params = options.params ?? {};
	const responses = [...(options.responses ?? [])];
	const requests: RecordedRequest[] = [];
	const warnings: string[] = [];
	const traceInputs: unknown[] = [];
	const traceOutputs: unknown[] = [];
	let traceIndex = 0;

	const httpRequestWithAuthentication = vi.fn(async function (
		credentialType: string,
		requestOptions: RecordedRequest,
	) {
		requests.push({ ...requestOptions, credentialType });
		if (responses.length === 0) return {};
		const next = responses.shift();
		if (next instanceof Error) throw next;
		return next;
	});

	return {
		requests,
		warnings,
		traceInputs,
		traceOutputs,
		getCredentials: async () => options.credentials ?? { baseUrl: 'http://localhost:3001' },
		getNode: () => ({
			id: 'test-node',
			name: 'Cortadel',
			type: 'n8n-nodes-cortadel.cortadel',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		getNodeParameter: (name: string, _index: number, fallback?: unknown) =>
			Object.prototype.hasOwnProperty.call(params, name) ? params[name] : fallback,
		getInputData: () => options.inputData ?? [{ json: {} }],
		continueOnFail: () => options.continueOnFail === true,
		addInputData: (_type: string, data: unknown) => {
			traceInputs.push(data);
			return { index: traceIndex++ };
		},
		addOutputData: (_type: string, _index: number, data: unknown) => {
			traceOutputs.push(data);
		},
		logger: {
			warn: (m: string) => warnings.push(m),
			error: () => undefined,
			info: () => undefined,
			debug: () => undefined,
		},
		helpers: { httpRequestWithAuthentication },
	};
}
