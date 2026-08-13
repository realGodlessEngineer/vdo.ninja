import { createElement } from "./dom-helpers.js?v=1";
import { formatRelativeTime } from "./time-format.js?v=1";
import { readPreflightState, writePreflightState, isPreflightFresh } from "./preflight-store.js?v=1";
import { readDiskRecordingState, verifyStoredDiskRecordingDirectory, chooseDiskRecordingDirectory } from "./disk-recording-store.js?v=1";

const PODCAST_DISK_EVENT = "podcast-disk-state";
const PREFLIGHT_MIN_MANDATORY_MS = 5 * 60 * 1000;

function describePreflightStatus(status) {
	switch (status) {
		case "ready":
			return "Ready";
		case "testing":
			return "Testing…";
		case "error":
			return "Needs attention";
		default:
			return "Pending";
	}
}

function createPreflightRow(label, description, options = {}) {
	const { initialStatus = "pending", actionLabel = "Test", showAction = true } = options;
	const row = createElement("div", "preflight-row");
	row.dataset.status = initialStatus;

	const info = createElement("div", "preflight-row__info");
	const labelNode = createElement("div", "preflight-row__label", { text: label });
	const descriptionNode = createElement("div", "preflight-row__description", { text: description });
	const messageNode = createElement("div", "preflight-row__message");
	info.append(labelNode, descriptionNode, messageNode);

	const controls = createElement("div", "preflight-row__controls");
	const statusNode = createElement("span", "preflight-row__status", { text: describePreflightStatus(initialStatus) });
	controls.append(statusNode);

	let actionButton = null;
	if (showAction) {
		actionButton = createElement("button", "preflight-row__action", { type: "button", text: actionLabel, title: `Run: ${label}` });
		controls.append(actionButton);
	}

	row.append(info, controls);
	return {
		row,
		info,
		statusNode,
		messageNode,
		actionButton
	};
}

function setPreflightRowState(rowParts, status, message = "") {
	if (!rowParts || !rowParts.row) {
		return;
	}
	rowParts.row.dataset.status = status;
	if (rowParts.statusNode) {
		rowParts.statusNode.textContent = describePreflightStatus(status);
	}
	if (rowParts.messageNode) {
		rowParts.messageNode.textContent = message || "";
	}
	if (rowParts.actionButton) {
		if (status === "testing") {
			rowParts.actionButton.disabled = true;
		} else {
			rowParts.actionButton.disabled = false;
		}
		if (status === "ready") {
			rowParts.actionButton.textContent = "Retest";
		} else if (status === "testing") {
			rowParts.actionButton.textContent = "Testing…";
		} else if (status === "error") {
			rowParts.actionButton.textContent = "Retry";
		} else {
			rowParts.actionButton.textContent = rowParts.actionButton.dataset.initialLabel || "Test";
		}
	}
}

