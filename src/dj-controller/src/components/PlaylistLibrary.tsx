import { PLAYLIST_SYNC_INTERVAL_MS } from '@common/youtubeDjDefaults';
import type { YouTubeDjPlaylistModeConfig } from '@common/YouTubeKaraokeTypes';
import { formatSyncTime } from '../api';

type PlaylistLibraryProps = {
	config: YouTubeDjPlaylistModeConfig | null;
	connected: boolean;
	busy: string;
	newPlaylistUrl: string;
	onNewPlaylistUrlChange: (url: string) => void;
	onAddPlaylist: () => void;
	onActivate: (playlistId: string, playFirst: boolean) => void;
	onRemove: (playlistId: string) => void;
	onSyncToggle: (enabled: boolean) => void;
	onSyncNow: () => void;
};

export default function PlaylistLibrary({
	config,
	connected,
	busy,
	newPlaylistUrl,
	onNewPlaylistUrlChange,
	onAddPlaylist,
	onActivate,
	onRemove,
	onSyncToggle,
	onSyncNow,
}: PlaylistLibraryProps) {
	const playlists = config?.playlists ?? [];
	const activeId = config?.activePlaylistId ?? config?.playlistId ?? '';
	const activePlaylist = playlists.find((p) => p.playlistId === activeId);

	return (
		<div className="card playlist-library">
			<h2>Show Playlists</h2>
			<p className="card-subtitle">
				Save multiple YouTube playlists, then pick which one powers the show queue.
				Large playlists (500+ songs) may take a minute to load.
			</p>

			{activePlaylist ? (
				<div className="playlist-active-banner" role="status">
					<span className="playlist-active-label">Current show</span>
					<strong className="playlist-active-name">{activePlaylist.name}</strong>
					<span className="playlist-active-meta">
						{activePlaylist.videoCount > 0
							? `${activePlaylist.videoCount} tracks synced`
							: 'Not synced yet'}
					</span>
				</div>
			) : (
				<div className="playlist-empty-hint">
					Add a playlist below, then tap <strong>Use as show</strong> to load it into the
					queue.
				</div>
			)}

			<label className="toggle-row">
				<span>Auto-sync active playlist</span>
				<span className="switch">
					<input
						type="checkbox"
						checked={Boolean(config?.enabled)}
						disabled={!connected || Boolean(busy) || playlists.length === 0}
						onChange={(e) => onSyncToggle(e.target.checked)}
					/>
					<span className="slider" />
				</span>
			</label>
			{config?.enabled ? (
				<p className="muted sync-meta">
					Polling every {Math.round(PLAYLIST_SYNC_INTERVAL_MS / 60_000)} min · last sync{' '}
					{formatSyncTime(config.lastSyncAt)} · +{config.lastAddedCount} added
				</p>
			) : null}
			{config?.lastSyncError ? (
				<p className="error-text">Sync error: {config.lastSyncError}</p>
			) : null}

			<button
				className="btn block"
				type="button"
				disabled={
					!connected ||
					!config?.enabled ||
					!activeId ||
					Boolean(busy)
				}
				onClick={onSyncNow}
			>
				{busy === 'sync' ? 'Syncing…' : 'Sync active playlist now'}
			</button>

			<div className="divider" />

			<h3 className="playlist-section-title">Your playlists</h3>
			{playlists.length === 0 ? (
				<p className="muted">No playlists saved yet.</p>
			) : (
				<ul className="playlist-list">
					{playlists.map((playlist) => {
						const isActive = playlist.playlistId === activeId;
						return (
							<li
								key={playlist.playlistId}
								className={`playlist-item ${isActive ? 'active' : ''}`}
							>
								<div className="playlist-item-main">
									<div className="playlist-item-title-row">
										<span className="playlist-item-name">{playlist.name}</span>
										{isActive ? (
											<span className="playlist-show-badge">Show</span>
										) : null}
									</div>
									<p className="playlist-item-meta">
										{playlist.videoCount > 0
											? `${playlist.videoCount} tracks`
											: 'Not loaded'}
										{playlist.lastSyncAt
											? ` · synced ${formatSyncTime(playlist.lastSyncAt)}`
											: ''}
									</p>
									{playlist.lastSyncError ? (
										<p className="playlist-item-error">{playlist.lastSyncError}</p>
									) : null}
								</div>
								<div className="playlist-item-actions">
									{!isActive ? (
										<button
											type="button"
											className="btn primary compact"
											disabled={!connected || Boolean(busy)}
											onClick={() => onActivate(playlist.playlistId, false)}
										>
											Use as show
										</button>
									) : null}
									<button
										type="button"
										className="btn compact"
										disabled={!connected || Boolean(busy)}
										onClick={() => onActivate(playlist.playlistId, true)}
										title="Load playlist and start playing"
									>
										▶ Play
									</button>
									<button
										type="button"
										className="btn danger compact"
										disabled={
											!connected ||
											Boolean(busy) ||
											(playlists.length === 1 && isActive)
										}
										onClick={() => onRemove(playlist.playlistId)}
										title={
											playlists.length === 1 && isActive
												? 'Add another playlist before removing the only one'
												: 'Remove playlist'
										}
									>
										Remove
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}

			<div className="divider" />

			<h3 className="playlist-section-title">Add playlist</h3>
			<input
				className="field"
				placeholder="YouTube playlist URL or ID"
				value={newPlaylistUrl}
				disabled={!connected || Boolean(busy)}
				onChange={(e) => onNewPlaylistUrlChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && newPlaylistUrl.trim() && connected && !busy) {
						onAddPlaylist();
					}
				}}
			/>
			<button
				className="btn primary block"
				type="button"
				disabled={!connected || !newPlaylistUrl.trim() || Boolean(busy)}
				onClick={onAddPlaylist}
					>
						{busy === 'activate' || busy === 'activate-play'
							? 'Loading playlist…'
							: busy === 'add-playlist'
								? 'Adding…'
								: 'Add playlist'}
					</button>
		</div>
	);
}
