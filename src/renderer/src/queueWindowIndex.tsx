import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@blueprintjs/core/lib/css/blueprint.css';
import { IpcEvents } from '@common/IpcEvents.enum';
import type {
	YouTubeDjQueueSnapshot,
	YouTubeDjRemoteCommandType,
} from '@common/YouTubeKaraokeTypes';
import YouTubeQueuePanel from './components/YouTubeKaraokePanel/YouTubeQueuePanel';
import './components/YouTubeKaraokePanel/youtube-queue-panel.css';

const EMPTY_SNAPSHOT: YouTubeDjQueueSnapshot = {
	queue: [],
	currentIndex: -1,
	mode: 'queue',
	currentTitle: '',
	currentTime: 0,
	duration: 0,
};

async function invokeRemote(
	type: YouTubeDjRemoteCommandType,
	args: Record<string, unknown> = {},
): Promise<YouTubeDjQueueSnapshot> {
	const result = (await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_DJ_INVOKE_REMOTE, {
		type,
		...args,
	})) as YouTubeDjQueueSnapshot;
	if (result && Array.isArray(result.queue)) {
		return result;
	}
	return EMPTY_SNAPSHOT;
}

function QueueWindowApp(): React.ReactElement {
	const [snapshot, setSnapshot] = useState<YouTubeDjQueueSnapshot>(EMPTY_SNAPSHOT);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	useEffect(() => {
		void invokeRemote('getState')
			.then(setSnapshot)
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : 'failed to load queue';
				setErrorMessage(message);
			});

		const unsubscribe = window.electron.ipcRenderer.on(
			IpcEvents.YOUTUBE_DJ_QUEUE_SNAPSHOT_PUSH,
			(_event, next: YouTubeDjQueueSnapshot) => {
				if (next && Array.isArray(next.queue)) {
					setSnapshot(next);
					setErrorMessage(null);
				}
			},
		);

		return () => {
			unsubscribe();
		};
	}, []);

	const runRemote = useCallback(
		async (
			type: YouTubeDjRemoteCommandType,
			args: Record<string, unknown> = {},
		): Promise<void> => {
			try {
				setErrorMessage(null);
				setSnapshot(await invokeRemote(type, args));
			} catch (error) {
				const message = error instanceof Error ? error.message : 'queue action failed';
				setErrorMessage(message);
			}
		},
		[],
	);

	if (snapshot.queue.length === 0) {
		return (
			<div className="queue-window-root">
				{errorMessage ? (
					<div className="yt-queue-panel__empty" style={{ color: '#c23030' }}>
						{errorMessage}
					</div>
				) : (
					<div className="yt-queue-panel__empty">Queue is empty</div>
				)}
			</div>
		);
	}

	return (
		<div className="queue-window-root">
			{errorMessage ? (
				<div
					style={{
						padding: '8px 12px',
						background: 'rgba(194, 48, 48, 0.1)',
						color: '#c23030',
						fontSize: 12,
					}}
				>
					{errorMessage}
				</div>
			) : null}
			<YouTubeQueuePanel
				state={snapshot}
				onReorder={(from, to) => void runRemote('reorderQueue', { fromIndex: from, toIndex: to })}
				onPlay={(id) => void runRemote('playNow', { id })}
				onRemove={(id) => void runRemote('removeFromQueue', { id })}
				onClear={() => void runRemote('clearQueue')}
				fillHeight
			/>
		</div>
	);
}

createRoot(document.getElementById('root')!).render(<QueueWindowApp />);
