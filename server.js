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

// Deny-list internal files that happen to live inside ROOT (see the comment on
// ROOT above) and would otherwise be served as ordinary static files: the
// server's own source, its dependency tree, and internal audit docs.
// Runs BEFORE express.static and ends the request outright — it never calls
// next() for a match — because the SPA fallback further down serves
// index.html (200) for any unmatched, extensionless GET, and an extensionless
// blocked path like /node_modules/express would otherwise fall through to it.
const BLOCKED_EXACT = new Set([
	"/server.js",
	"/package.json",
	"/package-lock.json",
	// Internal audit reports — same class of "ops file that shouldn't be
	// public" as the three above; harmless to keep blocking even on forks
	// that don't have these files.
	"/audit_report.md",
	"/improvements_report.md",
	// The bare directory path; everything under it is covered by
	// BLOCKED_PREFIXES below.
	"/node_modules"
]);
// Precomputed once (not per-request) for the child-of-blocked-file check in
// the middleware further down.
const BLOCKED_EXACT_LIST = [...BLOCKED_EXACT];
// Matched against the normalized path directly, so these only block
// "/<dir>/...". Bare "/docs" is deliberately NOT in this list: it's the
// clean URL express.static resolves to the real, shipped docs.html page
// (see `extensions: ["html"]` below), and blocking it would 404 that page
// for every forker who clones this repo (docs.html is tracked; only the
// contents of docs/ are gitignored). Bare "/node_modules" is covered by
// BLOCKED_EXACT above.
const BLOCKED_PREFIXES = ["/node_modules/", "/docs/"]; // this dir and everything under it

// Reduces a raw request path to a canonical form for comparison against the
// deny-list above, closing the path-normalization tricks that would otherwise
// let a blocked file slip past a naive string match:
//   - percent-decodes it (%2e -> ".", %2f -> "/", %73 -> "s", ...) so encoded
//     traversal/case tricks compare the same as their literal form;
//   - normalizes backslashes to forward slashes, since Windows treats "\" as
//     a path separator and it otherwise survives decodeURIComponent untouched;
//   - resolves "." / ".." segments, matching how the filesystem ultimately
//     resolves a path like /node_modules/../server.js;
//   - truncates everything from the first ":" onward. Windows/NTFS resolves
//     alternate-data-stream syntax ("/server.js::$DATA") to the file's
//     default stream, i.e. to the file itself, which would otherwise slip
//     past every entry in BLOCKED_EXACT. This must run AFTER normalize()
//     above, not before: "/foo:bar/../server.js" needs its ".." resolved
//     first, or truncating at the first ":" too early would cut it down to
//     "/foo" and let the real "../server.js" traversal through underneath;
//   - strips a single trailing slash. This is load-bearing on its own: a
//     literal trailing backslash ("/server.js\") survives decodeURIComponent
//     untouched, and the backslash-to-forward-slash rewrite above turns it
//     into "/server.js/";
//   - strips a trailing run of dots/spaces. Hand-rolled rather than a
//     /[ .]+$/ regex: that backtracks quadratically when the run isn't at
//     the very end of the string, so a ~16KB request path with a long
//     mid-string run of dots burned ~80ms of event-loop time per request —
//     a remotely-triggerable DoS from a handful of concurrent requests, for
//     a defense that Node's fs layer doesn't actually need (it opens paths
//     via "\\?\"-prefixed extended-length paths, which disable Win32
//     filename trimming, so trailing dots/spaces never reach a real file
//     anyway). Kept anyway as free, zero-cost defense-in-depth now that it's
//     linear;
//   - lowercases the result, because this app runs on case-insensitive
//     filesystems (Windows, default macOS) where /SERVER.JS and /server.js
//     resolve to the same file.
function normalizeForDenylist(rawPath) {
	let decoded;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		decoded = rawPath; // malformed % escape; compare the raw path instead of throwing
	}
	let normalized = path.posix.normalize(decoded.replace(/\\/g, "/"));
	const colonIndex = normalized.indexOf(":");
	if (colonIndex !== -1) {
		normalized = normalized.slice(0, colonIndex);
	}
	if (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}
	let end = normalized.length;
	while (end > 0 && (normalized[end - 1] === "." || normalized[end - 1] === " ")) {
		end--;
	}
	return normalized.slice(0, end).toLowerCase();
}

app.use((req, res, next) => {
	const normalized = normalizeForDenylist(req.path);
	const isBlockedName = BLOCKED_EXACT.has(normalized) || BLOCKED_PREFIXES.some(prefix => normalized.startsWith(prefix));
	// A blocked *file* can never legitimately have path children, so also
	// catch e.g. "/server.js/..namedfork/data" — macOS/HFS+'s resource-fork
	// syntax, the ADS trick's macOS analogue. "..namedfork" is not a ".."
	// segment, so it survives path.posix.normalize() untouched and isn't
	// caught by send's traversal guard either.
	const isChildOfBlockedFile = BLOCKED_EXACT_LIST.some(name => normalized.startsWith(name + "/"));
	if (isBlockedName || isChildOfBlockedFile) {
		return res.status(404).end(); // 404, not 403 — don't confirm the file exists
	}
	next();
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
