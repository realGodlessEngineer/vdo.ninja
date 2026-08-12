const DISK_RECORDING_STORAGE_KEY = "podcastStudio.diskRecordingState";
const DISK_DB_NAME = "podcastStudio.disk";
const DISK_DB_STORE = "handles";
const PODCAST_DISK_EVENT = "podcast-disk-state";

function dispatchDiskEvent(name, detail = {}) {
	if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
		return;
	}
	try {
		window.dispatchEvent(new CustomEvent(name, { detail }));
	} catch (error) {
		console.warn("Unable to dispatch studio event", name, error);
	}
}

export function readDiskRecordingState() {
	try {
		const raw = window.localStorage.getItem(DISK_RECORDING_STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (error) {
		console.warn("Unable to read disk recording state", error);
		return {};
	}
}

export function isDiskRecordingEnabled() {
	const state = readDiskRecordingState();
	return Boolean(state.folderName && state.enabled);
}

export function setDiskRecordingEnabled(enabled) {
	const current = readDiskRecordingState();
	const next = {
		...current,
		enabled: Boolean(enabled) && Boolean(current.folderName),
		updatedAt: Date.now()
	};
	writeDiskRecordingState(next);
	return next;
}

export function writeDiskRecordingState(state) {
	const snapshot = state || {};
	try {
		window.localStorage.setItem(DISK_RECORDING_STORAGE_KEY, JSON.stringify(snapshot));
	} catch (error) {
		console.warn("Unable to persist disk recording state", error);
		return;
	}
	dispatchDiskEvent(PODCAST_DISK_EVENT, { state: snapshot });
}

function openDiskHandleDatabase() {
	return new Promise((resolve, reject) => {
		if (!window.indexedDB) {
			reject(new Error("IndexedDB unavailable"));
			return;
		}
		const request = window.indexedDB.open(DISK_DB_NAME, 1);
		request.onerror = () => reject(request.error || new Error("Unable to open disk handle database"));
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(DISK_DB_STORE)) {
				db.createObjectStore(DISK_DB_STORE);
			}
		};
		request.onsuccess = () => resolve(request.result);
	});
}

async function saveDiskDirectoryHandle(handle) {
	if (!handle) {
		return;
	}
	const db = await openDiskHandleDatabase();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(DISK_DB_STORE, "readwrite");
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error || new Error("Unable to store disk handle"));
		};
		tx.objectStore(DISK_DB_STORE).put(handle, "primary");
	});
}

export async function readDiskDirectoryHandle() {
	const db = await openDiskHandleDatabase();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(DISK_DB_STORE, "readonly");
		tx.oncomplete = () => {
			db.close();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error || new Error("Unable to read disk handle"));
		};
		const request = tx.objectStore(DISK_DB_STORE).get("primary");
		request.onsuccess = () => resolve(request.result || null);
	});
}

export async function verifyStoredDiskRecordingDirectory({ requestPermission = false } = {}) {
	try {
		const handle = await readDiskDirectoryHandle();
		if (!handle) {
			return { ok: false, message: "No folder selected yet." };
		}
		let permission = await handle.queryPermission({ mode: "readwrite" });
		if (permission === "prompt" && requestPermission) {
			permission = await handle.requestPermission({ mode: "readwrite" });
		}
		if (permission !== "granted") {
			return { ok: false, message: "Access to the selected folder was denied." };
		}
		const meta = readDiskRecordingState();
		writeDiskRecordingState({
			...meta,
			lastVerifiedAt: Date.now(),
			folderName: meta.folderName || handle.name || "Selected folder",
			lastError: null
		});
		return { ok: true, folderName: meta.folderName || handle.name || "Selected folder" };
	} catch (error) {
		console.warn("Failed to verify disk folder", error);
		const meta = readDiskRecordingState();
		writeDiskRecordingState({
			...meta,
			lastError: error?.message || "Unable to verify folder access."
		});
		return { ok: false, message: error?.message || "Unable to verify folder access." };
	}
}

export async function chooseDiskRecordingDirectory() {
	if (typeof window.showDirectoryPicker !== "function") {
		throw new Error("This browser does not support the file-system directory picker yet.");
	}
	const handle = await window.showDirectoryPicker({ mode: "readwrite" });
	if (!handle) {
		throw new Error("Folder selection was cancelled.");
	}
	await saveDiskDirectoryHandle(handle);
	const meta = readDiskRecordingState();
	writeDiskRecordingState({
		...meta,
		folderName: handle.name || "Recording folder",
		lastVerifiedAt: Date.now(),
		lastError: null
	});
	return { handle, folderName: handle.name || "Recording folder" };
}
