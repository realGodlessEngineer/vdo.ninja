# Self-Hosting Layer — General Improvements Audit (VDO.Ninja Express Server)

**Date:** 2026-07-14
**Scope (as agreed):** the **self-hosting layer only** — `server.js`, `package.json`, `package-lock.json`, and the deploy/config story. The browser client (`index.html`, `lib.js`, `main.js`, `webrtc.js`, the standalone `.html` tools) is **out of scope** here.
**Dimensions (as agreed):** Performance · Code quality / maintainability · UX & accessibility (of the responses the server itself emits + operator DX).
**Companion doc:** security/correctness findings live in `AUDIT_REPORT.md` (IDs `S-01`…`S-13`). This report is *improvement*-focused and cross-references those instead of repeating them.

**Verification basis:** measured asset sizes on disk, and inspected the installed `express@4.22.2` / `compression@1.8.1` behavior directly (brotli is active by default at `BROTLI_PARAM_QUALITY = 4`; `express.static` default `maxAge` is `0`). Nothing here is a security bug — those are in `AUDIT_REPORT.md`.

---

## 0. Executive Summary

The server is small, clean, and well-commented — a good starting template. The single biggest *improvement* opportunity is **HTTP caching**: the server currently tells browsers to revalidate every asset on every load, which is wasteful given the client's payload is dominated by a **2.15 MB `lib.js`** and a **687 KB `webrtc.js`**, and given the app already uses `?ver=NNN` cache-busting that makes those assets safe to cache aggressively. Fixing caching (P-01) is the highest ROI change in this report.

Secondary improvements: precompressing large text assets offline (P-02), centralizing configuration (Q-01), adding a couple of smoke tests for the redirect/fallback branch logic that hid the open-redirect bug (Q-04), and replacing the **blank 404** and **absent error handler** with small, accessible responses (U-01, U-02).

**Effort tally:** High-value: 1 (P-01) · Medium: 5 · Low/Info: rest. None are large; the whole set is a half-day of focused work.

**Asset weights (measured, uncompressed):**

| File | Size | Served how |
|---|---|---|
| `lib.js` | 2,201,729 B (~2.15 MB) | static, `?ver=`-busted |
| `webrtc.js` | 703,323 B (~687 KB) | static, `?ver=`-busted |
| `main.js` | 370,418 B (~362 KB) | static, `?ver=`-busted |
| `index.html` | 222,514 B (~217 KB) | SPA fallback / static |

---

## 1. Performance

### P-01 — No cache lifetime on static assets → a revalidation round-trip per asset, per load  `[HIGH VALUE]`
**Location:** `server.js:78-84` (`express.static(ROOT, …)` — no `maxAge`/`immutable`/`setHeaders`)

**Problem.** `express.static` defaults to `Cache-Control: public, max-age=0`. Browsers therefore keep a copy but **revalidate on every navigation** (conditional `If-None-Match`/`If-Modified-Since` → usually `304`). Every page load pays a network round-trip for `lib.js`, `webrtc.js`, `main.js`, and every image/font — even when nothing changed. On OBS reconnects, mobile, and high-latency links this is the dominant cost, and it multiplies across the dozens of assets a page pulls.

**Why it's safe to fix aggressively here.** The whole app is designed around **query-string cache-busting** — `lib.js?ver=1415`, `webrtc.js?ver=933`, etc. (see `CLAUDE.md` → "Cache-busting version numbers"; `index.html` alone carries 5 `?ver=` refs). The browser cache key includes the query string, so bumping `?ver=` fetches a fresh copy automatically. That means versioned static assets can be served **`immutable`, one year** with zero staleness risk.

**Critical caveat — do NOT hard-cache HTML.** The `?ver` numbers *live inside* the HTML, so the HTML itself must stay revalidated or users would be pinned to old asset versions. Same for the SPA fallback (`server.js:90-97`), which serves `index.html`.

**Fix.** Use `express.static`'s `setHeaders` to split the policy by type — long/immutable for assets, `no-cache` for HTML:
```js
const ONE_YEAR = 31536000; // seconds
app.use(
	express.static(ROOT, {
		extensions: ["html"],
		index: "index.html",
		dotfiles: "ignore",
		etag: true,
		lastModified: true,
		setHeaders(res, filePath) {
			if (filePath.endsWith(".html")) {
				// HTML holds the ?ver= pointers — must always revalidate.
				res.setHeader("Cache-Control", "no-cache");
			} else {
				// Versioned, effectively-immutable assets (js/css/img/fonts…).
				res.setHeader("Cache-Control", `public, max-age=${ONE_YEAR}, immutable`);
			}
		}
	})
);
```
And set the SPA fallback (`server.js:93`) to `no-cache` before `res.sendFile(...)`:
```js
res.setHeader("Cache-Control", "no-cache");
res.sendFile(path.join(ROOT, "index.html"));
```
**Prerequisite to communicate:** any *mutable* asset must be referenced with a `?ver=` (or be content-hashed). The core client already does this for its big files; if a fork adds an image/CSS it expects to update in place *without* a `?ver` bump, that one asset would go stale until a hard refresh. Document this so forkers don't get surprised.

