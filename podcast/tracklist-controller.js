import { createElement } from "./dom-helpers.js?v=1";
import { SpectrogramRenderer } from "./spectrogram-renderer.js?v=1";

// Tracklist controller for the podcast studio: owns the timeline/outputs surface —
// building and updating the per-track indicator card for each recording chunk,
// swapping the surface between its idle-message and recording-tracklist modes,
// mirroring per-track audio into spectrogram canvases, driving the waveform-level
// bars from the meter bus, and folding inbound-audio metrics (bitrate/codec)
// captured off the roster into each track's indicator. The host builds the
// outputsContainer node inline (in buildLayout()) and hands it over with
// bindNodes(); the recorder's per-track meter lookup and the app's bitrate
// formatter are injected as read-only seam callbacks. ensureOutputIndicator()/
// prepareTracklistSurface()/showOutputsMessage() drive the timeline surface;
// attachSpectrogram()/teardownSpectrograms() own the per-track spectrogram
// renderers; registerTrackLevelNode()/updateTrackLevelVisual() drive the waveform
// bars; captureParticipantMetrics()/updateTrackInboundMetric() keep the
// inbound-audio label current; getIndicator()/getIndicatorCount()/
// clearOutputIndicators()/clearTrackLevelNodes() bridge the retained recorder-event
// wiring on the host; dispose() tears down spectrograms and clears the Maps.
export class TracklistController {
	constructor({ getTrackMeter = () => null, formatBitrate = () => "" } = {}) {
		this.getTrackMeter = getTrackMeter;
		this.formatBitrate = formatBitrate;

		this.outputsContainer = null;
		this.outputIndicators = new Map();
		this.spectrograms = new Map();
		this.trackLevelNodes = new Map();
		this.participantMetrics = new Map();
	}

	bindNodes({ outputsContainer = null } = {}) {
		this.outputsContainer = outputsContainer;
	}

	ensureOutputIndicator(key, participant, trackType, channelIndex = 0) {
		if (!this.outputsContainer) {
			return null;
		}
		if (this.outputIndicators.has(key)) {
			return this.outputIndicators.get(key);
		}

		this.prepareTracklistSurface();

		if (!this.outputsContainer.dataset.hasTracks) {
			this.outputsContainer.innerHTML = "";
			this.outputsContainer.dataset.hasTracks = "true";
		}

		const wrapper = createElement("div", "timeline-track");
		wrapper.dataset.key = key;
		wrapper.dataset.trackType = trackType;
		wrapper.dataset.participant = participant.uuid || "";
		wrapper.dataset.state = "armed";

		const header = createElement("div", "timeline-track__header");
		const titleGroup = createElement("div", "timeline-track__title-group");
		const title = createElement("div", "timeline-track__title", { text: participant.label || participant.uuid || "Guest" });
		const descriptorParts = [];
		if (participant.external || participant.uuid === "host-mic") {
			descriptorParts.push("Local input");
		} else if (participant.streamID) {
			descriptorParts.push(`Stream ${participant.streamID}`);
		}
		descriptorParts.push(trackType ? trackType.toUpperCase() : "AUDIO");
		descriptorParts.push(`Channel ${channelIndex + 1}`);
		const subtitle = createElement("div", "timeline-track__subtitle", {
			text: descriptorParts.filter(Boolean).join(" • ")
		});
		titleGroup.append(title, subtitle);
		const badge = createElement("span", "timeline-track__badge", { text: "Arming" });
		header.append(titleGroup, badge);

		const metrics = createElement("div", "timeline-track__metrics");
		const inboundMetric = createElement("span", "timeline-track__metric timeline-track__metric--inbound", {
			text: trackType === "video" ? (participant.external || participant.uuid === "host-mic" ? "Inbound: Local capture" : "Inbound: Video track live") : participant.external || participant.uuid === "host-mic" ? "Inbound: Local capture" : "Inbound: pending…"
		});
		const recordMetric = createElement("span", "timeline-track__metric timeline-track__metric--recording", {
			text: trackType === "video" ? "Recording: waiting for video…" : "Recording: waiting…"
		});
		metrics.append(inboundMetric, recordMetric);

		const waveform = createElement("div", "timeline-track__waveform");
		const spectrogramCanvas = document.createElement("canvas");
		spectrogramCanvas.className = "timeline-track__spectrogram";
		const waveFill = createElement("div", "timeline-track__wavefill");
		waveform.append(spectrogramCanvas, waveFill);

		wrapper.append(header, metrics, waveform);
		this.outputsContainer.append(wrapper);

		const indicator = {
			key,
			wrapper,
			badge,
			inboundMetric,
			recordMetric,
			waveFill,
			spectrogramCanvas,
			participant,
			trackType,
			channelIndex
		};

		this.outputIndicators.set(key, indicator);
		this.registerTrackLevelNode(participant.uuid, waveFill);
		this.updateTrackInboundMetric(participant.uuid);
		this.attachSpectrogram(key, indicator, participant, trackType, channelIndex);
		return indicator;
	}

	showOutputsMessage(text) {
		if (!this.outputsContainer) {
			return;
		}
		this.outputsContainer.dataset.mode = "message";
		this.outputsContainer.dataset.hasTracks = "";
		this.outputsContainer.classList.remove("timeline-tracklist");
		this.outputsContainer.classList.remove("timeline-results");
		this.outputsContainer.innerHTML = "";
		if (typeof text === "string" && text.trim()) {
			this.outputsContainer.append(createElement("div", "timeline-placeholder", { text }));
		} else {
			this.outputsContainer.append(createElement("div", "timeline-placeholder", { text: "" }));
		}
	}

