type IconProps = {
	className?: string;
};

export function IconSkipPrev({ className }: IconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
			<path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z" fill="currentColor" />
		</svg>
	);
}

export function IconSkipNext({ className }: IconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
			<path d="M6 18l8.5-6L6 6v12zm2-6v0zm3.5 0L18 18V6l-6.5 6z" fill="currentColor" />
		</svg>
	);
}

export function IconPlay({ className }: IconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
			<path d="M8 5v14l11-7L8 5z" fill="currentColor" />
		</svg>
	);
}

export function IconPause({ className }: IconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
			<path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" fill="currentColor" />
		</svg>
	);
}

export function IconVolumeMute({ className }: IconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
			<path
				d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"
				fill="currentColor"
			/>
		</svg>
	);
}

export function IconVolumeLow({ className }: IconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
			<path
				d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"
				fill="currentColor"
			/>
		</svg>
	);
}

export function IconVolumeHigh({ className }: IconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
			<path
				d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
				fill="currentColor"
			/>
		</svg>
	);
}
