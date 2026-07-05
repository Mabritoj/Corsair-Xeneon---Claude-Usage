"use strict";

// ---------------------------------------------------------------------------
// Claude Usage widget for the Corsair Xeneon Edge.
// Polls the local bridge (http://127.0.0.1:<port>/usage) every minute and
// renders session + weekly usage. Countdowns tick every second locally.
// ---------------------------------------------------------------------------

var FETCH_TIMEOUT_MS = 8000;
var DEFAULTS = {
	bridgePort: "37650",
	pollSeconds: "60",
	accentColor: "#D97757",
	textColor: "#F5F4F2",
	backgroundColor: "#1B1A19",
	maxModels: "3",
};

// Font-fit bounds (px) for the root font size that all rem sizes derive from.
var FONT_MIN_PX = 10;
var FONT_MAX_PX = 20;

var state = {
	data: null, // last good normalized payload
	resetRefs: [], // [{ el, resets_at }]
	pollTimer: null,
	tickTimer: null,
	started: false,
	resizeObserver: null,
};

// Read an iCUE property (injected as a global) with a fallback.
function prop(name) {
	try {
		if (typeof window !== "undefined" && window[name] !== undefined && window[name] !== null && window[name] !== "") {
			return window[name];
		}
	} catch (e) {}
	return DEFAULTS[name];
}

function $(id) {
	return document.getElementById(id);
}

function applyTheme() {
	var root = document.documentElement.style;
	root.setProperty("--accent", prop("accentColor"));
	root.setProperty("--text", prop("textColor"));
	root.setProperty("--bg", prop("backgroundColor"));
}

function statusClass(pct) {
	if (pct >= 90) return "danger";
	if (pct >= 75) return "warn";
	return "ok";
}

function fmtPct(pct) {
	if (pct === null || pct === undefined || isNaN(pct)) return "--";
	return Math.round(pct) + "%";
}

function fmtCountdown(resetsAt) {
	if (!resetsAt) return "";
	var target = new Date(resetsAt).getTime();
	if (isNaN(target)) return "";
	var diff = target - Date.now();
	if (diff <= 0) return "resets now";
	var mins = Math.floor(diff / 60000);
	var days = Math.floor(mins / 1440);
	var hours = Math.floor((mins % 1440) / 60);
	var m = mins % 60;
	if (days > 0) return "resets in " + days + "d " + hours + "h";
	if (hours > 0) return "resets in " + hours + "h " + m + "m";
	return "resets in " + m + "m";
}

function makeRow(label, bucket) {
	var pct = bucket && typeof bucket.utilization === "number" ? bucket.utilization : 0;

	var row = document.createElement("div");
	row.className = "row";

	var top = document.createElement("div");
	top.className = "row-top";

	var lbl = document.createElement("span");
	lbl.className = "row-label";
	lbl.textContent = label;

	var pctEl = document.createElement("span");
	pctEl.className = "row-pct";
	pctEl.textContent = fmtPct(bucket ? bucket.utilization : null);

	top.appendChild(lbl);
	top.appendChild(pctEl);

	var bar = document.createElement("div");
	bar.className = "bar";
	var fill = document.createElement("div");
	fill.className = "bar-fill " + statusClass(pct);
	// Defer width so the CSS transition animates from 0.
	requestAnimationFrame(function () {
		fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
	});
	bar.appendChild(fill);

	var reset = document.createElement("div");
	reset.className = "row-reset";
	if (bucket && bucket.resets_at) {
		reset.textContent = fmtCountdown(bucket.resets_at);
	} else if (pct === 0) {
		// No reset window and nothing used yet (mirrors "You haven't used X yet").
		reset.textContent = "not used yet";
	} else {
		reset.textContent = "";
	}

	row.appendChild(top);
	row.appendChild(bar);
	row.appendChild(reset);

	if (bucket && bucket.resets_at) {
		state.resetRefs.push({ el: reset, resets_at: bucket.resets_at });
	}
	return row;
}

function showMessage(text) {
	var msg = $("message");
	msg.textContent = text;
	msg.classList.remove("hidden");
}

function hideMessage() {
	$("message").classList.add("hidden");
}

function setStatus(kind, title) {
	var dot = $("status-dot");
	dot.className = "status-dot " + kind;
	dot.title = title || "";
}

function render(data) {
	state.data = data;
	state.resetRefs = [];

	var rows = $("rows");
	rows.innerHTML = "";

	if (data.session) {
		rows.appendChild(makeRow("Current Session", data.session));
	}
	if (data.weeklyAll) {
		rows.appendChild(makeRow("Weekly \u2014 All Models", data.weeklyAll));
	}
	if (Array.isArray(data.models)) {
		var cap = getMaxModels();
		data.models.slice(0, cap).forEach(function (m) {
			rows.appendChild(makeRow("Weekly \u2014 " + m.label, m));
		});
	}

	var updated = $("updated");
	var when = data.fetchedAt ? new Date(data.fetchedAt) : new Date();
	updated.textContent = "updated " + when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

	if (data.stale) {
		setStatus("stale", "Showing cached data");
	} else {
		setStatus("online", "Live");
	}
	$("widget").classList.remove("dim");
	hideMessage();

	// Row count changed; refit the text to the tile.
	fitFont();
}

