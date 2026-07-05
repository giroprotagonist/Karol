import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
	Button,
	Card,
	ControlGroup,
	Icon,
	InputGroup,
	Slider,
	Switch,
	Text,
	Tooltip,
} from '@blueprintjs/core';
import { IpcEvents } from '@common/IpcEvents.enum';
import type {
	YouTubeKaraokeState,
	YouTubeQueueItem,
	YouTubeSearchResult,
} from '@common/YouTubeKaraokeTypes';
import {
	getKaraokeState,
	setKaraokeMode,
	addToQueue,
	addManyToQueue,
	removeFromQueue,
	playNow,
	clearQueue,
	subscribeToKaraokeState,
	loadQueueFromStorage,
	setNowPlaying,
	onVideoEnded,
	skipNext,
	skipPrev,
	moveQueueItemUp,
	moveQueueItemDown,
	setPlaybackProgress,
	markCurrentError,
} from '../../features/YouTubeKaraoke/youtubeKaraokeQueue';
import {
	extractVideoId,
	isPlaylistUrl,
} from '../../features/YouTubeKaraoke/youtubeSearch';
import { YOUTUBE_DJ_TEST_PLAYLIST_URL } from '@common/youtubeDjDefaults';
import {
	startDjSession,
	switchCaptureToYouTubeWindow,
	transportPlay,
	transportPause,
	transportSeekRelative,
	transportSetVolume,
	formatTime,
	openYouTubeSignIn,
} from '../../features/YouTubeKaraoke/youtubeDjSession';

const YT_STATES: Record<number, string> = {
	'-1': 'error',
	0: 'ended',
	1: 'playing',
	2: 'paused',
	3: 'buffering',
	5: 'cued',
};

