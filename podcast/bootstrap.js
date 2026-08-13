const params = new URLSearchParams(window.location.search);
const studioMode = params.has("podcast");

if (studioMode) {
	import("./studio.js?v=25");
	document.body.style.display = "unset";
}
