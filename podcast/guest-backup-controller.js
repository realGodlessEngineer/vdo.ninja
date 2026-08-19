import { createElement } from "./dom-helpers.js?v=1";

const DRIVE_PROGRESS_EVENT = "vdoninja:gdrive-progress";
const REMOTE_RECORDER_EVENT = "vdoninja:remote-recorder-status";
const DEFAULT_GUEST_BACKUP_BITRATE = 6000;
const DRIVE_STATUS_RESET_MS = 8000;
const DRIVE_REQUEST_ACK_TIMEOUT_MS = 12000;
const DRIVE_REQUEST_STALE_TIMEOUT_MS = 60000;
const DRIVE_RECORDER_HEARTBEAT_GRACE_MS = DRIVE_REQUEST_STALE_TIMEOUT_MS + 15000;
const DRIVE_STATUS_MESSAGES = {
	idle: "Drive idle",
	pending: "Drive readying…",
	uploading: "Drive uploading…",
	done: "Drive upload complete",
	error: "Drive upload error"
};

// Guest → Drive backup controller for the podcast studio: owns the per-guest
// "Guest → Drive" roster buttons and their upload/heartbeat state machine, the
// "Enable guest backup" summary row, and the window listeners for guest recorder
// progress. The host injects the participant list, a Drive-linked probe, and two
// readiness callbacks, then mounts buildRow() into its settings list and hooks the
// roster lifecycle through createRosterControl()/teardownRosterControl().
export class GuestBackupController {
	constructor({ getParticipants = () => [], hasDriveAccess = () => false, onReadinessChange = () => {}, onRecordingStatusChange = () => {} } = {}) {
		this.getParticipants = getParticipants;
		this.hasDriveAccess = hasDriveAccess;
		this.onReadinessChange = onReadinessChange;
		this.onRecordingStatusChange = onRecordingStatusChange;

		this.buttons = new Map();
		this.statuses = new Map();
		this.statusResetTimers = new Map();
		this.requestTimers = new Map();
		this.recorderStates = new Map();
		this.progressSnapshots = new Map();

		this.row = null;
		this.hint = null;
		this.toggleButton = null;
		this.summaryStatusNode = null;
		this.busy = false;

		this.boundProgressHandler = null;
		this.boundRemoteRecorderHandler = null;
		this.attachEvents();
	}

	attachEvents() {
		if (typeof window === "undefined") {
			return;
		}
		this.boundProgressHandler = event => this.handleProgressEvent(event);
		window.addEventListener(DRIVE_PROGRESS_EVENT, this.boundProgressHandler);
		this.boundRemoteRecorderHandler = event => this.handleRemoteRecorderStatus(event);
		window.addEventListener(REMOTE_RECORDER_EVENT, this.boundRemoteRecorderHandler);
	}

	buildRow() {
		this.row = createElement("div", "iso-config-row");
		this.row.append(createElement("div", "iso-config-row__label", { text: "Guest backup" }));
		const actions = createElement("div", "iso-config-row__actions");
		this.toggleButton = createElement("button", "iso-config-row__button iso-config-row__button--backup", {
			type: "button",
			text: "Enable guest backup",
			title: "Ask every connected guest to self-record directly to your linked Google Drive."
		});
		this.toggleButton.addEventListener("click", () => this.handleBackupToggle());
		this.summaryStatusNode = createElement("span", "iso-config-row__status", { text: "No guests connected" });
		actions.append(this.toggleButton, this.summaryStatusNode);
		this.row.append(actions);
		this.hint = null;
		this.row.style.display = "none";
		return this.row;
	}

	getParticipantState(uuid) {
		const legacyButton = this.findLegacyButton(uuid);
		const pressed = Boolean(legacyButton?.classList?.contains("pressed"));
		const snapshot = this.progressSnapshots.get(uuid);
		const heartbeat = this.isHeartbeatActive(uuid);
		const status = this.statuses.get(uuid)?.dataset?.state || "idle";
		const requested = pressed || heartbeat || Boolean(snapshot) || this.requestTimers.has(uuid) || status === "pending" || status === "uploading";
		const confirmed = heartbeat || Boolean(snapshot);
		return {
			uuid,
			pressed,
			snapshot,
			heartbeat,
			status,
			requested,
			confirmed,
			error: status === "error"
		};
	}

