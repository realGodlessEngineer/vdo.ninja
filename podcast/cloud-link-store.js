const CLOUD_STATUS_STORAGE_KEY = "podcastStudio.cloudStatus";
const CLOUD_STATUS_STALE_MS = 30 * 60 * 1000;
const PODCAST_CLOUD_EVENT = "podcast-cloud-status";

function dispatchCloudEvent(name, detail = {}) {
	if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
		return;
	}
	try {
		window.dispatchEvent(new CustomEvent(name, { detail }));
	} catch (error) {
		console.warn("Unable to dispatch studio event", name, error);
	}
}

export function readCloudLinkStatus() {
	try {
		const raw = window.localStorage.getItem(CLOUD_STATUS_STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (error) {
		console.warn("Unable to read cloud link status", error);
		return {};
	}
}

export function writeCloudLinkStatus(nextState) {
	const snapshot = nextState || {};
	try {
		window.localStorage.setItem(CLOUD_STATUS_STORAGE_KEY, JSON.stringify(snapshot));
	} catch (error) {
		console.warn("Unable to persist cloud link status", error);
		return;
	}
	dispatchCloudEvent(PODCAST_CLOUD_EVENT, { state: snapshot });
}

export function isCloudLinkFresh(entry) {
	if (!entry?.linkedAt) {
		return false;
	}
	return Date.now() - entry.linkedAt < CLOUD_STATUS_STALE_MS;
}

export function markCloudLinked(service, details = {}) {
	if (!service) {
		return;
	}
	const state = readCloudLinkStatus();
	state[service] = {
		linkedAt: Date.now(),
		...details
	};
	writeCloudLinkStatus(state);
}

export function markCloudUnlinked(service) {
	if (!service) {
		return;
	}
	const state = readCloudLinkStatus();
	if (state[service]) {
		delete state[service];
		writeCloudLinkStatus(state);
	}
}
