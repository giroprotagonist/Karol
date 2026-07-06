import { useState, type HTMLAttributes } from 'react';
import {
	DndContext,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	TouchSensor,
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
	arrayMove,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getQueueItemDisplayTitle } from '@common/youtubeQueueUtils';
import type { YouTubeQueueItem } from '@common/YouTubeKaraokeTypes';
import { formatTime } from '../api';

type QueueListProps = {
	items: YouTubeQueueItem[];
	currentIndex: number;
	connected: boolean;
	busy: boolean;
	onReorder: (fromIndex: number, toIndex: number) => Promise<void>;
	onPlay: (id: string) => void;
	onRemove: (id: string) => void;
	onClear: () => void;
	onDragActiveChange?: (active: boolean) => void;
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

type QueueRowContentProps = {
	item: YouTubeQueueItem;
	index: number;
	isActive: boolean;
	connected: boolean;
	onPlay: (id: string) => void;
	onRemove: (id: string) => void;
	dragHandleProps?: HTMLAttributes<HTMLButtonElement>;
	isOverlay?: boolean;
};

function QueueRowContent({
	item,
	index,
	isActive,
	connected,
	onPlay,
	onRemove,
	dragHandleProps,
	isOverlay = false,
}: QueueRowContentProps) {
	const title = getQueueItemDisplayTitle(item.title, item.videoId);

	return (
		<div
			className={`queue-item ${isActive ? 'active' : ''} ${isOverlay ? 'drag-overlay' : ''}`}
		>
			<button
				type="button"
				className="drag-handle"
				aria-label={`Reorder ${title}`}
				disabled={!connected || isOverlay}
				{...dragHandleProps}
			>
				<span className="drag-grip" aria-hidden />
			</button>
			<div className="queue-index">{index + 1}</div>
			<img
				className="queue-thumb"
				src={youtubeThumb(item.videoId, item.thumbnail)}
				alt=""
				loading="lazy"
			/>
			<div className="queue-body">
				<div className="queue-title" title={title}>
					{title}
				</div>
				<div className="queue-meta">
					<span className={`status-chip status-${item.status}`}>
						{statusLabel(item.status)}
					</span>
					{item.durationSec ? (
						<span className="queue-duration">{formatTime(item.durationSec)}</span>
					) : null}
					{item.errorReason ? (
						<span className="queue-error" title={item.errorReason}>
							{item.errorReason}
						</span>
					) : null}
				</div>
			</div>
			{!isOverlay ? (
				<div className="queue-actions">
					<button
						className="btn icon"
						type="button"
						disabled={!connected}
						title="Play this track"
						onClick={() => onPlay(item.id)}
					>
						▶
					</button>
					<button
						className="btn icon danger-subtle"
						type="button"
						disabled={!connected}
						title="Remove from queue"
						onClick={() => onRemove(item.id)}
					>
						×
					</button>
				</div>
			) : null}
		</div>
	);
}

type SortableRowProps = {
	item: YouTubeQueueItem;
	index: number;
	isActive: boolean;
	connected: boolean;
	onPlay: (id: string) => void;
	onRemove: (id: string) => void;
};

function SortableRow({
	item,
	index,
	isActive,
	connected,
	onPlay,
	onRemove,
}: SortableRowProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
		useSortable({ id: item.id, disabled: !connected });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition: isDragging ? undefined : transition,
		opacity: isDragging ? 0.35 : 1,
	};

	return (
		<div ref={setNodeRef} style={style} className={isDragging ? 'sortable-ghost' : undefined}>
			<QueueRowContent
				item={item}
				index={index}
				isActive={isActive}
				connected={connected}
				onPlay={onPlay}
				onRemove={onRemove}
				dragHandleProps={{ ...attributes, ...listeners }}
			/>
		</div>
	);
}

export default function QueueList({
	items,
	currentIndex,
	connected,
	busy,
	onReorder,
	onPlay,
	onRemove,
	onClear,
	onDragActiveChange,
}: QueueListProps) {
	const [activeId, setActiveId] = useState<string | null>(null);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 8 },
		}),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const activeItem = activeId ? items.find((item) => item.id === activeId) : null;
	const activeIndex = activeItem ? items.indexOf(activeItem) : -1;

	const handleDragStart = (event: DragStartEvent) => {
		setActiveId(String(event.active.id));
		onDragActiveChange?.(true);
	};

	const handleDragEnd = (event: DragEndEvent) => {
		setActiveId(null);
		onDragActiveChange?.(false);

		const { active, over } = event;
		if (!over || active.id === over.id) {
			return;
		}
		const oldIndex = items.findIndex((item) => item.id === active.id);
		const newIndex = items.findIndex((item) => item.id === over.id);
		if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
			return;
		}
		void onReorder(oldIndex, newIndex);
	};

	const handleDragCancel = () => {
		setActiveId(null);
		onDragActiveChange?.(false);
	};

	return (
		<div className="card queue-card">
			<div className="card-header">
				<div>
					<h2>Queue</h2>
					<p className="card-subtitle">
						{items.length} track{items.length === 1 ? '' : 's'}
					</p>
				</div>
				<button
					className="btn small danger-subtle"
					type="button"
					disabled={!connected || items.length === 0 || busy}
					onClick={onClear}
				>
					Clear all
				</button>
			</div>

			{items.length === 0 ? (
				<div className="empty-state">
					<div className="empty-icon">♪</div>
					<p>Your queue is empty</p>
					<span className="muted">Search or paste a URL to add songs</span>
				</div>
			) : (
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					modifiers={[restrictToVerticalAxis, restrictToParentElement]}
					onDragStart={handleDragStart}
					onDragEnd={handleDragEnd}
					onDragCancel={handleDragCancel}
				>
					<SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
						<div className="queue-list">
							{items.map((item, index) => (
								<SortableRow
									key={item.id}
									item={item}
									index={index}
									isActive={index === currentIndex}
									connected={connected}
									onPlay={onPlay}
									onRemove={onRemove}
								/>
							))}
						</div>
					</SortableContext>
					<DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>
						{activeItem && activeIndex >= 0 ? (
							<QueueRowContent
								item={activeItem}
								index={activeIndex}
								isActive={activeIndex === currentIndex}
								connected={connected}
								onPlay={onPlay}
								onRemove={onRemove}
								isOverlay
							/>
						) : null}
					</DragOverlay>
				</DndContext>
			)}

			{items.length > 0 ? (
				<p className="queue-hint muted">Hold the handle, then drag to reorder</p>
			) : null}
		</div>
	);
}

/** Optimistic reorder helper for local state updates */
export function reorderItemsLocally<T extends { id: string }>(
	items: T[],
	fromIndex: number,
	toIndex: number,
): T[] {
	return arrayMove(items, fromIndex, toIndex);
}
