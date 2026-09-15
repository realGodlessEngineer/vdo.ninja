// Show-mode co-host view — Phase 6.
//
// Loaded (through core/showmode/index.js) only when `&cohost=<program stream id>`
// is present. The co-host is a normal room participant — publishes cam + mic and
// is heard as a host — so this module never touches groups or director state. On
// top of the default guest page it adds two things:
//
//   1. A Zoom-style layout: the program/composite feed (the director's screenshare
//      `:s` stream, whose id rides in the param) pinned large and centred, with
//      every other camera — self, the director's clean cam, callers, other
//      co-hosts — as a thumbnail strip across the top. A legacy `session.layout`
//      only shows the streams it keys explicitly (updateMixer hides any un-keyed
//      stream), so the layout is rebuilt from the live peer set rather than frozen
//      in the URL, and re-applied through the legacy `updateMixer()` only when it
//      actually changes. Until the program feed is present the default grid is
//      left alone, so co-hosts see each other normally before the show starts.
//   2. A details card (display name / pronouns / social handles) whose contents go
//      to the director over the engine's existing generic data pipe
//      (`session.sendGenericData` → `session.gotGenericData` on the far side, the
//      same path the IFRAME API's `sendData` / `dataReceived` uses). The director
//      console renders them inside the guest's control box.
//
// It touches no legacy source. The only legacy-side hook is `session.cohost` (set
// from `&cohost` in main.js); everything else reads live state through the bridge.

import { waitForLegacySession } from "../legacy/session-bridge.js";

const RECONCILE_MS = 500; // layout + card refresh cadence
const RESEND_MS = 20000; // periodic re-send so a late-joining or reloaded director still gets the details
const PEER_SETTLE_MS = 3000; // follow-up send after a new viewer appears, once its data channel has had time to open
const MAX_THUMBS = 8; // thumbnail-strip slots (self + hosts + callers)
const STRIP_H = 18; // % of the stage given to the strip
const THUMB_MAX_W = 18; // % — a 16:9 thumb in an 18%-tall strip on a 16:9 stage
const THUMB_GAP = 0.6; // % breathing room between thumbs
const STORAGE_KEY = "showmode-cohost-meta";
const LIMITS = { name: 64, pronouns: 32, social: 64, socials: 5 };

let started = false;
let session = null;
let pinnedSid = ""; // program stream id from the param ("" = discover the director's :s stream)
let layoutOwned = false; // we set session.layout, so we may also clear it
let lastLayoutJson = "";
const seenOrder = new Map(); // sid -> first-seen counter, for a stable strip order
let seenCounter = 0;
let meta = null; // { name, pronouns, socials[] } as last saved by the guest
let panel = null;
let fields = null; // { name, pronouns, socials } inputs
let lastPeerCount = -1;
let lastSentAt = 0;
let lastSendOk = false;
let settleTimer = null;

