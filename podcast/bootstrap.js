const params = new URLSearchParams(window.location.search);
const studioMode = params.has("podcast");

if (studioMode) {
	import("./studio.js?v=44");
	document.body.style.display = "unset";
}
