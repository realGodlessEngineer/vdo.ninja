"use strict";

/*
 * Deploy-time precompression (F14).
 *
 * server.js's `app.use(compression())` already brotli/gzip-compresses every
 * response on the fly, but it does so on every cache miss at a low quality
 * setting (brotli quality 4) to keep request latency low. This script walks
 * the repo ONCE, offline, and writes maximum-quality brotli (quality 11) and
 * gzip (level 9) siblings -- "<file>.br" and "<file>.gz" -- next to each
 * compressible text asset. server.js's precompressed-asset middleware serves
 * those bytes directly when a client's Accept-Encoding allows it, removing
 * the per-request compression CPU cost and shrinking the largest assets
 * (lib.js, webrtc.js, main.js, main.css) another ~10-15% over quality 4.
 *
 * Dependency-free by design (see CLAUDE.md: this project intentionally adds
 * no npm dependencies, since package.json is gitignored and every forker
 * re-derives it) -- only Node's built-in fs/path/zlib.
 *
 * Run via `npm run precompress` (or `node scripts/precompress.js`) as a
 * deploy step, after pulling client files and before starting the server.
 * The generated .br/.gz files are gitignored (see .gitignore) -- they're
 * build artifacts, not source, and would silently go stale the moment their
 * source file changes if anyone forgot to regenerate and commit them, so
 * they're deliberately never committed at all.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");

// Directories never worth walking: the dependency tree, gitignored internal
// audit docs, VCS internals, and this script's own directory. Matched by
// exact directory name so it applies at any depth, even though today each of
// these only exists once, directly under ROOT. "scripts" must stay in sync
// with server.js's BLOCKED_PREFIXES (which blocks "/scripts/" for the same
// reason it blocks "/node_modules/" and "/docs/") -- there's no point
// generating a .br/.gz sibling for a file the server will never serve.
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "docs", ".git", "scripts"]);

// Extensions worth precompressing: the client's own text assets. This is an
// ALLOWLIST, not a "skip known-binary extensions" denylist -- deliberately,
// because the repo also ships many binary/already-compressed asset types
// (images, fonts, video, wasm, minified vendor bundles with embedded binary
// data) that a denylist could easily miss and silently corrupt by
// "compressing" already-compressed bytes for no gain. `.json` is included:
// translations/*.json, presets.json, and the face-filter neural-net weights
// under thirdparty/jeeliz/neuralNets/ are all plain-text JSON fetched at
// runtime by lib.js/filters code, and compress just as well as any other
// text asset. This list is intentionally mirrored by
// PRECOMPRESSED_CONTENT_TYPES's keys in server.js -- keep the two in sync.
const COMPRESSIBLE_EXTENSIONS = new Set([".js", ".css", ".html", ".svg", ".json"]);

// Mirrors server.js's BLOCKED_EXACT (F2) -- these are server internals/ops
// files that must never be served, so there's no reason to spend deploy time
// compressing them or to leave a .br/.gz copy sitting on disk whose only
// protection against being served would be middleware ordering in a
// different file. Matched against the file's path RELATIVE TO ROOT (with
// forward slashes, lowercased) -- exact-match only, same semantics as
// server.js's BLOCKED_EXACT -- so this only skips these files at the repo
// root, not an unrelated same-named file nested elsewhere. node_modules/,
// docs/, and .git/ are already excluded above via EXCLUDED_DIR_NAMES, which
// covers the rest of BLOCKED_EXACT/BLOCKED_PREFIXES's directory entries.
// Keep this list in sync with server.js's BLOCKED_EXACT if that ever changes.
const NEVER_COMPRESS = new Set(["server.js", "package.json", "package-lock.json", "audit_report.md", "improvements_report.md"]);

// Below this, the two extra files on disk and the fixed per-stream framing
// overhead of brotli/gzip cost more than the savings are worth -- a few
// bytes of container overhead can even make a "compressed" file bigger than
// a very small original. 1 KiB is the conventional floor (nginx's
// gzip_min_length defaults to a permissive 20 bytes, but 1024+ is the
// commonly recommended threshold in practice); every asset that actually
// matters for this task (lib.js, webrtc.js, main.js, main.css, and the rest
// of the JS/CSS/HTML/SVG/JSON graph) is far above it, so this only ever
// skips the many trivially small files where precompression wouldn't help.
const MIN_SIZE_BYTES = 1024;

function brotliOptionsFor(size) {
	return {
		params: {
			// 11 is zlib.constants.BROTLI_MAX_QUALITY -- maximum compression,
			// deploy-time only. The on-the-fly compression() middleware in
			// server.js stays at its default quality 4 for cache misses; this
			// script is the one place quality 11 is worth paying for, since it
			// runs once per deploy instead of once per request.
			[zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
			[zlib.constants.BROTLI_PARAM_SIZE_HINT]: size
		}
	};
}

// Z_BEST_COMPRESSION is 9 -- named instead of hardcoded so the intent ("the
// best gzip offers") stays obvious without a magic number.
const GZIP_OPTIONS = { level: zlib.constants.Z_BEST_COMPRESSION };

function shouldSkipDir(dirName) {
	// Dot-directories (.github, .vscode, .claude, ...) never contain files
	// this server would ever serve -- server.js's own SPA fallback 404s any
	// dot-prefixed path segment (F13) -- so precompressing inside them would
	// only waste deploy time.
	return dirName.startsWith(".") || EXCLUDED_DIR_NAMES.has(dirName);
}

function isCompressible(fullPath) {
	if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) {
		return false;
	}
	const relativePath = path.relative(ROOT, fullPath).replace(/\\/g, "/").toLowerCase();
	return !NEVER_COMPRESS.has(relativePath);
}

// Recursively collects every compressible, large-enough source file under
// `dir`. Synchronous and eager (not streamed/async) on purpose: this only
// ever runs as a one-shot deploy step, never inside a request handler, so
// there's no event loop to protect. Previous runs' own ".br"/".gz" output is
// never revisited or recompressed because those extensions were never added
// to COMPRESSIBLE_EXTENSIONS -- it's an allowlist, so nothing extra is
// needed to exclude them.
function collectFiles(dir, results) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		console.error(`Skipping unreadable directory ${dir}: ${err.message}`);
		return results;
	}

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			if (!shouldSkipDir(entry.name)) {
				collectFiles(fullPath, results);
			}
			continue;
		}

		if (!entry.isFile() || !isCompressible(fullPath)) {
			continue;
		}

		const { size } = fs.statSync(fullPath);
		if (size >= MIN_SIZE_BYTES) {
			results.push({ fullPath, size });
		}
	}

	return results;
}

function formatKiB(bytes) {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

function precompressFile(fullPath) {
	const source = fs.readFileSync(fullPath);
	const brotli = zlib.brotliCompressSync(source, brotliOptionsFor(source.length));
	const gzip = zlib.gzipSync(source, GZIP_OPTIONS);
	fs.writeFileSync(`${fullPath}.br`, brotli);
	fs.writeFileSync(`${fullPath}.gz`, gzip);
	return { originalSize: source.length, brotliSize: brotli.length, gzipSize: gzip.length };
}

function main() {
	const startedAt = Date.now();
	const files = collectFiles(ROOT, []);

	let totalOriginal = 0;
	let totalBrotli = 0;
	let totalGzip = 0;
	let failures = 0;

	for (const { fullPath } of files) {
		try {
			const result = precompressFile(fullPath);
			totalOriginal += result.originalSize;
			totalBrotli += result.brotliSize;
			totalGzip += result.gzipSize;
		} catch (err) {
			failures++;
			console.error(`Failed to precompress ${fullPath}: ${err.message}`);
		}
	}

	const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
	const brotliSavingsPercent = totalOriginal > 0 ? (100 - (totalBrotli / totalOriginal) * 100).toFixed(1) : "0.0";
	const gzipSavingsPercent = totalOriginal > 0 ? (100 - (totalGzip / totalOriginal) * 100).toFixed(1) : "0.0";

	console.log(`Precompressed ${files.length - failures}/${files.length} file(s) in ${elapsedSeconds}s`);
	console.log(`  original:   ${formatKiB(totalOriginal)}`);
	console.log(`  brotli q11: ${formatKiB(totalBrotli)} (-${brotliSavingsPercent}%)`);
	console.log(`  gzip -9:    ${formatKiB(totalGzip)} (-${gzipSavingsPercent}%)`);

	if (failures > 0) {
		console.error(`${failures} file(s) failed to precompress -- see errors above.`);
		process.exitCode = 1;
	}
}

main();