export async function startCohostView() {
	if (started) {
		return;
	}
	started = true;

	try {
		session = await waitForLegacySession({ timeoutMs: 15000 });
	} catch (error) {
		console.warn("[showmode] legacy session never arrived; co-host view idle", error);
		return;
	}

	pinnedSid = typeof session.cohost === "string" ? session.cohost : "";
	meta = loadStoredMeta();
	injectStyles();

	reconcile();
	setInterval(reconcile, RECONCILE_MS);
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

function reconcile() {
	if (!session) {
		return;
	}
	try {
		applyLayout();
	} catch (error) {
		console.warn("[showmode] co-host layout failed", error);
	}
	try {
		ensurePanel();
		refreshPill();
	} catch (error) {
		console.warn("[showmode] co-host card failed", error);
	}
	try {
		maybeResend();
	} catch (error) {
		console.warn("[showmode] co-host details send failed", error);
	}
}

// ---- Zoom-style layout ------------------------------------------------------

function applyLayout() {
	const programSid = resolveProgramSid();
	const streams = collectStreams(programSid);

	if (!programSid || !streams.hasProgram) {
		// No program feed yet — hand the stage back to the default grid.
		if (layoutOwned && session.layout) {
			session.layout = false;
			layoutOwned = false;
			lastLayoutJson = "";
			refreshMixer();
		}
		return;
	}

	const layout = buildLayout(programSid, streams.thumbs);
	const json = JSON.stringify(layout);
	if (json === lastLayoutJson && session.layout) {
		return;
	}
	lastLayoutJson = json;
	session.layout = layout;
	layoutOwned = true;
	refreshMixer();
}

// The param pins the program feed; without one, fall back to the first
// screenshare-style (`:s`) stream in the room, which is the director's composite.
function resolveProgramSid() {
	if (pinnedSid) {
		return pinnedSid;
	}
	const rpcs = session.rpcs || {};
	const uuids = Object.keys(rpcs);
	for (let i = 0; i < uuids.length; i++) {
		const rpc = rpcs[uuids[i]];
		if (rpc && typeof rpc.streamID === "string" && rpc.streamID.endsWith(":s")) {
			return rpc.streamID;
		}
	}
	return "";
}

// Every stream with live video, minus the program feed: self first, the
// director's own camera next, then everyone else in the order they arrived.
function collectStreams(programSid) {
	const thumbs = [];
	let hasProgram = false;

	const selfSid = session.streamID || "";
	if (selfSid && selfSid !== programSid && hasVideo(session.videoElement)) {
		thumbs.push({ sid: selfSid, rank: 0 });
	}

	const rpcs = session.rpcs || {};
	Object.keys(rpcs).forEach(uuid => {
		const rpc = rpcs[uuid];
		if (!rpc || !rpc.streamID) {
			return;
		}
		if (rpc.streamID === programSid) {
			hasProgram = hasProgram || hasVideo(rpc.videoElement);
			return;
		}
		if (!hasVideo(rpc.videoElement)) {
			return;
		}
		if (!seenOrder.has(rpc.streamID)) {
			seenCounter += 1;
			seenOrder.set(rpc.streamID, seenCounter);
		}
		thumbs.push({ sid: rpc.streamID, rank: uuid === session.directorUUID ? 1 : 1 + seenOrder.get(rpc.streamID) });
	});

	thumbs.sort((a, b) => a.rank - b.rank);
	return { hasProgram, thumbs: thumbs.slice(0, MAX_THUMBS).map(t => t.sid) };
}

// A stream counts once its element carries a live video track that is not
// disabled — the same shape updateMixer uses to decide what to draw.
function hasVideo(el) {
	if (!el || !el.srcObject || typeof el.srcObject.getVideoTracks !== "function") {
		return false;
	}
	if (el.style && el.style.display === "none") {
		return false;
	}
	return el.srcObject.getVideoTracks().length > 0;
}

// Program feed large below the strip (letterboxed, so it sits centred), thumbs
// centred across the top, sized to fit — never wider than a 16:9 tile.
function buildLayout(programSid, thumbSids) {
	const layout = {};
	layout[programSid] = { x: 0, y: STRIP_H, w: 100, h: 100 - STRIP_H, z: 1 };

	const n = thumbSids.length;
	if (n) {
		const slotW = Math.min(THUMB_MAX_W, 100 / n);
		const x0 = (100 - slotW * n) / 2;
		thumbSids.forEach((sid, i) => {
			layout[sid] = { x: round2(x0 + i * slotW + THUMB_GAP / 2), y: 0.5, w: round2(slotW - THUMB_GAP), h: STRIP_H - 1, z: 2, cover: true };
		});
	}
	return layout;
}

function round2(value) {
	return Math.round(value * 100) / 100;
}

function refreshMixer() {
	if (typeof window.updateMixer !== "function") {
		return;
	}
	try {
		window.updateMixer();
	} catch (error) {
		console.warn("[showmode] updateMixer failed", error);
	}
}

// ---- Details card -----------------------------------------------------------

// Mount the card once the guest is actually publishing (the join screen is
// still up before `session.seeding`). Returning guests start collapsed.
function ensurePanel() {
	if (panel && panel.isConnected) {
		return;
	}
	if (!session.seeding || !document.body) {
		return;
	}
	panel = buildPanel();
	document.body.appendChild(panel);
	setOpen(!(meta && meta.name));
}

function buildPanel() {
	const root = document.createElement("div");
	root.id = "showmodeCohost";
	root.className = "smc";
	// Keep clicks inside the card from reaching the stage's own handlers.
	root.addEventListener("click", event => event.stopPropagation());

	const form = document.createElement("form");
	form.className = "smc-card";
	form.setAttribute("autocomplete", "off");

	const head = document.createElement("div");
	head.className = "smc-card__head";
	const title = document.createElement("div");
	title.className = "smc-card__title";
	title.textContent = translate("showmode-cohost-title", "Your on-screen details");
	const sub = document.createElement("div");
	sub.className = "smc-card__sub";
	sub.textContent = translate("showmode-cohost-subtitle", "The host sees these on their console. You can update them any time.");
	head.appendChild(title);
	head.appendChild(sub);
	form.appendChild(head);

	fields = {
		name: addField(form, "name", translate("showmode-cohost-name", "Display name"), translate("showmode-cohost-name-placeholder", "How you'd like to be introduced"), LIMITS.name),
		pronouns: addField(form, "pronouns", translate("showmode-cohost-pronouns", "Pronouns"), translate("showmode-cohost-pronouns-placeholder", "e.g. she/her, they/them"), LIMITS.pronouns),
		socials: addField(form, "socials", translate("showmode-cohost-socials", "Social handle(s)"), translate("showmode-cohost-socials-placeholder", "@you · x.com, @you · instagram"), (LIMITS.social + 2) * LIMITS.socials, translate("showmode-cohost-socials-hint", "Separate several handles with commas."))
	};

	const prefill = meta || prefillFromLabel();
	if (prefill) {
		fields.name.value = prefill.name || "";
		fields.pronouns.value = prefill.pronouns || "";
		fields.socials.value = (prefill.socials || []).join(", ");
	}

	const actions = document.createElement("div");
	actions.className = "smc-card__actions";
	const later = document.createElement("button");
	later.type = "button";
	later.className = "smc-btn smc-btn--ghost";
	later.textContent = translate("showmode-cohost-later", "Later");
	later.addEventListener("click", event => {
		event.preventDefault();
		setOpen(false);
	});
	const save = document.createElement("button");
	save.type = "submit";
	save.className = "smc-btn smc-btn--primary";
	save.textContent = translate("showmode-cohost-save", "Save & share");
	actions.appendChild(later);
	actions.appendChild(save);
	form.appendChild(actions);

	form.addEventListener("submit", event => {
		event.preventDefault();
		event.stopPropagation();
		const next = sanitizeMeta({ name: fields.name.value, pronouns: fields.pronouns.value, socials: fields.socials.value });
		if (!next.name) {
			form.classList.add("smc-card--invalid");
			fields.name.focus();
			return;
		}
		form.classList.remove("smc-card--invalid");
		meta = next;
		storeMeta(meta);
		sendMeta();
		setOpen(false);
		refreshPill();
	});

	const pill = document.createElement("button");
	pill.type = "button";
	pill.className = "smc-pill";
	const dot = document.createElement("span");
	dot.className = "smc-pill__dot";
	const text = document.createElement("span");
	text.className = "smc-pill__text";
	const status = document.createElement("span");
	status.className = "smc-pill__status";
	const edit = document.createElement("i");
	edit.className = "las la-pen smc-pill__edit";
	pill.appendChild(dot);
	pill.appendChild(text);
	pill.appendChild(status);
	pill.appendChild(edit);
	pill.addEventListener("click", event => {
		event.preventDefault();
		setOpen(true);
	});

	root.appendChild(form);
	root.appendChild(pill);
	return root;
}

function addField(form, name, label, placeholder, maxLength, hint) {
	const wrap = document.createElement("label");
	wrap.className = "smc-field smc-field--" + name;
	const caption = document.createElement("span");
	caption.className = "smc-field__label";
	caption.textContent = label;
	const input = document.createElement("input");
	input.type = "text";
	input.name = name;
	input.placeholder = placeholder;
	input.maxLength = maxLength;
	input.spellcheck = false;
	input.setAttribute("autocomplete", "off");
	wrap.appendChild(caption);
	wrap.appendChild(input);
	if (hint) {
		const hintEl = document.createElement("span");
		hintEl.className = "smc-field__hint";
		hintEl.textContent = hint;
		wrap.appendChild(hintEl);
	}
	form.appendChild(wrap);
	return input;
}

function setOpen(open) {
	if (!panel) {
		return;
	}
	panel.classList.toggle("smc--open", !!open);
	if (open && fields && fields.name) {
		try {
			fields.name.focus();
		} catch (error) {
			/* focus is best-effort */
		}
	}
}

// The collapsed pill: who you are, and whether the host has it yet.
function refreshPill() {
	if (!panel) {
		return;
	}
	const pill = panel.querySelector(".smc-pill");
	if (!pill) {
		return;
	}
	const text = pill.querySelector(".smc-pill__text");
	const status = pill.querySelector(".smc-pill__status");
	if (meta && meta.name) {
		text.textContent = meta.pronouns ? meta.name + " · " + meta.pronouns : meta.name;
		status.textContent = lastSendOk ? translate("showmode-cohost-shared", "Shared with the host") : translate("showmode-cohost-pending", "Will share when the host connects");
		pill.classList.toggle("smc-pill--shared", lastSendOk);
	} else {
		text.textContent = translate("showmode-cohost-edit", "Add your details");
		status.textContent = "";
		pill.classList.remove("smc-pill--shared");
	}
}

// ---- Details: shape, persistence, transport ---------------------------------

function cleanText(value, max) {
	if (typeof value !== "string") {
		return "";
	}
	return value
		.replace(/[\p{Cc}<>]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

// Normalise to { name, pronouns, socials[] } with length caps and no markup.
function sanitizeMeta(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	let socials = [];
	if (Array.isArray(src.socials)) {
		socials = src.socials;
	} else if (typeof src.socials === "string") {
		socials = src.socials.split(",");
	}
	socials = socials
		.map(handle => cleanText(handle, LIMITS.social))
		.filter(Boolean)
		.slice(0, LIMITS.socials);
	return { name: cleanText(src.name, LIMITS.name), pronouns: cleanText(src.pronouns, LIMITS.pronouns), socials };
}

// Details the guest saved on an earlier visit (per browser). Anything stored was
// explicitly saved, so it is safe to share again without re-confirming.
function loadStoredMeta() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = sanitizeMeta(JSON.parse(raw));
			if (parsed.name) {
				return parsed;
			}
		}
	} catch (error) {
		/* private mode / storage disabled — start empty */
	}
	return null;
}

