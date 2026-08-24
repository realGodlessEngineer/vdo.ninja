import { createElement, makeCollapsible } from "./dom-helpers.js?v=1";

// Guest-invite controller for the podcast studio: owns the "Guest Invites" panel —
// the read-only invite-link input, the copy button (with its clipboard flow and
// transient status timeout), and the processing-flag checkboxes that shape the
// generated guest URL. The host injects a single getRoomName() seam, mounts
// buildPanel() into the console grid, then drives refresh() whenever the room or
// options change; dispose() clears the copy timer and drops the DOM refs.
export class InviteLinkController {
	constructor({ getRoomName = () => "" } = {}) {
		this.getRoomName = getRoomName;

		this.inviteLinkInput = null;
		this.inviteCopyButton = null;
		this.inviteStatusNode = null;
		this.inviteOptionNodes = {};
		this.inviteCopyTimer = null;
	}

	buildPanel() {
		const invitePanel = createElement("section", "podcast-panel invite-panel");
		invitePanel.classList.add("console-grid__span-2");
		const inviteIntro = createElement("p", "invite-copy", {
			text: "Share a pro audio-ready link with guests. Tweak processing flags before copying."
		});
		const inviteLinkRow = createElement("div", "invite-link-row");
		this.inviteLinkInput = createElement("input", "invite-link-input", {
			type: "text",
			readonly: "true",
			value: "",
			title: "Guest invite link (click to select)."
		});
		this.inviteLinkInput.addEventListener("focus", () => {
			try {
				this.inviteLinkInput.select();
			} catch (error) {
				console.warn("Invite link select failed", error);
			}
		});
		this.inviteCopyButton = createElement("button", "invite-link-copy", { type: "button", text: "Copy link", title: "Copy the guest invite link." });
		this.inviteCopyButton.addEventListener("click", () => this.copyLink());
		inviteLinkRow.append(this.inviteLinkInput, this.inviteCopyButton);
		this.inviteStatusNode = createElement("div", "invite-status");

		const inviteOptions = createElement("div", "invite-options");
		const optionDefs = [
			{ key: "disableVideo", label: "Disable video preview", defaultChecked: false },
			{ key: "proAudio", label: "Enable pro audio (stereo, 256 kbps)", defaultChecked: true },
			{ key: "disableAec", label: "Disable echo cancellation", defaultChecked: true },
			{ key: "disableDenoise", label: "Disable noise reduction", defaultChecked: true },
			{ key: "disableAgc", label: "Disable auto gain control", defaultChecked: true },
			{ key: "guestRecordBackup", label: "Guest-side audio record backup", defaultChecked: true }
		];
		optionDefs.forEach(option => {
			const optionLabel = createElement("label", "invite-option");
			const checkbox = createElement("input", "invite-option__checkbox", { type: "checkbox" });
			checkbox.checked = option.defaultChecked;
			checkbox.title = "Applies to the generated guest link.";
			optionLabel.title = option.label;
			checkbox.addEventListener("change", () => this.refresh());
			optionLabel.append(checkbox, createElement("span", "invite-option__label", { text: option.label }));
			inviteOptions.append(optionLabel);
			this.inviteOptionNodes[option.key] = checkbox;
		});

		invitePanel.append(inviteIntro, inviteLinkRow, this.inviteStatusNode, inviteOptions);
		makeCollapsible(invitePanel, "Guest Invites", "podcastStudio.collapse.invites");
		return invitePanel;
	}

	refresh() {
		if (!this.inviteLinkInput) {
			return;
		}
		const room = this.getRoomName();
		if (!room) {
			this.inviteLinkInput.value = "Set a room name to generate a guest link";
			this.inviteLinkInput.dataset.state = "placeholder";
			if (this.inviteCopyButton) {
				this.inviteCopyButton.disabled = true;
			}
			if (this.inviteStatusNode) {
				this.inviteStatusNode.textContent = "";
			}
			return;
		}
		this.inviteLinkInput.dataset.state = "ready";
		if (this.inviteCopyButton) {
			this.inviteCopyButton.disabled = false;
		}
		const guestUrl = new URL(window.location.href);
		guestUrl.search = "";
		guestUrl.hash = "";

		const params = new URLSearchParams();
		params.set("room", room);
		params.set("style", "2");
		params.set("showlabel", "1");
		params.set("tips", "1");
		params.set("label", "");

		const options = this.inviteOptionNodes || {};
		const summary = [];
		summary.push("Label prompt");
		summary.push("Name tag overlay");
		summary.push("Join tips");

		// Video is ON by default
		if (options.disableVideo?.checked) {
			params.set("miconly", "1");
			summary.push("Audio only");
		} else {
			summary.push("Video enabled");
		}

		if (options.proAudio?.checked) {
			params.set("proaudio", "1");
			params.set("stereo", "1");
			params.set("audiobitrate", "256");
			summary.push("Pro audio");
		} else {
			params.delete("proaudio");
			params.delete("stereo");
			params.delete("audiobitrate");
		}

		if (options.disableAec?.checked) {
			params.set("aec", "0");
			params.set("echocancellation", "0");
			summary.push("AEC off");
		} else {
			params.delete("aec");
			params.delete("echocancellation");
		}

		if (options.disableDenoise?.checked) {
			params.set("denoise", "0");
			summary.push("Denoise off");
		} else {
			params.delete("denoise");
		}

		if (options.disableAgc?.checked) {
			params.set("agc", "0");
			params.set("autogain", "0");
			summary.push("AGC off");
		} else {
			params.delete("agc");
			params.delete("autogain");
		}

		if (options.guestRecordBackup?.checked) {
			params.set("autorecordlocal", "-128");
			summary.push("Audio backup");
		} else {
			params.delete("autorecordlocal");
		}

		guestUrl.search = params.toString();
		const value = guestUrl.toString();
		this.inviteLinkInput.value = value;
		if (this.inviteStatusNode) {
			this.inviteStatusNode.textContent = summary.length ? summary.join(" • ") : "Default settings";
		}
	}

	async copyLink() {
		if (!this.inviteLinkInput || this.inviteLinkInput.dataset.state === "placeholder") {
			return;
		}
		const value = this.inviteLinkInput.value;
		if (!value) {
			return;
		}
		const notify = (message, variant = "info") => {
			if (!this.inviteStatusNode) {
				return;
			}
			this.inviteStatusNode.textContent = message;
			this.inviteStatusNode.dataset.variant = variant;
			if (this.inviteCopyTimer) {
				clearTimeout(this.inviteCopyTimer);
			}
			this.inviteCopyTimer = setTimeout(() => {
				this.inviteStatusNode.dataset.variant = "";
				this.refresh();
			}, 3500);
		};
		try {
			if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
				await navigator.clipboard.writeText(value);
				notify("Guest link copied.", "success");
				return;
			}
		} catch (error) {
			console.warn("Navigator clipboard copy failed", error);
		}
		try {
			this.inviteLinkInput.focus();
			this.inviteLinkInput.select();
			const success = document.execCommand("copy");
			if (success) {
				notify("Guest link copied.", "success");
			} else {
				notify("Select and copy the link manually.", "warning");
			}
		} catch (error) {
			console.warn("Fallback copy failed", error);
			notify("Select and copy the link manually.", "warning");
		}
	}

	dispose() {
		if (this.inviteCopyTimer) {
			clearTimeout(this.inviteCopyTimer);
			this.inviteCopyTimer = null;
		}
		this.inviteLinkInput = null;
		this.inviteCopyButton = null;
		this.inviteStatusNode = null;
		this.inviteOptionNodes = {};
	}
}
