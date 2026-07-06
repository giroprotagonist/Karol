import { BrowserWindow, screen } from 'electron';
import { IpcEvents } from '../../common/IpcEvents.enum';

export const YOUTUBE_WINDOW_TITLE = 'Deskreen YouTube Player';

/** macOS ScreenCaptureKit often exposes the YouTube page title instead of BrowserWindow.title */
const YOUTUBE_CAPTURER_PAGE_TITLE = 'YouTube';

export function isYouTubeOutputCapturerSourceName(name: string): boolean {
	if (name === YOUTUBE_WINDOW_TITLE) {
		return true;
	}
	if (name === YOUTUBE_CAPTURER_PAGE_TITLE) {
		return youtubeWindow !== null && !youtubeWindow.isDestroyed();
	}
	return false;
}

export type YouTubeOutputPlayerSnapshot = {
	state: number;
	videoId: string;
	title: string;
	currentTime: number;
	duration: number;
	paused: boolean;
	ended: boolean;
	hasVideo: boolean;
};

export type YouTubePlayerDebugInfo = {
	videoWidth: number;
	videoHeight: number;
	readyState: number;
	rect: { x: number; y: number; width: number; height: number };
	theaterActive: boolean;
	url: string;
	documentHidden?: boolean;
	visibilityState?: string;
	computedTransform?: string;
	computedFilter?: string;
	computedOpacity?: string;
	computedMixBlendMode?: string;
};

const YOUTUBE_PARTITION = 'persist:deskreen-youtube';
const POLL_MS = 500;
const PROGRESS_BROADCAST_MIN_MS = 1000;
const LOAD_DEBOUNCE_MS = 200;
const VIDEO_READY_TIMEOUT_MS = 20000;

let youtubeWindow: BrowserWindow | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSnapshot: YouTubeOutputPlayerSnapshot | null = null;
let lastEmittedState = -2;
let lastProgressBroadcastAt = 0;
let lastVideoReadyId = '';
let layoutCssKey = '';
let loadInFlight: Promise<void> | null = null;
let pendingVideoId: string | null = null;

const READ_PLAYER_SNAPSHOT = `
(function () {
  const v = document.querySelector('video');
  const params = new URLSearchParams(window.location.search);
  const videoId = params.get('v') || '';
  const metaTitle =
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent ||
    document.querySelector('h1 yt-formatted-string')?.textContent ||
    '';
  const title = (metaTitle || document.title || '').replace(/\\s*-\\s*YouTube\\s*$/, '').trim();
  if (!v) {
    return {
      state: 3,
      videoId,
      title,
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
      hasVideo: false,
    };
  }
  let state = 3;
  if (v.ended) state = 0;
  else if (v.paused) state = 2;
  else if (v.readyState >= 2) state = 1;
  return {
    state,
    videoId,
    title,
    currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    paused: v.paused,
    ended: v.ended,
    hasVideo: true,
  };
})()
`;

const START_PLAYBACK = `
(function () {
  const v = document.querySelector('video');
  if (v) {
    v.muted = false;
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(function () {});
    return true;
  }
  const playBtn =
    document.querySelector('.ytp-play-button') ||
    document.querySelector('button[aria-label="Play"]');
  if (playBtn) { playBtn.click(); return true; }
  return false;
})()
`;

const FIX_VIDEO_LAYER = `
(function () {
  if (window.__deskreenYtFixVideoLayer) {
    return window.__deskreenYtFixVideoLayer();
  }
  return false;
})()
`;

const CHECK_VIDEO_LAYER_READY = `
(function () {
  const v = document.querySelector('video');
  if (!v) return { ready: false, videoWidth: 0, videoHeight: 0 };
  return {
    ready: v.videoWidth > 0 && v.readyState >= 2,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    readyState: v.readyState,
  };
})()
`;

