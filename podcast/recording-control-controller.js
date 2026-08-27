import { createRecordingSessionId, snapshotHighResClock } from "./recording-session-utils.js?v=1";
import { readCloudLinkStatus } from "./cloud-link-store.js?v=1";

// These mirror the public event names dispatched by studio.js. External code and
// other windows listen for these exact strings, so they must stay byte-for-byte
// identical to studio.js's PODCAST_RECORD_PLAN_EVENT / PODCAST_RECORD_STATUS_EVENT.
const PODCAST_RECORD_PLAN_EVENT = "podcast-record-plan";
const PODCAST_RECORD_STATUS_EVENT = "podcast-record-status";

// Local copy of studio.js's module-private dispatchStudioEvent helper (not
// exported there); mirrors it byte-for-byte so plan/status events fire identically.
function dispatchStudioEvent(name, detail = {}) {
	if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
		return;
	}
	try {
		window.dispatchEvent(new CustomEvent(name, { detail }));
	} catch (error) {
		console.warn("Unable to dispatch studio event", name, error);
	}
}

// Recording-control controller for the podcast studio: owns the riskier remainder
// of the recording-control cluster — the record/marker button state, the recorder
// event-wiring hub (start/chunk/meter-ready/participant-added/error/stop), the
// recording-plan/manifest bookkeeping, the late-join participant plumbing, and the
// "Record Group" popout. The seven shared recording-lifecycle fields (recording,
// recordTransitioning, recordStartedAt, recordingPlan, recordingSessionId, the
// trackRuntimeStats Map, the upload AbortController) stay owned by the coordinator
// because staying readers and other controllers' seam callbacks also touch them;
// this controller reaches them through the injected get*/set*/reset seams. Sibling
// collaborators (tracklist, marker log, recording status, capture mode, recorder)
// arrive as lazy getter seams so late-constructed ones (marker log, recorder)
// resolve correctly; single-method collaborators and the retained coordinator
// methods arrive as fine-grained callbacks. The host builds the record/marker
// buttons and the recording summary inline (in buildLayout()) and hands them over
// via bindNodes(); methods null-guard until the nodes are bound. dispose() drops
// the node refs and is null-safe and double-call-safe.
export class RecordingControlController {
	constructor({ getRecording = () => false, setRecording = () => {}, getRecordTransitioning = () => false, setRecordTransitioning = () => {}, getRecordStartedAt = () => null, setRecordStartedAt = () => {}, getRecordingPlan = () => null, setRecordingPlan = () => {}, getRecordingSessionId = () => null, setRecordingSessionId = () => {}, getTrackRuntimeStats = () => null, resetAbortController = () => {}, getRecorder = () => null, getTracklist = () => null, getMarkerLog = () => null, getRecordingStatus = () => null, getCaptureMode = () => null, updateHostMicUI = () => {}, setUploadPending = () => {}, updateGuestBackupControls = () => {}, hasDriveAccess = () => false, hasDropboxAccess = () => false, cleanupDownloadUrls = () => {}, updateRecordingRuntimeMetrics = () => {}, presentRecordings = () => {}, setStatusMessage = () => {}, resolveRoomName = () => "" } = {}) {
		this.getRecording = getRecording;
		this.setRecording = setRecording;
		this.getRecordTransitioning = getRecordTransitioning;
		this.setRecordTransitioning = setRecordTransitioning;
		this.getRecordStartedAt = getRecordStartedAt;
		this.setRecordStartedAt = setRecordStartedAt;
		this.getRecordingPlan = getRecordingPlan;
		this.setRecordingPlan = setRecordingPlan;
		this.getRecordingSessionId = getRecordingSessionId;
		this.setRecordingSessionId = setRecordingSessionId;
		this.getTrackRuntimeStats = getTrackRuntimeStats;
		this.resetAbortController = resetAbortController;
		this.getRecorder = getRecorder;
		this.getTracklist = getTracklist;
		this.getMarkerLog = getMarkerLog;
		this.getRecordingStatus = getRecordingStatus;
		this.getCaptureMode = getCaptureMode;
		this.updateHostMicUI = updateHostMicUI;
		this.setUploadPending = setUploadPending;
		this.updateGuestBackupControls = updateGuestBackupControls;
		this.hasDriveAccess = hasDriveAccess;
		this.hasDropboxAccess = hasDropboxAccess;
		this.cleanupDownloadUrls = cleanupDownloadUrls;
		this.updateRecordingRuntimeMetrics = updateRecordingRuntimeMetrics;
		this.presentRecordings = presentRecordings;
		this.setStatusMessage = setStatusMessage;
		this.resolveRoomName = resolveRoomName;

		this.recordButton = null;
		this.markerButton = null;
		this.recordingSummary = null;
	}

