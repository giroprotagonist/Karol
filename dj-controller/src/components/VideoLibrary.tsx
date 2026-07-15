import { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchLibraryList, queueUrl, formatTime } from '../api';
import type { LibraryVideoMeta } from '../api';

const PAGE_SIZE = 50;

type VideoLibraryProps = {
	host: string;
	connected: boolean;
	busy: string;
};

export default function VideoLibrary({ host, connected, busy }: VideoLibraryProps) {
	const [allVideos, setAllVideos] = useState<LibraryVideoMeta[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [search, setSearch] = useState('');
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
	const [actionBusy, setActionBusy] = useState<Record<string, 'play' | 'queue'>>({});

	useEffect(() => {
		if (!host || !connected) return;
		setLoading(true);
		fetchLibraryList(host)
			.then((result) => {
				setAllVideos(result.videos);
				setTotal(result.count);
				setVisibleCount(PAGE_SIZE);
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [host, connected]);

	const visible = useMemo(() => {
		const filtered = search.trim()
			? allVideos.filter((v) => v.title.toLowerCase().includes(search.toLowerCase()))
			: allVideos;
		return filtered.slice(0, visibleCount);
	}, [allVideos, search, visibleCount]);

	const hasMore = visible.length > 0 && visibleCount < (search.trim() ? allVideos.filter((v) => v.title.toLowerCase().includes(search.toLowerCase())).length : total);

	const handleAction = useCallback(async (videoId: string, action: 'play-now' | 'queue') => {
		setActionBusy((prev) => ({ ...prev, [videoId]: action === 'play-now' ? 'play' : 'queue' }));
		try {
			await queueUrl(host, `https://www.youtube.com/watch?v=${videoId}`, action);
		} catch {
			// ignore
		} finally {
			setActionBusy((prev) => {
				const next = { ...prev };
				delete next[videoId];
				return next;
			});
		}
	}, [host]);

	return (
		<div className="card vlc-library-card">
			<h2>
				Video Library
				<span className="vlc-library-count">{loading ? '...' : total}</span>
			</h2>

			<div className="vlc-library-search-wrap">
				<span className="vlc-search-icon">🔍</span>
				<input
					className="vlc-search-input"
					placeholder={`Search ${total} videos…`}
					value={search}
					onChange={(e) => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
					disabled={!connected || loading}
				/>
				{search && (
					<button className="vlc-search-clear" onClick={() => { setSearch(''); setVisibleCount(PAGE_SIZE); }}>
						✕
					</button>
				)}
			</div>

			<div className="vlc-library-list">
				{visible.map((video) => (
					<div key={video.videoId} className="vlc-library-row">
						<div className="vlc-lib-top-row">
							{video.thumbnail ? (
								<img
									className="vlc-lib-thumb"
									src={video.thumbnail}
									alt={video.title}
									loading="lazy"
								/>
							) : (
								<div className="vlc-lib-thumb vlc-lib-thumb-fb">🎬</div>
							)}
							<div className="vlc-lib-meta">
								<span className="vlc-lib-title">{video.title}</span>
								<span className="vlc-lib-subtitle">
									{video.upload_date
										? `${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`
										: ''}
								</span>
							</div>
							<span className="vlc-lib-dur">{formatTime(video.duration)}</span>
						</div>
						<div className="vlc-lib-bottom-row">
							<button
								className="vlc-lib-btn vlc-lib-btn--play"
								disabled={!connected || Boolean(busy) || Boolean(actionBusy[video.videoId])}
								onClick={() => handleAction(video.videoId, 'play-now')}
							>
								<span className="vlc-lib-btn-label">
									{actionBusy[video.videoId] === 'play' ? '...' : 'Play'}
								</span>
							</button>
							<button
								className="vlc-lib-btn vlc-lib-btn--enqueue"
								disabled={!connected || Boolean(busy) || Boolean(actionBusy[video.videoId])}
								onClick={() => handleAction(video.videoId, 'queue')}
							>
								<span className="vlc-lib-btn-label">
									{actionBusy[video.videoId] === 'queue' ? '...' : 'Enqueue'}
								</span>
							</button>
						</div>
					</div>
				))}

				{loading && (
					<div className="vlc-library-skeleton">
						{[...Array(3)].map((_, i) => (
							<div key={i} className="vlc-library-row">
								<div className="vlc-lib-top-row">
									<div className="vlc-lib-thumb vlc-lib-thumb-skel" />
									<div className="vlc-lib-meta">
										<div className="vlc-skel-line w-70" />
										<div className="vlc-skel-line w-40" />
									</div>
									<div className="vlc-skel-line w-30" />
								</div>
							</div>
						))}
					</div>
				)}

				{hasMore && !loading && (
					<button
						className="btn block"
						onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
						style={{ marginTop: 8 }}
					>
						Load more
					</button>
				)}

				{!loading && visible.length === 0 && total > 0 && search && (
					<p className="muted" style={{ padding: '12px 0' }}>
						No videos match &ldquo;{search}&rdquo;
					</p>
				)}
			</div>
		</div>
	);
}
