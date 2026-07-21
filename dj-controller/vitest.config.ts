import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		environment: 'node',
		setupFiles: ['./vitest.setup.ts'],
		include: ['src/**/*.test.ts'],
	},
	resolve: {
		alias: {
			'@common': resolve(__dirname, '../shared'),
		},
	},
});
