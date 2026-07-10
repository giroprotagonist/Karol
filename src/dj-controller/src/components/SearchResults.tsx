import type { YouTubeSearchResult } from '@common/YouTubeKaraokeTypes';
import TrackTitle from './TrackTitle';

type SearchResultsProps = {
	results: YouTubeSearchResult[];
	connected: boolean;
	previewVideoId: string | null;
	previewLoading: boolean;
	onPreview: (videoId: string) => void;
	onStopPreview: () => void;
	onQueue: (url: string) => void;
	onPlayNow: (url: string) => void;
};

export default function SearchResults({
	results,
	connected,
	previewVideoId,
	previewLoading,
	onPreview,
	onStopPreview,
	onQueue,
	onPlayNow,
}: SearchResultsProps) {
	if (results.length === 0) {
		return null;
	}

	return (
		<div className="search-results">
			{results.map((result) => {
				const isPreviewing = previewVideoId === result.videoId;
				return (
				<div key={result.videoId} className={`search-result${isPreviewing ? ' preview-active' : ''}`}>
					<img
						className="search-thumb"
						src={result.thumbnailUrl || `https://img.youtube.com/vi/${result.videoId}/mqdefault.jpg`}
						alt=""
						loading="lazy"
					/>
					<div className="search-body">
						<TrackTitle text={result.title} className="search-title" clampLines={4} />
						<div className="search-channel">{result.channelTitle}</div>
						<div className="search-actions">
							{isPreviewing ? (
								<button
									className="btn small"
									type="button"
									disabled={previewLoading}
									onClick={previewLoading ? undefined : onStopPreview}
								>
									{previewLoading ? '◌ Loading...' : '■ Stop'}
								</button>
							) : (
								<button
									className="btn small"
									type="button"
									onClick={() => onPreview(result.videoId)}
								>
									♪ Preview
								</button>
							)}
							<button
								className="btn small"
								type="button"
								disabled={!connected}
								onClick={() => onQueue(result.url)}
							>
								+ Queue
							</button>
							<button
								className="btn small primary"
								type="button"
								disabled={!connected}
								onClick={() => onPlayNow(result.url)}
							>
								▶ Play
							</button>
						</div>
					</div>
				</div>
				);
			})}
		</div>
	);
}