	getSnapshot() {
		const participants = this.getParticipants().map(participant => ({
			participant,
			...this.getParticipantState(participant.uuid)
		}));
		const total = participants.length;
		const requested = participants.filter(entry => entry.requested).length;
		const confirmed = participants.filter(entry => entry.confirmed).length;
		const errors = participants.filter(entry => entry.error).length;
		return {
			participants,
			total,
			requested,
			confirmed,
			pending: Math.max(requested - confirmed, 0),
			errors,
			linked: Boolean(this.hasDriveAccess())
		};
	}

	getCompactLabel() {
		const snapshot = this.getSnapshot();
		if (!snapshot.total) {
			return "No guests";
		}
		if (!snapshot.requested) {
			return "No live backup";
		}
		return `Guest backup ${snapshot.confirmed}/${snapshot.total}`;
	}

	updateControls() {
		if (!this.toggleButton || !this.summaryStatusNode) {
			return;
		}
		const snapshot = this.getSnapshot();
		if (this.row) {
			const visible = snapshot.total > 0;
			this.row.style.display = visible ? "" : "none";
			if (this.hint) this.hint.style.display = visible ? "" : "none";
		}
		const linked = snapshot.linked;
		const hasGuests = snapshot.total > 0;
		const hasRequested = snapshot.requested > 0;
		const allRequested = hasGuests && snapshot.requested === snapshot.total;
		const hasPartial = linked && snapshot.requested > 0 && snapshot.requested < snapshot.total;
		this.toggleButton.disabled = this.busy || !hasGuests || (!linked && !hasRequested);
		this.toggleButton.dataset.state = allRequested ? "enabled" : "idle";
		if (!hasGuests) {
			this.toggleButton.textContent = "Enable guest backup";
			this.toggleButton.title = "A guest must join before backup can be enabled.";
			this.summaryStatusNode.textContent = "No guests connected";
			this.summaryStatusNode.dataset.state = "idle";
			return;
		}
		if (!linked && !hasRequested) {
			this.toggleButton.textContent = "Enable guest backup";
			this.toggleButton.title = "Link Google Drive first to enable guest backup.";
			this.summaryStatusNode.textContent = "Link Google Drive first";
			this.summaryStatusNode.dataset.state = "error";
			return;
		}
		if (allRequested || (!linked && hasRequested)) {
			this.toggleButton.textContent = "Disable guest backup";
			this.toggleButton.title = "Stop guest-side backup recording for all connected guests.";
		} else if (hasPartial) {
			this.toggleButton.textContent = "Enable missing backups";
			this.toggleButton.title = "Enable backup recording for guests not yet confirmed.";
		} else {
			this.toggleButton.textContent = "Enable guest backup";
			this.toggleButton.title = "Ask every connected guest to self-record directly to your linked Google Drive.";
		}
		if (!snapshot.requested) {
			this.summaryStatusNode.textContent = `Ready for ${snapshot.total} guest${snapshot.total === 1 ? "" : "s"}`;
			this.summaryStatusNode.dataset.state = "idle";
		} else if (snapshot.confirmed === snapshot.total) {
			this.summaryStatusNode.textContent = `${snapshot.confirmed}/${snapshot.total} confirmed`;
			this.summaryStatusNode.dataset.state = "ready";
		} else {
			this.summaryStatusNode.textContent = `${snapshot.confirmed}/${snapshot.total} confirmed`;
			this.summaryStatusNode.dataset.state = snapshot.errors ? "error" : "pending";
		}
	}

