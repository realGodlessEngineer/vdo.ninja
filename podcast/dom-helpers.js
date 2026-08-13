export function injectStylesheet() {
	if (document.getElementById("podcast-studio-style")) {
		return;
	}
	const link = document.createElement("link");
	link.id = "podcast-studio-style";
	link.rel = "stylesheet";
	link.href = new URL("./studio.css?v=15", import.meta.url).toString();
	document.head.appendChild(link);
}

export function createElement(tag, className, attrs = {}) {
	const el = document.createElement(tag);
	if (className) {
		el.className = className;
	}
	Object.entries(attrs).forEach(([key, value]) => {
		if (value === undefined || value === null) {
			return;
		}
		if (key === "text") {
			el.textContent = value;
		} else {
			el.setAttribute(key, value);
		}
	});
	return el;
}

export function makeCollapsible(panel, title, storageKey = null) {
	panel.dataset.collapsible = "true";

	// Add title h2 if provided and panel doesn't already have one
	if (title && !panel.querySelector("h2")) {
		const h2 = createElement("h2", "", { text: title });
		panel.insertBefore(h2, panel.firstChild);
	}

	// Create toggle button (will be positioned absolute in top right via CSS)
	const toggle = createElement("button", "panel-collapse-toggle", { type: "button", text: "−", title: "Collapse section" });

	// Load saved state
	let collapsed = false;
	if (storageKey) {
		try {
			collapsed = localStorage.getItem(storageKey) === "true";
		} catch (e) {}
	}

	const updateState = () => {
		panel.dataset.collapsed = collapsed ? "true" : "false";
		toggle.textContent = collapsed ? "+" : "−";
		toggle.title = collapsed ? "Expand section" : "Collapse section";
		if (storageKey) {
			try {
				localStorage.setItem(storageKey, collapsed ? "true" : "false");
			} catch (e) {}
		}
	};

	toggle.addEventListener("click", () => {
		collapsed = !collapsed;
		updateState();
	});

	panel.appendChild(toggle);
	updateState();

	return { toggle };
}
