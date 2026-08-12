const PREFLIGHT_STORAGE_KEY = "podcastStudio.preflightState";
const PREFLIGHT_CACHE_MS = 6 * 60 * 60 * 1000;

export function readPreflightState() {
	try {
		const raw = window.localStorage.getItem(PREFLIGHT_STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed;
		}
	} catch (error) {
		console.warn("Unable to read preflight cache", error);
	}
	return {};
}

export function writePreflightState(state) {
	try {
		window.localStorage.setItem(PREFLIGHT_STORAGE_KEY, JSON.stringify(state || {}));
	} catch (error) {
		console.warn("Unable to persist preflight cache", error);
	}
}

export function isPreflightFresh(timestamp) {
	if (!timestamp) {
		return false;
	}
	return Date.now() - timestamp < PREFLIGHT_CACHE_MS;
}
