import { readCaptureMode, writeCaptureMode } from "./capture-mode-store.js?v=1";
import { createElement } from "./dom-helpers.js?v=1";

// Capture-mode controller for the podcast studio: owns the "Capture" label +
// mode select mounted in the transport-buttons row, the persisted recording
// mode it reflects, and the pure helpers that derive recorder options and a
// human-readable label from that mode. The host injects a single onModeChange
// seam, fired after a change is persisted and the select is synced back.
// buildControl() mounts the label+select pair, setRecording() disables the
// select mid-session, and dispose() drops the change listener and DOM ref.
export class CaptureModeController {
	constructor({ onModeChange = () => {} } = {}) {
		this.onModeChange = onModeChange;

		this.captureModeSelect = null;
		this.boundChangeHandler = null;
		this.currentRecordingMode = readCaptureMode();
	}

	buildControl() {
		const captureSelectId = "podcast-capture-mode";
		const captureModeLabel = createElement("label", "capture-mode-label", { text: "Capture" });
		captureModeLabel.setAttribute("for", captureSelectId);
		this.captureModeSelect = createElement("select", "capture-mode-select", { id: captureSelectId });
		this.captureModeSelect.append(new Option("Audio only", "audio"), new Option("Audio + Video", "video"));
		this.captureModeSelect.value = this.currentRecordingMode === "video" ? "video" : "audio";
		this.boundChangeHandler = () => this.handleCaptureModeChange(this.captureModeSelect.value);
		this.captureModeSelect.addEventListener("change", this.boundChangeHandler);
		const captureWrap = createElement("div", "capture-mode-wrap");
		captureWrap.append(captureModeLabel, this.captureModeSelect);
		return captureWrap;
	}

	getMode() {
		return this.currentRecordingMode;
	}

	getRecordingModeOptions(mode = this.currentRecordingMode) {
		const videoMode = mode === "video";
		return {
			includeVideo: videoMode,
			includeScreenshares: videoMode
		};
	}

	handleCaptureModeChange(mode) {
		const normalized = writeCaptureMode(mode);
		this.currentRecordingMode = normalized;
		if (this.captureModeSelect && this.captureModeSelect.value !== normalized) {
			this.captureModeSelect.value = normalized;
		}
		this.onModeChange();
	}

	describeCaptureMode(mode = this.currentRecordingMode) {
		return mode === "video" ? "Audio + Video ISO" : "Audio ISO";
	}

	setRecording(isRecording) {
		if (this.captureModeSelect) {
			this.captureModeSelect.disabled = isRecording;
		}
	}

	dispose() {
		if (this.captureModeSelect && this.boundChangeHandler) {
			this.captureModeSelect.removeEventListener("change", this.boundChangeHandler);
		}
		this.boundChangeHandler = null;
		this.captureModeSelect = null;
	}
}
