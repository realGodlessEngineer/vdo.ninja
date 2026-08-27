// Recording-status controller for the podcast studio: owns the single
// "session-recording-status" readout beneath the transport buttons and the 1 Hz
// timer that keeps its live "elapsed | tracks | backup" line current while a
// recording is running. The host builds the status node in buildLayout() and
// hands it over via bindNode(); recording state, the record start timestamp, the
// estimated track count, the guest-backup label, and the duration formatter are
// injected as read-only seam callbacks. set() records the base label/state and
// renders it (deferring to refresh() for the live "active" line), startTimer()/
// stopTimer() drive the interval, and dispose() clears the timer and drops the
// node ref.
export class RecordingStatusController {
	constructor({ isRecording = () => false, getRecordStartedAt = () => null, countTracks = () => 0, getBackupLabel = () => "", formatDuration = seconds => String(seconds) } = {}) {
		this.isRecording = isRecording;
		this.getRecordStartedAt = getRecordStartedAt;
		this.countTracks = countTracks;
		this.getBackupLabel = getBackupLabel;
		this.formatDuration = formatDuration;

		this.node = null;
		this.timer = null;
		this.base = "Idle";
		this.state = "idle";
	}

	bindNode(node) {
		this.node = node || null;
	}

	refresh() {
		if (!this.node) {
			return;
		}
		if (!this.isRecording() || !this.getRecordStartedAt()) {
			this.node.textContent = this.base || "Idle";
			this.node.dataset.state = this.state || "idle";
			return;
		}
		const elapsed = this.formatDuration(Math.max(0, (Date.now() - this.getRecordStartedAt()) / 1000));
		const trackCount = this.countTracks();
		const backupLabel = this.getBackupLabel();
		this.node.textContent = `${elapsed} | ${trackCount} track${trackCount === 1 ? "" : "s"} | ${backupLabel}`;
		this.node.dataset.state = "active";
	}

	startTimer() {
		this.stopTimer();
		this.refresh();
		this.timer = setInterval(() => this.refresh(), 1000);
	}

	stopTimer() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	set(text, state = "idle") {
		if (!this.node) {
			return;
		}
		this.base = text;
		this.state = state;
		if (state === "active") {
			this.refresh();
			return;
		}
		this.node.textContent = text;
		this.node.dataset.state = state;
	}

	dispose() {
		this.stopTimer();
		this.node = null;
	}
}
