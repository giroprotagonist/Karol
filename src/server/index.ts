/*
 * original JS code from darkwire.io
 * translated to typescript for Deskreen app
 * by Pavlo (Paul) Buidenkov
 * */

import http from 'http';
import Koa from 'koa';
import crypto from 'crypto';
import { Server } from 'socket.io';
import cors from 'kcors';
import Router from 'koa-router';
import koaStatic from 'koa-static';
import koaSend from 'koa-send';
import detectPort from 'detect-port';
import config from '../common/config';
import startPollForInactiveRooms from './startPollForInactiveRooms';
import Logger from '../main/utils/LoggerWithFilePrefix';
import SocketsIPService from './socketsIPService';
import socketIOServerStore from './store/socketIOServerStore';
import DarkwireSocket from './darkwireSocket';
import getStore from './store';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';
import getMyLocalIpV4 from '../main/helpers/getMyLocalIpV4';
import { getClientViewerDistPath } from './getClientViewerDistPath';
import { getDjControllerDistPath } from './getDjControllerDistPath';
import getScreenCapturePermissionStatus from '../main/utils/getScreenCapturePermissionStatus';
import SharingSessionStatusEnum from '../features/SharingSessionService/SharingSessionStatusEnum';
import { registerYouTubeKaraokeApi } from './youtubeKaraokeApi';
import { registerVlcControllerApi } from './vlcControllerApi';
import bodyParser from 'koa-bodyparser';
import path from 'path';
import fs from 'fs';

const { hostname, primaryPort, backupPort } = config;

const getRoomIdHash = (id: string): string => {
	return crypto.createHash('sha256').update(id).digest('hex');
};

const ioHandleOnConnection = (socket): void => {
	const { roomId } = socket.handshake.query;
	const store = getStore();

	setTimeout(async () => {
		if (!getDeskreenGlobal().roomIDService.isRoomIDTaken(roomId)) {
			socket.emit('NOT_ALLOWED');
			setTimeout(() => {
				socket.disconnect(true);
			}, 1000);
			return;
		}
		const roomIdHash = getRoomIdHash(roomId);

		const storedRoom = await store.get('rooms', roomIdHash);
		const parsedRoom =
			typeof storedRoom === 'string' ? JSON.parse(storedRoom) : {};

		new DarkwireSocket({
			roomIdOriginal: roomId,
			roomId: roomIdHash,
			socket,
			room: parsedRoom as Room,
		});
		// }
	}, 500); // timeout 500 millisecond for throttling malicious connections
};

function setStaticFileHeaders(
	ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext>,
): void {
	ctx.set({
		'strict-transport-security': 'max-age=31536000',
		'X-Frame-Options': 'deny',
		'X-XSS-Protection': '1; mode=block',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Feature-Policy':
			"geolocation 'none'; vr 'none'; payment 'none'; microphone 'none'",
		'Cache-Control': 'no-store, no-cache, must-revalidate',
	});
}

class DeskreenSignalingServer {
	log = new Logger(__filename);

	server = {} as unknown as http.Server;

	hostname: string;

	primaryPort: number;

	backupPort: number;

	port: number;

	app: Koa | undefined;

	clientDistDirectory: string;

	constructor() {
		const localIp = getMyLocalIpV4();
		this.hostname = localIp || String(hostname);
		this.primaryPort = parseInt(primaryPort as unknown as string, 10);
		this.backupPort = parseInt(backupPort as unknown as string, 10);

		this.port = this.primaryPort;
		this.clientDistDirectory = getClientViewerDistPath();

		if (!this.clientDistDirectory) {
			this.log.error(
				'Client viewer bundle is missing. Remote connections will fail.',
			);
		}

		this.init();
	}

