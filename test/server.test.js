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
	assert.equal(res.status, 302);
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
	// the guard (which would 302 instead) fails this test outright.
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

test("F16: a standalone tool page is themed AND its .html still 302-redirects to the clean URL", async () => {
	const themed = await request(themedApp).get("/mixer").buffer(true);
	assert.equal(themed.status, 200);
	assert.match(themed.headers["content-type"], /html/);
	assert.ok(themed.text.includes(`${THEME_LINK}</head>`));

	// Injection sits AFTER the clean-URL redirect, so /mixer.html must still 302
	// to /mixer (query preserved) instead of being served/injected directly.
	const redirect = await request(themedApp).get("/mixer.html?foo=1");
	assert.equal(redirect.status, 302);
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
