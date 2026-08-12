const CAPTURE_MODE_STORAGE_KEY = "podcastStudio.captureMode";

export function readCaptureMode() {
	try {
		const raw = window.localStorage.getItem(CAPTURE_MODE_STORAGE_KEY);
		const normalized = (raw || "audio").toString().toLowerCase();
		if (normalized === "video") {
			return "video";
		}
	} catch (error) {
		console.warn("Unable to read capture mode", error);
	}
	return "audio";
}

export function writeCaptureMode(mode) {
	const normalized = mode === "video" ? "video" : "audio";
	try {
		window.localStorage.setItem(CAPTURE_MODE_STORAGE_KEY, normalized);
	} catch (error) {
		console.warn("Unable to persist capture mode", error);
	}
	return normalized;
}
