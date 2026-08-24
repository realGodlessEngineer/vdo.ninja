import { readCloudLinkStatus, isCloudLinkFresh, markCloudLinked, markCloudUnlinked } from "./cloud-link-store.js?v=1";
import { createElement } from "./dom-helpers.js?v=1";

const PODCAST_CLOUD_EVENT = "podcast-cloud-status";
const DROPBOX_GUIDE_URL = "/cloud.html#dropbox";

// Cloud-link controller for the podcast studio: owns the "Google Drive" and
// "Dropbox" connect rows in the recording-settings list — their connect/reconnect
// buttons, status text, inline hint messages, and the Dropbox access-token
// fallback field. The host injects a CloudUploadCoordinator accessor, the
// recording flag (which disables the buttons mid-session), a Drive folder-name
// getter, and three refresh seams (readiness, cloud footer, and guest-backup
// controls). It mounts buildPanel() into the settings list, re-renders link state
// through refresh(), and drives the Drive/Dropbox authorization flows via
// handleDriveLink()/handleDropboxLink(); dispose() drops the cloud-status window
// listener and DOM refs.
export class CloudLinkController {
	constructor({ getCloud = () => null, isRecording = () => false, getDriveFolderName = () => null, onStatusChange = () => {}, refreshCloudFooter = () => {}, refreshGuestBackupControls = () => {} } = {}) {
		this.getCloud = getCloud;
		this.isRecording = isRecording;
		this.getDriveFolderName = getDriveFolderName;
		this.onStatusChange = onStatusChange;
		this.refreshCloudFooter = refreshCloudFooter;
		this.refreshGuestBackupControls = refreshGuestBackupControls;

		this.cloudBusy = {
			drive: false,
			dropbox: false
		};
		this.cloudLinkButtons = {
			drive: null,
			dropbox: null
		};
		this.cloudLinkStatusNodes = {
			drive: null,
			dropbox: null
		};
		this.cloudLinkMessages = {
			drive: null,
			dropbox: null
		};
		this.cloudLinkMessageTextNodes = {
			drive: null,
			dropbox: null
		};
		this.dropboxTokenInput = null;
		this.dropboxTokenRow = null;
		this.dropboxGuideRow = null;

		this.boundCloudStateHandler = null;
		this.attachEvents();
	}

	attachEvents() {
		if (typeof window === "undefined") {
			return;
		}
		this.boundCloudStateHandler = () => this.onStatusChange();
		window.addEventListener(PODCAST_CLOUD_EVENT, this.boundCloudStateHandler);
	}

	buildPanel() {
		const fragment = document.createDocumentFragment();

		// Google Drive row
		const driveRow = createElement("div", "iso-config-row");
		driveRow.append(createElement("div", "iso-config-row__label", { text: "Google Drive" }));
		const driveActions = createElement("div", "iso-config-row__actions");
		this.cloudLinkButtons.drive = createElement("button", "iso-config-row__button", { type: "button", text: "Connect", title: "Connect Google Drive to upload recordings automatically after each session." });
		this.cloudLinkButtons.drive.addEventListener("click", () => this.handleDriveLink());
		this.cloudLinkButtons.drive.dataset.state = "idle";
		this.cloudLinkStatusNodes.drive = createElement("span", "iso-config-row__status", { text: "Not connected" });
		this.cloudLinkStatusNodes.drive.dataset.state = "idle";
		driveActions.append(this.cloudLinkButtons.drive, this.cloudLinkStatusNodes.drive);
		driveRow.append(driveActions);
		this.cloudLinkMessages.drive = createElement("div", "iso-config-row__hint");
		this.cloudLinkMessages.drive.dataset.variant = "";
		const driveMessageText = createElement("span", "iso-config-row__hint-text");
		this.cloudLinkMessages.drive.append(driveMessageText);
		this.cloudLinkMessageTextNodes.drive = driveMessageText;
		fragment.append(driveRow, this.cloudLinkMessages.drive);

		// Dropbox row
		const dropboxRow = createElement("div", "iso-config-row");
		dropboxRow.append(createElement("div", "iso-config-row__label", { text: "Dropbox" }));
		const dropboxActions = createElement("div", "iso-config-row__actions");
		this.cloudLinkButtons.dropbox = createElement("button", "iso-config-row__button", { type: "button", text: "Connect", title: "Connect Dropbox to upload recordings automatically after each session." });
		this.cloudLinkButtons.dropbox.addEventListener("click", () => this.handleDropboxLink());
		this.cloudLinkButtons.dropbox.dataset.state = "idle";
		this.cloudLinkStatusNodes.dropbox = createElement("span", "iso-config-row__status", { text: "Not connected" });
		this.cloudLinkStatusNodes.dropbox.dataset.state = "idle";
		dropboxActions.append(this.cloudLinkButtons.dropbox, this.cloudLinkStatusNodes.dropbox);
		dropboxRow.append(dropboxActions);
		this.cloudLinkMessages.dropbox = createElement("div", "iso-config-row__hint");
		this.cloudLinkMessages.dropbox.dataset.variant = "";
		const dropboxMessageText = createElement("span", "iso-config-row__hint-text");
		this.cloudLinkMessages.dropbox.append(dropboxMessageText);
		this.cloudLinkMessageTextNodes.dropbox = dropboxMessageText;
		const tokenFieldId = "podcast-dropbox-token";
		const dropboxTokenRow = createElement("div", "cloud-sync-token");
		this.dropboxTokenRow = dropboxTokenRow;
		const tokenLabel = createElement("label", "cloud-sync-token__label", { text: "Access token" });
		tokenLabel.setAttribute("for", tokenFieldId);
		this.dropboxTokenInput = createElement("input", "cloud-sync-token__input", {
			type: "password",
			placeholder: "Paste Dropbox personal access token",
			id: tokenFieldId,
			spellcheck: "false",
			autocapitalize: "none",
			autocomplete: "off",
			title: "Fallback: paste a Dropbox token if the Link popup is unavailable."
		});
		dropboxTokenRow.append(tokenLabel, this.dropboxTokenInput);
		const dropboxGuideRow = createElement("div", "cloud-sync-token__guide");
		this.dropboxGuideRow = dropboxGuideRow;
		const guideLink = createElement("a", "cloud-sync-guide-link", {
			text: "Open the Dropbox setup guide",
			href: DROPBOX_GUIDE_URL,
			target: "_blank",
			rel: "noopener",
			title: "Open the Dropbox setup guide in a new tab."
		});
		dropboxGuideRow.append("Need a token? ", guideLink);
		this.cloudLinkMessages.dropbox.append(dropboxTokenRow, dropboxGuideRow);
		this.hideDropboxTokenFallback();
		fragment.append(dropboxRow, this.cloudLinkMessages.dropbox);

		return fragment;
	}

