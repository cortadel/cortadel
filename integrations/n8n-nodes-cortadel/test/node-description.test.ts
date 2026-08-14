import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Cortadel } from '../nodes/Cortadel/Cortadel.node';
import { CortadelMemory } from '../nodes/CortadelMemory/CortadelMemory.node';
import { CORTADEL_APP_NAME } from '../shared/transport';

/**
 * n8n's node linter enforces alphabetical ordering inside `collection` options and
 * inside `options`-type choice lists (`node-param-collection-type-unsorted-items`,
 * `node-param-options-type-unsorted-items`). Getting it wrong blocks verification,
 * and it is exactly the sort of thing that rots when an option is inserted by hand.
 */
function expectSortedRecursively(properties: any[]): void {
	for (const property of properties) {
		const entries: any[] = property.options ?? [];
		if (property.type === 'collection' || property.type === 'fixedCollection') {
			const names = entries.map((o) => o.displayName ?? o.name);
			expect(names, `unsorted collection: ${property.name}`).toEqual([...names].sort());
		} else if (property.type === 'options' && entries.every((o) => 'value' in o)) {
			const names = entries.map((o) => o.name);
			expect(names, `unsorted options: ${property.name}`).toEqual([...names].sort());
		}
		for (const option of entries) {
			if (Array.isArray(option.values)) expectSortedRecursively(option.values);
			else if (option.name && option.type) expectSortedRecursively([option]);
		}
	}
}

