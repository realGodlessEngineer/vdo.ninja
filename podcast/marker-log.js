import { createElement } from "./dom-helpers.js?v=1";

function escapeCsvValue(value) {
	const raw = value === null || typeof value === "undefined" ? "" : String(value);
	const escaped = raw.replace(/\"/g, '""');
	return `"${escaped}"`;
}

function formatMarkerTimecode(seconds) {
	const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
	const totalMs = Math.round(safeSeconds * 1000);
	const hours = Math.floor(totalMs / 3600000);
	const minutes = Math.floor((totalMs % 3600000) / 60000);
	const secs = Math.floor((totalMs % 60000) / 1000);
	const ms = totalMs % 1000;
	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
	}
	return `${minutes}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

// Session-cue-point log for the podcast studio: renders the marker list, owns the
// auto-sync scheduling timer, and exports/copies the log as CSV. Consumers push
// markers through add()/addManual() and read them back via snapshot().
export class MarkerLog {
	constructor({ logEl, actionsEl = null, exportButton = null, copyButton = null, isRecording = () => false, getElapsedSeconds = () => 0, getSessionId = () => null, onEvent = () => {} } = {}) {
		this.logEl = logEl;
		this.actionsEl = actionsEl;
		this.exportButton = exportButton;
		this.copyButton = copyButton;
		this.isRecording = isRecording;
		this.getElapsedSeconds = getElapsedSeconds;
		this.getSessionId = getSessionId;
		this.onEvent = onEvent;
		this.markers = [];
		this.autoSyncTimer = null;
		this.copyResetTimer = null;

		if (this.exportButton) {
			this.exportButton.addEventListener("click", () => this.exportCsv());
		}
		if (this.copyButton) {
			this.copyButton.addEventListener("click", () => this.copyCsv());
		}
	}

	reset() {
		this.markers = [];
		this.render();
	}

	add(note) {
		this.markers.push(note);
		const eventData = { label: note.label, timeSeconds: note.time };
		if (note.auto) {
			eventData.auto = true;
		}
		if (note.joinSync) {
			eventData.joinSync = true;
		}
		this.onEvent("marker", eventData);
		this.render();
	}

	addManual() {
		if (!this.isRecording()) {
			return;
		}
		const timestamp = this.getElapsedSeconds();
		this.add({
			time: timestamp,
			label: `Marker @ ${timestamp.toFixed(1)}s`
		});
	}

	scheduleAutoSync() {
		if (this.autoSyncTimer) {
			return;
		}
		this.autoSyncTimer = setTimeout(() => {
			this.autoSyncTimer = null;
			if (!this.isRecording()) {
				return;
			}
			const timestamp = this.getElapsedSeconds();
			this.add({
				time: timestamp,
				label: `Auto sync @ ${timestamp.toFixed(1)}s`,
				auto: true
			});
		}, 1000);
	}

	clearAutoTimer() {
		if (this.autoSyncTimer) {
			clearTimeout(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
	}

	snapshot() {
		return this.markers.map(marker => ({ ...marker }));
	}

	buildCsv() {
		const markers = Array.isArray(this.markers) ? this.markers : [];
		const header = ["index", "time_seconds", "timecode", "label", "auto"].join(",");
		if (!markers.length) {
			return `${header}\n`;
		}
		const rows = markers.map((marker, index) => {
			const timeSeconds = Number.isFinite(marker?.time) ? marker.time : 0;
			const timecode = formatMarkerTimecode(timeSeconds);
			const label = marker?.label || `Marker #${index + 1}`;
			const auto = marker?.auto ? "1" : "0";
			return [index + 1, timeSeconds.toFixed(3), escapeCsvValue(timecode), escapeCsvValue(label), auto].join(",");
		});
		return `${header}\n${rows.join("\n")}\n`;
	}

	buildFilename() {
		const sessionId = this.getSessionId() || "session";
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		return `vdo-ninja-markers-${sessionId}-${timestamp}.csv`;
	}

	exportCsv() {
		if (!this.exportButton) {
			return;
		}
		const csv = this.buildCsv();
		if (!csv.trim()) {
			return;
		}
		// Visual feedback while preparing download
		const originalText = this.exportButton.textContent;
		this.exportButton.textContent = "Exporting…";
		this.exportButton.disabled = true;

		// Small delay to show feedback before download triggers
		setTimeout(() => {
			const blob = new Blob([csv], { type: "text/csv" });
			const url = URL.createObjectURL(blob);
			try {
				const link = document.createElement("a");
				link.href = url;
				link.download = this.buildFilename();
				link.rel = "noopener";
				link.click();
				this.exportButton.textContent = "Exported";
			} catch (error) {
				console.warn("Failed to trigger CSV download", error);
				this.exportButton.textContent = "Export failed";
			} finally {
				setTimeout(() => URL.revokeObjectURL(url), 100);
				// Restore button after a moment
				setTimeout(() => {
					if (this.exportButton) {
						this.exportButton.textContent = originalText;
						this.exportButton.disabled = false;
					}
				}, 1500);
			}
		}, 50);
	}

	async copyCsv() {
		if (!this.copyButton) {
			return;
		}
		const csv = this.buildCsv();
		if (!csv.trim()) {
			return;
		}
		try {
			if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
				await navigator.clipboard.writeText(csv);
			} else {
				const textarea = document.createElement("textarea");
				textarea.value = csv;
				textarea.setAttribute("readonly", "true");
				textarea.style.position = "fixed";
				textarea.style.left = "-9999px";
				document.body.append(textarea);
				textarea.select();
				document.execCommand("copy");
				textarea.remove();
			}
			this.copyButton.textContent = "Copied";
			if (this.copyResetTimer) {
				clearTimeout(this.copyResetTimer);
			}
			this.copyResetTimer = setTimeout(() => {
				this.copyResetTimer = null;
				if (this.copyButton) {
					this.copyButton.textContent = "Copy CSV";
				}
			}, 1500);
		} catch (error) {
			console.warn("Copy markers failed", error);
			this.copyButton.textContent = "Copy failed";
			if (this.copyResetTimer) {
				clearTimeout(this.copyResetTimer);
			}
			this.copyResetTimer = setTimeout(() => {
				this.copyResetTimer = null;
				if (this.copyButton) {
					this.copyButton.textContent = "Copy CSV";
				}
			}, 2000);
		}
	}

	render() {
		this.logEl.innerHTML = "";
		if (this.actionsEl) {
			this.actionsEl.style.display = this.markers.length ? "" : "none";
		}
		if (!this.markers.length) {
			const empty = createElement("div", "empty-state", { text: "Tap “Marker” to drop cue points during recording." });
			empty.dataset.empty = "true";
			this.logEl.append(empty);
			return;
		}
		// Render newest markers first (reverse order) so they appear at the top
		for (let i = this.markers.length - 1; i >= 0; i -= 1) {
			const marker = this.markers[i];
			const timeSeconds = Number.isFinite(marker?.time) ? marker.time : 0;
			const timecode = formatMarkerTimecode(timeSeconds);
			const item = createElement("div", "marker-item");
			item.title = `${marker?.auto ? "Auto sync" : "Marker"} @ ${timecode}`;
			item.append(createElement("span", "", { text: marker.label }));
			item.append(createElement("span", "marker-badge", { text: `#${i + 1}` }));
			this.logEl.append(item);
		}
	}
}
