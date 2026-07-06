import { useState, type HTMLAttributes } from 'react';
import {
	DndContext,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	type DragEndEvent,
	type DragStartEvent,
	useSensor,
	useSensors,
} from '@dnd-kit/core';
import {
	restrictToParentElement,
	restrictToVerticalAxis,
} from '@dnd-kit/modifiers';
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Card, Text, Tooltip } from '@blueprintjs/core';
import { getQueueItemDisplayTitle } from '@common/youtubeQueueUtils';
import type { YouTubeKaraokeState, YouTubeQueueItem } from '@common/YouTubeKaraokeTypes';
import './youtube-queue-panel.css';

export type YouTubeQueuePanelState = Pick<
	YouTubeKaraokeState,
	'queue' | 'currentIndex'
>;

type YouTubeQueuePanelProps = {
	state: YouTubeQueuePanelState;
	onReorder: (fromIndex: number, toIndex: number) => void;
	onPlay: (id: string) => void;
	onRemove: (id: string) => void;
	onClear: () => void;
	showPopOutButton?: boolean;
	onPopOut?: () => void;
	fillHeight?: boolean;
};

function youtubeThumb(videoId: string, thumbnail?: string): string {
	if (thumbnail) {
		return thumbnail;
	}
	return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
}

function statusLabel(status: YouTubeQueueItem['status']): string {
	switch (status) {
		case 'playing':
			return 'Now';
		case 'loading':
			return 'Loading';
		case 'error':
			return 'Error';
		case 'ended':
			return 'Done';
		default:
			return 'Queued';
	}
}

type RowContentProps = {
	item: YouTubeQueueItem;
	index: number;
	isActive: boolean;
	onPlay: (id: string) => void;
	onRemove: (id: string) => void;
	dragHandleProps?: HTMLAttributes<HTMLButtonElement>;
	isOverlay?: boolean;
	showActions?: boolean;
};

function QueueRowContent({
	item,
	index,
	isActive,
	onPlay,
	onRemove,
	dragHandleProps,
	isOverlay = false,
	showActions = true,
}: RowContentProps) {
	const title = getQueueItemDisplayTitle(item.title, item.videoId);

	return (
		<div className={`yt-queue-row ${isActive ? 'active' : ''} ${isOverlay ? 'drag-overlay' : ''}`}>
			<button
				type="button"
				className="yt-queue-row__handle"
				aria-label={`Reorder ${title}`}
				disabled={isOverlay}
				{...dragHandleProps}
			>
				<span className="yt-queue-row__grip" aria-hidden />
			</button>
			<span className="yt-queue-row__index">{index + 1}</span>
			<img
				className="yt-queue-row__thumb"
				src={youtubeThumb(item.videoId, item.thumbnail)}
				alt=""
				loading="lazy"
			/>
			<div className="yt-queue-row__body">
				<div className="yt-queue-row__title" title={title}>
					{title}
				</div>
				<div className="yt-queue-row__meta">
					<span
						className={`yt-queue-row__status ${item.status === 'playing' ? 'playing' : ''}`}
					>
						{statusLabel(item.status)}
					</span>
				</div>
			</div>
			{showActions && !isOverlay ? (
				<>
					<Tooltip content="Play now">
						<Button icon="play" minimal small onClick={() => onPlay(item.id)} />
					</Tooltip>
					<Tooltip content="Remove">
						<Button icon="cross" minimal small onClick={() => onRemove(item.id)} />
					</Tooltip>
				</>
			) : null}
		</div>
	);
}

type SortableRowProps = {
	item: YouTubeQueueItem;
	index: number;
	isActive: boolean;
	onPlay: (id: string) => void;
	onRemove: (id: string) => void;
};

function SortableRow({ item, index, isActive, onPlay, onRemove }: SortableRowProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
		useSortable({ id: item.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition: isDragging ? undefined : transition,
		opacity: isDragging ? 0.45 : 1,
	};

	return (
		<div ref={setNodeRef} style={style} className={isDragging ? 'yt-queue-row__ghost' : undefined}>
			<QueueRowContent
				item={item}
				index={index}
				isActive={isActive}
				onPlay={onPlay}
				onRemove={onRemove}
				dragHandleProps={{ ...attributes, ...listeners }}
			/>
		</div>
	);
}

export default function YouTubeQueuePanel({
	state,
	onReorder,
	onPlay,
	onRemove,
	onClear,
	showPopOutButton = false,
	onPopOut,
	fillHeight = false,
}: YouTubeQueuePanelProps): React.ReactElement | null {
	const [activeId, setActiveId] = useState<string | null>(null);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	if (state.queue.length === 0) {
		return null;
	}

	const activeItem = activeId ? state.queue.find((item) => item.id === activeId) : null;
	const activeIndex = activeItem ? state.queue.indexOf(activeItem) : -1;

	const handleDragStart = (event: DragStartEvent) => {
		setActiveId(String(event.active.id));
	};

	const handleDragEnd = (event: DragEndEvent) => {
		setActiveId(null);
		const { active, over } = event;
		if (!over || active.id === over.id) {
			return;
		}
		const oldIndex = state.queue.findIndex((item) => item.id === active.id);
		const newIndex = state.queue.findIndex((item) => item.id === over.id);
		if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
			return;
		}
		onReorder(oldIndex, newIndex);
	};

	const scrollClass = fillHeight
		? 'yt-queue-panel__scroll yt-queue-panel__scroll--fill'
		: 'yt-queue-panel__scroll yt-queue-panel__scroll--inline';

	return (
		<Card className="yt-queue-panel" style={{ padding: 0, margin: fillHeight ? 0 : undefined }}>
			<div className="yt-queue-panel__header">
				<Text>
					<strong>Queue</strong> ({state.queue.length})
				</Text>
				<div style={{ display: 'flex', gap: 6 }}>
					{showPopOutButton && onPopOut ? (
						<Button icon="panel-stats" minimal small onClick={onPopOut}>
							Pop out
						</Button>
					) : null}
					<Button icon="trash" minimal small onClick={onClear}>
						Clear
					</Button>
				</div>
			</div>

			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				modifiers={[restrictToVerticalAxis, restrictToParentElement]}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
				onDragCancel={() => setActiveId(null)}
			>
				<SortableContext
					items={state.queue.map((item) => item.id)}
					strategy={verticalListSortingStrategy}
				>
					<div className={scrollClass}>
						{state.queue.map((item, index) => (
							<SortableRow
								key={item.id}
								item={item}
								index={index}
								isActive={index === state.currentIndex}
								onPlay={onPlay}
								onRemove={onRemove}
							/>
						))}
					</div>
				</SortableContext>
				<DragOverlay dropAnimation={{ duration: 160, easing: 'ease-out' }}>
					{activeItem && activeIndex >= 0 ? (
						<QueueRowContent
							item={activeItem}
							index={activeIndex}
							isActive={activeIndex === state.currentIndex}
							onPlay={onPlay}
							onRemove={onRemove}
							isOverlay
							showActions={false}
						/>
					) : null}
				</DragOverlay>
			</DndContext>
		</Card>
	);
}
