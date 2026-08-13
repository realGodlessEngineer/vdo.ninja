export const ROOM_QUERY_KEYS = ["room", "roomid", "r"];
export const DIRECTOR_QUERY_KEYS = ["director", "dir"];
const ROOM_STATE_STORAGE_KEY = "podcastStudio.lastRoom";

export function sanitizeRoomSlug(value) {
	if (!value) {
		return "";
	}
	const trimmed = String(value).trim();
	if (!trimmed) {
		return "";
	}
	try {
		if (typeof window.sanitizeRoomName === "function") {
			return window.sanitizeRoomName(trimmed);
		}
	} catch (error) {
		console.warn("sanitizeRoomName unavailable", error);
	}
	return trimmed.replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 64);
}

export function getRoomSlugFromParams(params = new URLSearchParams(window.location.search)) {
	for (const key of DIRECTOR_QUERY_KEYS) {
		if (params.has(key)) {
			const slug = sanitizeRoomSlug(params.get(key));
			if (slug) {
				return slug;
			}
		}
	}
	for (const key of ROOM_QUERY_KEYS) {
		if (params.has(key)) {
			const slug = sanitizeRoomSlug(params.get(key));
			if (slug) {
				return slug;
			}
		}
	}
	return "";
}

export function readStoredRoomState() {
	try {
		const raw = window.localStorage.getItem(ROOM_STATE_STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return {
				room: typeof parsed.room === "string" ? parsed.room : "",
				password: typeof parsed.password === "string" ? parsed.password : ""
			};
		}
	} catch (error) {
		console.warn("Unable to read stored room state", error);
	}
	return {};
}

export function persistStoredRoomState(state) {
	try {
		window.localStorage.setItem(ROOM_STATE_STORAGE_KEY, JSON.stringify(state || {}));
	} catch (error) {
		console.warn("Unable to store room state", error);
	}
}
