# Show-Mode Redesign — Phased Implementation Plan

Branch: `features/showmode` (cut from `ge-main`)
Mockup: https://claude.ai/code/artifact/3711bc0f-33b2-4ed9-86ec-a10cd78a0d81

## Goal

Optimize VDO.Ninja for a call-in show with two participant roles:

1. **Callers** — one at a time, on-air. They see a single **program feed** (the
   host's composite/virtual-cam device) and hear both hosts; they never see or
   hear the queue or each other.
2. **Co-hosts** — join as co-directors, see the director's **clean host cam** and
   their own cam presented equally, and help run the show.

Plus a **director console** that organizes people by role (On Air / On Deck /
Green Room) instead of one flat, color-coded camera list, and a director control
to designate the **caller-facing video source** (a composite device) separately
from the host's primary camera.

## Guiding constraints (from CLAUDE.md)

- **`webrtc.js` is off-limits** (license: not modifiable without the author's
  permission). Everything here must live in `lib.js` / `main.js` / HTML / `core/`.
- **No build step.** Plain static HTML/CSS/JS, global scope for the legacy files.
- **Keep changes minimal and localized** — forkers re-deploy this.
- **Gate all new behavior behind a URL param** (`&showmode`) so the default UI is
  untouched.
- **Bump `?ver=`** for `lib.js` / `main.js` in every HTML file touched (`index.html`
  and `room.html` track separate numbers).
- **i18n:** add English source strings with `data-translate` / `getTranslation`
  keys + base translation file; let CI fill other locales. Do not hand-translate.
- **Formatting:** tabs width 4, double quotes, semicolons, `printWidth: 10000`.
- Editing `lib.js` churns line endings — use a byte-precise raw edit (see memory
  `libjs-mixed-line-endings`).

## Traced code anchors (verified this session)

| Mechanism | Location |
|---|---|
| `&directoronly` / `&do` → `session.viewDirectorOnly` | `main.js:4232` |
| `&showonly` / `&novideo` / `&nv` / `&hidevideo` allowlist | `main.js:5034` (set), `lib.js:62334` (display gate) |
| Screenshare = independent 2nd stream `streamID + ":s"` | `lib.js:5547, 21608, 29193`; `:s` gates throughout |
| Groups membership intersection (who-sees/hears-whom) | `lib.js:7583` |
| `changeGroup()` — re-group a guest live | `lib.js:56741` |
| `updateMixer()` render loop | `lib.js:6953` |
| Co-directors list | `session.directorList` |

---

## Phase 0 — Spike & scaffolding (no user-visible change)

- [x] **Path B feasibility spike:** trace whether the second-source (`:s`) publish
      path — creating the track and attaching it to existing peer connections — is
      reachable from `lib.js` / `main.js`, or whether it crosses into `webrtc.js`.
      Verdict decides Phase 4's shape. Deliverable: a short written finding.
      **→ GREEN. See "Phase 0 findings" below.**
- [ ] Confirm the group→role assumptions against `lib.js:7583` and `changeGroup()`
      (`lib.js:56741`) with a live 3-party test (host + co-host + caller).
      **→ USER-OWNED: needs a live browser session; cannot be verified by code-read.**
- [x] Add a dormant `&showmode` URL param that flags the director into the new
      layout path (no-op branch for now). **→ `main.js` after the `&directoronly`
      block sets `session.showmode = true`; `?ver=` bumped (index 1065, room 769).**
- [x] Decide where the console lives: new CSS + markup injected into the director
      DOM from `main.js`, vs. a `core/` module bridged via `session-bridge.js`.
      **→ DECISION: `core/` module bridged via `session-bridge.js` (below).**

**Acceptance:** feasibility verdict written; `&showmode` toggles a branch that is
still visually identical to today. **→ MET** (live 3-party sanity check is the one
remaining user-owned item; it validates assumptions, not the acceptance gate).

### Phase 0 findings

**Feasibility verdict: GREEN.** The full second-source publish path is reachable
from `lib.js` using standard WebRTC APIs on the `session.pcs[UUID]` peer-connection
objects and the engine's already-exposed `session.createOffer`. Phase 4's native
"caller-facing source" selector does **not** require modifying `webrtc.js`.

Evidence (traced this session):

| What | Where | Note |
|---|---|---|
| Track-manipulation call count | `webrtc.js` 1× (obfuscated) vs `lib.js` 172× vs `main.js` 0× | Plumbing lives on the reachable side. |
| Attach 2nd stream to peers | `createSecondStream2(UUID)` `lib.js:66117` | `getSenders2()`, `sender.replaceTrack(track)`, and `session.pcs[UUID].addTrack(track, session.screenStream)` — all direct, in `lib.js`. |
| Build the 2nd-stream wrapper PC | `session.pcs[UUID + "_screen"]` `lib.js:66128` | Synthetic per-source PC record, created in `lib.js`. |
| Trigger renegotiation | `session.createOffer(UUID, true)` `lib.js:39226`; `pc.createOffer()` `lib.js:60490` | `lib.js` both calls the engine's exposed `createOffer` and calls the standard API directly. |
| Existing proof it works | `createSecondStream()` / `publishScreen2()` `lib.js:40309` | The shipping screenshare `:s` second source is orchestrated entirely from `lib.js` end-to-end. |

Implication for **Phase 4**: build the native director "caller-facing source"
selector on the existing `createSecondStream` / `:s` machinery — publish the chosen
composite device as the second stream and route callers to it via `&showonly`. The
two-publisher fallback recipe is a nice-to-have, not a necessity.

### Console-location decision (Phase 0)

The console will be a **`core/` ES module bridged through
`core/legacy/session-bridge.js`** (`waitForLegacySession()`, `onLegacyEvent()`,
`forwardLegacyEvent()`), not markup injected from `main.js`. Rationale: it is a new
surface (the module pattern is the project's stated direction for new features), it
keeps the large legacy `main.js` untouched beyond the one dormant flag, and the
lane/status rendering wants its own module state rather than more globals. The
`&showmode` flag in `main.js` is the only legacy-side hook; everything else lives in
the module and reads live state through the bridge.

## Phase 1 — Role recipes & presets (config-first; ships value immediately)

Delivers the working call-in flow using **existing** mechanics — no engine changes.

- [x] **Caller active-call room** — shipped as a preset param **`&callerview=<host
      program stream id>`**. It is a *compound alias*: `main.js` adds `callerview`
      to the `directoronly` block (`main.js:4232` → `session.viewDirectorOnly = true`)
      **and** to the `showonly`/`novideo` block (`main.js:5041-5042` →
      `session.novideo = [<id>]`). One short param expands to `&directoronly` +
      `&showonly=<id>`, so a caller invite link stays short. `?ver=` bumped
      (index 1066, room 770); `node --check main.js` clean.
- [x] **Co-host room** — kept as a documented recipe (no new code earns its keep):
      `&director=<room>&codirector=<password>&showonly=<clean host cam id>`. The
      co-host joins the director room as a co-director (existing `&codirector`
      password flow, `main.js:7976`) and `&showonly=<clean cam id>` shows the clean
      host cam instead of the composite — avoiding mirror-in-mirror. A preset was
      considered and rejected: the room + password + codirector context can't be
      folded into a single value param the way the caller side can.
      **→ Superseded in Phase 6 by the `&cohost=<program sid>` preset ("Option
      A": the co-host is a normal participant with a Zoom-style view, not a
      co-director). The co-director recipe remains valid for a co-host who needs
      director controls.**
- [x] Document the stream-ID prerequisite: the host must publish a **stable** stream
      ID for both the program/composite feed and the clean cam (e.g. via `&push=` or
      a fixed `&permaid`), because `&callerview` / `&showonly` key off that exact ID.
- [ ] Validate the whole flow live end-to-end (the "Path A works today" step).
      **→ USER-OWNED: needs a live host + co-host + caller browser session.**

### Verified allowlist semantics (this session)

`&showonly` is **not** referenced in `lib.js`; `main.js:5042` aliases it straight
into `session.novideo`. Despite the variable name, a *populated* `session.novideo`
acts as a video **allowlist**: the display gate at `lib.js:62334` sets `video = false`
for any peer whose `streamID` is **not** in the array, and audio is governed
separately (`session.noaudio`). So `&callerview=<id>` shows only the program feed's
video while the caller still hears the director(s). (An empty `&callerview` with no
value degrades safely to "all video hidden, audio kept" — hence the stream-ID
prerequisite above.)

**Acceptance:** a real show can run — caller sees only the program feed + hears both
hosts; co-host sees clean host cam + self equally; queue stays private. **→ Code +
recipes MET; the live end-to-end validation is the one remaining user-owned item.**

## Phase 2 — Director console: lane layout (read-only)

Shipped as a `core/` ES module (`core/showmode/index.js` + `console.js`), lazy-
loaded from `podcast/bootstrap.js` only under `&showmode` — no legacy edits, no
`?ver=` bumps. The module reads live state through `core/legacy/session-bridge.js`
and the core level bus; the sole legacy hook is `session.showmode` (`main.js:4240`).

- [x] Build the lane container (On Air / On Deck / Green Room) as the `&showmode`
      director view; CSS injected from the module (scoped to `#showmodeConsole`),
      on `main.css` tokens (`--container-color`, `--darktheme-red/yellow/green`,
      `--discord-text`) with literal fallbacks. Lanes carry a live member count.
- [x] Map **groups → lanes**. **Canonical group names: `onair` / `ondeck` /
      `green`.** First-match priority `onair > ondeck > green`; a guest in none
      holds in **Green Room** (default lane).
- [x] Render existing per-guest tiles into their lane by group membership instead
      of the flat list; the legacy `container_<UUID>` control boxes are **moved**
      into lane bodies untouched (markup/controls reused as-is). A MutationObserver
      on `#guestFeeds` + a 500 ms reconcile loop adopt newly-joined boxes, re-place
      on a group change, and prune boxes whose peer has left. **On Air anchors:**
      `container_director` and every co-director (`session.directorList`) are always
      On Air; the live caller (group `onair`) joins them. Screenshare boxes
      (`<uuid>_screen`) follow their owner's lane.
- [x] **Status-based coloring** replacing room-color, painted as non-destructive
      classes on the box: **talking** (core `levelBus`, falling back to the legacy
      `voiceMeter.dataset.level > 15` — the reliable director-side signal),
      **live** (a pressed scene control in the box), **connection quality** (legacy
      `signalMeter.dataset.level` 0–5 bars → good/warn/bad dot).
- [x] Read-only first: correct placement + visual language, **no promote/demote**
      (no `changeGroup()` calls) — that is Phase 3.
- [x] i18n: `showmode-lane-onair/ondeck/green` added to `translations/default.json`
      + `en.json` (`miscellaneous`); CI fills other locales. `node --check` clean on
      both modules; `ci-validateTranslations.js` passes.
- [ ] Live browser validation: with `&showmode` a real director session shows guests
      grouped by role with status-driven color, and the default view is unchanged
      without the flag. **→ USER-OWNED: needs a live director + guests browser
      session; cannot be verified by code-read.**

**Acceptance:** with `&showmode`, the director sees people grouped by role with
status-driven color; default view unchanged without the flag. **→ Code MET; live
browser validation is the one remaining user-owned item.**

**Known tradeoff (read-only phase):** moving the boxes out of the flat `#guestFeeds`
disables the legacy in-`#guestFeeds` drag-reorder / slot-lock ordering while
`&showmode` is active — acceptable for the console view; revisit if Phase 3 needs it.

## Phase 3 — Director console: promote/demote interactions

Shipped in the same `core/showmode/console.js` module — still no legacy edits. Each
guest box gets a lane-action bar that **drives the existing legacy controls**
rather than re-implementing them; the module cache-bust bumped to `?v=2`
(`podcast/bootstrap.js` → `index.js?v=2`; `index.js` → `console.js?v=2`).

- [x] Wire lane transitions to `changeGroup()` (`lib.js:56741`) + add/remove from
      the program scene. **→ `setGroupExclusive(uuid, group)` sets the caller's lane
      group exclusively (add target, drop the other two) by driving `changeGroup`
      with an explicit `state` — a detached `<button>` carries the
      `dataset.{group,UUID,sid}` it reads, so it is a *set*, not a toggle.
      `toggleProgramScene(box, on)` adds/removes the guest from program scene `0`
      via the legacy `directEnable()` toggle, gated on the button's `.value` so it
      is idempotent. On Air adds to scene; On Deck / Green remove.**
- [x] Controls: "Take → On Air", "↑ On Deck", "Hang up" (buttons first;
      drag-between-lanes as a stretch). **→ Four buttons per guest box:
      **Take On Air** / **Hold On Deck** / **To Green Room** / **Hang Up**. The
      current lane's button is highlighted (active) and the bar is non-destructive
      (appended as the box's last child; the box's own controls are untouched).
      Controls attach **only to caller boxes** — never the director, co-directors
      (`session.directorList`), or screenshare tiles, which are anchored On Air.
      **Hang Up clicks the box's own hangup button**, so the native
      confirm-with-block dialog runs (no silent disconnect). *Drag-between-lanes
      remains a deferred stretch.***
- [x] On Deck **pre-flight checks**: mic level, camera live. **→ On a box in the On
      Deck lane the bar shows mic + camera indicators that light green when live
      (`micLive`: the guest's `voiceMeter` is present and reporting a numeric
      level; `camLive`: the box has a playing `<video>` with real frame data).**
      *The "sees program feed only" check is deferred — it needs the caller's
      remote view state, which the director side does not currently mirror.*
- [x] Green Room detail: #position badges, hold timers, connection-quality bars,
      cam-off state — all from live stats. **→ A Green-Room box shows a `#N` queue
      position (its order within the lane) and a `m:ss` hold timer (time since the
      console first saw the guest). Connection quality is the Phase 2 corner dot
      (good/warn/bad from the 0–5 signal meter). *A dedicated cam-off badge is
      deferred; the On Deck `camLive` indicator already surfaces camera state at
      the point it matters most — the pre-flight before going live.***
- [ ] Live browser validation: with `&showmode`, promoting/demoting a caller
      actually re-groups them (and updates what they see) and the program-scene
      toggle tracks. **→ USER-OWNED: needs a live director + caller browser
      session; the group→view effect is the Phase 0 open item and can only be
      confirmed live.**

**Acceptance:** the director runs the whole show from the console — moving a caller
between lanes actually re-groups them and updates what they see. **→ Code MET
(interactions wired to `changeGroup` + `directEnable` + the native hangup);
the live group→view confirmation is the one remaining user-owned item.**

## Phase 4 — Caller-facing source control (the new capability)

Phase 0 verdict was **GREEN**, so the native path is what shipped. Per the user's
decision (open decision #3), Phase 4 shipped as the **console source bar** shape:
a native designation UI that drives the *existing, proven* screenshare `:s`
machinery rather than new WebRTC renegotiation, paired with the Phase-1
`&callerview` routing param. Built entirely in `core/showmode/console.js`
(module cache-bust bumped to `?v=3`); no legacy edits.

- [x] **Native "Caller-Facing Source" bar** at the top of the `&showmode` console
      (above the lanes). Two states — **None** / **Screen / Composite** — rendered
      as a segmented toggle that reflects the live second-stream state
      (`session.screenShareState`) and drives `toggleScreenShare()`
      (`lib.js:35329`) idempotently (only toggles when the desired state differs,
      so repeated clicks are safe). Publishing the composite as the director's
      screenshare rides `createSecondStream()` → `createSecondStream2(UUID)`
      end-to-end in `lib.js` — no `webrtc.js` access, exactly as the Phase 0 spike
      predicted.
- [x] **Live sid readout + one-click caller invite.** When a source is publishing,
      the bar shows the live caller-facing stream ID (`session.streamID + ":s"`) and
      enables a **Copy caller invite link** button. The link is the director UI's
      own guest link (`#director_block_1` `dataset.raw`, `main.js:28475` — already
      carries room / password / token / wss params) with `&callerview=<sid>`
      appended; it falls back to a bare `?room=<roomid>` link if the director link
      block is absent. Clipboard write uses `navigator.clipboard` with a
      `textarea`/`execCommand` fallback for insecure contexts. This closes the loop:
      the director designates the source in the UI, and the generated link
      auto-routes callers to it via the Phase-1 `&callerview` allowlist.
- [x] i18n: `showmode-source-title` / `-none` / `-screen` / `-copy` / `-copied` /
      `-hint` / `-hint-live` added to `translations/default.json` + `en.json`
      (`miscellaneous`); CI fills other locales. `node --check` clean on the module;
      `ci-validateTranslations.js` + `ci-checkTranslationKeys.js` pass (0 new
      missing keys).
- [ ] Live browser validation: with `&showmode`, the source bar publishes the
      composite as the `:s` second stream, the sid + copy link appear, and a caller
      opening the generated link sees only that source and hears the hosts.
      **→ USER-OWNED: needs a live director + caller browser session.**

**Deferred past this phase** (recorded, not shipped): a native **Camera / Media**
device picker that publishes a *distinct* getUserMedia second stream, and **live
auto-rerouting** of already-connected callers via a new director→caller signaling
message. Both need the wider Path-B plumbing (a second-stream slot independent of
screenshare, plus a new signaling path) and can only be validated live — deliberately
out of scope for the "drive the proven machinery" shape chosen for Phase 4.

**Acceptance:** the director designates the composite device shown to callers from
the UI (screenshare/composite source bar) and hands out a caller link that routes
to it. **→ Code MET; the live end-to-end validation is the one remaining
user-owned item.**

## Phase 5 — Polish, i18n, cache-bust, docs

- [x] `data-translate` / `getTranslation` keys for all new strings + base
      translation file entries (CI fills the rest). **→ Already complete: an audit
      of `core/showmode/console.js` confirmed every user-facing string (all 18,
      including the Phase 3 lane buttons and pre-flight indicators) routes through
      the module's `translate(key, fallback)` helper, and every key is present in
      **both** `translations/default.json` (flat) and `translations/en.json`
      (`miscellaneous`). No hardcoded strings, no called-but-missing keys. Nothing
      to add.**
- [x] Bump `?ver=` for `lib.js` / `main.js` (and any other touched file) in every
      HTML page that references them. **→ No legacy `?ver=` debt: Phases 2/3/4 made
      no `lib.js`/`main.js` edits, and the sole legacy edit (Phase 1's `&callerview`
      alias in `main.js`) already carried its bump in the same commit (index 1066,
      room 770). The module cache-bust `?v=` was instead bumped `3 → 4`
      (`podcast/bootstrap.js` → `index.js?v=4`; `index.js` → `console.js?v=4`)
      because the prettier pass below touched `console.js`.**
- [x] Prettier pass (tabs width 4, no reflow of long lines). **→ Ran
      `npx prettier --write core/showmode/console.js` (`index.js` / `bootstrap.js`
      were already compliant). Changes were purely cosmetic — double-quote
      normalization, long lines collapsed to `printWidth: 10000`, and prettier's
      canonical method-chain break on the clipboard call; no logic touched.
      `prettier --check` now clean on all three; ES-module syntax OK on all three;
      `ci-validateTranslations.js` + `ci-checkTranslationKeys.js` pass (0 new
      missing keys).**
- [x] Update `examples/` / note the new params where user-facing. **→ No valid
      in-repo target. The only URL-parameter catalog in the tree is `rawdoc.md`, a
      snapshot mirror of the external **docs.vdo.ninja** repo, which CLAUDE.md places
      out of scope ("End-user docs live at docs.vdo.ninja, not in this repo").
      `examples/` and `iframe.html` document the postMessage/IFRAME API, not
      view/routing params, so neither is the home for `&showmode` / `&callerview`.
      End-user docs for the two params belong at docs.vdo.ninja and are tracked as a
      separate, external follow-up.**

**Acceptance:** production-ready, translation-covered, cache-busted; ready for
`/ship` up the release tiers. **→ Code MET (i18n complete, module cache-busted,
prettier-clean, translation CI green). Remaining before/after `/ship` are the
user-owned **live browser validations** carried across Phases 0–4 (group→view
effect, caller routing, source-bar publish) — browser-only, not code-verifiable —
and the external docs.vdo.ninja param write-up.**

## Phase 6 — Co-host view, co-host invite, guest details

The user chose **"Option A"** for co-hosts: they join as a **normal room
participant** (publish cam + mic, heard as a host) — *not* as a co-director — and
get a **Zoom-style view**. Shipped as one new compound param, one new `core/`
module, and console extensions; module cache-bust bumped `4 → 5`
(`podcast/bootstrap.js` → `index.js?v=5`; `index.js` → `console.js?v=5` /
`cohost.js?v=5`). `main.js` gained a single flag block (`?ver=` bumped: index
1067, room 771). `lib.js` and `webrtc.js` untouched.

- [x] **`&cohost=<program stream id>` preset.** `main.js` (after the `&showmode`
      block) sets `session.cohost = <value> || true`; that is the only legacy hook.
      The value is the program feed's stream id — the director's screenshare `:s`
      stream, the same `session.streamID + ":s"` the Phase-4 source bar computes.
      The page must be `index.html` (it loads `podcast/bootstrap.js`); `room.html`
      does not load the module and simply shows the default guest view.
- [x] **Zoom-style layout** (`core/showmode/cohost.js`): the program feed pinned
      large below an 18 %-tall strip of thumbnails across the top (self first, the
      director's own cam next, then callers / other co-hosts in arrival order; up to
      8 thumbs, centred, ≤ 18 % wide each). **Why the layout is built at runtime
      rather than fixed in the URL:** `updateMixer` only draws streams that
      `session.layout` keys *explicitly* — un-keyed streams are hidden
      (`lib.js:8873`), and plain `layout[""]` entries without `iframeSrc` /
      media / `defaultStreamID` are skipped (`lib.js:8780`) — so a static
      `&layout` cannot express "everyone else". The module keys every live-video
      stream itself and re-applies via the legacy `updateMixer()` only when the
      set changes. Keying the guest's own `session.streamID` makes the legacy code
      fold the self-preview into the layout instead of the floating mini-preview
      (`lib.js:7223`). Until the program feed is present (or if the param value is
      empty and no `:s` stream is in the room) the default grid is left alone, so
      co-hosts see each other normally before the show starts.
- [x] **Copy co-host invite link** on the console source bar, beside the caller
      invite: `#director_block_1` `dataset.raw` + `&cohost=<sid>`. Unlike the
      caller button it is enabled as soon as the director's stream id is known —
      the co-host view degrades to the grid until the feed publishes, so the link
      can go out before the show.
- [x] **Guest details card** (`cohost.js`): display name (required), pronouns,
      social handle(s) (comma-separated, ≤ 5). Bottom-left card that collapses to a
      status pill ("Shared with the host" / "Will share when the host connects");
      remembered per browser (`localStorage`), name prefilled from `&label`.
- [x] **Transport — cloned from the label pattern, on the engine's generic pipe.**
      The `changeLabel` *send* is in `lib.js` but its *receive* is inside
      `webrtc.js` (off-limits) and unknown message keys are dropped there, so a new
      `sendMessage` field would never surface. The engine already exposes a
      generic pipe: `session.sendGenericData(data, UUID, streamID, type)` (wraps
      `sendMessage` / `sendRequest` / `sendPeers`; it is what the IFRAME API's
      `sendData` uses) arriving as `session.gotGenericData(data, UUID)` — a plain
      property on the session object. The guest sends
      `{ showmodeMeta: { name, pronouns, socials }, streamID }` with `type: "pcs"`
      (its viewers, which include the director), on save, when a new viewer
      appears (+ a 3 s settle re-send) and every 20 s. The console **wraps**
      `session.gotGenericData`: it stores the sanitised payload on
      `session.rpcs[UUID].showmodeMeta` (matching by UUID, or by the carried
      stream id when the message lands on a channel the console does not track),
      then defers to the original so the IFRAME `dataReceived` event and chat
      overlay keep working. Both sides strip markup/control chars and cap lengths;
      rendering is `textContent` only.
- [x] **Console rendering:** a `.sm-meta` row (name · pronouns · social chips) at
      the top of each guest box's action bar, hidden until details arrive.
- [x] i18n: 17 new `showmode-cohost-*` / `showmode-meta-title` keys in
      `translations/default.json` + `en.json` (`miscellaneous`); CI fills other
      locales. `ci-validateTranslations.js` + `ci-checkTranslationKeys.js` pass.
- [ ] Live browser validation. **→ USER-OWNED:** (1) with the director publishing
      the composite, a co-host opening the copied link sees it large with the
      strip on top, and the grid before it publishes; (2) the strip reflows as
      callers join/leave; (3) details saved on the co-host page appear in that
      guest's box on the `&showmode` console (and survive a director reload);
      (4) the copied link opens the right room with the right pass/token.

**Not done / follow-ups:** the guest's display name is *not* mirrored into the
legacy label (`session.label` + `changeLabel`) — the only in-repo sender of that
message is the director's own box, and its receive semantics are inside
`webrtc.js`, so it was left alone; revisit if the name should also drive OBS
`&showlabels`. The `"pcs"` route selector was inferred from the obfuscated
`sendGenericData` (`'rpcs'` → `sendRequest`, one literal → `sendMessage`, else
`sendPeers`); if the literal is not `"pcs"` the call falls through to
`sendPeers`, which still reaches the director — the stream-id fallback on the
console covers either channel.

---

## Open decisions (need the user)

1. **On Air lane composition:** permanent host + co-host anchors, or only
   what's currently broadcasting (empty until a caller is live)?
2. **Group naming / count:** three lanes (On Air / On Deck / Green Room) as drawn,
   or a different set?
3. ~~**Phase 4 preference if native is feasible:** device-picker in the console, or
   keep it param-driven for simplicity?~~ **RESOLVED:** console source bar that
   drives the proven screenshare `:s` machinery + generates a `&callerview` caller
   link (native designation UI, existing param routing). See Phase 4.
