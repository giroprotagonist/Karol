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
	triggerFx,
	fetchLibraryStatus,
	fetchLibraryList,
	fetchLibraryScan,
	fetchLibraryTags,
	addVideoToLibrary,
	fetchDownloadStatus,
} from './api';
import type { LibraryVideoMeta, LibraryScanStats, LibraryTagEntry } from './api';
import type { PlaylistDownloadStatus } from './components/PlaylistLibrary';
import NowPlayingCard from './components/NowPlayingCard';
import PlaylistLibrary from './components/PlaylistLibrary';
import LibraryBrowser from './components/LibraryBrowser';
import QueueList, { reorderItemsLocally } from './components/QueueList';
import SearchResults from './components/SearchResults';
import { useYouTubePreview } from './useYouTubePreview';
import { syncPlaybackAnchor } from './playbackClock';
import { IconPause, IconPlay } from './components/TransportIcons';

export default function App() {
	const initialHost = getDefaultHost();
	const [hostInput, setHostInput] = useState(initialHost || getSavedHost());
	const [host, setHost] = useState(initialHost);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState('');
	const [status, setStatus] = useState<YouTubeDjStatus | null>(null);
	const [nowPlaying, setNowPlaying] = useState<YouTubeDjNowPlaying | null>(null);
	const [queueState, setQueueState] = useState<YouTubeKaraokeState | null>(null);
	const [playlistConfig, setPlaylistConfig] = useState<YouTubeDjPlaylistModeConfig | null>(null);
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
	const [reconnectAttempt, setReconnectAttempt] = useState(0); // exponential backoff counter
	const reconnectTimerRef = useRef<number | null>(null);
	const BACKOFF_BASE = 2000; // start at 2s, double each attempt, max 30s
	const [displayTime, setDisplayTime] = useState(0);
	const [activeTab, setActiveTab] = useState<'queue' | 'library' | 'playlists' | 'player' | 'add'>('queue');
	const [libraryStatus, setLibraryStatus] = useState<'checking' | 'downloading' | 'ready' | 'fallback' | ''>('');
	const [playlistDlStatuses, setPlaylistDlStatuses] = useState<PlaylistDownloadStatus[]>([]);
	const [libraryVideos, setLibraryVideos] = useState<LibraryVideoMeta[]>([]);
	const [libraryTags, setLibraryTags] = useState<Record<string, LibraryTagEntry>>({});
	const [libraryScanStats, setLibraryScanStats] = useState<LibraryScanStats | null>(null);
	const [libraryLoading, setLibraryLoading] = useState(false);
	const [libraryFetchTrigger, setLibraryFetchTrigger] = useState(0);
	const [libraryDlQueueAfter, setLibraryDlQueueAfter] = useState(false);
	const [libraryDlJob, setLibraryDlJob] = useState<{ videoId: string; status: string; error?: string; queueAfter?: boolean } | null>(null);
	const hostRef = useRef(host);
	hostRef.current = host;
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
	const scrubbingRef = useRef(false);
	const lastSeekAnchorRef = useRef({ at: 0, time: 0 });
	const pollEnabled = Boolean(host) && !isDraggingQueue;

	const currentItem = queueState?.queue[queueState?.currentIndex];
	const currentTitle = useMemo(() => {
		const fromQueue = currentItem?.title;
		const fromNowPlaying = nowPlaying?.title;
		if (fromQueue && fromNowPlaying && fromQueue !== fromNowPlaying) return fromQueue;
		return fromNowPlaying || fromQueue || queueState?.currentTitle || 'Nothing playing';
	}, [nowPlaying?.title, currentItem?.title, queueState?.currentTitle]);
	const currentVideoId = nowPlaying?.videoId || currentItem?.videoId || '';
	const currentThumbnail = currentItem?.thumbnail || queueState?.currentThumbnail || '';

	const applyPlaybackSample = useCallback(
		(videoId: string, time: number, duration: number, playing: boolean) => {
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
			if (result.displayTime !== null) {
				setDisplayTime(result.displayTime);
			}
		},
		[],
	);

	const reconnectAttemptRef = useRef(0);
	reconnectAttemptRef.current = reconnectAttempt;

	const refreshAll = useCallback(async () => {
		if (!host) return;
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
			if (typeof nextStatus.volumeLevel === 'number') setVolume(nextStatus.volumeLevel);
			if (typeof nextNowPlaying.volumeLevel === 'number') setVolume(nextNowPlaying.volumeLevel);
			hasLoadedRef.current = true;
			setConnected(true);
			setReconnecting(false);
			setReconnectAttempt(0);
			setConnecting(false);
			setError('');
			setShowConnection(false);
		} catch (err) {
			const wasConnected = hasLoadedRef.current;
			setConnected(false);
			setConnecting(false);
			if (wasConnected) {
				// Auto-reconnect with exponential backoff: 2s → 4s → 8s → 16s → 30s cap
				const attempt = reconnectAttemptRef.current + 1;
				setReconnectAttempt(attempt);
				setReconnecting(true);
				const delay = Math.min(BACKOFF_BASE * Math.pow(2, attempt - 1), 30_000);
				if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = window.setTimeout(() => { void refreshAll(); }, delay);
			} else {
				setReconnecting(false);
				setReconnectAttempt(0);
				setError(err instanceof Error ? err.message : 'Connection failed');
			}
		}
	}, [host]);

	// Library is ~1.6MB / 4k videos — only fetch when Library tab is opened (or manual refresh).
	useEffect(() => {
		if (!host || !connected || activeTab !== 'library') return;
		setLibraryLoading(true);
		fetchLibraryList(host)
			.then((list) => setLibraryVideos(list.videos))
			.catch(() => {})
			.finally(() => setLibraryLoading(false));
		fetchLibraryTags(host).then((t) => setLibraryTags(t.tags ?? {})).catch(() => {});
		fetchLibraryScan(host).then((s) => setLibraryScanStats(s)).catch(() => {});
	}, [host, connected, libraryFetchTrigger, activeTab]);

	// Poll download status when a library download is in progress
	useEffect(() => {
		if (!libraryDlJob || !hostRef.current || libraryDlJob.status !== 'downloading') return;
		const h = hostRef.current;
		const videoId = libraryDlJob.videoId;
		const queueAfter = libraryDlJob.queueAfter;
		const timer = setInterval(async () => {
			try {
				const status = await fetchDownloadStatus(h, videoId);
				if (status.status === 'complete') {
					setLibraryDlJob({ videoId, status: 'complete', queueAfter });
					setLibraryFetchTrigger((t) => t + 1);
					clearInterval(timer);
					// Auto-queue after download if requested
					if (queueAfter) {
						try {
							const result = await queueUrl(h, 'https://www.youtube.com/watch?v=' + videoId, 'queue');
							console.log('[dl-poll] Auto-queued ' + videoId, result);
						} catch (e) {
							console.error('[dl-poll] Auto-queue failed for ' + videoId, e);
						}
					}
				} else if (status.status === 'failed') {
					setLibraryDlJob({ videoId, status: 'failed', error: status.error, queueAfter });
					clearInterval(timer);
				}
			} catch (e) {
				console.error('[dl-poll] Status check failed', e);
			}
		}, 3000);
		return () => clearInterval(timer);
	}, [libraryDlJob]);

	// Auto-detect host from page origin
	useEffect(() => {
		const autoHost = getDefaultHost();
		if (!autoHost) return;
		saveHost(autoHost);
		setHostInput(autoHost);
		setHost(autoHost);
	}, []);

	// Poll for state changes (slower on mobile / when tab hidden to avoid S24 jank)
	useEffect(() => {
		if (!pollEnabled) return;
		void refreshAll();
		const isCoarse = typeof window !== 'undefined'
			&& window.matchMedia
			&& window.matchMedia('(pointer: coarse)').matches;
		const baseMs = isCoarse ? 4_000 : 2_500;
		let interval = window.setInterval(() => {
			if (typeof document !== 'undefined' && document.hidden) return;
			void refreshAll();
		}, baseMs);
		const onVis = () => {
			if (!document.hidden) void refreshAll();
		};
		document.addEventListener('visibilitychange', onVis);
		return () => {
			clearInterval(interval);
			document.removeEventListener('visibilitychange', onVis);
		};
	}, [pollEnabled, refreshAll]);

	// Poll now-playing for smooth time updates + auto-reconnect trigger
	useEffect(() => {
		if (!pollEnabled || !host) return;
		let cancelled = false;
		let consecutiveFailures = 0;
		const isCoarse = typeof window !== 'undefined'
			&& window.matchMedia
			&& window.matchMedia('(pointer: coarse)').matches;
		const pollMs = isCoarse ? 1_200 : 500;
		const pollNowPlaying = async () => {
			if (typeof document !== 'undefined' && document.hidden) return;
			try {
				const next = await fetchNowPlaying(host);
				if (!cancelled) {
					consecutiveFailures = 0;
					setNowPlaying(next);
					setConnected(true);
					setReconnecting(false);
					setReconnectAttempt(0);
				}
			} catch {
				if (!cancelled) {
					consecutiveFailures++;
					// After 3 consecutive now-playing failures, trigger refreshAll reconnect
					if (consecutiveFailures >= 3 && hasLoadedRef.current && !reconnecting) {
						setReconnecting(true);
						setReconnectAttempt(1);
						const delay = BACKOFF_BASE;
						if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
						reconnectTimerRef.current = window.setTimeout(() => { void refreshAll(); }, delay);
					}
				}
			}
		};
		void pollNowPlaying();
		const interval = setInterval(() => { void pollNowPlaying(); }, pollMs);
		return () => { cancelled = true; clearInterval(interval); };
	}, [host, pollEnabled, reconnecting, refreshAll]);

	// Sync mode from queue state
	useEffect(() => {
		if (queueState?.mode === 'manual') { setManualMode(true); setAutoAdvance(false); }
		else if (queueState?.mode === 'queue') { setManualMode(false); setAutoAdvance(true); }
	}, [queueState?.mode]);

	useEffect(() => { setShuffleEnabledState(Boolean(queueState?.shuffleEnabled)); }, [queueState?.shuffleEnabled]);

	// Playback clock sync from now-playing
	useEffect(() => {
		const videoId = nowPlaying?.videoId ?? '';
		const duration = nowPlaying?.duration ?? queueState?.duration ?? 0;
		const time = nowPlaying?.currentTime ?? queueState?.currentTime ?? 0;
		const playing = nowPlaying?.state === 1;
		applyPlaybackSample(videoId, time, duration, playing);
	}, [applyPlaybackSample, nowPlaying?.currentTime, nowPlaying?.duration, nowPlaying?.state, nowPlaying?.videoId, queueState?.currentTime, queueState?.duration]);

	// Client-side clock tick
	useEffect(() => {
		const id = window.setInterval(() => {
			if (scrubbingRef.current) return;
			const anchor = playbackAnchor.current;
			if (!anchor.playing) { setDisplayTime(anchor.time); return; }
			const elapsed = (Date.now() - anchor.at) / 1000;
			const capped = anchor.duration > 0 ? Math.min(anchor.time + elapsed, anchor.duration) : anchor.time + elapsed;
			setDisplayTime(capped);
		}, 200);
		return () => window.clearInterval(id);
	}, []);

	// Mini player visibility — show when not on Player tab and there's something playing
	const showMiniPlayer = connected && currentTitle && activeTab !== 'player';

	// Library download status for current video
	useEffect(() => {
		if (!host || !currentVideoId) { setLibraryStatus(''); return; }
		let cancelled = false;
		setLibraryStatus('checking');
		const check = async () => {
			try {
				const st = await fetchLibraryStatus(host, currentVideoId);
				if (cancelled) return;
				setLibraryStatus(st.ready ? 'ready' : 'downloading');
			} catch { if (!cancelled) setLibraryStatus('fallback'); }
		};
		check();
		const interval = setInterval(async () => {
			try {
				const st = await fetchLibraryStatus(host, currentVideoId);
				if (cancelled) return;
				if (st.ready) { setLibraryStatus('ready'); clearInterval(interval); }
				else setLibraryStatus('downloading');
			} catch { if (!cancelled) setLibraryStatus('fallback'); }
		}, 5000);
		const timeout = setTimeout(() => { if (!cancelled) { clearInterval(interval); setLibraryStatus('fallback'); } }, 90000);
		return () => { cancelled = true; clearInterval(interval); clearTimeout(timeout); };
	}, [host, currentVideoId]);

	// Playlist download statuses
	const [activeBatchDownloads, setActiveBatchDownloads] = useState<Set<string>>(new Set());
	useEffect(() => {
		if (!host || !playlistConfig?.playlists?.length) return;
		let cancelled = false;
		const check = async () => {
			try {
				const resp = await fetch(host + '/api/library/scan');
				const scan = await resp.json();
				if (cancelled) return;
				const totalGlobal = scan.totalVideos || 0;
				const statuses: PlaylistDownloadStatus[] = playlistConfig?.playlists?.map(pl => ({
					playlistId: pl.playlistId,
					downloaded: Math.min(totalGlobal, pl.videoCount || 0),
					total: pl.videoCount || 0,
					loading: activeBatchDownloads.has(pl.playlistId),
				})) || [];
				setPlaylistDlStatuses(statuses);
			} catch {}
		};
		check();
		const interval = setInterval(check, 15000);
		return () => { cancelled = true; clearInterval(interval); };
	}, [host, playlistConfig?.playlists?.length]);

	const resetPlaybackClock = useCallback(() => {
		playbackAnchor.current = { time: 0, at: Date.now(), playing: false, videoId: lastVideoIdRef.current, duration: 0 };
		setDisplayTime(0);
	}, []);

	const bumpPlaybackTime = useCallback((seconds: number) => {
		const resolved = playbackAnchor.current.duration > 0
			? Math.min(Math.max(0, seconds), playbackAnchor.current.duration)
			: Math.max(0, seconds);
		playbackAnchor.current = { ...playbackAnchor.current, time: resolved, at: Date.now() };
		setDisplayTime(resolved);
	}, []);

	const connect = useCallback(() => {
		const nextHost = hostInput.trim();
		if (!nextHost) return;
		setConnecting(true);
		saveHost(nextHost);
		setHost(nextHost);
		void refreshAll();
	}, [hostInput, refreshAll]);

	const runAction = useCallback(
		async (label: string, action: () => Promise<unknown>) => {
			if (!host) return;
			const isTransport = label === 'play' || label === 'pause'
				|| label.includes('skip') || label === 'seek' || label === 'play-item';
			// Transport taps on phone must not lock the whole UI behind a full refresh
			if (!isTransport) setBusy(label);
			try {
				await action();
				if (isTransport) {
					const latest = await fetchNowPlaying(host);
					if (latest) setNowPlaying(latest);
					// Soft queue refresh — don't await in a way that blocks the next tap
					void fetchQueue(host).then((q) => setQueueState(q)).catch(() => {});
				} else {
					await refreshAll();
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Action failed');
			} finally { if (!isTransport) setBusy(''); }
		},
		[host, refreshAll],
	);

	const handleReorder = useCallback(
		async (fromIndex: number, toIndex: number) => {
			if (!host || !queueState) return;
			const previous = queueState;
			const optimisticQueue = reorderItemsLocally(queueState.queue, fromIndex, toIndex);
			let nextCurrentIndex = queueState.currentIndex;
			if (nextCurrentIndex === fromIndex) nextCurrentIndex = toIndex;
			else if (fromIndex < nextCurrentIndex && toIndex >= nextCurrentIndex) nextCurrentIndex -= 1;
			else if (fromIndex > nextCurrentIndex && toIndex <= nextCurrentIndex) nextCurrentIndex += 1;
			setQueueState({ ...queueState, queue: optimisticQueue, currentIndex: nextCurrentIndex });
			setBusy('reorder');
			try {
				const nextState = await moveQueueItem(host, fromIndex, toIndex);
				if (nextState) setQueueState(nextState);
				else await refreshAll();
				setError('');
			} catch (err) {
				setQueueState(previous);
				setError(err instanceof Error ? err.message : 'Reorder failed');
			} finally { setBusy(''); }
		},
		[host, queueState, refreshAll],
	);

	const handleDownloadPlaylist = useCallback(async (playlistId: string) => {
		const pl = playlistConfig?.playlists?.find(p => p.playlistId === playlistId);
		if (!pl || !host) return;
		setActiveBatchDownloads(prev => new Set(prev).add(playlistId));
		try {
			await fetch(host + '/api/library/download-playlist', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ playlistUrl: pl.playlistUrl }) });
		} catch {}
		setTimeout(() => setActiveBatchDownloads(prev => { const s = new Set(prev); s.delete(playlistId); return s; }), 30000);
	}, [host, playlistConfig]);

	const handlePopOut = useCallback(() => {
		// Open the dj-controller in a floating window via the host API
		if (host) {
			void fetch(`${host}/api/youtube-dj/controller-window/open`, { method: 'POST', body: '{}' }).catch(() => {});
		}
		// Fallback: open in a new browser tab
		window.open(window.location.href, 'karol-controller', 'width=480,height=800');
	}, [host]);

	const isDirectHost = status?.hostMode === 'direct';

	return (
		<div className="app">
			<header className="header">
				<div className="header-brand">
					<div className="logo-mark">♪</div>
					<div>
						<h1>Karol</h1>
						<p className="header-sub">
							{connected ? (isDirectHost ? 'Tablet player' : 'Mac cast host') : 'Remote controller'}
						</p>
					</div>
				</div>
				<div className="header-actions">
					{connected && (
						<button type="button" className="btn small icon popout-btn" onClick={handlePopOut} title="Pop out as floating window">
							⇱
						</button>
					)}
					<button
						type="button"
						className={`status-pill ${connected ? 'ok' : reconnecting ? 'reconnecting' : error ? 'error' : ''}`}
						onClick={() => setShowConnection((open) => !open)}
					>
						<span className="status-dot" />
						{connected ? 'Connected' : reconnecting ? `Reconnecting${reconnectAttempt > 0 ? ` (${reconnectAttempt})` : '…'}` : error ? 'Offline' : 'Setup'}
					</button>
				</div>
			</header>

			{busy ? <div className="busy-bar" role="status" aria-live="polite">Working…</div> : null}

			{reconnecting && hasLoadedRef.current ? (
				<div className="banner reconnect-banner" role="status">
					<span>Reconnecting{reconnectAttempt > 0 ? ` (attempt ${reconnectAttempt})…` : '…'} queue data may be stale</span>
					<button type="button" className="btn small" onClick={() => { setReconnectAttempt(0); void refreshAll(); }}>Retry now</button>
				</div>
			) : null}

			{status?.interstitialMessage || status?.lastPlaybackError ? (
				<div className="banner tablet-alert-banner" role="alert">{status.interstitialMessage || status.lastPlaybackError}</div>
			) : null}

			{connected && !isDirectHost ? (
				<div className={`clamshell-status ${status?.closedDisplayReady ? 'ready' : 'warn'}`}>
					<span>{status?.closedDisplayReady ? 'Closed-lid ready' : 'Keep lid open'}</span>
					<small>
						{status?.closedDisplayNote
							|| 'Connect external power and HDMI before closing the MacBook lid'}
					</small>
				</div>
			) : null}

			{error && !reconnecting ? (
				<div className="banner error-banner" role="alert">
					{error}
					<button type="button" className="banner-dismiss" onClick={() => setError('')}>×</button>
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
						onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
					/>
					<button className="btn primary block" type="button" onClick={connect} disabled={connecting}>
						{connecting ? 'Connecting…' : 'Connect'}
					</button>
					{status ? (
						<div className="status-grid">
							{!isDirectHost ? (
								<div className={`status-chip-lg ${status.castConnected ? 'ok' : ''}`}>Cast {status.castConnected ? 'live' : 'waiting'}</div>
							) : null}
							<div className={`status-chip-lg ${status.captureReady ? 'ok' : ''}`}>{isDirectHost ? 'Player' : 'Capture'} {status.captureReady ? 'ready' : 'pending'}</div>
							<div className={`status-chip-lg ${status.djActive ? 'ok' : ''}`}>DJ {status.djActive ? 'on' : 'off'}</div>
						</div>
					) : null}
				</div>
			) : null}

			<main className="main-content">
			{/* Tab bar */}
			<div className="tab-bar">
				<button
					className={`tab-btn ${activeTab === 'queue' ? 'tab-btn--active' : ''}`}
					onClick={() => setActiveTab('queue')}
				>
					Queue
					{queueState?.queue?.length ? (
						<span className="tab-badge">{queueState.queue.length}</span>
					) : null}
				</button>
				<button
					className={`tab-btn ${activeTab === 'library' ? 'tab-btn--active' : ''}`}
					onClick={() => setActiveTab('library')}
				>
					Library
				</button>
				<button
					className={`tab-btn ${activeTab === 'playlists' ? 'tab-btn--active' : ''}`}
					onClick={() => setActiveTab('playlists')}
				>
					Playlists
				</button>
				<button
					className={`tab-btn ${activeTab === 'player' ? 'tab-btn--active' : ''}`}
					onClick={() => setActiveTab('player')}
				>
					Player
				</button>
				<button
					className={`tab-btn ${activeTab === 'add' ? 'tab-btn--active' : ''}`}
					onClick={() => setActiveTab('add')}
				>
					Add
				</button>
			</div>

			<div className="tab-content">
				{/* Tab: Queue */}
				{activeTab === 'queue' && (
					<>
						{queueState?.queue?.length ? (
							<QueueList
								items={queueState.queue}
								currentIndex={queueState.currentIndex ?? -1}
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
										if (state) setQueueState(state);
									})
								}
								onDragActiveChange={setIsDraggingQueue}
							/>
						) : (
							<div className="card">
								<h2>Queue</h2>
								<div className="empty-state">
									<div className="empty-icon">📋</div>
									<p>Queue is empty</p>
									<span className="muted">Add videos below or import a playlist</span>
								</div>
							</div>
						)}
					</>
				)}

				{/* Tab: Library — browse all downloaded videos */}
				{activeTab === 'library' && (
					<LibraryBrowser
						host={host}
						connected={connected}
						busy={busy}
						videos={libraryVideos}
						tags={libraryTags}
						scanStats={libraryScanStats}
						loading={libraryLoading}
						onRefresh={() => setLibraryFetchTrigger((t) => t + 1)}
						onVideoDeleted={(videoId) => {
							setLibraryVideos((prev) => prev.filter((v) => v.videoId !== videoId));
						}}
					/>
				)}

				{/* Tab: Playlists — manage saved playlists */}
				{activeTab === 'playlists' && (
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
							onDownloadPlaylist={handleDownloadPlaylist}
							libraryStatuses={playlistDlStatuses}
						/>
				)}

				{/* Tab: Player — full-screen transport controls */}
				{activeTab === 'player' && (
					<>
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
							void runAction('play', () => nowPlaying?.state === 1 ? transportPause(host) : transportPlay(host));
						}}
						onSkipPrev={() => {
							resetPlaybackClock();
							void runAction('skip-prev', async () => {
								const result = await transportSkipPrev(host);
								if (result.state) setQueueState(result.state);
								if (result.nowPlaying) setNowPlaying(result.nowPlaying);
							});
						}}
						onSkipNext={() => {
							resetPlaybackClock();
							void runAction('skip-next', async () => {
								const result = await transportSkipNext(host);
								if (result.state) setQueueState(result.state);
								if (result.nowPlaying) setNowPlaying(result.nowPlaying);
							});
						}}
						onSeekRelative={(delta) => {
							const target = playbackAnchor.current.time + delta;
							lastSeekAnchorRef.current = { at: Date.now(), time: target };
							bumpPlaybackTime(target);
							void runAction('seek', async () => {
								const result = await transportSeekRelative(host, delta);
								if (result) setNowPlaying(result);
							});
						}}
						onScrubActiveChange={(active) => { scrubbingRef.current = active; }}
						onSeek={(seconds) => {
							lastSeekAnchorRef.current = { at: Date.now(), time: seconds };
							bumpPlaybackTime(seconds);
							void runAction('seek', async () => {
								const result = await transportSeek(host, seconds);
								if (result) setNowPlaying(result);
							});
						}}
						onVolumeChange={(level) => {
							setVolume(level);
							if (!host) return;
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
						libraryStatus={libraryStatus}
					/>
					<section className="show-fx-card" aria-label="Live show effects">
						<div className="show-fx-title">Live FX</div>
						<div className="show-fx-grid">
							<button className="show-fx-btn sendit" onClick={() => void triggerFx(host, 'sendit')}>🚀 SEND IT</button>
							<button className="show-fx-btn" onClick={() => void triggerFx(host, 'applause')}>👏 Applause</button>
							<button className="show-fx-btn" onClick={() => void triggerFx(host, 'airhorn')}>📯 Air Horn</button>
							<button className="show-fx-btn" onClick={() => void triggerFx(host, 'fire')}>🔥 Fire</button>
							<button className="show-fx-btn" onClick={() => void triggerFx(host, 'encore')}>⭐ Encore</button>
						</div>
					</section>
					</>
				)}

				{/* Tab: Add — search, queue URL, import playlist */}
				{activeTab === 'add' && (
					<>
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
								<button className="btn" type="button"
									disabled={!connected || !inputUrl.trim() || Boolean(busy)}
									onClick={() => void runAction('queue', async () => { await queueUrl(host, inputUrl.trim(), 'queue'); setInputUrl(''); })}>
									+ Queue
								</button>
								<button className="btn primary" type="button"
									disabled={!connected || !inputUrl.trim() || Boolean(busy)}
									onClick={() => void runAction('play-now', async () => { await queueUrl(host, inputUrl.trim(), 'play-now'); setInputUrl(''); })}>
									▶ Play now
								</button>
							</div>
						</div>

						<div className="divider" />
						<p className="card-subtitle">Download to Library</p>
						{libraryDlJob ? (
							<div className={`lib-dl-status lib-dl-status--${libraryDlJob.status}`}>
								{libraryDlJob.status === 'downloading' && (
									<>
										<span className="lib-dl-spinner" />
										<span>Downloading {libraryDlJob.videoId}…{libraryDlJob.queueAfter ? ' (queued after)' : ''}</span>
										<span className="muted" style={{ marginLeft: 'auto' }}>30–90s</span>
									</>
								)}
								{libraryDlJob.status === 'complete' && (
									<>
										<span>✅ Downloaded to library{libraryDlJob.queueAfter ? ' & queued' : ''}</span>
										<button className="btn small" onClick={() => setLibraryDlJob(null)}>OK</button>
									</>
								)}
								{libraryDlJob.status === 'failed' && (
									<>
										<span>❌ Failed: {libraryDlJob.error || 'Unknown error'}</span>
										<button className="btn small" onClick={() => setLibraryDlJob(null)}>Dismiss</button>
									</>
								)}
							</div>
						) : (
							<>
								<label className="checkbox-row" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
									<input
										type="checkbox"
										checked={libraryDlQueueAfter}
										onChange={(e) => setLibraryDlQueueAfter(e.target.checked)}
									/>
									<span>Also add to queue when ready</span>
								</label>
								<button
									className="btn block"
									type="button"
									disabled={!connected || !inputUrl.trim() || Boolean(busy)}
									onClick={() => {
										const url = inputUrl.trim();
										if (!url) return;
										setBusy('downloading');
										void addVideoToLibrary(host, url).then((res) => {
											if (res.ok && res.videoId) {
												setLibraryDlJob({ videoId: res.videoId, status: 'downloading', queueAfter: libraryDlQueueAfter });
												setInputUrl('');
												setLibraryFetchTrigger((t) => t + 1);
											}
										}).catch((err) => {
											setError(err instanceof Error ? err.message : 'Download failed');
										}).finally(() => setBusy(''));
									}}
								>
									⬇ Download to Library
								</button>
							</>
						)}
					</div>

					<div className="card">
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
							<button className="btn block" type="button"
								disabled={!connected || !searchQuery.trim() || Boolean(busy)}
								onClick={() => void runAction('search', async () => {
									const results = await searchVideos(host, searchQuery.trim());
									setSearchResults(results);
								})}>
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
							onPlayNow={(url) => void runAction('play-search', () => queueUrl(host, url, 'play-now'))}
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
							<button className="btn" type="button"
								disabled={!connected || !importUrl.trim() || Boolean(busy)}
								onClick={() => void runAction('import', async () => { await importPlaylist(host, importUrl.trim(), false); setImportUrl(''); })}>
								Import queue
							</button>
							<button className="btn primary" type="button"
								disabled={!connected || !importUrl.trim() || Boolean(busy)}
								onClick={() => void runAction('import-play', async () => { await importPlaylist(host, importUrl.trim(), true); setImportUrl(''); })}>
								Import & play
							</button>
						</div>
					</div>
					</>
				)}
			</div>
			</main>

			{/* Sticky mini player */}
			{showMiniPlayer && connected && currentTitle ? (
				<div className="sticky-mini-player" role="region" aria-label="Now playing">
					<button type="button" className="btn transport-btn primary"
						disabled={Boolean(busy)}
						onClick={() => {
							void runAction('play', () =>
								nowPlaying?.state === 1 ? transportPause(host) : transportPlay(host),
							);
						}}
						aria-label={nowPlaying?.state === 1 ? 'Pause' : 'Play'}>
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
