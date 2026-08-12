const SESSION_POLL_MS = 25;

export function getLegacySession() {
	if (typeof window === "undefined") {
		throw new Error("Session bridge requires a browser context.");
	}
	if (!window.session) {
		throw new Error("Legacy session object is not initialised yet.");
	}
	return window.session;
}

export async function waitForLegacySession(options = {}) {
	const { timeoutMs = 5000, signal } = options;
	const start = performance.now();

	while (true) {
		if (signal?.aborted) {
			throw abortReason(signal);
		}
		if (window.session) {
			return window.session;
		}
		if (performance.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for legacy session initialisation.");
		}
		await delay(SESSION_POLL_MS, signal);
	}
}

// setTimeout-based delay that rejects early if an optional AbortSignal fires mid-wait.
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(abortReason(signal));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// AbortSignal.reason defaults to an AbortError DOMException in modern browsers; fall back for older engines that leave it undefined.
function abortReason(signal) {
	return signal.reason !== undefined ? signal.reason : new DOMException("Wait for legacy session was aborted.", "AbortError");
}

export function onLegacyEvent(eventName, handler) {
	const session = getLegacySession();
	if (!session._podcastStudioListeners) {
		session._podcastStudioListeners = new Map();
	}
	if (!session._podcastStudioListeners.has(eventName)) {
		session._podcastStudioListeners.set(eventName, new Set());
	}
	const listeners = session._podcastStudioListeners.get(eventName);
	listeners.add(handler);

	return () => {
		listeners.delete(handler);
	};
}

// shim to forward events from legacy dispatchers
export function forwardLegacyEvent(eventName, payload) {
	const session = getLegacySession();
	const listeners = session._podcastStudioListeners?.get(eventName);
	if (!listeners) {
		return;
	}
	listeners.forEach(fn => {
		try {
			fn(payload);
		} catch (error) {
			console.error("Legacy event listener failed", error);
		}
	});
}