	createRosterControl(participant) {
		if (!participant || participant.role === "host-mic" || !participant.uuid) {
			return null;
		}
		if (typeof window === "undefined" || typeof window.requestGoogleDriveRecord !== "function") {
			return null;
		}
		const button = createElement("button", "roster-action-button roster-action-button--drive", {
			type: "button",
			text: "Guest → Drive",
			title: "Record guest to Google Drive (video + audio)"
		});
		button.dataset.uuid = participant.uuid;
		button.addEventListener("click", () => this.handleRecordToggle(participant.uuid));

		const status = createElement("div", "roster-drive-status", { text: DRIVE_STATUS_MESSAGES.idle });
		status.dataset.state = "idle";
		status.dataset.uuid = participant.uuid;

		this.buttons.set(participant.uuid, button);
		this.statuses.set(participant.uuid, status);
		this.updateActionAvailability(participant.uuid);
		this.applyRosterSnapshot(participant.uuid);

		return { button, status };
	}

	teardownRosterControl(uuid) {
		if (!uuid) {
			return;
		}
		this.clearRequestTimers(uuid);
		if (this.statusResetTimers.has(uuid)) {
			clearTimeout(this.statusResetTimers.get(uuid));
			this.statusResetTimers.delete(uuid);
		}
		this.buttons.delete(uuid);
		this.statuses.delete(uuid);
		this.recorderStates.delete(uuid);
		this.progressSnapshots.delete(uuid);
	}

	clearRequestTimers(uuid) {
		if (!uuid) {
			return;
		}
		const timers = this.requestTimers.get(uuid);
		if (!timers) {
			return;
		}
		if (timers.ack) {
			clearTimeout(timers.ack);
		}
		if (timers.stale) {
			clearTimeout(timers.stale);
		}
		this.requestTimers.delete(uuid);
	}

	isHeartbeatActive(uuid) {
		const state = this.recorderStates.get(uuid);
		if (!state) {
			return false;
		}
		if (!(state.code >= 0 || state.code === -5 || state.code === -2)) {
			return false;
		}
		if (!state.at) {
			return true;
		}
		return Date.now() - state.at <= DRIVE_RECORDER_HEARTBEAT_GRACE_MS;
	}

	scheduleRequestWatchdog(uuid) {
		if (!uuid) {
			return;
		}
		this.clearRequestTimers(uuid);
		const timers = {
			ack: null,
			stale: null
		};
		timers.ack = setTimeout(() => {
			const latestSnapshot = this.progressSnapshots.get(uuid);
			if (latestSnapshot) {
				this.setRosterStatusFromSnapshot(uuid, latestSnapshot);
				return;
			}
			const legacyButton = this.findLegacyButton(uuid);
			const pressed = Boolean(legacyButton?.classList?.contains("pressed"));
			this.setRosterStatus(uuid, "pending", pressed ? "Drive requested. Waiting for guest recorder to start…" : "Drive request sent. Waiting for guest to confirm recording permission…");
			const runStaleCheck = () => {
				const staleSnapshot = this.progressSnapshots.get(uuid);
				if (staleSnapshot) {
					this.setRosterStatusFromSnapshot(uuid, staleSnapshot);
					return;
				}
				const stillPressed = Boolean(this.findLegacyButton(uuid)?.classList?.contains("pressed"));
				if (this.isHeartbeatActive(uuid)) {
					this.setRosterStatus(uuid, "pending", "Guest recorder is active. Waiting for Drive upload stats…");
					timers.stale = setTimeout(runStaleCheck, DRIVE_REQUEST_STALE_TIMEOUT_MS);
					this.requestTimers.set(uuid, timers);
					return;
				}
				if (!stillPressed) {
					this.setRosterStatus(uuid, "error", "Guest did not confirm Drive recording.");
					this.updateActionAvailability(uuid);
				} else {
					this.setRosterStatus(uuid, "error", "Drive upload never started. Ask guest to allow recording and retry.");
					this.updateActionAvailability(uuid);
				}
				this.clearRequestTimers(uuid);
			};
			timers.stale = setTimeout(runStaleCheck, DRIVE_REQUEST_STALE_TIMEOUT_MS);
			this.requestTimers.set(uuid, timers);
		}, DRIVE_REQUEST_ACK_TIMEOUT_MS);
		this.requestTimers.set(uuid, timers);
	}

