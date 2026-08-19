import { createElement } from "./dom-helpers.js?v=1";
import { IcecastPublisher, ICECAST_MIME_OPTIONS } from "./icecast-publisher.js?v=2";
import { readIcecastSettings, writeIcecastSettings, resolveIcecastRelayUrl, resolveIcecastRelayToken, DEFAULT_ICECAST_MIME_TYPE } from "./icecast-settings-store.js?v=1";

// Icecast publishing controller for the podcast studio: owns the settings row/panel
// UI, the IcecastPublisher instance, and the live/busy state machine that starts and
// stops publishing the mixed studio audio. The host wires in the AudioContext, the mix
// participant source, the file-size/duration formatters, and a readiness callback, then
// builds the controls into its isolated-config list and drives updateUI()/dispose().
export class IcecastController {
	constructor({ getAudioContext = () => null, ensureAudioContextResumed = async () => {}, getMixParticipants = () => [], formatFileSize = () => "", formatDuration = () => "", onReadinessChange = () => {} } = {}) {
		this.getAudioContext = getAudioContext;
		this.ensureAudioContextResumed = ensureAudioContextResumed;
		this.getMixParticipants = getMixParticipants;
		this.formatFileSize = formatFileSize;
		this.formatDuration = formatDuration;
		this.onReadinessChange = onReadinessChange;

		this.button = null;
		this.settingsButton = null;
		this.settingsPanel = null;
		this.statusNode = null;
		this.targetInput = null;
		this.usernameInput = null;
		this.passwordInput = null;
		this.mimeSelect = null;
		this.publicInput = null;
		this.nameInput = null;
		this.genreInput = null;
		this.live = false;
		this.busy = false;
		this.settingsOpen = false;

		this.publisher = new IcecastPublisher({
			audioContext: this.getAudioContext(),
			getParticipants: () => this.getMixParticipants()
		});
		this.attachEvents();
	}

	attachEvents() {
		if (!this.publisher) {
			return;
		}
		this.publisher.addEventListener("status", event => {
			const detail = event.detail || {};
			const state = detail.state === "live" ? "ready" : detail.state === "connecting" ? "pending" : detail.state || "idle";
			this.live = state === "ready" || state === "pending";
			this.setStatus(detail.message || "Icecast idle.", state);
			this.updateUI();
			this.onReadinessChange();
		});
		this.publisher.addEventListener("progress", event => {
			const detail = event.detail || {};
			if (!this.publisher?.isLive()) {
				return;
			}
			const elapsedSeconds = detail.startedAt ? Math.max(1, Math.round((Date.now() - detail.startedAt) / 1000)) : 0;
			const bytes = detail.bytesSent || 0;
			this.setStatus(`Live ${this.formatFileSize(bytes)}${elapsedSeconds ? ` / ${this.formatDuration(elapsedSeconds)}` : ""}`, "ready");
		});
		this.publisher.addEventListener("error", event => {
			const error = event.detail;
			this.live = false;
			this.setStatus(error?.message || "Icecast publish failed.", "error");
			this.updateUI();
			this.onReadinessChange();
		});
	}

	collectSettingsFromForm() {
		const targetUrl = (this.targetInput?.value || "").trim();
		const username = (this.usernameInput?.value || "source").trim() || "source";
		const password = this.passwordInput?.value || "";
		const mimeType = this.mimeSelect?.value || ICECAST_MIME_OPTIONS[0].value;
		const isPublic = Boolean(this.publicInput?.checked);
		const name = (this.nameInput?.value || "").trim();
		const genre = (this.genreInput?.value || "").trim();
		return {
			targetUrl,
			username,
			password,
			mimeType,
			public: isPublic,
			name,
			genre
		};
	}

	persistSettingsFromForm() {
		writeIcecastSettings(this.collectSettingsFromForm());
	}

