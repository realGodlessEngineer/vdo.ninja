import { DEFAULT_SPECTROGRAM_OPTIONS, pickSpectrogramColor } from "./spectrogram-palette.js?v=1";

export class SpectrogramRenderer {
	constructor(canvas, options = {}) {
		this.canvas = canvas;
		this.ctx = canvas?.getContext ? canvas.getContext("2d", { alpha: true }) : null;
		this.options = { ...DEFAULT_SPECTROGRAM_OPTIONS, ...options };
		this.pixelStepBase = Math.max(1, this.options.pixelStep);
		this.frameInterval = this.options.fps > 0 ? 1000 / this.options.fps : 0;
		this.lastFrame = 0;
		this.animationFrame = null;
		this.resizeObserver = null;
		this.resizeListener = null;
		this.columnBuffer = null;
		this.analyser = null;
		this.frequencyData = null;
		this.width = 0;
		this.height = 0;
		this.pixelStep = this.pixelStepBase;
		this.noiseFloor = Math.max(0, this.options.noiseFloor);
		this.gamma = Math.max(0.25, Math.min(1.5, this.options.gamma));
		this.frequencyExponent = Math.max(0.4, Math.min(2.4, this.options.frequencyExponent));
		this.lowFrequencyCutoff = Math.min(0.9, Math.max(0.05, this.options.lowFrequencyCutoff || 0.3));
		this.lowFrequencyGain = Math.max(1, this.options.lowFrequencyGain || 1.2);
		this.lowFrequencySpread = Math.max(1, Math.round(this.options.lowFrequencySpread || 2));
		this.baseFillStyle = "rgb(4, 5, 13)";
		this.boundResize = () => this.handleResize();
		this.renderLoop = timestamp => this.tick(timestamp);
		if (this.ctx && this.canvas) {
			this.ctx.imageSmoothingEnabled = false;
			this.observeResize();
			this.handleResize();
		}
	}

	observeResize() {
		if (!this.canvas) {
			return;
		}
		if (typeof ResizeObserver === "function") {
			this.resizeObserver = new ResizeObserver(this.boundResize);
			this.resizeObserver.observe(this.canvas);
		} else {
			this.resizeListener = this.boundResize;
			window.addEventListener("resize", this.resizeListener);
		}
	}

	handleResize() {
		if (!this.canvas || !this.ctx) {
			return;
		}
		const rect = this.canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const nextWidth = Math.max(10, Math.floor(rect.width * dpr) || 10);
		const nextHeight = Math.max(10, Math.floor(rect.height * dpr) || 10);
		if (nextWidth === this.width && nextHeight === this.height) {
			return;
		}
		this.width = nextWidth;
		this.height = nextHeight;
		this.pixelStep = Math.max(1, Math.round(this.pixelStepBase * dpr));
		this.canvas.width = nextWidth;
		this.canvas.height = nextHeight;
		this.columnBuffer = this.ctx.createImageData(this.pixelStep, this.height);
		this.ctx.fillStyle = this.baseFillStyle;
		this.ctx.fillRect(0, 0, this.width, this.height);
	}

	ensureColumnBuffer() {
		if (!this.ctx) {
			return null;
		}
		if (!this.columnBuffer || this.columnBuffer.height !== this.height || this.columnBuffer.width !== this.pixelStep) {
			this.columnBuffer = this.ctx.createImageData(this.pixelStep, this.height);
		}
		return this.columnBuffer;
	}

	normalizeMagnitude(rawValue) {
		if (!Number.isFinite(rawValue)) {
			return 0;
		}
		const adjusted = Math.max(0, rawValue - this.noiseFloor);
		const normalized = Math.min(1, adjusted / (255 - this.noiseFloor));
		return Math.pow(normalized, this.gamma);
	}

