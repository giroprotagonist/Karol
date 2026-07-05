import screenfull from 'screenfull';
import { PLAYER_WRAPPER_ID } from '../constants/appConstants';
import isReceiverMode from './isReceiverMode';

type LegacyFullscreenElement = HTMLElement & {
	webkitRequestFullscreen?: () => Promise<void> | void;
	webkitRequestFullScreen?: () => Promise<void> | void;
	mozRequestFullScreen?: () => Promise<void> | void;
	msRequestFullscreen?: () => Promise<void> | void;
};

type LegacyFullscreenDocument = Document & {
	webkitExitFullscreen?: () => Promise<void> | void;
	mozCancelFullScreen?: () => Promise<void> | void;
	msExitFullscreen?: () => Promise<void> | void;
	webkitFullscreenElement?: Element | null;
	mozFullScreenElement?: Element | null;
	msFullscreenElement?: Element | null;
};

type IOSVideoElement = HTMLVideoElement & {
	webkitEnterFullscreen?: () => void;
	webkitExitFullscreen?: () => void;
	webkitSupportsFullscreen?: boolean;
	webkitDisplayingFullscreen?: boolean;
};

type Unsubscribe = () => void;

const fullscreenEventNames = [
	'fullscreenchange',
	'webkitfullscreenchange',
	'MSFullscreenChange',
	'mozfullscreenchange',
];

const isIOSDevice = (): boolean => {
	if (typeof navigator === 'undefined') {
		return false;
	}
	return /iPhone|iPad|iPod/i.test(navigator.userAgent);
};

const isAndroidDevice = (): boolean => {
	if (typeof navigator === 'undefined') {
		return false;
	}
	return /Android/i.test(navigator.userAgent);
};

const isMobileFullscreenDevice = (): boolean => {
	if (typeof navigator === 'undefined') {
		return false;
	}
	return /Android|iPhone|iPad|iPod|Mobile|DeskreenReceiver|wv\)/i.test(
		navigator.userAgent,
	);
};

const getPlayerContainer = (): HTMLElement | null => {
	return document.getElementById(PLAYER_WRAPPER_ID);
};

const getPlayerVideo = (): IOSVideoElement | null => {
	const container = getPlayerContainer();
	if (!container) return null;
	const maybeVideo = container.querySelector('video');
	if (!(maybeVideo instanceof HTMLVideoElement)) return null;
	return maybeVideo as IOSVideoElement;
};

const requestStandardFullscreen = async (
	element: HTMLElement | null,
): Promise<boolean> => {
	if (!element) return false;
	const target = element as LegacyFullscreenElement;
	const request =
		target.requestFullscreen ||
		target.webkitRequestFullscreen ||
		target.webkitRequestFullScreen ||
		target.mozRequestFullScreen ||
		target.msRequestFullscreen;
	if (typeof request !== 'function') return false;
	try {
		const result = request.call(target);
		if (result && typeof (result as Promise<void>).then === 'function') {
			await (result as Promise<void>);
		}
		return isPlayerFullscreen();
	} catch {
		return false;
	}
};

const exitStandardFullscreen = async (): Promise<boolean> => {
	const doc = document as LegacyFullscreenDocument;
	const exit =
		doc.exitFullscreen ||
		doc.webkitExitFullscreen ||
		doc.mozCancelFullScreen ||
		doc.msExitFullscreen;
	if (typeof exit !== 'function') return false;
	try {
		const result = exit.call(doc);
		if (result && typeof (result as Promise<void>).then === 'function') {
			await (result as Promise<void>);
		}
		return !isPlayerFullscreen();
	} catch {
		return false;
	}
};

const prepareAndroidVideoForFullscreen = (video: IOSVideoElement): void => {
	video.removeAttribute('playsinline');
	video.removeAttribute('webkit-playsinline');
	video.setAttribute('x5-video-player-type', 'h5-page');
};

export const isPlayerFullscreen = (): boolean => {
	const doc = document as LegacyFullscreenDocument;
	if (
		doc.fullscreenElement ||
		doc.webkitFullscreenElement ||
		doc.mozFullScreenElement ||
		doc.msFullscreenElement
	) {
		return true;
	}
	const video = getPlayerVideo();
	if (!video) return false;
	if (typeof video.webkitDisplayingFullscreen === 'boolean') {
		return video.webkitDisplayingFullscreen;
	}
	return false;
};

