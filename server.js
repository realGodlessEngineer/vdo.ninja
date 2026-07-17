/*
 * Express server for self-hosting a customizable VDO.Ninja client.
 *
 * VDO.Ninja itself is a static web app (see CLAUDE.md), so this server's main
 * job is to serve the repo's files with the same URL behavior as the reference
 * Nginx config in install.md:
 *   - CORS "*" on every response (OBS Browser Sources and iframes fetch cross-origin)
 *   - /foo.html redirects to the clean URL /foo
 *   - /foo resolves to foo.html; / resolves to index.html
 *   - unknown paths fall back to index.html
 *
 * The "CUSTOM ROUTES" section below is where you add your own server-side logic
 * (config injection, branding, proxying a private signaling/TURN server, etc.).
 * Those routes are registered BEFORE the static handler so they win over files.
 */

const path = require("path");
const express = require("express");
const compression = require("compression");

const ROOT = __dirname; // the VDO.Ninja files live at the repo root
// Default port 8366 spells "VDON" (VDO.Ninja) on a phone keypad. A hosting
// platform's PORT env var always overrides this in production.
const PORT = process.env.PORT || 8366;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();

// Hosting platforms terminate TLS at a proxy and forward via X-Forwarded-* headers.
app.set("trust proxy", true);

// gzip responses. lib.js (~2MB) and webrtc.js (~700KB) compress dramatically.
app.use(compression());

// Match production: allow the client and its assets to be embedded / fetched cross-origin.
app.use((req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	next();
});

// ---------------------------------------------------------------------------
// CUSTOM ROUTES — add your customizations here (they take priority over files)
// ---------------------------------------------------------------------------

// Health check for the hosting platform's uptime probes.
app.get("/healthz", (req, res) => {
	res.json({ ok: true, uptime: process.uptime() });
});

// Example: expose deploy-time config to the client from environment variables.
// Include it in a page with <script src="/config.js"></script> and read window.CUSTOM_CONFIG.
// Handy for injecting your own TURN server, signaling host, or branding without
// editing the (frequently-updated) VDO.Ninja source files.
app.get("/config.js", (req, res) => {
	const config = {
		turnServer: process.env.TURN_SERVER || null,
		signalingHost: process.env.SIGNALING_HOST || null,
		brandName: process.env.BRAND_NAME || "VDO.Ninja"
	};
	res.type("application/javascript");
	res.send(`window.CUSTOM_CONFIG = ${JSON.stringify(config)};`);
});

// ---------------------------------------------------------------------------
// STATIC FILE SERVING (production-like URL behavior)
// ---------------------------------------------------------------------------

// Redirect /foo.html -> /foo (preserving the query string), like the Nginx config.
app.get(/\.html$/, (req, res, next) => {
	const clean = req.path.replace(/\.html$/, "");
	// Guard against open redirects (CWE-601). A request like //evil.com.html or
	// /\evil.com.html strips down to //evil.com or /\evil.com, and browsers treat
	// a Location header starting with // (or a backslash-normalized //) as a
	// protocol-relative, cross-origin absolute URL rather than a same-origin path.
	// Only redirect when `clean` is a genuine same-origin path: exactly one leading
	// slash (not // or /\) and no backslashes anywhere. Otherwise fall through to
	// the static handler / SPA fallback, which will 404 the bogus path.
	const isSameOriginPath = /^\/(?![\/\\])/.test(clean) && !clean.includes("\\");
	if (!isSameOriginPath) {
		return next();
	}
	const queryIndex = req.originalUrl.indexOf("?");
	const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
	res.redirect(302, clean + query);
});

// Serve real files. `extensions: ["html"]` makes /mixer resolve to mixer.html;
// `index` serves index.html for directory roots.
app.use(
	express.static(ROOT, {
		extensions: ["html"],
		index: "index.html",
		dotfiles: "ignore"
	})
);

// Fallback: send index.html for unmatched, extensionless navigations
// (clean/room-style URLs like /myRoomName), but return 404 for a missing
// asset (anything with an extension: .js/.css/.png/...) so failures are obvious
// instead of being masked by a 200 HTML page.
app.use((req, res) => {
	const hasFileExtension = path.extname(req.path) !== "";
	if (req.method === "GET" && !hasFileExtension && req.accepts("html")) {
		res.sendFile(path.join(ROOT, "index.html"));
	} else {
		res.status(404).end();
	}
});

app.listen(PORT, HOST, () => {
	console.log(`VDO.Ninja client serving on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});
