import { type YouTubeQueueItem, type YouTubeKaraokeState } from '@common/YouTubeKaraokeTypes';

let state: YouTubeKaraokeState = {
	queue: [],
	currentIndex: -1,
	mode: 'queue',
	isPlaying: false,
	currentTitle: '',
	currentThumbnail: '',
};

type StateChangeListener = (state: YouTubeKaraokeState) => void;
let listeners: StateChangeListener[] = [];

function notifyListeners(): void {
	const snap = { ...state, queue: [...state.queue] };
	for (const fn of listeners) {
		try {
			fn(snap);
		} catch (_) {}
	}
}

export function subscribeToKaraokeState(fn: StateChangeListener): () => void {
	listeners.push(fn);
	return () => {
		listeners = listeners.filter((l) => l !== fn);
	};
}

export function getKaraokeState(): YouTubeKaraokeState {
	return { ...state, queue: [...state.queue] };
}

export function setKaraokeMode(mode: 'queue' | 'hotswap'): void {
	state.mode = mode;
	notifyListeners();
}

export function addToQueue(item: YouTubeQueueItem): void {
	state.queue.push({ ...item, status: 'queued' });
	saveQueue();
	notifyListeners();
}

export function removeFromQueue(id: string): void {
	state.queue = state.queue.filter((item) => item.id !== id);
	if (state.currentIndex >= state.queue.length) {
		state.currentIndex = state.queue.length - 1;
	}
	saveQueue();
	notifyListeners();
}

export function setNowPlaying(title: string, thumbnail: string): void {
	state.currentTitle = title;
	state.currentThumbnail = thumbnail;
	state.isPlaying = true;
	if (state.currentIndex >= 0 && state.currentIndex < state.queue.length) {
		state.queue[state.currentIndex].status = 'playing';
	}
	notifyListeners();
}

export function onVideoEnded(): void {
	if (state.currentIndex >= 0 && state.currentIndex < state.queue.length) {
		state.queue[state.currentIndex].status = 'ended';
	}
	if (state.mode === 'queue') {
		const nextIndex = state.currentIndex + 1;
		if (nextIndex < state.queue.length) {
			state.currentIndex = nextIndex;
			state.queue[nextIndex].status = 'loading';
			notifyListeners();
			return;
		}
	}
	state.isPlaying = false;
	state.currentTitle = '';
	notifyListeners();
}

export function playNow(id: string): void {
	const index = state.queue.findIndex((item) => item.id === id);
	if (index === -1) return;
	state.currentIndex = index;
	state.queue[index].status = 'loading';
	state.isPlaying = true;
	saveQueue();
	notifyListeners();
}

export function getNextVideoId(): string | null {
	if (state.mode !== 'queue') return null;
	const nextIndex = state.currentIndex + 1;
	if (nextIndex < state.queue.length) {
		return state.queue[nextIndex].videoId;
	}
	return null;
}

export function clearQueue(): void {
	state.queue = [];
	state.currentIndex = -1;
	state.isPlaying = false;
	state.currentTitle = '';
	saveQueue();
	notifyListeners();
}

function saveQueue(): void {
	try {
		const data = {
			queue: state.queue,
			currentIndex: state.currentIndex,
			mode: state.mode,
		};
		localStorage.setItem('deskreen_yt_queue', JSON.stringify(data));
	} catch (_) {}
}

export function loadQueueFromStorage(): void {
	try {
		const raw = localStorage.getItem('deskreen_yt_queue');
		if (raw) {
			const data = JSON.parse(raw);
			if (Array.isArray(data.queue)) {
				state.queue = data.queue;
				state.currentIndex =
					typeof data.currentIndex === 'number' ? data.currentIndex : -1;
				state.mode = data.mode === 'hotswap' ? 'hotswap' : 'queue';
			}
		}
	} catch (_) {}
}
