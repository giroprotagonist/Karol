import { expect, test } from '@playwright/test';
import { apiPost, ensurePlayerTab, openController, seedDemoQueue } from './helpers';

test.describe('Native bridge wiring (S24 WebView path)', () => {
	test.beforeEach(async ({ page, request }) => {
		await seedDemoQueue(request, 2);
		await page.addInitScript(() => {
			const publishes: unknown[] = [];
			const volumes: number[] = [];
			(window as unknown as { __nativePublishes: unknown[] }).__nativePublishes = publishes;
			(window as unknown as { __nativeVolumes: number[] }).__nativeVolumes = volumes;
			window.DeskreenNative = {
				onConnectionState: () => {},
				hapticLight: () => {},
				publishNowPlaying: (json: string) => {
					publishes.push(JSON.parse(json));
				},
				setRemoteVolume: (level: number) => {
					volumes.push(level);
				},
				ctrlDbg: () => {},
			};
		});
		await openController(page);
	});

	test('transport skip publishes now-playing to native', async ({ page }) => {
		await ensurePlayerTab(page);
		await page.getByRole('button', { name: 'Next' }).click();
		await expect
			.poll(async () => {
				return page.evaluate(() => (window as unknown as { __nativePublishes: unknown[] }).__nativePublishes.length);
			})
			.toBeGreaterThan(0);
		const last = await page.evaluate(() => {
			const list = (window as unknown as { __nativePublishes: { videoId?: string }[] }).__nativePublishes;
			return list[list.length - 1];
		});
		expect(last).toHaveProperty('videoId');
	});

	test('volume slider routes through setRemoteVolume on native', async ({ page }) => {
		await ensurePlayerTab(page);
		const volume = page.locator('input.volume[type="range"]');
		await volume.fill('0.6');
		await expect
			.poll(async () => {
				return page.evaluate(() => (window as unknown as { __nativeVolumes: number[] }).__nativeVolumes.length);
			})
			.toBeGreaterThan(0);
		const levels = await page.evaluate(() => (window as unknown as { __nativeVolumes: number[] }).__nativeVolumes);
		expect(levels[levels.length - 1]).toBeCloseTo(0.6, 1);
	});

	test('native now-playing push updates in-app display', async ({ page }) => {
		await ensurePlayerTab(page);
		await page.evaluate(() => {
			window.__deskreenNativeNowPlaying?.({
				title: 'Relay Test Track',
				videoId: 'jNQXAC9IVRw',
				currentTime: 42,
				duration: 120,
				state: 1,
			});
		});
		await expect(page.getByText('Relay Test Track')).toBeVisible({ timeout: 5000 });
	});
});