const GET_PLAYER_DEBUG_INFO = `
(function () {
  const v = document.querySelector('video');
  const flexy = document.querySelector('ytd-watch-flexy');
  const rect = v ? v.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
  const cs = v ? window.getComputedStyle(v) : null;
  return {
    videoWidth: v ? v.videoWidth : 0,
    videoHeight: v ? v.videoHeight : 0,
    readyState: v ? v.readyState : -1,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    theaterActive: flexy ? (flexy.hasAttribute('theater') || flexy.hasAttribute('full-bleed-player')) : false,
    url: location.href,
    computedTransform: cs ? cs.transform : '',
    computedFilter: cs ? cs.filter : '',
    computedOpacity: cs ? cs.opacity : '',
    computedMixBlendMode: cs ? cs.mixBlendMode : '',
    documentHidden: document.hidden,
    visibilityState: document.visibilityState,
  };
})()
`;

/** Hide-only layout + one-shot theater — avoids forced-theater blackscreen. */
const INJECT_LAYOUT_CONTROLLER = `
(function () {
  if (window.__deskreenYtLayout) return true;
  window.__deskreenYtLayout = true;

  var HIDE = [
    '#masthead-container', '#comments', '#related', '#secondary', '#below', '#chat',
    '#info', '#meta', '#meta-contents', 'ytd-watch-metadata', 'ytd-playlist-panel',
    'ytd-watch-next-secondary-results', 'ytd-engagement-panel-section-list-renderer',
    'ytd-rich-section-renderer', 'ytd-item-section-renderer', 'ytd-browse',
    'ytd-video-description-transcript-section-renderer', 'ytd-expandable-metadata-renderer',
    '#ticket-shelf', '#merch-shelf', 'ytd-merch-shelf-renderer',
    '.ytp-chrome-top', '.ytp-gradient-top', '.ytp-show-cards-title', '.ytp-ce-element',
    'ytd-reel-shelf-renderer', '#clarify-box', '#description', '#description-inner'
  ].join(',');

  function hidePanels() {
    try {
      document.querySelectorAll(HIDE).forEach(function (el) {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
      });
    } catch (e) {}
  }

  window.__deskreenYtEnableTheaterOnce = function () {
    if (window.__deskreenTheaterDone) return;
    var flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && (flexy.hasAttribute('theater') || flexy.hasAttribute('full-bleed-player'))) {
      window.__deskreenTheaterDone = true;
      return;
    }
    var btn =
      document.querySelector('.ytp-size-button') ||
      document.querySelector('button.ytp-button[aria-label*="Theater"]') ||
      document.querySelector('button.ytp-button[aria-label*="theater"]');
    if (btn) {
      btn.click();
      window.__deskreenTheaterDone = true;
    }
  };

  window.__deskreenYtFixVideoLayer = function () {
    var v = document.querySelector('video');
    if (!v) return false;
    v.style.setProperty('opacity', '1', 'important');
    v.style.setProperty('visibility', 'visible', 'important');
    v.style.removeProperty('transform');
    var top = v.style.top || window.getComputedStyle(v).top;
    if (top && top !== 'auto' && top.indexOf('-') === 0) {
      v.style.setProperty('top', '0', 'important');
    }
    v.style.setProperty('left', '0', 'important');
    v.style.setProperty('width', '100%', 'important');
    v.style.setProperty('height', '100vh', 'important');
    v.style.setProperty('object-fit', 'contain', 'important');
    var rect = v.getBoundingClientRect();
    return v.videoWidth > 0 && v.readyState >= 2 && rect.height > 0;
  };

  window.__deskreenYtApplyLayout = function () {
    if (!location.pathname.includes('/watch')) return;
    hidePanels();
    window.__deskreenYtEnableTheaterOnce();
    window.__deskreenYtFixVideoLayer();
  };

  window.__deskreenYtResetForNavigation = function () {
    window.__deskreenTheaterDone = false;
  };

  window.__deskreenYtNavigateSpa = function (videoId) {
    window.__deskreenYtResetForNavigation();
    var url = '/watch?v=' + videoId + '&autoplay=1';
    var app = document.querySelector('ytd-app');
    if (app && typeof app.navigate === 'function') {
      app.navigate({ endpoint: url });
      return true;
    }
    var parsed = new URL(window.location.href);
    parsed.pathname = '/watch';
    parsed.search = '?v=' + videoId + '&autoplay=1';
    history.pushState({}, '', parsed.toString());
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    return true;
  };

  var lastUrl = location.href;
  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    window.__deskreenYtResetForNavigation();
    setTimeout(function () { window.__deskreenYtApplyLayout(); }, 500);
  }

  var origPush = history.pushState;
  var origReplace = history.replaceState;
  history.pushState = function () {
    origPush.apply(history, arguments);
    onUrlChange();
  };
  history.replaceState = function () {
    origReplace.apply(history, arguments);
    onUrlChange();
  };
  window.addEventListener('popstate', onUrlChange);

  var mo = new MutationObserver(function () {
    if (location.pathname.includes('/watch')) {
      hidePanels();
      window.__deskreenYtFixVideoLayer();
    }
  });
  if (document.body) {
    mo.observe(document.body, { childList: true, subtree: true });
  }

  window.__deskreenYtApplyLayout();
  return true;
})()
`;

