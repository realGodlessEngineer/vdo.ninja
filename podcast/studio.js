import { waitForLegacySession, levelBus, LEVEL_EVENT, MultiTrackRecorder, CloudUploadCoordinator, bridgeLegacyMeters } from "../core/index.js";
import { readDiskRecordingState, verifyStoredDiskRecordingDirectory, readDiskDirectoryHandle } from "./disk-recording-store.js?v=1";
import { readCloudLinkStatus } from "./cloud-link-store.js?v=1";
import { readPreflightState, writePreflightState, isPreflightFresh } from "./preflight-store.js?v=1";
import { IcecastController } from "./icecast-controller.js?v=1";
import { ROOM_QUERY_KEYS, DIRECTOR_QUERY_KEYS, sanitizeRoomSlug, getRoomSlugFromParams, readStoredRoomState, persistStoredRoomState } from "./room-state-store.js?v=1";
import { SpectrogramRenderer } from "./spectrogram-renderer.js?v=1";
import { injectStylesheet, createElement, makeCollapsible } from "./dom-helpers.js?v=1";
import { formatRelativeTime } from "./time-format.js?v=1";
import { createRecordingSessionId, snapshotHighResClock } from "./recording-session-utils.js?v=1";
import { runPreflightChecklist } from "./preflight-checklist.js?v=1";
import { MarkerLog } from "./marker-log.js?v=1";
import { HostMicController } from "./host-mic-controller.js?v=1";
import { GuestBackupController } from "./guest-backup-controller.js?v=1";
import { RosterController } from "./roster-controller.js?v=1";
import { RemoteControlsController } from "./remote-controls-controller.js?v=1";
import { HelpModalController } from "./help-modal-controller.js?v=1";
import { UploadProgressController } from "./upload-progress-controller.js?v=1";
import { DiskRecordingController } from "./disk-recording-controller.js?v=1";
import { InviteLinkController } from "./invite-link-controller.js?v=1";
import { CloudLinkController } from "./cloud-link-controller.js?v=1";
import { CaptureModeController } from "./capture-mode-controller.js?v=1";

const STUDIO_ROOT_ID = "podcast-root";
const PODCAST_DISK_EVENT = "podcast-disk-state";
const PODCAST_RECORD_PLAN_EVENT = "podcast-record-plan";
const PODCAST_RECORD_STATUS_EVENT = "podcast-record-status";
const STUDIO_DISK_FEATURE_FLAG = (() => {
	let enabled = true;
	if (typeof urlParams !== "undefined" && urlParams) {
		const hasParam = typeof urlParams.has === "function" ? urlParams.has("studioiso") : false;
		if (hasParam) {
			const rawValue = typeof urlParams.get === "function" ? urlParams.get("studioiso") : null;
			const normalized = (rawValue || "1").toString().toLowerCase();
			enabled = !["0", "false", "off", "no"].includes(normalized);
		}
	}
	return enabled;
})();

const STUDIO_VIDEO_FEATURE_FLAG = true;

function dispatchStudioEvent(name, detail = {}) {
	if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
		return;
	}
	try {
		window.dispatchEvent(new CustomEvent(name, { detail }));
	} catch (error) {
		console.warn("Unable to dispatch studio event", name, error);
	}
}

function buildRoomGate(defaults = {}) {
	injectStylesheet();

	const gate = createElement("div", "", { id: "podcast-room-gate" });
	const panel = createElement("div", "podcast-room-gate__panel");
	const title = createElement("h1", "podcast-room-gate__title", { text: "Start a Control Room" });
	const subtitle = createElement("p", "podcast-room-gate__subtitle", {
		text: "Name your room to invite talent and capture their tracks. This matches the “&director=” link you share with guests."
	});

	const form = createElement("form", "podcast-room-gate__form");
	const roomLabel = createElement("label");
	roomLabel.append(createElement("span", "", { text: "Room name" }));
	const roomInput = createElement("input");
	roomInput.name = "room";
	roomInput.placeholder = defaults.roomPlaceholder || "podcast-hq";
	roomInput.title = "This name becomes the room slug used in guest links.";
	roomInput.autocomplete = "off";
	roomInput.autocapitalize = "off";
	roomInput.spellcheck = false;
	if (defaults.room) {
		roomInput.value = defaults.room;
	}
	roomLabel.append(roomInput);

	const passwordLabel = createElement("label");
	passwordLabel.append(createElement("span", "", { text: "Room password (optional)" }));
	const passwordInput = createElement("input");
	passwordInput.name = "password";
	passwordInput.placeholder = "Leave blank to skip";
	passwordInput.title = "Optional room password for guests and directors.";
	passwordInput.type = "text";
	passwordInput.autocomplete = "off";
	passwordInput.autocapitalize = "off";
	passwordInput.spellcheck = false;
	if (defaults.password) {
		passwordInput.value = defaults.password;
	}
	passwordLabel.append(passwordInput);

	const errorNode = createElement("div", "podcast-room-gate__error");

	const actions = createElement("div", "podcast-room-gate__actions");
	const cancelButton = createElement("button", "podcast-room-gate__cancel", {
		type: "button",
		text: "Back to classic",
		title: "Return to the classic VDO.Ninja interface."
	});
	const submitButton = createElement("button", "podcast-room-gate__submit", {
		type: "submit",
		text: "Enter studio",
		title: "Enter the podcast studio for this room."
	});
	actions.append(submitButton, cancelButton);

	form.append(roomLabel, passwordLabel, errorNode, actions);
	panel.append(title, subtitle, form);
	gate.append(panel);
	document.body.append(gate);

	document.body.classList.remove("hidden");
	document.body.classList.add("podcast-studio-mode");

	setTimeout(() => {
		roomInput.focus();
		roomInput.select();
	}, 0);

	return {
		gate,
		form,
		roomInput,
		passwordInput,
		errorNode,
		submitButton,
		cancelButton
	};
}

async function ensureRoomSelection() {
	const params = new URLSearchParams(window.location.search);
	const existing = getRoomSlugFromParams(params);
	if (existing) {
		injectStylesheet();
		const preflight = await runPreflightChecklist({ roomSlug: existing });
		if (preflight?.redirect) {
			return preflight;
		}
		return { roomSlug: preflight?.roomSlug || existing };
	}

	const stored = readStoredRoomState();
	const gateElements = buildRoomGate(stored);

	return new Promise(resolve => {
		function redirectToClassic() {
			const base = window.location.pathname;
			gateElements.cancelButton.disabled = true;
			gateElements.submitButton.disabled = true;
			window.location.href = base || "/";
			resolve({ redirect: true });
		}

		function handleSubmit(event) {
			event.preventDefault();
			const slug = sanitizeRoomSlug(gateElements.roomInput.value);
			if (!slug) {
				gateElements.errorNode.textContent = "Room name is required.";
				return;
			}
			gateElements.errorNode.textContent = "";
			gateElements.submitButton.disabled = true;
			gateElements.cancelButton.disabled = true;

			const updatedParams = new URLSearchParams(window.location.search);
			updatedParams.set("studio", "podcast");
			updatedParams.set("director", slug);
			for (const key of DIRECTOR_QUERY_KEYS) {
				if (key !== "director") {
					updatedParams.delete(key);
				}
			}
			for (const key of ROOM_QUERY_KEYS) {
				updatedParams.delete(key);
			}

			const password = gateElements.passwordInput.value.trim();
			if (password) {
				updatedParams.set("password", password);
			} else {
				updatedParams.delete("password");
			}

			persistStoredRoomState({ room: slug, password });
			window.location.search = updatedParams.toString();
			resolve({ redirect: true });
		}

		gateElements.form.addEventListener("submit", event => handleSubmit(event));
		gateElements.cancelButton.addEventListener("click", event => {
			event.preventDefault();
			redirectToClassic();
		});
		// Rely on form submit for enter/return handling.
	});
}

function extractPeerAudioStats(peer) {
	const stats = peer?.stats || {};
	const candidates = [stats.audio_bitrate_kbps, stats.inbound_audio_bitrate_kbps, stats.total_audio_bitrate_kbps, stats.total_sending_bitrate_kbps];
	const audioBitrateKbps = candidates.find(value => typeof value === "number" && value >= 0);
	const codec = typeof stats.audio_codec === "string" ? stats.audio_codec : typeof stats.audio_codec_in === "string" ? stats.audio_codec_in : typeof stats.audio_codec_out === "string" ? stats.audio_codec_out : "";
	return {
		audioBitrateKbps: audioBitrateKbps ?? null,
		audioCodec: codec || null
	};
}

function collectParticipants(session) {
	const participants = [];

	Object.entries(session.rpcs || {}).forEach(([uuid, peer]) => {
		if (!peer) {
			return;
		}
		const audioTracks = peer.streamSrc?.getAudioTracks?.() || [];
		let level = 0;
		if (peer.stats && typeof peer.stats.Audio_Loudness === "number") {
			level = peer.stats.Audio_Loudness;
		} else if (peer.audioMeter) {
			level = peer.audioMeter.level || 0;
		}
		const { audioBitrateKbps, audioCodec } = extractPeerAudioStats(peer);
		participants.push({
			uuid,
			label: peer.label || peer.streamID || `Guest ${uuid.substring(0, 4)}`,
			streamID: peer.streamID,
			status: peer.streamSrc && audioTracks.length ? "connected" : "connecting",
			audioLevel: level,
			isLocal: false,
			role: "remote",
			audioBitrateKbps,
			audioCodec
		});
	});

	return participants;
}

