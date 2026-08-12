import { ICECAST_MIME_OPTIONS } from "./icecast-publisher.js?v=2";

const ICECAST_SETTINGS_STORAGE_KEY = "podcastStudio.icecastSettings";
const ICECAST_SETTINGS_VERSION = 2;
export const DEFAULT_ICECAST_MIME_TYPE = ICECAST_MIME_OPTIONS[0].value;
const DEFAULT_ICECAST_RELAY_URL = "https://vdo-ninja-icecast-relay.vdo.workers.dev/publish";

export function readIcecastSettings() {
	try {
		const raw = window.localStorage.getItem(ICECAST_SETTINGS_STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") {
			return {};
		}
		const settings = { ...parsed };
		const version = Number(settings.version || 0);
		if (version < ICECAST_SETTINGS_VERSION && (!settings.mimeType || settings.mimeType === "audio/webm;codecs=opus" || settings.mimeType === "audio/webm")) {
			settings.mimeType = DEFAULT_ICECAST_MIME_TYPE;
		}
		settings.version = ICECAST_SETTINGS_VERSION;
		return settings;
	} catch (error) {
		console.warn("Unable to read Icecast settings", error);
		return {};
	}
}

export function writeIcecastSettings(settings) {
	const safeSettings = { ...(settings || {}) };
	delete safeSettings.relayUrl;
	delete safeSettings.relayToken;
	safeSettings.version = ICECAST_SETTINGS_VERSION;
	try {
		window.localStorage.setItem(ICECAST_SETTINGS_STORAGE_KEY, JSON.stringify(safeSettings));
	} catch (error) {
		console.warn("Unable to store Icecast settings", error);
	}
}

function readUrlParam(name) {
	try {
		if (typeof urlParams !== "undefined" && urlParams && typeof urlParams.get === "function") {
			return urlParams.get(name) || "";
		}
	} catch (error) {
		console.warn("Unable to read URL params", error);
	}
	try {
		const params = new URLSearchParams(window.location.search);
		return params.get(name) || "";
	} catch (error) {
		console.warn("Unable to parse URL params", error);
	}
	return "";
}

export function resolveIcecastRelayUrl(settings = {}) {
	const configured = (typeof window !== "undefined" && typeof window.VDO_NINJA_ICECAST_RELAY_URL === "string" ? window.VDO_NINJA_ICECAST_RELAY_URL : "") || readUrlParam("icecastrelay") || readUrlParam("icecastrelayurl") || settings.relayUrl || DEFAULT_ICECAST_RELAY_URL;
	return (configured || "").trim();
}

export function resolveIcecastRelayToken() {
	const configured = (typeof window !== "undefined" && typeof window.VDO_NINJA_ICECAST_RELAY_TOKEN === "string" ? window.VDO_NINJA_ICECAST_RELAY_TOKEN : "") || readUrlParam("icecastrelaytoken");
	return (configured || "").trim();
}
