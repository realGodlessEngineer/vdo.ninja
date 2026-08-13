const SPECTROGRAM_GRADIENT = [
	{ stop: 0, color: [4, 5, 13] }, // floor
	{ stop: 0.25, color: [24, 60, 140] },
	{ stop: 0.45, color: [47, 231, 163] }, // studio green accent
	{ stop: 0.7, color: [255, 153, 68] }, // warning orange
	{ stop: 1, color: [255, 255, 255] }
];

export const DEFAULT_SPECTROGRAM_OPTIONS = {
	fps: 24,
	pixelStep: 1,
	decay: 0.008,
	noiseFloor: 2,
	gamma: 0.65,
	frequencyExponent: 0.95,
	lowFrequencyCutoff: 0.55,
	lowFrequencyGain: 1.1,
	lowFrequencySpread: 2
};

function lerpColorChannel(start, end, ratio) {
	return Math.round(start + (end - start) * ratio);
}

export function pickSpectrogramColor(value) {
	const clamped = Math.min(1, Math.max(0, value));
	for (let i = 1; i < SPECTROGRAM_GRADIENT.length; i += 1) {
		const prev = SPECTROGRAM_GRADIENT[i - 1];
		const next = SPECTROGRAM_GRADIENT[i];
		if (clamped <= next.stop) {
			const span = next.stop - prev.stop || 1;
			const ratio = (clamped - prev.stop) / span;
			return [lerpColorChannel(prev.color[0], next.color[0], ratio), lerpColorChannel(prev.color[1], next.color[1], ratio), lerpColorChannel(prev.color[2], next.color[2], ratio)];
		}
	}
	const fallback = SPECTROGRAM_GRADIENT[SPECTROGRAM_GRADIENT.length - 1];
	return [...fallback.color];
}
