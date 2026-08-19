import { createElement } from "./dom-helpers.js?v=1";
import { monitorTrackLevel } from "../core/index.js";

// Host-input microphone controller for the podcast studio: owns the "🎙️ Host Input"
// panel UI, the local getUserMedia capture, the busy/muted state machine, and the
// host-mic virtual-participant lifecycle. The host wires in the AudioContext, session
// label, the shared virtual-participants map, and roster/meter callbacks, then builds
// the panel via buildControls() and drives updateUI()/setError()/dispose().
export class HostMicController {
	constructor({ isRecording = () => false, getAudioContext = () => null, ensureAudioContextResumed = async () => {}, getSessionLabel = () => null, virtualParticipants = new Map(), onRosterChange = () => {}, applyMeterValue = () => {} } = {}) {
		this.isRecording = isRecording;
		this.getAudioContext = getAudioContext;
		this.ensureAudioContextResumed = ensureAudioContextResumed;
		this.getSessionLabel = getSessionLabel;
		this.virtualParticipants = virtualParticipants;
		this.onRosterChange = onRosterChange;
		this.applyMeterValue = applyMeterValue;

		this.mic = null;
		this.meter = null;
		this.toggleButton = null;
		this.muteButton = null;
		this.statusNode = null;
		this.errorNode = null;
		this.busy = false;
		this.muted = false;
	}

	buildControls() {
		const hostPanel = createElement("section", "podcast-panel host-panel");
		hostPanel.append(createElement("h2", "", { text: "🎙️ Host Input" }));
		const hostControls = createElement("div", "host-input-content");
		this.toggleButton = createElement("button", "host-input-toggle", { type: "button", text: "Enable", title: "Toggle local host microphone capture (optional)." });
		this.toggleButton.addEventListener("click", () => this.handleToggle());
		this.muteButton = createElement("button", "host-mute-toggle", { type: "button", text: "🔊 Mute", title: "Mute/unmute the host mic track." });
		this.muteButton.disabled = true;
		this.muteButton.addEventListener("click", () => this.handleMuteToggle());
		this.statusNode = createElement("div", "host-input-status", { text: "Idle" });
		hostControls.append(this.toggleButton, this.muteButton, this.statusNode);
		this.errorNode = createElement("div", "host-input-error");
		hostPanel.append(hostControls, this.errorNode);
		return hostPanel;
	}

	setError(message) {
		if (this.errorNode) {
			this.errorNode.textContent = message || "";
		}
	}

	updateUI() {
		if (this.toggleButton) {
			if (this.busy || this.isRecording()) {
				this.toggleButton.disabled = true;
				const busyLabel = this.mic?.active ? "Disabling…" : "Enabling…";
				this.toggleButton.textContent = this.isRecording() ? "Locked" : busyLabel;
			} else {
				this.toggleButton.disabled = false;
				this.toggleButton.textContent = this.mic?.active ? "Disable" : "Enable";
			}
			if (this.mic?.active) {
				this.toggleButton.classList.add("active");
			} else {
				this.toggleButton.classList.remove("active");
			}
		}
		if (this.statusNode) {
			if (this.mic?.active) {
				this.statusNode.textContent = "Live";
				this.statusNode.dataset.state = "active";
			} else {
				this.statusNode.textContent = "Idle";
				this.statusNode.dataset.state = "idle";
			}
		}
		this.updateMuteUI();
	}

	async handleToggle() {
		if (this.isRecording()) {
			this.setError("Stop the recording to change the host mic.");
			return;
		}
		if (this.busy) {
			return;
		}
		if (this.mic?.active) {
			await this.disable();
		} else {
			await this.enable();
		}
	}

	handleMuteToggle() {
		if (!this.mic?.active) {
			return;
		}
		this.muted = !this.muted;
		if (this.mic.track) {
			this.mic.track.enabled = !this.muted;
		}
		this.updateMuteUI();
	}

	updateMuteUI() {
		if (this.muteButton) {
			if (this.mic?.active) {
				this.muteButton.disabled = false;
				this.muteButton.textContent = this.muted ? "🔇 Unmute" : "🔊 Mute";
				this.muteButton.classList.toggle("muted", this.muted);
			} else {
				this.muteButton.disabled = true;
				this.muteButton.textContent = "🔊 Mute";
				this.muteButton.classList.remove("muted");
			}
		}
	}

	async enable() {
		if (this.mic?.active) {
			this.updateUI();
			return;
		}
		if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
			this.setError("Browser does not support microphone capture.");
			return;
		}
		this.busy = true;
		this.setError("");
		this.updateUI();
		try {
			await this.ensureAudioContextResumed();
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
			const [track] = stream.getAudioTracks();
			if (!track) {
				throw new Error("No audio track available.");
			}
			const sessionLabel = this.getSessionLabel();
			const label = sessionLabel ? `${sessionLabel} (Host)` : "Host Mic";
			const participant = {
				uuid: "host-mic",
				label,
				stream,
				streamID: "host-mic",
				status: "connected",
				audioLevel: 0,
				isLocal: true,
				kind: "local",
				role: "host-mic"
			};
			track.addEventListener("ended", () => {
				if (this.mic?.track === track) {
					this.disable();
				}
			});
			this.mic = {
				active: true,
				stream,
				track,
				uuid: participant.uuid,
				label: participant.label,
				streamID: participant.streamID,
				participant
			};
			this.virtualParticipants.set(participant.uuid, participant);
			const audioContext = this.getAudioContext();
			if (audioContext && track) {
				try {
					this.meter = await monitorTrackLevel(audioContext, track, {
						uuid: participant.uuid,
						trackType: "audio",
						metadata: { label: participant.label, source: "host" }
					});
				} catch (error) {
					console.warn("Failed to attach host mic meter", error);
				}
			}
			this.updateUI();
			this.onRosterChange();
		} catch (error) {
			console.error("Failed to enable host microphone", error);
			this.setError(error?.message || "Unable to access microphone.");
			if (this.mic?.stream) {
				try {
					this.mic.stream.getTracks().forEach(mediaTrack => mediaTrack.stop());
				} catch (stopError) {
					console.warn("Failed to stop host mic stream after error", stopError);
				}
			}
			this.mic = null;
			this.virtualParticipants.delete("host-mic");
			this.updateUI();
		} finally {
			this.busy = false;
			this.updateUI();
		}
	}

	async disable() {
		if (!this.mic?.active && !this.virtualParticipants.has("host-mic")) {
			this.mic = null;
			this.updateUI();
			return;
		}
		this.busy = true;
		this.updateUI();
		try {
			if (this.meter) {
				try {
					this.meter.disconnect({ stopTrack: false });
				} catch (error) {
					console.warn("Failed to disconnect host mic meter", error);
				}
				this.meter = null;
			}
			if (this.mic?.stream) {
				this.mic.stream.getTracks().forEach(track => {
					try {
						track.stop();
					} catch (error) {
						console.warn("Failed to stop host mic track", error);
					}
				});
			}
		} finally {
			this.virtualParticipants.delete("host-mic");
			this.mic = null;
			this.busy = false;
			this.muted = false;
			this.setError("");
			this.updateUI();
			this.applyMeterValue("host-mic", 0);
			this.onRosterChange();
		}
	}

	async dispose() {
		await this.disable();
	}
}
