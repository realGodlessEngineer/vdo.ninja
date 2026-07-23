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
const crypto = require("crypto");
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
	logRequests: process.env.LOG_REQUESTS === "true",
	// F18 (server-gated director link). DIRECTOR_SECRET/DIRECTOR_ROOM gate the
	// feature and are trimmed because trailing whitespace in an env var is
	// almost always an accident and would silently change the auth password /
	// break the room name. ROOM_PASSWORD/ROOM_KEY are the credentials baked into
	// the dispensed link; they are NOT trimmed -- the room password is folded
	// byte-for-byte into the room's hashed identity (see lib.js), so the
	// director and every guest must use the exact same value, whitespace
	// included. Empty (or unset) means "not set" for all four.
	directorSecret: (process.env.DIRECTOR_SECRET || "").trim(),
	directorRoom: (process.env.DIRECTOR_ROOM || "").trim(),
	roomPassword: process.env.ROOM_PASSWORD || null,
	roomKey: process.env.ROOM_KEY || null,
	// F22 (opt-in per-IP rate limiter). A positive integer is the sliding-
	// window requests-per-minute allowance per client IP. Note `|| 0` alone
	// does NOT fully normalize this to "0 means off": Number.parseInt("-5", 10)
	// is -5, and -5 is truthy, so a negative env value survives as a negative
	// number here rather than becoming 0. That's fine -- RATE_LIMIT_ENABLED
	// below (the thing the middleware registration actually gates on) treats
	// zero, negative, unset, and non-numeric identically via `> 0`, so this
	// field is only ever consulted once already known to be a positive count.
	rateLimitRpm: Number.parseInt(process.env.RATE_LIMIT_RPM, 10) || 0
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

// F18: the server-gated /director route is only active when BOTH DIRECTOR_SECRET
// (the auth password that guards the link) AND DIRECTOR_ROOM (the room to
// direct) are set. Mirrors THEME_NAME's gate: when this is false the route below
// is never registered, so /director simply falls through to the SPA fallback
// like any other clean URL -- the feature is genuinely absent, not just inert. A
// secret with no room can't produce a usable link, so that combination disables
// the feature and is announced once, the same posture as the invalid-THEME
// warning above.
const DIRECTOR_ENABLED = config.directorSecret !== "" && config.directorRoom !== "";
if (config.directorSecret !== "" && config.directorRoom === "") {
	console.warn(`Ignoring DIRECTOR_SECRET: the server-gated director link also requires DIRECTOR_ROOM (the room name to direct) to be set.`);
}

