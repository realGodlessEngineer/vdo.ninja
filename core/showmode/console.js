// Show-mode director console — Phase 2 (read-only lane layout).
//
// Reorganises the flat #guestFeeds control-box list into three role lanes
// (On Air / On Deck / Green Room) backed by the legacy group model, and paints
// status-driven colour (talking / live / connection quality) in place of the
// room colour. This is READ-ONLY: it moves and decorates the existing legacy
// control boxes but never mutates group membership — promote/demote is Phase 3.
//
// It touches no legacy source. The only legacy-side hook is `session.showmode`
// (set from `&showmode` in main.js); everything here reads live state through
// the session bridge and the core audio-level bus.

import { waitForLegacySession } from "../legacy/session-bridge.js";
import { levelBus, LEVEL_EVENT } from "../events/level-bus.js";

const RECONCILE_MS = 500; // lane placement + status refresh cadence
const TALK_METER_THRESHOLD = 15; // legacy voiceMeter dataset.level scale (0..100); matches lib.js opacity gate
const TALK_BUS_THRESHOLD = 0.05; // core level bus magnitude gate (best-effort; bus is usually idle on the console)
const LEVEL_TTL_MS = 500; // how long a level-bus sample counts as "recent"

// The three lanes, in placement-priority order. `group` is the canonical group
// name a guest carries to land in the lane; the labels resolve through i18n.
const LANES = [
	{ key: "onair", group: "onair", labelKey: "showmode-lane-onair", fallback: "On Air" },
	{ key: "ondeck", group: "ondeck", labelKey: "showmode-lane-ondeck", fallback: "On Deck" },
	{ key: "green", group: "green", labelKey: "showmode-lane-green", fallback: "Green Room" }
];
const DEFAULT_LANE = "green"; // guests in none of the three lane groups hold here

const laneBodies = new Map(); // lane key -> the DOM element boxes live in
const recentLevels = new Map(); // UUID -> { v, t } most recent core level-bus sample
let consoleEl = null;
let feedObserver = null;
let reconcileTimer = null;
let started = false;

export async function startShowmodeConsole() {
	if (started) {
		return;
	}
	started = true;

	// The console only makes sense once the legacy session exists; the director
	// UI (#guestFeeds) may still be building, so the reconcile loop self-heals
	// until it appears rather than blocking on it here.
	try {
		await waitForLegacySession({ timeoutMs: 15000 });
	} catch (error) {
		console.warn("[showmode] legacy session never arrived; console idle", error);
		return;
	}

	injectStyles();
	subscribeLevels();

	reconcile();
	reconcileTimer = setInterval(reconcile, RECONCILE_MS);
}

// Resolve an i18n string, preferring the real translation and falling back to a
// clean English literal (getTranslation degrades to a de-hyphenated key).
function translate(key, fallback) {
	try {
		if (typeof window.getTranslation === "function") {
			const value = window.getTranslation(key);
			if (value && value !== key.split("-").join(" ")) {
				return value;
			}
		}
	} catch (error) {
		/* fall through to literal */
	}
	return fallback;
}

function subscribeLevels() {
	try {
		levelBus.on(LEVEL_EVENT, payload => {
			if (!payload || payload.uuid == null) {
				return;
			}
			const magnitude = pickLevelMagnitude(payload);
			recentLevels.set(payload.uuid, { v: magnitude, t: performance.now() });
		});
	} catch (error) {
		console.warn("[showmode] level bus subscription failed", error);
	}
}

// The worklet payload shape varies; take whatever magnitude field is present.
function pickLevelMagnitude(payload) {
	if (typeof payload.peak === "number") {
		return payload.peak;
	}
	if (typeof payload.rms === "number") {
		return payload.rms;
	}
	if (typeof payload.level === "number") {
		return payload.level;
	}
	if (typeof payload.value === "number") {
		return payload.value;
	}
	return 0;
}

// Build the lane scaffold once and splice it in just before #guestFeeds. Returns
// false until the director UI exists, so callers can retry on the next tick.
function ensureLanes() {
	if (consoleEl && consoleEl.isConnected) {
		return true;
	}
	const guestFeeds = document.getElementById("guestFeeds");
	if (!guestFeeds || !guestFeeds.parentNode) {
		return false;
	}

	consoleEl = document.createElement("div");
	consoleEl.id = "showmodeConsole";
	consoleEl.className = "sm-console";

	laneBodies.clear();
	LANES.forEach(lane => {
		const laneEl = document.createElement("section");
		laneEl.className = "sm-lane sm-lane--" + lane.key;
		laneEl.dataset.lane = lane.key;

		const head = document.createElement("div");
		head.className = "sm-lane__head";
		const title = document.createElement("span");
		title.className = "sm-lane__title";
		title.textContent = translate(lane.labelKey, lane.fallback);
		const count = document.createElement("span");
		count.className = "sm-lane__count";
		count.textContent = "0";
		head.appendChild(title);
		head.appendChild(count);

		const body = document.createElement("div");
		body.className = "sm-lane__body";
		body.dataset.lane = lane.key;

		laneEl.appendChild(head);
		laneEl.appendChild(body);
		consoleEl.appendChild(laneEl);
		laneBodies.set(lane.key, body);
	});

	guestFeeds.parentNode.insertBefore(consoleEl, guestFeeds);
	document.body.classList.add("showmode-active");

	// Relocate boxes the legacy code appends to #guestFeeds as guests join.
	feedObserver = new MutationObserver(() => reconcile());
	feedObserver.observe(guestFeeds, { childList: true });

	return true;
}