// First visit: seed the name from `&label` if the guest joined with one. Only a
// prefill — nothing is shared until the guest saves.
function prefillFromLabel() {
	if (typeof session.label === "string" && session.label) {
		return sanitizeMeta({ name: session.label });
	}
	return null;
}

function storeMeta(value) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch (error) {
		/* private mode / storage disabled — session-only */
	}
}

// Send over the engine's generic data pipe. "pcs" targets the data channels of
// everyone viewing this stream — which includes the director. The stream id
// rides along so the console can match the sender even if the message arrives on
// a channel it does not track by UUID.
function sendMeta() {
	if (!meta || !meta.name) {
		return false;
	}
	if (typeof session.sendGenericData !== "function") {
		return false;
	}
	let ok = false;
	try {
		ok = !!session.sendGenericData({ showmodeMeta: meta, streamID: session.streamID || "" }, false, false, "pcs");
	} catch (error) {
		ok = false;
	}
	lastSentAt = performance.now();
	lastSendOk = ok;
	return ok;
}

// Re-send when a new viewer connects (a reloaded director, a co-director), after
// a failed send, and periodically — the payload is tiny.
function maybeResend() {
	if (!meta || !meta.name) {
		return;
	}
	const peers = session.pcs ? Object.keys(session.pcs).length : 0;
	const peersChanged = peers !== lastPeerCount;
	lastPeerCount = peers;
	if (!peers) {
		lastSendOk = false;
		return;
	}
	if (peersChanged) {
		clearTimeout(settleTimer);
		settleTimer = setTimeout(sendMeta, PEER_SETTLE_MS);
	}
	if (peersChanged || !lastSendOk || performance.now() - lastSentAt > RESEND_MS) {
		sendMeta();
	}
}

