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

// Phase 3 — promote/demote. The canonical lane groups a caller is moved between,
// and the default program scene the "On Air" action pushes a guest into.
const LANE_GROUPS = ["onair", "ondeck", "green"];
const PROGRAM_SCENE = "0";

// Lane-action buttons. The label resolves through i18n; the fallback is the base-
// JSON English, so behaviour is identical with or without translations loaded.
// `scene` marks whether the action also puts the guest on the program scene.
const LANE_ACTIONS = [
	{ cls: "sm-btn--onair", group: "onair", labelKey: "showmode-action-onair", fallback: "Take On Air", scene: true },
	{ cls: "sm-btn--ondeck", group: "ondeck", labelKey: "showmode-action-ondeck", fallback: "Hold On Deck", scene: false },
	{ cls: "sm-btn--green", group: "green", labelKey: "showmode-action-green", fallback: "To Green Room", scene: false }
];

// Phase 4 — caller-facing source. Two states: "none" (no second stream) and
// "screen" (the composite, published as the director's screenshare :s stream).
// "screen" is the only publishing option because it rides the existing, proven
// screenshare machinery; a native camera/media second-stream picker is the wider
// Path-B work deferred past this phase.
const SOURCE_OPTS = [
	{ key: "none", labelKey: "showmode-source-none", fallback: "None" },
	{ key: "screen", labelKey: "showmode-source-screen", fallback: "Screen / Composite" }
];

const laneBodies = new Map(); // lane key -> the DOM element boxes live in
const recentLevels = new Map(); // UUID -> { v, t } most recent core level-bus sample
const firstSeen = new Map(); // UUID -> performance.now() when the console first saw the guest
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

	// Phase 4 — the caller-facing source bar sits above the lanes.
	buildSourceBar(consoleEl);

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
				const goneUUID = boxUUID(box);
				if (goneUUID) {
					recentLevels.delete(goneUUID);
					firstSeen.delete(goneUUID);
				}
				if (box.parentNode) {
					box.parentNode.removeChild(box);
				}
				return;
			}
			if (body.dataset.lane !== laneForBox(box, session)) {
				placeBox(box, session);
			}
			updateBoxStatus(box, session);
			if (isGuestBox(box, session)) {
				ensureBoxControls(box, session);
				refreshBoxControls(box, session);
			}
		});
	});

	updateLaneCounts();
	refreshSourceBar(session);
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

// ---- Phase 3: promote / demote interactions -------------------------------
//
// The lane-action bar drives the *existing* legacy controls rather than
// re-implementing them: group membership through `changeGroup()`, program-scene
// membership through `directEnable()`, and hang-up through the box's own hangup
// button (so its native confirm-with-block dialog is reused). Controls attach
// only to real caller boxes — never the director, co-directors, or screenshare
// tiles, which are structurally anchored On Air.

function isGuestBox(box, session) {
	const id = box.id || "";
	if (id === "container_director" || id === "container_screen_director") {
		return false;
	}
	const uuid = boxUUID(box);
	if (!uuid) {
		return false;
	}
	if (typeof uuid === "string" && uuid.endsWith("_screen")) {
		return false; // screenshare tile follows its owner; no independent controls
	}
	if (!(session.rpcs && session.rpcs[uuid])) {
		return false;
	}
	const directorList = Array.isArray(session.directorList) ? session.directorList : [];
	if (directorList.indexOf(uuid) !== -1) {
		return false; // a co-director host, not a caller
	}
	return true;
}