// One full pass: adopt stray boxes, re-place moved ones, prune the departed,
// repaint status, and refresh lane counts.
function reconcile() {
	const session = window.session;
	if (!session) {
		return;
	}
	if (!ensureLanes()) {
		return;
	}

	// 1) Adopt any control boxes currently sitting in #guestFeeds.
	const guestFeeds = document.getElementById("guestFeeds");
	if (guestFeeds) {
		Array.prototype.slice.call(guestFeeds.children).forEach(child => {
			if (isControlBox(child)) {
				placeBox(child, session);
			}
		});
	}

	// 2) Walk the boxes already in lanes: prune the departed, re-place on a lane
	//    change, and repaint status.
	laneBodies.forEach(body => {
		Array.prototype.slice.call(body.children).forEach(box => {
			if (!isControlBox(box)) {
				return;
			}
			if (isDeadBox(box, session)) {
				if (box.parentNode) {
					box.parentNode.removeChild(box);
				}
				return;
			}
			if (body.dataset.lane !== laneForBox(box, session)) {
				placeBox(box, session);
			}
			updateBoxStatus(box, session);
		});
	});

	updateLaneCounts();
}

function isControlBox(el) {
	return !!(el && el.id && el.id.indexOf("container_") === 0);
}

// A guest box whose peer is gone (e.g. after a legacy guestFeeds reset) is
// stale and pruned. Director/screenshare-of-director anchors are never dead.
function isDeadBox(box, session) {
	const id = box.id || "";
	if (id === "container_director" || id === "container_screen_director") {
		return false;
	}
	const uuid = boxUUID(box);
	if (!uuid) {
		return false; // unknown child — leave it alone rather than risk a wrong prune
	}
	return !(session.rpcs && session.rpcs[uuid]);
}

function boxUUID(box) {
	if (box.dataset && box.dataset.UUID) {
		return box.dataset.UUID;
	}
	return box.UUID || null;
}

// Decide the lane for a control box: director + co-directors anchor On Air; a
// guest follows its group (onair > ondeck > green), defaulting to Green Room.
// A screenshare box (`<uuid>_screen`) follows its owner.
function laneForBox(box, session) {
	const id = box.id || "";
	if (id === "container_director" || id === "container_screen_director") {
		return "onair";
	}

	const rawUUID = boxUUID(box);
	if (!rawUUID) {
		return DEFAULT_LANE;
	}
	let ownerUUID = rawUUID;
	if (typeof ownerUUID === "string" && ownerUUID.endsWith("_screen")) {
		ownerUUID = ownerUUID.slice(0, -"_screen".length);
	}

	const directorList = Array.isArray(session.directorList) ? session.directorList : [];
	if (directorList.indexOf(ownerUUID) !== -1 || directorList.indexOf(rawUUID) !== -1) {
		return "onair";
	}

	const rpc = session.rpcs ? session.rpcs[ownerUUID] || session.rpcs[rawUUID] : null;
	const groups = rpc && Array.isArray(rpc.group) ? rpc.group : [];
	for (let i = 0; i < LANES.length; i++) {
		if (groups.indexOf(LANES[i].group) !== -1) {
			return LANES[i].key;
		}
	}
	return DEFAULT_LANE;
}

function placeBox(box, session) {
	const body = laneBodies.get(laneForBox(box, session));
	if (body && box.parentNode !== body) {
		body.appendChild(box);
	}
}

// Paint the three status signals as classes on the box, non-destructively —
// the legacy room-colour logic is left untouched underneath.
function updateBoxStatus(box, session) {
	const uuid = boxUUID(box);
	const rpc = uuid && session.rpcs ? session.rpcs[uuid] : null;

	box.classList.toggle("sm-talking", isTalking(uuid, rpc));
	box.classList.toggle("sm-live", isLive(box));

	const quality = connectionQuality(rpc);
	box.classList.remove("sm-q-good", "sm-q-warn", "sm-q-bad");
	if (quality) {
		box.classList.add("sm-q-" + quality);
	}
}

function isTalking(uuid, rpc) {
	// Primary (when the podcast meter feeds it): the core level bus.
	if (uuid && recentLevels.has(uuid)) {
		const sample = recentLevels.get(uuid);
		if (performance.now() - sample.t < LEVEL_TTL_MS && sample.v > TALK_BUS_THRESHOLD) {
			return true;
		}
	}
	// Fallback (the reliable director-side signal): the legacy voice meter, which
	// updates live whenever no scene is active — i.e. on the console.
	if (rpc && rpc.voiceMeter && rpc.voiceMeter.dataset) {
		const level = parseFloat(rpc.voiceMeter.dataset.level);
		if (!isNaN(level) && level > TALK_METER_THRESHOLD) {
			return true;
		}
	}
	return false;
}

