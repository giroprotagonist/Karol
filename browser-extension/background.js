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
				fetch(`http://${host}/api/youtube-karaoke/queue`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ url, action: 'play-now' }),
				})
				.then((res) => res.json())
				.then((data) => {
					console.log('[Deskreen Karaoke] sent:', url, data.ok ? 'OK' : 'FAIL');
				})
				.catch((err) => {
					console.error('[Deskreen Karaoke] error:', err.message);
				});
			});
		});
	}
});