	reconcileRequestOutcome(uuid) {
		if (!uuid) {
			return;
		}
		const latestSnapshot = this.progressSnapshots.get(uuid);
		if (latestSnapshot) {
			this.setRosterStatusFromSnapshot(uuid, latestSnapshot);
			return;
		}
		const legacyButton = this.findLegacyButton(uuid);
		const pressed = Boolean(legacyButton?.classList?.contains("pressed"));
		if (pressed) {
			this.setRosterStatus(uuid, "pending", "Drive request sent. Waiting for upload telemetry…");
			return;
		}
		this.setRosterStatus(uuid, "error", "Drive upload not started. Retry and have the guest accept the recording prompt.");
	}

	findLegacyButton(uuid) {
		if (!uuid || typeof document === "undefined") {
			return null;
		}
		return document.querySelector('[data-action-type="recorder-google-drive-remote"][data--u-u-i-d="' + uuid + '"]');
	}

	canTriggerUpload() {
		if (typeof window === "undefined" || typeof window.requestGoogleDriveRecord !== "function") {
			return false;
		}
		return Boolean(this.hasDriveAccess());
	}

	async handleBackupToggle() {
		const snapshot = this.getSnapshot();
		if (!snapshot.total) {
			this.updateControls();
			this.onReadinessChange();
			return;
		}
		if (!this.canTriggerUpload()) {
			if (this.summaryStatusNode) {
				this.summaryStatusNode.textContent = "Link Google Drive first";
				this.summaryStatusNode.dataset.state = "error";
			}
			this.onReadinessChange();
			return;
		}
		const stopTargets = snapshot.participants.filter(entry => entry.requested).map(entry => entry.uuid);
		const armTargets = snapshot.participants.filter(entry => !entry.requested).map(entry => entry.uuid);
		const stopping = snapshot.requested === snapshot.total;
		const targets = stopping ? stopTargets : armTargets;
		if (!targets.length) {
			this.updateControls();
			this.onReadinessChange();
			return;
		}
		this.busy = true;
		this.updateControls();
		try {
			if (stopping) {
				for (const uuid of targets) {
					// Reuse the existing per-guest stop path so the legacy UI stays in sync.
					await this.handleRecordToggle(uuid);
				}
			} else {
				for (const uuid of targets) {
					await this.handleRecordToggle(uuid, { bitrate: DEFAULT_GUEST_BACKUP_BITRATE });
				}
			}
		} finally {
			this.busy = false;
			this.updateControls();
			this.onReadinessChange();
			this.onRecordingStatusChange();
		}
	}

	async handleRecordToggle(uuid, { bitrate = null } = {}) {
		if (!uuid) {
			return;
		}
		const button = this.buttons.get(uuid);
		if (!button) {
			return;
		}
		if (typeof window === "undefined" || typeof window.requestGoogleDriveRecord !== "function") {
			this.setRosterStatus(uuid, "error", "Drive controls unavailable in this build.");
			return;
		}
		const legacyButton = this.findLegacyButton(uuid);
		if (!legacyButton) {
			this.setRosterStatus(uuid, "pending", "Guest controls preparing…");
			this.updateActionAvailability(uuid);
			return;
		}
		const isActive = legacyButton.classList?.contains("pressed");
		if (!isActive && !this.canTriggerUpload()) {
			this.setRosterStatus(uuid, "error", "Link Google Drive above to enable uploads.");
			this.updateActionAvailability(uuid);
			return;
		}
		button.dataset.pending = "true";
		button.disabled = true;
		try {
			if (isActive) {
				this.clearRequestTimers(uuid);
				this.recorderStates.delete(uuid);
				await window.requestGoogleDriveRecord(legacyButton, false);
				this.setRosterStatus(uuid, "idle", DRIVE_STATUS_MESSAGES.idle);
			} else {
				// Drop any stale snapshot from a prior upload so a new request must
				// wait for fresh telemetry before reconciling success/failure.
				this.progressSnapshots.delete(uuid);
				this.recorderStates.delete(uuid);
				this.setRosterStatus(uuid, "pending", "Requesting Drive upload…");
				await window.requestGoogleDriveRecord(legacyButton, true, bitrate);
				const started = Boolean(legacyButton.classList?.contains("pressed")) || Boolean(this.progressSnapshots.get(uuid)) || this.isHeartbeatActive(uuid);
				if (started) {
					this.scheduleRequestWatchdog(uuid);
					this.reconcileRequestOutcome(uuid);
				} else {
					this.setRosterStatus(uuid, "idle", DRIVE_STATUS_MESSAGES.idle);
				}
			}
		} catch (error) {
			this.clearRequestTimers(uuid);
			const message = error?.message || "Drive request cancelled";
			this.setRosterStatus(uuid, "error", message);
		} finally {
			button.dataset.pending = "false";
			this.updateActionAvailability(uuid);
			this.onReadinessChange();
			this.onRecordingStatusChange();
		}
	}

