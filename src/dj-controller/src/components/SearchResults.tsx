import type { YouTubeSearchResult } from '@common/YouTubeKaraokeTypes';

type SearchResultsProps = {
	results: YouTubeSearchResult[];
	connected: boolean;
	onQueue: (url: string) => void;
	onPlayNow: (url: string) => void;
};

export default function SearchResults({
	results,
	connected,
	onQueue,
	onPlayNow,
}: SearchResultsProps) {
	if (results.length === 0) {
		return null;
	}

	return (
		<div className="search-results">
			{results.map((result) => (
				<div key={result.videoId} className="search-result">
					<img
						className="search-thumb"
						src={result.thumbnailUrl || `https://img.youtube.com/vi/${result.videoId}/mqdefault.jpg`}
						alt=""
						loading="lazy"
					/>
					<div className="search-body">
						<div className="search-title">{result.title}</div>
						<div className="search-channel">{result.channelTitle}</div>
						<div className="search-actions">
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
			))}
		</div>
	);
}
