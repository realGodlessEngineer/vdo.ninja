import { createElement, makeCollapsible } from "./dom-helpers.js?v=1";

const ROSTER_REFRESH_MS = 1500;

// Talent-roster controller for the podcast studio: owns the "Talent Roster" panel
// UI, the per-participant roster items and their audio meters, and the refresh
// interval that reconciles the visible list against the live participant array.
// The host injects the session, the merged participant list, guest-backup control
// factories, and a set of lifecycle callbacks (metrics capture, recording add,
// remote-control open, overlay teardown, readiness refresh), then mounts the panel
// via buildPanel() and drives it through refresh()/startLoop()/dispose().
export class RosterController {
	constructor({ getSession = () => null, getParticipants = () => [], createGuestBackupControl = () => null, teardownGuestBackupControl = () => {}, updateGuestBackupAvailability = () => {}, onOpenRemoteControls = () => {}, onParticipantSeen = () => {}, onParticipantAdded = () => {}, onParticipantRemoved = () => {}, onBeforeRefresh = () => {}, onAfterRefresh = () => {} } = {}) {
		this.getSession = getSession;
		this.getParticipants = getParticipants;
		this.createGuestBackupControl = createGuestBackupControl;
		this.teardownGuestBackupControl = teardownGuestBackupControl;
		this.updateGuestBackupAvailability = updateGuestBackupAvailability;
		this.onOpenRemoteControls = onOpenRemoteControls;
		this.onParticipantSeen = onParticipantSeen;
		this.onParticipantAdded = onParticipantAdded;
		this.onParticipantRemoved = onParticipantRemoved;
		this.onBeforeRefresh = onBeforeRefresh;
		this.onAfterRefresh = onAfterRefresh;

		this.rosterItems = new Map();
		this.meterValues = new Map();
		this.rosterList = null;
		this.rosterTimer = null;
	}

	buildPanel() {
		const rosterPanel = createElement("section", "podcast-panel");
		this.rosterList = createElement("div", "roster-list");
		rosterPanel.append(this.rosterList);
		makeCollapsible(rosterPanel, "Talent Roster", "podcastStudio.collapse.roster");
		return rosterPanel;
	}

	startLoop() {
		if (this.rosterTimer) {
			clearInterval(this.rosterTimer);
		}
		this.rosterTimer = setInterval(() => this.refresh(), ROSTER_REFRESH_MS);
	}

	refresh() {
		if (!this.getSession()) {
			return;
		}
		this.onBeforeRefresh();
		const participants = this.getParticipants();
		const activeIds = new Set();

		participants.forEach(participant => {
			activeIds.add(participant.uuid);
			this.onParticipantSeen(participant);
			const existing = this.rosterItems.get(participant.uuid);
			if (existing) {
				this.updateItem(existing, participant);
			} else {
				const item = this.createItem(participant);
				this.rosterItems.set(participant.uuid, item);
				this.rosterList.append(item);
				// Add new participant to active recording
				this.onParticipantAdded(participant);
			}
		});

		Array.from(this.rosterItems.keys()).forEach(uuid => {
			if (!activeIds.has(uuid)) {
				const node = this.rosterItems.get(uuid);
				if (node?.parentNode) {
					node.parentNode.removeChild(node);
				}
				this.rosterItems.delete(uuid);
				this.meterValues.delete(uuid);
				this.teardownGuestBackupControl(uuid);
				this.onParticipantRemoved(uuid);
			}
		});
		this.onAfterRefresh();
	}

