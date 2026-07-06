import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
	plugins: [react()],
	base: '/dj-controller/',
	build: {
		outDir: 'dist',
		emptyOutDir: true,
	},
	resolve: {
		alias: {
			'@common': resolve(__dirname, '../common'),
		},
	},
});
