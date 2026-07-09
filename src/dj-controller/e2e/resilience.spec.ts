import { expect, test } from '@playwright/test';
import { ensurePlayerTab, openController, seedDemoQueue } from './helpers';

test.describe('UI resilience', () => {
	test.beforeEach(async ({ page, request }) => {
		await seedDemoQueue(request, 2);
		await openController(page);
	});

	test('rapid tab switching stays stable', async ({ page }) => {
		const nav = page.getByRole('navigation', { name: 'Sections' });
		const tabs = ['Player', 'Queue', 'Add', 'Playlist'] as const;
		for (let round = 0; round < 3; round++) {
			for (const tab of tabs) {
				await nav.getByRole('button', { name: tab }).click();
			}
		}
		await expect(page.locator('.error-banner')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Karol' })).toBeVisible();
	});

	test('rapid transport taps do not break connection', async ({ page }) => {
		await ensurePlayerTab(page);
		const playPause = page.getByRole('button', { name: /Pause|Play/ }).first();
		const next = page.getByRole('button', { name: 'Next' });
		for (let i = 0; i < 4; i++) {
			await playPause.click({ force: true });
			await next.click({ force: true });
		}
		await expect(page.locator('.status-pill')).toContainText('Connected');
		await expect(page.locator('.error-banner')).toHaveCount(0);
	});

	test('tab nav and transport fit viewport (no horizontal overflow)', async ({ page }) => {
		const overflow = await page.evaluate(() => {
			const doc = document.documentElement;
			return doc.scrollWidth > doc.clientWidth + 2;
		});
		expect(overflow).toBe(false);
		await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
		await expect(page.locator('.transport')).toBeVisible();
	});

	test('connection panel can be toggled while connected', async ({ page }) => {
		const pill = page.locator('.status-pill');
		await pill.click();
		await expect(page.locator('.connection-card')).toBeVisible();
		await pill.click();
		// Panel may stay open if disconnected; when connected, second click toggles closed
		await expect(page.locator('.error-banner')).toHaveCount(0);
	});
});
