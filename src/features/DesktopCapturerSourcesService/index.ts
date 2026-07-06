/* eslint-disable no-async-promise-executor */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { desktopCapturer, DesktopCapturerSource } from 'electron';
import Logger from '../../main/utils/LoggerWithFilePrefix';
import DesktopCapturerSourceType from '../../common/DesktopCapturerSourceType';
import isLinuxWaylandSession from '../../main/utils/isLinuxWaylandSession';
import getScreenCapturePermissionStatus from '../../main/utils/getScreenCapturePermissionStatus';
import { isYouTubeOutputCapturerSourceName } from '../../main/helpers/youtubeOutputPlayer';

export interface DesktopCapturerSourceWithType {
	source: import('electron').DesktopCapturerSource;
	type: import('../../common/DesktopCapturerSourceType').default;
}

export function getSourceTypeFromSourceID(
	id: string,
): DesktopCapturerSourceType {
	if (id.includes(DesktopCapturerSourceType.SCREEN)) {
		return DesktopCapturerSourceType.SCREEN;
	}
	return DesktopCapturerSourceType.WINDOW;
}

type SourcesDisappearListener = (ids: string[]) => void;
type SharingSessionID = string;

class DesktopCapturerSourcesService {
	sources: Map<string, DesktopCapturerSourceWithType>;

	lastAvailableScreenIDs: string[];

	lastAvailableWindowIDs: string[];

	onWindowClosedListeners: Map<SharingSessionID, SourcesDisappearListener[]>;

	onScreenDisconnectedListeners: Map<
		SharingSessionID,
		SourcesDisappearListener[]
	>;

	log = new Logger(__filename);

	autoRefreshEnabled: boolean;

	refreshPromise: Promise<void> | null;

	portalSelectionPromise: Promise<DesktopCapturerSource | null> | null;

	lastRefreshError: string | null;

	captureSessionActive: boolean;

	heartbeatInterval: ReturnType<typeof setInterval> | null;

	permissionWarningLogged: boolean;

	getSourcesChain: Promise<unknown>;

	constructor() {
		this.sources = new Map<string, DesktopCapturerSourceWithType>();
		this.lastAvailableScreenIDs = [];
		this.lastAvailableWindowIDs = [];
		this.onWindowClosedListeners = new Map<
			SharingSessionID,
			SourcesDisappearListener[]
		>();
		this.onScreenDisconnectedListeners = new Map<
			SharingSessionID,
			SourcesDisappearListener[]
		>();
		this.autoRefreshEnabled = !isLinuxWaylandSession;
		this.refreshPromise = null;
		this.portalSelectionPromise = null;
		this.lastRefreshError = null;
		this.captureSessionActive = false;
		this.heartbeatInterval = null;
		this.permissionWarningLogged = false;
		this.getSourcesChain = Promise.resolve();

		if (this.autoRefreshEnabled) {
			this.log.debug(
				'desktop capturer sources refresh on demand only (no background polling)',
			);
		} else {
			this.log.debug(
				'skipping desktop capturer auto refresh on wayland session',
			);
		}
		this.startPollForInactiveListenersLoop();
	}

	getLastRefreshError(): string | null {
		return this.lastRefreshError;
	}

	isCaptureSessionActive(): boolean {
		return this.captureSessionActive;
	}

	setCaptureSessionActive(active: boolean, caller = ''): void {
		if (this.captureSessionActive === active) {
			return;
		}
		this.captureSessionActive = active;
		this.log.warn(
			active
				? 'host capture session started'
				: `host capture session ended | caller=${caller}`,
		);

		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}