const packageJson = JSON.parse(
	readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as Record<string, any>;

describe('package manifest follows n8n community node rules', () => {
	it('is named with the required n8n-nodes- prefix', () => {
		expect(packageJson.name.startsWith('n8n-nodes-')).toBe(true);
	});

	it('carries the discovery keyword', () => {
		expect(packageJson.keywords).toContain('n8n-community-node-package');
	});

	it('declares the n8n block with compiled dist paths', () => {
		expect(packageJson.n8n.n8nNodesApiVersion).toBe(1);
		expect(packageJson.n8n.credentials).toEqual(['dist/credentials/CortadelApi.credentials.js']);
		expect(packageJson.n8n.nodes).toEqual([
			'dist/nodes/Cortadel/Cortadel.node.js',
			'dist/nodes/CortadelMemory/CortadelMemory.node.js',
		]);
		for (const entry of [...packageJson.n8n.credentials, ...packageJson.n8n.nodes]) {
			expect(entry.startsWith('dist/')).toBe(true);
			expect(entry.endsWith('.js')).toBe(true);
		}
	});

	it('takes n8n-workflow as a peer dependency and ships zero run-time dependencies', () => {
		expect(packageJson.peerDependencies['n8n-workflow']).toBeDefined();
		// Verified community nodes are not allowed run-time dependencies.
		expect(packageJson.dependencies).toBeUndefined();
	});

	it('publishes publicly with provenance and no author field', () => {
		// Repo-wide convention, matching sdk/typescript: provenance on, no `author`.
		expect(packageJson.publishConfig).toEqual({ access: 'public', provenance: true });
		expect(packageJson.author).toBeUndefined();
	});

	it('labels itself to Cortadel with its own published package name', () => {
		// `app_name` on searches and `app` on writes. An access log entry should name
		// something a reader can actually install.
		expect(CORTADEL_APP_NAME).toBe(packageJson.name);
	});
});

describe('Cortadel action node', () => {
	const node = new Cortadel();

	it('is usable as an AI Agent tool', () => {
		expect(node.description.usableAsTool).toBe(true);
	});

	it('is a main-to-main node bound to the Cortadel credential', () => {
		expect(node.description.inputs).toEqual(['main']);
		expect(node.description.outputs).toEqual(['main']);
		expect(node.description.credentials).toEqual([{ name: 'cortadelApi', required: true }]);
		expect(node.description.icon).toBe('file:cortadel.svg');
	});

	it('exposes exactly the six operations the Cortadel surface supports', () => {
		const operation = node.description.properties.find((p) => p.name === 'operation');
		const values = (operation?.options ?? []).map((o: any) => o.value).sort();
		expect(values).toEqual(['add', 'addConversation', 'delete', 'get', 'list', 'search']);
	});

	it('requires a user id, because memories are namespaced per user', () => {
		const userId = node.description.properties.find((p) => p.name === 'userId');
		expect(userId?.required).toBe(true);
	});

	it('lets every Memory Type filter be cleared back to Any', () => {
		// A user who adds this option in the UI must be able to get back to "no
		// filter" without removing the option again — and the blank must be what the
		// property defaults to, so merely adding it changes nothing.
		const memoryTypeProps: any[] = [];
		const walk = (properties: any[]): void => {
			for (const property of properties) {
				if (property.name === 'memoryType') memoryTypeProps.push(property);
				for (const option of property.options ?? []) {
					if (Array.isArray(option.values)) walk(option.values);
					else if (option.name && option.type) walk([option]);
				}
			}
		};
		walk(node.description.properties);

		// Add, Search and List each expose one.
		expect(memoryTypeProps).toHaveLength(3);
		for (const property of memoryTypeProps) {
			expect(property.default).toBe('');
			expect(property.options.map((o: any) => o.value)).toContain('');
		}
	});

	it('keeps every option list alphabetical, as the n8n node linter requires', () => {
		expectSortedRecursively(node.description.properties);
	});

	it('gives every property a default, as the n8n node linter requires', () => {
		const walk = (properties: any[]): void => {
			for (const property of properties) {
				expect(property, `missing default on ${property.name}`).toHaveProperty('default');
				if (Array.isArray(property.options)) {
					for (const option of property.options) {
						if (Array.isArray(option.values)) walk(option.values);
						else if (option.name && option.type) walk([option]);
					}
				}
			}
		};
		walk(node.description.properties);
	});
});

describe('Cortadel Memory sub-node', () => {
	const node = new CortadelMemory();

	it('outputs the ai_memory connection the AI Agent memory port accepts', () => {
		expect(node.description.inputs).toEqual([]);
		expect(node.description.outputs).toEqual(['ai_memory']);
		expect(node.description.outputNames).toEqual(['Memory']);
	});

	it('files itself under AI > Memory in the nodes panel', () => {
		expect(node.description.codex?.categories).toContain('AI');
		expect(node.description.codex?.subcategories?.AI).toContain('Memory');
	});

	it('has no execute method — it supplies data instead', () => {
		expect(typeof node.supplyData).toBe('function');
		expect((node as any).execute).toBeUndefined();
	});

	it('asks for the user id separately from the session id', () => {
		const names = node.description.properties.map((p) => p.name);
		expect(names).toContain('userId');
		expect(names).toContain('sessionId');
		expect(names).toContain('scopeRecallToSession');
	});

	it('recalls across the whole user graph unless recall is scoped to the session', () => {
		const scope = node.description.properties.find((p) => p.name === 'scopeRecallToSession');
		expect(scope?.type).toBe('boolean');
		expect(scope?.default).toBe(false);
	});

	it('injects memories at the default Top K the canon sets for automatic recall', () => {
		const topK = node.description.properties.find((p) => p.name === 'topK');
		expect(topK?.default).toBe(5);
	});

	it('keeps every option list alphabetical, as the n8n node linter requires', () => {
		expectSortedRecursively(node.description.properties);
	});

	it('defaults the recalled context to the one role no provider rejects', () => {
		// The default has to be `user`: a system-role injection is a hard throw on the
		// Anthropic Chat Model, and this node's headline promise is that memory degrades
		// rather than breaking the agent. `system` stays selectable.
		const options = node.description.properties.find((p) => p.name === 'options');
		const contextRole: any = (options?.options ?? []).find((o: any) => o.name === 'contextRole');
		expect(contextRole.default).toBe('user');
		expect(contextRole.options.map((o: any) => o.value)).toEqual(['system', 'user']);
		expect(String(contextRole.description)).toMatch(/anthropic/i);
	});

	it('offers the same Memory Type choices as the action node', () => {
		const options = node.description.properties.find((p) => p.name === 'options');
		const memoryType: any = (options?.options ?? []).find((o: any) => o.name === 'memoryType');
		expect(memoryType.default).toBe('');
		expect(memoryType.options.map((o: any) => o.value)).toEqual([
			'',
			'episodic',
			'procedural',
			'semantic',
		]);
	});
});