	setAnalyser(analyser) {
		if (this.analyser === analyser) {
			return;
		}
		this.analyser = analyser || null;
		this.frequencyData = this.analyser ? new Uint8Array(this.analyser.frequencyBinCount) : null;
		if (this.analyser) {
			this.startLoop();
		} else {
			this.stopLoop();
		}
	}

	startLoop() {
		if (this.animationFrame || !this.analyser) {
			return;
		}
		this.lastFrame = 0;
		this.animationFrame = requestAnimationFrame(this.renderLoop);
	}

	stopLoop() {
		if (this.animationFrame) {
			cancelAnimationFrame(this.animationFrame);
			this.animationFrame = null;
		}
	}

	tick(timestamp) {
		if (!this.analyser || !this.frequencyData || !this.ctx || !this.canvas) {
			this.stopLoop();
			return;
		}
		if (this.frameInterval && timestamp - this.lastFrame < this.frameInterval) {
			this.animationFrame = requestAnimationFrame(this.renderLoop);
			return;
		}
		this.lastFrame = timestamp;
		this.drawColumn();
		this.animationFrame = requestAnimationFrame(this.renderLoop);
	}

	drawColumn() {
		if (!this.analyser || !this.frequencyData || !this.ctx) {
			return;
		}
		try {
			this.analyser.getByteFrequencyData(this.frequencyData);
		} catch (error) {
			console.warn("Spectrogram analyser unavailable", error);
			this.frequencyData = null;
			return;
		}
		const width = this.canvas.width;
		const height = this.canvas.height;
		const shift = Math.min(this.pixelStep, Math.max(1, width - 1));
		if (!width || !height || !shift) {
			return;
		}
		this.ctx.drawImage(this.canvas, shift, 0, width - shift, height, 0, 0, width - shift, height);
		const fadeStrength = Math.max(0, Math.min(1, this.options.decay));
		if (fadeStrength > 0 && width - shift > 0) {
			this.ctx.save();
			this.ctx.globalAlpha = fadeStrength;
			this.ctx.fillStyle = this.baseFillStyle;
			this.ctx.fillRect(0, 0, width - shift, height);
			this.ctx.restore();
		}
		// clear the area reserved for the new samples
		this.ctx.fillStyle = this.baseFillStyle;
		this.ctx.fillRect(width - shift, 0, shift, height);
		const column = this.ensureColumnBuffer();
		if (!column) {
			return;
		}
		const bins = this.frequencyData.length;
		for (let y = 0; y < height; y += 1) {
			const ratio = 1 - y / height;
			const curved = Math.pow(ratio, this.frequencyExponent); // slower exponent keeps low freqs visible
			const baseIndex = Math.max(0, Math.min(bins - 1, Math.floor(curved * (bins - 1))));
			let accumulator = 0;
			let samples = 0;
			const isLowBand = curved <= this.lowFrequencyCutoff;
			const spread = isLowBand ? this.lowFrequencySpread : 1;
			for (let i = 0; i < spread; i += 1) {
				const idx = Math.min(bins - 1, baseIndex + i);
				accumulator += this.frequencyData[idx];
				samples += 1;
			}
			let magnitude = this.normalizeMagnitude(accumulator / Math.max(1, samples));
			if (isLowBand) {
				magnitude = Math.min(1, magnitude * this.lowFrequencyGain);
			}
			const [r, g, b] = pickSpectrogramColor(magnitude);
			const alpha = Math.round(35 + magnitude * 220);
			for (let x = 0; x < shift; x += 1) {
				const offset = (y * shift + x) * 4;
				column.data[offset] = r;
				column.data[offset + 1] = g;
				column.data[offset + 2] = b;
				column.data[offset + 3] = alpha;
			}
		}
		this.ctx.putImageData(column, width - shift, 0);
	}

	destroy() {
		this.stopLoop();
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeListener) {
			window.removeEventListener("resize", this.resizeListener);
			this.resizeListener = null;
		}
		this.analyser = null;
		this.frequencyData = null;
		if (this.ctx && this.canvas) {
			this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		}
	}
}