		if (active) {
			const startTime = Date.now();
			this.heartbeatInterval = setInterval(() => {
				const uptimeSec = Math.round((Date.now() - startTime) / 1000);
				this.log.warn(
					`[HEARTBEAT] capture session alive for ${uptimeSec}s | sources=${this.sources.size}`,
				);
				void this.checkForClosedWindows();
				void this.checkForScreensDisconnected();
			}, 30000);
		}
	}

	private shouldSkipLiveGetSources(reason: string): boolean {
		if (!this.isCaptureSessionActive()) {
			return false;
		}
		this.log.debug(
			`safeGetSources: skipping live getSources (${reason}) — capture session active`,
		);
		return true;
	}

	async safeGetSourcesList(
		options: {
			types: DesktopCapturerSourceType[];
			thumbnailSize: { width: number; height: number };
			fetchWindowIcons?: boolean;
		},
		reason: string,
	): Promise<DesktopCapturerSource[]> {
		if (this.shouldSkipLiveGetSources(reason)) {
			return [...this.sources.values()]
				.filter((entry) => options.types.includes(entry.type))
				.map((entry) => entry.source);
		}

		if (
			process.platform === 'darwin' &&
			getScreenCapturePermissionStatus() !== 'granted'
		) {
			return [];
		}

		return this.runExclusiveGetSources(async () => {
			if (this.shouldSkipLiveGetSources(`${reason}-after-queue`)) {
				return [...this.sources.values()]
					.filter((entry) => options.types.includes(entry.type))
					.map((entry) => entry.source);
			}
			return desktopCapturer.getSources(options);
		});
	}

	private runExclusiveGetSources<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.getSourcesChain.then(operation, operation);
		this.getSourcesChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	getSourcesMap(): Map<string, DesktopCapturerSourceWithType> {
		return this.sources;
	}

	startRefreshDesktopCapturerSourcesLoop(): void {
		if (!this.autoRefreshEnabled) {
			return;
		}
		setInterval(() => {
			this.refreshDesktopCapturerSources();
		}, 5000);
	}

	getScreenSources(): DesktopCapturerSource[] {
		const screenSources: DesktopCapturerSource[] = [];
		[...this.sources.keys()].forEach((key) => {
			const source = this.sources.get(key);
			if (!source) return;
			if (source.type === DesktopCapturerSourceType.SCREEN) {
				screenSources.push(source.source);
			}
		});
		return screenSources;
	}

	getAppWindowSources(): DesktopCapturerSource[] {
		const appWindowSources: DesktopCapturerSource[] = [];
		[...this.sources.keys()].forEach((key) => {
			const source = this.sources.get(key);
			if (!source) return;
			if (source.type === DesktopCapturerSourceType.WINDOW) {
				appWindowSources.push(source.source);
			}
		});
		return appWindowSources;
	}

	/** Returns the Deskreen YouTube Player window source if it exists. */
	getYouTubeWindowSource(): DesktopCapturerSource | null {
		for (const [, source] of this.sources) {
			if (
				source.type === DesktopCapturerSourceType.WINDOW &&
				isYouTubeOutputCapturerSourceName(source.source.name)
			) {
				return source.source;
			}
		}
		return null;
	}

	getSourceDisplayIDByDisplayCapturerSourceID(sourceID: string): string {
		let displayID = '';
		[...this.sources.keys()].forEach((key) => {
			const source = this.sources.get(key);
			if (!source) return;
			if (source.source.id === sourceID) {
				displayID = source.source.display_id;
			}
		});
		return displayID;
	}

	addWindowClosedListener(
		sharingSessionID: string,
		callback: SourcesDisappearListener,
	): void {
		const existing = this.onWindowClosedListeners.get(sharingSessionID) ?? [];
		existing.push(callback);
		this.onWindowClosedListeners.set(sharingSessionID, existing);
	}

	addScreenDisconnectedListener(
		sharingSessionID: string,
		callback: SourcesDisappearListener,
	): void {
		const existing = this.onScreenDisconnectedListeners.get(sharingSessionID) ?? [];
		existing.push(callback);
		this.onScreenDisconnectedListeners.set(sharingSessionID, existing);
	}

	async updateDesktopCapturerSources(): Promise<void> {
		// TODO: implement logic of checking if last sources match new sources,
		// TODO: if source is gone, do proper actions and notify user if needed
		// this.lastAvailableScreenIDs = [];
		// this.lastAvailableWindowIDs = [];

		// [...this.sources.keys()].forEach((key) => {
		//   const oldSource = this.sources.get(key);
		//   if (!oldSource) return;
		//   if (oldSource.type === DesktopCapturerSourceType.WINDOW) {
		//     this.lastAvailableWindowIDs.push(oldSource.source.id);
		//   } else if (oldSource.type === DesktopCapturerSourceType.SCREEN) {
		//     this.lastAvailableScreenIDs.push(oldSource.source.id);
		//   }
		// });

		const newSources = await this.getDesktopCapturerSources();
		this.sources = newSources;
		this.lastAvailableWindowIDs = [...newSources.values()]
			.filter((entry) => entry.type === DesktopCapturerSourceType.WINDOW)
			.map((entry) => entry.source.id);
		this.lastAvailableScreenIDs = [...newSources.values()]
			.filter((entry) => entry.type === DesktopCapturerSourceType.SCREEN)
			.map((entry) => entry.source.id);
		this.lastRefreshError = null;
	}

	async probeScreenCaptureAccess(): Promise<boolean> {
		if (this.isCaptureSessionActive()) {
			return this.sources.size > 0;
		}
		try {
			const sources = await this.safeGetSourcesList(
				{
					types: [DesktopCapturerSourceType.SCREEN],
					thumbnailSize: { width: 1, height: 1 },
				},
				'probeScreenCaptureAccess',
			);
			return sources.length > 0;
		} catch {
			return false;
		}
	}

	async getDesktopCapturerSources(): Promise<
		Map<string, DesktopCapturerSourceWithType>
	> {
		if (this.shouldSkipLiveGetSources('getDesktopCapturerSources')) {
			return new Map(this.sources);
		}

		const capturerSources = await this.safeGetSourcesList(
			{
				types: [
					DesktopCapturerSourceType.WINDOW,
					DesktopCapturerSourceType.SCREEN,
				],
				thumbnailSize: { width: 500, height: 500 },
				fetchWindowIcons: true,
			},
			'getDesktopCapturerSources',
		);

		const newSources = new Map<string, DesktopCapturerSourceWithType>();
		capturerSources.forEach((source) => {
			newSources.set(source.id, {
				type: getSourceTypeFromSourceID(source.id),
				source,
			});
		});
		return newSources;
	}

	getCachedCapturerSourceById(
		sourceId: string,
	): DesktopCapturerSource | null {
		const trimmed = sourceId.trim();
		if (trimmed === '') {
			return null;
		}
		return this.sources.get(trimmed)?.source ?? null;
	}

	/** Upsert a window source into the cache (e.g. YouTube output player before cast). */
	registerCachedWindowSource(source: DesktopCapturerSource): void {
		this.sources.set(source.id, {
			type: DesktopCapturerSourceType.WINDOW,
			source,
		});
	}

	async refreshDesktopCapturerSources(): Promise<void> {
		if (this.isCaptureSessionActive()) {
			this.log.debug(
				'skipping refreshDesktopCapturerSources while capture session active',
			);
			return;
		}

		if (
			process.platform === 'darwin' &&
			getScreenCapturePermissionStatus() !== 'granted'
		) {
			if (!this.permissionWarningLogged) {
				this.log.warn(
					'skipping source refresh: screen recording permission not granted',
				);
				this.permissionWarningLogged = true;
			}
			return;
		}

		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.refreshPromise = (async () => {
			try {
				await this.updateDesktopCapturerSources();
				// eventually run checkers that emit events
				this.checkForClosedWindows();
				this.checkForScreensDisconnected();
			} catch (e) {
				const message =
					typeof e === 'string'
						? e
						: e instanceof Error
							? e.message
							: 'Failed to get sources.';
				this.lastRefreshError = message;
				this.log.error(message, e);
			} finally {
				this.refreshPromise = null;
			}
		})();

		return this.refreshPromise;
	}

	async requestPortalSource(
		types: DesktopCapturerSourceType[],
	): Promise<DesktopCapturerSource | null> {
		if (this.portalSelectionPromise) {
			return this.portalSelectionPromise;
		}

		this.portalSelectionPromise = (async () => {
			try {
				const sources = await this.safeGetSourcesList(
					{
						types,
						thumbnailSize: { width: 500, height: 500 },
						fetchWindowIcons: types.includes(DesktopCapturerSourceType.WINDOW),
					},
					'requestPortalSource',
				);
				if (sources.length === 0) {
					return null;
				}
				const selectedSourcesMap = new Map<
					string,
					DesktopCapturerSourceWithType
				>(this.sources);
				const defaultType = types.length === 1 ? types[0] : undefined;

				sources.forEach((source) => {
					selectedSourcesMap.set(source.id, {
						type: defaultType ?? getSourceTypeFromSourceID(source.id),
						source,
					});
				});

				this.sources = selectedSourcesMap;

				return sources[0];
			} catch (error) {
				this.log.error(error);
				return null;
			} finally {
				this.portalSelectionPromise = null;
			}
		})();

		return this.portalSelectionPromise;
	}

	startPollForInactiveListenersLoop(): void {
		setInterval(
			() => {
				// TODO: implement logic
				// if session ID no longer exists in SharingSessionsService -> remove its listener object
			},
			1000 * 60 * 60,
		); // runs every hour in infinite loop
	}

	checkForClosedWindows(): void {
		if (!this.isCaptureSessionActive()) {
			return;
		}
		const previousWindowIds = [...this.lastAvailableWindowIDs];
		const currentWindowIds = [...this.sources.values()]
			.filter((entry) => entry.type === DesktopCapturerSourceType.WINDOW)
			.map((entry) => entry.source.id);
		this.lastAvailableWindowIDs = currentWindowIds;
		if (previousWindowIds.length === 0) {
			return;
		}
		const disappeared = previousWindowIds.filter((id) => !currentWindowIds.includes(id));
		if (disappeared.length > 0) {
			this.log.warn(`[CAPTURE] window sources disappeared: ${disappeared.join(', ')}`);
			this.notifyOnWindowsClosedListeners(disappeared);
		}
	}

	notifyOnWindowsClosedListeners(closedWindowsIDs: string[]): void {
		for (const listeners of this.onWindowClosedListeners.values()) {
			for (const listener of listeners) {
				try {
					listener(closedWindowsIDs);
				} catch (error) {
					this.log.error('window closed listener failed', error);
				}
			}
		}
	}

	checkForScreensDisconnected(): void {
		if (!this.isCaptureSessionActive()) {
			return;
		}
		const previousScreenIds = [...this.lastAvailableScreenIDs];
		const currentScreenIds = [...this.sources.values()]
			.filter((entry) => entry.type === DesktopCapturerSourceType.SCREEN)
			.map((entry) => entry.source.id);
		this.lastAvailableScreenIDs = currentScreenIds;
		if (previousScreenIds.length === 0) {
			return;
		}
		const disconnected = previousScreenIds.filter((id) => !currentScreenIds.includes(id));
		if (disconnected.length > 0) {
			this.log.warn(`[CAPTURE] screen sources disconnected: ${disconnected.join(', ')}`);
			this.notifyOnScreensDisconnectedListeners(disconnected);
		}
	}

	notifyOnScreensDisconnectedListeners(
		disconnectedScreensIDs: string[],
	): void {
		for (const listeners of this.onScreenDisconnectedListeners.values()) {
			for (const listener of listeners) {
				try {
					listener(disconnectedScreensIDs);
				} catch (error) {
					this.log.error('screen disconnected listener failed', error);
				}
			}
		}
	}
}

export default DesktopCapturerSourcesService;