export async function runPreflightChecklist({ roomSlug } = {}) {
	const stored = readPreflightState();
	const now = Date.now();
	const micFresh = isPreflightFresh(stored.micSuccessAt);
	const camFresh = isPreflightFresh(stored.cameraSuccessAt);

	// If the user just completed the preflight moments ago, allow immediate pass-through.
	if (stored.completedAt && now - stored.completedAt < PREFLIGHT_MIN_MANDATORY_MS) {
		document.body.classList.remove("hidden");
		document.body.classList.add("podcast-studio-mode");
		return { roomSlug, skipped: true };
	}

	const overlay = createElement("div", "podcast-preflight-backdrop");
	overlay.dataset.podcastOverlay = "true";
	// Inline styles ensure overlay is styled before external CSS loads
	overlay.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);z-index:9999";
	const panel = createElement("div", "podcast-preflight-panel");
	panel.style.cssText = "background:#1a1d24;padding:32px;border-radius:12px;color:#fff;max-width:480px;width:90%";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-modal", "true");
	panel.setAttribute("aria-label", "Podcast studio preflight checklist");

	const heading = createElement("h2", "preflight-title", { text: "Check Your Setup" });
	const subtitleText = roomSlug ? `Confirm your gear before directing room “${roomSlug}”.` : "Confirm your gear before directing a session.";
	const subtitle = createElement("p", "preflight-subtitle", { text: subtitleText });

	const checklist = createElement("div", "preflight-list");
	const micRow = createPreflightRow("Microphone access", "Verify your preferred mic is available and browser permission is granted.", {
		initialStatus: micFresh ? "ready" : "pending",
		actionLabel: micFresh ? "Retest" : "Test mic"
	});
	if (micRow.actionButton) {
		micRow.actionButton.dataset.initialLabel = micFresh ? "Retest" : "Test mic";
	}
	if (micFresh) {
		setPreflightRowState(micRow, "ready", `Last checked ${formatRelativeTime(stored.micSuccessAt)}.`);
	}

	const camRow = createPreflightRow("Camera access", "Optional but useful if you plan to capture video.", {
		initialStatus: camFresh ? "ready" : "pending",
		actionLabel: camFresh ? "Retest" : "Test camera"
	});
	if (camRow.actionButton) {
		camRow.actionButton.dataset.initialLabel = camFresh ? "Retest" : "Test camera";
	}
	if (camFresh) {
		setPreflightRowState(camRow, "ready", `Last checked ${formatRelativeTime(stored.cameraSuccessAt)}.`);
	}

	const diskRow = createPreflightRow("Local disk recording", "Select a destination folder for ISO files (optional but recommended).", {
		initialStatus: "pending",
		showAction: Boolean(window.showDirectoryPicker),
		actionLabel: window.showDirectoryPicker ? "Choose folder" : "Unavailable"
	});
	if (!window.showDirectoryPicker && diskRow.actionButton) {
		diskRow.actionButton.disabled = true;
	}
	setPreflightRowState(diskRow, window.showDirectoryPicker ? "pending" : "error", window.showDirectoryPicker ? "No folder selected yet." : "Local disk recording requires the File System Access API (Chromium-based browsers).");

	checklist.append(micRow.row, camRow.row, diskRow.row);

	const actions = createElement("div", "preflight-actions");
	const continueButton = createElement("button", "preflight-primary", { type: "button", text: "Enter Control Room", title: "Enter the podcast studio." });
	const skipButton = createElement("button", "preflight-secondary", { type: "button", text: "Skip preflight", title: "Skip these checks and enter the studio." });
	actions.append(continueButton, skipButton);

	panel.append(heading, subtitle, checklist, actions);
	overlay.append(panel);
	document.body.append(overlay);

	document.body.classList.remove("hidden");
	document.body.classList.add("podcast-studio-mode");

	let micOk = Boolean(micFresh);
	let camOk = Boolean(camFresh);
	let diskReady = false;
	let destroyed = false;
	let diskStatusListener = null;
	let resolver;
	const completion = new Promise(resolve => {
		resolver = resolve;
	});

	function closeOverlay(result = {}) {
		if (destroyed) {
			return;
		}
		destroyed = true;
		if (diskStatusListener) {
			window.removeEventListener(PODCAST_DISK_EVENT, diskStatusListener);
			diskStatusListener = null;
		}
		if (overlay && overlay.parentNode) {
			overlay.parentNode.removeChild(overlay);
		}
		const payload = { roomSlug, ...result };
		if (result.completed) {
			writePreflightState({
				...stored,
				completedAt: Date.now(),
				micSuccessAt: micOk ? stored.micSuccessAt || Date.now() : stored.micSuccessAt,
				cameraSuccessAt: camOk ? stored.cameraSuccessAt || Date.now() : stored.cameraSuccessAt,
				roomSlug
			});
		} else {
			writePreflightState({
				...stored,
				micSuccessAt: micOk ? stored.micSuccessAt || Date.now() : stored.micSuccessAt,
				cameraSuccessAt: camOk ? stored.cameraSuccessAt || Date.now() : stored.cameraSuccessAt,
				roomSlug
			});
		}
		if (typeof resolver === "function") {
			resolver(payload);
			resolver = null;
		}
	}

	function updateContinueState() {
		continueButton.disabled = !micOk;
		continueButton.title = micOk ? "" : "Run the microphone test to continue.";
	}

	updateContinueState();

	async function runMediaTest(kind) {
		if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
			throw new Error("Browser does not support media tests.");
		}
		const constraints = kind === "video" ? { video: true } : { audio: { echoCancellation: false } };
		const stream = await navigator.mediaDevices.getUserMedia(constraints);
		stream.getTracks().forEach(track => {
			try {
				track.stop();
			} catch (error) {
				console.warn("Unable to stop track", error);
			}
		});
	}

	if (micRow.actionButton) {
		micRow.actionButton.addEventListener("click", async () => {
			setPreflightRowState(micRow, "testing", "Requesting microphone access…");
			try {
				await runMediaTest("audio");
				micOk = true;
				const timestamp = Date.now();
				stored.micSuccessAt = timestamp;
				setPreflightRowState(micRow, "ready", "Microphone ready to record.");
			} catch (error) {
				console.error("Microphone check failed", error);
				micOk = false;
				setPreflightRowState(micRow, "error", error?.message ? error.message : "Unable to access microphone.");
			}
			updateContinueState();
			writePreflightState({ ...stored, micSuccessAt: micOk ? Date.now() : stored.micSuccessAt, roomSlug });
		});
	}

	if (camRow.actionButton) {
		camRow.actionButton.addEventListener("click", async () => {
			setPreflightRowState(camRow, "testing", "Requesting camera access…");
			try {
				await runMediaTest("video");
				camOk = true;
				const timestamp = Date.now();
				stored.cameraSuccessAt = timestamp;
				setPreflightRowState(camRow, "ready", "Camera detected.");
				writePreflightState({ ...stored, cameraSuccessAt: timestamp, roomSlug });
			} catch (error) {
				console.error("Camera check failed", error);
				camOk = false;
				setPreflightRowState(camRow, "error", error?.message ? error.message : "Unable to access camera.");
				writePreflightState({ ...stored, roomSlug });
			}
		});
	}

	async function refreshDiskRowStatus({ interactive = false } = {}) {
		if (typeof window.showDirectoryPicker !== "function") {
			diskReady = false;
			setPreflightRowState(diskRow, "error", "Local disk recording requires a Chromium-based browser with the File System Access API.");
			if (diskRow.actionButton) {
				diskRow.actionButton.disabled = true;
			}
			return;
		}
		const diskState = readDiskRecordingState();
		if (!diskState.folderName) {
			diskReady = false;
			if (diskRow.actionButton) {
				diskRow.actionButton.textContent = "Choose folder";
				diskRow.actionButton.disabled = false;
			}
			setPreflightRowState(diskRow, "pending", "Pick a folder to enable local ISO recording.");
			return;
		}
		setPreflightRowState(diskRow, "testing", "Validating folder permissions…");
		const result = await verifyStoredDiskRecordingDirectory({ requestPermission: interactive });
		if (result.ok) {
			diskReady = true;
			const meta = readDiskRecordingState();
			if (diskRow.actionButton) {
				diskRow.actionButton.textContent = "Change folder";
				diskRow.actionButton.disabled = false;
			}
			const checked = meta.lastVerifiedAt ? `Last checked ${formatRelativeTime(meta.lastVerifiedAt)}.` : "Ready to write.";
			setPreflightRowState(diskRow, "ready", `Folder: ${result.folderName}. ${checked}`);
		} else {
			diskReady = false;
			if (diskRow.actionButton) {
				diskRow.actionButton.textContent = "Choose folder";
				diskRow.actionButton.disabled = false;
			}
			setPreflightRowState(diskRow, "error", result.message || "Unable to access the selected folder.");
		}
	}

	refreshDiskRowStatus();
	diskStatusListener = () => refreshDiskRowStatus();
	window.addEventListener(PODCAST_DISK_EVENT, diskStatusListener);

	if (diskRow.actionButton) {
		diskRow.actionButton.addEventListener("click", async () => {
			if (diskRow.actionButton.disabled) {
				return;
			}
			try {
				setPreflightRowState(diskRow, "testing", "Waiting for folder selection…");
				await chooseDiskRecordingDirectory();
				await refreshDiskRowStatus({ interactive: true });
			} catch (error) {
				diskReady = false;
				const message = error?.name === "AbortError" || /cancel/i.test(error?.message || "") ? "Folder selection cancelled." : error?.message || "Unable to choose folder.";
				setPreflightRowState(diskRow, "error", message);
			}
		});
	}

	continueButton.addEventListener("click", () => {
		if (!micOk) {
			setPreflightRowState(micRow, "error", "Microphone test is required before entering.");
			return;
		}
		closeOverlay({ completed: true });
	});

	skipButton.addEventListener("click", () => {
		closeOverlay({ skipped: true });
	});

	overlay.addEventListener("click", event => {
		if (event.target === overlay) {
			closeOverlay({ skipped: true });
		}
	});

	document.addEventListener(
		"keydown",
		event => {
			if (destroyed) {
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				closeOverlay({ skipped: true });
			}
		},
		{ once: true }
	);

	return completion;
}