**Impact:** turns "N conditional requests per page load" into "0 for a warm cache," dramatically cutting time-to-interactive on repeat loads and OBS source reloads. This is the single highest-leverage change in the report.

---

### P-02 — Large text assets are compressed on every miss instead of precompressed once  `[MEDIUM]`
**Location:** `server.js:33` (`app.use(compression())`)

**Current state (measured, not assumed).** `compression@1.8.1` is installed and **brotli is already on** for Node ≥18 (`PREFERRED_ENCODING = ['br','gzip']`), at `BROTLI_PARAM_QUALITY = 4` — a deliberately balanced speed/ratio setting. So "add brotli" is **not** a valid recommendation; it's there. Two real, smaller opportunities remain:

1. **Ratio.** On-the-fly brotli runs at quality **4**; an offline pass can use quality **11** (max) and typically shrinks `lib.js`/`webrtc.js` an extra ~10–15% — meaningful on a 2.15 MB file, and you pay the CPU once at deploy, not per request.
2. **CPU under fan-out.** Once P-01 lands, warm clients don't refetch — but CDN fills, cold caches, and every unique first-time viewer still trigger a fresh compress. Precompressed files remove that per-request work entirely.

**Fix (deploy-time precompression + serve the precompressed variant).**
```js
// npm i express-static-gzip  (serves file.br / file.gz when present, else falls back)
const expressStaticGzip = require("express-static-gzip");
app.use(expressStaticGzip(ROOT, {
	enableBrotli: true,
	orderPreference: ["br", "gz"],
	serveStatic: { extensions: ["html"], index: "index.html", dotfiles: "ignore",
		setHeaders: /* same split policy as P-01 */ }
}));
```
plus a deploy step that generates the artifacts once:
```bash
# gzip + brotli the big text assets ahead of time (run at build/deploy)
find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \) \
  -not -path './node_modules/*' \
  -exec sh -c 'gzip -9 -k -f "$1"; brotli -q 11 -k -f "$1"' _ {} \;
```
**Priority note:** this is *secondary to P-01*. If you only do one perf change, do P-01. Keep the current `compression()` as the fallback for any dynamic route (e.g. `/config.js`).

---

### P-03 — `.html` → clean-URL redirect adds an uncacheable round-trip  `[LOW]`
**Location:** `server.js:73` (`res.redirect(302, …)`) — cross-ref `S-12`.

**Problem.** Every hit to a `…​.html` URL costs an extra RTT for the `302`, and a `302` is *not* cached, so repeat hits keep paying it. This is deliberate parity with the reference Nginx config, so it's defensible — but if link-heavy pages route through `.html` URLs, a `301` lets browsers/CDNs remember the canonical form and skip the round-trip next time.

**Fix (only after `S-01`, the open-redirect guard, is in place):** switch `302` → `301`. Do **not** do this before `S-01` — a cached malicious redirect is worse than an uncached one.

---

### P-04 — No CDN / far-future strategy documented for the static tier  `[INFO]`
**Location:** deploy story (`README`/`install.md`), not a code line.

Once P-01 marks assets `immutable`, the client tier is ideal to front with any CDN/edge cache (the app is already "nearly serverless" per `CLAUDE.md`). Worth a sentence in the self-hosting docs: "put a CDN in front; assets are `immutable`, HTML is `no-cache`." No code needed — just guidance so operators get the win.

---

## 2. Code Quality / Maintainability

### Q-01 — Configuration is scattered as inline `process.env.X || default` reads  `[MEDIUM]`
**Location:** `server.js:24-25` (`PORT`, `HOST`) and `server.js:55-58` (`TURN_SERVER`, `SIGNALING_HOST`, `BRAND_NAME`) — cross-ref `S-13` (PORT validation).

**Problem.** For a file whose explicit purpose is "customize me," the set of knobs is spread across the file with no single place to see or validate them. A reader can't answer "what can I configure?" without scanning everything.

