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

- [ ] **Caller active-call room:** `&directoronly&showonly=<host program stream id>`.
      Optionally bundle behind a preset param (e.g. `&callerview`) that expands to
      the pair, so a caller invite link is short.
- [ ] **Co-host room:** shared group + `&codirector` + `&showonly=<clean host cam id>`
      so the co-host sees the clean cam, not the composite (avoids mirror-in-mirror).
- [ ] Document the stream-ID prerequisite (host publishes a stable ID via `&push=`).
- [ ] Validate the whole flow live end-to-end (this is the "Path A works today" step).

**Acceptance:** a real show can run — caller sees only the program feed + hears both
hosts; co-host sees clean host cam + self equally; queue stays private.

## Phase 2 — Director console: lane layout (read-only)

- [ ] Build the lane container (On Air / On Deck / Green Room) as the `&showmode`
      director view; CSS lifted from the mockup, on `main.css` tokens.
- [ ] Map **groups → lanes** (each lane backed by a group membership). Define the
      canonical group names (e.g. `onair`, `ondeck`, `green`).
- [ ] Render existing per-guest tiles into their lane by group membership instead
      of the flat list; reuse existing guest controls/markup.
- [ ] **Status-based coloring** replacing room-color: live (in program/scene),
      talking (audio-level bus, `core/`), connection quality (existing stats).
- [ ] Read-only first: correct placement + visual language, no promote/demote yet.

**Acceptance:** with `&showmode`, the director sees people grouped by role with
status-driven color; default view unchanged without the flag.

## Phase 3 — Director console: promote/demote interactions

- [ ] Wire lane transitions to `changeGroup()` (`lib.js:56741`) + add/remove from
      the program scene.
- [ ] Controls: "Take → On Air", "↑ On Deck", "Hang up" (buttons first;
      drag-between-lanes as a stretch).
- [ ] On Deck **pre-flight checks**: mic level, camera live, "sees program feed only".
- [ ] Green Room detail: #position badges, hold timers, connection-quality bars,
      cam-off state — all from live stats.

**Acceptance:** the director runs the whole show from the console — moving a caller
between lanes actually re-groups them and updates what they see.

## Phase 4 — Caller-facing source control (the new capability)

Shape depends on the Phase 0 verdict:

- [ ] **If the `:s` publish path is reachable outside `webrtc.js`:** native director
      "caller-facing source" selector (Camera / Screen / Media) that publishes the
      chosen device as the second stream and auto-routes callers to it via `showonly`.
      This is the source bar in the mockup.
- [ ] **If it crosses into `webrtc.js`:** ship the documented two-publisher recipe
      (clean cam + composite as separate pushes) plus a `&callercam=<id>` param that
      auto-applies the caller routing, and record the native selector as blocked on
      engine access.

**Acceptance:** the director designates the composite device shown to callers —
from the UI if feasible, otherwise via a first-class param + recipe.

## Phase 5 — Polish, i18n, cache-bust, docs

- [ ] `data-translate` / `getTranslation` keys for all new strings + base
      translation file entries (CI fills the rest).
- [ ] Bump `?ver=` for `lib.js` / `main.js` (and any other touched file) in every
      HTML page that references them.
- [ ] Prettier pass (tabs width 4, no reflow of long lines).
- [ ] Update `examples/` / note the new params where user-facing.

**Acceptance:** production-ready, translation-covered, cache-busted; ready for
`/ship` up the release tiers.

---

## Open decisions (need the user)

1. **On Air lane composition:** permanent host + co-host anchors, or only
   what's currently broadcasting (empty until a caller is live)?
2. **Group naming / count:** three lanes (On Air / On Deck / Green Room) as drawn,
   or a different set?
3. **Phase 4 preference if native is feasible:** device-picker in the console, or
   keep it param-driven for simplicity?