const LAYOUT_CSS = `
html, body, ytd-app {
  margin: 0 !important;
  padding: 0 !important;
  background: #000 !important;
  overflow: hidden !important;
}
#masthead-container, ytd-watch-metadata, #comments, #related, #secondary, #below,
#chat, ytd-playlist-panel, #info, #meta, ytd-watch-next-secondary-results,
ytd-engagement-panel-section-list-renderer, ytd-rich-section-renderer,
ytd-item-section-renderer, ytd-browse, ytd-video-description-transcript-section-renderer,
ytd-expandable-metadata-renderer, #ticket-shelf, #merch-shelf, ytd-merch-shelf-renderer,
.ytp-chrome-top, .ytp-gradient-top, .ytp-show-cards-title, .ytp-ce-element,
ytd-reel-shelf-renderer, #clarify-box, #description, #description-inner {
  display: none !important;
  visibility: hidden !important;
}
ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container.ytd-watch-flexy,
ytd-watch-flexy[full-bleed-player]:not([fullscreen]) #full-bleed-container.ytd-watch-flexy {
  height: 100vh !important;
  max-height: none !important;
}
#movie_player, .html5-video-player {
  width: 100% !important;
  height: 100vh !important;
}
ytd-watch-flexy[theater] video,
ytd-watch-flexy[full-bleed-player] video,
.html5-video-player video {
  position: relative !important;
  top: 0 !important;
  left: 0 !important;
  width: 100% !important;
  height: 100vh !important;
  min-height: 360px !important;
  object-fit: contain !important;
  opacity: 1 !important;
  visibility: visible !important;
}
.ytp-chrome-bottom { opacity: 0 !important; }
.html5-video-player:hover .ytp-chrome-bottom { opacity: 1 !important; }
`;

function isWatchPageUrl(url: string): boolean {
	return /youtube\.com\/watch/i.test(url);
}

function broadcastState(data: YouTubeOutputPlayerSnapshot): void {
	const windows = BrowserWindow.getAllWindows();
	for (const win of windows) {
		if (win.isDestroyed() || win.title === YOUTUBE_WINDOW_TITLE) {
			continue;
		}
		win.webContents.send(IpcEvents.YOUTUBE_KARAOKE_STATE_CHANGE, data);
	}
}

function broadcastVideoReady(videoId: string, title: string): void {
	if (!videoId || videoId === lastVideoReadyId) {
		return;
	}
	lastVideoReadyId = videoId;
	const windows = BrowserWindow.getAllWindows();
	for (const win of windows) {
		if (win.isDestroyed() || win.title === YOUTUBE_WINDOW_TITLE) {
			continue;
		}
		win.webContents.send(IpcEvents.YOUTUBE_DJ_VIDEO_READY, { videoId, title });
	}
}

function stopPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

