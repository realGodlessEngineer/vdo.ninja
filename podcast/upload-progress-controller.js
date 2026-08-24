import { createElement } from "./dom-helpers.js?v=1";

const UPLOAD_TRACKER_COOLDOWN_MS = 15000;

// Upload-progress controller for the podcast studio: owns the per-service
// (Drive / Dropbox) upload-tracker Maps and the two "…uploads idle" summary
// progress nodes rendered in the ISO config summary. The host injects a single
// seam for the human-readable service label, mounts the two nodes it creates
// via createProgressNodes(), then drives the tracker state machine through
// setPending()/registerTask()/updateTask()/finalizeTask()/refresh().
export class UploadProgressController {
	constructor({ describeService = service => service } = {}) {
		this.describeService = describeService;

		this.progressNodes = {
			drive: null,
			dropbox: null
		};
		this.trackers = {
			drive: new Map(),
			dropbox: new Map()
		};
		this.cooldownTimers = new Set();
	}

	createProgressNodes() {
		this.progressNodes.drive = createElement("div", "iso-config-summary__item iso-config-summary__item--service", {
			text: "Drive uploads idle"
		});
		this.progressNodes.drive.dataset.state = "idle";
		this.progressNodes.dropbox = createElement("div", "iso-config-summary__item iso-config-summary__item--service", {
			text: "Dropbox uploads idle"
		});
		this.progressNodes.dropbox.dataset.state = "idle";
		return { drive: this.progressNodes.drive, dropbox: this.progressNodes.dropbox };
	}

	setPending(pending) {
		["drive", "dropbox"].forEach(service => {
			const node = this.progressNodes?.[service];
			if (!node) {
				return;
			}
			if (pending) {
				node.dataset.state = "pending";
				node.textContent = `${this.describeService(service)} uploads pending (recording in progress)`;
			} else if (!this.trackers?.[service]?.size) {
				node.dataset.state = "idle";
				node.textContent = `${this.describeService(service)} uploads idle`;
			}
		});
	}

	registerTask(service, meta) {
		if (!service || !this.trackers?.[service]) {
			return null;
		}
		const tracker = this.trackers[service];
		const key = `${service}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const bytesTotal = meta?.blob?.size || 0;
		tracker.set(key, {
			key,
			label: meta?.participant?.label || meta?.filename || "Track",
			bytesUploaded: 0,
			bytesTotal,
			status: "pending",
			startedAt: Date.now()
		});
		this.refresh(service);
		return key;
	}

	updateTask(service, key, { uploaded, total, status } = {}) {
		if (!service || !key || !this.trackers?.[service]) {
			return;
		}
		const tracker = this.trackers[service];
		const entry = tracker.get(key);
		if (!entry) {
			return;
		}
		if (typeof uploaded === "number") {
			entry.bytesUploaded = uploaded;
		}
		if (typeof total === "number" && total >= 0) {
			entry.bytesTotal = total;
		}
		if (status) {
			entry.status = status;
		}
		this.refresh(service);
	}

	finalizeTask(service, key, status = "uploaded") {
		if (!service || !key || !this.trackers?.[service]) {
			return;
		}
		const tracker = this.trackers[service];
		const entry = tracker.get(key);
		if (!entry) {
			return;
		}
		entry.status = status;
		if (!entry.bytesTotal) {
			entry.bytesTotal = entry.bytesUploaded;
		}
		tracker.set(key, entry);
		this.refresh(service);
		const ttl = status === "error" ? UPLOAD_TRACKER_COOLDOWN_MS * 2 : status === "queued" ? UPLOAD_TRACKER_COOLDOWN_MS * 4 : UPLOAD_TRACKER_COOLDOWN_MS;
		const timer = setTimeout(() => {
			this.cooldownTimers.delete(timer);
			const current = tracker.get(key);
			if (current && current.status === status) {
				tracker.delete(key);
				this.refresh(service);
			}
		}, ttl);
		this.cooldownTimers.add(timer);
	}

	refresh(service) {
		const node = this.progressNodes?.[service];
		const tracker = this.trackers?.[service];
		if (!node || !tracker) {
			return;
		}
		if (!tracker.size) {
			node.textContent = `${this.describeService(service)} uploads idle`;
			node.dataset.state = "idle";
			return;
		}
		const entries = Array.from(tracker.values());
		const errors = entries.filter(entry => entry.status === "error");
		const active = entries.filter(entry => entry.status === "pending" || entry.status === "uploading");
		const queued = entries.filter(entry => entry.status === "queued");
		const completed = entries.filter(entry => entry.status === "uploaded");
		const skipped = entries.filter(entry => entry.status === "skipped");
		const uploadedBytes = entries.reduce((total, entry) => total + Math.min(entry.bytesUploaded || 0, entry.bytesTotal || entry.bytesUploaded || 0), 0);
		const totalBytes = entries.reduce((total, entry) => total + (entry.bytesTotal || entry.bytesUploaded || 0), 0);
		const percentage = totalBytes ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0;
		if (errors.length) {
			node.textContent = `${this.describeService(service)} upload error (${errors.length})`;
			node.dataset.state = "error";
			return;
		}
		if (active.length) {
			node.textContent = `${this.describeService(service)} uploading ${active.length} file${active.length === 1 ? "" : "s"} • ${percentage}%`;
			node.dataset.state = "uploading";
			return;
		}
		if (queued.length) {
			node.textContent = `${this.describeService(service)} queued ${queued.length} file${queued.length === 1 ? "" : "s"} • finalizing`;
			node.dataset.state = "pending";
			return;
		}
		if (completed.length || skipped.length) {
			node.textContent = `${this.describeService(service)} uploads complete`;
			node.dataset.state = "complete";
			return;
		}
		node.textContent = `${this.describeService(service)} uploads idle`;
		node.dataset.state = "idle";
	}

	dispose() {
		this.cooldownTimers.forEach(timer => clearTimeout(timer));
		this.cooldownTimers.clear();
		this.trackers.drive.clear();
		this.trackers.dropbox.clear();
		["drive", "dropbox"].forEach(service => {
			const node = this.progressNodes[service];
			if (node && node.parentNode) {
				node.parentNode.removeChild(node);
			}
			this.progressNodes[service] = null;
		});
	}
}