// Inject the action bar once per guest box. Non-destructive: appended as the last
// child of the legacy container, so the box's own controls are untouched.
function ensureBoxControls(box, session) {
	if (box.querySelector(":scope > .sm-actions")) {
		return;
	}
	const uuid = boxUUID(box);
	if (!uuid) {
		return;
	}

	const bar = document.createElement("div");
	bar.className = "sm-actions";

	const detail = document.createElement("div");
	detail.className = "sm-detail";

	const pos = document.createElement("span");
	pos.className = "sm-pos";
	pos.title = translate("showmode-position", "Queue position");

	const hold = document.createElement("span");
	hold.className = "sm-hold";
	hold.title = translate("showmode-hold-timer", "Time in queue");

	const mic = document.createElement("span");
	mic.className = "sm-pf sm-pf-mic";
	mic.title = translate("showmode-preflight-mic", "Mic live");
	mic.innerHTML = '<i class="las la-microphone"></i>';

	const cam = document.createElement("span");
	cam.className = "sm-pf sm-pf-cam";
	cam.title = translate("showmode-preflight-cam", "Camera live");
	cam.innerHTML = '<i class="las la-video"></i>';

	detail.appendChild(pos);
	detail.appendChild(hold);
	detail.appendChild(mic);
	detail.appendChild(cam);

	const buttons = document.createElement("div");
	buttons.className = "sm-buttons";

	LANE_ACTIONS.forEach(action => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "sm-btn " + action.cls;
		btn.dataset.group = action.group;
		btn.textContent = translate(action.labelKey, action.fallback);
		btn.addEventListener("click", event => {
			event.preventDefault();
			event.stopPropagation();
			setGroupExclusive(uuid, action.group, window.session);
			toggleProgramScene(box, action.scene);
			reconcile();
		});
		buttons.appendChild(btn);
	});

	const hangupBtn = document.createElement("button");
	hangupBtn.type = "button";
	hangupBtn.className = "sm-btn sm-btn--hangup";
	hangupBtn.textContent = translate("showmode-action-hangup", "Hang Up");
	hangupBtn.addEventListener("click", event => {
		event.preventDefault();
		event.stopPropagation();
		hangupGuest(box);
	});
	buttons.appendChild(hangupBtn);

	bar.appendChild(detail);
	bar.appendChild(buttons);
	box.appendChild(bar);
}

// Keep the bar in sync with the box's live lane: highlight the active lane's
// button, reveal the lane-appropriate detail, and refresh queue position / hold
// timer / pre-flight indicators.
function refreshBoxControls(box, session) {
	const bar = box.querySelector(":scope > .sm-actions");
	if (!bar) {
		return;
	}
	const uuid = boxUUID(box);
	if (uuid && !firstSeen.has(uuid)) {
		firstSeen.set(uuid, performance.now());
	}
	const lane = laneForBox(box, session);

	bar.classList.remove("sm-lane-onair", "sm-lane-ondeck", "sm-lane-green");
	bar.classList.add("sm-lane-" + lane);

	Array.prototype.slice.call(bar.querySelectorAll(".sm-btn[data-group]")).forEach(btn => {
		btn.classList.toggle("sm-btn--active", btn.dataset.group === lane);
	});

	const rpc = uuid && session.rpcs ? session.rpcs[uuid] : null;

	const pos = bar.querySelector(".sm-pos");
	if (pos) {
		pos.textContent = lane === "green" ? "#" + greenPosition(box) : "";
	}
	const hold = bar.querySelector(".sm-hold");
	if (hold) {
		hold.textContent = formatHold(uuid);
	}
	const mic = bar.querySelector(".sm-pf-mic");
	if (mic) {
		mic.classList.toggle("sm-pf--ok", micLive(rpc));
	}
	const cam = bar.querySelector(".sm-pf-cam");
	if (cam) {
		cam.classList.toggle("sm-pf--ok", camLive(box));
	}
}

// Set a caller's lane group exclusively: add the target group and drop the other
// two, driving the legacy `changeGroup()` with an explicit state so it is a set,
// not a toggle. A detached button carries the dataset changeGroup reads.
function setGroupExclusive(uuid, targetGroup, session) {
	if (typeof window.changeGroup !== "function") {
		console.warn("[showmode] changeGroup unavailable; cannot re-group");
		return;
	}
	const rpc = session && session.rpcs ? session.rpcs[uuid] : null;
	if (!rpc) {
		return;
	}
	if (!Array.isArray(rpc.group)) {
		rpc.group = [];
	}
	const sid = rpc.streamID || "";
	LANE_GROUPS.forEach(group => {
		const want = group === targetGroup;
		const has = rpc.group.indexOf(group) !== -1;
		if (want === has) {
			return;
		}
		const ele = document.createElement("button");
		ele.dataset.group = group;
		ele.dataset.UUID = uuid;
		ele.dataset.sid = sid;
		try {
			window.changeGroup(ele, want);
		} catch (error) {
			console.warn("[showmode] changeGroup failed", group, error);
		}
	});
}

// Add or remove the guest from the program scene via the legacy `directEnable()`
// toggle — gated on the button's current `.value` so repeated clicks are
// idempotent. Best-effort: silent if the box has no scene control.
function toggleProgramScene(box, on) {
	if (typeof window.directEnable !== "function") {
		return;
	}
	let btn = null;
	try {
		btn = box.querySelector('[data-action-type="addToScene"][data-scene="' + PROGRAM_SCENE + '"]');
	} catch (error) {
		return;
	}
	if (!btn) {
		return;
	}
	const isOn = String(btn.value) === "1";
	if (on === isOn) {
		return;
	}
	try {
		window.directEnable(btn, true); // `true` = synthetic click (no ctrl/meta): a plain toggle
	} catch (error) {
		console.warn("[showmode] directEnable failed", error);
	}
}