class PodcastStudioApp {
	constructor(options = {}) {
		this.options = options || {};
		this.roomHint = this.options.roomHint || "";
		this.session = null;
		this.cloud = null;
		this.recorder = null;
		this.audioContext = null;
		this.recording = false;
		this.outputIndicators = new Map();
		this.trackRuntimeStats = new Map();
		this.trackLevelNodes = new Map();
		this.spectrograms = new Map();
		this.participantMetrics = new Map();
		this.markerLog = null;
		this.levelOff = null;
		this.recordStartedAt = null;
		this.driveStatusNode = null;
		this.dropboxStatusNode = null;
		this.abortUploadsController = null;
		this.activeDownloadUrls = [];
		this.stopMeterBridge = null;
		this.roomName = this.roomHint || "";
		this.virtualParticipants = new Map();
		this.hostMicController = new HostMicController({
			isRecording: () => this.recording,
			getAudioContext: () => this.audioContext,
			ensureAudioContextResumed: () => this.ensureAudioContextResumed(),
			getSessionLabel: () => this.session?.label,
			virtualParticipants: this.virtualParticipants,
			onRosterChange: () => this.roster.refresh(),
			applyMeterValue: (uuid, value) => this.roster.applyMeterValue(uuid, value)
		});
		this.guestBackup = new GuestBackupController({
			getParticipants: () => this.getBackupParticipants(),
			hasDriveAccess: () => Boolean(this.cloud?.hasDriveAccess()),
			onReadinessChange: () => this.updateReadinessSummary(),
			onRecordingStatusChange: () => this.refreshRecordingStatusLive()
		});
		this.roster = new RosterController({
			getSession: () => this.session,
			getParticipants: () => {
				const participants = [...collectParticipants(this.session)];
				this.virtualParticipants.forEach(participant => {
					if (participant) {
						participants.push(participant);
					}
				});
				return participants;
			},
			createGuestBackupControl: participant => this.guestBackup.createRosterControl(participant),
			teardownGuestBackupControl: uuid => this.guestBackup.teardownRosterControl(uuid),
			updateGuestBackupAvailability: uuid => this.guestBackup.updateActionAvailability(uuid),
			onOpenRemoteControls: uuid => this.remoteControls.open(uuid),
			onParticipantSeen: participant => this.captureParticipantMetrics(participant),
			onParticipantAdded: participant => this.tryAddParticipantToRecording(participant),
			onParticipantRemoved: uuid => this.remoteControls.closeIfActive(uuid),
			onBeforeRefresh: () => this.updateRoomIndicator(),
			onAfterRefresh: () => {
				this.guestBackup.updateControls();
				this.updateReadinessSummary();
				this.refreshRecordingStatusLive();
				this.icecastController.refreshSourcesIfLive();
			}
		});
		this.remoteControls = new RemoteControlsController({
			getRosterItem: uuid => this.roster.getItem(uuid)
		});
		this.help = new HelpModalController();
		this.uploadProgress = new UploadProgressController({
			describeService: service => this.describeService(service)
		});
		this.diskRecording = new DiskRecordingController({
			featureEnabled: STUDIO_DISK_FEATURE_FLAG,
			onReadinessChange: () => this.updateReadinessSummary()
		});
		this.inviteLink = new InviteLinkController({
			getRoomName: () => this.resolveRoomName()
		});
		this.cloudLink = new CloudLinkController({
			getCloud: () => this.cloud,
			isRecording: () => this.recording,
			getDriveFolderName: () => this.session?.GDRIVE_FOLDERNAME || null,
			onStatusChange: () => this.updateReadinessSummary(),
			refreshCloudFooter: () => this.updateCloudFooter(),
			refreshGuestBackupControls: () => this.guestBackup.updateAllActions()
		});
		this.captureMode = new CaptureModeController({
			onModeChange: () => {
				this.updateRecordingButtons();
				this.updateReadinessSummary();
			}
		});
		this.chatModule = null;
		this.chatPlaceholder = null;
		this.chatPanel = null;
		this.chatCollapseButton = null;
		this.chatPopoutButton = null;
		this.chatCollapsed = false;
		this.chatPopoutAnchor = null;
		this.chatCollapsedHint = null;
		this.diskStateListener = null;
		this.cloudSummaryNode = null;
		this.captureSummaryNode = null;
		this.backupSummaryNode = null;
		this.saveSummaryNode = null;
		this.summaryWarningNode = null;
		this.recordingSummary = null;
		this.destinationLights = { download: null, drive: null, dropbox: null, disk: null };
		this.isoSummary = null;
		this.recordingStatusNode = null;
		this.recordingStatusTimer = null;
		this.recordingStatusBase = "Idle";
		this.recordingStatusState = "idle";
		this.recordTransitioning = false;
		this.recordingPlan = null;
		this.recordingSessionId = null;
		this.icecastController = null;
	}

	async init() {
		document.body.classList.remove("hidden");
		document.body.classList.add("podcast-studio-mode");
		injectStylesheet();

		this.session = await waitForLegacySession({ timeoutMs: 15000 });
		this.applyDirectorAudioDefaults();
		this.audioContext = this.session.audioCtx || this.session.audioCtxOutbound || this.createAudioContext();
		this.recorder = new MultiTrackRecorder({
			audioContext: this.audioContext,
			includeVideo: false,
			includeScreenshares: false,
			monitorLevels: true,
			timeslice: 1000
		});
		this.icecastController = new IcecastController({
			getAudioContext: () => this.audioContext,
			ensureAudioContextResumed: () => this.ensureAudioContextResumed(),
			getMixParticipants: () => this.getIcecastMixParticipants(),
			formatFileSize: bytes => this.formatFileSize(bytes),
			formatDuration: seconds => this.formatDuration(seconds),
			onReadinessChange: () => this.updateReadinessSummary()
		});
		this.cloud = new CloudUploadCoordinator(this.session);

		this.roomName = this.resolveRoomName();
		this.buildLayout();
		this.icecastController.updateUI();
		this.updateReadinessSummary();
		this.updateRecordingButtons();
		if (STUDIO_DISK_FEATURE_FLAG) {
			this.diskStateListener = () => {
				this.diskRecording.updateUI();
				this.updateReadinessSummary();
			};
			window.addEventListener(PODCAST_DISK_EVENT, this.diskStateListener);
		}
		this.updateRoomIndicator();
		this.updateCloudFooter();
		this.attachRecorderEvents();
		this.roster.refresh();
		this.roster.startLoop();
		this.levelOff = levelBus.on(LEVEL_EVENT, payload => this.updateMeterFromBus(payload));
		try {
			this.stopMeterBridge = await bridgeLegacyMeters();
		} catch (error) {
			console.warn("Failed to bridge legacy meter events", error);
		}
	}

	resolveRoomName() {
		if (this.session?.roomid && this.session.roomid !== true) {
			return sanitizeRoomSlug(this.session.roomid);
		}
		if (this.session?.director && this.session.director !== true) {
			return sanitizeRoomSlug(this.session.director);
		}
		if (this.roomHint) {
			return sanitizeRoomSlug(this.roomHint);
		}
		const paramsSlug = getRoomSlugFromParams();
		if (paramsSlug) {
			return paramsSlug;
		}
		return "";
	}

	updateRoomIndicator() {
		const latest = this.resolveRoomName();
		if (latest !== this.roomName) {
			this.roomName = latest;
			if (this.sessionInfo) {
				this.sessionInfo.textContent = this.roomName || "";
			}
			if (this.roomName) {
				const stored = readStoredRoomState();
				persistStoredRoomState({ room: this.roomName, password: stored?.password || "" });
			}
		}
		this.inviteLink.refresh();
	}

	applyDirectorAudioDefaults() {
		if (!this.session) {
			return;
		}
		if (this.session.stereo === undefined || this.session.stereo === null || this.session.stereo === false || this.session.stereo === 0) {
			this.session.stereo = 1;
		}
		if (!this.session.audiobitrate || this.session.audiobitrate < 192) {
			this.session.audiobitrate = 256;
		}
		if (!this.session.outboundAudioBitrate || this.session.outboundAudioBitrate < 192) {
			this.session.outboundAudioBitrate = 256;
		}
		if (typeof this.session.autoGainControl === "undefined") {
			this.session.autoGainControl = false;
		}
		if (typeof this.session.noiseSuppression === "undefined") {
			this.session.noiseSuppression = false;
		}
		if (typeof this.session.echoCancellation === "undefined") {
			this.session.echoCancellation = false;
		}
		if (typeof this.session.applyStereoDefaults === "function") {
			try {
				this.session.applyStereoDefaults();
			} catch (error) {
				console.warn("applyStereoDefaults failed", error);
			}
		}
	}

	getAdditionalRecordingParticipants() {
		const extras = [];
		this.virtualParticipants.forEach(participant => {
			if (participant && participant.stream) {
				extras.push({
					...participant
				});
			}
		});
		return extras;
	}

	async ensureAudioContextResumed() {
		if (!this.audioContext) {
			this.audioContext = this.createAudioContext();
		}
		if (this.audioContext && typeof this.audioContext.resume === "function" && this.audioContext.state === "suspended") {
			try {
				await this.audioContext.resume();
			} catch (error) {
				console.warn("Failed to resume audio context", error);
			}
		}
	}

	createAudioContext() {
		const AudioCtx = window.AudioContext || window.webkitAudioContext;
		if (!AudioCtx) {
			return null;
		}
		return new AudioCtx();
	}