	readConfigFromForm() {
		const storedSettings = this.collectSettingsFromForm();
		const relayUrl = resolveIcecastRelayUrl(storedSettings);
		const relayToken = resolveIcecastRelayToken();
		writeIcecastSettings(storedSettings);
		return {
			relayUrl,
			targetUrl: storedSettings.targetUrl,
			username: storedSettings.username,
			password: storedSettings.password,
			relayToken,
			mimeType: storedSettings.mimeType,
			metadata: {
				name: storedSettings.name || "VDO.Ninja Live",
				genre: storedSettings.genre || "Live",
				public: storedSettings.public
			}
		};
	}

	setStatus(message, state = "idle") {
		if (!this.statusNode) {
			return;
		}
		this.statusNode.textContent = message || "Idle";
		this.statusNode.dataset.state = state;
	}

	updateUI() {
		const live = Boolean(this.publisher?.isLive());
		this.live = live;
		if (this.button) {
			this.button.disabled = this.busy;
			this.button.textContent = live ? "Stop live" : this.busy ? "Starting..." : "Start live";
			this.button.dataset.state = live ? "enabled" : "idle";
		}
		if (this.settingsButton) {
			this.settingsButton.disabled = live || this.busy;
			this.settingsButton.textContent = this.settingsOpen ? "Hide settings" : "Settings";
			this.settingsButton.setAttribute("aria-expanded", this.settingsOpen ? "true" : "false");
		}
		if (this.settingsPanel) {
			this.settingsPanel.hidden = !this.settingsOpen;
		}
		[this.targetInput, this.usernameInput, this.passwordInput, this.mimeSelect, this.publicInput, this.nameInput, this.genreInput].forEach(node => {
			if (node) {
				node.disabled = live || this.busy;
			}
		});
	}

	toggleSettings() {
		if (this.publisher?.isLive() || this.busy) {
			return;
		}
		this.settingsOpen = !this.settingsOpen;
		this.updateUI();
	}

	async handleToggle() {
		if (!this.publisher || this.busy) {
			return;
		}
		if (this.publisher.isLive()) {
			this.busy = true;
			this.updateUI();
			this.setStatus("Stopping...", "pending");
			try {
				await this.publisher.stop();
			} catch (error) {
				console.warn("Failed to stop Icecast publisher", error);
				this.setStatus(error?.message || "Stop failed.", "error");
			} finally {
				this.busy = false;
				this.live = false;
				this.updateUI();
				this.onReadinessChange();
			}
			return;
		}
		this.busy = true;
		this.updateUI();
		this.setStatus("Starting...", "pending");
		try {
			await this.ensureAudioContextResumed();
			this.publisher.setAudioContext(this.getAudioContext());
			const config = this.readConfigFromForm();
			await this.publisher.start(config);
			this.live = true;
		} catch (error) {
			console.error("Failed to start Icecast publisher", error);
			this.live = false;
			this.setStatus(error?.message || "Unable to start.", "error");
		} finally {
			this.busy = false;
			this.updateUI();
			this.onReadinessChange();
		}
	}