// F22: the opt-in per-IP rate limiter (registered further below, after the F11
// access-log middleware, so a throttled request is still access-logged) is
// active only when RATE_LIMIT_RPM parsed to a positive requests-per-minute
// count above. Computed here, alongside THEME_NAME/DIRECTOR_ENABLED, so every
// "is this optional feature on" flag lives in one place. Mirrors those two:
// when this is false the middleware is never registered at all, so the
// feature is genuinely absent -- not merely inert -- the same posture as
// /director being absent (not just always-401) when DIRECTOR_ENABLED is
// false.
const RATE_LIMIT_ENABLED = config.rateLimitRpm > 0;
if (process.env.RATE_LIMIT_RPM !== undefined && process.env.RATE_LIMIT_RPM.trim() !== "" && !RATE_LIMIT_ENABLED) {
	console.warn(`Ignoring RATE_LIMIT_RPM=${JSON.stringify(process.env.RATE_LIMIT_RPM)}: must be a positive integer (requests per minute, per IP) to enable the rate limiter.`);
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
// F22: opt-in, in-memory, per-IP request-rate limiter.
// ---------------------------------------------------------------------------
// Off unless RATE_LIMIT_ENABLED (RATE_LIMIT_RPM set to a positive integer,
// see the config block above) -- when it's false NOTHING below is registered,
// so the feature costs nothing on every self-hosted deploy that never opts
// in. This is a lightweight, dependency-free abuse/DoS backstop for a plain
// VPS deploy with nothing else in front of it, not a replacement for a real
// edge layer -- this is equally self-hostable behind Cloudflare or another
// CDN/WAF, and an operator who already has one there should generally rate-
// limit *there* instead, where it's cheaper (blocked before it ever reaches
// this process) and not reset by a restart or split across multiple
// instances the way this in-process Map is.
//
// IMPORTANT for operators: a single browser page load fans out into MANY
// requests -- index.html, lib.js, webrtc.js, adapter.js, aes.js, CSS, icons,
// manifest.json, translations/*.json, and so on -- and this limiter counts
// EVERY request, not just "actions". Set RATE_LIMIT_RPM generously (a few
// hundred, not a handful) or normal page loads will start 429ing.
//
// Sliding-window-log algorithm, keyed on req.ip: a Map<ip, timestamps[]>
// holds each IP's request times within the trailing RATE_LIMIT_WINDOW_MS. On
// every request, timestamps older than the window are dropped first; if the
// count remaining is already at the limit, the request is rejected (429) and
// its timestamp is NOT recorded, so a well-behaved client's own window keeps
// draining while it backs off and it recovers within RATE_LIMIT_WINDOW_MS --
// only requests that were actually ALLOWED get logged.
//
// req.ip's correctness depends entirely on the already-configured
// `trust proxy` setting (config.trustProxy, applied near the top of this
// file from TRUST_PROXY): too permissive for the real topology and a client
// can spoof X-Forwarded-For to get a fresh bucket per request (defeating the
// limiter); too strict (or a real proxy in front with trust proxy left at
// the "loopback" default) and every distinct client behind that proxy
// collapses into a single shared bucket (one abusive client throttles
// everyone else behind the same proxy). That's the operator's TRUST_PROXY to
// get right for their deploy, not something this middleware can detect or
// correct.
const RATE_LIMIT_WINDOW_MS = 60_000;

if (RATE_LIMIT_ENABLED) {
	// ip -> ascending-order timestamps (ms since epoch) of requests ALLOWED
	// within the trailing window. A plain Map, not an LRU/TTL cache, because
	// the periodic sweep below is what keeps it bounded instead.
	const rateLimitBuckets = new Map();

	// Without this sweep, an IP's entry would sit in the Map forever once
	// created -- one entry per distinct IP ever seen, unbounded over a long-
	// running process's lifetime, even though the per-request pruning below
	// already empties out an IDLE ip's array on its next visit. This instead
	// proactively drops entries for IPs that never come back: on the same
	// cadence as the window itself, delete any bucket whose newest recorded
	// timestamp has already aged out. `.unref()` is required so this timer
	// can never keep the event loop (and so the process) alive on its own --
	// it must not interfere with the SIGTERM/SIGINT graceful-drain path near
	// the bottom of this file.
	const sweepInterval = setInterval(() => {
		const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
		for (const [ip, timestamps] of rateLimitBuckets) {
			const newest = timestamps[timestamps.length - 1];
			if (newest === undefined || newest < cutoff) {
				rateLimitBuckets.delete(ip);
			}
		}
	}, RATE_LIMIT_WINDOW_MS);
	sweepInterval.unref();

	app.use((req, res, next) => {
		// Platform uptime probes must never be throttled. Match the same set the
		// health route serves (Express non-strict routing answers /healthz and
		// /healthz/), so the trailing-slash form is exempt too.
		if (req.path === "/healthz" || req.path === "/healthz/") return next();

		const ip = req.ip || "unknown";
		const now = Date.now();
		const cutoff = now - RATE_LIMIT_WINDOW_MS;

		const timestamps = (rateLimitBuckets.get(ip) || []).filter(t => t > cutoff);

		if (timestamps.length >= config.rateLimitRpm) {
			rateLimitBuckets.set(ip, timestamps); // keep the pruned array even when rejecting
			const retryAfterSeconds = Math.max(1, Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
			res.setHeader("Retry-After", String(retryAfterSeconds));
			return sendError(req, res, 429, "Too many requests", "You’ve made too many requests recently — please slow down and try again shortly.");
		}

		timestamps.push(now);
		rateLimitBuckets.set(ip, timestamps);
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
// becomes a reflected-XSS sink. The JSON `error` label is looked up from
// `status` via the map below (not derived from `heading`/`body`, which are
// free-form prose) -- F22 added the 429 entry; anything without its own
// entry still falls back to the generic "internal_error" label it always had.
// ---------------------------------------------------------------------------
const ERROR_LABELS_BY_STATUS = { 404: "not_found", 429: "rate_limited" };

function sendError(req, res, status, heading, body) {
	res.status(status);
	if (req.accepts("html")) {
		res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">` + `<meta name="viewport" content="width=device-width,initial-scale=1">` + `<title>${status} — ${heading}</title></head>` + `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">` + `<h1>${status} — ${heading}</h1><p>${body} <a href="/">Return home</a>.</p></body></html>`);
	} else {
		res.json({ error: ERROR_LABELS_BY_STATUS[status] || "internal_error" });
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
// F18: server-gated director link.
// ---------------------------------------------------------------------------
// Honest model: this server only serves static files, so it CANNOT enforce the
// VDO.Ninja "director" role itself. All it does here is DISPENSE the privileged
// director link after an HTTP Basic auth check; the real director enforcement
// (room claim, guest approval, roomkey) is done by the signaling server
// (wss.vdo.ninja by default), not by this process. No client change is needed
// -- the route only assembles existing URL params onto a redirect that the
// stock client already understands.
//
// The redirect target is built ENTIRELY from server env vars (never from any
// request input -- no query, path, or header is incorporated), so there is no
// open-redirect risk. Secret params (the room password and roomkey) go in the
// URL "#" fragment rather than the query string: the fragment is never sent to
// the server on the follow-up GET and is not captured by F11's optional access
// log, whereas the query string would be. Gated on DIRECTOR_ENABLED so the
// route is absent unless the operator opted in with DIRECTOR_SECRET +
// DIRECTOR_ROOM.
if (DIRECTOR_ENABLED) {
	// Hash the secret once at boot. The per-request compare hashes the supplied
	// password to the same fixed 32-byte width, so crypto.timingSafeEqual never
	// sees mismatched-length buffers (which would make it throw) regardless of
	// what length the client sends.
	const directorSecretHash = crypto.createHash("sha256").update(config.directorSecret).digest();

	// F-A (CWE-307): per-IP failed-attempt throttle -- an in-process brute-force
	// backstop for this HTTP Basic auth endpoint. This is NOT a substitute for a
	// high-entropy DIRECTOR_SECRET (an operator who sets a guessable password is
	// still exposed; see deploy-railway.md's "Director link" section, which
	// requires a generated secret) -- it just caps how many guesses per IP an
	// online attacker gets before being locked out. It reuses F22's sliding-
	// window-log idiom exactly, but is deliberately NOT a global middleware:
	// it's scoped to the /director handler only and keyed on FAILED attempts,
	// not on all requests. It lives entirely inside `if (DIRECTOR_ENABLED)`, so
	// -- like F22's map + sweep living inside `if (RATE_LIMIT_ENABLED)` -- it
	// costs nothing and doesn't exist at all when the director feature is off.
	//
	// Hardcoded window/threshold (no new env var -- the config surface stays
	// unchanged): allow up to DIRECTOR_AUTH_MAX_FAILURES failed passwords per IP
	// within a trailing DIRECTOR_AUTH_WINDOW_MS, then lock that IP out for the
	// rest of the window. 10 failures / 15 minutes is lax enough that a director
	// who fat-fingers the password a few times is never affected, while cutting
	// an online guessing attacker from effectively unlimited attempts down to a
	// handful per window (~40/hour/IP). req.ip's correctness depends on the
	// already-configured `trust proxy` setting exactly as F22 documents above --
	// the same TRUST_PROXY caveat applies here and is the operator's to get
	// right, not re-solved in this handler.
	const DIRECTOR_AUTH_WINDOW_MS = 15 * 60_000; // 15 minutes
	const DIRECTOR_AUTH_MAX_FAILURES = 10;

	// ip -> ascending-order timestamps (ms since epoch) of FAILED auth attempts
	// within the trailing window. A plain Map, kept bounded by the sweep below,
	// exactly like F22's rateLimitBuckets. (A hard ceiling on this Map's size is
	// deliberately out of scope here -- it's tracked as T4 and will be applied
	// consistently across this map and F22's limiter.)
	const directorAuthFailures = new Map();

	// Same proactive sweep as F22's rate limiter: on the window cadence, delete
	// any bucket whose newest recorded failure has already aged out, so an IP
	// that stops guessing doesn't sit in the Map forever. `.unref()` is required
	// so this timer can never keep the event loop (and so the process) alive on
	// its own -- it must not interfere with the SIGTERM/SIGINT graceful-drain
	// path near the bottom of this file.
	const directorAuthSweep = setInterval(() => {
		const cutoff = Date.now() - DIRECTOR_AUTH_WINDOW_MS;
		for (const [ip, timestamps] of directorAuthFailures) {
			const newest = timestamps[timestamps.length - 1];
			if (newest === undefined || newest < cutoff) {
				directorAuthFailures.delete(ip);
			}
		}
	}, DIRECTOR_AUTH_WINDOW_MS);
	directorAuthSweep.unref();

	app.get("/director", (req, res) => {
		const ip = req.ip || "unknown";
		const now = Date.now();
		const cutoff = now - DIRECTOR_AUTH_WINDOW_MS;

		// Prune this IP's aged-out failures first, so the window slides.
		const failures = (directorAuthFailures.get(ip) || []).filter(t => t > cutoff);

		// Already at the cap -> locked out: refuse WITHOUT checking the password
		// (this is what stops continued online brute-forcing) and WITHOUT
		// recording a new timestamp (so the window keeps draining and a legit
		// user recovers within DIRECTOR_AUTH_WINDOW_MS -- the same recovery
		// property F22 documents). Retry-After via F22's exact formula.
		if (failures.length >= DIRECTOR_AUTH_MAX_FAILURES) {
			directorAuthFailures.set(ip, failures); // keep the pruned array even when rejecting
			const retryAfterSeconds = Math.max(1, Math.ceil((failures[0] + DIRECTOR_AUTH_WINDOW_MS - now) / 1000));
			res.setHeader("Retry-After", String(retryAfterSeconds));
			return sendError(req, res, 429, "Too many attempts", "Too many failed authentication attempts — please wait and try again shortly.");
		}

		const authorizationHeader = req.headers.authorization || "";
		const basicMatch = /^Basic (.+)$/i.exec(authorizationHeader);
		let authorized = false;
		if (basicMatch) {
			// Buffer.from(..., "base64") never throws (it silently drops invalid
			// characters), so a malformed credential just yields a string that
			// won't contain the right password -> 401.
			const decoded = Buffer.from(basicMatch[1], "base64").toString("utf8");
			const separatorIndex = decoded.indexOf(":");
			// Accept ANY username; compare ONLY the password (everything after the
			// first ":"). A credential with no ":" carries no password -> 401.
			if (separatorIndex !== -1) {
				const suppliedPassword = decoded.slice(separatorIndex + 1);
				const suppliedHash = crypto.createHash("sha256").update(suppliedPassword).digest();
				authorized = crypto.timingSafeEqual(suppliedHash, directorSecretHash);
			}
		}

		if (!authorized) {
			// Record this failed attempt in the sliding window, then decide the
			// response. If pushing it just reached the cap, the attempt that hits
			// the threshold is itself throttled (429 + Retry-After) rather than
			// getting one more 401 -- otherwise the usual 401 challenge, unchanged.
			failures.push(now);
			directorAuthFailures.set(ip, failures);
			if (failures.length >= DIRECTOR_AUTH_MAX_FAILURES) {
				const retryAfterSeconds = Math.max(1, Math.ceil((failures[0] + DIRECTOR_AUTH_WINDOW_MS - now) / 1000));
				res.setHeader("Retry-After", String(retryAfterSeconds));
				return sendError(req, res, 429, "Too many attempts", "Too many failed authentication attempts — please wait and try again shortly.");
			}
			res.setHeader("WWW-Authenticate", 'Basic realm="Director"');
			return sendError(req, res, 401, "Authentication required", "Provide the director credentials to obtain the director link.");
		}

		// Authenticated: reset this IP's failure counter BEFORE dispensing the
		// link, so a legitimate director who mistyped a couple of times before
		// getting it right isn't progressively penalized on their next visits.
		directorAuthFailures.delete(ip);

		// Non-secret params (the room name, and the non-sensitive &requireapproval
		// flag) in the query string; secret params (password, roomkey) in the "#"
		// fragment. Every interpolated value is env-derived and encodeURIComponent'd.
		let location = `/?director=${encodeURIComponent(config.directorRoom)}`;
		if (config.roomKey) {
			location += "&requireapproval";
		}
		const fragmentParams = [];
		if (config.roomPassword) {
			fragmentParams.push(`password=${encodeURIComponent(config.roomPassword)}`);
		}
		if (config.roomKey) {
			fragmentParams.push(`roomkey=${encodeURIComponent(config.roomKey)}`);
		}
		if (fragmentParams.length) {
			location += `#${fragmentParams.join("&")}`;
		}
		res.redirect(302, location);
	});
}

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
