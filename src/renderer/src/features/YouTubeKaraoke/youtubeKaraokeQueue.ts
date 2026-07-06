import {
	type YouTubeQueueItem,
	type YouTubeKaraokeState,
	type YouTubeKaraokeMode,
	type YouTubeSearchResult,
} from '@common/YouTubeKaraokeTypes';
import { IpcEvents } from '@common/IpcEvents.enum';

let state: YouTubeKaraokeState = {
	queue: [],
	currentIndex: -1,
	mode: 'queue',
	isPlaying: false,
	currentTitle: '',
	currentThumbnail: '',
	currentTime: 0,
	duration: 0,
};

type StateChangeListener = (state: YouTubeKaraokeState) => void;
let listeners: StateChangeListener[] = [];

function notifyListeners(): void {
	const snap: YouTubeKaraokeState = {
		...state,
		queue: [...state.queue],
	};
	for (const fn of listeners) {
		try {
			fn(snap);
		} catch {
			// ignore listener errors
		}
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

export function setKaraokeMode(mode: YouTubeKaraokeMode): void {
	state.mode = mode;
	saveQueue();
	notifyListeners();
}

export function addToQueue(item: YouTubeQueueItem): void {
	state.queue.push({ ...item, status: item.status || 'queued' });
	saveQueue();
	notifyListeners();
}

export function addManyToQueue(items: YouTubeQueueItem[]): void {
	for (const item of items) {
		state.queue.push({ ...item, status: item.status || 'queued' });
	}
	saveQueue();
	notifyListeners();
}

export function getQueuedVideoIds(): Set<string> {
	const ids = new Set<string>();
	for (const item of state.queue) {
		if (
			item.status === 'queued' ||
			item.status === 'loading' ||
			item.status === 'playing'
		) {
			ids.add(item.videoId);
		}
	}
	return ids;
}

export function tryAddToQueue(item: YouTubeQueueItem): boolean {
	if (getQueuedVideoIds().has(item.videoId)) {
		return false;
	}
	addToQueue(item);
	return true;
}

export function updateQueueItemMetadata(
	videoId: string,
	title: string,
	thumbnail = '',
): boolean {
	let changed = false;
	for (const item of state.queue) {
		if (item.videoId !== videoId) {
			continue;
		}
		if (title && item.title !== title) {
			item.title = title;
			changed = true;
		}
		if (thumbnail && !item.thumbnail) {
			item.thumbnail = thumbnail;
			changed = true;
		}
	}
	if (changed) {
		saveQueue();
		notifyListeners();
	}
	return changed;
}

export function addNewVideosToQueue(
	videos: YouTubeSearchResult[],
	source: 'playlist' | 'manual' | 'extension',
): YouTubeQueueItem[] {
	const ids = getQueuedVideoIds();
	const added: YouTubeQueueItem[] = [];
	const now = Date.now();

	for (let index = 0; index < videos.length; index += 1) {
		const video = videos[index];
		if (ids.has(video.videoId)) {
			continue;
		}
		ids.add(video.videoId);
		const item: YouTubeQueueItem = {
			id: `${source}-${now}-${index}-${video.videoId}`,
			url: video.url,
			videoId: video.videoId,
			title: video.title,
			thumbnail: video.thumbnailUrl,
			status: 'queued',
		};
		state.queue.push(item);
		added.push(item);
	}

	if (added.length > 0) {
		saveQueue();
		notifyListeners();
	}
	return added;
}

export function removeFromQueue(id: string): void {
	const removedIndex = state.queue.findIndex((item) => item.id === id);
	state.queue = state.queue.filter((item) => item.id !== id);
	if (removedIndex >= 0 && removedIndex < state.currentIndex) {
		state.currentIndex -= 1;
	}
	if (state.currentIndex >= state.queue.length) {
		state.currentIndex = state.queue.length - 1;
	}
	if (state.queue.length === 0) {
		state.currentIndex = -1;
		state.isPlaying = false;
		state.currentTitle = '';
	}
	saveQueue();
	notifyListeners();
}

export function reorderQueue(fromIndex: number, toIndex: number): void {
	if (
		fromIndex < 0 ||
		toIndex < 0 ||
		fromIndex >= state.queue.length ||
		toIndex >= state.queue.length ||
		fromIndex === toIndex
	) {
		return;
	}
	const [item] = state.queue.splice(fromIndex, 1);
	state.queue.splice(toIndex, 0, item);
	if (state.currentIndex === fromIndex) {
		state.currentIndex = toIndex;
	} else if (
		fromIndex < state.currentIndex &&
		toIndex >= state.currentIndex
	) {
		state.currentIndex -= 1;
	} else if (
		fromIndex > state.currentIndex &&
		toIndex <= state.currentIndex
	) {
		state.currentIndex += 1;
	}
	saveQueue();
	notifyListeners();
}

export function moveQueueItemUp(id: string): void {
	const index = state.queue.findIndex((item) => item.id === id);
	if (index > 0) {
		reorderQueue(index, index - 1);
	}
}

export function moveQueueItemDown(id: string): void {
	const index = state.queue.findIndex((item) => item.id === id);
	if (index >= 0 && index < state.queue.length - 1) {
		reorderQueue(index, index + 1);
	}
}

export function setNowPlaying(
	title: string,
	thumbnail: string,
	currentTime = 0,
	duration = 0,
): void {
	state.currentTitle = title;
	state.currentThumbnail = thumbnail;
	state.currentTime = currentTime;
	state.duration = duration;
	state.isPlaying = true;
	if (state.currentIndex >= 0 && state.currentIndex < state.queue.length) {
		state.queue[state.currentIndex].status = 'playing';
		if (title) {
			state.queue[state.currentIndex].title = title;
		}
	}
	notifyListeners();
}

export function setPlaybackProgress(currentTime: number, duration: number): void {
	state.currentTime = currentTime;
	state.duration = duration;
	notifyListeners();
}

export function markCurrentError(reason: string): void {
	if (state.currentIndex >= 0 && state.currentIndex < state.queue.length) {
		state.queue[state.currentIndex].status = 'error';
		state.queue[state.currentIndex].errorReason = reason;
	}
	state.isPlaying = false;
	saveQueue();
	notifyListeners();
}

export function onVideoEnded(): string | null {
	if (state.currentIndex >= 0 && state.currentIndex < state.queue.length) {
		state.queue[state.currentIndex].status = 'ended';
	}

	if (state.mode === 'manual') {
		state.isPlaying = false;
		notifyListeners();
		return null;
	}

	if (state.mode === 'queue') {
		const nextIndex = state.currentIndex + 1;
		if (nextIndex < state.queue.length) {
			state.currentIndex = nextIndex;
			state.queue[nextIndex].status = 'loading';
			saveQueue();
			notifyListeners();
			return state.queue[nextIndex].videoId;
		}
	}

	state.isPlaying = false;
	state.currentTitle = '';
	state.currentTime = 0;
	state.duration = 0;
	saveQueue();
	notifyListeners();
	return null;
}

export function playNow(id: string): string | null {
	const index = state.queue.findIndex((item) => item.id === id);
	if (index === -1) {
		return null;
	}
	state.currentIndex = index;
	state.queue[index].status = 'loading';
	state.isPlaying = true;
	saveQueue();
	notifyListeners();
	return state.queue[index].videoId;
}

export function skipNext(): string | null {
	if (state.queue.length === 0) {
		return null;
	}
	const nextIndex =
		state.currentIndex < 0 ? 0 : Math.min(state.currentIndex + 1, state.queue.length - 1);
	state.currentIndex = nextIndex;
	state.queue[nextIndex].status = 'loading';
	state.isPlaying = true;
	saveQueue();
	notifyListeners();
	return state.queue[nextIndex].videoId;
}

export function skipPrev(): string | null {
	if (state.queue.length === 0) {
		return null;
	}
	const prevIndex = Math.max(0, state.currentIndex <= 0 ? 0 : state.currentIndex - 1);
	state.currentIndex = prevIndex;
	state.queue[prevIndex].status = 'loading';
	state.isPlaying = true;
	saveQueue();
	notifyListeners();
	return state.queue[prevIndex].videoId;
}

export function getCurrentVideoId(): string | null {
	if (state.currentIndex < 0 || state.currentIndex >= state.queue.length) {
		return null;
	}
	return state.queue[state.currentIndex].videoId;
}

export function getNextVideoId(): string | null {
	if (state.mode !== 'queue') {
		return null;
	}
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
	state.currentThumbnail = '';
	state.currentTime = 0;
	state.duration = 0;
	saveQueue();
	notifyListeners();
}

function saveQueue(): void {
	try {
		const data = {
			queue: state.queue,
			currentIndex: state.currentIndex,
			mode: state.mode,
			currentTitle: state.currentTitle,
			currentTime: state.currentTime,
			duration: state.duration,
			updatedAt: Date.now(),
		};
		localStorage.setItem('deskreen_yt_queue', JSON.stringify(data));
		window.electron.ipcRenderer.send(IpcEvents.YOUTUBE_DJ_QUEUE_SNAPSHOT, data);
	} catch {
		// ignore quota errors
	}
}

export function loadQueueFromStorage(): void {
	try {
		const raw = localStorage.getItem('deskreen_yt_queue');
		if (!raw) {
			return;
		}
		const data = JSON.parse(raw) as {
			queue?: YouTubeQueueItem[];
			currentIndex?: number;
			mode?: YouTubeKaraokeMode;
		};
		if (Array.isArray(data.queue)) {
			state.queue = data.queue;
			state.currentIndex =
				typeof data.currentIndex === 'number' ? data.currentIndex : -1;
			if (data.mode === 'hotswap' || data.mode === 'manual' || data.mode === 'queue') {
				state.mode = data.mode;
			}
		}
	} catch {
		// ignore corrupt storage
	}
}

export function exportQueueJson(): string {
	return JSON.stringify(
		{
			queue: state.queue,
			currentIndex: state.currentIndex,
			mode: state.mode,
		},
		null,
		2,
	);
}

export function importQueueJson(raw: string): boolean {
	try {
		const data = JSON.parse(raw) as {
			queue?: YouTubeQueueItem[];
			currentIndex?: number;
			mode?: YouTubeKaraokeMode;
		};
		if (!Array.isArray(data.queue)) {
			return false;
		}
		state.queue = data.queue;
		state.currentIndex =
			typeof data.currentIndex === 'number' ? data.currentIndex : -1;
		if (data.mode === 'hotswap' || data.mode === 'manual' || data.mode === 'queue') {
			state.mode = data.mode;
		}
		saveQueue();
		notifyListeners();
		return true;
	} catch {
		return false;
	}
}
