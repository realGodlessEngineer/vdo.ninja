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
const fs = require("fs");
const express = require("express");
const compression = require("compression");

const ROOT = __dirname; // the VDO.Ninja files live at the repo root

const app = express();

// Don't advertise the framework in responses -- trivial info leak that helps
// an attacker fingerprint the stack for known Express CVEs.
app.disable("x-powered-by");

// TRUST_PROXY controls how Express derives req.ip / req.protocol from the
// client-spoofable X-Forwarded-* headers. There's no IP-based logic in this
// app today, but any future rate limiter, IP allowlist, or access log would
// inherit whatever this is set to, so it defaults to "loopback": trust only
// 127.0.0.1/::1. That's safe with no proxy in front (no untrusted hop can
// inject those headers) and also correct for a same-host reverse proxy. A
// platform that puts exactly one proxy in front of this server (Railway,
// Fly, Heroku, a remote Nginx/Caddy box, etc.) should set TRUST_PROXY=1 to
// trust just that one hop. Accepted values: an integer hop count ("1", "2",
// ...), "false" (matched case-insensitively, e.g. "FALSE"/"False" also work)
// to disable trust entirely, or anything else passed through verbatim to
// Express, which understands preset names ("loopback", "linklocal",
// "uniquelocal"), single IPs, CIDR subnets ("10.0.0.0/8"), and
// comma-separated lists of those. Unset, empty, or whitespace-only falls
// back to the "loopback" default rather than being passed through. An
// unrecognized/invalid value (e.g. "-1", "off") is never silently defaulted
// -- that could leave the server trusting the wrong hops -- it fails fast at
// boot with an error that names TRUST_PROXY and the value it rejected.
const rawTrustProxy = (process.env.TRUST_PROXY ?? "").trim();

// ---------------------------------------------------------------------------
// Centralized, validated server configuration (F7). Every environment-driven
// knob is read from process.env exactly once, here -- add new settings to
// this object instead of reading process.env inline elsewhere in the file.
// `theme` and `logRequests` aren't consumed by anything yet; they're the
// intentional single-surface seam reserved for later work (F16 theme
// injection, F11 request logging) to extend instead of adding another ad hoc
// env read.
// ---------------------------------------------------------------------------
const config = {
	// Default port 8366 spells "VDON" (VDO.Ninja) on a phone keypad. A hosting
	// platform's PORT env var always overrides this in production.
	// Number.parseInt("", 10) and any non-numeric value both yield NaN, so
	// `|| 8366` catches those the same as unset -- instead of a bad string
	// silently reaching net.Server#listen() and failing deep inside Node with
	// an obscure error.
	port: Number.parseInt(process.env.PORT, 10) || 8366,
	host: process.env.HOST || "0.0.0.0",
	trustProxy: rawTrustProxy === "" ? "loopback" : rawTrustProxy.toLowerCase() === "false" ? false : /^\d+$/.test(rawTrustProxy) ? Number(rawTrustProxy) : rawTrustProxy,
	turnServer: process.env.TURN_SERVER || null,
	signalingHost: process.env.SIGNALING_HOST || null,
	brandName: process.env.BRAND_NAME || "VDO.Ninja",
	brandVersion: process.env.BRAND_VERSION || null,
	theme: process.env.THEME || null,
	logRequests: process.env.LOG_REQUESTS === "true"
};

try {
	app.set("trust proxy", config.trustProxy);
} catch (err) {
	console.error(`Invalid TRUST_PROXY value ${JSON.stringify(rawTrustProxy)}: ${err.message}. Accepted: an integer hop count, "false" (any case), a preset (loopback/linklocal/uniquelocal), an IP, a CIDR, or a comma-list of those.`);
	process.exit(1);
}

// F16: the operator-supplied THEME name is only honored if it's a simple slug
// -- letters, digits, "-" and "_" only. That guarantee is what lets it be
// composed into a filesystem path below (themes/<name>.css) without risk: no
// path separator, no "..", nothing that could traverse out of themes/. A
// set-but-invalid value disables theming rather than crashing this purely
// cosmetic feature at boot, and is announced once so an operator who typo'd
// knows why their theme didn't load. Both F16 surfaces (the /theme.css route
// and the HTML-injection middleware) gate on THEME_NAME, not config.theme, so
// an unsafe value is inert everywhere.
const THEME_NAME = config.theme && /^[a-zA-Z0-9_-]+$/.test(config.theme) ? config.theme : null;
if (config.theme && !THEME_NAME) {
	console.warn(`Ignoring THEME=${JSON.stringify(config.theme)}: theme names may contain only letters, digits, "-" and "_".`);
}

