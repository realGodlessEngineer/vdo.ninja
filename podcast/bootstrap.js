const params = new URLSearchParams(window.location.search);
const studioMode = params.has("podcast");

if (studioMode) {
	import("./studio.js?v=29");
	document.body.style.display = "unset";
}
