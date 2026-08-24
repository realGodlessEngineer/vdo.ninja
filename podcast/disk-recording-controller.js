import { readDiskRecordingState, isDiskRecordingEnabled, setDiskRecordingEnabled, verifyStoredDiskRecordingDirectory, chooseDiskRecordingDirectory } from "./disk-recording-store.js?v=1";
import { createElement } from "./dom-helpers.js?v=1";

// Local-disk-recording controller for the podcast studio: owns the "Local Disk"
// settings row (arm/disarm toggle, folder picker, and status text) and the disk
// destination readiness checks consumed by the recording/save pipeline. The host
// injects the studioiso feature flag and a single readiness-change seam, mounts
// buildRow() into its settings list, then drives the arm/disarm flow through
// handleFolderSelection()/handleToggle()/updateUI(), with
// ensureCaptureReadiness()/isDestinationReady()/sanitizeFilename() consumed
// elsewhere in the recording flow.
export class DiskRecordingController {
	constructor({ featureEnabled = true, onReadinessChange = () => {} } = {}) {
		this.featureEnabled = featureEnabled;
		this.onReadinessChange = onReadinessChange;

		this.controls = null;
		this.toggleButton = null;
		this.folderButton = null;
		this.statusNode = null;
		this.enabled = isDiskRecordingEnabled();
	}

	buildRow(isoConfigList) {
		if (!this.featureEnabled) {
			return;
		}
		const diskSupported = typeof window.showDirectoryPicker === "function";
		const diskRow = createElement("div", "iso-config-row");
		diskRow.append(createElement("div", "iso-config-row__label", { text: "Local Disk" }));
		const diskActions = createElement("div", "iso-config-row__actions");
		this.controls = diskActions;
		this.toggleButton = createElement("button", "iso-config-row__button", {
			type: "button",
			text: "Arm",
			title: "Arm/disarm recording ISO files to local disk."
		});
		this.toggleButton.addEventListener("click", () => this.handleToggle());
		this.folderButton = createElement("button", "iso-config-row__button iso-config-row__button--secondary", {
			type: "button",
			text: diskSupported ? "Folder" : "N/A",
			title: diskSupported ? "Choose the destination folder for disk recording." : "Local disk recording is not supported in this browser."
		});
		this.folderButton.disabled = !diskSupported;
		if (diskSupported) {
			this.folderButton.addEventListener("click", () => this.handleFolderSelection());
		}
		this.statusNode = createElement("span", "iso-config-row__status", {
			text: diskSupported ? "No folder" : "Not supported"
		});
		diskActions.append(this.toggleButton, this.folderButton, this.statusNode);
		diskRow.append(diskActions);
		isoConfigList.append(diskRow);
		this.updateUI();
	}

	async handleFolderSelection({ autoEnable = false } = {}) {
		if (!this.featureEnabled || !this.folderButton) {
			return;
		}
		if (typeof window.showDirectoryPicker !== "function") {
			this.statusNode.textContent = "Local disk recording requires Chrome, Edge, or Arc.";
			this.statusNode.dataset.state = "error";
			return;
		}
		try {
			this.folderButton.disabled = true;
			this.folderButton.textContent = "…";
			await chooseDiskRecordingDirectory();
			const result = await verifyStoredDiskRecordingDirectory({ requestPermission: true });
			if (!result.ok) {
				throw new Error(result.message || "Failed");
			}
			if (autoEnable || isDiskRecordingEnabled()) {
				setDiskRecordingEnabled(true);
				this.enabled = true;
			}
		} catch (error) {
			console.warn("Disk folder selection failed", error);
			this.statusNode.textContent = error?.name === "AbortError" || /cancel/i.test(error?.message || "") ? "Cancelled" : error?.message || "Error";
			this.statusNode.dataset.state = "error";
		} finally {
			this.folderButton.disabled = false;
			this.updateUI();
		}
	}

