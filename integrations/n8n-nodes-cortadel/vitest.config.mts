import { defineConfig } from 'vitest/config';

export default defineConfig({
	// n8n-workflow ships sourcemaps that point at files absent from the npm tarball,
	// which makes Vite emit one warning per module. Nothing to fix on our side.
	logLevel: 'error',
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
	},
});