	bindNodes({ recordButton = null, markerButton = null, recordingSummary = null } = {}) {
		this.recordButton = recordButton;
		this.markerButton = markerButton;
		this.recordingSummary = recordingSummary;
	}

	updateRecordingButtons() {
		if (this.recordButton) {
			this.recordButton.classList.toggle("recording", this.getRecording());
			this.recordButton.disabled = this.getRecordTransitioning();
			this.recordButton.textContent = this.getRecording() ? "Stop Recording" : "Start Recording";
			this.recordButton.title = this.getRecording() ? "Stop the current ISO recording." : `Start ${this.getCaptureMode()?.describeCaptureMode(this.getCaptureMode()?.getMode())} capture.`;
		}
		this.getCaptureMode()?.setRecording(this.getRecording());
		this.updateGuestBackupControls();
	}

	attachRecorderEvents() {
		const recorder = this.getRecorder();
		if (!recorder) {
			return;
		}
		recorder.addEventListener("start", event => {
			this.resetAbortController();
			this.cleanupDownloadUrls();
			const runtimeStats = this.getTrackRuntimeStats();
			if (runtimeStats) {
				runtimeStats.clear();
			}
			this.getTracklist()?.clearTrackLevelNodes();
			this.getTracklist()?.teardownSpectrograms();
			this.getTracklist()?.clearOutputIndicators();
			this.setRecording(true);
			this.setRecordTransitioning(false);
			this.setRecordStartedAt(event?.detail?.startedAt || Date.now());
			this.getMarkerLog()?.reset();
			this.getMarkerLog()?.scheduleAutoSync();
			this.updateRecordingButtons();
			if (this.markerButton) {
				this.markerButton.disabled = false;
			}
			this.getTracklist()?.showOutputsMessage("Recording… tracks will appear as media arrives.");
			this.updateHostMicUI();
			this.setUploadPending(true);
			if (this.getRecordingPlan()?.sync) {
				this.getRecordingPlan().sync.start = {
					wallClock: this.getRecordStartedAt(),
					highRes: snapshotHighResClock()
				};
			}
			this.logRecordingEvent("record:start", { sessionId: this.getRecordingSessionId(), mode: this.getCaptureMode()?.getMode() });
			this.updateRecordingPlanStatus("started", { events: this.getRecordingPlan()?.events || [] });
			this.getRecordingStatus()?.set(this.getCaptureMode()?.getMode() === "video" ? "Recording audio + video ISOs" : "Recording audio ISOs", "active");
			if (this.recordingSummary) this.recordingSummary.style.display = "";
			this.getRecordingStatus()?.startTimer();
		});

		recorder.addEventListener("chunk", event => {
			const { participant, trackType, channelIndex } = event.detail || {};
			if (!participant || !trackType) {
				return;
			}
			const channelKey = typeof channelIndex === "number" ? channelIndex : 0;
			const key = this.getTracklist()?.buildTrackKey(participant.uuid, trackType, channelKey);
			if (!key) {
				return;
			}
			const indicator = this.getTracklist()?.ensureOutputIndicator(key, participant, trackType, channelKey);
			if (!indicator) {
				return;
			}
			indicator.badge.textContent = "Recording";
			indicator.wrapper.dataset.state = "recording";
			this.updateRecordingRuntimeMetrics(key, indicator, event.detail);
			this.trackManifestChunk(event.detail);
		});

		recorder.addEventListener("meter-ready", event => {
			const { participant, trackType, channelIndex, meter } = event.detail || {};
			if (!participant?.uuid || trackType !== "audio") {
				return;
			}
			const key = this.getTracklist()?.buildTrackKey(participant.uuid, trackType, channelIndex);
			if (!key) {
				return;
			}
			const indicator = this.getTracklist()?.getIndicator(key);
			if (!indicator) {
				return;
			}
			this.getTracklist()?.attachSpectrogram(key, indicator, participant, trackType, channelIndex, meter);
		});

		recorder.addEventListener("participant-added", event => {
			const { participant, startOffsetSeconds } = event.detail || {};
			if (!participant) {
				return;
			}
			const annotateLateJoin = (trackType, trackIndex) => {
				const key = this.getTracklist()?.buildTrackKey(participant.uuid, trackType, trackIndex);
				if (key) {
					const indicator = this.getTracklist()?.ensureOutputIndicator(key, participant, trackType, trackIndex);
					if (indicator?.badge) {
						indicator.badge.textContent = "Late join";
						indicator.badge.title = `Joined ${startOffsetSeconds?.toFixed(1) || "?"}s into recording`;
					}
				}
			};
			const audioTracks = participant.stream?.getAudioTracks?.() || [];
			if (audioTracks.length) {
				audioTracks.forEach((_track, index) => annotateLateJoin("audio", index));
			}
			const videoTracks = participant.stream?.getVideoTracks?.() || [];
			if (videoTracks.length) {
				videoTracks.forEach((_track, index) => annotateLateJoin("video", index));
			}
			if (!audioTracks.length && !videoTracks.length) {
				annotateLateJoin("audio", 0);
			}
		});

		recorder.addEventListener("error", event => {
			console.error("Recorder error", event.detail);
			this.setStatusMessage("Recorder error: " + (event.detail?.message || "unknown"));
		});

		recorder.addEventListener("stop", event => {
			this.setRecording(false);
			this.setRecordTransitioning(false);
			this.getRecordingStatus()?.stopTimer();
			this.updateRecordingButtons();
			if (this.markerButton) {
				this.markerButton.disabled = true;
			}
			this.getMarkerLog()?.clearAutoTimer();
			this.getTracklist()?.showOutputsMessage("Finalising recordings…");
			this.getTracklist()?.clearTrackLevelNodes();
			this.getTracklist()?.teardownSpectrograms();
			this.presentRecordings(event.detail?.files);
			this.getTracklist()?.clearOutputIndicators();
			const runtimeStats = this.getTrackRuntimeStats();
			if (runtimeStats) {
				runtimeStats.clear();
			}
			this.updateHostMicUI();
			if (this.getRecordingPlan()?.sync) {
				this.getRecordingPlan().sync.stop = {
					wallClock: Date.now(),
					highRes: snapshotHighResClock()
				};
			}
			if (this.getRecordingPlan()) {
				this.getRecordingPlan().files = this.summariseRecordingFiles(event.detail?.files);
				this.logRecordingEvent("record:stop", {
					fileCount: this.getRecordingPlan()?.files?.length || 0,
					mode: this.getCaptureMode()?.getMode()
				});
				this.updateRecordingPlanStatus("stopped", {
					files: this.getRecordingPlan().files,
					events: this.getRecordingPlan().events
				});
			}
			this.getRecordingStatus()?.set("Recording idle", "idle");
		});
	}

