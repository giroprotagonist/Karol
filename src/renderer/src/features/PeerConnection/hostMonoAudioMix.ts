const mixerByStream = new WeakMap<MediaStream, HostMonoAudioMixer>();

/**
 * Downmixes captured stereo system audio to mono (L+R)/2 before WebRTC send.
 * Keeps video tracks unchanged; replaces the audio track in-place.
 *
 * The original capture track must stay alive (not stopped) while the Web Audio
 * graph runs — stopping it silences the MediaStreamAudioSourceNode input.
 */
export class HostMonoAudioMixer {
	private audioContext: AudioContext | null = null;

	private sourceNode: MediaStreamAudioSourceNode | null = null;

	private destinationNode: MediaStreamAudioDestinationNode | null = null;

	private mixedTrack: MediaStreamTrack | null = null;

	/** Live capture tracks kept alive to feed the Web Audio graph. */
	private captureTracks: MediaStreamTrack[] = [];

	async apply(stream: MediaStream): Promise<MediaStream> {
		const audioTracks = stream.getAudioTracks().filter(
			(track) => track.readyState === 'live',
		);
		if (audioTracks.length === 0) {
			return stream;
		}

		this.release();

		const originalTrack = audioTracks[0];
		const channelCount = originalTrack.getSettings().channelCount ?? 2;

		if (channelCount <= 1) {
			return stream;
		}

		const AudioContextCtor =
			window.AudioContext ||
			(window as Window & { webkitAudioContext?: typeof AudioContext })
				.webkitAudioContext;
		if (!AudioContextCtor) {
			console.warn('[HOST_MONO] Web Audio unavailable — sending stereo audio');
			return stream;
		}

		this.audioContext = new AudioContextCtor();
		this.captureTracks = [...audioTracks];
		this.sourceNode = this.audioContext.createMediaStreamSource(
			new MediaStream([originalTrack]),
		);
		this.destinationNode = this.audioContext.createMediaStreamDestination();

		this.connectDownmix(this.sourceNode, this.destinationNode);

		const monoTrack = this.destinationNode.stream.getAudioTracks()[0];
		if (!monoTrack) {
			console.warn('[HOST_MONO] failed to create mono audio track');
			this.release();
			return stream;
		}

		for (const track of audioTracks) {
			stream.removeTrack(track);
		}

		stream.addTrack(monoTrack);
		this.mixedTrack = monoTrack;
		monoTrack.addEventListener('ended', () => {
			this.release();
		});

		if (this.audioContext.state === 'suspended') {
			try {
				await this.audioContext.resume();
			} catch (error) {
				console.warn('[HOST_MONO] unable to resume AudioContext', error);
			}
		}

		return stream;
	}

	private connectDownmix(
		source: MediaStreamAudioSourceNode,
		destination: MediaStreamAudioDestinationNode,
	): void {
		if (!this.audioContext) {
			return;
		}

		// Same graph as receiverAudioPipeline: (L+R)/2 duplicated to L/R for
		// WebRTC compatibility (true 1-channel tracks are poorly supported).
		const splitter = this.audioContext.createChannelSplitter(2);
		const monoMix = this.audioContext.createGain();
		monoMix.gain.value = 0.5;
		const merger = this.audioContext.createChannelMerger(2);

		source.connect(splitter);
		splitter.connect(monoMix, 0);
		splitter.connect(monoMix, 1);
		monoMix.connect(merger, 0, 0);
		monoMix.connect(merger, 0, 1);
		merger.connect(destination);
	}

	release(): void {
		if (this.mixedTrack) {
			this.mixedTrack.onended = null;
			this.mixedTrack = null;
		}

		for (const track of this.captureTracks) {
			try {
				track.stop();
			} catch {
				// ignore
			}
		}
		this.captureTracks = [];

		try {
			this.sourceNode?.disconnect();
		} catch {
			// already disconnected
		}
		this.sourceNode = null;

		try {
			this.destinationNode?.disconnect();
		} catch {
			// already disconnected
		}
		this.destinationNode = null;

		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
		}
	}
}

export async function applyHostMonoAudioMix(
	stream: MediaStream,
): Promise<MediaStream> {
	const existing = mixerByStream.get(stream);
	existing?.release();

	const mixer = new HostMonoAudioMixer();
	const mixedStream = await mixer.apply(stream);
	mixerByStream.set(mixedStream, mixer);
	return mixedStream;
}

export function releaseHostMonoAudioMix(stream: MediaStream | null): void {
	if (!stream) {
		return;
	}
	mixerByStream.get(stream)?.release();
	mixerByStream.delete(stream);
}
