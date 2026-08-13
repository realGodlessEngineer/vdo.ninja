export function formatRelativeTime(timestamp) {
	if (!timestamp) {
		return "";
	}
	const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (deltaSeconds < 45) {
		return "just now";
	}
	if (deltaSeconds < 90) {
		return "about a minute ago";
	}
	if (deltaSeconds < 45 * 60) {
		const minutes = Math.round(deltaSeconds / 60);
		return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	}
	if (deltaSeconds < 90 * 60) {
		return "about an hour ago";
	}
	if (deltaSeconds < 36 * 3600) {
		const hours = Math.round(deltaSeconds / 3600);
		return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	}
	const days = Math.round(deltaSeconds / 86400);
	return `${days} day${days === 1 ? "" : "s"} ago`;
}
