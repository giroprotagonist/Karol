import { expect, test } from '@playwright/test';
import { apiGet, apiPost, ensurePlayerTab, openController, seedDemoQueue } from './helpers';

test.describe('Playback flow (API seed + UI)', () => {
	test.beforeEach(async ({ page, request }) => {
		await seedDemoQueue(request, 3);
		await openController(page);
	});

	test('queue section reflects seeded tracks', async ({ page }) => {
		await expect(page.locator('.queue-item')).toHaveCount(3, { timeout: 15_000 });
		await expect(page.locator('.status-chip').filter({ hasText: 'Now' })).toBeVisible();
	});

	test('skip next from UI advances without error', async ({ page, request }) => {
		const beforeRes = await apiGet(request, '/queue');
		const before = (await beforeRes.json()) as { currentIndex?: number };
		await page.getByRole('button', { name: 'Next' }).click();
		await expect(page.locator('.error-banner')).toHaveCount(0);
		await expect
			.poll(
				async () => {
					const afterRes = await apiGet(request, '/queue');
					const after = (await afterRes.json()) as { currentIndex?: number };
					return after.currentIndex;
				},
				{ timeout: 30_000 },
			)
			.not.toBe(before.currentIndex);
	});

	test('seek relative buttons do not surface errors', async ({ page }) => {
		await page.getByRole('button', { name: '+10' }).click();
		await page.getByRole('button', { name: '−10' }).click();
		await expect(page.locator('.error-banner')).toHaveCount(0);
	});

	test('volume slider updates display immediately', async ({ page }) => {
		const volume = page.locator('input.volume[type="range"]');
		await expect(volume).toBeEnabled();
		await volume.fill('0.75');
		await expect(page.locator('.volume-value')).toHaveText('75%');
		await expect(page.locator('.error-banner')).toHaveCount(0);
	});

	test('mode toggles shuffle and manual DJ without errors', async ({ page }) => {
		const shuffle = page.getByRole('checkbox', { name: 'Shuffle' });
		const manual = page.getByRole('checkbox', { name: 'Manual DJ' });
		await shuffle.check();
		await expect(page.locator('.mode-badge')).toContainText('Shuffle');
		await manual.check();
		await expect(shuffle).toBeDisabled();
		await manual.uncheck();
		await expect(page.locator('.error-banner')).toHaveCount(0);
	});

	test('API volume change reflected after status poll', async ({ page, request }) => {
		const res = await apiPost(request, '/transport/volume', { level: 0.25 });
		expect(res.ok()).toBeTruthy();
		await expect(page.locator('.volume-value')).toHaveText('25%', { timeout: 18_000 });
	});
});
