import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { app } from 'electron';

const hasBundle = (directory: string): boolean => {
	if (!directory) {
		return false;
	}
	return existsSync(join(directory, 'index.html'));
};

const normalizeCandidates = (candidates: string[]): string[] => {
	const normalized = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}
		normalized.add(resolve(candidate));
	}
	return [...normalized];
};

export const getDjControllerDistPath = (): string => {
	const resourcesPath = process.resourcesPath ?? '';
	const appPath = app.getAppPath();

	const candidates = normalizeCandidates([
		join(__dirname, '../dj-controller'),
		join(appPath, 'dj-controller'),
		join(appPath, 'out/dj-controller'),
		join(resourcesPath, 'dj-controller'),
		join(resourcesPath, 'app.asar.unpacked/dj-controller'),
		join(process.cwd(), 'out/dj-controller'),
		join(process.cwd(), 'src/dj-controller/dist'),
	]);

	for (const candidate of candidates) {
		if (hasBundle(candidate)) {
			return candidate;
		}
	}

	return '';
};
