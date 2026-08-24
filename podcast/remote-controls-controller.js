import { createElement } from "./dom-helpers.js?v=1";

// Remote-controls controller for the podcast studio: owns the modal overlay that
// hosts the legacy per-guest director controls. It lazily builds the overlay DOM,
// relocates the legacy `container_<uuid>` node into the overlay while open, and
// restores that node to its original position on close. The host injects a single
// seam for reading the participant's roster item (used only for the header label),
// then drives the overlay through open()/close()/closeIfActive()/dispose().
export class RemoteControlsController {
	constructor({ getRosterItem = () => null } = {}) {
		this.getRosterItem = getRosterItem;

		this.overlay = null;
		this.overlayContent = null;
		this.controlState = {
			activeUuid: null,
			element: null,
			placeholder: null,
			wrapper: null
		};
	}

	ensureOverlay() {
		if (this.overlay && this.overlayContent) {
			return this.overlay;
		}
		const overlay = createElement("div", "remote-overlay");
		overlay.dataset.podcastOverlay = "true";
		overlay.dataset.visible = "false";

		const panel = createElement("div", "remote-overlay__panel");
		const header = createElement("div", "remote-overlay__header");
		const title = createElement("h3", "remote-overlay__title", { text: "Remote controls" });
		const closeButton = createElement("button", "remote-overlay__close", { type: "button", text: "Close", title: "Close remote controls." });
		closeButton.addEventListener("click", () => this.close());
		header.append(title, closeButton);

		const body = createElement("div", "remote-overlay__body");
		panel.append(header, body);
		overlay.append(panel);

		overlay.addEventListener("click", event => {
			if (event.target === overlay) {
				this.close();
			}
		});

		document.body.appendChild(overlay);
		this.overlay = overlay;
		this.overlayContent = body;
		return overlay;
	}

	restore() {
		const state = this.controlState;
		if (!state || !state.element) {
			if (this.overlay) {
				delete this.overlay.dataset.activeUuid;
			}
			return;
		}
		const { element, placeholder, wrapper } = state;
		try {
			if (wrapper && wrapper.parentNode) {
				wrapper.parentNode.removeChild(wrapper);
			}
		} catch (error) {
			console.warn("Failed to remove remote controls wrapper", error);
		}
		if (placeholder && placeholder.parentNode) {
			try {
				placeholder.parentNode.insertBefore(element, placeholder);
				placeholder.parentNode.removeChild(placeholder);
			} catch (error) {
				console.warn("Failed to restore remote controls container", error);
			}
		}
		this.controlState = {
			activeUuid: null,
			element: null,
			placeholder: null,
			wrapper: null
		};
		if (this.overlay) {
			delete this.overlay.dataset.activeUuid;
		}
	}

	open(uuid) {
		if (!uuid) {
			return;
		}
		if (this.controlState?.activeUuid && this.controlState.activeUuid !== uuid) {
			this.restore();
		}
		const overlay = this.ensureOverlay();
		const body = this.overlayContent;
		if (!overlay || !body) {
			return;
		}
		body.innerHTML = "";

		const rosterNode = this.getRosterItem(uuid);
		let label = "";
		if (rosterNode) {
			const nameNode = rosterNode.querySelector(".roster-name");
			label = nameNode ? nameNode.textContent : "";
		}
		const headerTitle = overlay.querySelector(".remote-overlay__title");
		if (headerTitle) {
			headerTitle.textContent = label ? `Remote controls • ${label}` : "Remote controls";
		}

		const existingState = this.controlState || {};
		if (existingState.activeUuid && existingState.activeUuid === uuid && existingState.wrapper) {
			body.append(existingState.wrapper);
			overlay.dataset.visible = "true";
			overlay.dataset.activeUuid = uuid;
			return;
		}

		const source = document.getElementById(`container_${uuid}`);
		if (!source) {
			body.append(
				createElement("div", "remote-overlay__empty", {
					text: "Legacy director controls are still loading. Try again once the guest is fully connected."
				})
			);
			overlay.dataset.visible = "true";
			overlay.dataset.activeUuid = uuid;
			return;
		}

		const placeholder = document.createElement("div");
		placeholder.dataset.podcastPlaceholder = "remote-controls";
		source.parentNode?.insertBefore(placeholder, source);

		source.classList.remove("hidden");

		const wrapper = createElement("div", "remote-overlay__legacy");
		wrapper.dataset.uuid = uuid;
		wrapper.append(source);
		body.append(wrapper);

		this.controlState = {
			activeUuid: uuid,
			element: source,
			placeholder,
			wrapper
		};

		overlay.dataset.visible = "true";
		overlay.dataset.activeUuid = uuid;
	}

	close() {
		if (!this.overlay) {
			return;
		}
		this.restore();
		this.overlay.dataset.visible = "false";
		if (this.overlayContent) {
			this.overlayContent.innerHTML = "";
		}
	}

	closeIfActive(uuid) {
		if (this.overlay && this.overlay.dataset.activeUuid === uuid) {
			this.close();
		}
	}

	dispose() {
		this.restore();
		if (this.overlay && this.overlay.parentNode) {
			this.overlay.parentNode.removeChild(this.overlay);
		}
		this.overlay = null;
		this.overlayContent = null;
	}
}