// "Live" = the guest is pushed to an active program scene, read from a pressed
// scene control inside the box. Absent that UI, no highlight (graceful).
function isLive(box) {
	try {
		return !!box.querySelector(
			'[data-action-type*="scene"].pressed, [data-action-type*="Scene"].pressed, [data-scene].pressed, [data-action-type*="scene"][data-state="1"], [data-action-type*="Scene"][data-state="1"]'
		);
	} catch (error) {
		return false;
	}
}

// Map the legacy 0..5 signal-meter bars to a coarse quality band.
function connectionQuality(rpc) {
	if (!rpc || !rpc.signalMeter || !rpc.signalMeter.dataset) {
		return "";
	}
	const bars = parseInt(rpc.signalMeter.dataset.level, 10);
	if (isNaN(bars)) {
		return "";
	}
	if (bars >= 4) {
		return "good";
	}
	if (bars >= 2) {
		return "warn";
	}
	if (bars >= 1) {
		return "bad";
	}
	return "";
}

function updateLaneCounts() {
	if (!consoleEl) {
		return;
	}
	laneBodies.forEach((body, key) => {
		let n = 0;
		Array.prototype.slice.call(body.children).forEach(child => {
			if (isControlBox(child)) {
				n += 1;
			}
		});
		const count = consoleEl.querySelector('.sm-lane--' + key + ' .sm-lane__count');
		if (count) {
			count.textContent = String(n);
		}
	});
}

function injectStyles() {
	if (document.getElementById("showmode-console-styles")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "showmode-console-styles";
	style.textContent = CONSOLE_CSS;
	document.head.appendChild(style);
}

// Scoped to #showmodeConsole so nothing leaks into the default UI. Colours lean
// on main.css custom properties, with literal fallbacks for older themes.
const CONSOLE_CSS = `
#showmodeConsole.sm-console {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 10px;
	box-sizing: border-box;
	width: 100%;
}
#showmodeConsole .sm-lane {
	border: 1px solid rgba(255, 255, 255, 0.08);
	border-radius: 8px;
	background: var(--container-color, #373737);
	overflow: hidden;
}
#showmodeConsole .sm-lane__head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 6px 12px;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	font-size: 0.82em;
	color: var(--discord-text, #dcddde);
	border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
#showmodeConsole .sm-lane__count {
	min-width: 1.6em;
	text-align: center;
	padding: 1px 8px;
	border-radius: 999px;
	background: rgba(0, 0, 0, 0.25);
	font-variant-numeric: tabular-nums;
}
#showmodeConsole .sm-lane__body {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	padding: 10px;
	min-height: 64px;
	align-content: flex-start;
}
#showmodeConsole .sm-lane__body:empty::after {
	content: "";
	display: block;
	width: 100%;
	min-height: 44px;
	border: 1px dashed rgba(255, 255, 255, 0.12);
	border-radius: 6px;
}
#showmodeConsole .sm-lane--onair { border-left: 4px solid var(--darktheme-red, rgb(161, 45, 45)); }
#showmodeConsole .sm-lane--ondeck { border-left: 4px solid var(--darktheme-yellow, rgb(84, 70, 9)); }
#showmodeConsole .sm-lane--green { border-left: 4px solid var(--darktheme-green, rgb(36, 88, 49)); }

/* Status colouring on the existing control boxes, overriding room colour. */
#showmodeConsole .vidcon { position: relative; }
#showmodeConsole .vidcon.sm-talking {
	outline: 2px solid #37d67a;
	outline-offset: -2px;
	box-shadow: 0 0 8px rgba(55, 214, 122, 0.55);
}
#showmodeConsole .vidcon.sm-live {
	box-shadow: 0 0 0 2px var(--darktheme-red, rgb(161, 45, 45)), 0 0 10px rgba(220, 60, 60, 0.6);
}
#showmodeConsole .vidcon.sm-talking.sm-live {
	box-shadow: 0 0 0 2px var(--darktheme-red, rgb(161, 45, 45)), 0 0 8px rgba(55, 214, 122, 0.55);
}
#showmodeConsole .vidcon.sm-q-good::before,
#showmodeConsole .vidcon.sm-q-warn::before,
#showmodeConsole .vidcon.sm-q-bad::before {
	content: "";
	position: absolute;
	top: 6px;
	left: 6px;
	width: 9px;
	height: 9px;
	border-radius: 50%;
	z-index: 30;
	box-shadow: 0 0 4px rgba(0, 0, 0, 0.6);
}
#showmodeConsole .vidcon.sm-q-good::before { background: #37d67a; }
#showmodeConsole .vidcon.sm-q-warn::before { background: #e0a63a; }
#showmodeConsole .vidcon.sm-q-bad::before { background: #d64545; }

/* The now-empty legacy list is kept as the legacy append target but hidden. */
body.showmode-active #guestFeeds:empty { display: none; }
`;
