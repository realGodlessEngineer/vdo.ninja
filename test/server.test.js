"use strict";

// Smoke tests for server.js's URL-handling behavior (F8). server.js exports
// the Express app without listening when required (see the
// `require.main === module` guard at the bottom of the file), so these run
// entirely in-process via supertest -- no port is ever bound.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const request = require("supertest");
const app = require("../server");

test("clean-url redirect preserves the query string", async () => {
	const res = await request(app).get("/mixer.html?foo=1");
	assert.equal(res.status, 301);
	assert.equal(res.headers.location, "/mixer?foo=1");
});

// F1 regression guard. The attack path is a request-target starting with two
// slashes (e.g. "//evil.com.html"): stripping ".html" naively would leave
// "//evil.com", and a Location header starting with "//" is a
// protocol-relative absolute URL that browsers resolve to the attacker's
// origin, not this site.
//
// This must exercise the literal request-target "//evil.com.html", not a
// supertest/superagent misparse of it as an absolute URL to a host named
// "evil.com.html". Traced through the installed versions (supertest 7.2.2 /
// superagent 10.3.0): `request(app).get(path)` builds the request URL as
// `http://127.0.0.1:<ephemeralPort>` + `path` (supertest's
// Test#serverAddress, lib/test.js) *before* superagent's node client parses
// that combined string with `new URL(...)` (lib/node/index.js). Because the
// authority ("127.0.0.1:<port>") is already explicit at that point, the
// WHATWG URL parser keeps the following "//evil.com.html" as a literal
// pathname rather than a second, protocol-relative authority -- confirmed
// directly: `new URL("http://127.0.0.1:12345//evil.com.html").pathname ===
// "//evil.com.html"`. So the server genuinely receives request-target
// "//evil.com.html", the same as a real client that sent that path.
test("F1 regression: a protocol-relative //host.html path is never redirected off-site", async () => {
	const res = await request(app).get("//evil.com.html");
	// Under the current guard this path isn't a same-origin clean URL, so the
	// redirect route steps aside (next()) and the request falls through to the
	// deny-list / static handler / SPA fallback, none of which know this path
	// -> 404. Assert that concretely, not just "no bad Location", so removing
	// the guard (which would 301 instead) fails this test outright.
	assert.equal(res.status, 404);
	if (res.headers.location) {
		assert.doesNotMatch(res.headers.location, /^\/\//);
	}
});

test("missing asset 404s; extensionless clean URL falls back to index.html", async () => {
	const missingAsset = await request(app).get("/nope.js");
	assert.equal(missingAsset.status, 404);

	const cleanRoom = await request(app).get("/someRoom");
	assert.equal(cleanRoom.status, 200);
	assert.match(cleanRoom.headers["content-type"], /html/);
});

test("F2 regression: server internals are not served over HTTP", async () => {
	assert.equal((await request(app).get("/server.js")).status, 404);
	assert.equal((await request(app).get("/node_modules/express/package.json")).status, 404);
	// B1 regression: F14's own deploy tooling (scripts/precompress.js) is the
	// same class of server internal as the two above.
	assert.equal((await request(app).get("/scripts/precompress.js")).status, 404);
});

test("F3: a version-stamped asset is long-cached, HTML is always revalidated", async () => {
	const versioned = await request(app).get("/lib.js?ver=1415");
	assert.equal(versioned.status, 200);
	assert.equal(versioned.headers["cache-control"], "public, max-age=3600");

	const html = await request(app).get("/");
	assert.equal(html.status, 200);
	assert.equal(html.headers["cache-control"], "no-cache");
});

// F13 regression: dot-prefixed paths never fall back to the misleading 200
// index.html a scanner would otherwise see, including a percent-encoded dot
// (%2e) -- a standard scanner/WAF evasion that bypassed a naive raw-req.path
// string check.
test("F13 regression: dot-prefixed paths 404, including percent-encoded ones", async () => {
	assert.equal((await request(app).get("/.git/config")).status, 404);
	assert.equal((await request(app).get("/.gitignore")).status, 404);
	assert.equal((await request(app).get("/%2egitignore")).status, 404);

	const cleanRoom = await request(app).get("/someRoomName");
	assert.equal(cleanRoom.status, 200);
	assert.match(cleanRoom.headers["content-type"], /html/);
});

// F15 regression: /healthz is enriched with `status` and `version` alongside
// the pre-existing `ok`/`uptime`, for human/dashboard consumption. `version`
// is null here because the test process doesn't set BRAND_VERSION.
test("F15: /healthz reports ok, status, uptime, and version", async () => {
	const res = await request(app).get("/healthz");
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"], /json/);
	assert.equal(res.headers["cache-control"], "no-store");
	assert.equal(res.body.ok, true);
	assert.equal(res.body.status, "ok");
	assert.equal(typeof res.body.uptime, "number");
	assert.equal(res.body.version, null);
});

// F14 regression: deploy-time precompression (scripts/precompress.js) is
// served instead of paying the on-the-fly compression() cost, with F3's
// Cache-Control policy still intact on that path.
//
// Self-contained on purpose: rather than depending on `npm run precompress`
// having already been run (which would make this test pass in the full suite
// but fail on a bare `node --test` after a fresh checkout), it generates
// lib.js's ".br" sibling itself if one isn't already on disk, and removes
// only the copy it created. quality 5 (not scripts/precompress.js's quality
// 11) is deliberate -- this test only needs a structurally valid brotli
// stream to prove the serving mechanics (headers, Cache-Control, fallback),
// not maximum compression, and quality 11 on lib.js's ~2.1MB takes multiple
// seconds that would otherwise slow down every `node --test` run.
//
// supertest/superagent auto-decompress response bodies, but the raw response
// HEADERS are captured before that decoding happens -- verified live against
// this project's installed supertest 7.2.2 / superagent 10.3.0:
// res.headers["content-encoding"] is NOT stripped, so it's safe to assert on
// directly here instead of needing a raw http/TCP request.
test("F14: a versioned asset with a precompressed sibling is served brotli-encoded; F3's Cache-Control is preserved", async () => {
	const libJsPath = path.join(__dirname, "..", "lib.js");
	const brPath = `${libJsPath}.br`;
	const brAlreadyExisted = fs.existsSync(brPath);
	if (!brAlreadyExisted) {
		const source = fs.readFileSync(libJsPath);
		const brotli = zlib.brotliCompressSync(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
		fs.writeFileSync(brPath, brotli);
	}

	try {
		const compressed = await request(app).get("/lib.js?ver=1415").set("Accept-Encoding", "br");
		assert.equal(compressed.status, 200);
		assert.equal(compressed.headers["content-encoding"], "br");
		assert.match(compressed.headers["vary"], /Accept-Encoding/);
		assert.match(compressed.headers["content-type"], /javascript/);
		// Proves F3's long-cache branch (this asset's URL carries "?ver=") is
		// unaffected by going through the precompressed-serving path instead of
		// express.static directly.
		assert.equal(compressed.headers["cache-control"], "public, max-age=3600");
		// The assertions above alone still pass even with the F14 middleware
		// entirely removed: server.js's pre-existing app.use(compression())
		// independently brotli-encodes this same request on the fly whenever
		// Accept-Encoding: br is sent and the body is large enough, producing an
		// identical status/content-encoding/vary/content-type/cache-control.
		// Content-Length vs. Transfer-Encoding is the one signal that actually
		// distinguishes the two code paths: res.sendFile() (F14) sends a fixed
		// Content-Length for the precompressed file with no Transfer-Encoding,
		// while compression()'s on-the-fly stream sends Transfer-Encoding:
		// chunked with no Content-Length. Confirmed by mutation testing --
		// temporarily removing the F14 middleware and re-running the assertions
		// above (minus this one) still passed; only these two fail.
		const brStat = fs.statSync(brPath);
		assert.equal(compressed.headers["content-length"], String(brStat.size));
		assert.equal(compressed.headers["transfer-encoding"], undefined);

		// A client that doesn't accept br/gzip must fall through to normal
		// serving untouched -- no Content-Encoding at all, not even a mismatched
		// one.
		const uncompressed = await request(app).get("/lib.js?ver=1415").set("Accept-Encoding", "identity");
		assert.equal(uncompressed.status, 200);
		assert.equal(uncompressed.headers["content-encoding"], undefined);
	} finally {
		if (!brAlreadyExisted) {
			fs.unlinkSync(brPath);
		}
	}
});

// ---------------------------------------------------------------------------
// F16 — /theme.css route + server-side theme <link> injection.
// ---------------------------------------------------------------------------
// server.js reads the THEME env var exactly once, at require time, into its
// frozen `config` (and derived `THEME_NAME`). The suite above requires
// ../server once at the top with THEME UNSET in this process, giving us the
// default THEME-OFF `app`. To exercise the THEME-ON path we need a SECOND app
// instance built with THEME set. loadThemedApp() does that hermetically: it
// snapshots the cached server module, briefly sets process.env.THEME, drops the
// module from require's cache so a fresh require re-runs server.js with THEME
// visible, then restores BOTH process.env.THEME and the ORIGINAL cached module
// object. That last step is what keeps every other test untouched -- the
// top-level `app` and require.cache are left exactly as they were, still
// THEME-off. (Mirrors the care the F14 test takes with its environment.)
const THEME_LINK = `<link rel="stylesheet" href="/theme.css?ver=1">`;
const THEME_NAME = "red-black";

function loadThemedApp() {
	const serverPath = require.resolve("../server");
	const originalModule = require.cache[serverPath];
	const hadTheme = "THEME" in process.env;
	const savedTheme = process.env.THEME;

	process.env.THEME = THEME_NAME;
	delete require.cache[serverPath];
	const themedApp = require("../server");

	// Restore env + the pristine cached module so the rest of the suite still
	// sees the original THEME-off `app` and an unmodified require cache.
	if (hadTheme) process.env.THEME = savedTheme;
	else delete process.env.THEME;
	require.cache[serverPath] = originalModule;

	return themedApp;
}

const themedApp = loadThemedApp();

test("F16: /theme.css serves the active theme sheet as text/css, no-cache, when THEME is set", async () => {
	const res = await request(themedApp).get("/theme.css").buffer(true);
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"], /text\/css/);
	assert.equal(res.headers["cache-control"], "no-cache");
	const expected = fs.readFileSync(path.join(__dirname, "..", "themes", `${THEME_NAME}.css`), "utf8");
	assert.equal(res.text, expected);
});

// F17 — the real red/black palette shipped, not the F16 mechanism placeholder.
// Deliberately loose: it asserts the durable core signal (the red accent hex and
// a remap of the highest-frequency neutral-ramp token) and the absence of the
// placeholder marker, rather than exact bytes, so palette tuning does not make it
// brittle while a regression to the placeholder fails loudly.
test("F17: /theme.css ships the red/black palette, not the placeholder", async () => {
	const res = await request(themedApp).get("/theme.css").buffer(true);
	assert.equal(res.status, 200);
	assert.ok(!res.text.includes("--vdo-theme-placeholder"), "placeholder token must be gone");
	assert.match(res.text, /#ff3b3b/i, "red accent must be present");
	assert.match(res.text, /--discord-grey-7:/, "neutral ramp must be remapped");
});

test("F16: THEME injects exactly one theme <link> immediately before </head> on / and a clean room URL", async () => {
	// The clean room URL is the headline case: it has no matching <name>.html,
	// so it resolves through the SPA fallback to index.html -- which must still
	// be themed, not left un-themed while only real pages get the <link>.
	for (const url of ["/", "/someRoom"]) {
		const res = await request(themedApp).get(url).buffer(true);
		assert.equal(res.status, 200);
		assert.match(res.headers["content-type"], /html/);
		assert.equal(res.headers["cache-control"], "no-cache");
		// Exactly once, and immediately before the first </head>.
		assert.equal(res.text.split(THEME_LINK).length - 1, 1);
		assert.ok(res.text.includes(`${THEME_LINK}</head>`));
	}
});

test("F16: a standalone tool page is themed AND its .html still 301-redirects to the clean URL", async () => {
	const themed = await request(themedApp).get("/mixer").buffer(true);
	assert.equal(themed.status, 200);
	assert.match(themed.headers["content-type"], /html/);
	assert.ok(themed.text.includes(`${THEME_LINK}</head>`));

	// Injection sits AFTER the clean-URL redirect, so /mixer.html must still 301
	// to /mixer (query preserved) instead of being served/injected directly.
	const redirect = await request(themedApp).get("/mixer.html?foo=1");
	assert.equal(redirect.status, 301);
	assert.equal(redirect.headers.location, "/mixer?foo=1");
});

test("F16: non-HTML assets are served untouched under THEME (no injected link, correct type)", async () => {
	const res = await request(themedApp).get("/lib.js?ver=1415").buffer(true);
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"], /javascript/);
	assert.ok(!res.text.includes(THEME_LINK));
});

test("F16: with THEME unset (default app) /theme.css 404s and no theme link is injected", async () => {
	// Proves zero behavior change when the feature is off: the middleware isn't
	// even registered on the default `app`.
	assert.equal((await request(app).get("/theme.css")).status, 404);

	const home = await request(app).get("/").buffer(true);
	assert.equal(home.status, 200);
	assert.ok(!home.text.includes(THEME_LINK));
});

test("F16: the deny-list still wins under THEME (server internals + themes/ stay 404)", async () => {
	// Injection runs after the deny-list, so a blocked internal is never
	// read-and-injected. themes/ itself is off the static path (see BLOCKED_
	// PREFIXES), so /theme.css is the only route to a theme file.
	assert.equal((await request(themedApp).get("/server.js")).status, 404);
	assert.equal((await request(themedApp).get("/themes/red-black.css")).status, 404);
});

// ---------------------------------------------------------------------------
// F18 — server-gated /director link dispensing.
// ---------------------------------------------------------------------------
// Like THEME, server.js reads DIRECTOR_SECRET / DIRECTOR_ROOM / ROOM_PASSWORD /
// ROOM_KEY exactly once at require time into its `config`. The top-level `app`
// was required with all four UNSET, so it has the feature OFF -- reused directly
// by the "disabled" test below. loadDirectorApp() builds a fresh app instance
// with a chosen env hermetically, mirroring loadThemedApp() above: it snapshots
// the cached server module, sets the requested env vars (deleting any the caller
// omits), re-requires server.js so it re-reads the env, then restores BOTH the
// env and the original cached module so the rest of the suite is untouched.
const DIRECTOR_ENV_KEYS = ["DIRECTOR_SECRET", "DIRECTOR_ROOM", "ROOM_PASSWORD", "ROOM_KEY"];

function loadDirectorApp(env) {
	const serverPath = require.resolve("../server");
	const originalModule = require.cache[serverPath];
	const saved = {};
	for (const key of DIRECTOR_ENV_KEYS) {
		saved[key] = key in process.env ? process.env[key] : undefined;
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}

	delete require.cache[serverPath];
	const directorApp = require("../server");

	for (const key of DIRECTOR_ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	require.cache[serverPath] = originalModule;

	return directorApp;
}

// Encodes an HTTP Basic "Authorization" header value for a supplied password
// (username is irrelevant to the check, so it's left blank).
function basicAuth(password) {
	return `Basic ${Buffer.from(`:${password}`).toString("base64")}`;
}

test("F18: with DIRECTOR_SECRET unset the /director route is absent (falls through, no 401, no director redirect)", async () => {
	// Default `app` has the feature off, so /director is just a clean URL: it
	// falls through to the SPA fallback (there is no director.html) -> 200 index.
	const res = await request(app).get("/director");
	assert.notEqual(res.status, 401);
	assert.notEqual(res.status, 302);
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"], /html/);
});

test("F18: enabled but no Authorization header -> 401 with WWW-Authenticate", async () => {
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret", DIRECTOR_ROOM: "greenroom" });
	const res = await request(directorApp).get("/director");
	assert.equal(res.status, 401);
	assert.match(res.headers["www-authenticate"], /^Basic /);
});

test("F18: enabled with a wrong password -> 401", async () => {
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret", DIRECTOR_ROOM: "greenroom" });
	const res = await request(directorApp).get("/director").set("Authorization", basicAuth("wrong"));
	assert.equal(res.status, 401);
});

test("F18: enabled with a supplied password of a DIFFERENT length than the secret does not throw -> 401", async () => {
	// Guards the constant-time-compare contract: hashing both sides to a fixed
	// 32-byte width is what stops crypto.timingSafeEqual from throwing on
	// mismatched-length inputs. A raw compare here would 500, not 401.
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "short", DIRECTOR_ROOM: "greenroom" });
	const res = await request(directorApp).get("/director").set("Authorization", basicAuth("a-much-longer-password-than-the-secret"));
	assert.equal(res.status, 401);
});

test("F18: enabled, correct password, no ROOM_KEY -> 302 to /?director=<ROOM>; password only in the fragment; no requireapproval", async () => {
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret", DIRECTOR_ROOM: "green room", ROOM_PASSWORD: "hunter2" });
	const res = await request(directorApp).get("/director").set("Authorization", basicAuth("s3cret"));
	assert.equal(res.status, 302);

	const location = res.headers.location;
	const hashIndex = location.indexOf("#");
	assert.notEqual(hashIndex, -1, "a password is set, so there must be a fragment");
	const beforeHash = location.slice(0, hashIndex);
	const afterHash = location.slice(hashIndex + 1);

	// Query part: director room only, no requireapproval (ROOM_KEY unset).
	assert.equal(beforeHash, `/?director=${encodeURIComponent("green room")}`);
	assert.ok(!beforeHash.includes("requireapproval"), "no ROOM_KEY -> no requireapproval");

	// The secret must NOT leak into the query string, only the fragment.
	assert.ok(!beforeHash.includes("password="), "password must not appear before '#'");
	assert.ok(!beforeHash.includes("hunter2"), "password value must not appear before '#'");
	assert.equal(afterHash, `password=${encodeURIComponent("hunter2")}`);
});

test("F18: enabled, correct password, ROOM_KEY set -> requireapproval in query; password + roomkey only in the fragment", async () => {
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret", DIRECTOR_ROOM: "greenroom", ROOM_PASSWORD: "hunter2", ROOM_KEY: "let me in" });
	const res = await request(directorApp).get("/director").set("Authorization", basicAuth("s3cret"));
	assert.equal(res.status, 302);

	const location = res.headers.location;
	const hashIndex = location.indexOf("#");
	assert.notEqual(hashIndex, -1);
	const beforeHash = location.slice(0, hashIndex);
	const afterHash = location.slice(hashIndex + 1);

	// Query part: director room + requireapproval (present iff ROOM_KEY set).
	assert.equal(beforeHash, "/?director=greenroom&requireapproval");

	// Neither secret leaks into the query string.
	assert.ok(!beforeHash.includes("password="), "password must not appear before '#'");
	assert.ok(!beforeHash.includes("hunter2"), "password value must not appear before '#'");
	assert.ok(!beforeHash.includes("roomkey="), "roomkey must not appear before '#'");
	assert.ok(!beforeHash.includes("let me in") && !beforeHash.includes(encodeURIComponent("let me in")), "roomkey value must not appear before '#'");

	// Both secrets live in the fragment, encodeURIComponent'd.
	assert.equal(afterHash, `password=${encodeURIComponent("hunter2")}&roomkey=${encodeURIComponent("let me in")}`);
});

test("F18: ROOM_KEY set with no ROOM_PASSWORD -> fragment carries only roomkey and requireapproval is present", async () => {
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret", DIRECTOR_ROOM: "greenroom", ROOM_KEY: "rk123" });
	const res = await request(directorApp).get("/director").set("Authorization", basicAuth("s3cret"));
	assert.equal(res.status, 302);
	assert.equal(res.headers.location, "/?director=greenroom&requireapproval#roomkey=rk123");
});

test("F18: no ROOM_PASSWORD and no ROOM_KEY -> plain /?director=<ROOM> with no fragment at all", async () => {
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret", DIRECTOR_ROOM: "greenroom" });
	const res = await request(directorApp).get("/director").set("Authorization", basicAuth("s3cret"));
	assert.equal(res.status, 302);
	assert.equal(res.headers.location, "/?director=greenroom");
});

test("F18: DIRECTOR_SECRET set but DIRECTOR_ROOM unset disables the feature (route absent, falls through to 200)", async () => {
	// Same "secret without a room" disable-and-warn posture as an invalid THEME.
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret" });
	const res = await request(directorApp).get("/director");
	assert.notEqual(res.status, 401);
	assert.notEqual(res.status, 302);
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"], /html/);
});

// ---------------------------------------------------------------------------
// F-A / T1 — per-IP brute-force throttle on the /director Basic-auth endpoint.
// ---------------------------------------------------------------------------
// server.js hardcodes the throttle window/threshold INSIDE its
// `if (DIRECTOR_ENABLED)` block (no env var, mirroring the F22 limiter): up to
// DIRECTOR_AUTH_MAX_FAILURES failed password attempts per IP within a trailing
// 15-minute window, then that IP is locked out (429 + Retry-After) for the rest
// of the window; a correct password resets the counter. These tests cross the
// threshold synchronously within the window -- every supertest request here
// comes from the same loopback IP, i.e. one shared bucket -- so there are no
// timers to wait on, and each loadDirectorApp() call is a fresh app with a
// fresh, empty failure map. DIRECTOR_AUTH_MAX_FAILURES below must stay in sync
// with the constant of the same name in server.js.
const DIRECTOR_AUTH_MAX_FAILURES = 10;

test("F-A/T1: repeated wrong passwords lock the IP out -- pre-threshold attempts 401, the threshold attempt 429 with a positive Retry-After", async () => {
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret", DIRECTOR_ROOM: "greenroom" });

	// The first DIRECTOR_AUTH_MAX_FAILURES - 1 wrong attempts are ordinary 401s.
	for (let i = 0; i < DIRECTOR_AUTH_MAX_FAILURES - 1; i++) {
		const res = await request(directorApp).get("/director").set("Authorization", basicAuth("wrong"));
		assert.equal(res.status, 401, `attempt ${i + 1} should still be 401`);
	}

	// The attempt that REACHES the cap is itself throttled: 429 + Retry-After,
	// and the JSON body reuses sendError's shared 429 label.
	const locking = await request(directorApp).get("/director").set("Authorization", basicAuth("wrong")).set("Accept", "application/json");
	assert.equal(locking.status, 429);
	assert.ok(Number(locking.headers["retry-after"]) > 0, "Retry-After must be a positive number of seconds");
	assert.deepEqual(locking.body, { error: "rate_limited" });
});

test("F-A/T1: once locked out, even the CORRECT password is 429 -- lockout is not bypassable while locked", async () => {
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret", DIRECTOR_ROOM: "greenroom" });

	// Drive it to the cap with wrong passwords.
	for (let i = 0; i < DIRECTOR_AUTH_MAX_FAILURES; i++) {
		await request(directorApp).get("/director").set("Authorization", basicAuth("wrong"));
	}

	// The password check is skipped entirely while locked, so the correct
	// password gets 429, NOT a 302 redirect -- proving an attacker can't keep
	// guessing and slip through the moment they hit the right value.
	const correctWhileLocked = await request(directorApp).get("/director").set("Authorization", basicAuth("s3cret"));
	assert.equal(correctWhileLocked.status, 429);
	assert.notEqual(correctWhileLocked.status, 302);
	assert.ok(Number(correctWhileLocked.headers["retry-after"]) > 0, "Retry-After must be a positive number of seconds");
});

test("F-A/T1: a correct password resets the counter -- earlier failures don't carry over, so it takes a full fresh threshold to lock out again", async () => {
	const directorApp = loadDirectorApp({ DIRECTOR_SECRET: "s3cret", DIRECTOR_ROOM: "greenroom" });

	// A few (below-threshold) wrong attempts...
	for (let i = 0; i < DIRECTOR_AUTH_MAX_FAILURES - 1; i++) {
		const res = await request(directorApp).get("/director").set("Authorization", basicAuth("wrong"));
		assert.equal(res.status, 401);
	}

	// ...then one correct attempt succeeds (302) and clears this IP's bucket.
	const success = await request(directorApp).get("/director").set("Authorization", basicAuth("s3cret"));
	assert.equal(success.status, 302);

	// The counter is back to zero: the next DIRECTOR_AUTH_MAX_FAILURES - 1 wrong
	// attempts are all 401 again. Had the earlier failures persisted across the
	// success, the very first of these would already be the threshold-th failure
	// and 429 -- so a 401 here is what proves the reset happened.
	for (let i = 0; i < DIRECTOR_AUTH_MAX_FAILURES - 1; i++) {
		const res = await request(directorApp).get("/director").set("Authorization", basicAuth("wrong"));
		assert.equal(res.status, 401, `post-reset attempt ${i + 1} should be 401, proving the counter restarted from zero`);
	}

	// Only the full fresh threshold of new failures locks out again.
	const relock = await request(directorApp).get("/director").set("Authorization", basicAuth("wrong"));
	assert.equal(relock.status, 429);
});

// ---------------------------------------------------------------------------
// F22 — opt-in, in-memory, per-IP request-rate limiter.
// ---------------------------------------------------------------------------
// Same hermetic pattern as loadThemedApp()/loadDirectorApp() above: server.js
// reads RATE_LIMIT_RPM (and, for the per-IP isolation test below, TRUST_PROXY)
// into its frozen `config` exactly once at require time. The top-level `app`
// was required with RATE_LIMIT_RPM unset, so it has the feature OFF -- reused
// directly by the "disabled by default" test below. loadRateLimitedApp()
// builds a fresh instance with a chosen env hermetically: snapshot the cached
// module, set/delete the requested env vars, re-require server.js so it
// re-reads them, then restore both the env and the original cached module so
// the rest of the suite is untouched.
const RATE_LIMIT_ENV_KEYS = ["RATE_LIMIT_RPM", "TRUST_PROXY", "RATE_LIMIT_MAX_IPS"];

function loadRateLimitedApp(env) {
	const serverPath = require.resolve("../server");
	const originalModule = require.cache[serverPath];
	const saved = {};
	for (const key of RATE_LIMIT_ENV_KEYS) {
		saved[key] = key in process.env ? process.env[key] : undefined;
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}

	delete require.cache[serverPath];
	const limitedApp = require("../server");

	for (const key of RATE_LIMIT_ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	require.cache[serverPath] = originalModule;

	return limitedApp;
}

test("F22: disabled by default -- with RATE_LIMIT_RPM unset, far more requests than any plausible limit all succeed", async () => {
	// The default top-level `app` was required with RATE_LIMIT_RPM unset, so
	// the middleware isn't even registered on it -- this proves zero behavior
	// change for every self-hoster who never opts in.
	for (let i = 0; i < 50; i++) {
		const res = await request(app).get("/config.js");
		assert.equal(res.status, 200);
	}
});

test("F22: enabled -- the first N requests succeed and request N+1 is 429 with a Retry-After header and a rate_limited JSON body", async () => {
	const limitedApp = loadRateLimitedApp({ RATE_LIMIT_RPM: "3" });

	for (let i = 0; i < 3; i++) {
		const res = await request(limitedApp).get("/config.js");
		assert.equal(res.status, 200);
	}

	const blocked = await request(limitedApp).get("/config.js").set("Accept", "application/json");
	assert.equal(blocked.status, 429);
	assert.ok(blocked.headers["retry-after"], "Retry-After header must be present");
	assert.ok(Number(blocked.headers["retry-after"]) > 0, "Retry-After must be a positive number of seconds");
	assert.deepEqual(blocked.body, { error: "rate_limited" });
});

test("F22: /healthz is exempt from the limit even after the same IP is already throttled on other paths", async () => {
	const limitedApp = loadRateLimitedApp({ RATE_LIMIT_RPM: "1" });

	const first = await request(limitedApp).get("/config.js");
	assert.equal(first.status, 200);
	const throttled = await request(limitedApp).get("/config.js");
	assert.equal(throttled.status, 429);

	// Same client, repeatedly, on /healthz: always 200, never throttled.
	for (let i = 0; i < 3; i++) {
		const health = await request(limitedApp).get("/healthz");
		assert.equal(health.status, 200);
	}
});

test("F22: /healthz/ (trailing slash) is also exempt from the limit, since Express's non-strict routing serves it from the same /healthz route", async () => {
	const limitedApp = loadRateLimitedApp({ RATE_LIMIT_RPM: "1" });

	const first = await request(limitedApp).get("/config.js");
	assert.equal(first.status, 200);
	const throttled = await request(limitedApp).get("/config.js");
	assert.equal(throttled.status, 429);

	// Same client, repeatedly, on /healthz/: always 200, never throttled.
	for (let i = 0; i < 3; i++) {
		const health = await request(limitedApp).get("/healthz/");
		assert.equal(health.status, 200);
	}
});

// Confirms req.ip is genuinely derived from X-Forwarded-For under TRUST_PROXY
// (not just from the underlying loopback socket every supertest request
// actually comes from): the same XFF value used repeatedly gets throttled,
// while a DIFFERENT XFF value is unaffected by that first client's usage --
// which could only happen if each XFF value maps to its own bucket.
test("F22: per-IP isolation -- one client IP being throttled does not affect a different client IP (TRUST_PROXY + X-Forwarded-For)", async () => {
	const limitedApp = loadRateLimitedApp({ RATE_LIMIT_RPM: "2", TRUST_PROXY: "1" });

	for (let i = 0; i < 2; i++) {
		const res = await request(limitedApp).get("/config.js").set("X-Forwarded-For", "203.0.113.10");
		assert.equal(res.status, 200);
	}
	const blockedFirstClient = await request(limitedApp).get("/config.js").set("X-Forwarded-For", "203.0.113.10");
	assert.equal(blockedFirstClient.status, 429);

	// A second, distinct client IP has its own untouched bucket.
	const secondClient = await request(limitedApp).get("/config.js").set("X-Forwarded-For", "203.0.113.99");
	assert.equal(secondClient.status, 200);
});

// T4/F-D: rateLimitBuckets is bounded not just by its periodic sweep but also by
// a hard ceiling (RATE_LIMIT_MAX_IPS), least-recently-active entry evicted first.
// Without it, a misconfigured TRUST_PROXY plus a spoofed X-Forwarded-For could
// mint one fresh bucket per request and grow the Map without bound between
// sweeps. RATE_LIMIT_MAX_IPS: "3" makes the ceiling cheap to actually drive here.
test("F22/T4: rateLimitBuckets is hard-capped by RATE_LIMIT_MAX_IPS, evicting the least-recently-active IP first", async () => {
	const limitedApp = loadRateLimitedApp({ RATE_LIMIT_RPM: "1", RATE_LIMIT_MAX_IPS: "3", TRUST_PROXY: "1" });
	const clientA = "203.0.113.201";

	// Client A's bucket is created (200) then immediately full for its 1rpm
	// allowance (429) -- it now sits in the Map, untouched from here on.
	const first = await request(limitedApp).get("/config.js").set("X-Forwarded-For", clientA);
	assert.equal(first.status, 200);
	const throttled = await request(limitedApp).get("/config.js").set("X-Forwarded-For", clientA);
	assert.equal(throttled.status, 429);

	// Three more, never-before-seen IPs each mint a brand-new bucket: the Map is
	// [A] (size 1) going in, the 1st grows it to size 2, the 2nd to size 3 (at the
	// cap), and the 3rd is the one that must evict to stay <= 3. A hasn't been
	// touched since its 429 above, so A -- not the 1st or 2nd new IP -- is the
	// least-recently-active entry and the one evicted.
	for (let i = 0; i < 3; i++) {
		const res = await request(limitedApp)
			.get("/config.js")
			.set("X-Forwarded-For", `203.0.113.${210 + i}`);
		assert.equal(res.status, 200);
	}

	// A's bucket was evicted to make room, so this request starts a brand-new,
	// empty bucket for A and is allowed. If the Map were unbounded, A's original
	// (already-full) bucket would still be sitting there and this would still be
	// 429 -- so seeing 200 here is exactly what proves the hard cap fired and
	// evicted the right (least-recently-active) entry.
	const afterEviction = await request(limitedApp).get("/config.js").set("X-Forwarded-For", clientA);
	assert.equal(afterEviction.status, 200);
});

// T4/F-D: isolates LRU eviction from a plain FIFO (evict-first-inserted) policy.
// In the test above, IP A is simultaneously the first-inserted AND the
// least-recently-active entry, so evicting A is consistent with either policy --
// it can't tell them apart. Here, A is re-touched after B and C so it is no
// longer the least-recently-active entry despite still being the first-ever
// inserted, which only LRU (not FIFO) tracks correctly.
test("F22/T4: recency refresh on the 429 path is what picks the eviction victim, not insertion order", async () => {
	const limitedApp = loadRateLimitedApp({ RATE_LIMIT_RPM: "1", RATE_LIMIT_MAX_IPS: "3", TRUST_PROXY: "1" });
	const [clientA, clientB, clientC, clientD] = ["203.0.113.220", "203.0.113.221", "203.0.113.222", "203.0.113.223"];

	// Fill the cap with three distinct IPs, one request each (all 200). Map
	// (insertion/MRU order, front = LRU) is now [A, B, C].
	for (const ip of [clientA, clientB, clientC]) {
		const res = await request(limitedApp).get("/config.js").set("X-Forwarded-For", ip);
		assert.equal(res.status, 200);
	}

	// Re-touch A: at RPM=1, A's bucket is already full, so this is a 429 -- but
	// the 429 path calls touchBounded too, which moves A to the MRU/end position.
	// Map is now [B, C, A]: B, not A, is the new least-recently-active entry,
	// even though A was inserted first.
	const retouchA = await request(limitedApp).get("/config.js").set("X-Forwarded-For", clientA);
	assert.equal(retouchA.status, 429);

	// A fourth, never-before-seen IP forces exactly one eviction to stay <= 3.
	// Under correct LRU the front is B, so B is evicted: map becomes [C, A, D].
	// Under a broken FIFO (evict first-inserted) A would be evicted instead.
	const insertD = await request(limitedApp).get("/config.js").set("X-Forwarded-For", clientD);
	assert.equal(insertD.status, 200);

	// Discriminator: B was evicted, so it starts a fresh, empty bucket -- 200.
	const freshB = await request(limitedApp).get("/config.js").set("X-Forwarded-For", clientB);
	assert.equal(freshB.status, 200);

	// Discriminator (load-bearing): A survived the eviction, so its original,
	// still-full 1rpm bucket is still there -- 429. Under a FIFO eviction policy
	// A would have been evicted here and returned 200; a 429 proves the recency
	// refresh (LRU) is what chose the victim.
	const stillA = await request(limitedApp).get("/config.js").set("X-Forwarded-For", clientA);
	assert.equal(stillA.status, 429);
});

// ---------------------------------------------------------------------------
// F-C — HSTS's includeSubDomains is opt-in, not default.
// ---------------------------------------------------------------------------
// Same hermetic pattern as loadThemedApp()/loadDirectorApp()/loadRateLimitedApp()
// above: server.js reads HSTS_INCLUDE_SUBDOMAINS into its frozen `config` exactly
// once at require time. The top-level `app` was required with it unset, so it
// has includeSubDomains OFF -- reused directly by the "default" test below.
// loadHstsApp() builds a fresh instance with the env var set hermetically:
// snapshot the cached module, set/delete the env var, re-require server.js so
// it re-reads it, then restore both the env and the original cached module so
// the rest of the suite is untouched.
function loadHstsApp(env) {
	const serverPath = require.resolve("../server");
	const originalModule = require.cache[serverPath];
	const hadEnv = "HSTS_INCLUDE_SUBDOMAINS" in process.env;
	const savedEnv = process.env.HSTS_INCLUDE_SUBDOMAINS;
	if (env.HSTS_INCLUDE_SUBDOMAINS === undefined) delete process.env.HSTS_INCLUDE_SUBDOMAINS;
	else process.env.HSTS_INCLUDE_SUBDOMAINS = env.HSTS_INCLUDE_SUBDOMAINS;

	delete require.cache[serverPath];
	const hstsApp = require("../server");

	if (hadEnv) process.env.HSTS_INCLUDE_SUBDOMAINS = savedEnv;
	else delete process.env.HSTS_INCLUDE_SUBDOMAINS;
	require.cache[serverPath] = originalModule;

	return hstsApp;
}

test("F-C: by default, Strict-Transport-Security omits includeSubDomains", async () => {
	// The top-level `app` was required with HSTS_INCLUDE_SUBDOMAINS unset, so
	// this proves the safe-by-default behavior forkers get with no configuration.
	const res = await request(app).get("/healthz");
	assert.equal(res.headers["strict-transport-security"], "max-age=15552000");
	assert.doesNotMatch(res.headers["strict-transport-security"], /includeSubDomains/);
});

test("F-C: HSTS_INCLUDE_SUBDOMAINS=true appends includeSubDomains to the Strict-Transport-Security header", async () => {
	const hstsApp = loadHstsApp({ HSTS_INCLUDE_SUBDOMAINS: "true" });
	const res = await request(hstsApp).get("/healthz");
	assert.equal(res.headers["strict-transport-security"], "max-age=15552000; includeSubDomains");
});