// Number of scoped (per-model) rows to display. User-configurable via iCUE.
// NOTE: must not be named `maxModels` — iCUE injects the `maxModels` property
// as a global, and a same-named function declaration is a redeclaration error.
function getMaxModels() {
	var n = parseInt(String(prop("maxModels")).replace(/[^0-9]/g, ""), 10);
	if (isNaN(n)) n = parseInt(DEFAULTS.maxModels, 10);
	return Math.max(0, Math.min(8, n));
}

// Poll interval in ms. User-configurable via iCUE (seconds).
// NOTE: must not be named `pollSeconds` — iCUE injects the `pollSeconds`
// property as a global, and a same-named declaration is a redeclaration error.
function getPollMs() {
	var n = parseInt(String(prop("pollSeconds")).replace(/[^0-9]/g, ""), 10);
	if (isNaN(n)) n = parseInt(DEFAULTS.pollSeconds, 10);
	n = Math.max(10, Math.min(3600, n)); // keep >= fetch timeout (8s), cap at 1h
	return n * 1000;
}

// (Re)start the poll timer using the current configured interval.
function startPolling() {
	if (state.pollTimer) clearInterval(state.pollTimer);
	state.pollTimer = setInterval(poll, getPollMs());
}

// Scale the root font size so the widget content fits the tile without
// overflowing, with a legible floor. All rem-based sizes derive from this.
// We shrink from FONT_MAX_PX until #widget no longer overflows vertically, and
// also cap by width so wide-short tiles do not clip horizontally.
function fitFont() {
	var widget = $("widget");
	if (!widget) return;
	var rootStyle = document.documentElement.style;
	var widthCap = Math.max(FONT_MIN_PX, widget.clientWidth / 26);
	var hi = Math.min(FONT_MAX_PX, widthCap);
	var size = hi;

	rootStyle.fontSize = size + "px";
	// Step down until content fits vertically or we hit the floor.
	while (size > FONT_MIN_PX && widget.scrollHeight > widget.clientHeight + 1) {
		size -= 0.5;
		rootStyle.fontSize = size + "px";
	}
}

function updateCountdowns() {
	for (var i = 0; i < state.resetRefs.length; i++) {
		var ref = state.resetRefs[i];
		ref.el.textContent = fmtCountdown(ref.resets_at);
	}
}

function messageForError(payload) {
	var code = payload && payload.error ? payload.error : "ERROR";
	if (code === "NO_OAUTH" || code === "INVALID_GRANT" || code === "UNAUTHORIZED") {
		return "Claude sign-in needed\nRun `claude` on your PC to sign in again.";
	}
	if (code === "RATE_LIMITED") {
		return "Rate limited by Anthropic\nRetrying shortly\u2026";
	}
	return "Usage unavailable\n" + (payload && payload.message ? payload.message : code);
}

function handleFailure(kind, text) {
	setStatus("offline", text.split("\n")[0]);
	if (state.data) {
		// Keep last good data visible but dimmed behind the message.
		$("widget").classList.add("dim");
	}
	showMessage(text);
}

function poll() {
	var port = String(prop("bridgePort")).replace(/[^0-9]/g, "") || DEFAULTS.bridgePort;
	var url = "http://127.0.0.1:" + port + "/usage";

	var controller = new AbortController();
	var to = setTimeout(function () {
		controller.abort();
	}, FETCH_TIMEOUT_MS);

	fetch(url, { signal: controller.signal, cache: "no-store" })
		.then(function (res) {
			return res.json().catch(function () {
				return null;
			});
		})
		.then(function (payload) {
			clearTimeout(to);
			if (!payload) {
				handleFailure("offline", "Usage unavailable\nUnexpected response from bridge.");
				return;
			}
			if (payload.ok === false) {
				handleFailure("offline", messageForError(payload));
				return;
			}
			render(payload);
		})
		.catch(function () {
			clearTimeout(to);
			handleFailure(
				"offline",
				"Bridge offline\nStart the Claude Usage Bridge on your PC (bridge/start-bridge.ps1)."
			);
		});
}

function start() {
	if (state.started) return;
	state.started = true;

	applyTheme();
	observeResize();
	poll();
	startPolling();
	state.tickTimer = setInterval(updateCountdowns, 1000);
}

// Refit the font whenever the tile is resized (e.g. small <-> medium layout).
function observeResize() {
	if (state.resizeObserver) return;
	var widget = $("widget");
	if (!widget) return;
	if (typeof ResizeObserver !== "undefined") {
		state.resizeObserver = new ResizeObserver(function () {
			fitFont();
		});
		state.resizeObserver.observe(widget);
	} else {
		window.addEventListener("resize", fitFont);
	}
	fitFont();
}

function onDataUpdated() {
	// A property (color/port/interval) changed; re-theme, re-poll, and
	// restart the timer so a new poll interval takes effect live.
	applyTheme();
	poll();
	startPolling();
}

// Public surface consumed by the iCUE lifecycle hooks declared in index.html.
window.ClaudeUsageWidget = { start: start, onDataUpdated: onDataUpdated };

// Start as soon as the DOM is ready, regardless of iCUE init state. start() is
// idempotent (guarded by state.started), so the onICUEInitialized/onDataUpdated
// hooks and the immediate check below simply refine theme + data afterwards.
// (iCUE sets iCUE_initialized = false at script-load and fires onICUEInitialized
// later, but we must not depend on that to render.)
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", function () {
		start();
	});
} else {
	start();
}

// If iCUE was already initialized when we loaded, start immediately too.
if (typeof iCUE_initialized !== "undefined" && iCUE_initialized) {
	start();
}