	updateActionAvailability(uuid) {
		const button = this.buttons.get(uuid);
		if (!button) {
			return;
		}
		const hasRequestApi = typeof window !== "undefined" && typeof window.requestGoogleDriveRecord === "function";
		const legacyButton = this.findLegacyButton(uuid);
		const hasLegacyControl = Boolean(legacyButton);
		const isActive = Boolean(legacyButton?.classList?.contains("pressed"));
		const pending = button.dataset.pending === "true";

		let disabled = pending || !hasRequestApi;
		let title = "";

		if (!hasRequestApi) {
			title = "Drive controls are not available in this build.";
		} else if (!hasLegacyControl) {
			title = "Guest controls are still initialising.";
			disabled = true;
		} else if (isActive) {
			title = "Stop this guest’s Drive upload.";
			disabled = pending;
		} else if (!this.canTriggerUpload()) {
			title = "Link Google Drive above to enable uploads.";
			disabled = true;
		} else {
			title = "Ask this guest to upload to Drive.";
			disabled = pending;
		}

		button.disabled = disabled;
		button.textContent = isActive ? "Stop Guest → Drive" : "Guest → Drive";
		button.dataset.state = isActive ? "active" : "idle";
		if (title) {
			button.title = title;
		}
	}

	updateAllActions() {
		this.buttons.forEach((_, uuid) => this.updateActionAvailability(uuid));
	}

	setRosterStatus(uuid, state = "idle", text) {
		const node = this.statuses.get(uuid);
		if (!node) {
			return;
		}
		if (this.statusResetTimers.has(uuid)) {
			clearTimeout(this.statusResetTimers.get(uuid));
			this.statusResetTimers.delete(uuid);
		}
		const label = text || DRIVE_STATUS_MESSAGES[state] || DRIVE_STATUS_MESSAGES.idle;
		node.dataset.state = state;
		node.textContent = label;
		if (state === "done" || state === "idle" || state === "error") {
			this.clearRequestTimers(uuid);
		}
		if (state === "done") {
			const timer = setTimeout(() => {
				this.setRosterStatus(uuid, "idle", DRIVE_STATUS_MESSAGES.idle);
				this.statusResetTimers.delete(uuid);
			}, DRIVE_STATUS_RESET_MS);
			this.statusResetTimers.set(uuid, timer);
		}
		this.updateControls();
		this.onReadinessChange();
		this.onRecordingStatusChange();
	}

	applyRosterSnapshot(uuid) {
		const snapshot = this.progressSnapshots.get(uuid);
		if (!snapshot) {
			return;
		}
		this.setRosterStatusFromSnapshot(uuid, snapshot);
	}

	setRosterStatusFromSnapshot(uuid, gdrive) {
		if (!gdrive) {
			this.setRosterStatus(uuid, "idle", DRIVE_STATUS_MESSAGES.idle);
			return;
		}
		this.clearRequestTimers(uuid);
		if (gdrive.state === 2) {
			this.setRosterStatus(uuid, "done", DRIVE_STATUS_MESSAGES.done);
			return;
		}
		if (typeof gdrive.rec === "number" && gdrive.rec > 0) {
			const percent = Math.min(100, Math.round((gdrive.up / Math.max(1, gdrive.rec)) * 100));
			this.setRosterStatus(uuid, "uploading", `Drive upload ${percent}%`);
		} else {
			this.setRosterStatus(uuid, "pending", DRIVE_STATUS_MESSAGES.pending);
		}
	}