// Hang up a caller by clicking their box's own hangup button, so the native
// confirm-with-block dialog runs — never a silent disconnect.
function hangupGuest(box) {
	let btn = null;
	try {
		btn = box.querySelector('[data-action-type="hangup"]');
	} catch (error) {
		return;
	}
	if (btn && typeof btn.click === "function") {
		btn.click();
	}
}

// Pre-flight: mic is "live" when the guest's voice meter is present and reporting
// a numeric level (audio is arriving), independent of whether they are talking.
function micLive(rpc) {
	if (rpc && rpc.voiceMeter && rpc.voiceMeter.dataset) {
		return !isNaN(parseFloat(rpc.voiceMeter.dataset.level));
	}
	return false;
}

// Pre-flight: camera is "live" when the box has a playing video element with real
// frame data.
function camLive(box) {
	let video = null;
	try {
		video = box.querySelector("video");
	} catch (error) {
		return false;
	}
	if (!video) {
		return false;
	}
	return video.readyState >= 2 && !!video.videoWidth;
}

// 1-based position of a Green-Room box among its lane siblings.
function greenPosition(box) {
	const body = laneBodies.get("green");
	if (!body) {
		return 0;
	}
	let n = 0;
	const kids = Array.prototype.slice.call(body.children);
	for (let i = 0; i < kids.length; i++) {
		if (isControlBox(kids[i])) {
			n += 1;
			if (kids[i] === box) {
				return n;
			}
		}
	}
	return n;
}

// "m:ss" since the console first saw the guest — a rough time-in-queue readout.
function formatHold(uuid) {
	if (!uuid || !firstSeen.has(uuid)) {
		return "";
	}
	const seconds = Math.max(0, Math.floor((performance.now() - firstSeen.get(uuid)) / 1000));
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return mins + ":" + (secs < 10 ? "0" + secs : String(secs));
}

// ---- Phase 4: caller-facing source bar ------------------------------------
//
// Designates the composite that callers see, and hands the director the caller
// invite link. It drives the *existing* screenshare :s machinery
// (`toggleScreenShare`) to publish the source and reuses the director UI's own
// guest link (`#director_block_1`) + Phase-1 `&callerview` for routing — so there
// is no new WebRTC renegotiation and no new signaling path here.

// Build the source bar once, above the lanes. Non-destructive; refreshed each
// reconcile by refreshSourceBar().
function buildSourceBar(root) {
	const bar = document.createElement("div");
	bar.className = "sm-source";

	const head = document.createElement("div");
	head.className = "sm-source__head";
	const title = document.createElement("span");
	title.className = "sm-source__title";
	title.textContent = translate("showmode-source-title", "Caller-Facing Source");
	const sid = document.createElement("span");
	sid.className = "sm-source__sid";
	head.appendChild(title);
	head.appendChild(sid);

	const controls = document.createElement("div");
	controls.className = "sm-source__controls";

	const opts = document.createElement("div");
	opts.className = "sm-source__opts";
	SOURCE_OPTS.forEach(opt => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "sm-src-btn sm-src-" + opt.key;
		btn.dataset.src = opt.key;
		btn.textContent = translate(opt.labelKey, opt.fallback);
		btn.addEventListener("click", event => {
			event.preventDefault();
			event.stopPropagation();
			setCallerSource(opt.key === "screen");
			reconcile();
		});
		opts.appendChild(btn);
	});

	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "sm-src-copy";
	copy.textContent = translate("showmode-source-copy", "Copy caller invite link");
	copy.addEventListener("click", event => {
		event.preventDefault();
		event.stopPropagation();
		copyCallerLink(copy);
	});

	controls.appendChild(opts);
	controls.appendChild(copy);

	const hint = document.createElement("div");
	hint.className = "sm-source__hint";

	bar.appendChild(head);
	bar.appendChild(controls);
	bar.appendChild(hint);
	root.appendChild(bar);
}

// The caller-facing source's live stream ID: the director's screenshare :s
// second stream when one is being published, else empty.
function callerSourceSid(session) {
	if (session && session.screenShareState && session.streamID) {
		return session.streamID + ":s";
	}
	return "";
}

// Publish or stop the caller-facing source by driving the legacy screenshare
// toggle — gated on the current state so repeated clicks are idempotent (the
// legacy toggle would otherwise flip it the wrong way).
function setCallerSource(on) {
	const session = window.session;
	if (!session) {
		return;
	}
	if (!!session.screenShareState === on) {
		return;
	}
	if (typeof window.toggleScreenShare !== "function") {
		console.warn("[showmode] toggleScreenShare unavailable; cannot set caller source");
		return;
	}
	try {
		window.toggleScreenShare();
	} catch (error) {
		console.warn("[showmode] toggleScreenShare failed", error);
	}
}

