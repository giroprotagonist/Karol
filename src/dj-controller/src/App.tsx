import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
	YouTubeDjNowPlaying,
	YouTubeDjPlaylistModeConfig,
	YouTubeDjStatus,
	YouTubeKaraokeState,
	YouTubeSearchResult,
} from '@common/YouTubeKaraokeTypes';
import {
	activatePlaylist,
	addPlaylist,
	clearQueue,
	formatTime,
	fetchNowPlaying,
	fetchPlaylistConfig,
	fetchQueue,
	fetchStatus,
	getDefaultHost,
	getSavedHost,
	importPlaylist,
	moveQueueItem,
	playQueueItem,
	queueUrl,
	removeQueueItem,
	removePlaylist,
	saveHost,
	searchVideos,
	setMode,
	setShuffleEnabled,
	shuffleUpcoming,
	setPlaylistMode,
	sortQueue,
	syncPlaylist,
	transportPause,
	transportPlay,
	transportSeek,
	transportSeekRelative,
	transportSkipNext,
	transportSkipPrev,
	transportVolume,
} from './api';
import NowPlayingCard from './components/NowPlayingCard';
import PlaylistLibrary from './components/PlaylistLibrary';
import QueueList, { reorderItemsLocally } from './components/QueueList';
import SearchResults from './components/SearchResults';
import VlcPlayerTab from './components/VlcPlayerTab';
import { useYouTubePreview } from './useYouTubePreview';
import { hapticLight, isNativeAndroidController, notifyNativeConnection, publishNowPlayingToNative, registerNativeNowPlayingListener, registerNativeVolumeListener } from './nativeBridge';
import { syncPlaybackAnchor } from './playbackClock';
import { IconPause, IconPlay } from './components/TransportIcons';

type AppTab = 'player' | 'queue' | 'add' | 'playlist' | 'vlc';