	buildRecordingPlanContext({ diskInfo } = {}) {
		const now = Date.now();
		const cloudSnapshot = readCloudLinkStatus();
		const plan = {
			sessionId: createRecordingSessionId(),
			conductor: "studio",
			preparedAt: now,
			disk: {
				enabled: Boolean(diskInfo?.ready),
				folderName: diskInfo?.folderName || null,
				verifiedAt: diskInfo?.verifiedAt || null
			},
			cloud: {
				driveLinked: Boolean(this.hasDriveAccess() || cloudSnapshot.drive),
				dropboxLinked: Boolean(this.hasDropboxAccess() || cloudSnapshot.dropbox),
				snapshot: cloudSnapshot
			},
			sync: {
				prepared: snapshotHighResClock(),
				start: null,
				stop: null
			},
			capture: {
				mode: this.getCaptureMode()?.getMode(),
				includeVideo: this.getCaptureMode()?.getMode() === "video",
				includeScreenshares: this.getCaptureMode()?.getMode() === "video"
			},
			participants: {},
			files: [],
			events: []
		};
		this.setRecordingPlan(plan);
		this.setRecordingSessionId(plan.sessionId);
		this.logRecordingEvent("record:plan", { sessionId: plan.sessionId });
		dispatchStudioEvent(PODCAST_RECORD_PLAN_EVENT, { plan });
		this.getRecordingStatus()?.set("Recording plan armed", "armed");
		return plan;
	}

	updateRecordingPlanStatus(status, extra = {}) {
		if (!this.getRecordingPlan()) {
			return;
		}
		const detail = {
			status,
			plan: this.getRecordingPlan(),
			timestamp: Date.now(),
			...extra
		};
		dispatchStudioEvent(PODCAST_RECORD_STATUS_EVENT, detail);
	}