export default function YouTubeKaraokePanel(): React.ReactElement {
	const [isEnabled, setIsEnabled] = useState(false);
	const [state, setState] = useState<YouTubeKaraokeState>(getKaraokeState());
	const [inputUrl, setInputUrl] = useState('');
	const [searchQuery, setSearchQuery] = useState('');
	const [searchResults, setSearchResults] = useState<YouTubeSearchResult[]>([]);
	const [apiKey, setApiKey] = useState('');
	const [ytState, setYtState] = useState(-2);
	const [sourceReady, setSourceReady] = useState(false);
	const [isOpening, setIsOpening] = useState(false);
	const [isCastingActive, setIsCastingActive] = useState(false);
	const [isSwitching, setIsSwitching] = useState(false);
	const [volume, setVolume] = useState(1);
	const [manualMode, setManualMode] = useState(false);
	const [isImportingPlaylist, setIsImportingPlaylist] = useState(false);
	const [castStatus, setCastStatus] = useState<{
		ok: boolean;
		reason?: string;
		sourceId?: string;
	} | null>(null);
	const apiKeySetRef = useRef(false);
	const loadingVideoRef = useRef(false);

	useEffect(() => {
		loadQueueFromStorage();
		setState(getKaraokeState());
		const unsub = subscribeToKaraokeState(setState);
		return unsub;
	}, []);

	useEffect(() => {
		const checkCasting = async () => {
			const devices = await window.electron.ipcRenderer.invoke(
				IpcEvents.GetConnectedDevices,
			);
			setIsCastingActive(Array.isArray(devices) && devices.length > 0);
		};
		void checkCasting();
		const interval = setInterval(() => {
			void checkCasting();
		}, 3000);
		return () => clearInterval(interval);
	}, []);

	const tryAutoConnect = useCallback(async () => {
		try {
			const connectResult = (await window.electron.ipcRenderer.invoke(
				IpcEvents.AutoConnectTrustedReceiver,
			)) as { ok?: boolean; reason?: string; sourceId?: string };
			setCastStatus({
				ok: Boolean(connectResult?.ok),
				reason: connectResult?.reason,
				sourceId: connectResult?.sourceId,
			});
			if (connectResult?.ok) {
				setIsCastingActive(true);
			}
			return connectResult;
		} catch (error) {
			const reason =
				error instanceof Error ? error.message : 'auto-connect-failed';
			setCastStatus({ ok: false, reason });
			return { ok: false, reason };
		}
	}, []);

	const loadVideoById = useCallback(async (videoId: string) => {
		if (!videoId || loadingVideoRef.current) {
			return;
		}
		loadingVideoRef.current = true;
		try {
			await window.electron.ipcRenderer.invoke(
				IpcEvents.YOUTUBE_KARAOKE_LOAD_VIDEO,
				videoId,
			);
		} finally {
			loadingVideoRef.current = false;
		}
	}, []);

	const importPlaylist = useCallback(
		async (playlistUrlOrId: string, playFirst = false) => {
			setIsImportingPlaylist(true);
			try {
				const result = (await window.electron.ipcRenderer.invoke(
					IpcEvents.YOUTUBE_KARAOKE_IMPORT_PLAYLIST,
					playlistUrlOrId,
					playFirst,
				)) as {
					ok?: boolean;
					videos?: YouTubeSearchResult[];
				};

				const videos = result?.videos ?? [];
				if (videos.length === 0) {
					return;
				}

				const items: YouTubeQueueItem[] = videos.map((video, index) => ({
					id: `pl-${Date.now()}-${index}-${video.videoId}`,
					url: video.url,
					videoId: video.videoId,
					title: video.title,
					thumbnail: video.thumbnailUrl,
					status: 'queued' as const,
				}));
				addManyToQueue(items);
				setState(getKaraokeState());

				if (playFirst && items[0]) {
					if (!sourceReady) {
						setCastStatus((prev) => ({
							ok: prev?.ok ?? false,
							reason: 'start-dj-session-first',
						}));
						return;
					}
					playNow(items[0].id);
					setState(getKaraokeState());
					await loadVideoById(items[0].videoId);
				}
			} finally {
				setIsImportingPlaylist(false);
			}
		},
		[loadVideoById, sourceReady],
	);

	useEffect(() => {
		const handler = async (
			_event: unknown,
			data: {
				state: number;
				videoId: string;
				title: string;
				currentTime?: number;
				duration?: number;
			},
		) => {
			setYtState(data.state);
			if (data.currentTime !== undefined && data.duration !== undefined) {
				setPlaybackProgress(data.currentTime, data.duration);
				setState(getKaraokeState());
			}

			if (data.state === 0) {
				const nextVideoId = onVideoEnded();
				setState(getKaraokeState());
				if (nextVideoId) {
					await loadVideoById(nextVideoId);
				}
			} else if (data.state === 1 && data.title) {
				setNowPlaying(
					data.title,
					'',
					data.currentTime ?? 0,
					data.duration ?? 0,
				);
				setState(getKaraokeState());
				window.electron.ipcRenderer.send(IpcEvents.YOUTUBE_KARAOKE_SEND_INFO, {
					title: data.title,
				});
			} else if (data.state === -1) {
				markCurrentError('playback error');
				setState(getKaraokeState());
				const nextVideoId = onVideoEnded();
				if (nextVideoId) {
					await loadVideoById(nextVideoId);
				}
			}
		};
		window.electron.ipcRenderer.on(IpcEvents.YOUTUBE_KARAOKE_STATE_CHANGE, handler);
		return () => {
			window.electron.ipcRenderer.removeListener(
				IpcEvents.YOUTUBE_KARAOKE_STATE_CHANGE,
				handler,
			);
		};
	}, [loadVideoById]);

	useEffect(() => {
		const handler = (_event: unknown, item: YouTubeQueueItem) => {
			addToQueue(item);
			setState(getKaraokeState());
		};
		window.electron.ipcRenderer.on(IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO, handler);
		return () => {
			window.electron.ipcRenderer.removeListener(
				IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO,
				handler,
			);
		};
	}, []);

	useEffect(() => {
		const handler = async (_event: unknown, videoId: string) => {
			setIsEnabled(true);
			setSourceReady(true);
			const url = `https://www.youtube.com/watch?v=${videoId}`;
			const item: YouTubeQueueItem = {
				id: `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				url,
				videoId,
				title: `YouTube: ${videoId}`,
				thumbnail: '',
				status: 'queued',
			};
			addToQueue(item);
			playNow(item.id);
			setState(getKaraokeState());
			await loadVideoById(videoId);
		};
		window.electron.ipcRenderer.on('youtube-karaoke-play-now-from-api', handler);
		return () => {
			window.electron.ipcRenderer.removeListener(
				'youtube-karaoke-play-now-from-api',
				handler,
			);
		};
	}, [loadVideoById]);

	const handleToggle = useCallback(async (enabled: boolean) => {
		if (enabled) {
			setIsOpening(true);
			const result = await startDjSession();
			setIsEnabled(true);
			setIsOpening(false);
			setSourceReady(Boolean(result?.sourceId));
			if ((result?.connectedDevices ?? 0) === 0) {
				await tryAutoConnect();
			} else {
				setCastStatus({ ok: true, sourceId: result?.sourceId ?? undefined });
			}
		} else {
			setIsEnabled(false);
			setSourceReady(false);
			setCastStatus(null);
			await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_KARAOKE_CLOSE_WINDOW);
		}
	}, [tryAutoConnect]);

	const handleStartDjSession = useCallback(async () => {
		setIsOpening(true);
		const result = await startDjSession();
		setIsEnabled(true);
		setIsOpening(false);
		setSourceReady(Boolean(result?.sourceId));
		if ((result?.connectedDevices ?? 0) === 0) {
			await tryAutoConnect();
		} else {
			setCastStatus({ ok: true, sourceId: result?.sourceId ?? undefined });
		}
	}, [tryAutoConnect]);

	const handleSetApiKey = useCallback(async () => {
		if (!apiKey.trim()) {
			return;
		}
		await window.electron.ipcRenderer.invoke('youtube-karaoke-set-api-key', apiKey.trim());
		apiKeySetRef.current = true;
	}, [apiKey]);

	const handleSearch = useCallback(async () => {
		if (!searchQuery.trim()) {
			return;
		}
		const result = await window.electron.ipcRenderer.invoke(
			IpcEvents.YOUTUBE_KARAOKE_SEARCH,
			searchQuery.trim(),
		);
		setSearchResults(result?.results ?? []);
	}, [searchQuery]);

	const handlePlayNow = useCallback(
		async (url: string) => {
			if (isPlaylistUrl(url)) {
				await importPlaylist(url, true);
				setInputUrl('');
				return;
			}

			const videoId = extractVideoId(url);
			if (!videoId) {
				return;
			}

			const item: YouTubeQueueItem = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				url,
				videoId,
				title: `YouTube: ${videoId}`,
				thumbnail: '',
				status: 'queued',
			};
			addToQueue(item);
			playNow(item.id);
			setState(getKaraokeState());
			await loadVideoById(videoId);
			setInputUrl('');
		},
		[loadVideoById, importPlaylist],
	);

	const handleQueueUrl = useCallback(
		(url: string) => {
			if (isPlaylistUrl(url)) {
				void importPlaylist(url, false);
				setInputUrl('');
				return;
			}

			const videoId = extractVideoId(url);
			if (!videoId) {
				return;
			}

			const item: YouTubeQueueItem = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				url,
				videoId,
				title: `YouTube: ${videoId}`,
				thumbnail: '',
				status: 'queued',
			};
			addToQueue(item);
			setInputUrl('');
			setState(getKaraokeState());
		},
		[importPlaylist],
	);

	const handlePlayQueueItem = useCallback(
		async (id: string) => {
			const current = getKaraokeState();
			const item = current.queue.find((q) => q.id === id);
			if (!item) {
				return;
			}
			playNow(id);
			setState(getKaraokeState());
			await loadVideoById(item.videoId);
		},
		[loadVideoById],
	);

	const handleSkipNext = useCallback(async () => {
		const videoId = skipNext();
		setState(getKaraokeState());
		if (videoId) {
			await loadVideoById(videoId);
		}
	}, [loadVideoById]);

	const handleSkipPrev = useCallback(async () => {
		const videoId = skipPrev();
		setState(getKaraokeState());
		if (videoId) {
			await loadVideoById(videoId);
		}
	}, [loadVideoById]);

	const handleRemoveItem = useCallback((id: string) => {
		removeFromQueue(id);
		setState(getKaraokeState());
	}, []);

	const handleClearQueue = useCallback(() => {
		clearQueue();
		setState(getKaraokeState());
	}, []);

	const handleModeToggle = useCallback((queueMode: boolean) => {
		const mode = queueMode ? 'queue' : 'hotswap';
		setKaraokeMode(mode);
		setManualMode(false);
		setState(getKaraokeState());
	}, []);

	const handleManualToggle = useCallback((enabled: boolean) => {
		setManualMode(enabled);
		setKaraokeMode(enabled ? 'manual' : 'queue');
		setState(getKaraokeState());
	}, []);

	const handleSwitchSource = useCallback(async () => {
		setIsSwitching(true);
		try {
			const result = await switchCaptureToYouTubeWindow();
			if (result?.ok) {
				setSourceReady(true);
				setIsEnabled(true);
			}
		} catch {
			// ignore
		}
		setIsSwitching(false);
	}, []);

	const handleSignIn = useCallback(async () => {
		await openYouTubeSignIn();
	}, []);

	const handleVolumeChange = useCallback(async (value: number) => {
		setVolume(value);
		await transportSetVolume(value);
	}, []);

	if (!isEnabled) {
		return (
			<div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(0,0,0,0.1)' }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
					<Switch
						label="YouTube DJ / Karaoke"
						checked={false}
						onChange={(e) => handleToggle((e.target as HTMLInputElement).checked)}
						disabled={isOpening}
					/>
					<Button
						intent="primary"
						icon="play"
						loading={isOpening}
						onClick={() => void handleStartDjSession()}
					>
						Start DJ Session
					</Button>
					<Button icon="log-in" onClick={() => void handleSignIn()}>
						Sign in to YouTube
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div style={{ borderBottom: '1px solid rgba(0,0,0,0.1)' }}>
			<div
				style={{
					padding: '12px 20px',
					display: 'flex',
					alignItems: 'center',
					gap: 12,
					flexWrap: 'wrap',
				}}
			>
				<Switch
					label="YouTube DJ"
					checked={true}
					onChange={(e) => handleToggle((e.target as HTMLInputElement).checked)}
				/>
				<Switch
					label="Auto-advance queue"
					checked={state.mode === 'queue'}
					onChange={(e) => handleModeToggle((e.target as HTMLInputElement).checked)}
					disabled={manualMode}
				/>
				<Switch
					label="Manual mode"
					checked={manualMode}
					onChange={(e) => handleManualToggle((e.target as HTMLInputElement).checked)}
				/>
				<Button
					intent="primary"
					icon="play"
					small
					loading={isOpening}
					onClick={() => void handleStartDjSession()}
				>
					Start DJ Session
				</Button>
				<Button
					icon="log-in"
					small
					onClick={() => void handleSignIn()}
					title="Sign in once for YouTube Premium (no ads). Login persists in the output player."
				>
					Sign in to YouTube
				</Button>
				<Text style={{ fontSize: 12 }}>
					{sourceReady ? (
						<span style={{ color: '#15B371' }}>
							<Icon icon="tick-circle" style={{ marginRight: 4 }} />
							Output window is capture source
						</span>
					) : isOpening ? (
						<span style={{ color: '#aaa' }}>
							<Icon icon="time" style={{ marginRight: 4 }} />
							Setting up output player...
						</span>
					) : (
						<span style={{ color: '#F55656' }}>
							<Icon icon="warning-sign" style={{ marginRight: 4 }} />
							Output player not selected as source
						</span>
					)}
				</Text>
				<Text style={{ fontSize: 12 }}>
					{isCastingActive || castStatus?.ok ? (
						<span style={{ color: '#15B371' }}>
							<Icon icon="mobile-video" style={{ marginRight: 4 }} />
							Tablet cast connected
						</span>
					) : castStatus?.reason ? (
						<span style={{ color: '#F55656' }}>
							<Icon icon="warning-sign" style={{ marginRight: 4 }} />
							Cast failed: {castStatus.reason}
						</span>
					) : (
						<span style={{ color: '#aaa' }}>
							<Icon icon="mobile-video" style={{ marginRight: 4 }} />
							Waiting for tablet — open receiver app on S8
						</span>
					)}
				</Text>
				{isCastingActive && !isSwitching && (
					<Button
						icon="swap-horizontal"
						small
						minimal
						intent="primary"
						onClick={() => void handleSwitchSource()}
						style={{ marginLeft: 'auto' }}
					>
						Switch capture to output window
					</Button>
				)}
				{isSwitching && (
					<Text style={{ fontSize: 12, color: '#aaa', marginLeft: 'auto' }}>
						<Icon icon="time" style={{ marginRight: 4 }} />
						Switching...
					</Text>
				)}
			</div>

			<div style={{ padding: '0 20px 12px' }}>
				<Card style={{ padding: '12px 16px', marginBottom: 8 }}>
					<Text style={{ fontWeight: 600, marginBottom: 8 }}>
						{state.currentTitle || 'Nothing playing'}
					</Text>
					<Text style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
						{formatTime(state.currentTime)} / {formatTime(state.duration)} —{' '}
						{YT_STATES[String(ytState)] || 'loading'}
					</Text>
					<ControlGroup>
						<Tooltip content="Previous">
							<Button icon="step-backward" onClick={() => void handleSkipPrev()} />
						</Tooltip>
						<Tooltip content="Back 10s">
							<Button
								icon="chevron-left"
								onClick={() => void transportSeekRelative(-10)}
							/>
						</Tooltip>
						<Tooltip content="Play">
							<Button icon="play" intent="success" onClick={() => void transportPlay()} />
						</Tooltip>
						<Tooltip content="Pause">
							<Button icon="pause" onClick={() => void transportPause()} />
						</Tooltip>
						<Tooltip content="Forward 10s">
							<Button
								icon="chevron-right"
								onClick={() => void transportSeekRelative(10)}
							/>
						</Tooltip>
						<Tooltip content="Next">
							<Button icon="step-forward" onClick={() => void handleSkipNext()} />
						</Tooltip>
					</ControlGroup>
					<div style={{ marginTop: 12, maxWidth: 240 }}>
						<Text style={{ fontSize: 12 }}>Volume</Text>
						<Slider
							min={0}
							max={1}
							stepSize={0.05}
							labelStepSize={0.5}
							onChange={handleVolumeChange}
							value={volume}
						/>
					</div>
				</Card>
			</div>

			<div style={{ padding: '0 20px 8px' }}>
				<ControlGroup fill>
					<InputGroup
						placeholder="Paste YouTube URL, playlist URL, or video ID"
						value={inputUrl}
						onChange={(e) => setInputUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && inputUrl.trim()) {
								void handlePlayNow(inputUrl.trim());
							}
						}}
						rightElement={
							<>
								<Tooltip content="Add to queue">
									<Button
										icon="plus"
										minimal
										onClick={() => inputUrl.trim() && handleQueueUrl(inputUrl.trim())}
									/>
								</Tooltip>
								<Tooltip content="Play now">
									<Button
										icon="play"
										minimal
										intent="primary"
										onClick={() => inputUrl.trim() && void handlePlayNow(inputUrl.trim())}
									/>
								</Tooltip>
							</>
						}
					/>
				</ControlGroup>
				<div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
					<Button
						icon="list"
						small
						loading={isImportingPlaylist}
						onClick={() => void importPlaylist(inputUrl.trim() || YOUTUBE_DJ_TEST_PLAYLIST_URL, false)}
					>
						Import playlist to queue
					</Button>
					<Button
						icon="play"
						small
						intent="primary"
						loading={isImportingPlaylist}
						onClick={() => void importPlaylist(YOUTUBE_DJ_TEST_PLAYLIST_URL, true)}
					>
						Load test playlist
					</Button>
				</div>
			</div>

			<div style={{ padding: '0 20px 8px' }}>
				<ControlGroup fill>
					<InputGroup
						placeholder="Search YouTube (optional API key below)"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								void handleSearch();
							}
						}}
					/>
					<Button icon="search" onClick={() => void handleSearch()}>
						Search
					</Button>
				</ControlGroup>
			</div>

			{searchResults.length > 0 && (
				<div style={{ padding: '0 20px 8px' }}>
					{searchResults.map((result) => (
						<Card key={result.videoId} style={{ padding: '8px 12px', marginBottom: 4 }}>
							<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
								<Text style={{ flex: 1, fontSize: 13 }}>{result.title}</Text>
								<Button
									icon="plus"
									minimal
									small
									onClick={() => handleQueueUrl(result.url)}
								/>
								<Button
									icon="play"
									minimal
									small
									intent="primary"
									onClick={() => void handlePlayNow(result.url)}
								/>
							</div>
						</Card>
					))}
				</div>
			)}

			<div style={{ padding: '0 20px 8px' }}>
				<Text style={{ fontSize: 12, color: '#666' }}>
					Output player stays windowed (video fills that window for the S8 cast).
					Sign in to YouTube once for Premium ad-free playback — use &quot;Sign in to
					YouTube&quot; above.
				</Text>
			</div>

			{!apiKeySetRef.current && (
				<div style={{ padding: '0 20px 8px' }}>
					<ControlGroup fill>
						<InputGroup
							placeholder="YouTube Data API v3 key (optional, enables search)"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							type="password"
						/>
						<Button icon="key" onClick={() => void handleSetApiKey()} disabled={!apiKey.trim()}>
							Set
						</Button>
					</ControlGroup>
				</div>
			)}

			{state.queue.length > 0 && (
				<div style={{ padding: '0 20px 12px' }}>
					<div
						style={{
							display: 'flex',
							justifyContent: 'space-between',
							alignItems: 'center',
							marginBottom: 6,
						}}
					>
						<Text>Queue ({state.queue.length})</Text>
						<Button icon="trash" minimal small onClick={handleClearQueue}>
							Clear
						</Button>
					</div>
					{state.queue.map((item, index) => (
						<Card
							key={item.id}
							style={{
								padding: '8px 12px',
								marginBottom: 4,
								backgroundColor:
									index === state.currentIndex
										? 'rgba(19, 124, 189, 0.12)'
										: 'transparent',
								borderLeft:
									index === state.currentIndex
										? '3px solid #137cbd'
										: '3px solid transparent',
							}}
						>
							<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
								<Text style={{ fontSize: 12, color: '#888', minWidth: 20 }}>
									{index + 1}
								</Text>
								<Text
									style={{
										flex: 1,
										fontSize: 13,
										overflow: 'hidden',
										textOverflow: 'ellipsis',
										whiteSpace: 'nowrap',
									}}
								>
									{item.title || item.videoId}
								</Text>
								<Text style={{ fontSize: 11, color: '#888' }}>{item.status}</Text>
								<Tooltip content="Move up">
									<Button
										icon="arrow-up"
										minimal
										small
										disabled={index === 0}
										onClick={() => {
											moveQueueItemUp(item.id);
											setState(getKaraokeState());
										}}
									/>
								</Tooltip>
								<Tooltip content="Move down">
									<Button
										icon="arrow-down"
										minimal
										small
										disabled={index === state.queue.length - 1}
										onClick={() => {
											moveQueueItemDown(item.id);
											setState(getKaraokeState());
										}}
									/>
								</Tooltip>
								<Tooltip content="Play now">
									<Button
										icon="play"
										minimal
										small
										onClick={() => void handlePlayQueueItem(item.id)}
									/>
								</Tooltip>
								<Tooltip content="Remove">
									<Button
										icon="cross"
										minimal
										small
										onClick={() => handleRemoveItem(item.id)}
									/>
								</Tooltip>
							</div>
						</Card>
					))}
				</div>
			)}
		</div>
	);
}