function startPolling(): void {
	stopPolling();
	pollTimer = setInterval(() => {
		void pollPlayerState();
	}, POLL_MS);
}

async function pollPlayerState(): Promise<YouTubeOutputPlayerSnapshot | null> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return null;
	}
	try {
		const layerReady = (await youtubeWindow.webContents.executeJavaScript(
			CHECK_VIDEO_LAYER_READY,
			true,
		)) as { ready: boolean };

		const snapshot = (await youtubeWindow.webContents.executeJavaScript(
			READ_PLAYER_SNAPSHOT,
			true,
		)) as YouTubeOutputPlayerSnapshot;

		if (
			layerReady.ready &&
			snapshot.hasVideo &&
			snapshot.state === 1 &&
			snapshot.videoId &&
			snapshot.videoId !== lastVideoReadyId
		) {
			broadcastVideoReady(snapshot.videoId, snapshot.title);
		}

		if (
			snapshot.state !== lastEmittedState ||
			snapshot.title !== lastSnapshot?.title ||
			snapshot.videoId !== lastSnapshot?.videoId
		) {
			lastEmittedState = snapshot.state;
			lastSnapshot = snapshot;
			lastProgressBroadcastAt = Date.now();
			broadcastState(snapshot);
		} else {
			const prevTime = lastSnapshot?.currentTime ?? 0;
			const prevDuration = lastSnapshot?.duration ?? 0;
			lastSnapshot = snapshot;
			const now = Date.now();
			const timeMoved =
				Math.abs((snapshot.currentTime ?? 0) - prevTime) >= 0.5 ||
				(snapshot.duration ?? 0) !== prevDuration;
			if (
				snapshot.state === 1 &&
				timeMoved &&
				now - lastProgressBroadcastAt >= PROGRESS_BROADCAST_MIN_MS
			) {
				lastProgressBroadcastAt = now;
				broadcastState(snapshot);
			}
		}
		return snapshot;
	} catch {
		return null;
	}
}

function pickOutputDisplay(): Electron.Display {
	const displays = screen.getAllDisplays();
	if (displays.length > 1) {
		return displays[1];
	}
	return screen.getPrimaryDisplay();
}

async function injectLayoutController(): Promise<void> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}
	try {
		await youtubeWindow.webContents.executeJavaScript(
			INJECT_LAYOUT_CONTROLLER,
			true,
		);
	} catch {
		// page may not be ready
	}
}

async function insertLayoutCss(): Promise<void> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}
	try {
		if (layoutCssKey) {
			await youtubeWindow.webContents.removeInsertedCSS(layoutCssKey);
		}
		layoutCssKey = await youtubeWindow.webContents.insertCSS(LAYOUT_CSS);
	} catch {
		layoutCssKey = '';
	}
}

async function applyWatchPageLayout(): Promise<void> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}
	if (!isWatchPageUrl(youtubeWindow.webContents.getURL())) {
		return;
	}
	await injectLayoutController();
	await insertLayoutCss();
	await youtubeWindow.webContents.executeJavaScript(
		'window.__deskreenYtApplyLayout && window.__deskreenYtApplyLayout()',
		true,
	);
	await youtubeWindow.webContents.executeJavaScript(FIX_VIDEO_LAYER, true);
	await youtubeWindow.webContents.executeJavaScript(START_PLAYBACK, true);
}

async function waitForVideoLayerReady(expectedVideoId: string): Promise<boolean> {
	const deadline = Date.now() + VIDEO_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!youtubeWindow || youtubeWindow.isDestroyed()) {
			return false;
		}
		try {
			const check = (await youtubeWindow.webContents.executeJavaScript(
				CHECK_VIDEO_LAYER_READY,
				true,
			)) as { ready: boolean; videoWidth: number };

			const params = new URL(youtubeWindow.webContents.getURL());
			const currentId = params.searchParams.get('v') || '';

			if (check.ready && (!expectedVideoId || currentId === expectedVideoId)) {
				await youtubeWindow.webContents.executeJavaScript(FIX_VIDEO_LAYER, true);
				const debugInfo = await getYouTubePlayerDebugInfo();
				if ((debugInfo?.rect?.height ?? 0) > 0) {
					return true;
				}
			}
		} catch {
			// retry
		}
		await applyWatchPageLayout();
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return false;
}

