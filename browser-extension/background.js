// Deskreen YouTube Karaoke - Background Service Worker

chrome.commands.onCommand.addListener((command) => {
	if (command === 'send-to-deskreen') {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			if (tabs.length === 0) return;
			const tab = tabs[0];
			const url = tab.url || '';
			if (!url.includes('youtube.com/watch') && !url.includes('youtu.be/')) return;

			chrome.storage.local.get(['deskreenHost'], (result) => {
				const host = result.deskreenHost || 'localhost:3131';
				const endpoints = [
					`http://${host}/api/youtube-dj/queue`,
					`http://${host}/api/youtube-karaoke/queue`,
				];
				const payload = JSON.stringify({ url, action: 'play-now' });
				const trySend = (index) => {
					if (index >= endpoints.length) {
						console.error('[Deskreen DJ] connection failed');
						return;
					}
					fetch(endpoints[index], {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: payload,
					})
						.then((res) => res.json())
						.then((data) => {
							console.log('[Deskreen DJ] sent:', url, data.ok ? 'OK' : 'FAIL');
						})
						.catch(() => trySend(index + 1));
				};
				trySend(0);
			});
		});
	}
});
