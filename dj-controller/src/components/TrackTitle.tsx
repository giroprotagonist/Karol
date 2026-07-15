import { useState, type CSSProperties } from 'react';

type TrackTitleProps = {
	text: string;
	className?: string;
	/** Lines shown before tap-to-expand; omit for full text */
	clampLines?: number;
};

export default function TrackTitle({ text, className = '', clampLines = 4 }: TrackTitleProps) {
	const [expanded, setExpanded] = useState(false);
	const style =
		!expanded && clampLines > 0
			? ({
					WebkitLineClamp: clampLines,
				} as CSSProperties)
			: undefined;

	return (
		<button
			type="button"
			className={`track-title ${expanded ? 'expanded' : 'clamped'} ${className}`.trim()}
			style={style}
			aria-expanded={expanded}
			title={expanded ? 'Collapse title' : 'Show full title'}
			onClick={() => setExpanded((value) => !value)}
		>
			{text}
		</button>
	);
}