function attachNavigationHandlers(): void {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}

	youtubeWindow.webContents.on('did-finish-load', () => {
		if (youtubeWindow?.isFullScreen()) {
			youtubeWindow.setFullScreen(false);
		}
		void youtubeWindow?.webContents.executeJavaScript(
			'window.__deskreenYtResetForNavigation && window.__deskreenYtResetForNavigation()',
			true,
		);
		void applyWatchPageLayout();
	});

	youtubeWindow.webContents.on('did-navigate-in-page', () => {
		void youtubeWindow?.webContents.executeJavaScript(
			'window.__deskreenYtResetForNavigation && window.__deskreenYtResetForNavigation()',
			true,
		);
		void applyWatchPageLayout();
	});
}

export function isYouTubeWindowOpen(): boolean {
	return youtubeWindow !== null && !youtubeWindow.isDestroyed();
}

export function getYouTubeWindowTitle(): string {
	return YOUTUBE_WINDOW_TITLE;
}

export function openYouTubePlayerWindow(_serverPort?: number): BrowserWindow {
	if (youtubeWindow && !youtubeWindow.isDestroyed()) {
		youtubeWindow.show();
		return youtubeWindow;
	}

	const display = pickOutputDisplay();
	const { x, y, width, height } = display.workArea;

	const winHeight = Math.min(720, Math.floor(height * 0.65));
	const winWidth = Math.round((winHeight * 16) / 9);

	youtubeWindow = new BrowserWindow({
		x: x + Math.max(0, width - winWidth - 24),
		y: y + 24,
		width: winWidth,
		height: winHeight,
		title: YOUTUBE_WINDOW_TITLE,
		backgroundColor: '#000000',
		autoHideMenuBar: true,
		fullscreenable: true,
		show: true,
		webPreferences: {
			partition: YOUTUBE_PARTITION,
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: false,
			backgroundThrottling: false,
		},
	});

	youtubeWindow.webContents.setBackgroundThrottling(false);

	attachNavigationHandlers();

	youtubeWindow.on('closed', () => {
		youtubeWindow = null;
		stopPolling();
		lastSnapshot = null;
		lastEmittedState = -2;
		lastVideoReadyId = '';
		layoutCssKey = '';
		loadInFlight = null;
		pendingVideoId = null;
	});

	startPolling();
	return youtubeWindow;
}

export function focusYouTubePlayerWindow(): void {
	if (youtubeWindow && !youtubeWindow.isDestroyed()) {
		youtubeWindow.show();
		youtubeWindow.focus();
	}
}

export async function openYouTubeSignIn(): Promise<void> {
	openYouTubePlayerWindow();
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}
	await youtubeWindow.loadURL(
		'https://accounts.google.com/signin/v2/identifier?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F&flowName=GlifWebSignIn',
	);
	youtubeWindow.show();
	youtubeWindow.focus();
}

export function closeYouTubePlayerWindow(): void {
	stopPolling();
	if (youtubeWindow && !youtubeWindow.isDestroyed()) {
		if (youtubeWindow.isFullScreen()) {
			youtubeWindow.setFullScreen(false);
		}
		youtubeWindow.close();
	}
	youtubeWindow = null;
	lastSnapshot = null;
	lastEmittedState = -2;
	lastVideoReadyId = '';
	layoutCssKey = '';
	loadInFlight = null;
	pendingVideoId = null;
}

export function getYouTubeWindowSourceId(): string | null {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return null;
	}
	try {
		const nativeHandle = youtubeWindow.getNativeWindowHandle();
		if (!nativeHandle || nativeHandle.length < 4) {
			return null;
		}
		const windowId = nativeHandle.readUInt32LE(0);
		return `window:${windowId}:0`;
	} catch {
		return null;
	}
}