// Caller invite = the director UI's own guest link (which already carries the
// room, password, token and wss params) + Phase-1 `&callerview=<sid>`. Falls
// back to a bare room link if the director link block is not present.
function buildCallerInviteLink(sid) {
	let base = "";
	try {
		const block = document.getElementById("director_block_1");
		if (block && block.dataset && block.dataset.raw) {
			base = block.dataset.raw;
		}
	} catch (error) {
		/* fall through to the room-link fallback */
	}
	if (!base) {
		const roomid = window.session && window.session.roomid;
		if (!roomid) {
			return "";
		}
		base = location.protocol + "//" + location.host + location.pathname + "?room=" + roomid;
	}
	const sep = base.indexOf("?") === -1 ? "?" : "&";
	return base + sep + "callerview=" + sid;
}

function copyCallerLink(btn) {
	const sid = callerSourceSid(window.session);
	if (!sid) {
		return;
	}
	const link = buildCallerInviteLink(sid);
	if (!link) {
		return;
	}
	const done = () => flashCopied(btn);
	try {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(link).then(done).catch(() => legacyCopy(link, done));
		} else {
			legacyCopy(link, done);
		}
	} catch (error) {
		legacyCopy(link, done);
	}
}

// Clipboard fallback for insecure contexts / older browsers.
function legacyCopy(text, done) {
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		document.execCommand("copy");
		document.body.removeChild(ta);
		if (typeof done === "function") {
			done();
		}
	} catch (error) {
		console.warn("[showmode] clipboard copy failed", error);
	}
}

function flashCopied(btn) {
	if (!btn) {
		return;
	}
	const original = translate("showmode-source-copy", "Copy caller invite link");
	btn.textContent = translate("showmode-source-copied", "Copied!");
	btn.classList.add("sm-src-copied");
	clearTimeout(btn._smCopyTimer);
	btn._smCopyTimer = setTimeout(() => {
		btn.textContent = original;
		btn.classList.remove("sm-src-copied");
	}, 1600);
}

// Keep the bar in sync with the live second-stream state: highlight the active
// source, show the live sid, enable copy only when a source is publishing, and
// swap the hint.
function refreshSourceBar(session) {
	if (!consoleEl) {
		return;
	}
	const bar = consoleEl.querySelector(":scope > .sm-source");
	if (!bar) {
		return;
	}
	const live = !!(session && session.screenShareState);
	const sid = callerSourceSid(session);

	Array.prototype.slice.call(bar.querySelectorAll(".sm-src-btn")).forEach(btn => {
		const isActive = (btn.dataset.src === "screen") === live;
		btn.classList.toggle("sm-src-btn--active", isActive);
	});

	const sidEl = bar.querySelector(".sm-source__sid");
	if (sidEl) {
		sidEl.textContent = sid;
	}

	const copy = bar.querySelector(".sm-src-copy");
	if (copy && !copy.classList.contains("sm-src-copied")) {
		copy.disabled = !sid;
	}

	const hint = bar.querySelector(".sm-source__hint");
	if (hint) {
		hint.textContent = live
			? translate("showmode-source-hint-live", "Callers who open this invite see only this source.")
			: translate("showmode-source-hint", "Publish a source, then share the caller invite — callers see only it.");
	}
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

/* Phase 3 — per-guest lane actions + queue detail. */
#showmodeConsole .sm-actions {
	position: relative;
	z-index: 40;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 6px;
	margin-top: 6px;
	padding: 5px 6px;
	border-top: 1px solid rgba(255, 255, 255, 0.08);
	background: rgba(0, 0, 0, 0.28);
	border-bottom-left-radius: 6px;
	border-bottom-right-radius: 6px;
}
#showmodeConsole .sm-detail {
	display: flex;
	align-items: center;
	gap: 6px;
	min-height: 18px;
	font-size: 0.72em;
	color: var(--discord-text, #dcddde);
	opacity: 0.85;
}
#showmodeConsole .sm-buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}
#showmodeConsole .sm-btn {
	cursor: pointer;
	border: 1px solid rgba(255, 255, 255, 0.14);
	border-radius: 5px;
	padding: 3px 8px;
	font-size: 0.72em;
	font-weight: 600;
	line-height: 1.4;
	color: var(--discord-text, #dcddde);
	background: rgba(255, 255, 255, 0.06);
	white-space: nowrap;
}
#showmodeConsole .sm-btn:hover { background: rgba(255, 255, 255, 0.14); }
#showmodeConsole .sm-btn--onair { border-color: var(--darktheme-red, rgb(161, 45, 45)); }
#showmodeConsole .sm-btn--ondeck { border-color: var(--darktheme-yellow, rgb(120, 100, 20)); }
#showmodeConsole .sm-btn--green { border-color: var(--darktheme-green, rgb(36, 88, 49)); }
#showmodeConsole .sm-btn--hangup { border-color: rgba(214, 69, 69, 0.7); color: #f0a9a9; }
#showmodeConsole .sm-btn--hangup:hover { background: rgba(214, 69, 69, 0.28); }
#showmodeConsole .sm-btn--active {
	box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
	cursor: default;
}
#showmodeConsole .sm-btn--onair.sm-btn--active { background: var(--darktheme-red, rgb(161, 45, 45)); color: #fff; }
#showmodeConsole .sm-btn--ondeck.sm-btn--active { background: var(--darktheme-yellow, rgb(120, 100, 20)); color: #fff; }
#showmodeConsole .sm-btn--green.sm-btn--active { background: var(--darktheme-green, rgb(36, 88, 49)); color: #fff; }