**Fix.** Hoist a single validated `config` block near the top; everything else references it:
```js
const config = {
	port: Number.parseInt(process.env.PORT, 10) || 8366,   // fixes S-13 too
	host: process.env.HOST || "0.0.0.0",
	trustProxy: process.env.TRUST_PROXY ?? "loopback",     // see S-03
	turnServer: process.env.TURN_SERVER || null,
	signalingHost: process.env.SIGNALING_HOST || null,
	brandName: process.env.BRAND_NAME || "VDO.Ninja",
	logRequests: process.env.LOG_REQUESTS === "true"
};
```
This also becomes the natural home for the `/config.js` payload (`server.js:55-59`), removing duplication.

---

### Q-02 — Redirect/fallback branch logic is subtle and untested  `[MEDIUM]`
**Location:** `server.js:69-74` (redirect) and `server.js:90-97` (extension-vs-SPA fallback).

**Problem.** These two blocks carry all the tricky behavior — query-string preservation, "extension ⇒ 404 vs extensionless ⇒ SPA," method handling — and one of them shipped the open-redirect bug (`S-01`). There is no test guarding any of it, so the next edit can silently reintroduce a regression.

**Fix.** Add a handful of `supertest` smoke tests (dev-only dependency; no framework needed elsewhere). High value for ~30 lines:
```js
// test/server.test.js  (run with `node --test`)
const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const app = require("../server"); // export `app` from server.js (see Q-03)

test("clean-url redirect preserves query", async () => {
	const r = await request(app).get("/mixer.html?foo=1");
	assert.equal(r.status, 302);
	assert.equal(r.headers.location, "/mixer?foo=1");
});
test("open-redirect is blocked", async () => {          // guards S-01
	const r = await request(app).get("//evil.com.html");
	assert.notMatch(r.headers.location || "", /^\/\//);
});
test("missing asset 404s, clean URL falls back to index", async () => {
	assert.equal((await request(app).get("/nope.js")).status, 404);
	assert.equal((await request(app).get("/someRoom")).status, 200);
});
```

---

### Q-03 — `server.js` isn't importable (blocks testing) and binds on require  `[LOW]`
**Location:** `server.js:99-101` (`app.listen(...)` runs unconditionally at module load).

**Problem.** Because the file calls `app.listen` at the top level and exports nothing, you can't `require('./server')` in a test (Q-02) without it grabbing a port. Small structural nit that unlocks testability.

**Fix.** Export the app and guard the listen:
```js
module.exports = app;
if (require.main === module) {
	const server = app.listen(config.port, config.host, () => { /* … */ });
	// server.on('error', …) / graceful shutdown from S-05, S-06
}
```

---

### Q-04 — Minor clean-code polish  `[INFO]`
- **Named constants** for magic values: the `302` redirect status (`server.js:73`) and, once P-01 lands, the cache TTLs. Small readability win. `8366` is already well-explained in a comment — keep that.
- **`dev` script equals `start`** (`package.json:9-10`, cross-ref `S-11`): make `dev` `node --watch server.js` (Node ≥18 supports it, matching `engines`) so the two scripts mean different things.
- **Section banners & comments are excellent** (`server.js:41-43`, `64-66`) and accurately describe intent — keep them; they're a big part of why this file is easy to extend. *(positive — do not regress)*
- **Prettier compliance:** the file matches the repo `.prettierrc` (tabs, double quotes, semicolons). Keep running `npx prettier` on edits.

---

## 3. UX & Accessibility (server-emitted responses + operator DX)

> Scope note: a real accessibility/mobile audit belongs to the **client UI** (`index.html` and the standalone tools), which you deliberately kept **out of scope**. The only a11y surface the *self-hosting layer* owns is the pages it emits itself — the 404 and error responses below — plus operator/developer experience. Flag it if you later want the client-UI a11y/mobile pass; it's a separate, larger effort.

### U-01 — Blank 404 page (no content, nothing for assistive tech)  `[MEDIUM]`
**Location:** `server.js:96` (`res.status(404).end()`), also hit from `server.js:82`'s dotfile path.

**Problem.** A user who mistypes a URL or follows a broken asset link gets an **empty white page** — no message, no "go home" link, and nothing for a screen reader (no `lang`, no heading, no text). That's both a UX dead-end and an accessibility failure for the one page the server renders on its own.

