/**
 * Shared YouTube watch-page kiosk layout (full watch URLs — never /embed/).
 * Used by Deskreen Mac player and android-player WebView.
 */
(function () {
	if (window.__deskreenYtLayout) {
		window.__deskreenYtApplyLayout();
		return true;
	}
	window.__deskreenYtLayout = true;

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
	].join(',');

	function injectKioskCss() {
		if (document.getElementById('deskreen-yt-kiosk-css')) {
			return;
		}
		var style = document.createElement('style');
		style.id = 'deskreen-yt-kiosk-css';
		style.textContent =
			'html,body,ytd-app{margin:0!important;padding:0!important;background:#000!important;overflow:hidden!important}' +
			'#movie_player,.html5-video-player{width:100%!important;height:100vh!important;max-height:100vh!important}' +
			'ytd-watch-flexy[theater] #full-bleed-container.ytd-watch-flexy,' +
			'ytd-watch-flexy[full-bleed-player] #full-bleed-container.ytd-watch-flexy{height:100vh!important;max-height:none!important}';
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
			document.querySelector('button.ytp-button[aria-label*="theater"]') ||
			document.querySelector('button.ytp-button[aria-label*="Fullscreen"]');
		if (btn) {
			btn.click();
			window.__deskreenTheaterDone = true;
		}
	};

	window.__deskreenYtFixVideoLayer = function () {
		var v = document.querySelector('video');
		if (!v) {
			return false;
		}
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
		if (!location.pathname.includes('/watch')) {
			return;
		}
		injectKioskCss();
		hidePanels();
		window.__deskreenYtEnableTheaterOnce();
		window.__deskreenYtFixVideoLayer();
	};

	window.__deskreenYtResetForNavigation = function () {
		window.__deskreenTheaterDone = false;
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
		return {
			state: state,
			videoId: videoId,
			title: title,
			currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
			duration: Number.isFinite(v.duration) ? v.duration : 0,
			paused: v.paused,
			ended: v.ended,
			hasVideo: true,
		};
	};

	window.__deskreenYtPlay = function () {
		var v = document.querySelector('video');
		if (v) {
			v.muted = false;
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
		var v = document.querySelector('video');
		if (!v) {
			return false;
		}
		v.currentTime = Math.max(0, seconds);
		return true;
	};

	window.__deskreenYtSetVolume = function (level) {
		var v = document.querySelector('video');
		if (!v) {
			return false;
		}
		v.volume = Math.max(0, Math.min(1, level));
		v.muted = level <= 0;
		return true;
	};

	var lastUrl = location.href;
	function onUrlChange() {
		if (location.href === lastUrl) {
			return;
		}
		lastUrl = location.href;
		window.__deskreenYtResetForNavigation();
		[300, 800, 1500, 3000].forEach(function (ms) {
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
			window.__deskreenYtFixVideoLayer();
		}
	});
	if (document.body) {
		mo.observe(document.body, { childList: true, subtree: true });
	}

	injectKioskCss();
	window.__deskreenYtApplyLayout();
	return true;
})();
