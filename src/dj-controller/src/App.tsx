import { useCallback, useEffect, useMemo, useState } from 'react';
import { PLAYLIST_SYNC_INTERVAL_MS } from '@common/youtubeDjDefaults';
import type {
	YouTubeDjNowPlaying,
	YouTubeDjPlaylistModeConfig,
	YouTubeDjStatus,
	YouTubeKaraokeState,
	YouTubeSearchResult,
} from '@common/YouTubeKaraokeTypes';
import {
	clearQueue,
	fetchNowPlaying,
	fetchPlaylistConfig,
	fetchQueue,
	fetchStatus,
	formatSyncTime,
	getDefaultHost,
	getSavedHost,
	importPlaylist,
	moveQueueItem,
	playQueueItem,
	queueUrl,
	removeQueueItem,
	saveHost,
	searchVideos,
	setMode,
	setPlaylistMode,
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
import QueueList, { reorderItemsLocally } from './components/QueueList';
import SearchResults from './components/SearchResults';

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
	const [playlistUrl, setPlaylistUrl] = useState('');
	const [inputUrl, setInputUrl] = useState('');
	const [importUrl, setImportUrl] = useState('');
	const [searchQuery, setSearchQuery] = useState('');
	const [searchResults, setSearchResults] = useState<YouTubeSearchResult[]>([]);
	const [volume, setVolume] = useState(1);
	const [manualMode, setManualMode] = useState(false);
	const [busy, setBusy] = useState('');
	const [autoAdvance, setAutoAdvance] = useState(true);
	const [showConnection, setShowConnection] = useState(false);
	const [isDraggingQueue, setIsDraggingQueue] = useState(false);

	const pollEnabled = Boolean(host) && !isDraggingQueue;

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
			if (!playlistUrl && nextPlaylist.config.playlistUrl) {
				setPlaylistUrl(nextPlaylist.config.playlistUrl);
			}
			setConnected(true);
			setError('');
		} catch (err) {
			setConnected(false);
			setError(err instanceof Error ? err.message : 'Connection failed');
		}
	}, [host, playlistUrl]);

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
		const interval = setInterval(() => {
			void refreshAll();
		}, 2500);
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

	const connect = useCallback(() => {
		const nextHost = hostInput.trim();
		if (!nextHost) {
			return;
		}
		saveHost(nextHost);
		setHost(nextHost);
		setShowConnection(false);
		void refreshAll();
	}, [hostInput, refreshAll]);

	const runAction = useCallback(
		async (label: string, action: () => Promise<unknown>) => {
			if (!host) {
				return;
			}
			setBusy(label);
			try {
				await action();
				await refreshAll();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Action failed');
			} finally {
				setBusy('');
			}
		},
		[host, refreshAll],
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
		if (nowPlaying?.title) {
			return nowPlaying.title;
		}
		if (currentItem?.title) {
			return currentItem.title;
		}
		return queueState?.currentTitle || 'Nothing playing';
	}, [nowPlaying?.title, currentItem?.title, queueState?.currentTitle]);

	const currentVideoId =
		nowPlaying?.videoId || currentItem?.videoId || '';
	const currentThumbnail =
		queueState?.currentThumbnail || currentItem?.thumbnail || '';

	const isDirectHost = status?.hostMode === 'direct';

	return (
		<div className="app">
			<header className="header">
				<div className="header-brand">
					<div className="logo-mark">♪</div>
					<div>
						<h1>Deskreen DJ</h1>
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
					className={`status-pill ${connected ? 'ok' : error ? 'error' : ''}`}
					onClick={() => setShowConnection((open) => !open)}
				>
					<span className="status-dot" />
					{connected ? 'Connected' : error ? 'Offline' : 'Setup'}
				</button>
			</header>

			{error ? (
				<div className="banner error-banner" role="alert">
					{error}
					<button type="button" className="banner-dismiss" onClick={() => setError('')}>
						×
					</button>
				</div>
			) : null}

			{busy ? <div className="busy-bar" aria-hidden /> : null}

			{showConnection || !connected ? (
				<div className="card connection-card">
					<h2>{isDirectHost ? 'Tablet Player' : 'DJ Host'}</h2>
					<p className="card-subtitle">
						{isDirectHost
							? 'Point your phone at the Deskreen Player tablet on your network'
							: 'Point your phone at Deskreen CE on your Mac (or enter tablet player IP)'}
					</p>
					<input
						className="field"
						placeholder="192.168.1.42:3131"
						value={hostInput}
						onChange={(e) => setHostInput(e.target.value)}
					/>
					<button className="btn primary block" type="button" onClick={connect}>
						Connect
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
				onPlayPause={() =>
					void runAction('play', () =>
						nowPlaying?.state === 1 ? transportPause(host) : transportPlay(host),
					)
				}
				onSkipPrev={() => void runAction('skip-prev', () => transportSkipPrev(host))}
				onSkipNext={() => void runAction('skip-next', () => transportSkipNext(host))}
				onSeekRelative={(delta) =>
					void runAction('seek', () => transportSeekRelative(host, delta))
				}
				onSeek={(seconds) => void runAction('seek', () => transportSeek(host, seconds))}
				onVolumeChange={(level) => {
					setVolume(level);
					void transportVolume(host, level);
				}}
				onAutoAdvanceChange={(enabled) => {
					setAutoAdvance(enabled);
					void runAction('mode', () => setMode(host, enabled ? 'queue' : 'hotswap'));
				}}
				onManualModeChange={(enabled) => {
					setManualMode(enabled);
					void runAction('mode', () => setMode(host, enabled ? 'manual' : 'queue'));
				}}
			/>

			<QueueList
				items={queueState?.queue ?? []}
				currentIndex={queueState?.currentIndex ?? -1}
				connected={connected}
				busy={Boolean(busy)}
				onReorder={handleReorder}
				onPlay={(id) => void runAction('play-item', () => playQueueItem(host, id))}
				onRemove={(id) => void runAction('remove', () => removeQueueItem(host, id))}
				onClear={() => void runAction('clear', () => clearQueue(host))}
				onDragActiveChange={setIsDraggingQueue}
			/>

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

			<div className="card">
				<h2>Central Playlist</h2>
				<p className="card-subtitle">
					Auto-sync a shared YouTube playlist from friends
				</p>
				<label className="toggle-row">
					<span>Playlist sync</span>
					<span className="switch">
						<input
							type="checkbox"
							checked={Boolean(playlistConfig?.enabled)}
							disabled={!connected || Boolean(busy)}
							onChange={(e) => {
								const enabled = e.target.checked;
								void runAction('playlist-mode', () =>
									setPlaylistMode(host, enabled, playlistUrl || undefined),
								);
							}}
						/>
						<span className="slider" />
					</span>
				</label>
				<input
					className="field"
					placeholder="YouTube playlist URL"
					value={playlistUrl}
					disabled={Boolean(playlistConfig?.enabled)}
					onChange={(e) => setPlaylistUrl(e.target.value)}
				/>
				<button
					className="btn primary block"
					type="button"
					disabled={!connected || !playlistConfig?.enabled || Boolean(busy)}
					onClick={() => void runAction('sync', () => syncPlaylist(host))}
				>
					{busy === 'sync' ? 'Syncing…' : 'Sync now'}
				</button>
				{playlistConfig?.enabled ? (
					<p className="muted sync-meta">
						Polling every {Math.round(PLAYLIST_SYNC_INTERVAL_MS / 60_000)} min · last sync{' '}
						{formatSyncTime(playlistConfig.lastSyncAt)} · +{playlistConfig.lastAddedCount} added
					</p>
				) : null}
				{playlistConfig?.lastSyncError ? (
					<p className="error-text">Sync error: {playlistConfig.lastSyncError}</p>
				) : null}
			</div>
		</div>
	);
}