**Fix.** Content-negotiated, tiny, accessible 404 (HTML for browsers, JSON otherwise):
```js
function send404(req, res) {
	res.status(404);
	if (req.accepts("html")) {
		res.type("html").send(
			`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
			`<meta name="viewport" content="width=device-width,initial-scale=1">` +
			`<title>404 — Not found</title></head>` +
			`<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
			`<h1>404 — Page not found</h1>` +
			`<p>That page or asset doesn’t exist. <a href="/">Return to the home page</a>.</p>` +
			`</body></html>`
		);
	} else {
		res.json({ error: "not_found" });
	}
}
```
Use `send404(req, res)` at both 404 sites. `viewport` + `lang` + a real heading + a link make it usable on mobile and with a screen reader while staying tiny.

---

### U-02 — No error-handling middleware → default stack-trace page on any thrown error  `[MEDIUM]`
**Location:** end of `server.js` (there is no `(err, req, res, next)` handler) — cross-ref `S-04` (info disclosure).

**Problem.** The file *invites* adding logic in "CUSTOM ROUTES" (`server.js:41-62`). The moment a custom route throws (or calls `next(err)`), Express's default handler responds — and with `NODE_ENV !== 'production'` that response is an **HTML page containing a stack trace**. Ugly for users, and it leaks internal paths/versions.

**Fix.** A final error handler that logs server-side and returns a friendly, accessible page (reuse the U-01 style), never internals:
```js
// register LAST, after all routes and the static handler
app.use((err, req, res, next) => {
	console.error("Unhandled error:", err);
	res.status(500);
	if (req.accepts("html")) {
		res.type("html").send(
			`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
			`<meta name="viewport" content="width=device-width,initial-scale=1">` +
			`<title>500 — Server error</title></head>` +
			`<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
			`<h1>Something went wrong</h1><p>Please try again. <a href="/">Home</a>.</p></body></html>`
		);
	} else {
		res.json({ error: "internal_error" });
	}
});
```

---

### U-03 — `/healthz` is probe-friendly but thin for humans/dashboards  `[LOW]`
**Location:** `server.js:46-48`.

**Problem.** `{ ok: true, uptime }` is fine for a liveness probe but tells an operator eyeballing it (or a status dashboard) nothing about *which* build is running.

**Fix (optional).** Enrich slightly:
```js
res.json({ status: "ok", uptime: process.uptime(), version: process.env.BRAND_VERSION || null });
```

---

### U-04 — Operator DX done well  `[INFO — positives, keep]`
- **Query-string preserved through the redirect** (`server.js:71-72`): links with `?params` survive the clean-URL bounce — correct and user-visible. Keep.
- **Friendly startup log** (`server.js:100`) prints `http://localhost:PORT` when bound to `0.0.0.0` instead of the unclickable `0.0.0.0` — nice touch. Keep.
- **`/config.js` customization path** (`server.js:54-62`) is a genuinely good self-hosting UX: operators inject TURN/signaling/branding via env without editing the frequently-updated client source. Keep (with the `S-08` escaping hardening).

---

## 4. Prioritized Improvement Checklist

1. **[HIGH VALUE] P-01** — Split cache policy: `immutable` 1-year for assets, `no-cache` for HTML + the SPA fallback. Biggest single win. Document the "mutable assets need `?ver=`" prerequisite.
2. **[MEDIUM] U-01 / U-02** — Replace the blank 404 with an accessible content-negotiated page, and add a final error-handling middleware (also closes the `S-04` stack-trace leak).
3. **[MEDIUM] Q-01** — Centralize + validate config in one `config` object (folds in `S-13`).
4. **[MEDIUM] Q-02 / Q-03** — Export `app`, guard `listen` with `require.main`, add ~4 `supertest` smoke tests for the redirect/404/fallback logic (guards the `S-01` regression).
5. **[MEDIUM] P-02** — Precompress `js/css/html/svg` at deploy (brotli q11) and serve the precompressed variants; keep `compression()` as the dynamic fallback. Secondary to P-01.
6. **[LOW] U-03** — Add `status`/`version` to `/healthz`.
7. **[LOW] P-03** — After `S-01` is fixed, consider `301` for the clean-URL redirect.
8. **[INFO] Q-04, P-04** — Named constants, `dev: node --watch`, and a one-line CDN note in the self-hosting docs.

**Sequencing note:** land the `AUDIT_REPORT.md` security fixes first (especially `S-01` open redirect and `S-02` node_modules exposure) — several items here (P-03 `301`, Q-02 tests, U-02 error page) assume those are in place. Then P-01 is the highest-ROI improvement.

---

*No application code was modified in producing this report; the only file written is `IMPROVEMENTS_REPORT.md`. Performance claims were checked against the installed `express@4.22.2` / `compression@1.8.1` behavior and the measured on-disk asset sizes.*