/* Contextual queue detail: position + hold timer for Green Room, mic/cam
   pre-flight for On Deck. Hidden unless the box is in the relevant lane. */
#showmodeConsole .sm-pos,
#showmodeConsole .sm-hold {
	display: none;
	font-variant-numeric: tabular-nums;
}
#showmodeConsole .sm-pos {
	font-weight: 700;
	padding: 0 5px;
	border-radius: 999px;
	background: rgba(0, 0, 0, 0.35);
}
#showmodeConsole .sm-actions.sm-lane-green .sm-pos,
#showmodeConsole .sm-actions.sm-lane-green .sm-hold { display: inline-block; }
#showmodeConsole .sm-pf {
	display: none;
	align-items: center;
	opacity: 0.4;
}
#showmodeConsole .sm-pf i { font-size: 1.05em; }
#showmodeConsole .sm-actions.sm-lane-ondeck .sm-pf { display: inline-flex; }
#showmodeConsole .sm-pf--ok {
	opacity: 1;
	color: #37d67a;
}

/* Phase 4 — caller-facing source bar (above the lanes). */
#showmodeConsole .sm-source {
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 8px;
	background: var(--container-color, #373737);
	padding: 8px 12px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}
#showmodeConsole .sm-source__head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
#showmodeConsole .sm-source__title {
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	font-size: 0.82em;
	color: var(--discord-text, #dcddde);
}
#showmodeConsole .sm-source__sid {
	font-family: monospace;
	font-size: 0.78em;
	color: var(--discord-text, #dcddde);
	opacity: 0.75;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 55%;
}
#showmodeConsole .sm-source__controls {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
#showmodeConsole .sm-source__opts {
	display: inline-flex;
	border-radius: 6px;
	overflow: hidden;
	border: 1px solid rgba(255, 255, 255, 0.14);
}
#showmodeConsole .sm-src-btn {
	cursor: pointer;
	border: 0;
	border-right: 1px solid rgba(255, 255, 255, 0.14);
	padding: 5px 12px;
	font-size: 0.76em;
	font-weight: 600;
	color: var(--discord-text, #dcddde);
	background: rgba(255, 255, 255, 0.05);
	white-space: nowrap;
}
#showmodeConsole .sm-src-btn:last-child { border-right: 0; }
#showmodeConsole .sm-src-btn:hover { background: rgba(255, 255, 255, 0.12); }
#showmodeConsole .sm-src-btn--active {
	background: var(--darktheme-red, rgb(161, 45, 45));
	color: #fff;
	cursor: default;
}
#showmodeConsole .sm-src-copy {
	cursor: pointer;
	border: 1px solid rgba(255, 255, 255, 0.18);
	border-radius: 6px;
	padding: 5px 12px;
	font-size: 0.76em;
	font-weight: 600;
	color: var(--discord-text, #dcddde);
	background: rgba(255, 255, 255, 0.06);
	white-space: nowrap;
}
#showmodeConsole .sm-src-copy:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
#showmodeConsole .sm-src-copy:disabled { opacity: 0.4; cursor: not-allowed; }
#showmodeConsole .sm-src-copy.sm-src-copied {
	background: var(--darktheme-green, rgb(36, 88, 49));
	color: #fff;
	border-color: var(--darktheme-green, rgb(36, 88, 49));
}
#showmodeConsole .sm-source__hint {
	font-size: 0.72em;
	color: var(--discord-text, #dcddde);
	opacity: 0.6;
}
`;
