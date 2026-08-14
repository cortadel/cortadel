// Copies node/credential assets that `tsc` leaves behind (icons and codex metadata)
// into dist/, preserving their relative paths. Zero dependencies on purpose — n8n's
// verified-community-node rules forbid run-time dependencies, and there is no reason
// to add a build-time one for a directory walk.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirs = ['credentials', 'nodes'];
const assetSuffixes = ['.svg', '.png', '.node.json'];

async function walk(dir) {
	const out = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else if (assetSuffixes.some((suffix) => entry.name.endsWith(suffix))) out.push(full);
	}
	return out;
}

let copied = 0;
for (const sourceDir of sourceDirs) {
	for (const file of await walk(join(root, sourceDir))) {
		const target = join(root, 'dist', relative(root, file));
		await mkdir(dirname(target), { recursive: true });
		await cp(file, target);
		copied += 1;
	}
}
console.log(`copy-assets: copied ${copied} asset(s) into dist/`);
