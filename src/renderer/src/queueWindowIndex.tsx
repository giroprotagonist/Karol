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

	useEffect(() => {
		void invokeRemote('getState').then(setSnapshot);

		const unsubscribe = window.electron.ipcRenderer.on(
			IpcEvents.YOUTUBE_DJ_QUEUE_SNAPSHOT_PUSH,
			(_event, next: YouTubeDjQueueSnapshot) => {
				if (next && Array.isArray(next.queue)) {
					setSnapshot(next);
				}
			},
		);

		return () => {
			unsubscribe();
		};
	}, []);

	const handleReorder = useCallback(
		async (fromIndex: number, toIndex: number) => {
			setSnapshot(await invokeRemote('reorderQueue', { fromIndex, toIndex }));
		},
		[],
	);

	const handlePlay = useCallback(async (id: string) => {
		setSnapshot(await invokeRemote('playNow', { id }));
	}, []);

	const handleRemove = useCallback(async (id: string) => {
		setSnapshot(await invokeRemote('removeFromQueue', { id }));
	}, []);

	const handleClear = useCallback(async () => {
		setSnapshot(await invokeRemote('clearQueue'));
	}, []);

	if (snapshot.queue.length === 0) {
		return (
			<div className="queue-window-root">
				<div className="yt-queue-panel__empty">Queue is empty</div>
			</div>
		);
	}

	return (
		<div className="queue-window-root">
			<YouTubeQueuePanel
				state={snapshot}
				onReorder={(from, to) => void handleReorder(from, to)}
				onPlay={(id) => void handlePlay(id)}
				onRemove={(id) => void handleRemove(id)}
				onClear={() => void handleClear()}
				fillHeight
			/>
		</div>
	);
}

createRoot(document.getElementById('root')!).render(<QueueWindowApp />);