	refresh() {
		const cloud = this.getCloud();
		const recording = this.isRecording();
		const driveLinked = cloud?.hasDriveAccess();
		const dropboxLinked = cloud?.hasDropboxAccess();
		const cachedState = readCloudLinkStatus();
		if (!driveLinked && cachedState.drive && !isCloudLinkFresh(cachedState.drive)) {
			markCloudUnlinked("drive");
		}
		if (!dropboxLinked && cachedState.dropbox && !isCloudLinkFresh(cachedState.dropbox)) {
			markCloudUnlinked("dropbox");
		}

		if (this.cloudLinkButtons.drive) {
			this.cloudLinkButtons.drive.textContent = driveLinked ? "Reconnect Drive" : "Connect";
			this.cloudLinkButtons.drive.disabled = Boolean(this.cloudBusy.drive) || recording;
			this.cloudLinkButtons.drive.dataset.state = driveLinked ? "linked" : "idle";
		}
		if (this.cloudLinkStatusNodes.drive) {
			this.cloudLinkStatusNodes.drive.textContent = driveLinked ? "Connected — guests upload directly" : "Not connected";
			this.cloudLinkStatusNodes.drive.dataset.state = driveLinked ? "linked" : "idle";
		}

		if (this.cloudLinkButtons.dropbox) {
			this.cloudLinkButtons.dropbox.textContent = dropboxLinked ? "Reconnect Dropbox" : "Connect";
			this.cloudLinkButtons.dropbox.disabled = Boolean(this.cloudBusy.dropbox) || recording;
			this.cloudLinkButtons.dropbox.dataset.state = dropboxLinked ? "linked" : "idle";
		}
		if (this.cloudLinkStatusNodes.dropbox) {
			this.cloudLinkStatusNodes.dropbox.textContent = dropboxLinked ? "Connected — uploads after recording" : "Not connected";
			this.cloudLinkStatusNodes.dropbox.dataset.state = dropboxLinked ? "linked" : "idle";
		}
		if (this.dropboxTokenInput) {
			this.dropboxTokenInput.disabled = Boolean(this.cloudBusy.dropbox) || recording;
		}
		this.refreshGuestBackupControls();
	}

	setCloudMessage(service, message, variant = "info") {
		const container = this.cloudLinkMessages?.[service];
		if (!container) {
			return;
		}
		const target = this.cloudLinkMessageTextNodes?.[service] || container;
		target.textContent = message || "";
		container.dataset.variant = message ? variant : "";
	}

	ensureDropboxTokenFallbackVisible({ focus = false, select = false } = {}) {
		if (this.dropboxTokenRow) {
			this.dropboxTokenRow.hidden = false;
			this.dropboxTokenRow.classList.add("cloud-sync-token--visible");
		}
		if (this.dropboxGuideRow) {
			this.dropboxGuideRow.hidden = false;
			this.dropboxGuideRow.classList.add("cloud-sync-token__guide--visible");
		}
		if (focus && this.dropboxTokenInput) {
			this.dropboxTokenInput.focus();
			if (select && typeof this.dropboxTokenInput.select === "function") {
				this.dropboxTokenInput.select();
			}
		}
	}

