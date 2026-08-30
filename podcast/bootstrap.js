const params = new URLSearchParams(window.location.search);
const studioMode = params.has("podcast");
const showMode = params.has("showmode");

if (studioMode) {
	import("./studio.js?v=44");
	document.body.style.display = "unset";
}

if (showMode) {
	import("../core/showmode/index.js?v=2");
}