	async handleToggle() {
		if (!this.featureEnabled || !this.toggleButton) {
			return;
		}
		if (typeof window.showDirectoryPicker !== "function") {
			this.statusNode.textContent = "Browser lacks File System Access API support.";
			this.statusNode.dataset.state = "error";
			return;
		}
		const meta = readDiskRecordingState();
		if (!meta.folderName) {
			await this.handleFolderSelection({ autoEnable: true });
			return;
		}
		const nextEnabled = !isDiskRecordingEnabled();
		if (nextEnabled) {
			const result = await verifyStoredDiskRecordingDirectory({ requestPermission: true });
			if (!result.ok) {
				this.statusNode.textContent = result.message || "Unable to access the selected folder.";
				this.statusNode.dataset.state = "error";
				setDiskRecordingEnabled(false);
				this.enabled = false;
				this.updateUI();
				return;
			}
		}
		const finalState = setDiskRecordingEnabled(nextEnabled);
		this.enabled = Boolean(finalState.enabled);
		this.updateUI();
	}

	updateUI() {
		if (!this.featureEnabled || !this.controls) {
			return;
		}
		const diskSupported = typeof window.showDirectoryPicker === "function";
		const meta = readDiskRecordingState();
		const hasFolder = Boolean(meta.folderName);
		const enabled = Boolean(meta.enabled && hasFolder);
		this.enabled = enabled;
		if (this.toggleButton) {
			this.toggleButton.disabled = !diskSupported;
			this.toggleButton.dataset.state = enabled ? "enabled" : "disabled";
			this.toggleButton.textContent = enabled ? "Armed ✓" : "Arm";
			this.toggleButton.setAttribute("aria-pressed", enabled ? "true" : "false");
		}
		if (this.folderButton) {
			this.folderButton.disabled = !diskSupported;
			this.folderButton.textContent = hasFolder ? "Change" : diskSupported ? "Folder" : "N/A";
		}
		if (this.statusNode) {
			if (!diskSupported) {
				this.statusNode.textContent = "Requires Chrome/Edge";
				this.statusNode.dataset.state = "error";
			} else if (!hasFolder) {
				this.statusNode.textContent = "No folder selected";
				this.statusNode.dataset.state = "pending";
			} else if (meta.lastError) {
				this.statusNode.textContent = `${meta.folderName} — error`;
				this.statusNode.dataset.state = "error";
			} else {
				this.statusNode.textContent = `${meta.folderName} ✓`;
				this.statusNode.dataset.state = meta.lastVerifiedAt ? "ready" : "pending";
			}
		}
		this.onReadinessChange();
	}

	async ensureCaptureReadiness({ interactive = false } = {}) {
		if (!this.featureEnabled || !this.enabled) {
			return { enabled: false, ready: false };
		}
		const result = await verifyStoredDiskRecordingDirectory({ requestPermission: interactive });
		if (!result.ok) {
			if (this.statusNode) {
				this.statusNode.textContent = result.message || "Unable to access the selected folder.";
				this.statusNode.dataset.state = "error";
			}
			setDiskRecordingEnabled(false);
			this.enabled = false;
			this.updateUI();
			return {
				enabled: true,
				ready: false,
				error: new Error(result.message || "Folder unavailable")
			};
		}
		return {
			enabled: true,
			ready: true,
			folderName: result.folderName,
			verifiedAt: Date.now()
		};
	}

	isDestinationReady() {
		if (!this.featureEnabled) {
			return false;
		}
		const meta = readDiskRecordingState();
		return Boolean(meta.enabled && meta.folderName);
	}

	sanitizeFilename(filename, fallbackExt = "wav") {
		const fallback = `podcast-track-${Date.now()}.${fallbackExt}`;
		const input = (filename || fallback).toString();
		const safe = input
			.replace(/[\\/:*?"<>|]+/g, "-")
			.replace(/\s+/g, "_")
			.replace(/_+/g, "_")
			.replace(/^-+|-+$/g, "");
		return safe || fallback;
	}

	dispose() {
		this.controls = null;
		this.toggleButton = null;
		this.folderButton = null;
		this.statusNode = null;
	}
}
