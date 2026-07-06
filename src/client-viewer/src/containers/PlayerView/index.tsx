import { useEffect, useRef, useCallback, useState } from 'react';
import { OverlayToaster, Position } from '@blueprintjs/core';
import { useTranslation } from 'react-i18next';
import VideoJSPlayer from '../../components/VideoJSPlayer';
import PlayerControlPanel from '../../components/PlayerControlPanel';
import {
	COMPARISON_CANVAS_ID,
	PLAYER_WRAPPER_ID,
} from '../../constants/appConstants';
import { type VideoQualityType } from '../../features/VideoAutoQualityOptimizer/VideoQualityEnum';
import {
	togglePlayerFullscreen,
	subscribeToPlayerFullscreenChange,
} from '../../utils/playerFullscreen';
import isReceiverMode, { isMobilePlaybackDevice } from '../../utils/isReceiverMode';
import { ReceiverAudioPipelineController } from '../../utils/receiverAudioPipeline';
import {
	getReceiverMonoOutputPreference,
	setReceiverMonoOutputPreference,
} from '../../utils/receiverMonoOutputPreference';
import {
	getReceiverQualityBufferPreference,
	setReceiverQualityBufferPreference,
} from '../../utils/receiverQualityBufferPreference';
import { applyReceiverQualityBufferFromPreference } from '../../utils/receiverJitterBuffer';
import {
	startReceiverSyncMonitor,
	stopReceiverSyncMonitor,
} from '../../utils/receiverSyncMonitor';
import {
	getReceiverPlayoutBufferDelayMs,
	isReceiverPlayoutBufferActive,
	isReceiverAvStartPending,
	reapplyReceiverPlayoutBufferAfterFullscreen,
	startReceiverPlayoutWithBuffer,
} from '../../utils/receiverPlayoutBuffer';
import { initPlaybackRateLock } from '../../utils/playbackRateLock';
import { ReceiverStreamHealthMonitor } from '../../utils/receiverStreamHealth';
import { receiverPlaybackDebug } from '../../utils/receiverPlaybackDebug';
import type { RemoteControlCapabilityPayload } from '../../../../common/RemoteInputTypes';
import type { RemoteInputPayload } from '../../../../common/RemoteInputTypes';
import {
	getReceiverControlModePreference,
	setReceiverControlModePreference,
} from '../../utils/receiverControlModePreference';
import {
	attachReceiverTouchControl,
	type TouchRipple,
} from '../../utils/receiverTouchControl';
import { applyReceiverControlModeLatency } from '../../utils/receiverControlModeLatency';
import { ScreenSharingSource } from '../../features/PeerConnection/ScreenSharingSourceEnum';

interface PlayerViewProps {
	isWithControls: boolean;
	setIsWithControls: (_: boolean) => void;
	handlePlayPause: () => void;
	isPlaying: boolean;
	setPlaying: (playing: boolean) => void;
	setVideoQuality: (_: VideoQualityType) => void;
	videoQuality: VideoQualityType;
	screenSharingSourceType: ScreenSharingSourceType;
	streamUrl: MediaStream | null;
	remoteControlCapability: RemoteControlCapabilityPayload;
	remoteInputFeedback?: string | null;
	onSendRemoteInput?: (payload: RemoteInputPayload) => void;
}

type IOSVideoElement = HTMLVideoElement & {
	webkitEnterFullscreen?: () => void;
	webkitExitFullscreen?: () => void;
	webkitSupportsFullscreen?: boolean;
	webkitDisplayingFullscreen?: boolean;
};