	hideDropboxTokenFallback() {
		if (this.dropboxTokenRow) {
			this.dropboxTokenRow.hidden = true;
			this.dropboxTokenRow.classList.remove("cloud-sync-token--visible");
		}
		if (this.dropboxGuideRow) {
			this.dropboxGuideRow.hidden = true;
			this.dropboxGuideRow.classList.remove("cloud-sync-token__guide--visible");
		}
		if (this.dropboxTokenInput) {
			this.dropboxTokenInput.value = "";
		}
	}

	async handleDriveLink() {
		const cloud = this.getCloud();
		if (!cloud || this.cloudBusy.drive) {
			return;
		}
		this.cloudBusy.drive = true;
		this.refresh();
		this.setCloudMessage("drive", "Requesting Google authorization…", "info");
		try {
			const client = cloud.ensureDriveClient();
			if (!client) {
				throw new Error("Google Drive integration is not available on this build.");
			}
			if (typeof client.ensureInitialized === "function") {
				await client.ensureInitialized();
			}
			if (typeof client.requestAccessToken === "function") {
				client.requestAccessToken();
			}
			if (client.promise && typeof client.promise.then === "function") {
				await client.promise;
			} else {
				await new Promise(resolve => setTimeout(resolve, 800));
			}
			if (cloud.hasDriveAccess()) {
				this.setCloudMessage("drive", "Google Drive connected. Guests can now record directly to Drive.", "success");
				const folder = this.getDriveFolderName();
				markCloudLinked("drive", { folder });
			} else {
				this.setCloudMessage("drive", "Check your popup blocker or try again.", "warn");
				markCloudUnlinked("drive");
			}
		} catch (error) {
			console.error("Failed to link Google Drive", error);
			this.setCloudMessage("drive", error?.message || "Failed to link Google Drive.", "error");
			markCloudUnlinked("drive");
		} finally {
			this.cloudBusy.drive = false;
			this.refreshCloudFooter();
		}
	}

	async handleDropboxLink() {
		const cloud = this.getCloud();
		if (!cloud || this.cloudBusy.dropbox) {
			return;
		}
		this.cloudBusy.dropbox = true;
		this.refresh();
		const providedToken = (this.dropboxTokenInput?.value || "").trim();
		if (providedToken) {
			this.ensureDropboxTokenFallbackVisible();
		}
		const interactive = !providedToken;
		const hasExistingAccess = cloud?.hasDropboxAccess();
		const forceReauth = !providedToken && hasExistingAccess;
		const pendingMessage = providedToken ? "Linking Dropbox with the provided token…" : hasExistingAccess ? "Refreshing Dropbox session…" : "Waiting for the Dropbox popup to complete…";
		this.setCloudMessage("dropbox", pendingMessage, "info");
		try {
			if (typeof window.setupDropbox !== "function") {
				throw new Error("Dropbox uploader is not available in this build.");
			}
			const client = await cloud.ensureDropboxClient(providedToken || undefined, { interactive, forceReauth });
			if (client) {
				this.setCloudMessage("dropbox", "Dropbox linked. Recordings will upload automatically.", "success");
				if (this.dropboxTokenInput) {
					this.dropboxTokenInput.value = "";
				}
				if (!providedToken) {
					this.hideDropboxTokenFallback();
				}
				markCloudLinked("dropbox");
			} else {
				markCloudUnlinked("dropbox");
				if (providedToken) {
					this.setCloudMessage("dropbox", "Dropbox rejected the provided token. Double-check and try again.", "error");
					this.ensureDropboxTokenFallbackVisible({ focus: true, select: true });
				} else {
					this.setCloudMessage("dropbox", "Dropbox authorization was cancelled. Check your popup blocker and try again.", "warn");
					this.ensureDropboxTokenFallbackVisible({ focus: true });
				}
			}
		} catch (error) {
			console.error("Failed to init Dropbox", error);
			this.setCloudMessage("dropbox", error?.message || "Unable to initialise Dropbox.", "error");
			this.ensureDropboxTokenFallbackVisible({ focus: true });
			markCloudUnlinked("dropbox");
		} finally {
			this.cloudBusy.dropbox = false;
			this.refreshCloudFooter();
		}
	}

	dispose() {
		if (typeof window !== "undefined" && this.boundCloudStateHandler) {
			window.removeEventListener(PODCAST_CLOUD_EVENT, this.boundCloudStateHandler);
		}
		this.boundCloudStateHandler = null;
		this.cloudLinkButtons = { drive: null, dropbox: null };
		this.cloudLinkStatusNodes = { drive: null, dropbox: null };
		this.cloudLinkMessages = { drive: null, dropbox: null };
		this.cloudLinkMessageTextNodes = { drive: null, dropbox: null };
		this.dropboxTokenInput = null;
		this.dropboxTokenRow = null;
		this.dropboxGuideRow = null;
	}
}
