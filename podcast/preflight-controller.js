import { readDiskRecordingState } from "./disk-recording-store.js?v=1";
import { createElement } from "./dom-helpers.js?v=1";

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

// Preflight controller for the podcast studio: owns the readiness-summary
// aggregation — the recording-summary line items, the destination "lights"
// row, the ISO-config cloud footer, and the per-service upload-status lines
// used both in the live summary and in the post-recording results list. The
// host builds the summary/lights DOM nodes inline (in buildLayout()) and
// hands them over with bindNodes(); everything else the controller needs —
// Drive/Dropbox link state, the guest-backup snapshot, Icecast live state,
// the capture-mode label, local-disk readiness, and refresh hooks for the
// upload-progress and cloud-link panels — is injected as read-only seam
// callbacks. updateReadinessSummary()/updateCloudFooter() re-render from
// that state; createServiceStatusLine()/applyUploadResult()/
// normalizeUploadStatus()/describeService() drive the per-file upload rows;
// dispose() drops the DOM node refs.
export class PreflightController {
	constructor({ hasDriveAccess = () => false, hasDropboxAccess = () => false, getGuestBackupSnapshot = () => ({ total: 0, requested: 0, confirmed: 0 }), isIcecastLive = () => false, describeCaptureMode = () => "", refreshUploadProgress = () => {}, refreshCloudLink = () => {}, isLocalDiskDestinationReady = () => false, updateGuestBackupControls = () => {}, formatFileSize = () => "" } = {}) {
		this.hasDriveAccess = hasDriveAccess;
		this.hasDropboxAccess = hasDropboxAccess;
		this.getGuestBackupSnapshot = getGuestBackupSnapshot;
		this.isIcecastLive = isIcecastLive;
		this.describeCaptureMode = describeCaptureMode;
		this.refreshUploadProgress = refreshUploadProgress;
		this.refreshCloudLink = refreshCloudLink;
		this.isLocalDiskDestinationReady = isLocalDiskDestinationReady;
		this.updateGuestBackupControls = updateGuestBackupControls;
		this.formatFileSize = formatFileSize;

		this.isoSummary = null;
		this.cloudSummaryNode = null;
		this.captureSummaryNode = null;
		this.backupSummaryNode = null;
		this.saveSummaryNode = null;
		this.summaryWarningNode = null;
		this.driveStatusNode = null;
		this.dropboxStatusNode = null;
		this.destinationLights = { download: null, drive: null, dropbox: null, disk: null };
	}

	bindNodes({ isoSummary = null, cloudSummaryNode = null, captureSummaryNode = null, backupSummaryNode = null, saveSummaryNode = null, summaryWarningNode = null, driveStatusNode = null, dropboxStatusNode = null, destinationLights = null } = {}) {
		this.isoSummary = isoSummary;
		this.cloudSummaryNode = cloudSummaryNode;
		this.captureSummaryNode = captureSummaryNode;
		this.backupSummaryNode = backupSummaryNode;
		this.saveSummaryNode = saveSummaryNode;
		this.summaryWarningNode = summaryWarningNode;
		this.driveStatusNode = driveStatusNode;
		this.dropboxStatusNode = dropboxStatusNode;
		if (destinationLights) {
			this.destinationLights = destinationLights;
		}
	}

	updateCloudFooter() {
		if (this.driveStatusNode) {
			this.driveStatusNode.textContent = this.hasDriveAccess() ? "Google Drive linked" : "Drive link pending";
		}
		if (this.dropboxStatusNode) {
			this.dropboxStatusNode.textContent = this.hasDropboxAccess() ? "Dropbox linked" : "Dropbox link pending";
		}
		this.refreshUploadProgress();
		this.refreshCloudLink();
		this.updateReadinessSummary();
	}

	updateReadinessSummary() {
		const driveActive = Boolean(this.hasDriveAccess());
		const dropboxActive = Boolean(this.hasDropboxAccess());
		const diskMeta = readDiskRecordingState();
		const diskReady = Boolean(STUDIO_DISK_FEATURE_FLAG && diskMeta.enabled && diskMeta.folderName);
		const guestBackup = this.getGuestBackupSnapshot();
		const icecastLive = Boolean(this.isIcecastLive());
		if (this.isoSummary) {
			this.isoSummary.style.display = driveActive || dropboxActive || diskReady || icecastLive ? "" : "none";
		}
		this.updateDestinationLights(driveActive, dropboxActive, diskReady, diskMeta, guestBackup);

		if (this.captureSummaryNode) {
			this.captureSummaryNode.textContent = `Capture: ${this.describeCaptureMode()}`;
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
		this.updateGuestBackupControls();
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

	describeSaveTargetSummary() {
		const driveActive = Boolean(this.hasDriveAccess());
		const dropboxActive = Boolean(this.hasDropboxAccess());
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
		const ready = service === "drive" ? this.hasDriveAccess() : service === "dropbox" ? this.hasDropboxAccess() : service === "local" ? this.isLocalDiskDestinationReady() : false;
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

	dispose() {
		this.isoSummary = null;
		this.cloudSummaryNode = null;
		this.captureSummaryNode = null;
		this.backupSummaryNode = null;
		this.saveSummaryNode = null;
		this.summaryWarningNode = null;
		this.driveStatusNode = null;
		this.dropboxStatusNode = null;
		this.destinationLights = { download: null, drive: null, dropbox: null, disk: null };
	}
}