export default function App() {
	const initialHost = getDefaultHost();
	const [hostInput, setHostInput] = useState(initialHost || getSavedHost());
	const [host, setHost] = useState(initialHost);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState('');
	const [status, setStatus] = useState<YouTubeDjStatus | null>(null);
	const [nowPlaying, setNowPlaying] = useState<YouTubeDjNowPlaying | null>(null);
	const [queueState, setQueueState] = useState<YouTubeKaraokeState | null>(null);
	const [playlistConfig, setPlaylistConfig] = useState<YouTubeDjPlaylistModeConfig | null>(
		null,
	);
	const [newPlaylistUrl, setNewPlaylistUrl] = useState('');
	const [inputUrl, setInputUrl] = useState('');
	const [importUrl, setImportUrl] = useState('');
	const [searchQuery, setSearchQuery] = useState('');
	const [searchResults, setSearchResults] = useState<YouTubeSearchResult[]>([]);
	const [volume, setVolume] = useState(1);
	const [connecting, setConnecting] = useState(false);
	const [manualMode, setManualMode] = useState(false);
	const [busy, setBusy] = useState('');
	const [autoAdvance, setAutoAdvance] = useState(true);
	const [shuffleEnabled, setShuffleEnabledState] = useState(false);
	const [showConnection, setShowConnection] = useState(false);
	const [isDraggingQueue, setIsDraggingQueue] = useState(false);
	const [reconnecting, setReconnecting] = useState(false);
	const [activeTab, setActiveTab] = useState<AppTab>('player');
	const [displayTime, setDisplayTime] = useState(0);
	const { previewVideoId, previewLoading, handlePreviewPlay, handlePreviewStop } = useYouTubePreview(host);
	const playbackAnchor = useRef({
		time: 0,
		at: Date.now(),
		playing: false,
		videoId: '',
		duration: 0,
	});
	const lastVideoIdRef = useRef('');
	const hasLoadedRef = useRef(false);
	const uiGuardUntil = useRef(0);
	const nowPlayingRef = useRef<HTMLDivElement>(null);
	const [showMiniPlayer, setShowMiniPlayer] = useState(false);
	const volumeFromNativeRef = useRef(false);
	const nowPlayingFromNativeRef = useRef(false);
	const scrubbingRef = useRef(false);
	const lastSeekAnchorRef = useRef({ at: 0, time: 0 });

	const canApplyNativeDisplayTime = useCallback(() => !scrubbingRef.current, []);

	const setDisplayTimeUnlessScrubbing = useCallback(
		(time: number, force = false) => {
			if (force || canApplyNativeDisplayTime()) {
				setDisplayTime(time);
				return true;
			}
			// #region agent log
			window.KarolNative?.ctrlDbg?.(
				'H10',
				'skip-native-display-time',
				JSON.stringify({
					time,
					scrubbing: scrubbingRef.current,
				}),
			);
			fetch('http://127.0.0.1:7592/ingest/808d4931-5ef3-48a2-9797-d856a57d6e0a', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Debug-Session-Id': '25b906',
				},
				body: JSON.stringify({
					sessionId: '25b906',
					hypothesisId: 'H10',
					location: 'App.tsx:setDisplayTimeUnlessScrubbing',
					message: 'skip-native-display-time',
					data: {
						time,
						scrubbing: scrubbingRef.current,
					},
					timestamp: Date.now(),
				}),
			}).catch(() => {});
			// #endregion
			return false;
		},
		[canApplyNativeDisplayTime],
	);

	const pollEnabled = Boolean(host) && !isDraggingQueue;

	const armUiGuard = useCallback(() => {
		uiGuardUntil.current = Date.now() + 500;
	}, []);

	const isUiGuarded = useCallback(() => Date.now() < uiGuardUntil.current, []);

	const changeTab = useCallback(
		(tab: AppTab) => {
			armUiGuard();
			setActiveTab(tab);
		},
		[armUiGuard],
	);

	const refreshAll = useCallback(async () => {
		if (!host) {
			return;
		}
		try {
			const [nextStatus, nextNowPlaying, nextQueue, nextPlaylist] = await Promise.all([
				fetchStatus(host),
				fetchNowPlaying(host),
				fetchQueue(host),
				fetchPlaylistConfig(host),
			]);
			setStatus(nextStatus);
			setNowPlaying(nextNowPlaying);
			setQueueState(nextQueue);
			setPlaylistConfig(nextPlaylist.config);
			if (typeof nextStatus.volumeLevel === 'number') {
				setVolume(nextStatus.volumeLevel);
			}
			if (typeof nextNowPlaying.volumeLevel === 'number') {
				setVolume(nextNowPlaying.volumeLevel);
			}
			hasLoadedRef.current = true;
			setConnected(true);
			setReconnecting(false);
			setConnecting(false);
			setError('');
			setShowConnection(false);
			notifyNativeConnection(true);
		} catch (err) {
			setConnected(false);
			setConnecting(false);
			notifyNativeConnection(false);
			if (hasLoadedRef.current) {
				setReconnecting(true);
			} else {
				setReconnecting(false);
				setError(err instanceof Error ? err.message : 'Connection failed');
			}
		}
	}, [host]);

	useEffect(() => {
		const autoHost = getDefaultHost();
		if (!autoHost) {
			return;
		}
		saveHost(autoHost);
		setHostInput(autoHost);
		setHost(autoHost);
	}, []);

	useEffect(() => {
		if (!pollEnabled) {
			return;
		}
		void refreshAll();
		// On Android, the native bridge pushes now-playing/volume updates in real time
		// so we only need occasional full refreshes to sync queue/status changes.
		const intervalMs = isNativeAndroidController() ? 10_000 : 2_500;
		const interval = setInterval(() => {
			void refreshAll();
		}, intervalMs);
		return () => clearInterval(interval);
	}, [pollEnabled, refreshAll]);

	useEffect(() => {
		if (queueState?.mode === 'manual') {
			setManualMode(true);
			setAutoAdvance(false);
		} else if (queueState?.mode === 'queue') {
			setManualMode(false);
			setAutoAdvance(true);
		}
	}, [queueState?.mode]);

	useEffect(() => {
		setShuffleEnabledState(Boolean(queueState?.shuffleEnabled));
	}, [queueState?.shuffleEnabled]);

	useEffect(() => {
		if (!pollEnabled || !host) {
			return;
		}
		// Android native bridge pushes now-playing updates via __karolNativeNowPlaying —
		// the JS poll is redundant and causes 4 API calls/sec in dual-poll mode.
		if (isNativeAndroidController()) {
			return;
		}
		let cancelled = false;
		const pollNowPlaying = async () => {
			try {
				const next = await fetchNowPlaying(host);
				if (!cancelled) {
					setNowPlaying((prev) => {
						if (!next) {
							return next;
						}
						if (!isNativeAndroidController()) {
							return next;
						}
						const sameTrack = prev?.videoId === next.videoId;
						return {
							...next,
							currentTime: sameTrack
								? (prev?.currentTime ?? next.currentTime)
								: next.currentTime,
						};
					});
					setConnected(true);
					setReconnecting(false);
					notifyNativeConnection(true);
				}
			} catch {
				if (!cancelled && hasLoadedRef.current) {
					setReconnecting(true);
					notifyNativeConnection(false);
				}
			}
		};
		void pollNowPlaying();
		const interval = setInterval(() => {
			void pollNowPlaying();
		}, 500);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [host, pollEnabled]);

	const applyPlaybackSample = useCallback(
		(
			videoId: string,
			time: number,
			duration: number,
			playing: boolean,
			opts?: { updateDisplay?: boolean },
		) => {
			const result = syncPlaybackAnchor({
				anchor: playbackAnchor.current,
				lastVideoId: lastVideoIdRef.current,
				videoId,
				time,
				duration,
				playing,
			});
			lastVideoIdRef.current = result.lastVideoId;
			playbackAnchor.current = result.anchor;
			// #region agent log
			if (result.keptLocalClock && playing) {
				window.KarolNative?.ctrlDbg?.(
					'H6',
					'kept-local-clock',
					JSON.stringify({
						serverTime: time,
						estimated: result.anchor.time,
						videoId: result.anchor.videoId,
					}),
				);
			}
			// #endregion
			if (opts?.updateDisplay !== false && result.displayTime !== null) {
				setDisplayTime(result.displayTime);
			}
		},
		[],
	);

	useEffect(() => {
		if (isNativeAndroidController()) {
			return;
		}
		const videoId = nowPlaying?.videoId ?? '';
		const duration = nowPlaying?.duration ?? queueState?.duration ?? 0;
		const time = nowPlaying?.currentTime ?? queueState?.currentTime ?? 0;
		const playing = nowPlaying?.state === 1;
		applyPlaybackSample(videoId, time, duration, playing);
	}, [
		applyPlaybackSample,
		nowPlaying?.currentTime,
		nowPlaying?.duration,
		nowPlaying?.state,
		nowPlaying?.videoId,
		queueState?.currentTime,
		queueState?.duration,
	]);

	useEffect(() => {
		const id = window.setInterval(() => {
			if (scrubbingRef.current) {
				return;
			}
			const anchor = playbackAnchor.current;
			if (!anchor.playing) {
				if (!isNativeAndroidController()) {
					setDisplayTime(anchor.time);
				}
				return;
			}
			const elapsed = (Date.now() - anchor.at) / 1000;
			const next = anchor.time + elapsed;
			const capped = anchor.duration > 0 ? Math.min(next, anchor.duration) : next;
			setDisplayTime(capped);
		}, 200);
		return () => window.clearInterval(id);
	}, []);

	useEffect(() => {
		const node = nowPlayingRef.current;
		if (!node || !connected) {
			setShowMiniPlayer(false);
			return;
		}
		const observer = new IntersectionObserver(
			([entry]) => {
				setShowMiniPlayer(!entry.isIntersecting);
			},
			{ threshold: 0.12, rootMargin: '-56px 0px 0px 0px' },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [connected, activeTab]);

	useEffect(() => {
		return registerNativeVolumeListener((level) => {
			volumeFromNativeRef.current = true;
			setVolume(level);
			window.setTimeout(() => {
				volumeFromNativeRef.current = false;
			}, 200);
		});
	}, []);

	const resetPlaybackClock = useCallback(() => {
		playbackAnchor.current = {
			time: 0,
			at: Date.now(),
			playing: false,
			videoId: lastVideoIdRef.current,
			duration: 0,
		};
		setDisplayTime(0);
	}, []);

	const bumpPlaybackTime = useCallback((seconds: number) => {
		const duration = playbackAnchor.current.duration;
		const resolved =
			duration > 0
				? Math.min(Math.max(0, seconds), duration)
				: Math.max(0, seconds);
		playbackAnchor.current = {
			...playbackAnchor.current,
			time: resolved,
			at: Date.now(),
		};
		setDisplayTimeUnlessScrubbing(resolved, true);
	}, [setDisplayTimeUnlessScrubbing]);

	const applyNowPlaying = useCallback((
		next: YouTubeDjNowPlaying | null | undefined,
		opts?: { fromNative?: boolean },
	) => {
		if (!next) {
			return;
		}
		setNowPlaying(next);
		if (next.videoId) {
			lastVideoIdRef.current = next.videoId;
		}
		if (isNativeAndroidController()) {
			// Only reset the JS clock anchor for fresh server responses,
			// not for native-extrapolated position ticks (they disagree with JS)
			if (!opts?.fromNative) {
				playbackAnchor.current = {
					time: next.currentTime,
					at: Date.now(),
					playing: next.state === 1,
					videoId: next.videoId || lastVideoIdRef.current,
					duration: next.duration,
				};
			}
			setDisplayTimeUnlessScrubbing(next.currentTime, !opts?.fromNative);
		} else {
			applyPlaybackSample(
				next.videoId || lastVideoIdRef.current,
				next.currentTime,
				next.duration,
				next.state === 1,
			);
		}
		if (!opts?.fromNative && !nowPlayingFromNativeRef.current) {
			publishNowPlayingToNative(next);
		}
	}, [applyPlaybackSample, setDisplayTimeUnlessScrubbing]);

	useEffect(() => {
		return registerNativeNowPlayingListener((next) => {
			nowPlayingFromNativeRef.current = true;
			const trackChanged =
				lastVideoIdRef.current &&
				next.videoId &&
				lastVideoIdRef.current !== next.videoId;
			if (next.videoId) {
				lastVideoIdRef.current = next.videoId;
			}
			setNowPlaying((prev) => ({ ...prev, ...next }));
			const seekAnchor = lastSeekAnchorRef.current;
			const staleAfterSeek =
				Date.now() - seekAnchor.at < 2000 &&
				seekAnchor.time > 0 &&
				next.currentTime < seekAnchor.time - 2;
			if (!staleAfterSeek) {
				playbackAnchor.current = {
					time: next.currentTime,
					at: Date.now(),
					playing: next.state === 1,
					videoId: next.videoId || lastVideoIdRef.current,
					duration: next.duration,
				};
				setDisplayTimeUnlessScrubbing(next.currentTime);
			}
			// #region agent log
			if (trackChanged) {
				window.KarolNative?.ctrlDbg?.(
					'H9',
					'native-track-change',
					JSON.stringify({
						videoId: next.videoId,
						time: next.currentTime,
					}),
				);
			}
			window.KarolNative?.ctrlDbg?.(
				'H7',
				'native-now-playing',
				JSON.stringify({
					time: next.currentTime,
					state: next.state,
					videoId: next.videoId,
				}),
			);
			// #endregion
			window.setTimeout(() => {
				nowPlayingFromNativeRef.current = false;
			}, 100);
		});
	}, [setDisplayTimeUnlessScrubbing]);

	const handleScrubActiveChange = useCallback((active: boolean) => {
		scrubbingRef.current = active;
		// #region agent log
		window.KarolNative?.ctrlDbg?.(
			'H10',
			'scrub-active',
			JSON.stringify({ active }),
		);
		fetch('http://127.0.0.1:7592/ingest/808d4931-5ef3-48a2-9797-d856a57d6e0a', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Debug-Session-Id': '25b906',
			},
			body: JSON.stringify({
				sessionId: '25b906',
				hypothesisId: 'H10',
				location: 'App.tsx:handleScrubActiveChange',
				message: 'scrub-active',
				data: { active },
				timestamp: Date.now(),
			}),
		}).catch(() => {});
		// #endregion
	}, []);

	const connect = useCallback(() => {
		const nextHost = hostInput.trim();
		if (!nextHost) {
			return;
		}
		setConnecting(true);
		saveHost(nextHost);
		setHost(nextHost);
		void refreshAll();
	}, [hostInput, refreshAll]);

	const runAction = useCallback(
		async (label: string, action: () => Promise<unknown>) => {
			if (!host) {
				return;
			}
			if (isUiGuarded() && (label.includes('skip') || label === 'play')) {
				return;
			}
			setBusy(label);
			try {
				await action();
				await refreshAll();
				if (label === 'play' || label === 'pause' || label.includes('skip') || label === 'seek') {
					const latest = await fetchNowPlaying(host);
					if (latest) {
						publishNowPlayingToNative(latest);
					}
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Action failed');
			} finally {
				setBusy('');
			}
		},
		[host, refreshAll, isUiGuarded],
	);

	const handleReorder = useCallback(
		async (fromIndex: number, toIndex: number) => {
			if (!host || !queueState) {
				return;
			}
			const previous = queueState;
			const optimisticQueue = reorderItemsLocally(queueState.queue, fromIndex, toIndex);
			let nextCurrentIndex = queueState.currentIndex;
			if (nextCurrentIndex === fromIndex) {
				nextCurrentIndex = toIndex;
			} else if (fromIndex < nextCurrentIndex && toIndex >= nextCurrentIndex) {
				nextCurrentIndex -= 1;
			} else if (fromIndex > nextCurrentIndex && toIndex <= nextCurrentIndex) {
				nextCurrentIndex += 1;
			}
			setQueueState({
				...queueState,
				queue: optimisticQueue,
				currentIndex: nextCurrentIndex,
			});
			setBusy('reorder');
			try {
				const nextState = await moveQueueItem(host, fromIndex, toIndex);
				if (nextState) {
					setQueueState(nextState);
				} else {
					await refreshAll();
				}
				setError('');
			} catch (err) {
				setQueueState(previous);
				setError(err instanceof Error ? err.message : 'Reorder failed');
			} finally {
				setBusy('');
			}
		},
		[host, queueState, refreshAll],
	);

	const currentItem = queueState?.queue[queueState.currentIndex];
	const currentTitle = useMemo(() => {
		// Prefer queue item at currentIndex — it's authoritative on what SHOULD be playing
		// nowPlaying.title is derived from a WebView snapshot that lags during transitions
		const fromQueue = currentItem?.title;
		const fromNowPlaying = nowPlaying?.title;
		if (fromQueue && fromNowPlaying && fromQueue !== fromNowPlaying) {
			return fromQueue;
		}
		return fromNowPlaying || fromQueue || queueState?.currentTitle || 'Nothing playing';
	}, [nowPlaying?.title, currentItem?.title, queueState?.currentTitle]);

	const currentVideoId =
		nowPlaying?.videoId || currentItem?.videoId || '';
	const currentThumbnail =
		currentItem?.thumbnail || queueState?.currentThumbnail || '';

	const isDirectHost = status?.hostMode === 'direct';

	return (
		<div className="app">
			<header className="header">
				<div className="header-brand">
					<div className="logo-mark">♪</div>
					<div>
						<h1>Karol</h1>
						<p className="header-sub">
							{connected
								? isDirectHost
									? 'Tablet player'
									: 'Mac cast host'
								: 'Remote controller'}
						</p>
					</div>
				</div>
				<button
					type="button"
					className={`status-pill ${connected ? 'ok' : reconnecting ? 'reconnecting' : error ? 'error' : ''}`}
					onClick={() => setShowConnection((open) => !open)}
				>
					<span className="status-dot" />
					{connected ? 'Connected' : reconnecting ? 'Reconnecting…' : error ? 'Offline' : 'Setup'}
				</button>
			</header>

			{busy ? (
				<div className="busy-bar" role="status" aria-live="polite">
					Working…
				</div>
			) : null}

			{reconnecting && hasLoadedRef.current ? (
				<div className="banner reconnect-banner" role="status">
					<span>Reconnecting to host… queue data may be stale</span>
					<button type="button" className="btn small" onClick={() => void refreshAll()}>
						Retry now
					</button>
				</div>
			) : null}

			{status?.interstitialMessage || status?.lastPlaybackError ? (
				<div className="banner tablet-alert-banner" role="alert">
					{status.interstitialMessage || status.lastPlaybackError}
				</div>
			) : null}

			{error && !reconnecting ? (
				<div className="banner error-banner" role="alert">
					{error}
					<button type="button" className="banner-dismiss" onClick={() => setError('')}>
						×
					</button>
				</div>
			) : null}

			{showConnection || !connected ? (
				<div className="card connection-card">
					<h2>{isDirectHost ? 'Tablet Player' : 'DJ Host'}</h2>
					<p className="card-subtitle">
						{isDirectHost
							? 'Point your phone at the Karol Player tablet on your network'
							: 'Point your phone at Karol on your Mac (or enter tablet player IP)'}
					</p>
					<input
						className="field"
						placeholder="192.168.1.42:3131"
						value={hostInput}
						onChange={(e) => setHostInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								connect();
							}
						}}
					/>
					<button
						className="btn primary block"
						type="button"
						onClick={connect}
						disabled={connecting}
					>
						{connecting ? 'Connecting…' : 'Connect'}
					</button>
					{status ? (
						<div className="status-grid">
							{!isDirectHost ? (
								<div className={`status-chip-lg ${status.castConnected ? 'ok' : ''}`}>
									Cast {status.castConnected ? 'live' : 'waiting'}
								</div>
							) : null}
							<div className={`status-chip-lg ${status.captureReady ? 'ok' : ''}`}>
								{isDirectHost ? 'Player' : 'Capture'}{' '}
								{status.captureReady ? 'ready' : 'pending'}
							</div>
							<div className={`status-chip-lg ${status.djActive ? 'ok' : ''}`}>
								DJ {status.djActive ? 'on' : 'off'}
							</div>
						</div>
					) : null}
				</div>
			) : null}

			<div ref={nowPlayingRef}>
			{activeTab === 'player' && (
			<div className="tab-panel">
			<NowPlayingCard
				title={currentTitle}
				videoId={currentVideoId}
				thumbnail={currentThumbnail}
				nowPlaying={nowPlaying}
				queueState={queueState}
				connected={connected}
				busy={Boolean(busy)}
				volume={volume}
				autoAdvance={autoAdvance}
				manualMode={manualMode}
				shuffleEnabled={shuffleEnabled}
				displayTime={displayTime}
				onPlayPause={() => {
					if (isUiGuarded()) {
						return;
					}
					hapticLight();
					void runAction('play', () =>
						nowPlaying?.state === 1 ? transportPause(host) : transportPlay(host),
					);
				}}
				onSkipPrev={() => {
					if (isUiGuarded()) {
						return;
					}
					resetPlaybackClock();
					void runAction('skip-prev', async () => {
						const result = await transportSkipPrev(host);
						if (result.state) {
							setQueueState(result.state);
						}
						applyNowPlaying(result.nowPlaying);
					});
				}}
				onSkipNext={() => {
					if (isUiGuarded()) {
						return;
					}
					hapticLight();
					resetPlaybackClock();
					void runAction('skip-next', async () => {
						const result = await transportSkipNext(host);
						if (result.state) {
							setQueueState(result.state);
						}
						applyNowPlaying(result.nowPlaying);
					});
				}}
				onSeekRelative={(delta) => {
					const base = playbackAnchor.current.time;
					const target = base + delta;
					lastSeekAnchorRef.current = { at: Date.now(), time: target };
					bumpPlaybackTime(target);
					void runAction('seek', async () => {
						const result = await transportSeekRelative(host, delta);
						if (result) {
							applyNowPlaying(result);
							lastSeekAnchorRef.current = {
								at: Date.now(),
								time: result.currentTime,
							};
						}
					});
				}}
				onScrubActiveChange={handleScrubActiveChange}
				onSeek={(seconds) => {
					lastSeekAnchorRef.current = { at: Date.now(), time: seconds };
					bumpPlaybackTime(seconds);
					void runAction('seek', async () => {
						const result = await transportSeek(host, seconds);
						if (result) {
							applyNowPlaying(result);
							lastSeekAnchorRef.current = {
								at: Date.now(),
								time: result.currentTime,
							};
						}
					});
				}}
				onVolumeChange={(level) => {
					setVolume(level);
					if (!host || volumeFromNativeRef.current) {
						return;
					}
					if (window.KarolNative?.setRemoteVolume) {
						window.KarolNative.setRemoteVolume(level);
						return;
					}
					void transportVolume(host, level).catch((err) => {
						setError(err instanceof Error ? err.message : 'Volume failed');
					});
				}}
				onAutoAdvanceChange={(enabled) => {
					setAutoAdvance(enabled);
					void runAction('mode', () => setMode(host, enabled ? 'queue' : 'hotswap'));
				}}
				onManualModeChange={(enabled) => {
					setManualMode(enabled);
					void runAction('mode', () => setMode(host, enabled ? 'manual' : 'queue'));
				}}
				onShuffleChange={(enabled) => {
					setShuffleEnabledState(enabled);
					void runAction('shuffle', async () => {
						const state = await setShuffleEnabled(host, enabled);
						setQueueState(state);
					});
				}}
			/>
			</div>
			)}
			</div>

			<nav className="tab-nav" aria-label="Sections">
				<button
					type="button"
					className={`tab-btn ${activeTab === 'player' ? 'active' : ''}`}
					onClick={() => changeTab('player')}
				>
					Player
				</button>
				<button
					type="button"
					className={`tab-btn ${activeTab === 'queue' ? 'active' : ''}`}
					onClick={() => changeTab('queue')}
				>
					Queue
				</button>
				<button
					type="button"
					className={`tab-btn ${activeTab === 'add' ? 'active' : ''}`}
					onClick={() => changeTab('add')}
				>
					Add
				</button>
			<button
				type="button"
				className={`tab-btn ${activeTab === 'playlist' ? 'active' : ''}`}
				onClick={() => changeTab('playlist')}
			>
				Playlist
				{playlistConfig?.playlists?.length ? (
					<span className="tab-badge">{playlistConfig.playlists.length}</span>
				) : null}
			</button>
			<button
				type="button"
				className={`tab-btn ${activeTab === 'vlc' ? 'active' : ''}`}
				onClick={() => changeTab('vlc')}
			>
				VLC
			</button>
		</nav>

			{activeTab === 'queue' ? (
			<div className="tab-panel">
			<QueueList
				items={queueState?.queue ?? []}
				currentIndex={queueState?.currentIndex ?? -1}
				connected={connected}
				busy={Boolean(busy)}
				shuffleEnabled={shuffleEnabled}
				previewVideoId={previewVideoId}
				previewLoading={previewLoading}
				onPreview={(videoId) => handlePreviewPlay(videoId)}
				onStopPreview={handlePreviewStop}
				onReorder={handleReorder}
				onPlay={(id) => void runAction('play-item', () => playQueueItem(host, id))}
				onRemove={(id) => void runAction('remove', () => removeQueueItem(host, id))}
				onClear={() => void runAction('clear', () => clearQueue(host))}
				onShuffleUpcoming={() =>
					void runAction('shuffle-upcoming', async () => {
						const state = await shuffleUpcoming(host);
						setQueueState(state);
					})
				}
				onSort={(mode) =>
					void runAction('sort', async () => {
						const state = await sortQueue(host, mode);
						if (state) {
							setQueueState(state);
						}
					})
				}
				onDragActiveChange={setIsDraggingQueue}
			/>
			</div>
			) : null}

			{activeTab === 'add' ? (
			<div className="tab-panel">
			<div className="card">
				<h2>Add Music</h2>
				<div className="input-group">
					<input
						className="field"
						placeholder="Paste YouTube URL or video ID"
						value={inputUrl}
						onChange={(e) => setInputUrl(e.target.value)}
					/>
					<div className="btn-row">
						<button
							className="btn"
							type="button"
							disabled={!connected || !inputUrl.trim() || Boolean(busy)}
							onClick={() =>
								void runAction('queue', async () => {
									await queueUrl(host, inputUrl.trim(), 'queue');
									setInputUrl('');
								})
							}
						>
							+ Queue
						</button>
						<button
							className="btn primary"
							type="button"
							disabled={!connected || !inputUrl.trim() || Boolean(busy)}
							onClick={() =>
								void runAction('play-now', async () => {
									await queueUrl(host, inputUrl.trim(), 'play-now');
									setInputUrl('');
								})
							}
						>
							▶ Play now
						</button>
					</div>
				</div>

				<div className="input-group">
					<input
						className="field"
						placeholder="Search YouTube…"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && searchQuery.trim() && connected && !busy) {
								void runAction('search', async () => {
									const results = await searchVideos(host, searchQuery.trim());
									setSearchResults(results);
								});
							}
						}}
					/>
					<button
						className="btn block"
						type="button"
						disabled={!connected || !searchQuery.trim() || Boolean(busy)}
						onClick={() =>
							void runAction('search', async () => {
								const results = await searchVideos(host, searchQuery.trim());
								setSearchResults(results);
							})
						}
					>
						Search
					</button>
				</div>

				<SearchResults
					results={searchResults}
					connected={connected}
					previewVideoId={previewVideoId}
					previewLoading={previewLoading}
					onPreview={(videoId) => handlePreviewPlay(videoId)}
					onStopPreview={handlePreviewStop}
					onQueue={(url) => void runAction('queue-search', () => queueUrl(host, url, 'queue'))}
					onPlayNow={(url) =>
						void runAction('play-search', () => queueUrl(host, url, 'play-now'))
					}
				/>

				<div className="divider" />

				<p className="card-subtitle">Import a full playlist at once</p>
				<input
					className="field"
					placeholder="YouTube playlist URL"
					value={importUrl}
					onChange={(e) => setImportUrl(e.target.value)}
				/>
				<div className="btn-row">
					<button
						className="btn"
						type="button"
						disabled={!connected || !importUrl.trim() || Boolean(busy)}
						onClick={() =>
							void runAction('import', async () => {
								await importPlaylist(host, importUrl.trim(), false);
								setImportUrl('');
							})
						}
					>
						Import queue
					</button>
					<button
						className="btn primary"
						type="button"
						disabled={!connected || !importUrl.trim() || Boolean(busy)}
						onClick={() =>
							void runAction('import-play', async () => {
								await importPlaylist(host, importUrl.trim(), true);
								setImportUrl('');
							})
						}
					>
						Import & play
					</button>
				</div>
			</div>
			</div>
			) : null}

			{activeTab === 'playlist' ? (
			<div className="tab-panel">
			<PlaylistLibrary
				config={playlistConfig}
				connected={connected}
				busy={busy}
				newPlaylistUrl={newPlaylistUrl}
				onNewPlaylistUrlChange={setNewPlaylistUrl}
				onAddPlaylist={() =>
					void runAction('add-playlist', async () => {
						const result = await addPlaylist(host, newPlaylistUrl.trim());
						setPlaylistConfig(result.config);
						setNewPlaylistUrl('');
					})
				}
				onActivate={(playlistId, playFirst) =>
					void runAction(playFirst ? 'activate-play' : 'activate', async () => {
						setError('');
						const result = await activatePlaylist(host, playlistId, playFirst);
						setPlaylistConfig(result.config);
					})
				}
				onRemove={(playlistId) =>
					void runAction('remove-playlist', async () => {
						const result = await removePlaylist(host, playlistId);
						setPlaylistConfig(result.config);
					})
				}
				onSyncToggle={(enabled) =>
					void runAction('playlist-mode', async () => {
						const result = await setPlaylistMode(host, enabled);
						setPlaylistConfig(result.config);
					})
				}
				onSyncNow={() =>
					void runAction('sync', async () => {
						const result = await syncPlaylist(host);
						setPlaylistConfig(result.config);
					})
				}
			/>
			</div>
			) : null}

			<div className="tab-panel" style={{ display: activeTab === 'vlc' ? 'flex' : 'none' }}>
			<VlcPlayerTab host={host} connected={connected} />
			</div>

			{showMiniPlayer && connected && currentTitle ? (
				<div className="sticky-mini-player" role="region" aria-label="Now playing">
					<button
						type="button"
						className="btn transport-btn primary"
						disabled={Boolean(busy)}
						onClick={() => {
							if (isUiGuarded()) {
								return;
							}
							hapticLight();
							void runAction('play', () =>
								nowPlaying?.state === 1 ? transportPause(host) : transportPlay(host),
							);
						}}
						aria-label={nowPlaying?.state === 1 ? 'Pause' : 'Play'}
					>
						{nowPlaying?.state === 1 ? (
							<IconPause className="transport-icon" />
						) : (
							<IconPlay className="transport-icon" />
						)}
					</button>
					<div className="sticky-mini-info">
						<div className="sticky-mini-title">{currentTitle}</div>
						<div className="sticky-mini-time">
							{formatTime(displayTime)}
							{(nowPlaying?.duration ?? queueState?.duration ?? 0) > 0
								? ` / ${formatTime(nowPlaying?.duration ?? queueState?.duration ?? 0)}`
								: ''}
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
