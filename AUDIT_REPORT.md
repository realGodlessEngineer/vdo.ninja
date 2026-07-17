# Node.js Code Audit Report — VDO.Ninja Express Server

**Audit date:** 2026-07-14
**Scope:** Newly-added Node.js server layer only — `server.js`, `package.json`, `package-lock.json`. Browser-client files (`webrtc.js`, `lib.js`, `main.js`, static `.html` tool pages, translations) are explicitly out of scope.
**Environment used for verification:** Node v22.17.0, deps installed from the committed lockfile, server probed live on `127.0.0.1:8399`.
**Runtime:** Express 4.22.2, compression 1.8.1 (resolved from `^4.21.2` / `^1.7.5`).

---

## 1. Executive Summary

The server is a small, well-commented, single-file static host (102 lines). It is coherent, uses only real and correctly-invoked Express/compression/Node APIs (no hallucinated APIs — every call was exercised live), and its dependency tree is fully patched (`npm audit` = **0 vulnerabilities**). The design intent — mirror the reference Nginx config from `install.md` (wide-open CORS, `/foo.html`→`/foo` redirects, clean URLs, index fallback) — is faithfully implemented, and several safety-relevant details (path-traversal protection, dotfile masking, no CRLF injection, extensionless-404 for missing assets) are handled correctly.

**However, it is not production-ready as written.** The headline issues are:

- **HIGH — Confirmed open redirect (CWE-601).** `GET //evil.com.html` returns `Location: //evil.com`. Verified live. Trivially exploitable on a trusted domain for phishing / link laundering.
- **MEDIUM — Server source and full `node_modules/` tree are served over HTTP.** `GET /server.js`, `/package.json`, `/package-lock.json`, and `/node_modules/**` all return real content. Verified live.
- **MEDIUM — `trust proxy: true` set unconditionally.** Any client can spoof `req.ip` via `X-Forwarded-For`; a latent footgun for any future rate-limiting/IP logging and a real spoof when the server is exposed directly.
- **MEDIUM — No security headers and `X-Powered-By` leaked.** No `X-Content-Type-Options`, `Referrer-Policy`, or HSTS. (Note: `X-Frame-Options`/`frame-ancestors` must deliberately **not** be added — embedding is a first-class feature.)
- **MEDIUM/LOW — Ops gaps:** no `listen` error handling (EADDRINUSE crashes with an unhandled `error` event), no graceful shutdown (SIGTERM/SIGINT), no request logging.

**Readiness verdict:** Ship-blocking on the HIGH open redirect. The MEDIUM items should be fixed before any internet-facing deployment. No CRITICAL issues (no RCE, no auth bypass — there is no auth surface — and no secret exposure). With the checklist in section 4 applied, this becomes a solid, minimal production host.

**Severity tally:** High: 1 · Medium: 4 · Low: 5 · Info: 3

---

## 2. Findings (ordered by severity)

### S-01 — Open redirect via the `.html` → clean-URL rewrite  `[HIGH]  [Security]`
**Location:** `server.js:69-74` (specifically `clean` at `:70` and `res.redirect` at `:73`)

**Problem.** The redirect derives its target purely from `req.path` and does not validate that the result is a local, single-slash-rooted path. Node/Express parse `//host` and `/\host` request targets such that `req.path` begins with `//`, so `clean` becomes a **protocol-relative URL**.

**Verified exploit (live):**
```
GET //evil.com.html      -> 302  Location: //evil.com
GET /\evil.com.html      -> 302  Location: //evil.com     (backslash normalized to //)
GET ///evil.com.html     -> 302  Location: ///evil.com
```
A browser receiving `Location: //evil.com` navigates to `https://evil.com`. Because VDO.Ninja is a trusted domain whose whole purpose is sharing room links, this is a strong phishing / redirect-laundering primitive (e.g. `https://your-vdo-host/​//attacker.example.html`).