function injectStyles() {
	if (document.getElementById("showmode-cohost-styles")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "showmode-cohost-styles";
	style.textContent = COHOST_CSS;
	document.head.appendChild(style);
}

// Scoped to #showmodeCohost so nothing leaks into the default UI. Colours lean
// on main.css custom properties, with literal fallbacks for older themes. Sits in
// the bottom-left corner, clear of the centred control bar (z-index 995).
const COHOST_CSS = `
#showmodeCohost.smc {
	position: fixed;
	left: 16px;
	bottom: 72px;
	z-index: 996;
	max-width: calc(100vw - 32px);
	color: var(--discord-text, #dcddde);
	font-family: inherit;
}
#showmodeCohost .smc-card {
	display: none;
	flex-direction: column;
	gap: 12px;
	width: 340px;
	max-width: 100%;
	box-sizing: border-box;
	padding: 16px 16px 14px;
	border-radius: 12px;
	border: 1px solid rgba(255, 255, 255, 0.1);
	background: var(--container-color, #373737);
	box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
#showmodeCohost.smc--open .smc-card { display: flex; }
#showmodeCohost .smc-card__title {
	font-weight: 700;
	font-size: 1.02em;
	letter-spacing: 0.01em;
}
#showmodeCohost .smc-card__sub {
	margin-top: 3px;
	font-size: 0.8em;
	line-height: 1.35;
	opacity: 0.7;
}
#showmodeCohost .smc-field {
	display: flex;
	flex-direction: column;
	gap: 4px;
	cursor: text;
}
#showmodeCohost .smc-field__label {
	font-size: 0.72em;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	opacity: 0.75;
}
#showmodeCohost .smc-field input {
	box-sizing: border-box;
	width: 100%;
	padding: 8px 10px;
	border-radius: 8px;
	border: 1px solid rgba(255, 255, 255, 0.16);
	background: rgba(0, 0, 0, 0.28);
	color: inherit;
	font: inherit;
	font-size: 0.92em;
	outline: none;
}
#showmodeCohost .smc-field input::placeholder { color: inherit; opacity: 0.35; }
#showmodeCohost .smc-field input:focus {
	border-color: rgba(255, 255, 255, 0.45);
	box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.08);
}
#showmodeCohost .smc-field__hint {
	font-size: 0.72em;
	opacity: 0.55;
}
#showmodeCohost .smc-card--invalid .smc-field--name input { border-color: #d64545; }
#showmodeCohost .smc-card__actions {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-top: 2px;
}
#showmodeCohost .smc-btn {
	cursor: pointer;
	padding: 7px 14px;
	border-radius: 8px;
	border: 1px solid rgba(255, 255, 255, 0.16);
	background: rgba(255, 255, 255, 0.06);
	color: inherit;
	font: inherit;
	font-size: 0.86em;
	font-weight: 600;
}
#showmodeCohost .smc-btn:hover { background: rgba(255, 255, 255, 0.14); }
#showmodeCohost .smc-btn--primary {
	border-color: transparent;
	background: var(--darktheme-green, rgb(36, 88, 49));
	color: #fff;
}
#showmodeCohost .smc-btn--primary:hover { filter: brightness(1.15); }
#showmodeCohost .smc-pill {
	display: none;
	align-items: center;
	gap: 8px;
	max-width: 100%;
	padding: 6px 12px 6px 9px;
	border-radius: 999px;
	border: 1px solid rgba(255, 255, 255, 0.14);
	background: rgba(0, 0, 0, 0.55);
	color: inherit;
	font: inherit;
	font-size: 0.84em;
	cursor: pointer;
	backdrop-filter: blur(6px);
}
#showmodeCohost:not(.smc--open) .smc-pill { display: inline-flex; }
#showmodeCohost .smc-pill:hover { background: rgba(0, 0, 0, 0.7); }
#showmodeCohost .smc-pill__dot {
	flex: none;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: #e0a63a;
}
#showmodeCohost .smc-pill--shared .smc-pill__dot { background: #37d67a; }
#showmodeCohost .smc-pill__text {
	font-weight: 600;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
#showmodeCohost .smc-pill__status {
	white-space: nowrap;
	opacity: 0.6;
}
#showmodeCohost .smc-pill__status:empty { display: none; }
#showmodeCohost .smc-pill__edit { opacity: 0.7; }
`;