	getIcecastMixParticipants() {
		const participants = [];
		Object.entries(this.session?.rpcs || {}).forEach(([uuid, peer]) => {
			const stream = peer?.streamSrc || peer?.stream || peer?.videoElement?.srcObject || null;
			if (!stream || !stream.getAudioTracks?.().length) {
				return;
			}
			participants.push({
				uuid,
				label: peer.label || peer.streamID || uuid,
				stream,
				streamID: peer.streamID || uuid,
				role: "remote"
			});
		});
		this.virtualParticipants.forEach(participant => {
			if (participant?.stream?.getAudioTracks?.().length) {
				participants.push({ ...participant });
			}
		});
		return participants;
	}

	buildLayout() {
		if (document.getElementById(STUDIO_ROOT_ID)) {
			return;
		}

		const root = createElement("div", "", { id: STUDIO_ROOT_ID });

		// Header
		const header = createElement("header", "podcast-header");
		const headerLeft = createElement("div", "podcast-header__left");
		const title = createElement("h1", "", { text: "Podcast Control Room" });
		this.sessionInfo = createElement("div", "podcast-header__room", { text: this.roomName || "" });
		headerLeft.append(title, this.sessionInfo);
		const statusPill = createElement("div", "podcast-status-pill");
		statusPill.innerHTML = "<span>Live-ready</span>";
		header.append(headerLeft, statusPill);

		// Main layout
		const main = createElement("main", "podcast-main");

		// Left column (host input + roster + markers)
		const rosterColumn = createElement("div", "podcast-roster");

		// Host Input panel (director's mic)
		const hostPanel = this.hostMicController.buildControls();

		const rosterPanel = this.roster.buildPanel();

		const markersPanel = createElement("section", "podcast-panel");
		const markerLogEl = createElement("div", "marker-log");
		const markerActions = createElement("div", "cloud-sync-list__actions marker-actions");
		markerActions.style.display = "none";
		const markerExportButton = createElement("button", "cloud-sync-list__button", { type: "button", text: "Export CSV", title: "Download markers as a CSV file." });
		const markerCopyButton = createElement("button", "cloud-sync-list__button", { type: "button", text: "Copy CSV", title: "Copy markers CSV to clipboard." });
		markerActions.append(markerExportButton, markerCopyButton);
		this.markerLog = new MarkerLog({
			logEl: markerLogEl,
			actionsEl: markerActions,
			exportButton: markerExportButton,
			copyButton: markerCopyButton,
			isRecording: () => this.recording,
			getElapsedSeconds: () => (this.recording ? (Date.now() - this.recordStartedAt) / 1000 : 0),
			getSessionId: () => this.recordingSessionId || this.recordingPlan?.sessionId,
			onEvent: (type, data) => this.logRecordingEvent(type, data)
		});
		this.markerLog.render();
		markersPanel.append(markerLogEl, markerActions);
		makeCollapsible(markersPanel, "Session Markers", "podcastStudio.collapse.markers");

		rosterColumn.append(hostPanel, rosterPanel, markersPanel);

		// Right column (controls + timeline)
		const consoleColumn = createElement("div", "podcast-console");
		const consoleGrid = createElement("div", "podcast-console-grid");
		consoleColumn.append(consoleGrid);

		const invitePanel = this.inviteLink.buildPanel();

		const sessionToolsPanel = createElement("section", "podcast-panel session-tools");
		sessionToolsPanel.classList.add("console-grid__span-2");
		const sessionToolsGrid = createElement("div", "session-tools__grid");
		sessionToolsPanel.append(sessionToolsGrid);

		const controlCard = createElement("div", "session-tool session-tool--control");
		controlCard.append(createElement("h2", "session-tool__title", { text: "⏺ Recording" }));

		this.recordingSummary = createElement("div", "recording-summary");
		this.captureSummaryNode = createElement("div", "recording-summary__item", { text: "Capture: Audio ISO" });
		this.backupSummaryNode = createElement("div", "recording-summary__item", { text: "Backup: None" });
		this.saveSummaryNode = createElement("div", "recording-summary__item", { text: "Save: Browser buffer only" });
		this.recordingSummary.append(this.captureSummaryNode, this.backupSummaryNode, this.saveSummaryNode);
		this.recordingSummary.style.display = "none";

		const transportButtons = createElement("div", "transport-buttons");
		this.recordButton = createElement("button", "btn-record", { type: "button", text: "Start Recording", title: "Start or stop ISO recording for this session." });
		this.recordButton.addEventListener("click", () => this.handleRecordToggle());
		this.markerButton = createElement("button", "btn-secondary", { type: "button", text: "Marker", title: "Drop a cue marker at the current time." });
		this.markerButton.disabled = true;
		this.markerButton.addEventListener("click", () => this.markerLog.addManual());
		const captureWrap = this.captureMode.buildControl();
		transportButtons.append(captureWrap, this.recordButton);
		transportButtons.append(this.markerButton);

		this.recordShowButton = createElement("button", "record-group-button", { type: "button", text: "🎬 Record Group", title: "Open a popup window with the combined scene for screen recording." });
		this.recordShowButton.addEventListener("click", () => this.openRecordShowWindow());

		this.recordingStatusNode = createElement("div", "session-recording-status", { text: "Idle" });
		this.recordingStatusNode.dataset.state = "idle";
		const statusRow = createElement("div", "recording-status-row");
		statusRow.append(this.recordingStatusNode);

		const destLightsRow = createElement("div", "destination-lights");
		const createDestLight = (key, label) => {
			const el = createElement("div", "dest-light");
			const dot = createElement("span", "dest-light__dot");
			const textWrap = createElement("div", "dest-light__text");
			const name = createElement("span", "dest-light__name", { text: label });
			const status = createElement("span", "dest-light__status");
			textWrap.append(name, status);
			el.append(dot, textWrap);
			el.dataset.state = "gray";
			this.destinationLights[key] = { el, dot, status };
			return el;
		};

		const hostGroup = createElement("div", "dest-group");
		hostGroup.append(createElement("div", "dest-group__label", { text: "You record" }));
		const hostLights = createElement("div", "dest-group__lights");
		hostLights.append(createDestLight("download", "Download"));
		hostLights.append(createDestLight("dropbox", "Dropbox"));
		if (STUDIO_DISK_FEATURE_FLAG) {
			hostLights.append(createDestLight("disk", "Local folder"));
		}
		hostGroup.append(hostLights);

		const guestGroup = createElement("div", "dest-group");
		guestGroup.append(createElement("div", "dest-group__label", { text: "Guests record" }));
		const guestLights = createElement("div", "dest-group__lights");
		guestLights.append(createDestLight("drive", "Google Drive"));
		guestGroup.append(guestLights, createElement("div", "dest-group__hint", { text: "Guests can also record locally — see Guest Invites" }));

		destLightsRow.append(hostGroup, createElement("div", "dest-group-divider"), guestGroup);
		const recordGroupRow = createElement("div", "record-group-row");
		recordGroupRow.append(this.recordShowButton);
		controlCard.append(this.recordingSummary, destLightsRow, transportButtons, statusRow, recordGroupRow);
		sessionToolsGrid.append(controlCard);

		// ISO Recording Configuration - unified destinations section
		const isoConfigCard = createElement("div", "session-tool session-tool--iso-config");
		isoConfigCard.append(createElement("h2", "session-tool__title", { text: "💾 Recording settings" }));
		const isoConfigList = createElement("div", "iso-config-list");

		isoConfigList.append(this.guestBackup.buildRow());

		// Cloud upload links (Google Drive / Dropbox)
		isoConfigList.append(this.cloudLink.buildPanel());

		// Local Disk row
		this.diskRecording.buildRow(isoConfigList);

		this.icecastController.buildControls(isoConfigList);

		// Summary section
		this.isoSummary = createElement("div", "iso-config-summary");
		this.cloudSummaryNode = createElement("div", "iso-config-summary__item", { text: "Status: checking..." });
		this.cloudSummaryNode.dataset.state = "pending";
		const serviceProgress = createElement("div", "iso-config-summary__services");
		const progressNodes = this.uploadProgress.createProgressNodes();
		serviceProgress.append(progressNodes.drive, progressNodes.dropbox);
		this.isoSummary.append(this.cloudSummaryNode, serviceProgress);
		this.isoSummary.style.display = "none";

		isoConfigCard.append(isoConfigList, this.isoSummary);
		sessionToolsGrid.append(isoConfigCard);
		makeCollapsible(sessionToolsPanel, "Recording Controls", "podcastStudio.collapse.recording");

		const timelinePanel = createElement("section", "podcast-panel timeline-shell");
		timelinePanel.classList.add("console-grid__span-2");
		this.outputsContainer = createElement("div", "timeline-surface");
		timelinePanel.append(this.outputsContainer);
		this.showOutputsMessage("Recordings and cue points will appear here.");
		makeCollapsible(timelinePanel, "Timeline & Outputs", "podcastStudio.collapse.timeline");

		const chatPanel = createElement("section", "podcast-panel chat-panel");
		chatPanel.dataset.collapsed = "false";
		this.chatPanel = chatPanel;
		const chatHeaderRow = createElement("div", "chat-panel__header");
		const chatTitle = createElement("h2", "", { text: "Control Room Chat" });
		const chatActions = createElement("div", "chat-panel__actions");
		this.chatPopoutButton = createElement("button", "chat-panel__action", { type: "button", text: "Pop out", title: "Open chat in a separate window." });
		this.chatPopoutButton.addEventListener("click", () => this.handleChatPopout());
		this.chatCollapseButton = createElement("button", "panel-collapse-toggle", {
			type: "button",
			text: "−"
		});
		this.chatCollapseButton.title = "Collapse section";
		this.chatCollapseButton.setAttribute("aria-expanded", "true");
		this.chatCollapseButton.addEventListener("click", () => this.toggleChatPanel());
		chatActions.append(this.chatPopoutButton, this.chatCollapseButton);
		chatHeaderRow.append(chatTitle, chatActions);
		chatPanel.append(chatHeaderRow);

		const chatBody = createElement("div", "chat-panel__body");
		const legacyChat = document.getElementById("chatModule");
		if (legacyChat) {
			this.chatPlaceholder = document.createElement("div");
			this.chatPlaceholder.dataset.podcastPlaceholder = "chat-module";
			if (legacyChat.parentNode) {
				legacyChat.parentNode.insertBefore(this.chatPlaceholder, legacyChat);
			}
			legacyChat.classList.remove("hidden");
			legacyChat.dataset.podcastOverlay = "true";
			const legacyHeader = legacyChat.querySelector(".chat-header");
			if (legacyHeader) {
				const popLink = legacyHeader.querySelector("#popOutChat");
				if (popLink) {
					this.chatPopoutAnchor = popLink;
					popLink.style.display = "none";
				}
				const closeLink = legacyHeader.querySelector("#closeChat");
				if (closeLink) {
					closeLink.style.display = "none";
				}
				legacyHeader.dataset.podcastDisplay = legacyHeader.style.display || "";
				legacyHeader.style.display = "none";
			}
			const legacyResizer = legacyChat.querySelector(".resizer");
			if (legacyResizer) {
				legacyResizer.dataset.podcastDisplay = legacyResizer.style.display || "";
				legacyResizer.style.display = "none";
			}
			legacyChat.style.position = "relative";
			legacyChat.style.right = "auto";
			legacyChat.style.left = "auto";
			legacyChat.style.bottom = "auto";
			legacyChat.style.top = "auto";
			legacyChat.style.zIndex = "auto";
			legacyChat.style.maxWidth = "100%";
			legacyChat.style.width = "100%";
			legacyChat.style.height = "auto";
			legacyChat.style.maxHeight = "320px";
			legacyChat.style.overflow = "hidden";
			legacyChat.style.margin = "0";
			chatBody.append(legacyChat);
			this.chatModule = legacyChat;
		} else {
			chatBody.append(createElement("div", "chat-panel__empty", { text: "Chat initialising…" }));
		}
		if (this.chatPopoutButton) {
			const hasPopout = Boolean(this.chatPopoutAnchor || typeof window.createPopoutChat === "function");
			this.chatPopoutButton.disabled = !hasPopout;
			if (!hasPopout) {
				this.chatPopoutButton.textContent = "Pop out unavailable";
			}
		}
		chatPanel.append(chatBody);
		this.chatCollapsedHint = createElement("div", "chat-panel__collapsed-hint", {
			text: "Chat hidden. Click “Show chat” to reopen."
		});
		this.chatCollapsedHint.style.display = "none";
		chatPanel.append(this.chatCollapsedHint);

		if (this.chatModule) {
			this.chatModule.classList.remove("hidden");
			this.chatModule.style.display = "";
			this.chatModule.dataset.podcastEmbedded = "true";
		}

		consoleGrid.append(invitePanel);
		consoleGrid.append(sessionToolsPanel);
		consoleGrid.append(timelinePanel);
		chatPanel.classList.add("console-grid__span-2");
		consoleGrid.append(chatPanel);

		main.append(rosterColumn, consoleColumn);

		// Footer
		const footer = createElement("footer", "podcast-footer");
		footer.innerHTML = `
      <div>Powered by VDO.Ninja • Low-latency P2P backbone intact • <span class="podcast-help-link" id="podcast-help-link" role="button" tabindex="0">Guide</span></div>
      <div class="cloud-status">
        <span id="podcast-cloud-drive">${this.cloud?.hasDriveAccess() ? "Google Drive linked" : "Drive link pending"}</span>
        <span id="podcast-cloud-dropbox">${this.cloud?.hasDropboxAccess() ? "Dropbox linked" : "Dropbox link pending"}</span>
      </div>
    `;

		root.append(header, main, footer);
		document.body.appendChild(root);

		// Help link click handler (must be after appendChild)
		const helpLink = document.getElementById("podcast-help-link");
		if (helpLink) {
			helpLink.addEventListener("click", () => this.help.open());
			helpLink.addEventListener("keydown", e => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					this.help.open();
				}
			});
		}

		this.driveStatusNode = document.getElementById("podcast-cloud-drive");
		this.dropboxStatusNode = document.getElementById("podcast-cloud-dropbox");
		this.hostMicController.updateUI();
		this.hostMicController.setError("");
		this.cloudLink.refresh();
		this.updateReadinessSummary();
		this.cloudLink.setCloudMessage("drive", "");
		this.cloudLink.setCloudMessage("dropbox", "");
		this.inviteLink.refresh();
		this.toggleChatPanel(false);
		requestAnimationFrame(() => this.toggleChatPanel(false));
	}

	handleChatPopout() {
		if (this.chatPopoutAnchor && typeof this.chatPopoutAnchor.click === "function") {
			try {
				this.chatPopoutAnchor.click();
				return;
			} catch (error) {
				console.warn("Legacy chat pop-out click failed", error);
			}
		}
		if (typeof window.createPopoutChat === "function") {
			try {
				window.createPopoutChat();
				return;
			} catch (error) {
				console.warn("createPopoutChat invocation failed", error);
			}
		}
		try {
			window.open(window.location.href, "_blank", "noopener");
		} catch (error) {
			console.warn("Fallback chat pop-out failed", error);
		}
	}

	toggleChatPanel(forceCollapsed) {
		const shouldCollapse = typeof forceCollapsed === "boolean" ? forceCollapsed : !this.chatCollapsed;
		this.chatCollapsed = Boolean(shouldCollapse);
		if (this.chatPanel) {
			this.chatPanel.dataset.collapsed = this.chatCollapsed ? "true" : "false";
		}
		if (this.chatCollapseButton) {
			this.chatCollapseButton.textContent = this.chatCollapsed ? "+" : "−";
			this.chatCollapseButton.title = this.chatCollapsed ? "Expand section" : "Collapse section";
			this.chatCollapseButton.setAttribute("aria-expanded", this.chatCollapsed ? "false" : "true");
		}
		if (this.chatCollapsedHint) {
			this.chatCollapsedHint.style.display = this.chatCollapsed ? "" : "none";
		}
		if (this.chatModule) {
			if (this.chatCollapsed) {
				this.chatModule.classList.add("hidden");
			} else {
				this.chatModule.classList.remove("hidden");
			}
		}
		if (this.session && typeof this.session.chat !== "undefined") {
			this.session.chat = !this.chatCollapsed;
		}
	}

	getBackupParticipants() {
		return collectParticipants(this.session).filter(participant => participant?.uuid);
	}

	describeSaveTargetSummary() {
		const driveActive = Boolean(this.cloud?.hasDriveAccess());
		const dropboxActive = Boolean(this.cloud?.hasDropboxAccess());
		const diskMeta = readDiskRecordingState();
		const saveTargets = [];
		if (STUDIO_DISK_FEATURE_FLAG && diskMeta.enabled && diskMeta.folderName) {
			saveTargets.push(`Local folder (${diskMeta.folderName})`);
		}
		if (driveActive) {
			saveTargets.push("Drive");
		}
		if (dropboxActive) {
			saveTargets.push("Dropbox");
		}
		if (!saveTargets.length) {
			return "Browser buffer only";
		}
		return `After stop -> ${saveTargets.join(" + ")}`;
	}

	countEstimatedRecordingTracks() {
		const recordingOptions = this.captureMode.getRecordingModeOptions(this.captureMode.getMode());
		let count = 0;
		this.getBackupParticipants().forEach(participant => {
			const stream = this.session?.rpcs?.[participant.uuid]?.streamSrc;
			const audioTracks = stream?.getAudioTracks?.() || [];
			const videoTracks = stream?.getVideoTracks?.() || [];
			count += audioTracks.length;
			if (recordingOptions.includeVideo) {
				count += videoTracks.length;
			}
		});
		this.getAdditionalRecordingParticipants().forEach(participant => {
			const stream = participant?.stream;
			count += stream?.getAudioTracks?.().length || 0;
			if (recordingOptions.includeVideo) {
				count += stream?.getVideoTracks?.().length || 0;
			}
		});
		return Math.max(count, this.outputIndicators?.size || 0);
	}

	refreshRecordingStatusLive() {
		if (!this.recordingStatusNode) {
			return;
		}
		if (!this.recording || !this.recordStartedAt) {
			this.recordingStatusNode.textContent = this.recordingStatusBase || "Idle";
			this.recordingStatusNode.dataset.state = this.recordingStatusState || "idle";
			return;
		}
		const elapsed = this.formatDuration(Math.max(0, (Date.now() - this.recordStartedAt) / 1000));
		const trackCount = this.countEstimatedRecordingTracks();
		const backupLabel = this.guestBackup.getCompactLabel();
		this.recordingStatusNode.textContent = `${elapsed} | ${trackCount} track${trackCount === 1 ? "" : "s"} | ${backupLabel}`;
		this.recordingStatusNode.dataset.state = "active";
	}

	startRecordingStatusTimer() {
		this.stopRecordingStatusTimer();
		this.refreshRecordingStatusLive();
		this.recordingStatusTimer = setInterval(() => this.refreshRecordingStatusLive(), 1000);
	}

	stopRecordingStatusTimer() {
		if (this.recordingStatusTimer) {
			clearInterval(this.recordingStatusTimer);
			this.recordingStatusTimer = null;
		}
	}

	updateRecordingButtons() {
		if (this.recordButton) {
			this.recordButton.classList.toggle("recording", this.recording);
			this.recordButton.disabled = this.recordTransitioning;
			this.recordButton.textContent = this.recording ? "Stop Recording" : "Start Recording";
			this.recordButton.title = this.recording ? "Stop the current ISO recording." : `Start ${this.captureMode.describeCaptureMode(this.captureMode.getMode())} capture.`;
		}
		this.captureMode.setRecording(this.recording);
		this.guestBackup.updateControls();
	}

	attachRecorderEvents() {
		this.recorder.addEventListener("start", event => {
			if (this.abortUploadsController) {
				this.abortUploadsController.abort();
			}
			this.abortUploadsController = new AbortController();
			this.cleanupDownloadUrls();
			this.trackRuntimeStats.clear();
			this.trackLevelNodes.clear();
			this.teardownSpectrograms();
			this.outputIndicators.clear();
			this.recording = true;
			this.recordTransitioning = false;
			this.recordStartedAt = event?.detail?.startedAt || Date.now();
			this.markerLog.reset();
			this.markerLog.scheduleAutoSync();
			this.updateRecordingButtons();
			this.markerButton.disabled = false;
			this.showOutputsMessage("Recording… tracks will appear as media arrives.");
			this.hostMicController.updateUI();
			this.uploadProgress.setPending(true);
			if (this.recordingPlan?.sync) {
				this.recordingPlan.sync.start = {
					wallClock: this.recordStartedAt,
					highRes: snapshotHighResClock()
				};
			}
			this.logRecordingEvent("record:start", { sessionId: this.recordingSessionId, mode: this.captureMode.getMode() });
			this.updateRecordingPlanStatus("started", { events: this.recordingPlan?.events || [] });
			this.setRecordingStatus(this.captureMode.getMode() === "video" ? "Recording audio + video ISOs" : "Recording audio ISOs", "active");
			if (this.recordingSummary) this.recordingSummary.style.display = "";
			this.startRecordingStatusTimer();
		});

		this.recorder.addEventListener("chunk", event => {
			const { participant, trackType, channelIndex } = event.detail || {};
			if (!participant || !trackType) {
				return;
			}
			const channelKey = typeof channelIndex === "number" ? channelIndex : 0;
			const key = this.buildTrackKey(participant.uuid, trackType, channelKey);
			if (!key) {
				return;
			}
			const indicator = this.ensureOutputIndicator(key, participant, trackType, channelKey);
			if (!indicator) {
				return;
			}
			indicator.badge.textContent = "Recording";
			indicator.wrapper.dataset.state = "recording";
			this.updateRecordingRuntimeMetrics(key, indicator, event.detail);
			this.trackManifestChunk(event.detail);
		});

		this.recorder.addEventListener("meter-ready", event => {
			const { participant, trackType, channelIndex, meter } = event.detail || {};
			if (!participant?.uuid || trackType !== "audio") {
				return;
			}
			const key = this.buildTrackKey(participant.uuid, trackType, channelIndex);
			if (!key) {
				return;
			}
			const indicator = this.outputIndicators.get(key);
			if (!indicator) {
				return;
			}
			this.attachSpectrogram(key, indicator, participant, trackType, channelIndex, meter);
		});

		this.recorder.addEventListener("participant-added", event => {
			const { participant, startOffsetSeconds } = event.detail || {};
			if (!participant) {
				return;
			}
			const annotateLateJoin = (trackType, trackIndex) => {
				const key = this.buildTrackKey(participant.uuid, trackType, trackIndex);
				if (key) {
					const indicator = this.ensureOutputIndicator(key, participant, trackType, trackIndex);
					if (indicator?.badge) {
						indicator.badge.textContent = "Late join";
						indicator.badge.title = `Joined ${startOffsetSeconds?.toFixed(1) || "?"}s into recording`;
					}
				}
			};
			const audioTracks = participant.stream?.getAudioTracks?.() || [];
			if (audioTracks.length) {
				audioTracks.forEach((_track, index) => annotateLateJoin("audio", index));
			}
			const videoTracks = participant.stream?.getVideoTracks?.() || [];
			if (videoTracks.length) {
				videoTracks.forEach((_track, index) => annotateLateJoin("video", index));
			}
			if (!audioTracks.length && !videoTracks.length) {
				annotateLateJoin("audio", 0);
			}
		});

		this.recorder.addEventListener("error", event => {
			console.error("Recorder error", event.detail);
			this.setStatusMessage("Recorder error: " + (event.detail?.message || "unknown"));
		});

		this.recorder.addEventListener("stop", event => {
			this.recording = false;
			this.recordTransitioning = false;
			this.stopRecordingStatusTimer();
			this.updateRecordingButtons();
			this.markerButton.disabled = true;
			this.markerLog.clearAutoTimer();
			this.showOutputsMessage("Finalising recordings…");
			this.trackLevelNodes.clear();
			this.teardownSpectrograms();
			this.presentRecordings(event.detail?.files);
			this.outputIndicators.clear();
			this.trackRuntimeStats.clear();
			this.hostMicController.updateUI();
			if (this.recordingPlan?.sync) {
				this.recordingPlan.sync.stop = {
					wallClock: Date.now(),
					highRes: snapshotHighResClock()
				};
			}
			if (this.recordingPlan) {
				this.recordingPlan.files = this.summariseRecordingFiles(event.detail?.files);
				this.logRecordingEvent("record:stop", {
					fileCount: this.recordingPlan?.files?.length || 0,
					mode: this.captureMode.getMode()
				});
				this.updateRecordingPlanStatus("stopped", {
					files: this.recordingPlan.files,
					events: this.recordingPlan.events
				});
			}
			this.setRecordingStatus("Recording idle", "idle");
		});
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

	setStatusMessage(message) {
		this.showOutputsMessage(message);
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
		if (!this.recorder || typeof this.recorder.getTrackMeter !== "function") {
			return null;
		}
		return this.recorder.getTrackMeter(uuid, trackType, channelIndex);
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

	updateRecordingRuntimeMetrics(key, indicator, detail) {
		if (!indicator) {
			return;
		}
		const runtime = this.trackRuntimeStats.get(key) || {
			bytes: 0,
			startedAt: Date.now(),
			lastUpdate: Date.now()
		};
		const chunk = detail?.data;
		if (chunk && typeof chunk.size === "number") {
			runtime.bytes += chunk.size;
		}
		const now = Date.now();
		if (!runtime.startedAt) {
			runtime.startedAt = now;
		}
		runtime.lastUpdate = now;
		const elapsedMs = Math.max(1, now - runtime.startedAt);
		const kbps = runtime.bytes ? (runtime.bytes * 8) / elapsedMs : 0;
		const durationSeconds = (now - runtime.startedAt) / 1000;
		if (indicator.trackType === "video" || detail?.trackType === "video") {
			const videoRateLabel = kbps > 0 ? `${Math.round(kbps)} kbps` : "capturing…";
			const durationLabel = this.formatDuration(durationSeconds);
			indicator.recordMetric.textContent = `Recording: ${videoRateLabel} • Video • ${durationLabel}`;
			this.trackRuntimeStats.set(key, runtime);
			return;
		}
		const sampleRate = this.recorder?.options?.targetSampleRate || 48000;
		const sampleRateLabel = sampleRate >= 1000 ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz` : `${sampleRate} Hz`;
		const bitrateLabel = kbps > 0 ? `${Math.round(kbps)} kbps` : "estimating…";
		const durationLabel = this.formatDuration(durationSeconds);
		indicator.recordMetric.textContent = `Recording: ${bitrateLabel} • WAV ${sampleRateLabel} • ${durationLabel}`;
		this.trackRuntimeStats.set(key, runtime);
	}

	buildRecordingPlanContext({ diskInfo } = {}) {
		const now = Date.now();
		const cloudSnapshot = readCloudLinkStatus();
		const plan = {
			sessionId: createRecordingSessionId(),
			conductor: "studio",
			preparedAt: now,
			disk: {
				enabled: Boolean(diskInfo?.ready),
				folderName: diskInfo?.folderName || null,
				verifiedAt: diskInfo?.verifiedAt || null
			},
			cloud: {
				driveLinked: Boolean(this.cloud?.hasDriveAccess() || cloudSnapshot.drive),
				dropboxLinked: Boolean(this.cloud?.hasDropboxAccess() || cloudSnapshot.dropbox),
				snapshot: cloudSnapshot
			},
			sync: {
				prepared: snapshotHighResClock(),
				start: null,
				stop: null
			},
			capture: {
				mode: this.captureMode.getMode(),
				includeVideo: this.captureMode.getMode() === "video",
				includeScreenshares: this.captureMode.getMode() === "video"
			},
			participants: {},
			files: [],
			events: []
		};
		this.recordingPlan = plan;
		this.recordingSessionId = plan.sessionId;
		this.logRecordingEvent("record:plan", { sessionId: plan.sessionId });
		dispatchStudioEvent(PODCAST_RECORD_PLAN_EVENT, { plan });
		this.setRecordingStatus("Recording plan armed", "armed");
		return plan;
	}

	updateRecordingPlanStatus(status, extra = {}) {
		if (!this.recordingPlan) {
			return;
		}
		const detail = {
			status,
			plan: this.recordingPlan,
			timestamp: Date.now(),
			...extra
		};
		dispatchStudioEvent(PODCAST_RECORD_STATUS_EVENT, detail);
	}

	trackManifestChunk(detail) {
		if (!this.recordingPlan || !detail?.participant?.uuid) {
			return;
		}
		const participantId = detail.participant.uuid;
		if (!this.recordingPlan.participants[participantId]) {
			this.recordingPlan.participants[participantId] = {
				participantId,
				label: detail.participant.label || participantId,
				tracks: {}
			};
		}
		const participantPlan = this.recordingPlan.participants[participantId];
		const trackKey = `${detail.trackType || "audio"}:${typeof detail.channelIndex === "number" ? detail.channelIndex : 0}`;
		if (!participantPlan.tracks[trackKey]) {
			participantPlan.tracks[trackKey] = {
				trackType: detail.trackType || "audio",
				channelIndex: typeof detail.channelIndex === "number" ? detail.channelIndex : 0,
				segments: [],
				totalBytes: 0,
				sequence: 0
			};
		}
		const track = participantPlan.tracks[trackKey];
		const bytes = detail.data?.size || 0;
		track.sequence += 1;
		track.totalBytes += bytes;
		const timecodeMs = this.recordStartedAt ? Date.now() - this.recordStartedAt : 0;
		const segment = {
			sequence: track.sequence,
			bytes,
			receivedAt: Date.now(),
			timecodeMs
		};
		if (track.segments.length > 48) {
			track.segments.shift();
		}
		track.segments.push(segment);
	}

	summariseRecordingFiles(filesMap) {
		if (!filesMap || typeof filesMap.forEach !== "function") {
			return [];
		}
		const summaries = [];
		filesMap.forEach(meta => {
			if (!meta) {
				return;
			}
			summaries.push({
				participant: meta.participant?.uuid || null,
				label: meta.participant?.label || null,
				trackType: meta.trackType,
				channelIndex: meta.channelIndex,
				filename: meta.filename,
				mimeType: meta.mimeType,
				size: meta.size,
				durationSeconds: meta.durationSeconds
			});
		});
		return summaries;
	}

	logRecordingEvent(type, data = {}) {
		if (!type) {
			return;
		}
		if (!this.recordingPlan) {
			this.recordingPlan = {
				sessionId: createRecordingSessionId(),
				events: []
			};
		}
		if (!Array.isArray(this.recordingPlan.events)) {
			this.recordingPlan.events = [];
		}
		const timestamp = Date.now();
		const timecodeMs = this.recordStartedAt ? Math.max(0, timestamp - this.recordStartedAt) : 0;
		this.recordingPlan.events.push({
			type,
			timestamp,
			timecodeMs,
			data
		});
		if (this.recordingPlan.events.length > 2000) {
			this.recordingPlan.events.shift();
		}
	}

	setRecordingStatus(text, state = "idle") {
		if (!this.recordingStatusNode) {
			return;
		}
		this.recordingStatusBase = text;
		this.recordingStatusState = state;
		if (state === "active") {
			this.refreshRecordingStatusLive();
			return;
		}
		this.recordingStatusNode.textContent = text;
		this.recordingStatusNode.dataset.state = state;
	}

	formatBitrate(value) {
		if (!Number.isFinite(value) || value <= 0) {
			return null;
		}
		if (value >= 1000) {
			const megabits = value / 1000;
			return `${megabits.toFixed(megabits >= 10 ? 0 : 1)} Mbps`;
		}
		return `${Math.round(value)} kbps`;
	}

	formatDuration(seconds) {
		if (!Number.isFinite(seconds) || seconds < 0) {
			return "0:00";
		}
		const totalSeconds = Math.floor(seconds);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const secs = totalSeconds % 60;
		if (hours > 0) {
			return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
		}
		return `${minutes}:${secs.toString().padStart(2, "0")}`;
	}

	async handleRecordToggle() {
		if (this.recordTransitioning) {
			return;
		}
		if (this.recording) {
			this.recordTransitioning = true;
			this.updateRecordingButtons();
			this.showOutputsMessage("Wrapping up recording…");
			this.logRecordingEvent("record:stop:requested", { reason: "host-toggle" });
			this.setRecordingStatus("Stopping recording…", "stopping");
			if (this.markerButton) {
				this.markerButton.disabled = true;
			}
			this.markerLog.clearAutoTimer();
			const markerSnapshot = this.markerLog.snapshot();
			try {
				await this.recorder.stop({ markers: markerSnapshot });
			} catch (error) {
				console.error("Failed to stop recorder cleanly", error);
				this.setStatusMessage("Recording stop failed: " + (error?.message || "unknown error"));
				this.recordTransitioning = false;
				this.updateRecordingButtons();
			}
			return;
		}
		try {
			this.recordTransitioning = true;
			this.updateRecordingButtons();
			let diskInfo = null;
			if (STUDIO_DISK_FEATURE_FLAG && this.diskRecording.enabled) {
				diskInfo = await this.diskRecording.ensureCaptureReadiness({ interactive: true });
				if (diskInfo && diskInfo.error) {
					this.setStatusMessage(diskInfo.error.message || "Disk folder not accessible.");
					this.recordTransitioning = false;
					this.updateRecordingButtons();
					return;
				}
			}
			this.buildRecordingPlanContext({ diskInfo });
			this.logRecordingEvent("record:arm", { source: "host-toggle", mode: this.captureMode.getMode() });
			this.updateRecordingPlanStatus("armed", { events: this.recordingPlan?.events || [] });
			this.setRecordingStatus(this.captureMode.getMode() === "video" ? "Arming audio + video ISOs…" : "Arming audio ISOs…", "arming");
			const recordingOptions = this.captureMode.getRecordingModeOptions(this.captureMode.getMode());
			await this.recorder.start({
				includeVideo: recordingOptions.includeVideo,
				includeScreenshares: recordingOptions.includeScreenshares,
				includeLocal: false,
				extraParticipants: this.getAdditionalRecordingParticipants()
			});
		} catch (error) {
			console.error("Failed to start recorder", error);
			this.setStatusMessage("Unable to start recording: " + (error?.message || "unknown error"));
			this.hostMicController.updateUI();
			this.recordTransitioning = false;
			this.updateRecordingButtons();
			this.stopRecordingStatusTimer();
			this.logRecordingEvent("record:error", { stage: "start", message: error?.message || "unknown error" });
			this.setRecordingStatus("Recording idle", "error");
			this.updateRecordingPlanStatus("error", { error: error?.message || "start failed", events: this.recordingPlan?.events || [] });
			this.uploadProgress.setPending(false);
		}
	}

	tryAddParticipantToRecording(participant) {
		if (!this.recording || !this.recorder) {
			return;
		}
		if (!participant?.stream) {
			return;
		}
		try {
			const result = this.recorder.addParticipant(participant);
			if (result?.added) {
				console.log(`Added late-joining participant to recording: ${participant.label || participant.uuid} (offset: ${result.startOffsetSeconds?.toFixed(1)}s)`);
				this.logRecordingEvent("participant:added-mid-recording", {
					uuid: participant.uuid,
					label: participant.label,
					startOffsetSeconds: result.startOffsetSeconds,
					trackCount: result.tracks
				});
				// Drop a sync marker so the new track can be aligned with existing tracks
				this.addSyncMarkerForNewTrack(participant, result.startOffsetSeconds);
			}
		} catch (error) {
			console.warn("Failed to add participant to recording", error);
		}
	}

	addSyncMarkerForNewTrack(participant, startOffsetSeconds) {
		if (!this.recording || !this.recordStartedAt) {
			return;
		}
		// Wait 1 second after track starts, then drop a sync marker
		// This gives the track time to stabilize before the sync point
		setTimeout(() => {
			if (!this.recording) {
				return;
			}
			const timestamp = this.recordStartedAt ? (Date.now() - this.recordStartedAt) / 1000 : startOffsetSeconds + 1;
			const label = participant?.label || participant?.uuid || "Guest";
			const note = {
				time: timestamp,
				label: `Sync: ${label} joined @ ${timestamp.toFixed(1)}s`,
				auto: true,
				joinSync: true
			};
			this.markerLog.add(note);
		}, 1000);
	}

	openRecordShowWindow() {
		const room = this.resolveRoomName();
		if (!room) {
			this.setStatusMessage("Set a room name before recording the show.");
			return;
		}
		// Build URL to the main VDO.ninja with scene + recordwindow
		const baseUrl = window.location.origin + window.location.pathname.replace(/\/podcast\/?.*/, "");
		const url = `${baseUrl}/?scene=0&room=${encodeURIComponent(room)}&recordwindow&chroma=000&locked=1.777`;
		const win = window.open(url, "recordShow", "toolbar=no,location=no,status=no,menubar=no,scrollbars=no,resizable=yes,width=1280,height=720");
		if (win) {
			win.focus();
		}
	}

	async presentRecordings(filesMap) {
		const files = filesMap || this.recorder.getFiles();
		if (!files || files.size === 0) {
			this.showOutputsMessage("No media captured.");
			this.uploadProgress.setPending(false);
			return;
		}
		this.cleanupDownloadUrls();
		this.outputsContainer.dataset.mode = "results";
		this.outputsContainer.dataset.hasTracks = "";
		this.outputsContainer.classList.remove("timeline-tracklist");
		this.outputsContainer.classList.add("timeline-results");
		this.outputsContainer.innerHTML = "";
		const uploadPromises = [];
		this.uploadProgress.setPending(false);
		files.forEach((meta, key) => {
			if (!meta?.blob) {
				return;
			}
			const wrapper = createElement("div", "timeline-entry");
			wrapper.dataset.key = key;
			const label = `${meta.trackType.toUpperCase()} • ${meta.participant.label || meta.participant.uuid}`;
			const downloadUrl = URL.createObjectURL(meta.blob);
			this.activeDownloadUrls.push(downloadUrl);
			const linkLabel = meta.mimeType === "audio/wav" ? "Download WAV" : "Download";
			const linkTitle = meta.mimeType === "audio/wav" ? "Download as WAV (includes embedded cue markers)." : "Download captured media.";
			const link = createElement("a", "marker-badge", { text: linkLabel, href: downloadUrl, title: linkTitle });
			const fallbackExtension = meta.mimeType?.split("/")?.[1] || "webm";
			link.download = meta.filename || `${meta.participant.streamID || meta.participant.uuid}-${meta.trackType}.${fallbackExtension}`;
			const header = createElement("div", "timeline-entry-header");
			header.append(createElement("span", "timeline-entry-label", { text: label }), link);
			wrapper.append(header);
			const metaSummary = this.describeTrackMeta(meta) || "Metadata pending";
			const metaLine = createElement("div", "upload-meta", { text: metaSummary });
			if (meta.packagingError) {
				metaLine.textContent += metaSummary ? " • fallback export" : "Fallback export";
			}
			wrapper.append(metaLine);
			const statusContainer = createElement("div", "upload-status");
			const localLine = STUDIO_DISK_FEATURE_FLAG ? this.createServiceStatusLine("local") : null;
			const dropboxLine = this.createServiceStatusLine("dropbox");
			if (localLine) {
				statusContainer.append(localLine);
			}
			statusContainer.append(dropboxLine);
			wrapper.append(statusContainer);
			this.outputsContainer.append(wrapper);
			const transferTasks = [this.queueDropboxUpload(meta, dropboxLine)];
			if (localLine) {
				transferTasks.unshift(this.queueLocalDiskWrite(meta, localLine));
			}
			uploadPromises.push(Promise.allSettled(transferTasks));
		});
		if (uploadPromises.length) {
			try {
				await Promise.allSettled(uploadPromises);
			} catch (error) {
				console.warn("One or more uploads failed", error);
			}
		}
		this.updateCloudFooter();
	}

	updateMeterFromBus(payload) {
		if (!payload?.uuid) {
			return;
		}
		const peak = payload.peak || 0;
		const level = Math.min(100, Math.round(peak * 120));
		this.roster.applyMeterValue(payload.uuid, level);
		this.updateTrackLevelVisual(payload.uuid, level);
	}

	updateCloudFooter() {
		if (this.driveStatusNode) {
			const driveText = this.cloud?.hasDriveAccess() ? "Google Drive linked" : "Drive link pending";
			this.driveStatusNode.textContent = driveText;
		}
		if (this.dropboxStatusNode) {
			const dropboxText = this.cloud?.hasDropboxAccess() ? "Dropbox linked" : "Dropbox link pending";
			this.dropboxStatusNode.textContent = dropboxText;
		}
		this.uploadProgress.refresh("dropbox");
		this.cloudLink.refresh();
		this.updateReadinessSummary();
	}

	updateReadinessSummary() {
		const driveActive = Boolean(this.cloud?.hasDriveAccess());
		const dropboxActive = Boolean(this.cloud?.hasDropboxAccess());
		const diskMeta = readDiskRecordingState();
		const diskReady = Boolean(STUDIO_DISK_FEATURE_FLAG && diskMeta.enabled && diskMeta.folderName);
		const guestBackup = this.guestBackup.getSnapshot();
		const icecastLive = Boolean(this.icecastController?.isLive());
		if (this.isoSummary) {
			this.isoSummary.style.display = driveActive || dropboxActive || diskReady || icecastLive ? "" : "none";
		}
		this.updateDestinationLights(driveActive, dropboxActive, diskReady, diskMeta, guestBackup);

		if (this.captureSummaryNode) {
			this.captureSummaryNode.textContent = `Capture: ${this.captureMode.describeCaptureMode(this.captureMode.getMode())}`;
		}
		if (this.backupSummaryNode) {
			if (!guestBackup.total) {
				this.backupSummaryNode.textContent = "Backup: No guests connected";
			} else if (!guestBackup.requested) {
				this.backupSummaryNode.textContent = "Backup: None";
			} else {
				this.backupSummaryNode.textContent = `Backup: Guest backup ${guestBackup.confirmed}/${guestBackup.total} confirmed`;
			}
		}
		if (this.saveSummaryNode) {
			this.saveSummaryNode.textContent = `Save: ${this.describeSaveTargetSummary()}`;
		}
		if (this.summaryWarningNode) {
			let warningText = "No live backup active. Host capture stays buffered until stop.";
			let warningState = "";
			if (!guestBackup.total) {
				warningText = "No guests connected yet. Host capture stays buffered until stop.";
				warningState = "pending";
			} else if (guestBackup.confirmed === guestBackup.total && guestBackup.total > 0) {
				warningText = "Live guest backup active for all connected guests.";
				warningState = "ready";
			} else if (guestBackup.requested) {
				warningText = `Live guest backup confirmed for ${guestBackup.confirmed}/${guestBackup.total}. Unconfirmed guests are not backed up yet.`;
			}
			this.summaryWarningNode.textContent = warningText;
			if (warningState) {
				this.summaryWarningNode.dataset.state = warningState;
			} else if (this.summaryWarningNode.dataset) {
				delete this.summaryWarningNode.dataset.state;
			}
		}
		if (this.cloudSummaryNode) {
			const afterSessionTargets = [];
			if (diskReady) {
				afterSessionTargets.push(`Local folder (${diskMeta.folderName})`);
			}
			if (driveActive) {
				afterSessionTargets.push("Drive");
			}
			if (dropboxActive) {
				afterSessionTargets.push("Dropbox");
			}
			if (icecastLive) {
				afterSessionTargets.push("Icecast live");
			}
			this.cloudSummaryNode.textContent = afterSessionTargets.length ? `Outputs: ${afterSessionTargets.join(" • ")}` : "After-session save: Browser buffer only";
			this.cloudSummaryNode.dataset.state = afterSessionTargets.length ? "ready" : "pending";
		}
		this.guestBackup.updateControls();
	}

	updateDestinationLights(driveActive, dropboxActive, diskReady, diskMeta, guestBackup) {
		const setLight = (key, state, statusText) => {
			const light = this.destinationLights[key];
			if (!light) return;
			light.el.dataset.state = state;
			if (light.status) light.status.textContent = statusText || "";
		};

		setLight("download", "green", "Always on");

		setLight("dropbox", dropboxActive ? "green" : "gray", dropboxActive ? "After recording" : "Not connected");

		// Drive = guest direct upload path
		if (!driveActive) {
			setLight("drive", "gray", "Not connected");
		} else if (!guestBackup.total) {
			setLight("drive", "yellow", "Connected — no guests");
		} else if (!guestBackup.requested) {
			setLight("drive", "yellow", "Connected — not enabled");
		} else if (guestBackup.confirmed === guestBackup.total) {
			setLight("drive", "green", `${guestBackup.confirmed}/${guestBackup.total} recording`);
		} else {
			setLight("drive", "yellow", `${guestBackup.confirmed}/${guestBackup.total} confirmed`);
		}

		if (STUDIO_DISK_FEATURE_FLAG) {
			if (diskReady) {
				setLight("disk", "green", diskMeta.folderName || "Ready");
			} else if (diskMeta.enabled) {
				setLight("disk", "yellow", "No folder");
			} else {
				setLight("disk", "gray", "Not set up");
			}
		}
	}

	formatFileSize(bytes) {
		if (!bytes && bytes !== 0) {
			return "";
		}
		const thresh = 1024;
		if (bytes < thresh) {
			return `${bytes} B`;
		}
		const units = ["KB", "MB", "GB", "TB"];
		let unitIndex = -1;
		let value = bytes;
		do {
			value /= thresh;
			unitIndex += 1;
		} while (value >= thresh && unitIndex < units.length - 1);
		return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
	}

	describeTrackMeta(meta) {
		const parts = [];
		if (meta?.mimeType) {
			parts.push(meta.mimeType.toUpperCase());
		}
		if (meta?.size) {
			parts.push(this.formatFileSize(meta.size));
		}
		if (meta?.durationSeconds) {
			parts.push(`${meta.durationSeconds.toFixed(1)}s`);
		}
		return parts.join(" • ");
	}

	describeService(service) {
		if (service === "drive") {
			return "Drive";
		}
		if (service === "dropbox") {
			return "Dropbox";
		}
		if (service === "local") {
			return "Local disk";
		}
		return service || "Service";
	}

	normalizeUploadStatus(service, status) {
		if (service === "drive" && status === "uploaded") {
			// Legacy Drive flows finalize asynchronously after blob handoff.
			return "queued";
		}
		return status || "unknown";
	}

	createServiceStatusLine(service) {
		const line = createElement("div", "upload-status-line");
		line.dataset.service = service;
		const ready = service === "drive" ? this.cloud?.hasDriveAccess() : service === "dropbox" ? this.cloud?.hasDropboxAccess() : service === "local" ? this.diskRecording.isDestinationReady() : false;
		const hint = ready ? (service === "local" ? "armed" : "ready") : service === "local" ? "not armed" : "link to upload";
		line.textContent = `${this.describeService(service)}: ${hint}`;
		if (service === "local") {
			line.title = ready ? "Files will be written into the armed local folder after recording stops." : "Arm local disk recording above to write files directly into the selected folder.";
		} else {
			line.title = ready ? `${this.describeService(service)} is linked; uploads will start when queued.` : `Link ${this.describeService(service)} above to enable uploads.`;
		}
		return line;
	}

	applyUploadResult(element, result) {
		if (!element || !result) {
			return;
		}
		const service = result.service || element.dataset.service;
		const label = this.describeService(service);
		const normalizedStatus = this.normalizeUploadStatus(service, result.status);
		element.dataset.status = normalizedStatus;
		if (normalizedStatus === "queued") {
			const sizeText = result.bytes ? ` (${this.formatFileSize(result.bytes)})` : "";
			element.textContent = `${label}: queued${sizeText}`;
		} else if (normalizedStatus === "uploaded") {
			const sizeText = result.bytes ? ` (${this.formatFileSize(result.bytes)})` : "";
			element.textContent = `${label}: uploaded${sizeText}`;
		} else if (normalizedStatus === "skipped") {
			element.textContent = `${label}: ${result.reason || "skipped"}`;
		} else if (normalizedStatus === "error") {
			const message = result.error?.message || result.error?.toString() || "failed";
			element.textContent = `${label}: ${message}`;
			element.dataset.status = "error";
		} else {
			element.textContent = `${label}: ${normalizedStatus}`;
		}
	}

	async saveBlobToArmedDisk(blob, filename) {
		if (!blob) {
			throw new Error("No recording blob available for disk write.");
		}
		const verify = await verifyStoredDiskRecordingDirectory({ requestPermission: false });
		if (!verify.ok) {
			throw new Error(verify.message || "Disk folder is not accessible.");
		}
		const directoryHandle = await readDiskDirectoryHandle();
		if (!directoryHandle) {
			throw new Error("No local disk folder is selected.");
		}
		const guessedExt = blob.type && blob.type.includes("/") ? (blob.type.split("/")[1] || "bin").split(";")[0] : "bin";
		const safeFilename = this.diskRecording.sanitizeFilename(filename, guessedExt);
		const fileHandle = await directoryHandle.getFileHandle(safeFilename, { create: true });
		const writable = await fileHandle.createWritable();
		try {
			await writable.write(blob);
			await writable.close();
		} catch (error) {
			try {
				await writable.abort();
			} catch (abortError) {
				console.warn("Unable to abort disk writer after failure", abortError);
			}
			throw error;
		}
		return {
			filename: safeFilename,
			bytes: blob.size || 0,
			folderName: verify.folderName || readDiskRecordingState().folderName || null
		};
	}

	async queueLocalDiskWrite(meta, localElement) {
		if (!localElement) {
			return { status: "skipped", service: "local", reason: "not-visible" };
		}
		if (!meta?.blob) {
			localElement.dataset.status = "error";
			localElement.textContent = "Local disk: missing file data";
			return { status: "error", service: "local", error: new Error("Missing recording blob") };
		}
		if (!this.diskRecording.isDestinationReady()) {
			localElement.dataset.status = "skipped";
			localElement.textContent = "Local folder: not configured (download only)";
			return { status: "skipped", service: "local", reason: "not-armed" };
		}
		localElement.dataset.status = "pending";
		localElement.textContent = "Local disk: writing…";
		try {
			const saved = await this.saveBlobToArmedDisk(meta.blob, meta.filename);
			localElement.dataset.status = "uploaded";
			const sizeText = saved.bytes ? ` (${this.formatFileSize(saved.bytes)})` : "";
			localElement.textContent = `Local disk: saved${sizeText}`;
			localElement.title = saved.folderName ? `Saved to local folder: ${saved.folderName}` : "Saved to the armed local folder.";
			return { status: "uploaded", service: "local", ...saved };
		} catch (error) {
			console.error("Failed writing recording to local disk", error);
			localElement.dataset.status = "error";
			localElement.textContent = `Local disk: ${error?.message || "write failed"}`;
			localElement.title = "Local disk write failed.";
			return { status: "error", service: "local", error };
		}
	}

	async queueDropboxUpload(meta, dropboxLine) {
		if (!this.cloud || !meta?.blob) {
			if (dropboxLine) dropboxLine.textContent = "Dropbox: unavailable";
			return;
		}
		let canDropbox = Boolean(this.cloud?.hasDropboxAccess());
		if (!canDropbox) {
			try {
				const client = await this.cloud.ensureDropboxClient();
				canDropbox = Boolean(client);
			} catch (error) {
				console.warn("Dropbox client unavailable", error);
			}
		}
		if (dropboxLine) {
			dropboxLine.textContent = `${this.describeService("dropbox")}: ${canDropbox ? "preparing upload…" : "not connected"}`;
			dropboxLine.dataset.status = canDropbox ? "pending" : "idle";
		}
		if (!canDropbox) return;

		const uploadKey = this.uploadProgress.registerTask("dropbox", meta);
		try {
			const results = await this.cloud.uploadBlob(meta.blob, {
				filename: meta.filename,
				drive: false,
				dropbox: true,
				onProgress: progress => {
					if (progress?.service === "dropbox" && dropboxLine) {
						dropboxLine.textContent = `${this.describeService("dropbox")}: ${progress.percentage || 0}%`;
						if (uploadKey) {
							this.uploadProgress.updateTask("dropbox", uploadKey, {
								uploaded: progress.uploaded,
								total: progress.total,
								status: "uploading"
							});
						}
					}
				},
				signal: this.abortUploadsController?.signal
			});
			this.applyUploadResult(dropboxLine, results.dropbox);
			if (uploadKey) {
				const status = this.normalizeUploadStatus("dropbox", results.dropbox?.status || "unknown");
				this.uploadProgress.finalizeTask("dropbox", uploadKey, status);
			}
		} catch (error) {
			console.error("Dropbox upload failed", error);
			if (dropboxLine) {
				dropboxLine.textContent = "Dropbox: upload failed";
				dropboxLine.dataset.status = "error";
			}
			if (uploadKey) {
				this.uploadProgress.finalizeTask("dropbox", uploadKey, "error");
			}
		} finally {
			this.updateCloudFooter();
		}
	}

	cleanupDownloadUrls() {
		if (!this.activeDownloadUrls || !this.activeDownloadUrls.length) {
			return;
		}
		this.activeDownloadUrls.forEach(url => {
			try {
				URL.revokeObjectURL(url);
			} catch (error) {
				console.warn("Failed to revoke object URL", error);
			}
		});
		this.activeDownloadUrls = [];
	}

	dispose() {
		this.guestBackup.dispose();
		this.roster.dispose();
		this.remoteControls.dispose();
		this.help.dispose();
		this.uploadProgress.dispose();
		this.diskRecording.dispose();
		this.inviteLink?.dispose();
		this.cloudLink?.dispose();
		this.captureMode?.dispose();
		this.stopRecordingStatusTimer();
		if (this.diskStateListener) {
			window.removeEventListener(PODCAST_DISK_EVENT, this.diskStateListener);
			this.diskStateListener = null;
		}
		if (this.levelOff) {
			this.levelOff();
			this.levelOff = null;
		}
		if (this.abortUploadsController) {
			this.abortUploadsController.abort();
			this.abortUploadsController = null;
		}
		this.icecastController?.dispose();
		this.hostMicController.dispose().catch(error => {
			console.warn("Failed to disable host microphone during dispose", error);
		});
		if (this.chatModule) {
			try {
				if (this.chatModule.dataset) {
					delete this.chatModule.dataset.podcastOverlay;
				}
				if (this.chatPlaceholder?.parentNode) {
					this.chatPlaceholder.parentNode.insertBefore(this.chatModule, this.chatPlaceholder);
					this.chatPlaceholder.parentNode.removeChild(this.chatPlaceholder);
				}
				const legacyHeader = this.chatModule.querySelector(".chat-header");
				if (legacyHeader) {
					if (legacyHeader.dataset && Object.prototype.hasOwnProperty.call(legacyHeader.dataset, "podcastDisplay")) {
						legacyHeader.style.display = legacyHeader.dataset.podcastDisplay || "";
						delete legacyHeader.dataset.podcastDisplay;
					} else {
						legacyHeader.style.display = "";
					}
				}
				const legacyResizer = this.chatModule.querySelector(".resizer");
				if (legacyResizer) {
					if (legacyResizer.dataset && Object.prototype.hasOwnProperty.call(legacyResizer.dataset, "podcastDisplay")) {
						legacyResizer.style.display = legacyResizer.dataset.podcastDisplay || "";
						delete legacyResizer.dataset.podcastDisplay;
					} else {
						legacyResizer.style.display = "";
					}
				}
				const popLink = this.chatModule.querySelector("#popOutChat");
				if (popLink) {
					popLink.style.display = "";
				}
				const closeLink = this.chatModule.querySelector("#closeChat");
				if (closeLink) {
					closeLink.style.display = "";
				}
				if (this.chatModule.style) {
					this.chatModule.style.position = "";
					this.chatModule.style.right = "";
					this.chatModule.style.left = "";
					this.chatModule.style.bottom = "";
					this.chatModule.style.top = "";
					this.chatModule.style.zIndex = "";
					this.chatModule.style.maxWidth = "";
					this.chatModule.style.width = "";
					this.chatModule.style.height = "";
					this.chatModule.style.maxHeight = "";
					this.chatModule.style.overflow = "";
					this.chatModule.style.margin = "";
				}
				this.chatModule.classList.add("hidden");
			} catch (error) {
				console.warn("Failed to restore chat module", error);
			}
			this.chatModule = null;
			this.chatPlaceholder = null;
		}
		this.chatPanel = null;
		this.chatCollapseButton = null;
		this.chatPopoutButton = null;
		this.chatPopoutAnchor = null;
		this.chatCollapsed = false;
		this.chatCollapsedHint = null;
		this.cleanupDownloadUrls();
		if (this.stopMeterBridge) {
			this.stopMeterBridge();
			this.stopMeterBridge = null;
		}
	}
}

async function bootstrap() {
	try {
		const preflight = await ensureRoomSelection();
		if (preflight?.redirect) {
			return;
		}
		const app = new PodcastStudioApp({ roomHint: preflight?.roomSlug });
		await app.init();
		window.podcastStudioApp = app;
	} catch (error) {
		console.error("Failed to initialise podcast studio", error);
	}
}

bootstrap();
