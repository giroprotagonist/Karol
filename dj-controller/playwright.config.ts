import { defineConfig, devices } from '@playwright/test';

const host = process.env.DESKREEN_HOST || 'http://127.0.0.1:3131';
const baseURL = `${host.replace(/\/+$/, '')}/dj-controller/`;

export default defineConfig({
	testDir: './e2e',
	timeout: 60_000,
	expect: { timeout: 15_000 },
	retries: process.env.CI ? 1 : 0,
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL,
		trace: 'on-first-retry',
		actionTimeout: 12_000,
	},
	projects: [
		{
			name: 'galaxy-s8',
			use: { ...devices['Galaxy S8'] },
		},
		{
			name: 'galaxy-s24',
			use: { ...devices['Galaxy S24'] },
		},
	],
});