	buildControls(isoConfigList) {
		const icecastSettings = readIcecastSettings();
		const icecastRow = createElement("div", "iso-config-row iso-config-row--icecast");
		icecastRow.append(createElement("div", "iso-config-row__label", { text: "Icecast" }));
		const icecastActions = createElement("div", "iso-config-row__actions");
		this.button = createElement("button", "iso-config-row__button", {
			type: "button",
			text: "Start live",
			title: "Publish the mixed studio audio to an Icecast-compatible source endpoint."
		});
		this.button.addEventListener("click", () => this.handleToggle());
		this.settingsButton = createElement("button", "iso-config-row__button iso-config-row__button--secondary", {
			type: "button",
			text: "Settings",
			title: "Show Icecast publishing settings.",
			"aria-expanded": "false"
		});
		this.settingsButton.addEventListener("click", () => this.toggleSettings());
		this.statusNode = createElement("span", "iso-config-row__status", { text: "Idle" });
		this.statusNode.dataset.state = "idle";
		icecastActions.append(this.button, this.settingsButton, this.statusNode);
		icecastRow.append(icecastActions);
		isoConfigList.append(icecastRow);

		this.settingsOpen = false;
		const icecastPanel = createElement("div", "iso-config-advanced icecast-config");
		icecastPanel.hidden = true;
		this.settingsPanel = icecastPanel;
		const icecastBody = createElement("div", "iso-config-advanced__body icecast-config__body");
		const createIcecastField = (labelText, input, hintText = "") => {
			const label = createElement("label", "icecast-config__field");
			label.append(createElement("span", "icecast-config__label", { text: labelText }), input);
			if (hintText) {
				label.append(createElement("span", "icecast-config__hint", { text: hintText }));
			}
			return label;
		};
		this.targetInput = createElement("input", "icecast-config__input", {
			type: "url",
			placeholder: "https://radio.example.com/radio/8000/",
			value: icecastSettings.targetUrl || "",
			autocomplete: "off",
			spellcheck: "false",
			title: "Icecast or AzuraCast source ingest URL, not the public listener URL."
		});
		this.usernameInput = createElement("input", "icecast-config__input", {
			type: "text",
			placeholder: "source",
			value: icecastSettings.username || "source",
			autocomplete: "username",
			spellcheck: "false",
			title: "Icecast source username."
		});
		this.passwordInput = createElement("input", "icecast-config__input", {
			type: "password",
			placeholder: "Source password",
			value: icecastSettings.password || "",
			autocomplete: "off",
			autocapitalize: "none",
			spellcheck: "false",
			title: "Icecast source password. Stored locally in this browser with the Icecast settings."
		});
		this.mimeSelect = createElement("select", "icecast-config__input icecast-config__select", {
			title: "Audio container sent to Icecast."
		});
		ICECAST_MIME_OPTIONS.forEach(option => {
			this.mimeSelect.append(new Option(option.label, option.value));
		});
		this.mimeSelect.value = ICECAST_MIME_OPTIONS.some(option => option.value === icecastSettings.mimeType) ? icecastSettings.mimeType : DEFAULT_ICECAST_MIME_TYPE;
		this.nameInput = createElement("input", "icecast-config__input", {
			type: "text",
			placeholder: "VDO.Ninja Live",
			value: icecastSettings.name || "",
			autocomplete: "off",
			title: "Optional stream name shown by Icecast."
		});
		this.genreInput = createElement("input", "icecast-config__input", {
			type: "text",
			placeholder: "Live",
			value: icecastSettings.genre || "",
			autocomplete: "off",
			title: "Optional stream genre shown by Icecast."
		});
		const icecastToggles = createElement("div", "icecast-config__toggles");
		const publicLabel = createElement("label", "icecast-config__toggle");
		this.publicInput = createElement("input", "", { type: "checkbox" });
		this.publicInput.checked = Boolean(icecastSettings.public);
		publicLabel.append(this.publicInput, createElement("span", "", { text: "Public listing" }));
		icecastToggles.append(publicLabel);

		icecastBody.append(createIcecastField("Source URL", this.targetInput, "Recommended: allow VDO.Ninja in the Icecast/AzuraCast CORS settings for the best direct publishing path."), createIcecastField("Username", this.usernameInput), createIcecastField("Password", this.passwordInput), createIcecastField("Format", this.mimeSelect), createIcecastField("Name", this.nameInput), createIcecastField("Genre", this.genreInput), icecastToggles);
		[this.targetInput, this.usernameInput, this.passwordInput, this.mimeSelect, this.publicInput, this.nameInput, this.genreInput].forEach(node => {
			node.addEventListener("input", () => this.persistSettingsFromForm());
			node.addEventListener("change", () => this.persistSettingsFromForm());
		});
		icecastPanel.append(icecastBody);
		isoConfigList.append(icecastPanel);
	}

	refreshSourcesIfLive() {
		if (this.publisher?.isLive()) {
			this.publisher.refreshSources();
		}
	}

	isLive() {
		return Boolean(this.publisher?.isLive());
	}

	dispose() {
		if (this.publisher?.isLive()) {
			this.publisher.stop({ quiet: true }).catch(error => {
				console.warn("Failed to stop Icecast publisher during dispose", error);
			});
		}
	}
}
