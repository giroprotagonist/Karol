import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
	Button,
	Card,
	ControlGroup,
	Icon,
	InputGroup,
	Switch,
	Text,
	Tooltip,
} from '@blueprintjs/core';
import { IpcEvents } from '@common/IpcEvents.enum';
import type {
	YouTubeKaraokeState,
	YouTubeQueueItem,
} from '@common/YouTubeKaraokeTypes';
import {
	getKaraokeState,
	setKaraokeMode,
	addToQueue,
	removeFromQueue,
	playNow,
	clearQueue,
	subscribeToKaraokeState,
	loadQueueFromStorage,
	setNowPlaying,
	onVideoEnded,
} from '../../features/YouTubeKaraoke/youtubeKaraokeQueue';
import { extractVideoId } from '../../features/YouTubeKaraoke/youtubeSearch';

const YT_STATES: Record<number, string> = {
	'-1': 'unstarted',
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
	const [apiKey, setApiKey] = useState('');
	const [ytState, setYtState] = useState(-2);
	const [sourceReady, setSourceReady] = useState(false);
	const [isOpening, setIsOpening] = useState(false);
	const [isCastingActive, setIsCastingActive] = useState(false);
	const [isSwitching, setIsSwitching] = useState(false);
	const apiKeySetRef = useRef(false);

	useEffect(() => {
		loadQueueFromStorage();
		setState(getKaraokeState());
		const unsub = subscribeToKaraokeState(setState);
		return unsub;
	}, []);

	// Poll for casting status
	useEffect(() => {
		const checkCasting = async () => {
			const devices = await window.electron.ipcRenderer.invoke(IpcEvents.GetConnectedDevices);
			setIsCastingActive(Array.isArray(devices) && devices.length > 0);
		};
		checkCasting();
		const interval = setInterval(checkCasting, 3000);
		return () => clearInterval(interval);
	}, []);

	useEffect(() => {
		const handler = (_event: unknown, data: { state: number; videoId: string; title: string }) => {
			setYtState(data.state);
			if (data.state === 0) {
				onVideoEnded();
				setState(getKaraokeState());
			} else if (data.state === 1 && data.title) {
				setNowPlaying(data.title, '');
				setState(getKaraokeState());
				window.electron.ipcRenderer.send(
					IpcEvents.YOUTUBE_KARAOKE_SEND_INFO,
					{ title: data.title },
				);
			}
		};
		window.electron.ipcRenderer.on(IpcEvents.YOUTUBE_KARAOKE_STATE_CHANGE, handler);
		return () => {
			window.electron.ipcRenderer.removeListener(IpcEvents.YOUTUBE_KARAOKE_STATE_CHANGE, handler);
		};
	}, []);

	useEffect(() => {
		const handler = (_event: unknown, item: YouTubeQueueItem) => {
			addToQueue(item);
			setState(getKaraokeState());
		};
		window.electron.ipcRenderer.on(IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO, handler);
		return () => {
			window.electron.ipcRenderer.removeListener(IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO, handler);
		};
	}, []);

	// Handle play-now events coming from the API (browser extension / curl)
	useEffect(() => {
		const handler = (_event: unknown, videoId: string) => {
			// Enable karaoke mode so the expanded UI shows
			setIsEnabled(true);
			setSourceReady(true);
			// Add to queue and play
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
		};
		window.electron.ipcRenderer.on('youtube-karaoke-play-now-from-api', handler);
		return () => {
			window.electron.ipcRenderer.removeListener('youtube-karaoke-play-now-from-api', handler);
		};
	}, []);

	const handleToggle = useCallback(
		async (enabled: boolean) => {
			if (enabled) {
				setIsOpening(true);
				const result = await window.electron.ipcRenderer.invoke(
					IpcEvents.YOUTUBE_KARAOKE_OPEN_WINDOW,
				);
				setIsEnabled(true);
				setIsOpening(false);
				setSourceReady(Boolean(result?.sourceId));
			} else {
				setIsEnabled(false);
				setSourceReady(false);
				await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_KARAOKE_CLOSE_WINDOW);
			}
		},
		[],
	);

	const handleSetApiKey = useCallback(async () => {
		if (!apiKey.trim()) return;
		await window.electron.ipcRenderer.invoke('youtube-karaoke-set-api-key', apiKey.trim());
		apiKeySetRef.current = true;
	}, [apiKey]);

	const handlePlayNow = useCallback(
		async (url: string) => {
			const videoId = extractVideoId(url);
			if (!videoId) return;

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
			const result = await window.electron.ipcRenderer.invoke(
				IpcEvents.YOUTUBE_KARAOKE_PLAY_NOW,
				videoId,
			);
			setSourceReady(Boolean(result?.sourceId));
			setInputUrl('');
			setState(getKaraokeState());
		},
		[],
	);

	const handleQueueUrl = useCallback(
		(url: string) => {
			const videoId = extractVideoId(url);
			if (!videoId) return;

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
		[],
	);

	const handlePlayQueueItem = useCallback(
		async (id: string) => {
			const current = getKaraokeState();
			const item = current.queue.find((q) => q.id === id);
			if (!item) return;
			playNow(id);
			const result = await window.electron.ipcRenderer.invoke(
				IpcEvents.YOUTUBE_KARAOKE_PLAY_NOW,
				item.videoId,
			);
			setSourceReady(Boolean(result?.sourceId));
			setState(getKaraokeState());
		},
		[],
	);

	const handleRemoveItem = useCallback((id: string) => {
		removeFromQueue(id);
		setState(getKaraokeState());
	}, []);

	const handleClearQueue = useCallback(() => {
		clearQueue();
		setState(getKaraokeState());
	}, []);

	const handleModeToggle = useCallback(
		(queueMode: boolean) => {
			const mode = queueMode ? 'queue' : 'hotswap';
			setKaraokeMode(mode);
			setState(getKaraokeState());
		},
		[],
	);

	const handleSwitchSource = useCallback(async () => {
		setIsSwitching(true);
		try {
			const result = await window.electron.ipcRenderer.invoke(
				'youtube-karaoke-restart-with-window',
			);
			if (result?.ok) {
				setSourceReady(true);
				setIsEnabled(true);
				setIsCastingActive(false);
			}
		} catch (_) {}
		setIsSwitching(false);
	}, []);

	if (!isEnabled) {
		return (
			<div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(0,0,0,0.1)' }}>
				<Switch
					label="YouTube Karaoke DJ Mode"
					checked={false}
					onChange={(e) => handleToggle((e.target as HTMLInputElement).checked)}
					disabled={isOpening}
				/>
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
					label="Karaoke DJ"
					checked={true}
					onChange={(e) => handleToggle((e.target as HTMLInputElement).checked)}
				/>
				<Switch
					label="Queue mode"
					checked={state.mode === 'queue'}
					onChange={(e) => handleModeToggle((e.target as HTMLInputElement).checked)}
				/>
				<Text style={{ fontSize: 12 }}>
					{sourceReady ? (
						<span style={{ color: '#15B371' }}>
							<Icon icon="tick-circle" style={{ marginRight: 4 }} />
							YouTube window selected as source
						</span>
					) : isOpening ? (
						<span style={{ color: '#aaa' }}>
							<Icon icon="time" style={{ marginRight: 4 }} />
							Setting up player...
						</span>
					) : (
						<span style={{ color: '#F55656' }}>
							<Icon icon="warning-sign" style={{ marginRight: 4 }} />
							Make sure the player window is visible
						</span>
					)}
				</Text>
				{isCastingActive && !isSwitching && (
					<Button
						icon="swap-horizontal"
						small
						minimal
						intent="primary"
						onClick={handleSwitchSource}
						style={{ marginLeft: 'auto' }}
					>
						Switch Source to YouTube Window
					</Button>
				)}
				{isSwitching && (
					<Text style={{ fontSize: 12, color: '#aaa', marginLeft: 'auto' }}>
						<Icon icon="time" style={{ marginRight: 4 }} />
						Switching...
					</Text>
				)}
				{state.isPlaying && (
					<Text style={{ fontSize: 12, marginLeft: 'auto' }}>
						Now: {state.currentTitle || '...'} ({YT_STATES[String(ytState)] || 'loading'})
					</Text>
				)}
			</div>

			<div style={{ padding: '0 20px 8px' }}>
				<ControlGroup fill>
					<InputGroup
						placeholder="Paste YouTube URL or video ID"
						value={inputUrl}
						onChange={(e) => setInputUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && inputUrl.trim()) {
								handlePlayNow(inputUrl.trim());
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
								<Tooltip content="Play now (streams to tablet)">
									<Button
										icon="play"
										minimal
										intent="primary"
										onClick={() => inputUrl.trim() && handlePlayNow(inputUrl.trim())}
									/>
								</Tooltip>
							</>
						}
					/>
				</ControlGroup>
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
						<Button icon="key" onClick={handleSetApiKey} disabled={!apiKey.trim()}>
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
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 8,
								}}
							>
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
								<Tooltip content="Play now (streams to tablet)">
									<Button
										icon="play"
										minimal
										small
										onClick={() => handlePlayQueueItem(item.id)}
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
