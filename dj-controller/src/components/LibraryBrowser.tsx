import { useState, useMemo, useCallback } from 'react';
import { queueUrl, formatTime } from '../api';
import type { LibraryVideoMeta, LibraryScanStats, LibraryTagEntry } from '../api';

export interface MergedVideo {
	videoId: string;
	title: string;
	duration: number;
	size: number;
	subtitles: string[];
	thumbnail: string;
	uploaded: string;
	downloaded: boolean;
	tag: string;
	year: string;
	artist: string;
	source: string;
}

type SortKey = 'title' | 'artist' | 'year' | 'duration' | 'size' | 'tag';
type ViewMode = 'list' | 'grid';

function fmtSize(b: number): string {
	if (!b) return '0 KB';
	if (b < 1048576) return `${Math.round(b / 1024)} KB`;
	return `${(b / 1048576).toFixed(1)} MB`;
}

function fmtYear(s: string | number): string {
	const str = String(s ?? '');
	if (!str) return '';
	return str.slice(0, 4);
}

type Props = {
	host: string;
	connected: boolean;
	busy: string;
	videos: LibraryVideoMeta[];
	tags: Record<string, LibraryTagEntry>;
	scanStats: LibraryScanStats | null;
	loading: boolean;
	onRefresh: () => void;
	onVideoDeleted?: (videoId: string) => void;
};

