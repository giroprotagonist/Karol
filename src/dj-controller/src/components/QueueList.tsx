import React, { useEffect, useRef, useState, type HTMLAttributes } from 'react';
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
import { formatTime, QUEUE_SORT_OPTIONS, type QueueSortMode } from '../api';

type QueueListProps = {
	items: YouTubeQueueItem[];
	currentIndex: number;
	connected: boolean;
	busy: boolean;
	onReorder: (fromIndex: number, toIndex: number) => Promise<void>;
	onPlay: (id: string) => void;
	onRemove: (id: string) => void;
	onClear: () => void;
	onShuffleUpcoming: () => void;
	onSort: (mode: QueueSortMode) => void;
	shuffleEnabled?: boolean;
	onDragActiveChange?: (active: boolean) => void;
};

function youtubeThumb(videoId: string, thumbnail?: string): string {
	if (thumbnail) {
		return thumbnail;
	}
	return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

function statusLabel(status: YouTubeQueueItem['status'], isActive: boolean): string {
	if (isActive) {
		return 'Now';
	}
	switch (status) {
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
			<div className="queue-leading-col">
				<span className="queue-index">{index + 1}</span>
				{!isOverlay && (
					<div className="queue-leading-actions">
						<button
							className="queue-row-btn play"
							type="button"
							disabled={!connected}
							title="Play this track"
							onClick={() => onPlay(item.id)}
						>
							▶
						</button>
						<button
							className="queue-row-btn remove"
							type="button"
							disabled={!connected}
							title="Remove from queue"
							onClick={() => onRemove(item.id)}
						>
							×
						</button>
					</div>
				)}
			</div>
			<button
				type="button"
				className="queue-art-drag"
				aria-label={`Drag to reorder ${title}`}
				disabled={!connected || isOverlay}
				{...dragHandleProps}
			>
				<img
					className="queue-thumb"
					src={youtubeThumb(item.videoId, item.thumbnail)}
					alt=""
					loading="lazy"
				/>
			</button>
			<div className="queue-item-body">
				<p className="queue-title-full">{title}</p>
				<div className="queue-meta-row">
					<span className={`status-chip status-${isActive ? 'playing' : item.status === 'error' ? 'error' : item.status === 'ended' ? 'ended' : 'queued'}`}>
						{statusLabel(item.status, isActive)}
					</span>
					{item.durationSec ? (
						<span className="queue-duration">{formatTime(item.durationSec)}</span>
					) : null}
					{item.errorReason && !isActive ? (
						<span className="queue-error" title={item.errorReason}>
							{item.errorReason}
						</span>
					) : null}
				</div>
			</div>
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

const RowPlaceholderHeight = 108;

function SortableRowInner({
	item,
	index,
	isActive,
	connected,
	onPlay,
	onRemove,
}: SortableRowProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
		useSortable({ id: item.id, disabled: !connected });
	const [hydrated, setHydrated] = useState(isActive || index < 25 || index >= 99999);
	const sentinelRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (hydrated) return;
		const el = sentinelRef.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					setHydrated(true);
					observer.disconnect();
				}
			},
			{ rootMargin: '800px', threshold: 0 },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hydrated]);

	const style = {
		transform: CSS.Transform.toString(transform),
		transition: isDragging ? undefined : transition,
		opacity: isDragging ? 0.35 : 1,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={isDragging ? 'sortable-ghost' : undefined}
			data-queue-index={index}
		>
			<div ref={sentinelRef}>
				{hydrated ? (
					<QueueRowContent
						item={item}
						index={index}
						isActive={isActive}
						connected={connected}
						onPlay={onPlay}
						onRemove={onRemove}
						dragHandleProps={{ ...attributes, ...listeners }}
					/>
				) : (
					<div
						className="queue-item queue-item-placeholder"
						style={{ height: RowPlaceholderHeight }}
					>
						<span className="queue-index">{index + 1}</span>
						<div className="queue-item-body" style={{ flex: 1 }}>
							<span className="queue-title-full" style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
								{item.title ? item.title.slice(0, 50) : '...'}
							</span>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

const SortableRow = React.memo(SortableRowInner);

export default function QueueList({
	items,
	currentIndex,
	connected,
	busy,
	onReorder,
	onPlay,
	onRemove,
	onClear,
	onShuffleUpcoming,
	onSort,
	shuffleEnabled = false,
	onDragActiveChange,
}: QueueListProps) {
	const [activeId, setActiveId] = useState<string | null>(null);
	const [sortMode, setSortMode] = useState<QueueSortMode>('custom');
	const listRef = useRef<HTMLDivElement | null>(null);
	const prevIndexRef = useRef(-999);

	useEffect(() => {
		return () => onDragActiveChange?.(false);
	}, [onDragActiveChange]);

	useEffect(() => {
		if (currentIndex < 0 || !listRef.current) {
			return;
		}
		if (prevIndexRef.current === currentIndex) {
			return;
		}
		prevIndexRef.current = currentIndex;
		const container = listRef.current;
		const row = container.querySelector<HTMLElement>(
			`[data-queue-index="${currentIndex}"]`,
		);
		if (!row) {
			return;
		}
		// Scroll inside queue panel when scrollable; otherwise scroll page to active row.
		if (container.scrollHeight <= container.clientHeight) {
			row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			return;
		}
		const rowTop = row.offsetTop;
		const rowBottom = rowTop + row.offsetHeight;
		const viewTop = container.scrollTop;
		const viewBottom = viewTop + container.clientHeight;
		if (rowTop < viewTop) {
			container.scrollTop = rowTop;
		} else if (rowBottom > viewBottom) {
			container.scrollTop = rowBottom - container.clientHeight;
		}
	}, [currentIndex]);

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
		setSortMode('custom');
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
						{shuffleEnabled ? ' · shuffle on' : ''}
					</p>
				</div>
				<div className="queue-header-actions">
					<label className="queue-sort-label">
						<span className="sr-only">Sort queue</span>
						<select
							className="queue-sort-select"
							value={sortMode}
							disabled={!connected || items.length < 2 || busy}
							onChange={(e) => {
								const mode = e.target.value as QueueSortMode;
								setSortMode(mode);
								if (mode !== 'custom') {
									onSort(mode);
								}
							}}
						>
							{QUEUE_SORT_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</label>
					<button
						className="btn small"
						type="button"
						disabled={
							!connected ||
							items.length < 2 ||
							busy ||
							(currentIndex >= 0 && currentIndex >= items.length - 1)
						}
						onClick={onShuffleUpcoming}
						title="Randomize upcoming tracks (keeps current song)"
					>
						Shuffle upcoming
					</button>
					<button
					className="btn small danger-subtle"
					type="button"
					disabled={!connected || items.length === 0 || busy}
					onClick={onClear}
				>
					Clear all
				</button>
				</div>
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
						<div className="queue-list" ref={listRef}>
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
				<p className="queue-hint muted">Hold artwork, then drag to reorder</p>
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
