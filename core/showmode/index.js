// Show-mode director console — module entry (Phase 2).
//
// Lazy-loaded by podcast/bootstrap.js only when `&showmode` is present, so the
// default UI never pays for it. The URL param is the same source main.js reads
// to set `session.showmode`, so there is no ordering race with main() here.

import { startShowmodeConsole } from "./console.js";

const params = new URLSearchParams(window.location.search);

if (params.has("showmode")) {
	startShowmodeConsole().catch(error => {
		console.warn("[showmode] console failed to start", error);
	});
}