	handleProgressEvent(event) {
		const detail = event?.detail;
		if (!detail || !detail.UUID) {
			return;
		}
		const { UUID: uuid, gdrive } = detail;
		this.progressSnapshots.set(uuid, gdrive || null);
		if (!this.statuses.has(uuid)) {
			return;
		}
		this.setRosterStatusFromSnapshot(uuid, gdrive || null);
		this.updateActionAvailability(uuid);
		this.onReadinessChange();
		this.onRecordingStatusChange();
	}

	handleRemoteRecorderStatus(event) {
		const detail = event?.detail;
		if (!detail || !detail.UUID) {
			return;
		}
		const { UUID: uuid, recorder, screen } = detail;
		if (screen || !this.statuses.has(uuid)) {
			return;
		}
		const legacyDriveButton = this.findLegacyButton(uuid);
		const hasWatchdog = this.requestTimers.has(uuid);
		const drivePressed = Boolean(legacyDriveButton?.classList?.contains("pressed"));
		const currentState = this.statuses.get(uuid)?.dataset?.state || "idle";
		const driveStateActive = currentState === "pending" || currentState === "uploading";
		if (!hasWatchdog && !drivePressed && !driveStateActive) {
			// Ignore generic remote-recorder updates unless Drive was actually requested/active.
			return;
		}
		const code = parseInt(recorder, 10);
		if (!Number.isFinite(code)) {
			return;
		}
		this.recorderStates.set(uuid, { code, at: Date.now() });
		if (code >= 0) {
			if (!this.progressSnapshots.get(uuid)) {
				const minutes = Math.floor(code / 60);
				const seconds = Math.max(0, code - minutes * 60)
					.toString()
					.padStart(2, "0");
				this.setRosterStatus(uuid, "pending", `Guest recording ${minutes}m ${seconds}s… waiting for Drive stats`);
			}
			this.updateActionAvailability(uuid);
			return;
		}
		if (code === -5) {
			this.setRosterStatus(uuid, "pending", "Guest recorder started with experimental browser support.");
		} else if (code === -4) {
			this.setRosterStatus(uuid, "error", "Guest recording stopped unexpectedly.");
		} else if (code === -3) {
			this.setRosterStatus(uuid, "error", "Guest browser cannot record/upload to Drive.");
		} else if (code === -2) {
			this.setRosterStatus(uuid, "pending", "Guest recorder stopping…");
		} else if (code === -1) {
			const snapshot = this.progressSnapshots.get(uuid);
			if (snapshot) {
				this.setRosterStatusFromSnapshot(uuid, snapshot);
			} else if (hasWatchdog || drivePressed || driveStateActive) {
				this.setRosterStatus(uuid, "error", "Guest recorder stopped before Drive upload telemetry started.");
			} else {
				this.setRosterStatus(uuid, "idle", DRIVE_STATUS_MESSAGES.idle);
			}
		}
		this.updateActionAvailability(uuid);
		this.onReadinessChange();
		this.onRecordingStatusChange();
	}

	dispose() {
		this.requestTimers.forEach((_timers, uuid) => {
			this.clearRequestTimers(uuid);
		});
		if (typeof window !== "undefined") {
			if (this.boundProgressHandler) {
				window.removeEventListener(DRIVE_PROGRESS_EVENT, this.boundProgressHandler);
				this.boundProgressHandler = null;
			}
			if (this.boundRemoteRecorderHandler) {
				window.removeEventListener(REMOTE_RECORDER_EVENT, this.boundRemoteRecorderHandler);
				this.boundRemoteRecorderHandler = null;
			}
		}
		this.buttons.clear();
		this.statuses.clear();
		this.recorderStates.clear();
		this.progressSnapshots.clear();
		this.statusResetTimers.forEach(timer => clearTimeout(timer));
		this.statusResetTimers.clear();
	}
}
