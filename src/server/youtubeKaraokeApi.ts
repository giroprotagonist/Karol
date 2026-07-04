import Router from 'koa-router';
import { BrowserWindow } from 'electron';
import { IpcEvents } from '../common/IpcEvents.enum';
import type { YouTubeQueueItem } from '../common/YouTubeKaraokeTypes';
import {
	openYouTubePlayerWindow,
	loadYouTubeVideo,
	getYouTubeWindowSourceId,
} from '../main/helpers/youtubeKaraokeWindow';
import { signalingServer } from './index';
import { store } from '../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../common/ElectronStoreKeys.enum';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';
import { setPreferredDesktopCapturerSourceId } from '../main/helpers/configureScreenCaptureSession';

const PLAYER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Deskreen YouTube Player</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self' https://www.youtube.com https://*.youtube.com https://*.ytimg.com https://*.ggpht.com https://*.googleapis.com; script-src 'self' https://www.youtube.com https://*.youtube.com 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src https://www.youtube.com; media-src 'self'; connect-src https://www.youtube.com https://*.youtube.com https://*.googleapis.com;">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
#player { width: 100%; height: 100%; }
#status { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: rgba(255,255,255,0.6); font-family: -apple-system, sans-serif; font-size: 18px; pointer-events: none; z-index: 2; }
</style>
</head>
<body>
<div id="player"></div>
<div id="status">Waiting for video...</div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
(function () {
  var player = null;
  var currentVideoId = '';
  var lastState = -2;

  function hideStatus() { var el = document.getElementById('status'); if (el) el.style.display = 'none'; }
  function showStatus(msg) { var el = document.getElementById('status'); if (el) { el.style.display = 'block'; el.textContent = msg; } }

  function notifyState(state) {
    if (state === lastState) return;
    lastState = state;
    var title = player && player.getVideoData ? (player.getVideoData().title || '') : '';
    console.log('[YT_STATE]', JSON.stringify({ state: state, videoId: currentVideoId, title: title }));
  }

  function createPlayer() {
    if (player) return;
    player = new YT.Player('player', {
      height: '100%', width: '100%', videoId: '',
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, rel: 0, showinfo: 0, origin: window.location.origin },
      events: {
        onReady: function () { hideStatus(); notifyState(-2); },
        onStateChange: function (event) { notifyState(event.data); },
        onError: function (event) { console.error('[YT_ERROR] code=' + event.data); notifyState(-1); }
      }
    });
  }

  window.onYouTubeIframeAPIReady = function () { createPlayer(); };
  if (typeof YT !== 'undefined' && YT.Player) { createPlayer(); }

  var attempts = 0;
  var tryCreate = setInterval(function () {
    attempts++;
    if (player) { clearInterval(tryCreate); return; }
    if (typeof YT !== 'undefined' && YT.Player) createPlayer();
    if (attempts > 30) clearInterval(tryCreate);
  }, 500);

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || !data.type) return;
    switch (data.type) {
      case 'loadVideo':
        if (player && player.loadVideoById) {
          currentVideoId = data.videoId;
          showStatus('Loading...');
          player.loadVideoById({ videoId: data.videoId, startSeconds: 0 });
        }
        break;
      case 'pauseVideo': if (player && player.pauseVideo) player.pauseVideo(); break;
      case 'playVideo': if (player && player.playVideo) player.playVideo(); break;
      case 'seekTo': if (player && player.seekTo) player.seekTo(data.seconds, true); break;
      case 'getInfo':
        var info = { currentTime: 0, duration: 0, state: lastState };
        if (player && player.getCurrentTime) info.currentTime = player.getCurrentTime();
        if (player && player.getDuration) info.duration = player.getDuration();
        console.log('[YT_INFO]', JSON.stringify(info));
        break;
    }
  });
})();
</script>
</body>
</html>`;

export function registerYouTubeKaraokeApi(router: Router): void {
	// Serve the YouTube player HTML page at a proper origin (required by YouTube IFrame API)
	router.get('/youtube-player', (ctx) => {
		ctx.type = 'text/html';
		ctx.body = PLAYER_HTML;
	});
	router.post('/api/youtube-karaoke/queue', async (ctx) => {
		const body = ctx.request.body as {
			url?: string;
			action?: 'queue' | 'play-now';
		};
		const url = body?.url || '';
		const action = body?.action || 'queue';

		if (!url) {
			ctx.status = 400;
			ctx.body = { error: 'url is required' };
			return;
		}

		const videoId = extractUrlVideoId(url);
		if (!videoId) {
			ctx.status = 400;
			ctx.body = { error: 'invalid YouTube URL' };
			return;
		}

		const item: YouTubeQueueItem = {
			id: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			url,
			videoId,
			title: `YouTube: ${videoId}`,
			thumbnail: '',
			status: 'queued',
		};

		// Open the YouTube player window and load the video directly from the main process,
		// bypassing the renderer so it works even when karaoke mode hasn't been toggled on yet.
		if (action === 'play-now') {
			try {
				// Persist karaoke mode so auto-connect prefers the YouTube window
				store.set(ElectronStoreKeys.YouTubeKaraokeActive, 'true');
				const serverPort = signalingServer.port;

				// Open the YouTube player window
				openYouTubePlayerWindow(serverPort);
				await new Promise((resolve) => setTimeout(resolve, 1000));

				// Load the video
				loadYouTubeVideo(videoId, serverPort);
				await new Promise((resolve) => setTimeout(resolve, 500));

				// Get the YouTube window's native source ID directly from the
				// BrowserWindow (avoids source refresh which is blocked during
				// active capture).
				const ytSourceId = getYouTubeWindowSourceId();
				if (ytSourceId) {
					setPreferredDesktopCapturerSourceId(ytSourceId);
					store.set(ElectronStoreKeys.LastDesktopCapturerSourceId, ytSourceId);

					// Swap the capture source on all existing sessions mid‑stream.
					// setDesktopCapturerSourceID triggers a track‑replacement via
					// peer.replaceTrack() — the tablet doesn't even notice the switch.
					const deskreenGlobal = getDeskreenGlobal();
					const sessions = deskreenGlobal.sharingSessionService.sharingSessions;
					for (const [, session] of sessions) {
						session.setDesktopCapturerSourceID(ytSourceId);
					}

					// Also set on the waiting‑for‑connection session (future connects)
					const waitingSession = deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession;
					waitingSession?.setDesktopCapturerSourceID(ytSourceId);
				}
			} catch (err) {
				console.error('[YT_API] failed to setup karaoke session:', err);
			}
		}

		// Also send IPC events to all renderer windows so the karaoke panel UI updates
		const windows = BrowserWindow.getAllWindows();
		for (const win of windows) {
			if (!win.isDestroyed()) {
				win.webContents.send(IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO, item);
				if (action === 'play-now') {
					win.webContents.send('youtube-karaoke-play-now-from-api', videoId);
				}
			}
		}

		ctx.body = { ok: true, videoId, action };
	});

	router.get('/api/youtube-karaoke/health', (ctx) => {
		ctx.body = { ok: true };
	});
}

function extractUrlVideoId(url: string): string | null {
	try {
		const u = new URL(url);
		if (u.hostname.includes('youtube.com')) {
			return u.searchParams.get('v') || null;
		}
		if (u.hostname.includes('youtu.be')) {
			return u.pathname.slice(1).split('/')[0] || null;
		}
	} catch (_) {}
	return null;
}