async function navigateToVideo(safeId: string): Promise<'spa' | 'full'> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return 'full';
	}

	const currentUrl = youtubeWindow.webContents.getURL();
	if (isWatchPageUrl(currentUrl)) {
		await injectLayoutController();
		const usedSpa = (await youtubeWindow.webContents.executeJavaScript(
			`window.__deskreenYtNavigateSpa && window.__deskreenYtNavigateSpa(${JSON.stringify(safeId)})`,
			true,
		)) as boolean;
		if (usedSpa) {
			return 'spa';
		}
	}

	const url = `https://www.youtube.com/watch?v=${safeId}&autoplay=1`;
	await youtubeWindow.loadURL(url);
	return 'full';
}

async function loadYouTubeVideoInternal(
	videoId: string,
	_serverPort?: number,
): Promise<void> {
	const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
	if (!safeId) {
		throw new Error('invalid video id');
	}

	openYouTubePlayerWindow(_serverPort);
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}

	lastEmittedState = -2;
	lastVideoReadyId = '';

	await navigateToVideo(safeId);
	await new Promise((resolve) => setTimeout(resolve, 400));
	await applyWatchPageLayout();
	const ready = await waitForVideoLayerReady(safeId);
	if (!ready) {
		throw new Error(`YouTube video layer not ready: ${safeId}`);
	}
}

export async function loadYouTubeVideo(
	videoId: string,
	_serverPort?: number,
): Promise<void> {
	const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
	if (!safeId) {
		throw new Error('invalid video id');
	}

	if (loadInFlight) {
		pendingVideoId = safeId;
		await loadInFlight;
		if (pendingVideoId && pendingVideoId !== safeId) {
			return loadYouTubeVideo(pendingVideoId, _serverPort);
		}
		return;
	}

	loadInFlight = (async () => {
		await new Promise((resolve) => setTimeout(resolve, LOAD_DEBOUNCE_MS));
		await loadYouTubeVideoInternal(safeId, _serverPort);
	})();

	try {
		await loadInFlight;
	} finally {
		loadInFlight = null;
		const next = pendingVideoId;
		pendingVideoId = null;
		if (next && next !== safeId) {
			await loadYouTubeVideo(next, _serverPort);
		}
	}
}

export async function playYouTubeVideo(): Promise<void> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}
	await youtubeWindow.webContents.executeJavaScript(START_PLAYBACK, true);
}

export async function pauseYouTubeVideo(): Promise<void> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}
	await youtubeWindow.webContents.executeJavaScript(
		`(function(){ const v=document.querySelector('video'); if(v) v.pause(); })()`,
		true,
	);
}

export async function seekYouTubeVideo(seconds: number): Promise<void> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}
	const t = Math.max(0, seconds);
	await youtubeWindow.webContents.executeJavaScript(
		`(function(){ const v=document.querySelector('video'); if(v) v.currentTime=${t}; })()`,
		true,
	);
}

export async function setYouTubeVolume(level: number): Promise<void> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return;
	}
	const vol = Math.min(1, Math.max(0, level));
	await youtubeWindow.webContents.executeJavaScript(
		`(function(){ const v=document.querySelector('video'); if(v) v.volume=${vol}; })()`,
		true,
	);
}

export async function getYouTubePlayerInfo(): Promise<YouTubeOutputPlayerSnapshot | null> {
	return pollPlayerState();
}

export async function getYouTubePlayerDebugInfo(): Promise<YouTubePlayerDebugInfo | null> {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		return null;
	}
	try {
		return (await youtubeWindow.webContents.executeJavaScript(
			GET_PLAYER_DEBUG_INFO,
			true,
		)) as YouTubePlayerDebugInfo;
	} catch {
		return null;
	}
}

export async function applyInWindowTheaterMode(): Promise<void> {
	await applyWatchPageLayout();
}

export function enterYouTubePlayerFullscreen(): void {
	void applyInWindowTheaterMode();
}
