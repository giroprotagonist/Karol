import type { APIRequestContext, Page } from '@playwright/test';

export const deskreenHost = () =>
	(process.env.DESKREEN_HOST || 'http://127.0.0.1:3131').replace(/\/+$/, '');

export const apiBase = () => `${deskreenHost()}/api/youtube-dj`;

const clientHeaders = {
	'Content-Type': 'application/json',
	'X-Deskreen-Client': 'DeskreenPlaywright/1.0',
};

export async function apiPost(
	request: APIRequestContext,
	path: string,
	body: Record<string, unknown> = {},
) {
	return request.post(`${apiBase()}${path}`, { headers: clientHeaders, data: body });
}

export async function apiGet(request: APIRequestContext, path: string) {
	return request.get(`${apiBase()}${path}`, { headers: clientHeaders });
}

export async function apiPatch(
	request: APIRequestContext,
	path: string,
	body: Record<string, unknown> = {},
) {
	return request.patch(`${apiBase()}${path}`, { headers: clientHeaders, data: body });
}

export async function clearQueue(request: APIRequestContext) {
	await apiPost(request, '/queue/clear');
}

/** Seed a short known-good queue for UI tests (Me at the zoo, etc.). */
export async function seedDemoQueue(request: APIRequestContext, count = 2) {
	const videos = ['jNQXAC9IVRw', 'dQw4w9WgXcQ', '9bZkp7q19f0'];
	await clearQueue(request);
	await apiPatch(request, '/shuffle', { enabled: false });
	await apiPost(request, '/mode', { mode: 'queue' });
	for (let i = 0; i < Math.min(count, videos.length); i++) {
		const res = await apiPost(request, '/queue', {
			url: `https://www.youtube.com/watch?v=${videos[i]}`,
			action: 'queue',
		});
		if (!res.ok()) {
			throw new Error(`Failed to seed queue item ${i}: ${res.status()}`);
		}
	}
	const queueRes = await apiGet(request, '/queue');
	const queueBody = (await queueRes.json()) as { queue?: { id: string }[] };
	const firstId = queueBody.queue?.[0]?.id;
	if (firstId) {
		await apiPost(request, `/queue/${encodeURIComponent(firstId)}/play`, {});
	}
	await apiPost(request, '/transport/play', {});
}

export async function openController(page: Page) {
	await page.goto('index.html');
	await page.waitForSelector('h1', { timeout: 20_000 });
	await waitForConnected(page);
}

export async function waitForConnected(page: Page) {
	await page.locator('.status-pill').filter({ hasText: 'Connected' }).waitFor({
		timeout: 20_000,
	});
}

/** No-op: all sections are visible in the unified single-view layout. */
export async function ensurePlayerTab(_page: Page) {
	// Player section is always visible — no tab switching needed
}

export async function expectNoErrorBanner(page: Page) {
	await page.locator('.error-banner').waitFor({ state: 'detached', timeout: 500 }).catch(() => {});
}
