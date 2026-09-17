// Show-mode module entry (Phase 2; co-host role added in Phase 6).
//
// Lazy-loaded by podcast/bootstrap.js only when `&showmode` (director console) or
// `&cohost` (co-host view) is present, so the default UI never pays for it. The
// URL params are the same source main.js reads to set `session.showmode` /
// `session.cohost`, so there is no ordering race with main() here. Each role's
// module is imported on demand, so a page only loads the code for its own role.

const params = new URLSearchParams(window.location.search);

if (params.has("showmode")) {
	import("./console.js?v=6")
		.then(mod => mod.startShowmodeConsole())
		.catch(error => {
			console.warn("[showmode] console failed to start", error);
		});
}

if (params.has("cohost")) {
	import("./cohost.js?v=6")
		.then(mod => mod.startCohostView())
		.catch(error => {
			console.warn("[showmode] co-host view failed to start", error);
		});
}
