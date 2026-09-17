const params = new URLSearchParams(window.location.search);
const studioMode = params.has("podcast");
const showMode = params.has("showmode");
const coHost = params.has("cohost");

if (studioMode) {
	import("./studio.js?v=44");
	document.body.style.display = "unset";
}

if (showMode || coHost) {
	import("../core/showmode/index.js?v=6");
}