	createItem(participant) {
		const item = createElement("div", "roster-item");
		item.dataset.uuid = participant.uuid;
		item.dataset.status = participant.status || "connecting";
		if (participant.role) {
			item.dataset.role = participant.role;
		}

		// Video thumbnail for guest preview
		const videoThumb = document.createElement("video");
		videoThumb.className = "roster-item__video-thumb";
		videoThumb.muted = true;
		videoThumb.playsInline = true;
		videoThumb.autoplay = true;
		videoThumb.dataset.noVideo = "true"; // hidden by default until video track available

		const meta = createElement("div", "roster-meta");
		meta.append(createElement("div", "roster-name", { text: participant.label }));
		const idText = participant.streamID ? `Stream: ${participant.streamID}` : "Awaiting stream";
		meta.append(createElement("div", "roster-id", { text: idText }));
		const descriptorText = this.describeParticipantRole(participant);
		if (descriptorText) {
			meta.append(createElement("div", "roster-role", { text: descriptorText }));
		}

		const meter = createElement("div", "meter-bar", { "data-meter": participant.uuid });
		meter.append(createElement("div", "meter-bar-fill"));

		const mediaRow = createElement("div", "roster-item__media-row");
		mediaRow.append(videoThumb, meter);

		item.append(meta, mediaRow);

		const actions = createElement("div", "roster-actions");
		const actionRow = createElement("div", "roster-action-row");
		let hasActions = false;
		if (participant.role !== "host-mic") {
			const controlButton = createElement("button", "roster-action-button", {
				type: "button",
				text: "Remote Controls",
				title: "Open legacy remote controls for this guest."
			});
			controlButton.addEventListener("click", () => this.onOpenRemoteControls(participant.uuid));
			actionRow.append(controlButton);
			hasActions = true;
		}
		const driveControls = this.createGuestBackupControl(participant);
		if (driveControls) {
			actionRow.append(driveControls.button);
			hasActions = true;
		}
		if (hasActions) {
			if (driveControls?.status) {
				actionRow.append(driveControls.status);
			}
			actions.append(actionRow);
			item.append(actions);
		}

		this.updateItem(item, participant);
		return item;
	}

	updateItem(item, participant) {
		item.dataset.status = participant.status || "connecting";
		const name = item.querySelector(".roster-name");
		if (name) {
			name.textContent = participant.label;
		}
		const id = item.querySelector(".roster-id");
		if (id) {
			id.textContent = participant.streamID ? `Stream: ${participant.streamID}` : "Awaiting stream";
		}
		item.dataset.role = participant.role || "";
		const descriptor = item.querySelector(".roster-role");
		if (descriptor) {
			const descriptorText = this.describeParticipantRole(participant);
			descriptor.textContent = descriptorText || "";
			descriptor.style.display = descriptorText ? "" : "none";
		}
		this.applyMeterValue(participant.uuid, participant.audioLevel || 0);
		this.updateGuestBackupAvailability(participant.uuid);

		// Update video thumbnail if available
		const videoThumb = item.querySelector(".roster-item__video-thumb");
		const session = this.getSession();
		if (videoThumb && session?.rpcs) {
			const peer = session.rpcs[participant.uuid];
			const videoTracks = peer?.streamSrc?.getVideoTracks?.() || [];
			if (videoTracks.length > 0) {
				if (!videoThumb.srcObject || videoThumb.srcObject.getVideoTracks()[0]?.id !== videoTracks[0].id) {
					videoThumb.srcObject = new MediaStream(videoTracks);
				}
				videoThumb.dataset.noVideo = "false";
			} else {
				if (videoThumb.srcObject) {
					videoThumb.srcObject = null;
				}
				videoThumb.dataset.noVideo = "true";
			}
		}
	}

	describeParticipantRole(participant) {
		if (!participant) {
			return "";
		}
		if (participant.role === "host-mic") {
			return "Local recording input";
		}
		return "";
	}

	applyMeterValue(uuid, value) {
		const percent = Math.min(100, Math.max(0, value));
		this.meterValues.set(uuid, percent);
		if (!this.rosterList) {
			return;
		}
		const meter = this.rosterList.querySelector(`[data-meter="${uuid}"] .meter-bar-fill`);
		if (meter) {
			meter.style.width = `${percent}%`;
		}
	}

	getItem(uuid) {
		return this.rosterItems.get(uuid) || null;
	}

	dispose() {
		if (this.rosterTimer) {
			clearInterval(this.rosterTimer);
			this.rosterTimer = null;
		}
		this.rosterItems.clear();
		this.meterValues.clear();
	}
}