	init(): void {
		this.app = new Koa();
		const router = new Router();

		this.app.use(cors());
		this.app.use(bodyParser());
		router.get('/api/discover.json', (ctx) => {
			const deskreenGlobal = getDeskreenGlobal();
			const roomId =
				deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession
					?.roomID ?? '';
			const ip = getMyLocalIpV4() || this.hostname;
			const shareBase = `http://${ip}:${this.port}/${roomId}`;
			const serverBase = `http://${ip}:${this.port}`;
			ctx.set('Access-Control-Allow-Origin', '*');
			ctx.type = 'application/json';
			ctx.body = {
				name: 'Deskreen CE',
				ready: roomId !== '',
				roomId,
				host: ip,
				port: this.port,
				shareUrl: roomId !== '' ? `${shareBase}?receiver=1` : null,
				djControllerUrl: `${serverBase}/dj-controller/`,
				youtubeDjHealthUrl: `${serverBase}/api/youtube-dj/health`,
			};
		});
		router.get('/api/health.json', (ctx) => {
			const deskreenGlobal = getDeskreenGlobal();
			const sharingSessions = [
				...deskreenGlobal.sharingSessionService.sharingSessions.values(),
			];
			const activeSharingCount = sharingSessions.filter(
				(session) => session.status === SharingSessionStatusEnum.SHARING,
			).length;
			ctx.set('Access-Control-Allow-Origin', '*');
			ctx.type = 'application/json';
			ctx.body = {
				captureActive:
					deskreenGlobal.desktopCapturerSourcesService.isCaptureSessionActive(),
				permission: getScreenCapturePermissionStatus(),
				sharingSessionCount: sharingSessions.length,
				activeSharingCount,
				ready:
					(deskreenGlobal.sharingSessionService
						.waitingForConnectionSharingSession?.roomID ?? '') !== '',
			};
		});
		registerYouTubeKaraokeApi(router);
		registerVlcControllerApi(router);

		// ── Karol-specific API routes are served by karol-api-server.js
		//     (managed by LaunchAgent: ~/Library/LaunchAgents/com.karol-api.plist)
		//     This includes /api/ableton/* and /api/vlc-dj/*.
		//     The TS Electron server only serves Deskreen discovery/health
		//     and the DJ controller + Ableton mixer SPAs.
		//     When Ableton Live is running, the JS server handles OSC bridging.
		// ── Proxy VLC/Ableton requests to the JS server if it's running ──
		router.all('/api/ableton/(.*)', async (ctx) => {
			// The karol-api-server.js handles these. If it's not running,
			// fall through to static serving.
			ctx.body = { ok: false, error: 'Karol API server not running', hint: 'Start karol-api-server.js via LaunchAgent' };
		});
		router.all('/api/vlc-dj/(.*)', async (ctx) => {
			ctx.body = { ok: false, error: 'Karol API server not running', hint: 'Start karol-api-server.js via LaunchAgent' };
		});

		this.app.use(router.routes());

	// ── Serve Ableton mixer SPA (iPhone landscape controller) ──
	const abletonMixerDir = path.resolve(__dirname, '..', '..', 'src', 'ableton-mixer');
	if (fs.existsSync(abletonMixerDir)) {
		this.app.use(async (ctx, next) => {
			if (!ctx.path.startsWith('/ableton-mixer')) return next();
			setStaticFileHeaders(ctx);
			const rel = ctx.path.slice('/ableton-mixer'.length).replace(/^\//, '') || 'index.html';
			const filePath = path.join(abletonMixerDir, rel);
			try {
				if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
					const ext = path.extname(filePath);
					ctx.type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css'
						: ext === '.js' ? 'application/javascript' : ext === '.svg' ? 'image/svg+xml'
						: ext === '.png' ? 'image/png' : 'application/octet-stream';
					ctx.body = fs.createReadStream(filePath);
					return;
				}
			} catch { /* fall through */ }
			ctx.type = 'text/html';
			ctx.body = fs.createReadStream(path.join(abletonMixerDir, 'index.html'));
		});
	}

	// ── Serve DJ Controller SPA ──
	const djControllerDistDirectory = getDjControllerDistPath();
	if (djControllerDistDirectory) {
			this.app.use(async (ctx, next) => {
				if (!ctx.path.startsWith('/dj-controller')) {
					return next();
				}
				setStaticFileHeaders(ctx);
				let relPath = ctx.path.slice('/dj-controller'.length).replace(/^\//, '');
				if (!relPath) {
					relPath = 'index.html';
				}
				try {
					await koaSend(ctx, relPath, { root: djControllerDistDirectory });
				} catch {
					await koaSend(ctx, 'index.html', { root: djControllerDistDirectory });
				}
			});
		}

		const clientDistDirectory = this.clientDistDirectory;

		if (clientDistDirectory) {
			this.app.use(async (ctx, next) => {
				setStaticFileHeaders(ctx);
				await koaStatic(clientDistDirectory)(ctx, next);
			});

			this.app.use(async (ctx) => {
				if (ctx.path.startsWith('/api/')) return;
				setStaticFileHeaders(ctx);
				await koaSend(ctx, 'index.html', { root: clientDistDirectory });
			});
		} else {
			this.app.use(async (ctx) => {
				ctx.body = { ready: true };
			});
		}

		const protocol = http;

		this.server = protocol.createServer(this.app.callback());
		const io = new Server(this.server, {
			pingInterval: 20000,
			pingTimeout: 5000,
			serveClient: false,
		});

		io.sockets.on('connection', (socket) => {
			const socketId = socket.id;

			const clientIp = socket.request.socket.remoteAddress;
			SocketsIPService.setIPOfSocketID(socketId, clientIp || '');
		});

		io.on('connection', (socket) => {
			ioHandleOnConnection(socket);
		});

		socketIOServerStore.setServer(io);
	}

	async start(): Promise<http.Server> {
		startPollForInactiveRooms();
		this.server = await this.callListenOnHttpServer();
		return this.server;
	}

	listenCallback() {
		return () => {
			this.log.info(
				`Deskreen CE signaling server is online at port ${this.port}`,
			);
			this.log.info(
				`🌐 Server available at http://${this.hostname}:${this.port}`,
			);
		};
	}

	async callListenOnHttpServer(): Promise<http.Server> {
		return new Promise<http.Server>((resolve, reject) => {
			const tryListen = (port: number): void => {
				// Remove any previous error listeners
				this.server.removeAllListeners('error');

				// Set up error handler
				this.server.once('error', async (error: NodeJS.ErrnoException) => {
					if (
						error.code === 'EADDRINUSE' &&
						(port === this.primaryPort || port === this.backupPort)
					) {
						// Primary port is already in use, try backup
						this.log.error(`Port ${port} is already in use`);
						this.log.warn(
							`Port ${primaryPort} is in use. Trying backup port ${backupPort}...`,
						);

						try {
							const detectedBackupPort = await detectPort(backupPort);

							if (backupPort === detectedBackupPort) {
								this.log.info(`Backup port ${backupPort} is available.`);
								this.port = backupPort;
								tryListen(backupPort);
							} else {
								const errorMsg = `Both primary port ${primaryPort} and backup port ${backupPort} are in use`;
								this.log.error(`Error: ${errorMsg}`);
								// reject(new Error(errorMsg));
								this.port = await detectPort();
								tryListen(this.port);
							}
						} catch (err) {
							this.log.error(
								'An unexpected error occurred while detecting ports:',
								err,
							);
							reject(err);
						}
					} else {
						// Some other error or backup port is also in use
						this.log.error(`Failed to start server on port ${port}:`, error);
						reject(error);
					}
				});

				// Attempt to listen on all interfaces (0.0.0.0) to allow both local and local network access
			this.server.listen(port, '0.0.0.0', () => {
				this.listenCallback()();
				resolve(this.server);
				});
			};

			// Start with the primary port
			tryListen(this.port);
		});
	}

	stop(): void {
		try {
			const io = socketIOServerStore.getServer();
			if (io && typeof io.disconnectSockets === 'function') {
				io.disconnectSockets(true);
			}
			if (io && typeof io.close === 'function') {
				io.close();
			}
		} catch (error) {
			this.log.error('Error closing Socket.IO server', error);
		}
		if (this.server && typeof this.server.close === 'function') {
			this.server.close();
		}
	}
}

export const signalingServer = new DeskreenSignalingServer();
