/**
 * Shared YouTube watch-page kiosk layout (full watch URLs — never /embed/).
 * Used by Karol Mac player and android-player WebView.
 */
(function () {
	if (window.__deskreenYtLayout) {
		window.__deskreenYtApplyLayout();
		return true;
	}
	window.__deskreenYtLayout = true;

	// Auto-dismiss YouTube consent dialog (blocks playback until accepted)
	(function autoDismissConsent() {
		if (!location.hostname.includes('consent.youtube')) return;
		function acceptConsent() {
			// Try various accept button selectors
			var btns = document.querySelectorAll(
				'button, input[type="submit"], form input[type="submit"]'
			);
			for (var i = 0; i < btns.length; i++) {
				var b = btns[i];
				var label = (b.textContent || '').trim().toLowerCase();
				var aria = (b.getAttribute('aria-label') || '').toLowerCase();
				if (label.includes('accept') || label.includes('agree') ||
					label.includes('i agree') || label.includes('allow') ||
					aria.includes('accept') || aria.includes('agree')) {
					b.click();
					return true;
				}
			}
			// Fallback: submit the form
			var form = document.querySelector('form');
			if (form) { form.submit(); return true; }
			return false;
		}
		// Try immediately, then retry
		setTimeout(function() {
			if (!acceptConsent()) {
				setTimeout(acceptConsent, 1000);
			}
		}, 500);
	})();

	function isPlayerMode() {
		return (
			window.__deskreenYtPlayerMode === true ||
			(navigator.userAgent || '').indexOf('KarolPlayer') !== -1
		);
	}

	var HIDE = [
		'#masthead-container',
		'#comments',
		'#related',
		'#secondary',
		'#below',
		'#chat',
		'#info',
		'#meta',
		'#meta-contents',
		'ytd-watch-metadata',
		'ytd-playlist-panel',
		'ytd-watch-next-secondary-results',
		'ytd-engagement-panel-section-list-renderer',
		'ytd-rich-section-renderer',
		'ytd-item-section-renderer',
		'ytd-browse',
		'ytd-video-description-transcript-section-renderer',
		'ytd-expandable-metadata-renderer',
		'#ticket-shelf',
		'#merch-shelf',
		'ytd-merch-shelf-renderer',
		'.ytp-chrome-top',
		'.ytp-gradient-top',
		'.ytp-show-cards-title',
		'.ytp-ce-element',
		'.ytp-endscreen-content',
		'.ytp-videowall-still',
		'ytd-reel-shelf-renderer',
		'#clarify-box',
		'#description',
		'#description-inner',
		'.ytp-ad-module',
		'.ytp-ad-player-overlay',
		'.ytp-ad-image',
		'.ytp-ad-text',
		'.video-ads',
		'ytd-ad-slot-renderer',
		'ytd-display-ad-renderer',
		'ytd-in-feed-ad-layout-renderer',
		'ytd-promoted-sparkles-web-renderer',
		'ytd-banner-promo-renderer',
	].join(',');

	function viewportHeightPx() {
		var vv = window.visualViewport;
		if (vv && vv.height > 0) {
			return Math.round(vv.height) + 'px';
		}
		return window.innerHeight + 'px';
	}

	function syncViewportHeight() {
		document.documentElement.style.setProperty('--karol-vh', viewportHeightPx());
	}

	function ensureViewportMeta() {
		if (!isPlayerMode()) {
			return;
		}
		var meta = document.querySelector('meta[name="viewport"]');
		if (!meta) {
			meta = document.createElement('meta');
			meta.setAttribute('name', 'viewport');
			document.head.appendChild(meta);
		}
		meta.setAttribute(
			'content',
			'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover',
		);
	}

	function injectKioskCss() {
		syncViewportHeight();
		var existing = document.getElementById('karol-yt-kiosk-css');
		var vh = 'var(--karol-vh, 100vh)';
		var playerShell = isPlayerMode()
			? 'ytd-watch-flexy,#columns,#primary,#player,#player-container-id,' +
				'#player-container,#full-bleed-container.ytd-watch-flexy,ytd-player,' +
				'#primary-inner,#player-container-outer,#player-container-inner,' +
				'ytd-page-manager,#page-manager,#content,#header,ytd-masthead{' +
				'margin:0!important;padding:0!important;top:0!important;' +
				'transform:none!important;min-height:0!important}' +
				'ytd-watch-flexy #primary-inner{padding-top:0!important;margin-top:0!important}' +
				'ytd-watch-flexy[theater] #primary.ytd-watch-flexy,' +
				'ytd-watch-flexy[full-bleed-player] #primary.ytd-watch-flexy{' +
				'margin-top:0!important;padding-top:0!important}'
			: '';
		var css =
			':root{--karol-vh:100vh}' +
			'html,body,ytd-app{margin:0!important;padding:0!important;overflow:hidden!important;background:transparent!important}' +
			'#movie_player,.html5-video-player{background:transparent!important}' +
			'#movie_player,.html5-video-player{width:100%!important;height:' +
			vh +
			'!important;max-height:' +
			vh +
			'!important}' +
			'ytd-watch-flexy[theater] #full-bleed-container.ytd-watch-flexy,' +
			'ytd-watch-flexy[full-bleed-player] #full-bleed-container.ytd-watch-flexy{height:' +
			vh +
			'!important;max-height:none!important;margin-top:0!important;padding-top:0!important}' +
			'ytd-watch-flexy[theater] video,ytd-watch-flexy[full-bleed-player] video,' +
			'.html5-video-player video{position:relative!important;top:0!important;left:0!important;' +
			'margin:0!important;padding:0!important;width:100%!important;height:' +
			vh +
			'!important;object-fit:contain!important}' +
			playerShell;
		if (existing) {
			existing.textContent = css;
			return;
		}
		var style = document.createElement('style');
		style.id = 'karol-yt-kiosk-css';
		style.textContent = css;
		document.head.appendChild(style);
	}

	function hidePanels() {
		try {
			document.querySelectorAll(HIDE).forEach(function (el) {
				el.style.setProperty('display', 'none', 'important');
				el.style.setProperty('visibility', 'hidden', 'important');
			});
		} catch (e) {
			/* ignore */
		}
	}

	/** Player tablet: downmix stereo to (L+R)/2 on both output channels. */
	var monoPipeline = null;

	function readStoredVolume() {
		try {
			var stored = sessionStorage.getItem('karolVolume');
			if (stored !== null && stored !== '') {
				var parsed = parseFloat(stored);
				if (Number.isFinite(parsed)) {
					return Math.max(0, Math.min(1, parsed));
				}
			}
		} catch (e) {
			/* ignore */
		}
		return null;
	}

	function persistVolumeLevel(level) {
		var clamped = Math.max(0, Math.min(1, level));
		window.__deskreenVolumeLevel = clamped;
		try {
			sessionStorage.setItem('karolVolume', String(clamped));
		} catch (e) {
			/* ignore */
		}
		return clamped;
	}

	var storedVol = readStoredVolume();
	window.__deskreenVolumeLevel =
		typeof window.__deskreenVolumeLevel === 'number'
			? window.__deskreenVolumeLevel
			: storedVol !== null
				? storedVol
				: 1;	
	function getDesiredOutputLevel() {
		if (typeof window.__deskreenVolumeLevel === 'number') {
			return Math.max(0, Math.min(1, window.__deskreenVolumeLevel));
		}
		var fromStore = readStoredVolume();
		if (fromStore !== null) {
			window.__deskreenVolumeLevel = fromStore;
			return fromStore;
		}
		return 1;
	}

	window.__deskreenYtReapplyVolume = function () {
		var level = getDesiredOutputLevel();
		if (applyMonoOutputLevel(level)) {
			return true;
		}
		var v = document.querySelector('video');
		if (!v) {
			return false;
		}
		v.volume = level;
		v.muted = level <= 0;
		return true;
	};

	function getAudioContextCtor() {
		return (
			window.AudioContext ||
			(window.webkitAudioContext ? window.webkitAudioContext : null)
		);
	}

	window.__deskreenYtReleaseMonoPipeline = function () {
		if (!monoPipeline) {
			return;
		}
		try {
			monoPipeline.source.disconnect();
			monoPipeline.splitter.disconnect();
			monoPipeline.monoMix.disconnect();
			monoPipeline.merger.disconnect();
			monoPipeline.outputGain.disconnect();
		} catch (e) {
			/* ignore */
		}
		if (monoPipeline.audioContext) {
			monoPipeline.audioContext.close().catch(function () {});
		}
		monoPipeline = null;
	};

	function resumeMonoAudioContext() {
		if (
			monoPipeline &&
			monoPipeline.audioContext &&
			monoPipeline.audioContext.state === 'suspended'
		) {
			monoPipeline.audioContext.resume().catch(function () {});
		}
	}

	function attachMonoPipeline(video) {
		if (!isPlayerMode() || !video) {
			return false;
		}
		if (monoPipeline && monoPipeline.video === video) {			applyMonoOutputLevel(getDesiredOutputLevel());
			resumeMonoAudioContext();
			return true;
		}
		var needsMuteGate =
			!video.paused &&
			video.readyState >= 2 &&
			Number.isFinite(video.currentTime) &&
			video.currentTime > 0.05;
		if (needsMuteGate) {
			video.muted = true;
		}		window.__deskreenYtReleaseMonoPipeline();
		var AudioContextCtor = getAudioContextCtor();
		if (!AudioContextCtor) {
			if (needsMuteGate) {
				video.muted = false;
			}
			return false;
		}
		try {
			var ctx = new AudioContextCtor();
			var source = ctx.createMediaElementSource(video);
			var splitter = ctx.createChannelSplitter(2);
			var monoMix = ctx.createGain();
			monoMix.gain.value = 0.5;
			var merger = ctx.createChannelMerger(2);
			var outputGain = ctx.createGain();
			outputGain.gain.value = getDesiredOutputLevel();

			source.connect(splitter);
			splitter.connect(monoMix, 0);
			splitter.connect(monoMix, 1);
			monoMix.connect(merger, 0, 0);
			monoMix.connect(merger, 0, 1);
			merger.connect(outputGain);
			outputGain.connect(ctx.destination);

			// Route level through Web Audio; keep element at unity.
			video.volume = 1;
			video.muted = false;

			if (ctx.state === 'suspended') {
				ctx.resume().catch(function () {});
			}

			monoPipeline = {
				video: video,
				audioContext: ctx,
				source: source,
				splitter: splitter,
				monoMix: monoMix,
				merger: merger,
				outputGain: outputGain,
			};
			applyMonoOutputLevel(getDesiredOutputLevel());
			return true;
		} catch (e) {
			if (needsMuteGate) {
				video.muted = false;
			}
			return false;
		}
	}

	function applyMonoOutputLevel(level) {
		var clamped = Math.max(0, Math.min(1, level));
		if (monoPipeline && monoPipeline.outputGain) {
			monoPipeline.outputGain.gain.value = clamped;
			return true;
		}
		return false;
	}

	window.__deskreenYtEnableFullscreen = function () {
		// Already in fullscreen (either YouTube native or Deskreen custom view)?
		if (document.fullscreenElement || window.__deskreenFullscreenAttempted) {
			return true;
		}
		// Click YouTube's fullscreen button — mobile YouTube has .ytp-fullscreen-button
		var btn =
			document.querySelector('.ytp-fullscreen-button') ||
			document.querySelector('button.ytp-button[aria-label*="Full screen"]') ||
			document.querySelector('button.ytp-button[aria-label*="fullscreen"]') ||
			document.querySelector('button.ytp-button[aria-label*="Fullscreen"]');
		if (btn) {
			window.__deskreenFullscreenAttempted = true;
			btn.click();
			return true;
		}
		return false;
	};

	window.__deskreenYtEnableTheaterOnce = function () {
		if (window.__deskreenTheaterDone) {
			return;
		}
		var flexy = document.querySelector('ytd-watch-flexy');
		if (
			flexy &&
			(flexy.hasAttribute('theater') || flexy.hasAttribute('full-bleed-player'))
		) {
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

	window.__deskreenYtExitPageFullscreen = function () {
		if (!document.fullscreenElement) {
			return false;
		}
		var exitBtn =
			document.querySelector('.ytp-fullscreen-button[aria-label*="Exit"]') ||
			document.querySelector('.ytp-fullscreen-button[aria-label*="exit"]') ||
			document.querySelector('.ytp-fullscreen-button');
		if (exitBtn) {
			exitBtn.click();
			return true;
		}
		if (document.exitFullscreen) {
			document.exitFullscreen().catch(function () {});
			return true;
		}
		return false;
	};

	var fixVideoLayerPending = false;
	var fixVideoLayerLastAt = 0;
	function fixVideoLayerImpl() {
		var v = document.querySelector('video');
		if (!v) {
			return false;
		}
		var now = Date.now();
		if (now - fixVideoLayerLastAt < 400) {
			return false;
		}
		fixVideoLayerLastAt = now;		if (isPlayerMode()) {
			syncViewportHeight();
		}
		var vh = viewportHeightPx();
		v.style.setProperty('opacity', '1', 'important');
		v.style.setProperty('visibility', 'visible', 'important');
		v.style.removeProperty('transform');
		v.style.setProperty('top', '0', 'important');
		v.style.setProperty('left', '0', 'important');
		v.style.setProperty('margin-top', '0', 'important');
		v.style.setProperty('margin-left', '0', 'important');
		v.style.setProperty('padding', '0', 'important');
		v.style.setProperty('width', '100%', 'important');
		v.style.setProperty('height', vh, 'important');
		v.style.setProperty('max-height', vh, 'important');
		v.style.setProperty('object-fit', 'contain', 'important');
		v.style.setProperty('object-position', 'center top', 'important');

		var player =
			document.querySelector('#movie_player') ||
			document.querySelector('.html5-video-player');
		if (player && isPlayerMode()) {
		 player.style.setProperty('margin-top', '0', 'important');
			player.style.setProperty('padding-top', '0', 'important');
			player.style.setProperty('top', '0', 'important');
			player.style.setProperty('height', vh, 'important');
		}

		if (isPlayerMode()) {
			var rect = v.getBoundingClientRect();
			if (rect.top > 1) {
				v.style.setProperty('margin-top', '-' + Math.round(rect.top) + 'px', 'important');
			}
		}
		var rect = v.getBoundingClientRect();
		return v.videoWidth > 0 && v.readyState >= 2 && rect.height > 0;
	}

	window.__deskreenYtFixVideoLayer = function () {
		if (fixVideoLayerPending) {
			return false;
		}
		fixVideoLayerPending = true;
		requestAnimationFrame(function () {
			fixVideoLayerPending = false;
			fixVideoLayerImpl();
		});
		return true;
	};

	window.__deskreenYtApplyLayout = function () {
		if (!location.pathname.includes('/watch')) {
			return;
		}
		ensureViewportMeta();
		injectKioskCss();
		hidePanels();
		window.__deskreenYtEnableTheaterOnce();
		window.__deskreenYtFixVideoLayer();
		window.__deskreenYtReapplyVolume();
		// Make all video ancestors transparent so the hardware video surface
		// (which composites behind WebView content on Android) shows through.
		var v = document.querySelector('video');
		if (v) {
			var el = v.parentElement;
			while (el && el !== document.documentElement) {
				el.style.setProperty('background-color', 'transparent', 'important');
				el.style.setProperty('background', 'transparent', 'important');
				el = el.parentElement;
			}
		}
		// Trigger fullscreen after layout settles. Mobile YouTube serves a compact
		// player — native fullscreen gives us the hardware video surface edge-to-edge.
		window.__deskreenFullscreenAttempted = false;
		[800, 2000, 5000].forEach(function (ms) {
			setTimeout(function () {
				window.__deskreenYtEnableFullscreen();
			}, ms);
		});		(function () {
			var flexy = document.querySelector('ytd-watch-flexy');
			var v = document.querySelector('video');
			var rect = v ? v.getBoundingClientRect() : null;
		})();	};

	window.__deskreenYtResetForNavigation = function () {
		window.__deskreenTheaterDone = false;
		window.__deskreenFullscreenAttempted = false;
		window.__deskreenYtReleaseMonoPipeline();
	};

	window.__deskreenYtNavigateSpa = function (videoId) {
		/* Android player uses full page loads; SPA kept for Mac Electron. */
		window.__deskreenYtResetForNavigation();
		var url = '/watch?v=' + videoId + '&autoplay=1';
		var app = document.querySelector('ytd-app');
		if (app && typeof app.navigate === 'function') {
			app.navigate({ endpoint: url });
			setTimeout(function () {
				window.__deskreenYtApplyLayout();
			}, 400);
			return true;
		}
		return false;
	};

	window.__deskreenYtReadSnapshot = function () {
		var v = document.querySelector('video');
		var params = new URLSearchParams(window.location.search);
		var videoId = params.get('v') || '';
		var metaTitle =
			document.querySelector('h1.ytd-watch-metadata yt-formatted-string')
				?.textContent ||
			document.querySelector('h1 yt-formatted-string')?.textContent ||
			'';
		var title = (metaTitle || document.title || '')
			.replace(/\s*-\s*YouTube\s*$/, '')
			.trim();
		if (!v) {
			return {
				state: 3,
				videoId: videoId,
				title: title,
				currentTime: 0,
				duration: 0,
				paused: true,
				ended: false,
				hasVideo: false,
				layoutOk: false,
				videoTopPx: 0,
			};
		}
		var state = 3;
		if (v.ended) {
			state = 0;
		} else if (v.paused) {
			state = 2;
		} else if (v.readyState >= 2) {
			state = 1;
		}
		var rect = v.getBoundingClientRect();
		var layoutOk = v.videoWidth > 0 && v.readyState >= 2 && rect.height > 0 && rect.top <= 2;
		return {
			state: state,
			videoId: videoId,
			title: title,
			currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
			duration: Number.isFinite(v.duration) ? v.duration : 0,
			paused: v.paused,
			ended: v.ended,
			hasVideo: true,
			layoutOk: layoutOk,
			videoTopPx: Math.round(rect.top),
		};
	};

	window.__deskreenYtSoftRecover = function (seekTo) {
		var v = document.querySelector('video');
		window.__deskreenYtApplyLayout();
		if (!v) {
			return false;
		}
		if (typeof seekTo === 'number' && seekTo > 0.25 && Number.isFinite(seekTo)) {
			try {
				var max = Number.isFinite(v.duration) && v.duration > 0 ? v.duration - 0.5 : seekTo;
				v.currentTime = Math.min(seekTo, max);
			} catch (e) {
				/* ignore */
			}
		}
		if (!(monoPipeline && monoPipeline.video === v)) {
			attachMonoPipeline(v);
		}
		window.__deskreenYtReapplyVolume();
		resumeMonoAudioContext();
		return window.__deskreenYtEnsurePlaying();
	};

	window.__deskreenYtEnsurePlaying = function () {
		var v = document.querySelector('video');
		if (!v) {
			return false;
		}
		if (!v.paused && !v.ended) {
			return true;
		}
		// Muted autoplay is always allowed by WebView autoplay policy.
		// Play muted first, then unmute after the promise resolves.
		var wasMuted = v.muted;
		v.muted = true;
		if (isPlayerMode()) {
			if (!(monoPipeline && monoPipeline.video === v)) {
				attachMonoPipeline(v);
			}
		}
		// Write play attempt time to a global for debugging
		window.__deskreenYtLastPlayAttempt = Date.now();
		var p = v.play();
		if (p && typeof p.then === 'function') {
			p.then(function() {
				window.__deskreenYtPlayResolved = Date.now();
				// Playback started — restore volume if in player mode
				if (isPlayerMode()) {
					v.muted = false;
					window.__deskreenYtReapplyVolume();
					resumeMonoAudioContext();
				} else {
					v.muted = wasMuted;
				}
			}).catch(function(e) {
				window.__deskreenYtPlayRejected = Date.now();
				window.__deskreenYtPlayError = String(e);
				v.muted = wasMuted;
			});
		}
		return true;
	};

	window.__deskreenYtPlay = function () {
		var v = document.querySelector('video');
		if (v) {
			v.muted = false;
			if (isPlayerMode()) {
				if (!(monoPipeline && monoPipeline.video === v)) {
					attachMonoPipeline(v);
				}
				window.__deskreenYtReapplyVolume();
				resumeMonoAudioContext();
			}
			if (!v.paused && !v.ended) {
				return true;
			}
			var p = v.play();
			if (p && typeof p.catch === 'function') {
				p.catch(function () {});
			}
			return true;
		}
		var playBtn =
			document.querySelector('.ytp-play-button') ||
			document.querySelector('button[aria-label="Play"]');
		if (playBtn) {
			playBtn.click();
			return true;
		}
		return false;
	};

	window.__deskreenYtPause = function () {
		var v = document.querySelector('video');
		if (v) {
			v.pause();
			return true;
		}
		var pauseBtn =
			document.querySelector('.ytp-play-button[aria-label*="Pause"]') ||
			document.querySelector('button[aria-label="Pause"]');
		if (pauseBtn) {
			pauseBtn.click();
			return true;
		}
		return false;
	};

	window.__deskreenYtSeek = function (seconds) {
		var v =
			(monoPipeline && monoPipeline.video) || document.querySelector('video');
		if (!v) {			return false;
		}
		var target = Math.max(0, seconds);
		if (Number.isFinite(v.duration) && v.duration > 0) {
			target = Math.min(target, Math.max(0, v.duration - 0.25));
		}
		var before = v.currentTime;
		var wasPlaying = !v.paused && !v.ended;
		try {
			if (wasPlaying) {
				v.pause();
			}
			v.currentTime = target;
		} catch (e) {			return false;
		}		if (wasPlaying) {
			var p = v.play();
			if (p && typeof p.catch === 'function') {
				p.catch(function () {});
			}
		}
		return true;
	};

	window.__deskreenYtSetVolume = function (level) {
		var clamped = persistVolumeLevel(level);
		if (applyMonoOutputLevel(clamped)) {
			return true;
		}
		var v = document.querySelector('video');
		if (!v) {
			return false;
		}
		v.volume = clamped;
		v.muted = clamped <= 0;
		return true;
	};

	var lastUrl = location.href;
	function getUrlVideoId() {
		return new URLSearchParams(location.search).get('v') || '';
	}

	window.__deskreenYtResetEndedTracking = function () {
		endedState.maxDurationSeen = 0;
		endedState.durationStableSince = 0;
		endedState.lastDuration = 0;
		endedState.lastEndedAt = 0;
	};

	var unexpectedCheckTimer = null;
	function checkExpectedVideoId() {
		var expected = window.__deskreenYtExpectedVideoId;
		if (!expected) {
			return;
		}
		var found = getUrlVideoId();
		if (!found || found === expected) {
			if (unexpectedCheckTimer) {
				clearTimeout(unexpectedCheckTimer);
				unexpectedCheckTimer = null;
			}
			return;
		}
		if (unexpectedCheckTimer) {
			return;
		}
		unexpectedCheckTimer = setTimeout(function () {
			unexpectedCheckTimer = null;
			var again = getUrlVideoId();
			if (again && again !== expected) {
				if (window.KarolPlayer && KarolPlayer.onUnexpectedVideoId) {
					KarolPlayer.onUnexpectedVideoId(again);
				}
			}
		}, 2000);
	}

	function onUrlChange() {
		if (location.href === lastUrl) {
			return;
		}
		var prevId = '';
		try {
			prevId = new URL(lastUrl, location.origin).searchParams.get('v') || '';
		} catch (e) {
			prevId = '';
		}
		lastUrl = location.href;
		checkExpectedVideoId();
		var newId = getUrlVideoId();
		if (prevId === newId) {
			return;
		}
		window.__deskreenYtResetForNavigation();
		[400, 1200].forEach(function (ms) {
			setTimeout(function () {
				window.__deskreenYtApplyLayout();
			}, ms);
		});
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

	if (window.visualViewport) {
		window.visualViewport.addEventListener('resize', function () {
			if (!location.pathname.includes('/watch')) {
				return;
			}
			syncViewportHeight();
			window.__deskreenYtFixVideoLayer();
		});
	}
	window.addEventListener('resize', function () {
		if (!location.pathname.includes('/watch')) {
			return;
		}
		syncViewportHeight();
		window.__deskreenYtFixVideoLayer();
	});

	var mo = new MutationObserver(function () {
		if (location.pathname.includes('/watch')) {
			hidePanels();
			bindEndedListener();
			bindMonoPipelineEarly();
		}
	});
	if (document.body) {
		mo.observe(document.body, { childList: true, subtree: true });
	}

	injectKioskCss();
	window.__deskreenYtApplyLayout();

	function startAdGuard() {
		if (!isPlayerMode() || window.__deskreenYtAdGuard) {
			return;
		}
		window.__deskreenYtAdGuard = true;

		function trySkipAd() {
			// 1. Click skip button (after 5s for skippable ads)
			var skip =
				document.querySelector('.ytp-ad-skip-button') ||
				document.querySelector('.ytp-ad-skip-button-modern') ||
				document.querySelector('.ytp-ad-skip-button-container button') ||
				document.querySelector('.videoAdUiSkipButton');
			if (skip) {
				skip.click();
				return true;
			}

			// 2. For non-skippable ads: seek video to its end
		var v = document.querySelector('video');
		var container = v && v.closest ? v.closest('.html5-video-player') : null;
		if (container && container.classList.contains('ad-showing')) {
			if (v.duration && isFinite(v.duration)) {
				v.currentTime = v.duration - 0.01;
			} else {
				// Ad present but video not loaded — force a large seek past ad
				v.currentTime = 120;
			}
			return true;
		}

			// 3. Close overlay ads
			var close =
				document.querySelector('.ytp-ad-overlay-close-button') ||
				document.querySelector('.ytp-ad-overlay-close-container .ytp-button');
			if (close) {
				close.click();
				return true;
			}
			return false;
		}

		// Fast poll for ad detection and skipping
		setInterval(function () {
			if (!location.pathname.includes('/watch')) {
				return;
			}
			trySkipAd();

			// Hide any ad visual elements
			try {
				document.querySelectorAll(
					'.ytp-ad-module, .video-ads, .ytp-ad-player-overlay, ' +
					'.ytp-ad-image, .ytp-ad-text, .ytp-ad-persistent-rollover, ' +
					'.ytp-ad-player-overlay-layout'
				).forEach(function (el) {
					el.style.setProperty('display', 'none', 'important');
				});
			} catch (e) {
				/* ignore */
			}
		}, 250);

		// Also use a MutationObserver for instant detection
		var adObserver = new MutationObserver(function () {
			if (!location.pathname.includes('/watch')) return;
			trySkipAd();
		});
		if (document.body) {
			adObserver.observe(document.body, {
				childList: true,
				subtree: true,
			});
		}
	}

	var endedVideo = null;
	var endedState = {
		maxDurationSeen: 0,
		durationStableSince: 0,
		lastDuration: 0,
		lastEndedAt: 0,
	};

	function updateDurationTracking(v) {
		if (!v) {
			return;
		}
		var d = Number.isFinite(v.duration) ? v.duration : 0;
		if (d > endedState.maxDurationSeen) {
			endedState.maxDurationSeen = d;
		}
		if (d !== endedState.lastDuration) {
			endedState.lastDuration = d;
			endedState.durationStableSince = Date.now();
		}
	}

	function bindEndedListener() {
		var v = document.querySelector('video');
		if (!v || v === endedVideo) {
			return;
		}
		if (endedVideo) {
			endedVideo.removeEventListener('ended', onVideoEnded);
			endedVideo.removeEventListener('timeupdate', onTimeUpdateForEnded);
		}
		endedVideo = v;
		v.addEventListener('ended', onVideoEnded);
		v.addEventListener('timeupdate', onTimeUpdateForEnded);
		updateDurationTracking(v);
	}

	function onTimeUpdateForEnded() {
		updateDurationTracking(endedVideo);
	}

	function onVideoEnded() {
		var v = endedVideo || document.querySelector('video');
		if (!v) {
			return;
		}
		var now = Date.now();
		if (now - endedState.lastEndedAt < 5000) {
			return;
		}
		updateDurationTracking(v);
		var expected = window.__deskreenYtExpectedVideoId || getUrlVideoId();
		var currentTime = Number.isFinite(v.currentTime) ? v.currentTime : 0;
		var maxDur = endedState.maxDurationSeen;
		if (maxDur < 30) {
			return;
		}
		if (now - endedState.durationStableSince < 8000) {
			return;
		}
		if (currentTime < maxDur - 4) {
			return;
		}
		endedState.lastEndedAt = now;
		if (window.KarolPlayer && KarolPlayer.onPlaybackEnded && expected) {
			KarolPlayer.onPlaybackEnded(expected);
		}
	}
	function bindMonoPipelineEarly() {
		if (!isPlayerMode()) {
			return;
		}
		var v = document.querySelector('video');
		if (!v || (monoPipeline && monoPipeline.video === v)) {
			return;
		}
		if (v.__deskreenPipelineArmed) {
			return;
		}
		v.__deskreenPipelineArmed = true;
		var attachFromEarlyEvent = function (source) {
			if (monoPipeline && monoPipeline.video === v) {
				return;
			}			attachMonoPipeline(v);
			window.__deskreenYtReapplyVolume();
			resumeMonoAudioContext();
		};
		if (v.readyState >= 1) {
			attachFromEarlyEvent('already-metadata');
			return;
		}
		v.addEventListener(
			'loadedmetadata',
			function () {
				attachFromEarlyEvent('loadedmetadata');
			},
			{ once: true },
		);
		v.addEventListener(
			'loadeddata',
			function () {
				attachFromEarlyEvent('loadeddata');
			},
			{ once: true },
		);
	}

	bindEndedListener();
	bindMonoPipelineEarly();
	startAdGuard();
	var endedMo = new MutationObserver(function () {
		if (location.pathname.includes('/watch')) {
			bindEndedListener();
			bindMonoPipelineEarly();
		}
	});
	if (document.body) {
		endedMo.observe(document.body, { childList: true, subtree: true });
	}

	return true;
})();
