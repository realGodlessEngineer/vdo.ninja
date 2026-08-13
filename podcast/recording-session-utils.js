export function createRecordingSessionId() {
	try {
		if (typeof crypto !== "undefined" && crypto.randomUUID) {
			return crypto.randomUUID();
		}
	} catch (error) {
		console.warn("randomUUID unavailable", error);
	}
	return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function snapshotHighResClock() {
	if (typeof performance === "undefined" || typeof performance.now !== "function") {
		return null;
	}
	const now = performance.now();
	const origin = typeof performance.timeOrigin === "number" ? performance.timeOrigin : Date.now() - now;
	return {
		perfNow: now,
		timeOrigin: origin,
		wallClockMs: Math.round(origin + now)
	};
}
