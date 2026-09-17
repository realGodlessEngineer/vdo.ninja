// Show-mode guest-intake modal.
//
// Loaded on demand by main.js when the director-set `&intake` param is present,
// at the existing name-collection point (before the publish gate). It replaces
// the plain "enter your display name" prompt with ONE combined card that
// collects four fields for every guest who queues up:
//
//   Name (required) · Pronouns (optional) · Religious Position (a searchable,
//   list-constrained field) · Topic (optional).
//
// It returns the collected object to main.js, which seeds session.label /
// session.meta, mirrors the Phase 6 co-host pipe so the director console can
// render the details, and POSTs them to the server's /api/showmode/queue store.
//
// Kept as a small ES module (the newer core/ style) specifically so lib.js is
// left untouched; it only REUSES lib.js's .promptModal / .opaqueBackdrop CSS and
// the global getTranslation()/sanitizeLabel helpers. No legacy source changes.

// Operator-editable curated list. This is a counter-apologetics / debate show,
// so the set spans non-theistic and secular positions, major-religion theistic
// positions, and common debate stances, with "Other" and "Prefer not to say"
// last so the constraint never traps a guest. Edit this array to tune the
// options; the Religious Position field filters against it as the guest types
// and normalizes a typed value back to a canonical entry on submit.
const RELIGIOUS_POSITIONS = ["Atheist", "Agnostic", "Agnostic Atheist", "Anti-theist", "Secular Humanist", "Skeptic", "Freethinker", "Ignostic", "Deist", "Pantheist", "Spiritual but not religious", "Christian — Catholic", "Christian — Protestant/Evangelical", "Christian — Orthodox", "Christian — Nondenominational", "Christian — Mormon (LDS)", "Christian — Jehovah's Witness", "Muslim — Sunni", "Muslim — Shia", "Jewish", "Hindu", "Buddhist", "Sikh", "Baháʼí", "Jain", "Pagan/Wiccan", "Unitarian Universalist", "Satanist (LaVeyan/TST)", "Other", "Prefer not to say"];

// Field length caps, applied on submit. Mirrors the server's FIELD_CAPS
// (server.js) so what the guest can enter matches what the endpoint will store.
const LIMITS = { name: 64, pronouns: 40, religiousPosition: 80, topic: 200 };

const STYLE_ID = "showmode-intake-styles";
const BACKDROP_ID = "showmode-intake-backdrop";
const MODAL_ID = "intakeModal";
const DATALIST_ID = "showmode-intake-positions";

// Resolve an i18n string, preferring the real translation and falling back to a
// clean English literal (getTranslation degrades to a de-hyphenated key). Same
// helper shape as core/showmode/console.js / cohost.js.
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