	trackManifestChunk(detail) {
		if (!this.getRecordingPlan() || !detail?.participant?.uuid) {
			return;
		}
		const plan = this.getRecordingPlan();
		const participantId = detail.participant.uuid;
		if (!plan.participants[participantId]) {
			plan.participants[participantId] = {
				participantId,
				label: detail.participant.label || participantId,
				tracks: {}
			};
		}
		const participantPlan = plan.participants[participantId];
		const trackKey = `${detail.trackType || "audio"}:${typeof detail.channelIndex === "number" ? detail.channelIndex : 0}`;
		if (!participantPlan.tracks[trackKey]) {
			participantPlan.tracks[trackKey] = {
				trackType: detail.trackType || "audio",
				channelIndex: typeof detail.channelIndex === "number" ? detail.channelIndex : 0,
				segments: [],
				totalBytes: 0,
				sequence: 0
			};
		}
		const track = participantPlan.tracks[trackKey];
		const bytes = detail.data?.size || 0;
		track.sequence += 1;
		track.totalBytes += bytes;
		const timecodeMs = this.getRecordStartedAt() ? Date.now() - this.getRecordStartedAt() : 0;
		const segment = {
			sequence: track.sequence,
			bytes,
			receivedAt: Date.now(),
			timecodeMs
		};
		if (track.segments.length > 48) {
			track.segments.shift();
		}
		track.segments.push(segment);
	}

	summariseRecordingFiles(filesMap) {
		if (!filesMap || typeof filesMap.forEach !== "function") {
			return [];
		}
		const summaries = [];
		filesMap.forEach(meta => {
			if (!meta) {
				return;
			}
			summaries.push({
				participant: meta.participant?.uuid || null,
				label: meta.participant?.label || null,
				trackType: meta.trackType,
				channelIndex: meta.channelIndex,
				filename: meta.filename,
				mimeType: meta.mimeType,
				size: meta.size,
				durationSeconds: meta.durationSeconds
			});
		});
		return summaries;
	}

	logRecordingEvent(type, data = {}) {
		if (!type) {
			return;
		}
		if (!this.getRecordingPlan()) {
			this.setRecordingPlan({
				sessionId: createRecordingSessionId(),
				events: []
			});
		}
		const plan = this.getRecordingPlan();
		if (!Array.isArray(plan.events)) {
			plan.events = [];
		}
		const timestamp = Date.now();
		const timecodeMs = this.getRecordStartedAt() ? Math.max(0, timestamp - this.getRecordStartedAt()) : 0;
		plan.events.push({
			type,
			timestamp,
			timecodeMs,
			data
		});
		if (plan.events.length > 2000) {
			plan.events.shift();
		}
	}

	tryAddParticipantToRecording(participant) {
		if (!this.getRecording() || !this.getRecorder()) {
			return;
		}
		if (!participant?.stream) {
			return;
		}
		try {
			const result = this.getRecorder().addParticipant(participant);
			if (result?.added) {
				console.log(`Added late-joining participant to recording: ${participant.label || participant.uuid} (offset: ${result.startOffsetSeconds?.toFixed(1)}s)`);
				this.logRecordingEvent("participant:added-mid-recording", {
					uuid: participant.uuid,
					label: participant.label,
					startOffsetSeconds: result.startOffsetSeconds,
					trackCount: result.tracks
				});
				// Drop a sync marker so the new track can be aligned with existing tracks
				this.addSyncMarkerForNewTrack(participant, result.startOffsetSeconds);
			}
		} catch (error) {
			console.warn("Failed to add participant to recording", error);
		}
	}

	addSyncMarkerForNewTrack(participant, startOffsetSeconds) {
		if (!this.getRecording() || !this.getRecordStartedAt()) {
			return;
		}
		// Wait 1 second after track starts, then drop a sync marker
		// This gives the track time to stabilize before the sync point
		setTimeout(() => {
			if (!this.getRecording()) {
				return;
			}
			const timestamp = this.getRecordStartedAt() ? (Date.now() - this.getRecordStartedAt()) / 1000 : startOffsetSeconds + 1;
			const label = participant?.label || participant?.uuid || "Guest";
			const note = {
				time: timestamp,
				label: `Sync: ${label} joined @ ${timestamp.toFixed(1)}s`,
				auto: true,
				joinSync: true
			};
			this.getMarkerLog()?.add(note);
		}, 1000);
	}

	openRecordShowWindow() {
		const room = this.resolveRoomName();
		if (!room) {
			this.setStatusMessage("Set a room name before recording the show.");
			return;
		}
		// Build URL to the main VDO.ninja with scene + recordwindow
		const baseUrl = window.location.origin + window.location.pathname.replace(/\/podcast\/?.*/, "");
		const url = `${baseUrl}/?scene=0&room=${encodeURIComponent(room)}&recordwindow&chroma=000&locked=1.777`;
		const win = window.open(url, "recordShow", "toolbar=no,location=no,status=no,menubar=no,scrollbars=no,resizable=yes,width=1280,height=720");
		if (win) {
			win.focus();
		}
	}

	dispose() {
		this.recordButton = null;
		this.markerButton = null;
		this.recordingSummary = null;
	}
}
