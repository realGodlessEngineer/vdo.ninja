"use strict";

// Smoke tests for server.js's URL-handling behavior (F8). server.js exports
// the Express app without listening when required (see the
// `require.main === module` guard at the bottom of the file), so these run
// entirely in-process via supertest -- no port is ever bound.

const test = require("node:test");
const assert = require("node:assert/strict");
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
