import { RECEIVER_QUALITY_BUFFER_DELAY_MS } from '../constants/castReliabilityConstants';

type MonoGraphNodes = {
	splitter: ChannelSplitterNode;
	monoMix: GainNode;
	merger: ChannelMergerNode;
};

export type ReceiverAudioPipelineOptions = {
	monoEnabled: boolean;
	bufferEnabled: boolean;
	bufferDelayMs?: number;
};

/**
 * Routes receiver <video> audio through Web Audio for mono downmix and/or
 * quality-buffer delay so audio stays aligned with the video jitter target.
 */
export class ReceiverAudioPipelineController {
	private audioContext: AudioContext | null = null;

	private source: MediaElementAudioSourceNode | null = null;

	private monoGraph: MonoGraphNodes | null = null;

	private delayNode: DelayNode | null = null;

	private outputGain: GainNode | null = null;

	private videoElement: HTMLVideoElement | null = null;

	private isMonoEnabled = false;

	private isBufferEnabled = false;

	private playoutHoldSilence = false;

	private bufferDelaySeconds = RECEIVER_QUALITY_BUFFER_DELAY_MS / 1000;

	attach(video: HTMLVideoElement, options: ReceiverAudioPipelineOptions): void {
		if (this.videoElement && this.videoElement !== video) {
			this.release();
		}
		this.videoElement = video;
		this.isMonoEnabled = options.monoEnabled;
		this.isBufferEnabled = options.bufferEnabled;
		if (options.bufferDelayMs !== undefined) {
			this.bufferDelaySeconds = options.bufferDelayMs / 1000;
		}
		if (!this.needsWebAudio() && !this.source) {
			return;
		}
		this.ensureContext();
		this.ensureSource();
		this.applyRouting();
	}

	async setMonoEnabled(enabled: boolean): Promise<void> {
		this.isMonoEnabled = enabled;
		if (!this.needsWebAudio() && !this.source) {
			return;
		}
		if (!this.videoElement) {
			return;
		}
		await this.ensureContextRunning();
		this.ensureSource();
		this.applyRouting();
	}

	async setBufferEnabled(
		enabled: boolean,
		bufferDelayMs = RECEIVER_QUALITY_BUFFER_DELAY_MS,
	): Promise<void> {
		this.isBufferEnabled = enabled;
		this.bufferDelaySeconds = bufferDelayMs / 1000;
		if (!this.needsWebAudio() && !this.source) {
			return;
		}
		if (!this.videoElement) {
			return;
		}
		await this.ensureContextRunning();
		this.ensureSource();
		this.applyRouting();
	}

	setPlayoutHoldSilence(hold: boolean): void {
		this.playoutHoldSilence = hold;
		if (this.outputGain) {
			this.outputGain.gain.value = hold ? 0 : 1;
		}
	}

	release(): void {
		this.disconnectSource();
		this.monoGraph = null;
		this.delayNode = null;
		this.source = null;
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
		}
		this.videoElement = null;
		this.isMonoEnabled = false;
		this.isBufferEnabled = false;
		this.playoutHoldSilence = false;
		this.outputGain = null;
	}

	private needsWebAudio(): boolean {
		return this.isMonoEnabled || this.isBufferEnabled;
	}

	private ensureContext(): void {
		if (this.audioContext) {
			return;
		}
		const AudioContextCtor =
			window.AudioContext ||
			(window as Window & { webkitAudioContext?: typeof AudioContext })
				.webkitAudioContext;
		if (!AudioContextCtor) {
			console.warn('Web Audio API is unavailable');
			return;
		}
		this.audioContext = new AudioContextCtor();
	}

	private async ensureContextRunning(): Promise<void> {
		this.ensureContext();
		if (this.audioContext?.state === 'suspended') {
			await this.audioContext.resume();
		}
	}

	private ensureSource(): void {
		if (this.source || !this.audioContext || !this.videoElement) {
			return;
		}
		try {
			this.source = this.audioContext.createMediaElementSource(
				this.videoElement,
			);
		} catch (error) {
			console.warn('Unable to create MediaElementSource for audio pipeline', error);
		}
	}

	private ensureMonoGraph(): MonoGraphNodes {
		if (this.monoGraph) {
			return this.monoGraph;
		}
		if (!this.audioContext) {
			throw new Error('AudioContext is not initialized');
		}
		const splitter = this.audioContext.createChannelSplitter(2);
		const monoMix = this.audioContext.createGain();
		monoMix.gain.value = 0.5;
		const merger = this.audioContext.createChannelMerger(2);

		splitter.connect(monoMix, 0);
		splitter.connect(monoMix, 1);
		monoMix.connect(merger, 0, 0);
		monoMix.connect(merger, 0, 1);

		this.monoGraph = { splitter, monoMix, merger };
		return this.monoGraph;
	}

	private ensureOutputGain(): GainNode {
		if (!this.audioContext) {
			throw new Error('AudioContext is not initialized');
		}
		if (!this.outputGain) {
			this.outputGain = this.audioContext.createGain();
			this.outputGain.gain.value = this.playoutHoldSilence ? 0 : 1;
		}
		return this.outputGain;
	}

	private ensureDelayNode(): DelayNode {
		if (!this.audioContext) {
			throw new Error('AudioContext is not initialized');
		}
		if (!this.delayNode) {
			this.delayNode = this.audioContext.createDelay(12);
		}
		this.delayNode.delayTime.value = this.isBufferEnabled
			? this.bufferDelaySeconds
			: 0;
		return this.delayNode;
	}

	private disconnectSource(): void {
		if (!this.source) {
			return;
		}
		try {
			this.source.disconnect();
		} catch {
			// already disconnected
		}
		if (this.monoGraph) {
			try {
				this.monoGraph.splitter.disconnect();
				this.monoGraph.monoMix.disconnect();
				this.monoGraph.merger.disconnect();
			} catch {
				// ignore
			}
		}
		if (this.delayNode) {
			try {
				this.delayNode.disconnect();
			} catch {
				// ignore
			}
		}
		if (this.outputGain) {
			try {
				this.outputGain.disconnect();
			} catch {
				// ignore
			}
		}
	}

	private applyRouting(): void {
		if (!this.source || !this.audioContext) {
			return;
		}
		this.disconnectSource();

		let outputNode: AudioNode = this.source;
		if (this.isMonoEnabled) {
			const graph = this.ensureMonoGraph();
			this.source.connect(graph.splitter);
			outputNode = graph.merger;
		}

		const destinationGain = this.ensureOutputGain();

		if (this.isBufferEnabled) {
			const delay = this.ensureDelayNode();
			outputNode.connect(delay);
			delay.connect(destinationGain);
			destinationGain.connect(this.audioContext.destination);
			return;
		}

		outputNode.connect(destinationGain);
		destinationGain.connect(this.audioContext.destination);
	}
}