**Not affected (also verified):** encoded slashes stay literal (`/%2f%2fevil.com` — safe), and CRLF injection is blocked (`%0d%0a` stays percent-encoded in `Location`, no header splitting). So the fix only needs to defend the `//` / `/\` prefix.

**Fix.** Reject non-local targets and fall through to the static handler (which will 404):
```js
app.get(/\.html$/, (req, res, next) => {
	const clean = req.path.replace(/\.html$/, "");
	// Only redirect to a local, single-slash-rooted path.
	// Blocks //host and /\host protocol-relative open redirects.
	if (!clean.startsWith("/") || clean.startsWith("//") || clean.startsWith("/\\")) {
		return next();
	}
	const queryIndex = req.originalUrl.indexOf("?");
	const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
	res.redirect(302, clean + query);
});
```

---

### S-02 — Server source and full `node_modules/` tree exposed over HTTP  `[MEDIUM]  [Security / Ops]`
**Location:** `server.js:21` (`ROOT = __dirname`) + `server.js:78-84` (`express.static(ROOT, …)`)

**Problem.** The static root is the entire repo directory, so operational/server files are served as real content.

**Verified live:**
```
GET /server.js                              -> 200  application/javascript   (real source, 4051 bytes)
GET /package.json                           -> 200  application/json          (real)
GET /package-lock.json                      -> 200                            (real)
GET /node_modules/express/package.json      -> 200  application/json          (real)
```
Impact: leaks the server's implementation, exact dependency versions (fingerprinting for targeted CVE probing), and exposes the whole `node_modules/` tree as an over-HTTP file surface. The application source is AGPL/public, so this is information-disclosure/hardening rather than secret leakage — but serving `node_modules/` and server internals is not acceptable for a production host.

**Fix.** Add a small denylist before `express.static` (keeps the single-dir layout):
```js
const BLOCKED = new Set(["/server.js", "/package.json", "/package-lock.json"]);
app.use((req, res, next) => {
	if (BLOCKED.has(req.path) || req.path.startsWith("/node_modules/")) {
		return res.status(404).end();
	}
	next();
});
```
**Preferred (structural) alternative:** move the browser client into a dedicated `public/`/`www/` subfolder and point `express.static` there, so server files and `node_modules/` are physically outside the served root. This also removes the need for the denylist.

---

### S-03 — `trust proxy: true` set unconditionally  `[MEDIUM]  [Security]`
**Location:** `server.js:30`

**Problem.** `app.set("trust proxy", true)` trusts **every** upstream hop, so `req.ip` / `req.protocol` are taken from client-supplied `X-Forwarded-*` headers and are fully spoofable. Today there is no IP-based logic, so impact is latent — but it is a footgun: any future rate limiter, IP allowlist, or access log will trust a forged `X-Forwarded-For`. When the server is exposed directly (no proxy), it is an immediate spoof.

**Fix.** Make it explicit and configurable, defaulting to a safe value rather than "trust everyone":
```js
// e.g. TRUST_PROXY="1" (one proxy hop), "loopback", a CIDR, or "false"
const tp = process.env.TRUST_PROXY ?? "loopback";
app.set("trust proxy", tp === "false" ? false : /^\d+$/.test(tp) ? Number(tp) : tp);
```
Document that hosting platforms which put exactly one proxy in front should set `TRUST_PROXY=1`.

---

### S-04 — Missing security headers; `X-Powered-By` disclosed  `[MEDIUM]  [Security]`
**Location:** response middleware region `server.js:36-39`; `X-Powered-By` never disabled (app created `server.js:27`)

**Problem (verified live):** responses carry `X-Powered-By: Express` and **none** of `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`. Absence of `nosniff` combined with serving user-controllable clean URLs and arbitrary repo assets makes MIME-sniffing mistakes more likely.

**Important constraint:** Do **not** add `X-Frame-Options` or a CSP `frame-ancestors` directive. Embedding VDO.Ninja via `<iframe>` is a documented, first-class feature (see `CLAUDE.md` → "IFRAME API"); frame-blocking headers would break OBS Browser Sources and every downstream embedder. A full CSP is also impractical here (the client relies heavily on inline scripts) and is out of scope for this server.

**Fix.** Add the safe subset and drop the fingerprint header:
```js
app.disable("x-powered-by");
app.use((req, res, next) => {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
	// TLS is terminated at the edge; advertise HSTS for the canonical HTTPS host.
	res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
	next();
});
```
(If you adopt `helmet`, initialize it with `frameguard: false` and `contentSecurityPolicy: false` for the same reasons.)

---

### S-05 — No `listen` error handling (EADDRINUSE crashes uncleanly)  `[LOW]  [Ops / Correctness]`
**Location:** `server.js:99-101`

**Problem.** `app.listen(PORT, HOST, cb)` has no `error` listener. On `EADDRINUSE` (or `EACCES` for a privileged port) the server emits an unhandled `'error'` event, producing a raw stack-trace crash instead of a clear message and clean exit code.

**Fix.**
```js
const server = app.listen(PORT, HOST, () => {
	console.log(`VDO.Ninja client serving on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});
server.on("error", (err) => {
	if (err.code === "EADDRINUSE") console.error(`Port ${PORT} is already in use.`);
	else if (err.code === "EACCES") console.error(`Insufficient privileges to bind port ${PORT}.`);
	else console.error("Server failed to start:", err);
	process.exit(1);
});
```

---

### S-06 — No graceful shutdown (SIGTERM/SIGINT)  `[LOW]  [Ops]`
**Location:** `server.js:99-101` (nothing after `listen`)

**Problem.** Container orchestrators and hosting platforms send `SIGTERM` on deploy/scale-down. With no handler, the default action terminates the process immediately, dropping in-flight responses and skipping cleanup.

**Fix.** Add signal handlers that close the server (reuse the `server` handle from S-05):
```js
for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		console.log(`${sig} received — shutting down.`);
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(1), 10_000).unref(); // force-exit safety net
	});
}
```

---

### S-07 — No request logging / observability  `[LOW]  [Ops]`
**Location:** whole file — only the startup line is logged (`server.js:100`)

**Problem.** There is no access logging, so a hosted deployment has no visibility into traffic, 404 rates, or the redirect/fallback behavior in production.

**Fix.** Add a lightweight logger, gated so it stays quiet by default:
```js
// optional dep; or a 5-line inline middleware using res.on('finish')
if (process.env.LOG_REQUESTS === "true") {
	const morgan = require("morgan");
	app.use(morgan("combined"));
}
```
Keep it opt-in to preserve the "minimal, forker-friendly" philosophy noted in `CLAUDE.md`.

---

### S-08 — `/config.js` reflects env vars without JS-safe escaping  `[LOW]  [Security]`
**Location:** `server.js:54-62` (escaping concern at `:61`)

**Problem.** `res.send(\`window.CUSTOM_CONFIG = ${JSON.stringify(config)};\`)` serves operator-supplied env values (`TURN_SERVER`, `SIGNALING_HOST`, `BRAND_NAME`). `JSON.stringify` does not escape `<`, `/`, or the line separators U+2028/U+2029. Because this is delivered as an **external** `application/javascript` resource (not inlined into HTML), the `</script>` breakout does not apply and the values are deploy-time/operator-controlled — so real-world risk is low. It is still worth hardening in case an operator later inlines the output, and to avoid a malformed script if a value contains U+2028/U+2029.

**Fix.**
```js
const json = JSON.stringify(config)
	.replace(/</g, "\\u003c")
	.replace(/ /g, "\\u2028")
	.replace(/ /g, "\\u2029");
res.type("application/javascript");
res.send(`window.CUSTOM_CONFIG = ${json};`);
```

---

### S-09 — Wide-open CORS (`Access-Control-Allow-Origin: *`) on every response  `[LOW]  [Security — mostly by design]`
**Location:** `server.js:36-39`

**Assessment.** For a public, credential-less static client this is **intentional and correct** — it mirrors the reference Nginx config (`install.md:74,82`) and is required for OBS Browser Sources / iframe asset fetches. No cookies or auth are involved, so `*` cannot be abused to read a victim's authenticated data. **Keep it.** Two minor hardening notes for the remediation dev, not blockers:
- It is applied to `/healthz` and `/config.js` too; harmless, but if a future custom route ever returns per-user or private data, exempt it from the blanket `*`.
- The header is set via a global middleware; that is fine. No `Access-Control-Allow-Credentials: true` is present (good — combining it with `*` would be invalid and is correctly avoided).

---

### S-10 — Dotfile/non-file paths return `200 index.html` instead of `404`  `[LOW]  [Correctness]`
**Location:** interaction of `server.js:82` (`dotfiles: "ignore"`) and the SPA fallback `server.js:90-97`

**Problem.** `dotfiles: "ignore"` correctly prevents dotfile **content** from being served — verified: `GET /.gitignore` and `GET /.git/config` return the index.html body, **not** the real files (no leak). But because `path.extname("/.gitignore") === ""` (leading-dot basenames have no extension), these requests fall through to the SPA handler and return **200 index.html**. So a probe for `/.git/config` gets a 200, which is misleading (a scanner may misread it as "exists"). It is a correctness/telemetry wart, not a leak.

**Fix (optional).** Treat dot-prefixed final segments as non-SPA and 404 them:
```js
app.use((req, res) => {
	const base = path.basename(req.path);
	const isDotPath = base.startsWith(".");
	const hasFileExtension = path.extname(req.path) !== "";
	if (req.method === "GET" && !hasFileExtension && !isDotPath && req.accepts("html")) {
		res.sendFile(path.join(ROOT, "index.html"));
	} else {
		res.status(404).end();
	}
});
```

---

### S-11 — `dev` script is identical to `start` (no watch/reload)  `[INFO]  [Clean-code / DX]`
**Location:** `package.json:9-10`

**Problem.** `"dev": "node server.js"` offers no auto-reload, so the two scripts are indistinguishable. Minor developer-experience gap. Since there is no dev dependency policy here, either add `--watch` (Node 18+ supports `node --watch`, matching the declared engine) or document that `dev` is intentionally identical.
```json
"dev": "node --watch server.js"
```

---

### S-12 — `302` (temporary) used for canonical clean-URL redirect  `[INFO]  [Correctness]`
**Location:** `server.js:73`

**Problem.** `/foo.html` → `/foo` is a permanent canonicalization; `301` would let browsers/CDNs cache it. This matches the reference Nginx `return 302` (`install.md:79`), so it is defensible as parity. Flagged only for awareness — switch to `301` if SEO/caching of the canonical form is desired.

---

### S-13 — `PORT`/config env values used without validation  `[INFO]  [Robustness]`
**Location:** `server.js:24-25`

**Problem.** `process.env.PORT || 8366` will pass a string straight to `listen`; an accidental `PORT=0` binds a random port, and a non-numeric value fails deep inside Node with a less-obvious error. Very low impact (operator misconfiguration only). Optional: coerce and validate (`Number.parseInt`, fall back to default on `NaN`).

---

## 3. Positive Notes (do not regress these)

- **No hallucinated APIs.** Every Express/compression/Node call is real and correctly used — verified at runtime: `app.set("trust proxy", …)`, `compression()`, `app.get(/regex/)`, `res.redirect(status, path)`, `express.static` with `extensions`/`index`/`dotfiles`, `res.type`, `res.sendFile`, `req.accepts`, `path.extname`.
- **Path traversal is not exploitable.** Static serving goes through `serve-static`/`send`, which normalizes and rejects `..`; the custom fallback only ever sends a fixed `index.html`. No user-controlled path reaches the filesystem.
- **Dotfiles are not leaked.** `dotfiles: "ignore"` verified — `.gitignore` / `.git/config` do not return real content.
- **No CRLF/header-injection in the redirect.** `%0d%0a` in the path stays percent-encoded in `Location` (verified) — no response splitting.
- **Encoded-slash open redirect is not possible.** `%2f%2fevil.com` stays literal (verified); only the raw `//`/`\` prefix (S-01) is the gap.
- **Missing assets correctly 404.** Extensioned requests that don't resolve return `404` rather than masking failures with a `200` HTML page (verified: `/does-not-exist.js` → 404) — this is a deliberately good design choice; keep it.
- **Compression is correct.** `Vary: Accept-Encoding` + `Content-Encoding: gzip` verified; big client assets (`lib.js`, `webrtc.js`) benefit substantially.
- **Dependencies are current and clean.** `npm audit` = 0 vulnerabilities; pins include the ReDoS-patched `path-to-regexp@0.1.13`, `qs@6.15.3`, `body-parser@1.20.5`, `send@0.19.2`, `serve-static@1.16.3`.
- **Correct module hygiene.** `"type": "commonjs"` with `require`, `engines.node >=18`, custom routes registered before the static handler (correct precedence), and clear, accurate comments throughout.
- **Method handling is sane.** `POST /mixer.html` and `POST /someRoom` both return `404` (verified); `HEAD` correctly follows the GET redirect.

---

## 4. Prioritized Remediation Checklist

1. **[HIGH] S-01** — Guard the `.html` redirect against `//` / `/\` targets (open redirect). *Blocks release.*
2. **[MEDIUM] S-02** — Stop serving `server.js`, `package.json`, `package-lock.json`, and `node_modules/` (denylist, or move client into a `public/` subfolder).
3. **[MEDIUM] S-03** — Make `trust proxy` explicit/configurable; stop trusting all hops by default.
4. **[MEDIUM] S-04** — Add `nosniff` + `Referrer-Policy` (+ HSTS behind TLS), `app.disable("x-powered-by")`. **Do not** add `X-Frame-Options`/`frame-ancestors` (breaks embedding).
5. **[LOW] S-05 / S-06** — Add `listen` `error` handling (EADDRINUSE) and SIGTERM/SIGINT graceful shutdown (capture the `server` handle once for both).
6. **[LOW] S-08** — JS-escape `<` and U+2028/U+2029 in `/config.js`.
7. **[LOW] S-07** — Add opt-in request logging (`LOG_REQUESTS`).
8. **[LOW] S-10** — 404 dot-prefixed paths instead of returning `200 index.html`.
9. **[INFO] S-09, S-11, S-12, S-13** — Awareness/nice-to-have: keep CORS `*` (by design), differentiate `dev` (`--watch`), consider `301`, validate `PORT`.
10. **Verification after fixes:** re-run the S-01/S-02 probes (`GET //evil.com.html`, `GET /server.js`, `GET /node_modules/express/package.json`), confirm `npm audit` stays clean, and manually smoke-test that iframe embedding still works (no frame-blocking header regressions).

---

*Verification note: all "verified live" statements were produced by running `server.js` locally (Node 22.17.0) and probing with `curl --path-as-is`. No application code was modified during this audit; the only file written is this report.*