// gzip responses. lib.js (~2MB) and webrtc.js (~700KB) compress dramatically.
app.use(compression());

// Match production: allow the client and its assets to be embedded / fetched cross-origin.
// Also set a small set of safe, non-breaking security headers on every response here.
// Deliberately NOT set: X-Frame-Options or a CSP frame-ancestors directive. Embedding
// VDO.Ninja via <iframe> is a first-class, documented feature (see CLAUDE.md's "IFRAME
// API" section) and OBS Browser Sources rely on it -- either header would break embedding.
// Do not "helpfully" add one; that's the whole reason this comment exists.
app.use((req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
	res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
	next();
});

// F11: opt-in, dependency-free access log -- silent by default so self-hosters
// get a quiet server, set LOG_REQUESTS=true to get a line per request for debugging.
if (config.logRequests) {
	app.use((req, res, next) => {
		const start = process.hrtime.bigint();
		res.on("finish", () => {
			const ms = Number(process.hrtime.bigint() - start) / 1e6;
			console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
		});
		next();
	});
}

// ---------------------------------------------------------------------------
// Error responses (F6): one content-negotiated helper reused by both 404
// sites below and the final error handler at the bottom of the file. An HTML
// client (req.accepts("html")) gets a minimal, accessible, self-contained
// document -- lang, viewport, a heading, a short message, and a link home --
// instead of an empty white page; anything else (fetch/XHR/curl/an API
// consumer) gets a small JSON body instead. `heading` and `body` are always
// hardcoded string literals passed by the call sites in this file, never
// request data (URL, headers, params, query) -- keep it that way, or this
// becomes a reflected-XSS sink.
// ---------------------------------------------------------------------------
function sendError(req, res, status, heading, body) {
	res.status(status);
	if (req.accepts("html")) {
		res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">` + `<meta name="viewport" content="width=device-width,initial-scale=1">` + `<title>${status} — ${heading}</title></head>` + `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">` + `<h1>${status} — ${heading}</h1><p>${body} <a href="/">Return home</a>.</p></body></html>`);
	} else {
		res.json({ error: status === 404 ? "not_found" : "internal_error" });
	}
}

// ---------------------------------------------------------------------------
// CUSTOM ROUTES — add your customizations here (they take priority over files)
// ---------------------------------------------------------------------------

// Health check for the hosting platform's uptime probes. The body changes
// every call (uptime) and monitoring systems must always see the live
// status, so tell every cache (browser, proxy, CDN) not to store this at all.
// `ok` is kept for back-compat with anything already asserting on it;
// `status`/`version` are F15's enrichment for human/dashboard consumption.
// `version` is null unless BRAND_VERSION is set at deploy time -- this repo
// has no build step to stamp a version into, so it's operator-supplied.
app.get("/healthz", (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	res.json({ ok: true, status: "ok", uptime: process.uptime(), version: config.brandVersion });
});

// Example: expose deploy-time config to the client from environment variables.
// Include it in a page with <script src="/config.js"></script> and read window.CUSTOM_CONFIG.
// Handy for injecting your own TURN server, signaling host, or branding without
// editing the (frequently-updated) VDO.Ninja source files.
app.get("/config.js", (req, res) => {
	const clientConfig = {
		turnServer: config.turnServer,
		signalingHost: config.signalingHost,
		brandName: config.brandName
	};
	res.type("application/javascript");
	// This is regenerated from the environment on every request, so a deploy-time
	// config change (new TURN server, new signaling host, rebranding) must reach
	// browsers immediately, not after a cache expires. "no-cache" (not "no-store")
	// still lets res.send()'s auto-generated ETag do its job: unchanged config
	// comes back as a cheap 304 with no body instead of a full re-send every time.
	res.setHeader("Cache-Control", "no-cache");
	// JSON.stringify leaves <, U+2028, and U+2029 unescaped: an unescaped "<" matters if this
	// is ever inlined into HTML (</script> breakout), and U+2028/U+2029 are literal JS line
	// terminators that would break the script if an operator-controlled value contained one.
	const json = JSON.stringify(clientConfig)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
	res.send(`window.CUSTOM_CONFIG = ${json};`);
});

// F16: serve the active theme's override sheet from themes/ (a folder next to
// server.js that is deliberately kept off the normal static path -- see the
// "/themes/" deny-list prefix below -- so this gated route is the ONLY way to
// reach a theme file). Gated on THEME_NAME: when no valid theme is active this
// route steps aside via next() and the request 404s like any other unknown
// path, so the feature is genuinely absent when off. "no-cache" (not a long
// max-age) keeps the small sheet fresh so an operator iterating on a theme
// sees edits on reload; there's no meaningful caching win to give up on a tiny
// file. Content-Type/Cache-Control are threaded through res.sendFile's
// `headers` option (mirroring the precompressed middleware below) so they're
// only applied once `send` has confirmed the file exists -- a missing or
// mistyped theme file then falls cleanly through to a 404 instead of emitting
// a half-set text/css response.
app.get("/theme.css", (req, res, next) => {
	if (!THEME_NAME) return next();
	res.sendFile(
		path.join(ROOT, "themes", `${THEME_NAME}.css`),
		{
			headers: {
				"Content-Type": "text/css; charset=UTF-8",
				"Cache-Control": "no-cache"
			}
		},
		err => {
			if (!err) return; // response already sent
			// ENOENT / 404-shaped: no such theme file on disk -- fall through to
			// the normal 404. Anything else (permissions, I/O) is a real error.
			if (err.code === "ENOENT" || err.status === 404 || err.statusCode === 404) return next();
			next(err);
		}
	);
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
	res.redirect(301, clean + query);
});

// Deny-list internal files that happen to live inside ROOT (see the comment on
// ROOT above) and would otherwise be served as ordinary static files: the
// server's own source, its dependency tree, and internal audit docs.
// Runs BEFORE express.static and ends the request outright — it never calls
// next() for a match — because the SPA fallback further down serves
// index.html (200) for any unmatched, extensionless GET, and an extensionless
// blocked path like /node_modules/express would otherwise fall through to it.
// scripts/precompress.js's NEVER_COMPRESS set mirrors the file-name entries
// below (not the directory ones, which it already skips via its own
// EXCLUDED_DIR_NAMES) so it never wastes a deploy step compressing a file
// that will never be served anyway. Keep the two lists in sync.
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
// BLOCKED_EXACT above. "/scripts/" (F14's deploy tooling, e.g.
// scripts/precompress.js) is the same class of "server-side ops file, not a
// client asset" as the two above -- and since F14's precompressed-asset
// middleware runs AFTER this one, blocking the prefix here also stops a
// stray scripts/precompress.js.br/.gz from being served, without that
// middleware needing its own awareness of the deny-list. No "scripts.html"
// exists at the repo root, so unlike "/docs" there's no clean-URL page this
// would shadow -- bare "/scripts" is deliberately left unblocked/unlisted
// for the same reason "/docs" is.
//
// "/themes/" (F16) holds the server-side theme override sheets. They are meant
// to be reachable ONLY through the gated "/theme.css" route (which reads the
// active theme by an absolute path via res.sendFile, so it is unaffected by
// this deny-list) -- never as directly-addressable static files. Blocking the
// prefix here means an ungated "/themes/red-black.css" is never served
// alongside the gated route, and unsetting THEME leaves nothing under here
// reachable at all. Like "/scripts", no "themes.html" page exists to shadow,
// so bare "/themes" is deliberately left unlisted.
const BLOCKED_PREFIXES = ["/node_modules/", "/docs/", "/scripts/", "/themes/"]; // this dir and everything under it

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
		// 404, not 403 — don't confirm the file exists. Same generic sendError()
		// every other missing path gets below, so the response body/status gives
		// no signal that this particular path hit the deny-list.
		return sendError(req, res, 404, "Not found", "That page or asset doesn’t exist.");
	}
	next();
});

// ---------------------------------------------------------------------------
// Theme injection (F16, Option A: server-side HTML injection, zero client edits)
// ---------------------------------------------------------------------------
// When a valid THEME is active, inject exactly one
// <link rel="stylesheet" href="/theme.css?ver=1"> immediately before the FIRST
// </head> of every HTML page the server would otherwise serve: index.html,
// room.html, the standalone tool pages (/mixer, /whiteboard, ...), directory
// index pages, and -- the headline case -- the SPA-fallback index.html served
// for clean/room URLs like /someRoom. Because it edits NO client file, a
// forker's `git pull` never conflicts with the theme, and unsetting THEME
// removes it entirely.
//
// The whole block is registered ONLY when a theme is active. For the many
// self-hosters who never set THEME it isn't even in the middleware chain --
// literally zero added work on any request, HTML or asset.
//
// Placement is load-bearing (this sits after the deny-list above and before
// the precompressed-asset middleware / express.static / SPA fallback below):
//   * AFTER the /foo.html -> /foo redirect, so a *.html request still 301s to
//     its clean URL first -- the clean-URL redirect (and its test) is
//     untouched. This middleware only themes the extensionless clean/room URLs
//     that redirect produces; it never serves a *.html path itself.
//   * AFTER the deny-list, so a blocked internal (server.js, node_modules/,
//     docs/, scripts/, themes/) is 404'd before this can read it -- the theme
//     can never resurrect a blocked path.
//   * BEFORE express.static + the SPA fallback, so it intercepts and themes the
//     extensionless navigations they would otherwise serve un-themed. It
//     mirrors the SPA fallback's own guards (GET, extensionless, not a
//     dot-path, req.accepts("html")) and resolves to the very file
//     express.static / the fallback would serve, so a themed response is only
//     ever that exact page plus one <link> -- never injected into a 404, an
//     asset, or the wrong page.
if (THEME_NAME) {
	const THEME_LINK = `<link rel="stylesheet" href="/theme.css?ver=1">`;

	// Inject the <link> before the first </head> and send it no-cache (F3's
	// HTML policy -- res.send bypasses express.static's setHeaders, so it's set
	// here explicitly). String#replace with a string needle replaces ONLY the
	// first match and is case-sensitive; every shipped page has a single
	// lowercase </head> (verified). A page with no </head> is sent unchanged
	// (replace is then a no-op) rather than corrupted.
	const injectAndSend = (res, html) => {
		res.type("html");
		res.setHeader("Cache-Control", "no-cache");
		res.send(html.replace("</head>", THEME_LINK + "</head>"));
	};

	app.use((req, res, next) => {
		// Assets (anything with a file extension) and non-GET requests fall
		// straight through untouched -- only extensionless navigations are
		// themed, so the big cacheable JS/CSS/image path pays nothing here
		// beyond this one extname check.
		//
		// GET-only is deliberate (V002). A HEAD for an HTML page falls
		// through to express.static, which answers from the file's stat and
		// reports its UN-injected Content-Length -- short of the themed GET
		// body by exactly one <link> (~47 bytes). RFC 9110 §9.3.2 says a HEAD
		// response's headers SHOULD match the equivalent GET, so this is a
		// genuine (if inert) divergence, left as-is on purpose rather than
		// synthesizing an injected body just to advertise its length with no
		// payload: themed HTML is served no-cache, the themed GET itself goes
		// out chunked/compressed with NO Content-Length at all (so in practice
		// there's nothing for a client to compare against), and HEAD-probing an
		// HTML page before navigating isn't a real access pattern for this app.
		// F14's precompressed-asset middleware does handle both GET and HEAD,
		// but there the served bytes are a fixed on-disk file with a real
		// Content-Length worth advertising; here the body is synthesized per
		// request, so HEAD is intentionally left to express.static.
		if (req.method !== "GET") return next();
		if (path.extname(req.path) !== "") return next();

		// Decode and mirror the SPA fallback's dot-path + content-negotiation
		// guards, so we never inject into a path it would 404 (a dotfile scan)
		// or hand an HTML document to a non-HTML client.
		let decodedPath;
		try {
			decodedPath = decodeURIComponent(req.path);
		} catch {
			decodedPath = req.path; // malformed % escape; compare the raw path
		}
		const isDotPath = decodedPath.split("/").some(segment => segment.startsWith("."));
		if (isDotPath || !req.accepts("html")) return next();

		// Re-derive the target file from the decoded path and containment-check
		// it against ROOT (never trust req.path raw), exactly like the
		// precompressed-asset middleware does, so a crafted path can't read
		// outside ROOT.
		const candidate = path.normalize(path.join(ROOT, decodedPath));
		if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) return next();

		// Resolve to the same file express.static + the SPA fallback would serve,
		// so the themed body is byte-for-byte that page plus one <link>:
		fs.stat(candidate, (statErr, stats) => {
			if (!statErr) {
				if (stats.isDirectory()) {
					// A directory URL. Without a trailing slash, express.static
					// 301s to add one (so the page's relative URLs resolve against
					// the right base) -- don't pre-empt that redirect; let it
					// through un-themed. With a trailing slash (including "/"
					// itself) the served page is <dir>/index.html; theme it, or
					// fall through if the directory has no index.html so
					// express.static gives its usual response.
					if (!decodedPath.endsWith("/")) return next();
					return fs.readFile(path.join(candidate, "index.html"), "utf8", (err, html) => (err ? next() : injectAndSend(res, html)));
				}
				// An existing extensionless real file (a LICENSE, etc.):
				// express.static serves it as-is -- it isn't an HTML page to
				// theme -- so fall through untouched.
				return next();
			}
			// candidate doesn't exist as-is: a clean tool URL (/mixer ->
			// mixer.html, /room -> room.html) when <name>.html exists, else the
			// SPA fallback's index.html for a room-style URL (/someRoom). The
			// first readFile's ENOENT is what drives that fallback.
			fs.readFile(candidate + ".html", "utf8", (err, html) => {
				if (!err) return injectAndSend(res, html);
				fs.readFile(path.join(ROOT, "index.html"), "utf8", (spaErr, spaHtml) => (spaErr ? next() : injectAndSend(res, spaHtml)));
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Cache-Control policy (F3)
// ---------------------------------------------------------------------------
// The client cache-busts by putting a version marker in the query string of
// the <script>/<link> tag that loads it -- "?ver=NNN" on most files, but
// "?v=7" on auth-client.js (see CLAUDE.md's "Cache-busting version numbers";
// both spellings are genuinely in use, check both). Only a request that
// actually carries one of those params is eligible for the long-cache
// branch below -- an unversioned request is always "no-cache" instead.
//
// That gate is necessary but NOT sufficient to hard-cache for a full year:
// it assumes the URL changes the moment the file's content does, which
// depends on a human remembering to bump "?ver=" on every HTML page that
// references the file. That discipline is real but demonstrably imperfect
// -- e.g. room.html's lib.js?ver= has been bumped in only 3 of the last 30
// commits that changed lib.js's content, and is currently stale against 7
// of them, pinning an older version of the file than index.html requests.
// Since room.html itself is always "no-cache" (below), a missed bump means
// a returning visitor gets fresh HTML that still points at a stale script
// URL -- an inconsistent HTML/script mix, not just an old snapshot. Pairing
// that with "immutable" and a one-year max-age would suppress revalidation
// even on a manual reload, so the visitor has no way to self-rescue short
// of clearing site data. So this deliberately bounds the long-cache window
// instead: VERSIONED_ASSET_MAX_AGE_SECONDS (1 hour) still removes the
// revalidation round trip for repeat loads within that window -- the RTT
// savings F3 actually asked for, and the dominant case for a returning
// visitor's session -- while letting a missed bump self-heal within an
// hour instead of wedging a visitor for a year. Raise this only once the
// "?ver=" bump discipline is enforced somehow (e.g. CI failing a PR that
// changes lib.js/main.js/main.css/webrtc.js without bumping every
// referencing page) -- that is a client/CI change, out of scope here.
const VERSIONED_ASSET_MAX_AGE_SECONDS = 3600;
//
// Most files in this repo carry NO version param anywhere they're
// referenced: most of the ES-module graph under core/ and podcast/
// (bootstrap.js itself is loaded via <script type="module"
// src="./podcast/bootstrap.js"> with no param, and everything under core/
// is imported unversioned) -- though module specifiers CAN carry a query
// param, and two here do: podcast/bootstrap.js imports "./studio.js?v=16"
// and podcast/studio.js imports "./icecast-publisher.js?v=2". A third file,
// podcast/studio.css?v=15, is versioned too, but as a <link> href built at
// runtime by podcast/studio.js rather than a module specifier. All three DO
// get the long-cache treatment above and their "?v=" must be bumped when
// their contents change. Also unversioned: thirdparty/adapter.js,
// thirdparty/aes.js, auth-styles.css, manifest.json, translations/*.json
// (fetched at runtime by lib.js), presets.json (fetched by lib.js), and
// everything under media/. An unversioned request gets "no-cache": the
// browser still keeps the bytes, but must send a conditional GET
// (If-None-Match/If-Modified-Since) before reusing them. express.static
// already emits ETag + Last-Modified for every file, so that conditional
// request is a cheap 304-with-empty-body, not a re-download -- correctness
// (a fix actually reaching users) is worth far more here than shaving the
// one round trip off files that mostly aren't the multi-megabyte ones.
//
// Forker note: if you add a reference to a new asset that changes over
// time, give the URL a "?ver=" or "?v=" query param (and bump it whenever
// the file's contents change) the same way the existing assets do.
// Otherwise it will only ever be revalidated, never long-cached. Module
// specifiers (bare imports and dynamic import()) can carry the param too,
// not just <script src>/<link href> -- see podcast/studio.js above for a
// live example.

// True if this request's query string carries a cache-busting version
// marker in either spelling used across the repo ("?ver=" or "?v=").
// express's built-in query-parser middleware (installed by app.use/app.get
// the first time either is called, see lazyrouter() in express's
// application.js) always runs before any route/middleware registered here,
// so `req.query` is already populated by the time this fires -- verified
// live below.
function hasVersionParam(req) {
	return req.query != null && (req.query.ver !== undefined || req.query.v !== undefined);
}

// The F3 Cache-Control decision itself, factored out so both express.static's
// setHeaders below and the precompressed-asset middleware above it apply the
// *exact* same policy from one place -- otherwise the two paths could drift
// out of sync (e.g. a precompressed response getting a different Cache-Control
// than the identical, non-precompressed response would have gotten).
// `filePath` must always be the ORIGINAL asset's path (e.g. "…/lib.js"), never
// a precompressed variant's ("…/lib.js.br") -- the ".html" check below would
// misfire on "mixer.html.br" otherwise.
function cacheControlFor(filePath, req) {
	if (filePath.endsWith(".html")) {
		// HTML carries the ?ver=/?v= pointers into the assets above it, so
		// caching HTML would pin visitors to old asset versions and quietly
		// defeat the whole cache-busting scheme -- always revalidate it.
		return "no-cache";
	}
	return hasVersionParam(req) ? `public, max-age=${VERSIONED_ASSET_MAX_AGE_SECONDS}` : "no-cache";
}

// ---------------------------------------------------------------------------
// Precompressed asset serving (F14)
// ---------------------------------------------------------------------------
// `scripts/precompress.js` writes maximum-quality brotli (q11) and gzip (-9)
// siblings ("<file>.br" / "<file>.gz") for the repo's large text assets as a
// deploy step (see that file's header comment). This middleware serves those
// precomputed bytes directly instead of paying the on-the-fly compression()
// CPU cost (quality 4) on every cache miss.
//
// Placement matters: this MUST run after the deny-list middleware above (a
// blocked path -- server.js itself, node_modules/, docs/ -- must never be
// served just because scripts/precompress.js happened to produce a .br/.gz
// sibling for it) and BEFORE express.static (a hit here skips the filesystem
// stat + on-the-fly compression express.static/compression() would otherwise
// do).
//
// Scope: this only ever handles a DIRECTLY-requested file with one of these
// extensions (e.g. /lib.js, /main.css) -- resolving a clean/extensionless URL
// (e.g. /mixer -> mixer.html) to its precompressed variant is intentionally
// out of scope. In practice that also makes the ".html" entry below mostly
// theoretical: the clean-URL redirect route earlier in this file 301s every
// same-origin "*.html" request to its extensionless form before it can ever
// reach here, so a real client essentially never hits the ".html" branch
// directly. It's kept anyway for the same-shape edge case that redirect route
// itself carves out (a non-same-origin-looking "*.html" path that steps aside
// via next() instead of redirecting) and so this map stays a uniform,
// unsurprising list of "every text extension this server serves" rather than
// silently special-casing HTML out. Either way, HTML is small and already
// `no-cache`, so the win there is negligible -- see CLAUDE.md task notes.
// Those requests, and any request for a file with no precompressed sibling,
// fall through untouched to express.static + compression() below, exactly as
// before.
//
// Values captured live from this project's installed `mime-types`@2.1.35 (the
// same mime lookup `send`/express.static uses internally -- see
// node_modules/send/index.js's `type()` method, which does
// `mime.lookup(path)` + `mime.charsets.lookup(type)`), so a precompressed
// response gets an identical Content-Type to what the equivalent
// non-precompressed response would have gotten. Hardcoded here instead of
// `require("mime-types")` so this file has no *implicit* dependency on
// express's transitive dependency tree keeping that exact shape -- this
// project otherwise takes no new npm dependencies (see CLAUDE.md). Keep this
// object's keys in sync with scripts/precompress.js's COMPRESSIBLE_EXTENSIONS.
const PRECOMPRESSED_CONTENT_TYPES = {
	".js": "application/javascript; charset=UTF-8",
	".css": "text/css; charset=UTF-8",
	".html": "text/html; charset=UTF-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=UTF-8"
};

// Preferred-first: brotli compresses smaller than gzip from the same source,
// so prefer it whenever a client's Accept-Encoding allows both.
const PRECOMPRESSED_VARIANTS = [
	{ suffix: ".br", encoding: "br" },
	{ suffix: ".gz", encoding: "gzip" }
];

app.use((req, res, next) => {
	if (req.method !== "GET" && req.method !== "HEAD") {
		return next();
	}

	const contentType = PRECOMPRESSED_CONTENT_TYPES[path.extname(req.path).toLowerCase()];
	if (!contentType) {
		return next();
	}

	// Resolve the same way express.static would: ROOT + the decoded,
	// path-normalized request path. Re-derived independently here (rather
	// than trusting req.path) as defense-in-depth against traversal, matching
	// the posture of normalizeForDenylist() above -- res.sendFile() below
	// enforces no containment of its own for an already-absolute path (that
	// guarantee only applies when callers use its `root` option instead), so
	// this middleware is the thing keeping `filePath` inside ROOT.
	let decodedPath;
	try {
		decodedPath = decodeURIComponent(req.path);
	} catch {
		return next(); // malformed % escape -- let express.static produce the right response
	}
	const filePath = path.normalize(path.join(ROOT, decodedPath));
	if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
		return next();
	}

	const variant = PRECOMPRESSED_VARIANTS.find(candidate => req.acceptsEncodings(candidate.encoding) === candidate.encoding);
	if (!variant) {
		return next(); // client doesn't accept br or gzip -- let normal serving handle it
	}

	// All headers are threaded through res.sendFile's `headers` option rather
	// than set eagerly via res.setHeader beforehand, so they're only ever
	// applied once `send` (used internally by res.sendFile) has confirmed the
	// variant file actually exists -- see node_modules/send/index.js:
	// SendStream#setHeader emits the 'headers' event (which this populates)
	// before SendStream#type() sets Content-Type, and SendStream#type() skips
	// its own mime lookup once Content-Type is already set -- so this Content-
	// Type is never clobbered. The same ordering means `send`'s own default
	// Cache-Control (gated on `!res.getHeader('Cache-Control')`) never fires
	// either, since ours is already set by the time it checks. ETag and
	// Last-Modified are deliberately left for `send` to compute itself, from
	// the variant file's own fs.Stats -- keeping conditional-GET/304 support
	// correct and tied to the bytes actually being served, not the original
	// file.
	res.sendFile(
		filePath + variant.suffix,
		{
			headers: {
				"Content-Type": contentType,
				"Content-Encoding": variant.encoding,
				// Tells any shared cache (browser, CDN, proxy) that the response
				// body depends on Accept-Encoding, so it never hands this br/gzip
				// body to a client that can't decode it.
				Vary: "Accept-Encoding",
				"Cache-Control": cacheControlFor(filePath, req)
			}
		},
		err => {
			if (!err) {
				return; // response already sent
			}
			// ENOENT: no precompressed sibling on disk. err.status/err.statusCode
			// === 404: `send` (which res.sendFile() uses internally) raises its OWN
			// 404 for reasons besides ENOENT -- e.g. its built-in dotfile guard,
			// which fires on the *last path segment* of the file being sent and has
			// no `.code` property, only `.status`/`.statusCode` (confirmed against
			// this project's installed `send`/`http-errors`: a bare res.sendFile()
			// call with no `dotfiles` option treats a dotfile the same as
			// `dotfiles: "ignore"` by default). Either way, `send` has already
			// decided this specific variant path should look like "not found" --
			// fall through to normal serving the same way, so the ORIGINAL path
			// gets a consistent response (its own 404, or a real file) instead of
			// this middleware turning a 404-shaped outcome into a 500.
			if (err.code === "ENOENT" || err.status === 404 || err.statusCode === 404) {
				return next();
			}
			next(err); // unexpected (permissions, I/O, ...) -- let the final error handler respond
		}
	);
});

// Serve real files. `extensions: ["html"]` makes /mixer resolve to mixer.html;
// `index` serves index.html for directory roots.
app.use(
	express.static(ROOT, {
		extensions: ["html"],
		index: "index.html",
		dotfiles: "ignore",
		setHeaders(res, filePath) {
			// send/serve-static invoke setHeaders with the real http.ServerResponse,
			// which Node populates with a `.req` back-reference to the original
			// request (see the Node docs for response.req) -- and because Express
			// mutates that same request object's prototype/properties in place
			// rather than copying it, res.req here is the fully-Express-augmented
			// request, `.query` included.
			res.setHeader("Cache-Control", cacheControlFor(filePath, res.req));
		}
	})
);

// Fallback: send index.html for unmatched, extensionless navigations
// (clean/room-style URLs like /myRoomName), but return 404 for a missing
// asset (anything with an extension: .js/.css/.png/...) so failures are obvious
// instead of being masked by a 200 HTML page.
app.use((req, res) => {
	const hasFileExtension = path.extname(req.path) !== "";
	// A dot-prefixed path segment (/.gitignore, /.env, or a nested one like
	// /.git/config) is never a legit SPA route -- exclude it here so it 404s
	// instead of reading as a misleading 200 to scanners. Checked against every
	// segment, not just the basename, since /.git/config's final segment
	// ("config") isn't itself dot-prefixed. Decoded first -- like
	// normalizeForDenylist() above -- so a percent-encoded variant (e.g.
	// /%2egitignore) can't hide its leading dot from req.path's raw, undecoded
	// segments. dotfiles:"ignore" above already stops the real file content
	// from being served; this just keeps the status code honest too.
	let decodedPath;
	try {
		decodedPath = decodeURIComponent(req.path);
	} catch {
		decodedPath = req.path; // malformed % escape; compare the raw path instead of throwing
	}
	const isDotPath = decodedPath.split("/").some(segment => segment.startsWith("."));
	if (req.method === "GET" && !hasFileExtension && !isDotPath && req.accepts("html")) {
		// res.sendFile() does NOT go through express.static's setHeaders above,
		// so it needs the same "HTML holds the ?ver= pointers" no-cache policy
		// set explicitly here or this fallback would silently miss it.
		res.setHeader("Cache-Control", "no-cache");
		res.sendFile(path.join(ROOT, "index.html"));
	} else {
		sendError(req, res, 404, "Not found", "That page or asset doesn’t exist.");
	}
});

// ---------------------------------------------------------------------------
// Final error handler (F6) — must be the LAST app.use(), after every route
// and the SPA fallback above, so Express routes any thrown error or
// next(err) call here instead of its own default handler, which (with
// NODE_ENV !== "production") renders an HTML page containing a stack trace —
// leaking internal file paths and versions on top of the F5 fingerprint leak
// this file already closes elsewhere.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
	// Per the Express docs: once headers are sent, a custom error handler must
	// NOT attempt to send another response -- delegate to Express's built-in
	// handler, which knows how to finish/abort the in-flight response without
	// corrupting it. Only render the friendly 500 below when nothing has gone
	// out yet.
	if (res.headersSent) {
		return next(err);
	}
	// The real error (message, stack, internal paths) is logged server-side
	// only -- the client only ever sees the generic, hardcoded 500 page/JSON.
	console.error("Unhandled error:", err);
	sendError(req, res, 500, "Server error", "Something went wrong — please try again.");
});

module.exports = app;

if (require.main === module) {
	const server = app.listen(config.port, config.host, () => {
		console.log(`VDO.Ninja client serving on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
	});

	// Without this, a bind failure (port already in use, or insufficient
	// privileges to bind a low port) surfaces as an unhandled "error" event --
	// a raw stack trace instead of a clear, actionable message -- and Node
	// exits with a non-obvious code. Name the failure mode and exit cleanly.
	server.on("error", err => {
		if (err.code === "EADDRINUSE") console.error(`Port ${config.port} is already in use.`);
		else if (err.code === "EACCES") console.error(`Insufficient privileges to bind port ${config.port}.`);
		else console.error("Server failed to start:", err);
		process.exit(1);
	});

	// Drain in-flight requests instead of dropping them when an orchestrator
	// stops this process -- Docker, Kubernetes, systemd, and most PaaS
	// platforms send SIGTERM on deploy/scale-down; a developer's Ctrl-C sends
	// SIGINT. server.close() stops accepting new connections and only calls
	// back once every in-flight request has finished, so the exit below is a
	// clean one. The timer is a force-exit backstop for a request that never
	// finishes; .unref() is required so the timer itself doesn't keep the
	// event loop alive and block the clean exit it's there to back up.
	for (const sig of ["SIGTERM", "SIGINT"]) {
		process.on(sig, () => {
			console.log(`${sig} received — shutting down.`);
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(1), 10000).unref();
		});
	}
}