function PlayerView(props: PlayerViewProps) {
	const { t } = useTranslation();
	const {
		screenSharingSourceType,
		setIsWithControls,
		isWithControls,
		handlePlayPause,
		isPlaying,
		setPlaying,
		setVideoQuality,
		videoQuality,
		streamUrl,
		remoteControlCapability,
		remoteInputFeedback,
		onSendRemoteInput,
	} = props;

	// const player = useRef(null);

	const videoRef = useRef<HTMLVideoElement>(null);
	const touchOverlayRef = useRef<HTMLDivElement>(null);
	const touchControlCleanupRef = useRef<(() => void) | null>(null);
	const qualityBufferBeforeControlRef = useRef<boolean | null>(null);
	const audioUnlockedRef = useRef(false);
	const monoAudioControllerRef = useRef<ReceiverAudioPipelineController | null>(
		null,
	);
	const streamHealthMonitorRef = useRef<ReceiverStreamHealthMonitor | null>(
		null,
	);
	const playoutCancelRef = useRef<(() => void) | null>(null);
	const wakeLockRef = useRef<WakeLockSentinel | null>(null);
	const toasterRef = useRef<Awaited<ReturnType<typeof OverlayToaster.create>> | null>(null);
	const mobileLike =
		isReceiverMode() || isMobilePlaybackDevice();
	const receiverMode = isReceiverMode();
	const hasStreamAudio = Boolean(streamUrl?.getAudioTracks().length);
	const showMonoOutputToggle = receiverMode && hasStreamAudio;
	const showQualityBufferToggle = false;
	const [isMonoOutputEnabled, setIsMonoOutputEnabled] = useState(
		() => getReceiverMonoOutputPreference(),
	);
	const [isQualityBufferEnabled, setIsQualityBufferEnabled] = useState(
		() => getReceiverQualityBufferPreference(),
	);
	const [isPlayoutBuffering, setIsPlayoutBuffering] = useState(false);
	const handlePlayoutBufferingChange = useCallback((buffering: boolean) => {
		setIsPlayoutBuffering(buffering);
		monoAudioControllerRef.current?.setPlayoutHoldSilence(buffering);
	}, []);
	const handleAvStartTimeout = useCallback(() => {
		if (!toasterRef.current) {
			return;
		}
		toasterRef.current.show({
			message: t('Video is still loading — audio stays muted until video is ready'),
			intent: 'warning',
			timeout: 8000,
		});
	}, [t]);
	const [isControlModeEnabled, setIsControlModeEnabled] = useState(
		() => getReceiverControlModePreference(),
	);
	const [touchRipples, setTouchRipples] = useState<TouchRipple[]>([]);
	const [showKaraokeOverlay] = useState(true);
	const [karaokeTitle, setKaraokeTitle] = useState('');
	const karaokeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Listen for karaoke info from host via data channel
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as { title?: string };
			if (detail?.title) {
				setKaraokeTitle(detail.title);
				if (karaokeTimerRef.current) {
					clearTimeout(karaokeTimerRef.current);
				}
				karaokeTimerRef.current = setTimeout(() => {
					setKaraokeTitle('');
				}, 8000);
			}
		};
		window.addEventListener('deskreen-karaoke-info', handler);
		return () => {
			window.removeEventListener('deskreen-karaoke-info', handler);
			if (karaokeTimerRef.current) {
				clearTimeout(karaokeTimerRef.current);
			}
		};
	}, []);
	const controlAvailable =
		receiverMode &&
		remoteControlCapability.enabled &&
		remoteControlCapability.screenShare &&
		screenSharingSourceType === ScreenSharingSource.SCREEN;
	const showControlModeToggle = receiverMode;

	useEffect(() => {
		if (!monoAudioControllerRef.current) {
			monoAudioControllerRef.current = new ReceiverAudioPipelineController();
		}
		const controller = monoAudioControllerRef.current;

		if (!isWithControls) {
			controller.release();
			return;
		}

		if (!videoRef.current) {
			return;
		}

		controller.attach(videoRef.current, {
			monoEnabled: showMonoOutputToggle && isMonoOutputEnabled,
			bufferEnabled: false,
			bufferDelayMs: 0,
		});
	}, [
		showMonoOutputToggle,
		isWithControls,
		streamUrl,
		isMonoOutputEnabled,
		isQualityBufferEnabled,
	]);

	useEffect(() => {
		return () => {
			monoAudioControllerRef.current?.release();
			monoAudioControllerRef.current = null;
			streamHealthMonitorRef.current?.detach();
			streamHealthMonitorRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!receiverMode || !streamUrl || !isWithControls) {
			streamHealthMonitorRef.current?.detach();
			streamHealthMonitorRef.current = null;
			return;
		}

		if (!videoRef.current) {
			return;
		}

		if (!streamHealthMonitorRef.current) {
			streamHealthMonitorRef.current = new ReceiverStreamHealthMonitor();
		}
		streamHealthMonitorRef.current.attach(videoRef.current, {
			qualityBufferEnabled: isQualityBufferEnabled,
			onFrozen: () => {
				if (isReceiverPlayoutBufferActive()) {
					return;
				}
				videoRef.current?.play().catch(() => {
					// ignore autoplay policy errors
				});
			},
		});
	}, [receiverMode, streamUrl, isWithControls, isQualityBufferEnabled]);

	useEffect(() => {
		if (!receiverMode || !streamUrl) {
			void wakeLockRef.current?.release();
			wakeLockRef.current = null;
			return;
		}

		const requestWakeLock = async () => {
			if (!('wakeLock' in navigator)) {
				return;
			}
			try {
				wakeLockRef.current = await navigator.wakeLock.request('screen');
			} catch {
				// unsupported or denied
			}
		};

		void requestWakeLock();

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				void requestWakeLock();
				if (isReceiverPlayoutBufferActive() || isReceiverAvStartPending()) {
					return;
				}
				if (videoRef.current?.paused) {
					videoRef.current.play().catch(() => {
						// ignore
					});
				}
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			void wakeLockRef.current?.release();
			wakeLockRef.current = null;
		};
	}, [receiverMode, streamUrl]);

	const handleMonoOutputToggle = useCallback(async (enabled: boolean) => {
		setIsMonoOutputEnabled(enabled);
		setReceiverMonoOutputPreference(enabled);
		await monoAudioControllerRef.current?.setMonoEnabled(enabled);
	}, []);

	const handleQualityBufferToggle = useCallback(async (enabled: boolean) => {
		if (isControlModeEnabled) {
			return;
		}
		setIsQualityBufferEnabled(enabled);
		setReceiverQualityBufferPreference(enabled);
		applyReceiverQualityBufferFromPreference();
		await monoAudioControllerRef.current?.setBufferEnabled(false, 0);
	}, [isControlModeEnabled]);

	const handleControlModeToggle = useCallback(async (enabled: boolean) => {
		setIsControlModeEnabled(enabled);
		setReceiverControlModePreference(enabled);

		if (enabled) {
			qualityBufferBeforeControlRef.current = isQualityBufferEnabled;
			if (isQualityBufferEnabled) {
				setIsQualityBufferEnabled(false);
				applyReceiverControlModeLatency();
				await monoAudioControllerRef.current?.setBufferEnabled(false, 0);
			} else {
				applyReceiverControlModeLatency();
			}
			return;
		}

		const restoreBuffer =
			qualityBufferBeforeControlRef.current ??
			getReceiverQualityBufferPreference();
		qualityBufferBeforeControlRef.current = null;
		setIsQualityBufferEnabled(restoreBuffer);
		setReceiverQualityBufferPreference(restoreBuffer);
		applyReceiverQualityBufferFromPreference();
		await monoAudioControllerRef.current?.setBufferEnabled(false, 0);
	}, [isQualityBufferEnabled]);

	useEffect(() => {
		if (!isControlModeEnabled || !controlAvailable || !isWithControls) {
			touchControlCleanupRef.current?.();
			touchControlCleanupRef.current = null;
			return;
		}

		const video = videoRef.current;
		const overlay = touchOverlayRef.current;
		if (!video || !overlay || !onSendRemoteInput) {
			return;
		}

		touchControlCleanupRef.current = attachReceiverTouchControl({
			video,
			overlay,
			enabled: true,
			sourceWidth: remoteControlCapability.sourceWidth,
			sourceHeight: remoteControlCapability.sourceHeight,
			onSendInput: onSendRemoteInput,
			onRipple: (ripple) => {
				setTouchRipples((current) => [...current.slice(-4), ripple]);
				setTimeout(() => {
					setTouchRipples((current) =>
						current.filter((item) => item.id !== ripple.id),
					);
				}, 450);
			},
		});

		return () => {
			touchControlCleanupRef.current?.();
			touchControlCleanupRef.current = null;
		};
	}, [
		isControlModeEnabled,
		controlAvailable,
		isWithControls,
		streamUrl,
		onSendRemoteInput,
		remoteControlCapability.sourceWidth,
		remoteControlCapability.sourceHeight,
	]);

	useEffect(() => {
		if (!controlAvailable && isControlModeEnabled) {
			void handleControlModeToggle(false);
		}
	}, [controlAvailable, isControlModeEnabled, handleControlModeToggle]);

	useEffect(() => {
		if (!streamUrl) return;

		// html5 video mode
		if (isWithControls && videoRef.current) {
			if (streamUrl instanceof MediaStream) {
				videoRef.current.srcObject = streamUrl;
			} else {
				videoRef.current.src = streamUrl;
			}

			const hasAudio = streamUrl.getAudioTracks().length > 0;
			const unmutedAfterBuffer = hasAudio && isReceiverMode();
			if (unmutedAfterBuffer) {
				audioUnlockedRef.current = true;
			}

			const cancelPlayout = startReceiverPlayoutWithBuffer(videoRef.current, {
				onBufferingChange: handlePlayoutBufferingChange,
				onAvStartTimeout: handleAvStartTimeout,
				unmutedAfterBuffer,
				reason: 'stream-start',
			});
			playoutCancelRef.current = cancelPlayout;
			receiverPlaybackDebug('stream-attached', {
				mono: isMonoOutputEnabled,
				qualityBuffer: isQualityBufferEnabled,
				hasAudio,
			});

			return () => {
				cancelPlayout();
				if (playoutCancelRef.current === cancelPlayout) {
					playoutCancelRef.current = null;
				}
				setIsPlayoutBuffering(false);
			};
		}

		// video.js mode (default) doesn't need imperative src assignment here
	}, [streamUrl, isWithControls, mobileLike, isQualityBufferEnabled, handlePlayoutBufferingChange, handleAvStartTimeout]);

	useEffect(() => {
		if (!receiverMode || !isQualityBufferEnabled || !streamUrl || !isWithControls) {
			return;
		}

		let wasFullscreen = false;

		return subscribeToPlayerFullscreenChange((isFullscreen) => {
			const video = videoRef.current;
			if (!video) {
				return;
			}

			if (isFullscreen === wasFullscreen) {
				return;
			}
			wasFullscreen = isFullscreen;

			const reason = isFullscreen ? 'fullscreen-enter' : 'fullscreen-exit';

			playoutCancelRef.current?.();
			playoutCancelRef.current = reapplyReceiverPlayoutBufferAfterFullscreen(
				video,
				{
					onBufferingChange: handlePlayoutBufferingChange,
					onAvStartTimeout: handleAvStartTimeout,
					unmutedAfterBuffer: Boolean(streamUrl?.getAudioTracks().length),
					reason,
				},
			);
		});
	}, [receiverMode, isQualityBufferEnabled, streamUrl, isWithControls, handlePlayoutBufferingChange, handleAvStartTimeout]);

	useEffect(() => {
		if (isWithControls) {
			if (!videoRef.current) return;
			if (isReceiverPlayoutBufferActive() || isReceiverAvStartPending()) {
				return;
			}
		if (mobileLike) {
			videoRef.current.muted = !audioUnlockedRef.current;
		} else if (isReceiverMode() && streamUrl?.getAudioTracks().length) {
			videoRef.current.muted = false;
		} else {
			videoRef.current.muted = !isPlaying;
		}
			if (isPlaying && !isPlayoutBuffering) {
				videoRef.current.play().catch((error) => {
					console.error('Error playing video:', error);
				});
			} else if (!isPlaying) {
				videoRef.current.pause();
			}
		}
		// react-player play/pause is handled via its `playing` prop
	}, [isPlaying, isWithControls, mobileLike, streamUrl, isPlayoutBuffering]);

	// initialize toaster
	useEffect(() => {
		const initToaster = async () => {
			if (!toasterRef.current) {
				toasterRef.current = await OverlayToaster.create({
					position: Position.BOTTOM,
				});
			}
		};
		initToaster();
	}, []);

	useEffect(() => {
		if (!remoteInputFeedback || !toasterRef.current) {
			return;
		}
		toasterRef.current.show({
			message: remoteInputFeedback,
			intent: 'warning',
			timeout: 6000,
		});
	}, [remoteInputFeedback]);

	// wrap handlePlayPause to show toaster notifications
	const handlePlayPauseWithNotification = useCallback(() => {
		const nextPlaying = !isPlaying;
		if (mobileLike && nextPlaying) {
			audioUnlockedRef.current = true;
		}
		if (nextPlaying && isMonoOutputEnabled) {
			void monoAudioControllerRef.current?.setMonoEnabled(true);
		}
		handlePlayPause();
		
		// show notification after a small delay to ensure state is updated
		setTimeout(() => {
			if (toasterRef.current) {
				toasterRef.current.show({
					message: nextPlaying ? t('Video stream is playing') : t('Video stream is paused'),
					intent: nextPlaying ? 'success' : 'warning',
					timeout: 2000,
				});
			}
		}, 50);
	}, [handlePlayPause, isPlaying, isMonoOutputEnabled, isQualityBufferEnabled, mobileLike, t]);

	// handle iPhone fullscreen exit - detect when video stops and auto-resume
	useEffect(() => {
		if (!streamUrl) return;

		const getVideoElement = (): IOSVideoElement | null => {
			if (isWithControls && videoRef.current) {
				return videoRef.current as IOSVideoElement;
			}
			const container = document.getElementById(PLAYER_WRAPPER_ID);
			if (!container) return null;
			const maybeVideo = container.querySelector('video');
			if (!(maybeVideo instanceof HTMLVideoElement)) return null;
			return maybeVideo as IOSVideoElement;
		};

		const handleFullscreenEnd = () => {
			if (receiverMode && isQualityBufferEnabled) {
				return;
			}
			// small delay to ensure video state is updated after fullscreen exit
			setTimeout(() => {
				const video = getVideoElement();
				if (!video) return;

				// check if video is paused after exiting fullscreen
				if (video.paused) {
					// sync play state - ensure button shows "Play" instead of "Pause"
					setPlaying(false);

					// show warning notification that video stopped and user needs to click play
					if (toasterRef.current) {
						toasterRef.current.show({
							message: t('Video stream paused after exiting fullscreen. Please click Play to continue.'),
							intent: 'warning',
							timeout: 5000,
						});
					}
				} else {
					// video is playing, but state might be wrong - sync it
					if (!isPlaying) {
						setPlaying(true);
					}
				}
			}, 150);
		};

		const attachListener = (video: IOSVideoElement | null) => {
			if (video) {
				video.addEventListener('webkitendfullscreen', handleFullscreenEnd);
			}
		};

		const detachListener = (video: IOSVideoElement | null) => {
			if (video) {
				video.removeEventListener('webkitendfullscreen', handleFullscreenEnd);
			}
		};

		let currentVideo: IOSVideoElement | null = getVideoElement();
		attachListener(currentVideo);

		// watch for video element changes (especially for VideoJSPlayer)
		const container = document.getElementById(PLAYER_WRAPPER_ID);
		let observer: MutationObserver | null = null;

		if (container) {
			observer = new MutationObserver(() => {
				const newVideo = getVideoElement();
				if (newVideo !== currentVideo) {
					detachListener(currentVideo);
					currentVideo = newVideo;
					attachListener(currentVideo);
				}
			});
			observer.observe(container, { childList: true, subtree: true });
		}

		return () => {
			detachListener(currentVideo);
			if (observer) {
				observer.disconnect();
			}
		};
	}, [streamUrl, isWithControls, isPlaying, setPlaying, t]);

	// Lock playbackRate to 1.0 — Chromium WebRTC jitter buffer compensation.
	useEffect(() => {
		if (!streamUrl || !isWithControls) return;
		const video = videoRef.current;
		if (!video) return;
		return initPlaybackRateLock(video);
	}, [streamUrl, isWithControls]);

	// Apply quality buffer jitter targets when receiver prefs are active.
	useEffect(() => {
		if (!receiverMode || !isQualityBufferEnabled) return;
		applyReceiverQualityBufferFromPreference();
	}, [receiverMode, isQualityBufferEnabled, streamUrl]);

	// A/V drift monitor — re-applies RTP hints and micro-nudges when needed.
	useEffect(() => {
		if (!receiverMode || !streamUrl || !isWithControls) {
			stopReceiverSyncMonitor();
			return;
		}
		const video = videoRef.current;
		if (!video) {
			return;
		}
		startReceiverSyncMonitor(video);
		return () => {
			stopReceiverSyncMonitor();
		};
	}, [receiverMode, streamUrl, isWithControls, isQualityBufferEnabled]);

	return (
		<div
			style={{
				position: 'absolute',
				zIndex: 1,
				top: 0,
				left: 0,
				width: '100%',
				height: '100vh',
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}
		>
			<PlayerControlPanel
				onSwitchChangedCallback={(isEnabled) => setIsWithControls(isEnabled)}
				isDefaultPlayerTurnedOn={isWithControls}
				showMonoOutputToggle={showMonoOutputToggle}
				isMonoOutputEnabled={isMonoOutputEnabled}
				onMonoOutputToggle={handleMonoOutputToggle}
				showQualityBufferToggle={showQualityBufferToggle && !isControlModeEnabled}
				isQualityBufferEnabled={isQualityBufferEnabled}
				onQualityBufferToggle={handleQualityBufferToggle}
				showControlModeToggle={showControlModeToggle}
				isControlModeEnabled={isControlModeEnabled}
				controlModeAvailable={controlAvailable}
				hostAllowsRemoteControl={remoteControlCapability.enabled}
				onControlModeToggle={handleControlModeToggle}
				handleClickFullscreen={async () => {
					const result = await togglePlayerFullscreen();
					if (result === 'failed') {
						console.warn('Unable to toggle fullscreen');
					}
					return result;
				}}
				handleClickPlayPause={handlePlayPauseWithNotification}
				isPlaying={isPlaying}
				setVideoQuality={setVideoQuality}
				selectedVideoQuality={videoQuality}
				screenSharingSourceType={screenSharingSourceType}
			/>
			<div
				id="video-container"
				style={{
					margin: '0 auto',
					position: 'relative',
					flex: 1,
					width: '100%',
					height: '100%',
					minHeight: 0,
					backgroundColor: 'black',
				}}
			>
				<div
					id={PLAYER_WRAPPER_ID}
					className="player-wrapper"
					style={{
						position: 'relative',
						width: '100%',
						height: '100%',
						backgroundColor: 'black',
					}}
				>
					{isWithControls ? (
						<>
							<video
								ref={videoRef}
								playsInline
								className="absolute top-0 left-0 w-full h-full"
								style={{
									width: '100%',
									height: '100%',
									objectFit: 'contain',
									backgroundColor: 'black',
								}}
							/>
							{isControlModeEnabled && controlAvailable ? (
								<div
									ref={touchOverlayRef}
									style={{
										position: 'absolute',
										inset: 0,
										zIndex: 2,
										touchAction: 'none',
										cursor: 'crosshair',
									}}
								>
									{touchRipples.map((ripple) => (
										<span
											key={ripple.id}
											style={{
												position: 'absolute',
												left: ripple.x,
												top: ripple.y,
												width: 24,
												height: 24,
												marginLeft: -12,
												marginTop: -12,
												borderRadius: '50%',
												border: '2px solid rgba(19, 124, 189, 0.9)',
												backgroundColor: 'rgba(19, 124, 189, 0.25)',
												animation: 'deskreen-touch-ripple 450ms ease-out forwards',
												pointerEvents: 'none',
											}}
										/>
									))}
								</div>
							) : null}
						</>
					) : (
						<VideoJSPlayer
							stream={streamUrl}
							playing={isPlaying}
							containerEl={document.getElementById(PLAYER_WRAPPER_ID)}
						/>
					)}
				</div>
				{isPlayoutBuffering && isWithControls ? (
					<div
						style={{
							position: 'absolute',
							inset: 0,
							zIndex: 20,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							backgroundColor: '#000',
							color: '#fff',
							fontSize: '1.1rem',
							fontWeight: 600,
							pointerEvents: 'none',
						}}
					>
						{`Buffering (${Math.round(getReceiverPlayoutBufferDelayMs() / 1000)}s)…`}
					</div>
				) : null}
				<canvas id={COMPARISON_CANVAS_ID} style={{ display: 'none' }}></canvas>
				{showKaraokeOverlay && karaokeTitle && (
					<div
						style={{
							position: 'absolute',
							bottom: 0,
							left: 0,
							right: 0,
							zIndex: 5,
							padding: '12px 20px',
							background: 'linear-gradient(transparent, rgba(0,0,0,0.75))',
							color: 'white',
							fontSize: '16px',
							fontWeight: 600,
							textAlign: 'center',
							textShadow: '0 1px 4px rgba(0,0,0,0.5)',
							pointerEvents: 'none',
						}}
					>
						{karaokeTitle}
					</div>
				)}
			</div>
		</div>
	);
}

export default PlayerView;