export const enterPlayerFullscreen = async (): Promise<boolean> => {
	const video = getPlayerVideo();
	const videoContainer = document.getElementById('video-container');
	const container = getPlayerContainer();
	const ios = isIOSDevice();
	const android = isAndroidDevice();
	const receiver = isReceiverMode();

	// Receiver: fullscreen the container so buffer UI stays visible and WebRTC
	// is not moved to a separate Android video surface (which flushes jitter buffer).
	if (receiver && videoContainer) {
		if (await requestStandardFullscreen(videoContainer)) {
			return true;
		}
	}

	// iOS Safari: native video fullscreen layer.
	if (video && ios) {
		if (
			typeof video.webkitEnterFullscreen === 'function' &&
			(typeof video.webkitSupportsFullscreen !== 'boolean' ||
				video.webkitSupportsFullscreen)
		) {
			try {
				video.webkitEnterFullscreen();
				return true;
			} catch {
				// fall through
			}
		}
	}

	// Android (Chrome + WebView): requestFullscreen on the playing <video>.
	if (video && android) {
		prepareAndroidVideoForFullscreen(video);
		if (await requestStandardFullscreen(video)) return true;
	}

	if (video && !android && (await requestStandardFullscreen(video))) {
		return true;
	}

	if (videoContainer && (await requestStandardFullscreen(videoContainer))) {
		return true;
	}

	if (container && (await requestStandardFullscreen(container))) {
		return true;
	}

	if (
		isMobileFullscreenDevice() &&
		(await requestStandardFullscreen(document.documentElement))
	) {
		return true;
	}

	if (container && screenfull.isEnabled) {
		try {
			await screenfull.request(container);
			return true;
		} catch {
			return false;
		}
	}

	return false;
};

export const exitPlayerFullscreen = async (): Promise<boolean> => {
	if (screenfull.isEnabled && screenfull.isFullscreen) {
		await screenfull.exit();
		return true;
	}
	if (await exitStandardFullscreen()) return true;
	const video = getPlayerVideo();
	if (video && typeof video.webkitExitFullscreen === 'function') {
		if (
			typeof video.webkitDisplayingFullscreen === 'boolean' &&
			!video.webkitDisplayingFullscreen
		) {
			return false;
		}
		video.webkitExitFullscreen();
		return true;
	}
	return false;
};

export const togglePlayerFullscreen = async (): Promise<
	'entered' | 'exited' | 'failed'
> => {
	if (isPlayerFullscreen()) {
		return (await exitPlayerFullscreen()) ? 'exited' : 'failed';
	}
	return (await enterPlayerFullscreen()) ? 'entered' : 'failed';
};

export const subscribeToPlayerFullscreenChange = (
	listener: (isFullscreen: boolean) => void,
): Unsubscribe => {
	const handleChange = () => listener(isPlayerFullscreen());
	const handleVideoBegin = () => listener(true);
	const handleVideoEnd = () => listener(false);

	if (screenfull.isEnabled) {
		screenfull.on('change', handleChange);
	}

	fullscreenEventNames.forEach((eventName) => {
		document.addEventListener(eventName, handleChange);
	});

	let currentVideo: IOSVideoElement | null = null;

	const attachVideoListeners = (video: IOSVideoElement | null) => {
		if (currentVideo === video) return;
		if (currentVideo) {
			currentVideo.removeEventListener(
				'webkitbeginfullscreen',
				handleVideoBegin,
			);
			currentVideo.removeEventListener('webkitendfullscreen', handleVideoEnd);
		}
		currentVideo = video;
		if (currentVideo) {
			currentVideo.addEventListener('webkitbeginfullscreen', handleVideoBegin);
			currentVideo.addEventListener('webkitendfullscreen', handleVideoEnd);
		}
	};

	attachVideoListeners(getPlayerVideo());

	const container = getPlayerContainer();
	let observer: MutationObserver | null = null;

	if (container) {
		observer = new MutationObserver(() => {
			attachVideoListeners(getPlayerVideo());
		});
		observer.observe(container, { childList: true, subtree: true });
	}

	listener(isPlayerFullscreen());

	return () => {
		if (screenfull.isEnabled) {
			screenfull.off('change', handleChange);
		}
		fullscreenEventNames.forEach((eventName) => {
			document.removeEventListener(eventName, handleChange);
		});
		if (currentVideo) {
			currentVideo.removeEventListener(
				'webkitbeginfullscreen',
				handleVideoBegin,
			);
			currentVideo.removeEventListener('webkitendfullscreen', handleVideoEnd);
		}
		if (observer) {
			observer.disconnect();
		}
	};
};