function injectStyles() {
	if (document.getElementById(STYLE_ID)) {
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = INTAKE_CSS;
	document.head.appendChild(style);
}

// Trim then hard-cap a free-text field.
function trimCap(value, cap) {
	return (typeof value === "string" ? value : "").trim().slice(0, cap);
}

// Match a typed Religious Position back to a canonical list entry (case-
// insensitive). Empty is allowed (optional field); a non-empty off-list value is
// rejected so the field stays constrained. { ok, value } — value is the
// canonical form when matched.
function normalizePosition(raw) {
	const value = (typeof raw === "string" ? raw : "").trim();
	if (!value) {
		return { ok: true, value: "" };
	}
	const lowered = value.toLowerCase();
	const match = RELIGIOUS_POSITIONS.find(option => option.toLowerCase() === lowered);
	if (match) {
		return { ok: true, value: match };
	}
	return { ok: false, value };
}

// Build one labelled control and return { field, input }. `input` is the
// interactive element (input or textarea) so callers can read/focus it.
function buildField(labelText, control, id, hintText) {
	const field = document.createElement("div");
	field.className = "smi-field";

	const label = document.createElement("label");
	label.className = "smi-label";
	label.setAttribute("for", id);
	label.textContent = labelText;
	field.appendChild(label);

	control.id = id;
	control.className = "smi-input";
	field.appendChild(control);

	if (hintText) {
		const hint = document.createElement("div");
		hint.className = "smi-hint";
		hint.textContent = hintText;
		field.appendChild(hint);
	}

	return { field, input: control };
}

// Show the single blocking intake card and resolve with the collected,
// trimmed/normalized details once the guest submits a valid Name.
export function collectGuestIntake() {
	return new Promise(resolve => {
		injectStyles();

		const backdrop = document.createElement("div");
		backdrop.className = "opaqueBackdrop";
		backdrop.id = BACKDROP_ID;
		backdrop.style.zIndex = "2147483646";

		const modal = document.createElement("div");
		modal.className = "promptModal";
		modal.id = MODAL_ID;
		modal.style.zIndex = "2147483647";
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-labelledby", "smi-title");

		const inner = document.createElement("div");
		inner.className = "promptModalInner";

		const form = document.createElement("form");
		form.className = "smi-form";
		form.setAttribute("novalidate", "novalidate");

		const title = document.createElement("h2");
		title.className = "smi-title";
		title.id = "smi-title";
		title.textContent = translate("intake-title", "Join the show");
		form.appendChild(title);

		const subtitle = document.createElement("p");
		subtitle.className = "smi-subtitle";
		subtitle.textContent = translate("intake-subtitle", "Tell us a little about yourself before you go live.");
		form.appendChild(subtitle);

		// Name — required.
		const nameInput = document.createElement("input");
		nameInput.type = "text";
		nameInput.maxLength = LIMITS.name;
		nameInput.autocomplete = "name";
		nameInput.placeholder = translate("intake-name-placeholder", "How you'd like to be introduced");
		nameInput.setAttribute("aria-required", "true");
		const nameField = buildField(translate("intake-name", "Name"), nameInput, "smi-name");
		form.appendChild(nameField.field);

		// Pronouns — optional.
		const pronounsInput = document.createElement("input");
		pronounsInput.type = "text";
		pronounsInput.maxLength = LIMITS.pronouns;
		pronounsInput.autocomplete = "off";
		pronounsInput.placeholder = translate("intake-pronouns-placeholder", "e.g. she/her, they/them");
		const pronounsField = buildField(translate("intake-pronouns", "Pronouns"), pronounsInput, "smi-pronouns");
		form.appendChild(pronounsField.field);

		// Religious Position — searchable, constrained to the curated list via a
		// native datalist (dependency-free type-to-filter, keyboard-accessible).
		const positionInput = document.createElement("input");
		positionInput.type = "text";
		positionInput.maxLength = LIMITS.religiousPosition;
		positionInput.autocomplete = "off";
		positionInput.setAttribute("list", DATALIST_ID);
		positionInput.placeholder = translate("intake-position-placeholder", "Search or pick your position");
		const positionField = buildField(translate("intake-position", "Religious Position"), positionInput, "smi-position", translate("intake-position-hint", "Start typing to filter the list."));

		const datalist = document.createElement("datalist");
		datalist.id = DATALIST_ID;
		RELIGIOUS_POSITIONS.forEach(option => {
			const el = document.createElement("option");
			el.value = option; // constant list values, not user text
			datalist.appendChild(el);
		});
		positionField.field.appendChild(datalist);
		form.appendChild(positionField.field);

		// Topic — optional, free text.
		const topicInput = document.createElement("textarea");
		topicInput.maxLength = LIMITS.topic;
		topicInput.rows = 2;
		topicInput.placeholder = translate("intake-topic-placeholder", "What would you like to discuss?");
		const topicField = buildField(translate("intake-topic", "Topic"), topicInput, "smi-topic");
		form.appendChild(topicField.field);

		// Validation message (aria-live so a screen reader announces it).
		const error = document.createElement("div");
		error.className = "smi-error";
		error.setAttribute("role", "alert");
		error.setAttribute("aria-live", "assertive");
		form.appendChild(error);

		const submit = document.createElement("button");
		submit.type = "submit";
		submit.className = "smi-submit";
		submit.textContent = translate("intake-submit", "Join the show");
		form.appendChild(submit);

		function showError(message, focusEl) {
			error.textContent = message;
			error.classList.add("smi-error--on");
			if (focusEl) {
				focusEl.focus();
			}
		}

		function clearError() {
			error.textContent = "";
			error.classList.remove("smi-error--on");
		}

		nameInput.addEventListener("input", clearError);
		positionInput.addEventListener("input", clearError);

		form.addEventListener("submit", event => {
			event.preventDefault();

			const name = trimCap(nameInput.value, LIMITS.name);
			if (!name) {
				showError(translate("intake-name-required", "Please enter your name to continue."), nameInput);
				return;
			}

			const position = normalizePosition(positionInput.value);
			if (!position.ok) {
				showError(translate("intake-position-invalid", "Please choose an option from the list."), positionInput);
				return;
			}

			const result = {
				name,
				pronouns: trimCap(pronounsInput.value, LIMITS.pronouns),
				religiousPosition: trimCap(position.value, LIMITS.religiousPosition),
				topic: trimCap(topicInput.value, LIMITS.topic)
			};

			backdrop.remove();
			modal.remove();
			resolve(result);
		});

		inner.appendChild(form);
		modal.appendChild(inner);
		document.body.appendChild(backdrop);
		document.body.appendChild(modal);

		// Focus the first field once painted.
		try {
			nameInput.focus();
		} catch (err) {
			/* focus is best-effort */
		}
	});
}

// Scoped to #intakeModal so nothing leaks into the default UI. The card itself
// reuses lib.js's .promptModal / .opaqueBackdrop positioning; these rules lay
// out the form and give the inputs a modern, high-contrast, mobile-friendly look
// that reads on both the light and dark theme cards.
const INTAKE_CSS = `
#intakeModal.promptModal {
	width: min(460px, 94vw);
	max-width: 94vw;
	font-weight: normal;
	text-align: left;
}
#intakeModal .promptModalInner {
	padding: 22px 24px 24px;
	max-height: 90vh;
	overflow-y: auto;
}
#intakeModal .smi-form {
	display: flex;
	flex-direction: column;
	gap: 14px;
}
#intakeModal .smi-title {
	margin: 0;
	font-size: 1.35em;
	font-weight: 700;
}
#intakeModal .smi-subtitle {
	margin: -6px 0 2px;
	font-size: 0.92em;
	opacity: 0.8;
}
#intakeModal .smi-field {
	display: flex;
	flex-direction: column;
	gap: 5px;
}
#intakeModal .smi-label {
	font-size: 0.9em;
	font-weight: 600;
}
#intakeModal .smi-input {
	width: 100%;
	box-sizing: border-box;
	padding: 10px 12px;
	font-size: 1em;
	font-family: inherit;
	color: #14161a;
	background: #ffffff;
	border: 1px solid #b4bac4;
	border-radius: 8px;
	outline: none;
	transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
#intakeModal textarea.smi-input {
	resize: vertical;
	min-height: 44px;
}
#intakeModal .smi-input:focus {
	border-color: #3487f1;
	box-shadow: 0 0 0 3px rgba(52, 135, 241, 0.28);
}
#intakeModal .smi-input::placeholder {
	color: #8a929e;
}
#intakeModal .smi-hint {
	font-size: 0.8em;
	opacity: 0.7;
}
#intakeModal .smi-error {
	display: none;
	font-size: 0.88em;
	font-weight: 600;
	color: #b3261e;
	background: rgba(179, 38, 30, 0.1);
	border-radius: 6px;
	padding: 8px 10px;
}
#intakeModal .smi-error--on {
	display: block;
}
#intakeModal .smi-submit {
	margin-top: 4px;
	padding: 12px 16px;
	font-size: 1.02em;
	font-weight: 700;
	font-family: inherit;
	color: #ffffff;
	background: #3487f1;
	border: none;
	border-radius: 8px;
	cursor: pointer;
	transition: background 0.12s ease;
}
#intakeModal .smi-submit:hover {
	background: #2f78d6;
}
#intakeModal .smi-submit:focus-visible {
	outline: 3px solid rgba(52, 135, 241, 0.5);
	outline-offset: 2px;
}
`;
