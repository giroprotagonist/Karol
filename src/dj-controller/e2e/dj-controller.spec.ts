import { expect, test } from '@playwright/test';
import { apiPost, ensurePlayerTab, openController, waitForConnected } from './helpers';

test.describe('Karol controller UI', () => {
	test.beforeEach(async ({ page }) => {
		await openController(page);
	});

	test('loads shell and connects to tablet host', async ({ page }) => {
		await expect(page.getByRole('heading', { name: 'Karol' })).toBeVisible();
		const pill = page.locator('.status-pill');
		await expect(pill).toContainText('Connected');
	});

	test('all main tabs render', async ({ page }) => {
		const nav = page.getByRole('navigation', { name: 'Sections' });
		for (const tab of ['Player', 'Queue', 'Add', 'Playlist']) {
			await nav.getByRole('button', { name: tab }).click();
			await expect(nav.getByRole('button', { name: tab })).toHaveClass(/active/);
		}
	});

	test('queue tab shows list or empty state', async ({ page }) => {
		await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Queue' }).click();
		await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();
		await expect(page.locator('.queue-card')).toBeVisible();
	});

	test('transport controls respond without error banner', async ({ page }) => {
		await ensurePlayerTab(page);
		const next = page.getByRole('button', { name: 'Next' });
		await expect(next).toBeVisible();
		await next.click();
		await expect(page.locator('.error-banner')).toHaveCount(0);
		const pauseOrPlay = page.getByRole('button', { name: /Pause|Play/ }).first();
		await pauseOrPlay.click();
		await expect(page.locator('.error-banner')).toHaveCount(0);
	});

	test('add tab queue button disabled when input empty', async ({ page }) => {
		await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Add' }).click();
		const queueBtn = page.getByRole('button', { name: '+ Queue' });
		await expect(queueBtn).toBeDisabled();
		const playNowBtn = page.getByRole('button', { name: '▶ Play now' });
		await expect(playNowBtn).toBeDisabled();
	});

	test('add tab enables actions when URL entered', async ({ page }) => {
		await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Add' }).click();
		await page.getByPlaceholder('Paste YouTube URL or video ID').fill('jNQXAC9IVRw');
		await expect(page.getByRole('button', { name: '+ Queue' })).toBeEnabled();
		await expect(page.getByRole('button', { name: '▶ Play now' })).toBeEnabled();
	});

	test('playlist tab renders library shell', async ({ page }) => {
		await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Playlist' }).click();
		await expect(page.getByRole('heading', { name: 'Show Playlists' })).toBeVisible();
	});

	test('SSE session updates after API skip (UI stays connected)', async ({ page, request }) => {
		await ensurePlayerTab(page);
		const res = await apiPost(request, '/transport/skip-next');
		expect(res.ok()).toBeTruthy();
		await waitForConnected(page);
		await expect(page.locator('.error-banner')).toHaveCount(0);
	});
});
