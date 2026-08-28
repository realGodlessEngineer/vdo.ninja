#!/usr/bin/env node
// scripts/install-longpipe-assets.mjs
//
// One-time, idempotent installer for the Longpipe + MediaPipe segmentation assets
// that power the background blur / virtual greenscreen / virtual background effects
// (effects=3/4/5/16). These ~139 MiB of model weights + wasm are intentionally NOT
// committed to git (see .gitignore) — they live on a Coolify persistent volume.
//
// Coolify setup: mount persistent volumes at these paths (relative to the app root
// that server.js serves via express.static(ROOT)):
//     thirdparty/longpipe
//     thirdparty/mediapipe
// then set INSTALL_LONGPIPE_ASSETS=true so server.js runs this automatically, in
// the background, at container start. Persistent volumes are only mounted at
// runtime -- never during the nixpacks build -- so provisioning has to happen at
// boot, not at build time. You can also run it by hand at any point. It is safe
// to run on every deploy: a stamp file (thirdparty/longpipe/.installed-pin)
// records the pinned commit, so a boot where the assets are already present for
// the current PIN does no network I/O at all and returns immediately. It
// re-downloads only when files are missing/corrupt, or when PIN below is bumped
// to a newer version.
//
// The assets are pulled from the upstream vdo.ninja repo pinned to a fixed commit,
// each verified by byte size (and by sha256 for the Longpipe model weights, whose
// hashes are published in the Longpipe manifest.json).
//
// Requires Node 18+ (global fetch). Usage:
//     node scripts/install-longpipe-assets.mjs [--force]
// Env overrides:
//     LONGPIPE_SOURCE_BASE  raw download base URL (default: upstream GitHub @ PIN)
//     LONGPIPE_ASSET_ROOT   destination root (default: repo root)

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "steveseguin/vdo.ninja";
const PIN = "4542e4bb2cfafb77e6ad20337126f44fa2b71c9f"; // upstream/develop @ Longpipe integration
const SOURCE_BASE = process.env.LONGPIPE_SOURCE_BASE || `https://raw.githubusercontent.com/${REPO}/${PIN}`;
const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/${PIN}?recursive=1`;
const ASSET_ROOT = process.env.LONGPIPE_ASSET_ROOT || resolve(fileURLToPath(import.meta.url), "..", "..");
const ASSET_PREFIXES = ["thirdparty/longpipe/", "thirdparty/mediapipe/"];
const MANIFEST_PATH = "thirdparty/longpipe/models/v/0.0.4/manifest.json";
// A stamp recording the PIN we last fully installed, kept inside the longpipe
// persistent volume so it survives redeploys. When it matches PIN and the
// sentinel files below all exist, install is a no-op with zero network I/O --
// this is what makes the server.js boot-time run instant (and offline-safe) on
// every deploy after the first. Bumping PIN invalidates it and forces a refresh.
const STAMP_PATH = "thirdparty/longpipe/.installed-pin";
const SENTINELS = ["thirdparty/longpipe/longpipe.mjs", MANIFEST_PATH, "thirdparty/mediapipe/models/selfie_segmenter_landscape_float16.tflite"];
const FORCE = process.argv.includes("--force");
const UA = { "User-Agent": "vdo-ninja-longpipe-installer" };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function listAssets() {
	const res = await fetch(TREE_API, { headers: { ...UA, Accept: "application/vnd.github+json" } });
	if (!res.ok) throw new Error(`GitHub tree API ${res.status} ${res.statusText}`);
	const json = await res.json();
	if (json.truncated) console.warn("WARNING: GitHub truncated the tree listing; some assets may be missing.");
	return json.tree
		.filter((e) => e.type === "blob" && ASSET_PREFIXES.some((p) => e.path.startsWith(p)))
		.map((e) => ({ path: e.path, size: e.size }));
}

async function sourceManifestHashes() {
	try {
		const res = await fetch(`${SOURCE_BASE}/${MANIFEST_PATH}`, { headers: UA });
		if (!res.ok) return {};
		const manifest = JSON.parse(await res.text());
		const map = {};
		for (const f of manifest.files || []) {
			if (f.sha256) map[`thirdparty/longpipe/models/v/0.0.4/${f.name}`] = f.sha256;
		}
		return map;
	} catch {
		return {};
	}
}

async function isValid(dest, size, wantHash) {
	if (FORCE || !existsSync(dest)) return false;
	const s = await stat(dest);
	if (typeof size === "number" && s.size !== size) return false;
	if (wantHash && sha256(await readFile(dest)) !== wantHash) return false;
	return true;
}

// Fast path for the server.js boot-time run: if the stamp matches the current
// PIN and the sentinels are present, everything is already installed -- return
// without touching the network, so a warm redeploy (or an offline box) is
// instant. Any missing stamp/sentinel falls through to the full reconcile below.
async function alreadyInstalled() {
	if (FORCE) return false;
	let stamped;
	try {
		stamped = (await readFile(join(ASSET_ROOT, STAMP_PATH), "utf8")).trim();
	} catch {
		return false; // no stamp -> never fully installed (or first run)
	}
	if (stamped !== PIN) return false;
	for (const rel of SENTINELS) {
		const p = join(ASSET_ROOT, rel);
		if (!existsSync(p)) return false;
		try {
			if ((await stat(p)).size === 0) return false;
		} catch {
			return false;
		}
	}
	return true;
}

async function download(path) {
	const res = await fetch(`${SOURCE_BASE}/${path}`, { headers: UA });
	if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
	return Buffer.from(await res.arrayBuffer());
}

async function main() {
	console.log(`Longpipe/MediaPipe asset install`);
	console.log(`  root:   ${ASSET_ROOT}`);
	console.log(`  source: ${SOURCE_BASE}`);
	if (await alreadyInstalled()) {
		console.log(`  already installed for pin ${PIN.slice(0, 12)} -- skipping (no network).`);
		return;
	}
	const [assets, hashes] = await Promise.all([listAssets(), sourceManifestHashes()]);
	let got = 0,
		skipped = 0,
		bytes = 0;
	for (const { path, size } of assets) {
		const dest = join(ASSET_ROOT, path);
		const wantHash = hashes[path];
		if (await isValid(dest, size, wantHash)) {
			skipped++;
			continue;
		}
		const buf = await download(path);
		if (typeof size === "number" && buf.length !== size) throw new Error(`${path}: size ${buf.length} != expected ${size}`);
		if (wantHash && sha256(buf) !== wantHash) throw new Error(`${path}: sha256 mismatch`);
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, buf);
		got++;
		bytes += buf.length;
		console.log(`  + ${path} (${(buf.length / 1048576).toFixed(2)} MiB)`);
	}
	// Stamp the successful install so the next boot can take the no-network fast
	// path above. Reached only when every asset verified, since any failure throws.
	await mkdir(dirname(join(ASSET_ROOT, STAMP_PATH)), { recursive: true });
	await writeFile(join(ASSET_ROOT, STAMP_PATH), `${PIN}\n`);
	console.log(`Done: ${got} downloaded, ${skipped} already valid, ${(bytes / 1048576).toFixed(1)} MiB fetched.`);
}

main().catch((err) => {
	console.error("Install failed:", err.message);
	process.exit(1);
});