export default function LibraryBrowser({ host, connected, busy, videos, tags, scanStats, loading, onRefresh, onVideoDeleted }: Props) {
	const [search, setSearch] = useState('');
	const [downloadFilter, setDownloadFilter] = useState('all');
	const [tagFilter, setTagFilter] = useState('all');
	const [sortKey, setSortKey] = useState<SortKey>('year');
	const [sortAsc, setSortAsc] = useState(false);
	const [viewMode, setViewMode] = useState<ViewMode>('list');
	const [actionBusy, setActionBusy] = useState<Record<string, 'play' | 'queue'>>({});
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	const merged = useMemo<MergedVideo[]>(() => {
		return videos.map((v) => {
			const t = tags[v.videoId];
			return {
				videoId: v.videoId,
				title: v.title && v.title !== v.videoId ? v.title : v.videoId,
				duration: v.duration ?? 0,
				size: v.size ?? 0,
				subtitles: v.subtitles ?? [],
				thumbnail: v.thumbnail ?? '',
				uploaded: v.upload_date ?? '',
				downloaded: v.cached ?? true,
				tag: t?.tag || v.tag || 'music',
				year: t?.year || (v.upload_date && v.upload_date.length >= 4 ? v.upload_date.slice(0, 4) : ''),
				artist: t?.artist ?? '',
				source: t?.source ?? '',
			};
		});
	}, [videos, tags]);

	const filtered = useMemo(() => {
		let result = [...merged];
		if (search.trim()) {
			const q = search.toLowerCase();
			result = result.filter((v) => v.title.toLowerCase().includes(q));
		}
		if (downloadFilter === 'downloaded') result = result.filter((v) => v.downloaded);
		if (downloadFilter === 'missing') result = result.filter((v) => !v.downloaded);
		if (tagFilter === 'karaoke') {
			result = result.filter((v) => v.tag === 'karaoke' && v.source !== 'karaoke-maker');
		}
		if (tagFilter === 'custom') {
			const ids = new Set(merged.map((v) => v.videoId));
			result = result.filter((v) => {
				const isCustom = v.source === 'karaoke-maker' || v.tag === 'custom';
				if (!isCustom) return false;
				// Never list Music Video twins under Custom
				if ((v.tag === 'music' || v.tag === 'song') && !/-karaoke$/.test(v.videoId)) return false;
				// Prefer '-karaoke' row when both base + variant are present
				if (!/-karaoke$/.test(v.videoId) && ids.has(v.videoId + '-karaoke')) return false;
				return true;
			});
		}
		if (tagFilter === 'musicvideo' || tagFilter === 'song') {
			result = result.filter((v) => v.tag === 'song' || v.tag === 'music');
		}

		result.sort((a, b) => {
			const dir = sortAsc ? 1 : -1;
			switch (sortKey) {
				case 'title':
					return dir * a.title.toLowerCase().localeCompare(b.title.toLowerCase());
				case 'artist':
					return dir * (a.artist || '').toLowerCase().localeCompare((b.artist || '').toLowerCase());
				case 'year':
					return dir * ((parseInt(a.year) || 0) - (parseInt(b.year) || 0));
				case 'duration':
					return dir * ((a.duration || 0) - (b.duration || 0));
				case 'size':
					return dir * ((a.size || 0) - (b.size || 0));
				case 'tag':
					return dir * a.tag.localeCompare(b.tag);
				default:
					return 0;
			}
		});
		return result;
	}, [merged, search, downloadFilter, tagFilter, sortKey, sortAsc]);

	const handleAction = useCallback(
		async (videoId: string, action: 'play-now' | 'queue') => {
			setActionBusy((prev) => ({ ...prev, [videoId]: action === 'play-now' ? 'play' : 'queue' }));
			try {
				await queueUrl(host, `https://www.youtube.com/watch?v=${videoId}`, action);
			} catch {
				/* ignore */
			} finally {
				setActionBusy((prev) => {
					const next = { ...prev };
					delete next[videoId];
					return next;
				});
			}
		},
		[host],
	);

	const handleDelete = useCallback(
		async (videoId: string) => {
			setConfirmDelete(null);
			setDeleting(true);
			try {
				const normalized = host.replace(/\/+$/, '');
				const res = await fetch(`${normalized}/api/library/video/${encodeURIComponent(videoId)}`, {
					method: 'DELETE',
				});
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					throw new Error(body.error || `Delete failed (${res.status})`);
				}
				onVideoDeleted?.(videoId);
			} catch (err) {
				alert(err instanceof Error ? err.message : 'Delete failed');
			} finally {
				setDeleting(false);
			}
		},
		[host, onVideoDeleted],
	);

	const toggleSort = (key: SortKey) => {
		if (sortKey === key) setSortAsc(!sortAsc);
		else {
			setSortKey(key);
			setSortAsc(key === 'year' ? false : true);
		}
	};

	const headCell = (key: SortKey, label: string) => (
		<th
			className={`lib-list-th lib-list-th--sortable ${sortKey === key ? 'lib-list-th--active' : ''}`}
			onClick={() => toggleSort(key)}
		>
			{label}
			<span className={`lib-list-sort-ind ${sortKey === key ? (sortAsc ? 'lib-list-sort-ind--asc' : 'lib-list-sort-ind--desc') : ''}`}>
				{sortKey === key ? (sortAsc ? '▲' : '▼') : ''}
			</span>
		</th>
	);

	const dlCount = merged.filter((v) => v.downloaded).length;
	const karaokeCount = merged.filter((v) => v.tag === 'karaoke').length;
	const total = videos.length;

	return (
		<div className="card vlc-library-card">
			<h2>
				Video Library
				<span className="vlc-library-count">{loading ? '...' : total}</span>
			</h2>

			{/* Summary bar */}
			{(total > 0 || loading) && (
				<div className="lib-summary">
					{loading ? (
						<span className="muted">Loading…</span>
					) : (
						<>
							<span>📹 {total} videos</span>
							<span>✅ {dlCount} downloaded</span>
							<span>🎤 {karaokeCount} karaoke</span>
							{scanStats?.totalSizeFormatted ? (
								<span>💾 {scanStats.totalSizeFormatted}</span>
							) : null}
						</>
					)}
				</div>
			)}

			{/* Toolbar */}
			<div className="lib-toolbar">
				<input
					className="lib-search vlc-search-input"
					placeholder={`Search ${total} videos…`}
					value={search}
					onChange={(e) => { setSearch(e.target.value); }}
					disabled={!connected || loading}
					style={{ flex: 2 }}
				/>
				<select
					className="lib-filter-sel"
					value={tagFilter}
					onChange={(e) => setTagFilter(e.target.value)}
				>
				<option value="all">All types</option>
				<option value="karaoke">Karaoke</option>
				<option value="custom">Custom</option>
				<option value="musicvideo">Music Videos</option>
				</select>
				<select
					className="lib-filter-sel"
					value={downloadFilter}
					onChange={(e) => setDownloadFilter(e.target.value)}
				>
					<option value="all">All status</option>
					<option value="downloaded">Downloaded</option>
					<option value="missing">Missing</option>
				</select>
				<div className="lib-view-toggle">
					<button
						className={`lib-sub-btn ${viewMode === 'list' ? 'active' : ''}`}
						onClick={() => setViewMode('list')}
					>
						List
					</button>
					<button
						className={`lib-sub-btn ${viewMode === 'grid' ? 'active' : ''}`}
						onClick={() => setViewMode('grid')}
					>
						Grid
					</button>
				</div>
				<button
					className="btn small"
					onClick={onRefresh}
					disabled={!connected || loading}
					title="Refresh library data"
				>
					↻
				</button>
			</div>

			<div className="lib-sub-nav">
				<span className="lib-sub-count">
					Showing all {filtered.length} of {total}
					{search ? ' matching' : ''}
				</span>
			</div>

			{/* List view */}
			{viewMode === 'list' && (
				<table className="lib-list-table">
					<thead>
						<tr>
							<th className="lib-list-th lib-list-th--thumb" />
							{headCell('title', 'Title')}
							{headCell('artist', 'Artist')}
							{headCell('year', 'Year')}
							{headCell('duration', 'Dur')}
							{headCell('size', 'Size')}
							{headCell('tag', 'Type')}
							<th className="lib-list-th">Actions</th>
						</tr>
					</thead>
					<tbody>
						{loading && (
							<tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 32 }}>
								<span className="lib-dl-spinner" style={{ marginRight: 10, verticalAlign: 'middle' }} />
								Loading library…
							</td></tr>
						)}
						{!loading && filtered.map((v) => {
							const isCustom = v.source === 'karaoke-maker' || v.tag === 'custom';
							const isKaraoke = v.tag === 'karaoke' && !isCustom;
							const typeLabel = isCustom ? 'Custom' : isKaraoke ? 'Karaoke' : 'Music Video';
							const typeClass = isCustom
								? 'lib-badge--custom'
								: isKaraoke
									? 'lib-badge--karaoke'
									: 'lib-badge--mv';
							return (
								<tr
									key={v.videoId}
									className={`${!v.downloaded ? 'lib-list-row--nodl' : ''}`}
								>
									<td className="lib-list-td lib-list-td--thumb">
										{v.thumbnail ? (
											<img
												className="vlc-lib-thumb"
												src={v.thumbnail}
												alt=""
												loading="lazy"
											/>
										) : (
											<div className="vlc-lib-thumb vlc-lib-thumb-fb">🎬</div>
										)}
									</td>
									<td className="lib-list-td lib-list-td--title" title={v.title}>
										{v.title.length > 55 ? `${v.title.slice(0, 52)}…` : v.title}
									</td>
									<td className="lib-list-td lib-list-td--artist">{v.artist}</td>
									<td className="lib-list-td lib-list-td--year">{fmtYear(v.year)}</td>
									<td className="lib-list-td lib-list-td--dur">{formatTime(v.duration)}</td>
									<td className="lib-list-td lib-list-td--size">{fmtSize(v.size)}</td>
									<td className="lib-list-td lib-list-td--type">
										<span className={`lib-badge ${typeClass}`}>{typeLabel}</span>
										{!v.downloaded && (
											<span className="lib-badge lib-badge--missing">Missing</span>
										)}
									</td>
									<td className="lib-list-td lib-list-td--actions">
										<button
											className="lib-list-act-btn lib-list-act-btn--play"
											disabled={!connected || Boolean(busy) || Boolean(actionBusy[v.videoId])}
											onClick={() => handleAction(v.videoId, 'play-now')}
										>
											{actionBusy[v.videoId] === 'play' ? '…' : '▶'}
										</button>
										<button
											className="lib-list-act-btn lib-list-act-btn--queue"
											disabled={!connected || Boolean(busy) || Boolean(actionBusy[v.videoId])}
											onClick={() => handleAction(v.videoId, 'queue')}
										>
											{actionBusy[v.videoId] === 'queue' ? '…' : '+'}
										</button>
										<button
											className="lib-list-act-btn lib-list-act-btn--delete"
											disabled={Boolean(deleting)}
											onClick={() => setConfirmDelete(v.videoId)}
											title="Delete video from library"
										>
											{confirmDelete === v.videoId ? '…' : '✕'}
										</button>
									</td>
								</tr>
							);
						})}
						{!loading && filtered.length === 0 && (
							<tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
								No videos match
							</td></tr>
						)}
					</tbody>
				</table>
			)}

			{/* Grid view */}
			{viewMode === 'grid' && (
				<div className="lib-grid">
					{loading && (
						<>
							{[...Array(6)].map((_, i) => (
								<div key={`skel-${i}`} className="lib-card pulse" style={{ pointerEvents: 'none' }}>
									<div className="lib-card-img" style={{ background: 'var(--bg-hover)' }} />
									<div className="lib-card-body">
										<div className="vlc-skel-line w-70" style={{ marginBottom: 8 }} />
										<div className="vlc-skel-line w-40" />
									</div>
								</div>
							))}
						</>
					)}
					{!loading && filtered.map((v) => (
						<div
							key={v.videoId}
							className={`lib-card ${!v.downloaded ? 'lib-card--not-dl' : ''} ${v.tag === 'karaoke' ? 'lib-card--karaoke' : ''}`}
						>
							<div className="lib-card-img">
								{v.thumbnail ? (
									<img src={v.thumbnail} alt={v.title} loading="lazy" />
								) : (
									<div className="vlc-lib-thumb-fb" style={{ width: '100%', height: '100%' }}>🎬</div>
								)}
								<div className="lib-card-overlay">
									<button
										className="lib-card-overlay-btn"
										disabled={!connected || Boolean(busy) || Boolean(actionBusy[v.videoId])}
										onClick={() => handleAction(v.videoId, 'play-now')}
										aria-label="Play now"
									>
										{actionBusy[v.videoId] === 'play' ? '…' : '▶'}
									</button>
									<button
										className="lib-card-overlay-btn lib-card-overlay-btn--queue"
										disabled={!connected || Boolean(busy) || Boolean(actionBusy[v.videoId])}
										onClick={() => handleAction(v.videoId, 'queue')}
										aria-label="Add to queue"
									>
										{actionBusy[v.videoId] === 'queue' ? '…' : '+'}
									</button>
									<button
										className="lib-card-overlay-btn lib-card-overlay-btn--delete"
										disabled={Boolean(deleting)}
										onClick={() => setConfirmDelete(v.videoId)}
										aria-label="Delete video"
									>
										{confirmDelete === v.videoId ? '…' : '✕'}
									</button>
								</div>
								<div className="lib-card-badges">
									{v.downloaded ? (
										<span className="lib-badge lib-badge--dl">DL</span>
									) : (
										<span className="lib-badge lib-badge--missing">Missing</span>
									)}
									{(v.source === 'karaoke-maker' || v.tag === 'custom') ? (
										<span className="lib-badge lib-badge--custom">Custom</span>
									) : v.tag === 'karaoke' ? (
										<span className="lib-badge lib-badge--karaoke">Karaoke</span>
									) : (
										<span className="lib-badge lib-badge--mv">Music Video</span>
									)}
								</div>
							</div>
							<div className="lib-card-body">
								<div className="lib-card-title">{v.title}</div>
								<div className="lib-card-meta">
									{v.artist && <span>{v.artist}</span>}
									{v.year && <span>{fmtYear(v.year)}</span>}
									{v.duration > 0 && <span>{formatTime(v.duration)}</span>}
									<span>{fmtSize(v.size)}</span>
								</div>
							</div>
						</div>
					))}
					{!loading && filtered.length === 0 && (
						<div className="lib-empty" style={{ gridColumn: '1 / -1' }}>
							<div className="vlc-empty-icon">🎬</div>
							<p className="vlc-empty-heading">No videos match</p>
							<p className="vlc-empty-hint">Try adjusting your search or filters</p>
						</div>
					)}
				</div>
			)}

			{/* Confirmation dialog */}
			{confirmDelete && (
				<div className="lib-confirm-overlay" onClick={() => setConfirmDelete(null)}>
					<div className="lib-confirm-dialog" onClick={(e) => e.stopPropagation()}>
						<p className="lib-confirm-text">
							Delete <strong>{merged.find((v) => v.videoId === confirmDelete)?.title || confirmDelete}</strong> from the library?
						</p>
						<p className="lib-confirm-hint">This removes the video file from disk and cannot be undone.</p>
						<div className="lib-confirm-actions">
							<button
								className="btn small"
								onClick={() => setConfirmDelete(null)}
								disabled={deleting}
							>
								Cancel
							</button>
							<button
								className="btn small lib-confirm-delete-btn"
								onClick={() => handleDelete(confirmDelete)}
								disabled={deleting}
							>
								{deleting ? 'Deleting…' : 'Delete'}
							</button>
						</div>
					</div>
				</div>
			)}

		</div>
	);
}
