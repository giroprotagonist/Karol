import { expect, test } from '@playwright/test';
import { apiPost, ensurePlayerTab, openController, waitForConnected } from './helpers';

test.describe('Karol unified controller UI', () => {
	test.beforeEach(async ({ page }) => {
		await openController(page);
	});

	test('loads shell and connects to tablet host', async ({ page }) => {
		await expect(page.getByRole('heading', { name: 'Karol' })).toBeVisible();
		const pill = page.locator('.status-pill');
		await expect(pill).toContainText('Connected');
	});

	test('all main sections are visible in single view', async ({ page }) => {
		// Player, Queue, Add Music, and Playlists are all visible without tabs
		await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Add Music' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Playlists' })).toBeVisible();
	});

	test('queue section renders card', async ({ page }) => {
		await expect(page.locator('.queue-card')).toBeVisible();
	});

	test('transport controls respond without error banner', async ({ page }) => {
		const next = page.getByRole('button', { name: 'Next' });
		await expect(next).toBeVisible();
		await next.click();
		await expect(page.locator('.error-banner')).toHaveCount(0);
		const pauseOrPlay = page.getByRole('button', { name: /Pause|Play/ }).first();
		await pauseOrPlay.click();
		await expect(page.locator('.error-banner')).toHaveCount(0);
	});

	test('add URL buttons disabled when input empty', async ({ page }) => {
		const queueBtn = page.getByRole('button', { name: '+ Queue' });
		await expect(queueBtn).toBeDisabled();
		const playNowBtn = page.getByRole('button', { name: '▶ Play now' });
		await expect(playNowBtn).toBeDisabled();
	});

	test('add URL buttons enabled when input filled', async ({ page }) => {
		await page.getByPlaceholder('Paste YouTube URL or video ID').fill('jNQXAC9IVRw');
		await expect(page.getByRole('button', { name: '+ Queue' })).toBeEnabled();
		await expect(page.getByRole('button', { name: '▶ Play now' })).toBeEnabled();
	});

	test('SSE session updates after API skip (UI stays connected)', async ({ page, request }) => {
		ensurePlayerTab(page);
		const res = await apiPost(request, '/transport/skip-next');
		expect(res.ok()).toBeTruthy();
		await waitForConnected(page);
		await expect(page.locator('.error-banner')).toHaveCount(0);
	});
});
