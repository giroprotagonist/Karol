import isReceiverMode from './isReceiverMode';

const STORAGE_KEY = 'deskreenReceiverMonoOutput';

export function getReceiverMonoOutputPreference(): boolean {
	if (typeof window === 'undefined') {
		return false;
	}
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === '0') {
			return false;
		}
		if (stored === '1') {
			return true;
		}
		// Default ON in receiver mode — downmix for single-speaker tablets / karaoke.
		return isReceiverMode();
	} catch {
		return false;
	}
}

export function setReceiverMonoOutputPreference(enabled: boolean): void {
	if (typeof window === 'undefined') {
		return;
	}
	try {
		localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
	} catch {
		// ignore quota / private mode errors
	}
}
