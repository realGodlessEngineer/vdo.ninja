import { createElement } from "./dom-helpers.js?v=1";

// Help-modal controller for the podcast studio: owns the modal overlay that
// presents the static "Podcast Studio Guide" content. It lazily builds the
// overlay DOM on first open, reuses it on subsequent opens by toggling
// `dataset.visible`, and hides (not removes) it on close. There are no host
// seams — the guide content is fully static — so the host simply drives
// open()/close() and tears the node down through dispose().
export class HelpModalController {
	constructor() {
		this.overlay = null;
	}

	open() {
		if (this.overlay) {
			this.overlay.dataset.visible = "true";
			return;
		}

		const overlay = createElement("div", "help-overlay");
		overlay.dataset.visible = "true";
		overlay.dataset.podcastOverlay = "true"; // Prevent CSS from hiding it
		this.overlay = overlay;

		const panel = createElement("div", "help-overlay__panel");

		const header = createElement("div", "help-overlay__header");
		const title = createElement("h2", "help-overlay__title", { text: "Podcast Studio Guide" });
		const closeButton = createElement("button", "help-overlay__close", { type: "button", text: "✕", title: "Close" });
		closeButton.addEventListener("click", () => this.close());
		header.append(title, closeButton);

		const content = createElement("div", "help-overlay__content");

		const sections = [
			{
				title: "Getting Started",
				content: `
          <p>The Podcast Studio is a specialized interface for recording multi-track audio from remote guests.</p>
          <ul>
            <li><strong>Create a room</strong> — Enter a room name and optional password</li>
            <li><strong>Share the invite link</strong> — Guests join via the generated link</li>
            <li><strong>Review Capture / Backup / Save</strong> — The summary card tells you what is being captured, whether live guest backup is active, and where files save after stop</li>
            <li><strong>Start Recording</strong> — Each guest's audio is captured as a separate WAV file, or audio + video if you enable the experimental capture mode</li>
          </ul>
          <p>All audio is recorded locally in your browser — nothing is uploaded unless you link cloud storage.</p>
        `
			},
			{
				title: "Session Markers",
				content: `
          <p>Markers are cue points you can drop during recording to mark important moments.</p>
          <ul>
            <li><strong>Manual markers</strong> — Click "Marker" to drop a cue at the current time</li>
            <li><strong>Auto sync markers</strong> — Dropped automatically ~1 second into recording for alignment</li>
            <li><strong>Join sync markers</strong> — Created when a guest joins mid-recording</li>
          </ul>
          <p><strong>WAV cue points:</strong> Markers are embedded directly in the WAV files as standard cue chunks. Compatible with:</p>
          <ul>
            <li>Adobe Audition, Audacity, Reaper, Pro Tools</li>
            <li>Most DAWs that support WAV cue/region markers</li>
          </ul>
          <p><strong>CSV export:</strong> Use "Export CSV" or "Copy CSV" to get markers in spreadsheet format for reference or importing into editors that don't read WAV cues.</p>
        `
			},
			{
				title: "Late Joiners & Reconnects",
				content: `
          <p>If a guest joins or reconnects while recording is in progress:</p>
          <ul>
            <li>Their audio is automatically added to the recording</li>
            <li>A sync marker is dropped ~1 second after they join</li>
            <li>Their track appears in the timeline with a "Late join" badge</li>
          </ul>
          <p><strong>Syncing in post:</strong> Each track's markers are adjusted relative to when that track started. Use the shared sync markers to align tracks in your editor.</p>
          <p>Experimental video ISO capture keeps the same late-join offsets, but longer runs will use much more memory than audio-only sessions.</p>
        `
			},
			{
				title: "Cloud Backup",
				content: `
          <p>Link Google Drive or Dropbox to save host-side recordings after the session ends.</p>
          <p><strong>Google Drive:</strong></p>
          <ul>
            <li>Uploads complete files after recording stops</li>
            <li>Files appear in a "VDO.Ninja Recordings" folder</li>
          </ul>
          <p><strong>Dropbox:</strong></p>
          <ul>
            <li>Supports chunked uploads for large files</li>
            <li>More reliable for longer recordings</li>
            <li>Can paste a token manually if popup is blocked</li>
          </ul>
          <p><strong>Guest backup:</strong> The "Enable guest backup" control asks every connected guest to self-record directly into your Google Drive. A guest only counts as backed up after they confirm the browser prompt.</p>
          <p>Both services are optional — recordings are always available for local download.</p>
        `
			},
			{
				title: "Video Recording",
				content: `
          <p>The studio focuses on audio ISO recording, but video options exist:</p>
          <ul>
            <li><strong>Audio + Video ISO</strong> - Add <code>?studiovideo=1</code> to the studio URL to expose the experimental capture mode in the destinations card</li>
            <li><strong>Record Group</strong> - Opens a popup with the combined scene for screen recording</li>
            <li><strong>Individual video workflow</strong> - <a href="https://www.youtube.com/watch?v=s5shpEqLZbM" target="_blank" rel="noopener">See video guide ↗</a></li>
          </ul>
          <p>The studio video ISO mode is still memory-heavy because files finalize after stop. For the most resilient long-form runs, guests can still use <code>&record</code> in their URL or the remote recording features in the classic VDO.Ninja interface.</p>
        `
			},
			{
				title: "Recording Model",
				content: `
          <p>The studio now separates recording into three questions:</p>
          <ul>
            <li><strong>Capture</strong> - Audio ISO by default, or experimental Audio + Video ISO with <code>?studiovideo=1</code></li>
            <li><strong>Backup</strong> - "Enable guest backup" requests guest-side self-recording directly into your Google Drive</li>
            <li><strong>Save</strong> - Host-side downloads and cloud uploads still finalize after recording stops</li>
          </ul>
          <p><strong>Important:</strong> A linked destination is not the same as a live backup. The summary warning stays yellow until guest backups are actually confirmed.</p>
        `
			},
			{
				title: "Live Captions",
				content: `
          <p>VDO.Ninja supports real-time speech-to-text captions:</p>
          <ul>
            <li><strong>Enable captions</strong> — Add <code>&transcribe</code> to a guest's URL to enable browser-based speech recognition</li>
            <li><strong>Display captions</strong> — Use <code>&showcc</code> on the viewer/scene URL to display incoming captions</li>
            <li><strong>Overlay in OBS</strong> — Captions can be displayed as a text overlay in your stream</li>
          </ul>
          <p>Captions are processed locally in the browser using the Web Speech API — no third-party services required.</p>
        `
			},
			{
				title: "Tips & Troubleshooting",
				content: `
          <ul>
            <li><strong>No audio?</strong> — Ensure guests have granted microphone permission</li>
            <li><strong>Tracks missing?</strong> — Check that guests joined before hitting Record, or they'll appear as late joiners</li>
            <li><strong>Large files?</strong> — Use Dropbox for chunked uploads, or download locally</li>
            <li><strong>Browser support:</strong> — Chrome/Edge recommended. Firefox/Safari may have limitations</li>
          </ul>
        `
			}
		];

		sections.forEach(section => {
			const item = createElement("details", "help-section");
			const summary = createElement("summary", "help-section__title", { text: section.title });
			const body = createElement("div", "help-section__body");
			body.innerHTML = section.content;
			item.append(summary, body);
			content.append(item);
		});

		// Open first section by default
		const firstSection = content.querySelector("details");
		if (firstSection) {
			firstSection.open = true;
		}

		panel.append(header, content);
		overlay.append(panel);

		overlay.addEventListener("click", event => {
			if (event.target === overlay) {
				this.close();
			}
		});

		document.body.appendChild(overlay);
	}

	close() {
		if (this.overlay) {
			this.overlay.dataset.visible = "false";
		}
	}

	dispose() {
		if (this.overlay && this.overlay.parentNode) {
			this.overlay.parentNode.removeChild(this.overlay);
		}
		this.overlay = null;
	}
}
