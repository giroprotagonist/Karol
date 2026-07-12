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
		'#masthead',
		'ytd-masthead',
		'#header',
		'ytd-page-manager',
		'#guide-inner-content',
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

	(function injectMinimalCss() {
		var style = document.createElement('style');
		style.id = 'karol-yt-kiosk-css';
		style.textContent =
			'html,body,ytd-app{background:#000!important;margin:0!important;padding:0!important;overflow:hidden!important}' +
			'#movie_player,.html5-video-player{background:#000!important}';
		document.head.appendChild(style);
	})();

	function hidePanels() {
		try {
			document.querySelectorAll(HIDE).forEach(function (el) {
				el.style.setProperty('display', 'none', 'important');
				el.style.setProperty('visibility', 'hidden', 'important');
			});
			// Traverse YouTube shadow roots to hide masthead/header
			try {
				var mastheadEl = document.querySelector('ytd-masthead') || document.querySelector('ytd-app');
				if (mastheadEl && mastheadEl.shadowRoot) {
					var shadowHide = mastheadEl.shadowRoot.querySelectorAll(
						'#container,#masthead-container,#header,ytd-masthead,#background,' +
						'#guide-inner-content,#start,#header-bar'
					);
					shadowHide.forEach(function (el) {
						el.style.setProperty('display', 'none', 'important');
						el.style.setProperty('visibility', 'hidden', 'important');
					});
				}
			} catch (e) { /* ignore shadow DOM errors */ }
			// Brute-force: find any top-level element at the very top with small height
			try {
				var all = document.querySelectorAll('body > *, ytd-app > *');
				for (var i = 0; i < all.length; i++) {
					var r = all[i].getBoundingClientRect();
					if (r.top <= 2 && r.height > 10 && r.height < 100 && r.width > 100) {
						all[i].style.setProperty('display', 'none', 'important');
						all[i].style.setProperty('visibility', 'hidden', 'important');
					}
				}
			} catch (e) { /* ignore */ }
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
		if (!btn && !isPlayerMode()) {
			btn = document.querySelector('button.ytp-button[aria-label*="Fullscreen"]');
		}
		if (btn) {
			btn.click();
			window.__deskreenTheaterDone = true;
		}	};

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

	window.__deskreenYtApplyLayout = function () {
		if (!location.pathname.includes('/watch')) {
			return;
		}
		hidePanels();
		window.__deskreenYtEnableTheaterOnce();
		window.__deskreenYtReapplyVolume();
	};

	window.__deskreenYtResetForNavigation = function () {
		window.__deskreenTheaterDone = false;
		window.__karolEndedFired = false;
		window.__karolQualityCapped = false;
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
				thumbnail: videoId ? 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg' : '',
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
			thumbnail: videoId ? 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg' : '',
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
				// Delayed re-check: YouTube's player may override mute/volume
				// asynchronously after our initial restoration.
				setTimeout(function () {
					if (v.paused || v.ended) return;
					if (v.muted) {
						console.log('[DeskreenDelayedCheck] video still muted after play — fixing');
						v.muted = false;
						window.__deskreenYtReapplyVolume();
						resumeMonoAudioContext();
					}
				}, 1500);
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
		window.__karolCurrentVideoId = newId;
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
		var expected = window.__deskreenYtExpectedVideoId || getUrlVideoId();
		var currentTime = Number.isFinite(v.currentTime) ? v.currentTime : 0;
		var maxDur = Number.isFinite(v.duration) ? v.duration : 0;
		if (maxDur > 0 && currentTime < maxDur - 10 && !v.ended) {
			return;
		}
		endedState.lastEndedAt = now;
		window.__karolEndedFired = true;
		if (window.KarolPlayer && KarolPlayer.onPlaybackEnded && expected) {
			KarolPlayer.onPlaybackEnded(expected);
		}
	}
	// Backup ended detection: polls the video element directly every 1s.
	// Catches cases where YouTube's DOM cleanup loses the JS ended event.
	var __karolEndedBackupInterval = setInterval(function () {
		if (window.__karolEndedFired) {
			return;
		}
		var v = document.querySelector('video');
		if (!v) {
			return;
		}
		if (v.ended) {
			window.__karolEndedFired = true;
			var vid = window.__karolCurrentVideoId || getUrlVideoId();
			if (window.KarolPlayer && window.KarolPlayer.onPlaybackEnded && vid) {
				window.KarolPlayer.onPlaybackEnded(vid);
			}
		}
	}, 1000);

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

	// Auto-recovery: periodically check that playing video isn't silently muted.
	// YouTube's player can override mute/volume state asynchronously after our
	// EnsurePlaying unmute — this catches that race and corrects it.
	var autoRecoveryTimer = null;
	function startAutoRecovery() {
		if (!isPlayerMode()) return;
		autoRecoveryTimer = setInterval(function () {
			if (!location.pathname.includes('/watch')) return;
			var v = document.querySelector('video');
			if (!v) return;
			var isAlive = !v.paused && !v.ended && v.readyState >= 2;
			if (!isAlive) return;
			var needsFix = v.muted;
			if (!needsFix) {
				var vol = Number.isFinite(v.volume) ? v.volume : 1;
				needsFix = vol < 0.01;
			}
			if (!needsFix) return;
			console.log('[DeskreenAutoRecovery] video playing but muted/zero-volume — fixing (muted=' + v.muted + ' vol=' + v.volume + ')');
			v.muted = false;
			var lvl = getDesiredOutputLevel();
			if (lvl < 0.01) lvl = 1;
			v.volume = lvl;
			if (isPlayerMode()) {
				if (!(monoPipeline && monoPipeline.video === v)) {
					attachMonoPipeline(v);
				}
				window.__deskreenYtReapplyVolume();
				resumeMonoAudioContext();
			}
		}, 2000);
	}
	startAutoRecovery();

	// Quality guard: cap resolution at 1080p, detect stalls, recover from freezes
	function startQualityGuard() {
		if (!isPlayerMode()) return;

		// Helper: log to both WebView console and Android logcat
		function karolLog(msg) {
			console.log(msg);
			try {
				if (window.KarolPlayer && KarolPlayer.log) {
					KarolPlayer.log(msg);
				}
			} catch (e) {}
		}

		// --- 1. Quality cap at hd1080 ---
		function applyQualityCap() {
			try {
				var player = document.querySelector('#movie_player') ||
					document.querySelector('.html5-video-player');
				if (!player) return;
				if (window.__karolQualityCapped) return;
				if (typeof player.setPlaybackQualityRange === 'function') {
					player.setPlaybackQualityRange('tiny', 'hd1080');
					window.__karolQualityCapped = true;
					karolLog('[Karol] Quality capped: tiny→hd1080');
				}
				if (typeof player.getPlaybackQuality === 'function') {
					karolLog('[Karol] Current quality: ' + player.getPlaybackQuality());
				}
			} catch (e) {
				karolLog('[Karol] Quality cap error: ' + e);
			}
		}

		// --- 2. Stall detection (buffering >5s → drop to hd720) ---
		var bufferingStart = 0;
		function onVideoWaiting() {
			if (bufferingStart) return;
			bufferingStart = Date.now();
		}
		function onVideoPlaying() {
			if (!bufferingStart) return;
			var stallMs = Date.now() - bufferingStart;
			bufferingStart = 0;
			if (stallMs > 5000) {
				karolLog('[Karol] Stall detected: ' + stallMs + 'ms, lowering quality');
				try {
					var player = document.querySelector('#movie_player');
					if (player && typeof player.setPlaybackQuality === 'function') {
						player.setPlaybackQuality('hd720');
					}
				} catch (e) {}
			}
		}

		// --- 3. Freeze recovery (currentTime stuck while playing) ---
		var lastTime = -1;
		var sameCount = 0;
		function checkFreeze() {
			var v = document.querySelector('video');
			if (!v) return;
			if (v.paused || v.ended) {
				sameCount = 0;
				lastTime = -1;
				return;
			}
			var now = v.currentTime;
			if (lastTime === now && lastTime > 0 && Number.isFinite(now)) {
				sameCount++;
				if (sameCount >= 3) {
					karolLog('[Karol] Video frozen at ' + now + 's, seeking to refresh');
					try { v.currentTime = now + 0.1; } catch (e) {}
					sameCount = 0;
				}
			} else {
				sameCount = 0;
			}
			lastTime = now;
		}

		// --- Bind/unbind video events ---
		var boundVideo = null;
		function bindVideoEvents() {
			var v = document.querySelector('video');
			if (!v || v === boundVideo) return;
			if (boundVideo) {
				boundVideo.removeEventListener('waiting', onVideoWaiting);
				boundVideo.removeEventListener('playing', onVideoPlaying);
			}
			boundVideo = v;
			v.addEventListener('waiting', onVideoWaiting);
			v.addEventListener('playing', onVideoPlaying);
		}

		// Periodic maintenance + initial bind
		setInterval(function () {
			if (!location.pathname.includes('/watch')) return;
			applyQualityCap();
			bindVideoEvents();
			checkFreeze();
		}, 2000);
		applyQualityCap();
		bindVideoEvents();
	}
	startQualityGuard();

	var endedMo = new MutationObserver(function () {
		if (location.pathname.includes('/watch')) {
			bindEndedListener();
			bindMonoPipelineEarly();
		}
	});
	if (document.body) {
		endedMo.observe(document.body, { childList: true, subtree: true });
	}

	// --- Caption / subtitle API exposed to Android bridge ---

	// Extract caption tracks from ytInitialPlayerResponse (available before player JS boots).
	function getCaptionTracksFromPageData() {
		var ytData = window.ytInitialPlayerResponse;
		if (!ytData) {
			try {
				if (window.ytcfg && window.ytcfg.data_) {
					ytData = window.ytcfg.data_.PLAYER_DATA;
				}
			} catch (e) {}
		}
		if (!ytData || !ytData.captions) return null;
		var renderer = ytData.captions.playerCaptionsTracklistRenderer;
		if (!renderer || !renderer.captionTracks) return null;
		var out = [];
		for (var i = 0; i < renderer.captionTracks.length; i++) {
			var ct = renderer.captionTracks[i];
			var label = '';
			if (ct.name) {
				if (typeof ct.name === 'string') {
					label = ct.name;
				} else if (ct.name.simpleText) {
					label = ct.name.simpleText;
				} else if (ct.name.runs && ct.name.runs.length) {
					label = ct.name.runs.map(function (r) { return r.text || ''; }).join('');
				}
			}
			out.push({
				index: i,
				label: label || ct.languageCode || '',
				lang: ct.languageCode || '',
				kind: ct.kind || '',
				isTranslatable: ct.isTranslatable || false
			});
		}
		return out;
	}

	function getCaptionTracksFromPlayer() {
		var player = document.querySelector('#movie_player');
		if (!player || typeof player.getAvailableCaptionTracks !== 'function') return null;
		var raw = player.getAvailableCaptionTracks();
		if (!raw || !raw.length) return null;
		var out = [];
		for (var i = 0; i < raw.length; i++) {
			var t = raw[i];
			var label = (t.name && t.name.simpleText) ? t.name.simpleText : (t.name || '');
			out.push({
				index: i,
				label: label,
				lang: t.languageCode || '',
				kind: t.kind || '',
				isTranslatable: t.isTranslatable || false
			});
		}
		return out;
	}

	window.__karolListCaptions = function () {
		try {
			var tracks = getCaptionTracksFromPlayer();
			if (!tracks || !tracks.length) {
				tracks = getCaptionTracksFromPageData();
			}
			return tracks || [];
		} catch (e) {
			return [];
		}
	};

	window.__karolSetCaption = function (index) {
		try {
			// Determine language code from available tracks (player or page data)
			var tracks = getCaptionTracksFromPlayer() || getCaptionTracksFromPageData();
			if (!tracks || !tracks[index]) return false;
			var langCode = tracks[index].lang;
			if (!langCode) return false;

			var player = document.querySelector('#movie_player');
			if (player && typeof player.setOption === 'function') {
				player.setOption('captions', 'track', {});
				player.setOption('captions', 'track', { languageCode: langCode });
				return true;
			}
			// Fallback: click the CC button then select from YouTube's caption menu
			var ccBtn = document.querySelector('.ytp-subtitles-button');
			if (ccBtn) {
				ccBtn.click();
				// After a short delay, try to click the specific track in the popup
				setTimeout(function () {
					var items = document.querySelectorAll('.ytp-menuitem[role="menuitemradio"]');
					if (items && items[index]) {
						items[index].click();
					}
				}, 400);
				return true;
			}
			return false;
		} catch (e) {
			return false;
		}
	};

	window.__karolCaptionOff = function () {
		try {
			var player = document.querySelector('#movie_player');
			if (player && typeof player.setOption === 'function') {
				player.setOption('captions', 'track', {});
			}
			var btn = document.querySelector('.ytp-subtitles-button');
			if (btn) { btn.click(); }
		} catch (e) {}
	};

	return true;
})();
