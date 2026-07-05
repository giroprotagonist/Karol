const statusEl = document.getElementById('status');
const tabTitleEl = document.getElementById('tab-title');
const hostInput = document.getElementById('deskreen-host');
const btnQueue = document.getElementById('btn-queue');
const btnPlay = document.getElementById('btn-play');

let currentUrl = '';
let currentTitle = '';
let isYouTube = false;

// Load saved host
chrome.storage.local.get(['deskreenHost'], (result) => {
	if (result.deskreenHost) {
		hostInput.value = result.deskreenHost;
	}
});

function saveHost() {
	const host = hostInput.value.trim();
	chrome.storage.local.set({ deskreenHost: host });
	showStatus('Host saved', 'success');
}

window.saveHost = saveHost;

function showStatus(msg, type) {
	statusEl.textContent = msg;
	statusEl.className = type === 'error' ? 'error' : '';
	setTimeout(() => {
		if (statusEl.textContent === msg) {
			statusEl.textContent = '';
		}
	}, 3000);
}

function updateButtons() {
	if (!isYouTube) {
		btnQueue.className = 'btn-disabled';
		btnPlay.className = 'btn-disabled';
		btnQueue.disabled = true;
		btnPlay.disabled = true;
		showStatus('Not a YouTube page', 'error');
	} else {
		btnQueue.className = 'btn-queue';
		btnPlay.className = 'btn-play';
		btnQueue.disabled = false;
		btnPlay.disabled = false;
	}
}

async function sendToDeskreen(action) {
	if (!isYouTube || !currentUrl) return;

	const host = hostInput.value.trim() || 'localhost:3131';
	const endpoints = [
		`http://${host}/api/youtube-dj/queue`,
		`http://${host}/api/youtube-karaoke/queue`,
	];

	for (const apiUrl of endpoints) {
		try {
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: currentUrl, action }),
			});
			const data = await response.json();
			if (data.ok) {
				showStatus(action === 'play-now' ? 'Playing now!' : 'Added to queue!', 'success');
				return;
			}
			showStatus(data.error || 'Failed', 'error');
			return;
		} catch {
			// try next endpoint
		}
	}
	showStatus('Connection error. Is Deskreen running?', 'error');
}

// Get current tab info
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
	if (tabs.length > 0) {
		const tab = tabs[0];
		currentUrl = tab.url || '';
		currentTitle = tab.title || '';
		tabTitleEl.textContent = currentTitle;
		isYouTube = currentUrl.includes('youtube.com/watch') || currentUrl.includes('youtu.be/');
		updateButtons();
	}
});

btnQueue.addEventListener('click', () => sendToDeskreen('queue'));
btnPlay.addEventListener('click', () => sendToDeskreen('play-now'));