	prepareTracklistSurface({ reset = false } = {}) {
		if (!this.outputsContainer) {
			return;
		}
		const switchingMode = this.outputsContainer.dataset.mode !== "recording";
		if (switchingMode || reset) {
			this.outputsContainer.innerHTML = "";
			this.outputsContainer.dataset.hasTracks = "";
		}
		this.outputsContainer.dataset.mode = "recording";
		this.outputsContainer.classList.add("timeline-tracklist");
		this.outputsContainer.classList.remove("timeline-results");
	}

	buildTrackKey(uuid, trackType, channelIndex = 0) {
		if (!uuid || !trackType) {
			return "";
		}
		const index = typeof channelIndex === "number" ? channelIndex : 0;
		return `${uuid}-${trackType}-${index}`;
	}

	getMeterForTrack(uuid, trackType, channelIndex = 0) {
		return this.getTrackMeter(uuid, trackType, channelIndex);
	}

	attachSpectrogram(key, indicator, participant, trackType, channelIndex, meterOverride = null) {
		if (!key || trackType !== "audio" || !indicator?.spectrogramCanvas) {
			return;
		}
		let renderer = this.spectrograms.get(key);
		if (!renderer) {
			renderer = new SpectrogramRenderer(indicator.spectrogramCanvas);
			this.spectrograms.set(key, renderer);
		}
		if (!participant?.uuid) {
			return;
		}
		const meter = meterOverride || this.getMeterForTrack(participant.uuid, trackType, channelIndex);
		if (meter?.analyser) {
			renderer.setAnalyser(meter.analyser);
		}
	}

	teardownSpectrograms() {
		if (!this.spectrograms) {
			return;
		}
		this.spectrograms.forEach(renderer => {
			if (renderer && typeof renderer.destroy === "function") {
				renderer.destroy();
			}
		});
		this.spectrograms.clear();
	}

	registerTrackLevelNode(uuid, node) {
		if (!uuid || !node) {
			return;
		}
		if (!this.trackLevelNodes.has(uuid)) {
			this.trackLevelNodes.set(uuid, new Set());
		}
		this.trackLevelNodes.get(uuid).add(node);
	}

	updateTrackLevelVisual(uuid, level) {
		if (!uuid) {
			return;
		}
		const nodes = this.trackLevelNodes.get(uuid);
		if (!nodes || !nodes.size) {
			return;
		}
		const normalized = Math.max(0.08, Math.min(1, (level || 0) / 100));
		nodes.forEach(node => {
			if (!node) {
				return;
			}
			node.style.transform = `scaleY(${normalized})`;
			node.style.opacity = level > 3 ? "0.95" : "0.45";
		});
	}

	captureParticipantMetrics(participant) {
		if (!participant?.uuid) {
			return;
		}
		const next = { ...(this.participantMetrics.get(participant.uuid) || {}) };
		if (typeof participant.audioBitrateKbps === "number" && participant.audioBitrateKbps >= 0) {
			next.audioBitrateKbps = participant.audioBitrateKbps;
		}
		if (participant.audioCodec) {
			next.audioCodec = participant.audioCodec;
		}
		if (participant.external || participant.uuid === "host-mic") {
			next.local = true;
		}
		this.participantMetrics.set(participant.uuid, next);
		this.updateTrackInboundMetric(participant.uuid, next);
	}

	updateTrackInboundMetric(uuid, metrics = this.participantMetrics.get(uuid)) {
		if (!uuid) {
			return;
		}
		const resolvedMetrics = metrics || null;
		const indicators = this.outputIndicators || new Map();
		indicators.forEach(indicator => {
			if (!indicator || !indicator.participant || indicator.participant.uuid !== uuid) {
				return;
			}
			const node = indicator.inboundMetric;
			if (!node) {
				return;
			}
			if (resolvedMetrics?.local) {
				node.textContent = indicator.trackType === "video" ? "Inbound: Local video capture" : "Inbound: Local capture";
				return;
			}
			if (indicator.trackType === "video") {
				node.textContent = "Inbound: Video track live";
				return;
			}
			const parts = [];
			if (resolvedMetrics && typeof resolvedMetrics.audioBitrateKbps === "number" && resolvedMetrics.audioBitrateKbps > 0) {
				const formatted = this.formatBitrate(resolvedMetrics.audioBitrateKbps);
				if (formatted) {
					parts.push(formatted);
				}
			}
			if (resolvedMetrics?.audioCodec) {
				parts.push(resolvedMetrics.audioCodec.toUpperCase());
			}
			node.textContent = parts.length ? `Inbound: ${parts.join(" • ")}` : "Inbound: pending…";
		});
	}

	getIndicator(key) {
		return this.outputIndicators.get(key) || null;
	}

	getIndicatorCount() {
		return this.outputIndicators.size;
	}

	clearOutputIndicators() {
		this.outputIndicators.clear();
	}

	clearTrackLevelNodes() {
		this.trackLevelNodes.clear();
	}

	dispose() {
		this.teardownSpectrograms();
		this.outputIndicators.clear();
		this.trackLevelNodes.clear();
		this.participantMetrics.clear();
		this.outputsContainer = null;
	}
}
