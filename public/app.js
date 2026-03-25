const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

let ws = null;
let reconnectTimer = null;
let hosts = [];
let currentSessionGuid = null;
let currentSession = createEmptySession(null);
let selectedHostId = null;
let noticeTimer = null;

const hostsEl = document.getElementById("hosts");
const messagesEl = document.getElementById("messages");
const connectionStatusEl = document.getElementById("connection-status");
const sessionTitleEl = document.getElementById("session-title");
const sessionSubtitleEl = document.getElementById("session-subtitle");
const noticeBarEl = document.getElementById("notice-bar");
const messageInputEl = document.getElementById("message-input");
const sendBtnEl = document.getElementById("send-btn");
const abortBtnEl = document.getElementById("abort-btn");
const startBtnEl = document.getElementById("start-btn");
const refreshBtnEl = document.getElementById("refresh-btn");

function connect() {
	ws = new WebSocket(WS_URL);

	ws.onopen = () => {
		setConnection(true);
		send({ type: "hello", role: "web" });
	};

	ws.onclose = () => {
		setConnection(false);
		scheduleReconnect();
	};

	ws.onerror = () => {};

	ws.onmessage = (event) => {
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}

		handleMessage(message);
	};
}

function scheduleReconnect() {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, 2000);
}

function setConnection(connected) {
	connectionStatusEl.textContent = connected ? "Connected" : "Disconnected";
	connectionStatusEl.className = `status-pill ${connected ? "connected" : "disconnected"}`;
	updateControls();
	if (!connected) showNotice("Disconnected from server. Reconnecting...", "error", false);
}

function send(message) {
	if (ws?.readyState !== WebSocket.OPEN) return;
	ws.send(JSON.stringify(message));
}

function handleMessage(message) {
	switch (message.type) {
		case "overview":
			hosts = Array.isArray(message.hosts) ? message.hosts : [];
			if (!selectedHostId && hosts[0]) selectedHostId = hosts[0].hostId;
			renderHosts();
			hydrateCurrentSessionFromOverview();
			updateSessionHeader();
			updateControls();
			break;

		case "session_snapshot":
			if (!message.session) return;
			currentSession = normalizeSession(message.session);
			hydrateCurrentSessionFromOverview();
			renderSession();
			updateSessionHeader();
			updateControls();
			break;

		case "session_event":
			if (message.sessionGuid !== currentSessionGuid) return;
			applySessionEvent(currentSession, message.event);
			renderSession();
			updateSessionHeader();
			updateControls();
			break;

		case "session_meta":
			if (message.sessionGuid !== currentSessionGuid) return;
			currentSession.owner = message.owner ?? null;
			currentSession.hostId = message.hostId ?? null;
			currentSession.sessionFile = message.sessionFile ?? null;
			currentSession.sessionName = message.sessionName ?? null;
			currentSession.cwd = message.cwd ?? null;
			currentSession.model = message.model ?? null;
			currentSession.busy = !!message.busy;
			hydrateCurrentSessionFromOverview();
			renderSession();
			updateSessionHeader();
			updateControls();
			break;

		case "error":
			showNotice(message.message || "Unknown error", "error");
			break;

		case "notice":
			showNotice(message.message || "Notice", message.level || "info");
			break;
	}
}

function renderHosts() {
	hostsEl.innerHTML = "";

	if (hosts.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = "No hosts connected yet. Start the host supervisor on a machine to see sessions.";
		hostsEl.appendChild(empty);
		return;
	}

	for (const host of hosts) {
		const hostCard = document.createElement("section");
		hostCard.className = "host-card";

		const header = document.createElement("div");
		header.className = "host-header";
		header.innerHTML = `
			<div class="host-title">
				<div><strong>${escapeHtml(host.hostname || host.hostId)}</strong></div>
				<div class="small">${escapeHtml(host.platform || host.hostId)}</div>
			</div>
		`;

		const buttons = document.createElement("div");
		buttons.className = "button-row";
		const hostStatus = document.createElement("span");
		hostStatus.className = `badge ${host.connected ? "interactive" : "disconnected"}`;
		hostStatus.textContent = host.connected ? "connected" : "offline";
		buttons.appendChild(hostStatus);

		const refreshBtn = document.createElement("button");
		refreshBtn.textContent = "Refresh";
		refreshBtn.disabled = !host.connected;
		refreshBtn.onclick = (event) => {
			event.stopPropagation();
			selectedHostId = host.hostId;
			send({ type: "refresh_host_sessions", hostId: host.hostId });
		};
		buttons.appendChild(refreshBtn);
		header.appendChild(buttons);
		hostCard.appendChild(header);

		const sessionList = document.createElement("div");
		sessionList.className = "host-sessions";

		if (!host.sessions?.length) {
			const empty = document.createElement("div");
			empty.className = "session-row";
			empty.innerHTML = `<div class="session-preview">No sessions discovered on this host yet.</div>`;
			sessionList.appendChild(empty);
		} else {
			for (const session of host.sessions) {
				const row = document.createElement("div");
				row.className = `session-row ${session.sessionGuid === currentSessionGuid ? "active" : ""}`;
				row.onclick = () => attachSession(session.sessionGuid, host.hostId);

				const summary = document.createElement("div");
				summary.className = "session-main";
				summary.innerHTML = `
					<div class="session-name">${escapeHtml(session.sessionName || session.preview || shortId(session.sessionGuid))}</div>
					<div class="session-preview">${escapeHtml(session.preview || shortId(session.sessionGuid))}</div>
					<div class="session-meta">${escapeHtml(session.cwd || session.sessionGuid)}</div>
				`;

				const badges = document.createElement("div");
				badges.className = "badges";

				const ownerBadge = document.createElement("span");
				ownerBadge.className = `badge ${session.owner || "idle"}`;
				ownerBadge.textContent = session.owner || "inactive";
				badges.appendChild(ownerBadge);

				if (session.busy) {
					const busyBadge = document.createElement("span");
					busyBadge.className = "badge busy";
					busyBadge.textContent = "busy";
					badges.appendChild(busyBadge);
				}

				if (session.runnerStatus && !session.owner) {
					const runnerBadge = document.createElement("span");
					runnerBadge.className = "badge idle";
					runnerBadge.textContent = session.runnerStatus;
					badges.appendChild(runnerBadge);
				}

				row.appendChild(summary);
				row.appendChild(badges);
				sessionList.appendChild(row);
			}
		}

		hostCard.appendChild(sessionList);
		hostsEl.appendChild(hostCard);
	}
}

function attachSession(sessionGuid, hostId) {
	currentSessionGuid = sessionGuid;
	selectedHostId = hostId;
	currentSession = createEmptySession(sessionGuid);
	hydrateCurrentSessionFromOverview();
	renderHosts();
	renderSession();
	updateSessionHeader();
	updateControls();
	send({ type: "attach", sessionGuid });
}

function hydrateCurrentSessionFromOverview() {
	if (!currentSessionGuid) return;
	const summary = findSessionSummary(currentSessionGuid);
	if (!summary) return;
	currentSession.hostId ||= summary.hostId;
	currentSession.sessionFile ||= summary.sessionFile || null;
	currentSession.sessionName ||= summary.sessionName || null;
	currentSession.cwd ||= summary.cwd || null;
	currentSession.model ||= summary.model || null;
	currentSession.owner ??= summary.owner ?? null;
	currentSession.busy ||= !!summary.busy;
}

function renderSession() {
	messagesEl.innerHTML = "";

	if (!currentSessionGuid) {
		messagesEl.innerHTML = `<div class="empty">Select a session from the left to watch or control it.</div>`;
		return;
	}

	const items = [];
	for (const message of currentSession.history) {
		items.push(renderMessage(message));
	}

	for (const tool of currentSession.activeTools) {
		items.push(renderSystemMessage(`Running ${tool.toolName}...`));
	}

	if (currentSession.streamingText) {
		items.push(renderAssistantStream(currentSession.streamingText));
	}

	if (items.length === 0) {
		messagesEl.innerHTML = `<div class="empty">No messages in this session yet.</div>`;
		return;
	}

	for (const item of items) {
		messagesEl.appendChild(item);
	}

	messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(message) {
	const el = document.createElement("div");
	if (message.role === "user") {
		el.className = "message user";
		appendTimestamp(el, message.timestamp);
		appendText(el, message.text || "");
		return el;
	}

	if (message.role === "assistant") {
		el.className = "message assistant";
		appendTimestamp(el, message.timestamp);
		appendText(el, message.text || "");
		return el;
	}

	if (message.role === "toolResult") {
		el.className = `message tool ${message.isError ? "error" : ""}`;
		appendTimestamp(el, message.timestamp);
		appendText(el, `${message.toolName}:\n${message.text || ""}`);
		return el;
	}

	return renderSystemMessage(message.text || "");
}

function renderAssistantStream(text) {
	const el = document.createElement("div");
	el.className = "message assistant streaming";
	appendText(el, text || "");
	return el;
}

function renderSystemMessage(text) {
	const el = document.createElement("div");
	el.className = "message system";
	el.textContent = text;
	return el;
}

function appendTimestamp(parent, timestamp) {
	if (!timestamp) return;
	const ts = document.createElement("div");
	ts.className = "timestamp";
	ts.textContent = new Date(timestamp).toLocaleTimeString();
	parent.appendChild(ts);
}

function appendText(parent, text) {
	const span = document.createElement("div");
	span.textContent = text || "";
	parent.appendChild(span);
}

function updateSessionHeader() {
	if (!currentSessionGuid) {
		sessionTitleEl.textContent = "No session selected";
		sessionSubtitleEl.textContent = "Choose a session from the left.";
		return;
	}

	const summary = findSessionSummary(currentSessionGuid);
	const title = currentSession.sessionName || summary?.sessionName || summary?.preview || shortId(currentSessionGuid);
	const owner = currentSession.owner || summary?.owner || "inactive";
	const hostId = currentSession.hostId || summary?.hostId || "unknown host";
	const model = currentSession.model || summary?.model || "no model";
	const cwd = currentSession.cwd || summary?.cwd || currentSessionGuid;
	const busy = currentSession.busy ? " • busy" : "";

		sessionTitleEl.textContent = title;
		sessionSubtitleEl.textContent = `${hostId} • ${owner}${busy} • ${model} • ${cwd}`;
}

function updateControls() {
	const connected = ws?.readyState === WebSocket.OPEN;
	const summary = currentSessionGuid ? findSessionSummary(currentSessionGuid) : null;
	const owner = currentSession.owner || summary?.owner || null;
	const hostId = currentSession.hostId || summary?.hostId || selectedHostId || null;
	const host = hostId ? hosts.find((entry) => entry.hostId === hostId) : null;
	const canStart = connected && !!summary && !owner && !!host?.connected;

	sendBtnEl.disabled = !(connected && currentSessionGuid && owner);
	abortBtnEl.disabled = !(connected && currentSessionGuid && owner);
	startBtnEl.disabled = !canStart;
	refreshBtnEl.disabled = !(connected && hostId && host?.connected);
}

function applySessionEvent(session, event) {
	if (!event || typeof event !== "object") return;

	switch (event.type) {
		case "message":
			if (event.message) session.history.push(event.message);
			if (event.message?.role === "assistant") session.streamingText = null;
			break;

		case "assistant_stream_start":
			session.streamingText = "";
			break;

		case "assistant_stream_update":
			session.streamingText = event.text || "";
			break;

		case "assistant_stream_end":
			break;

		case "tool_start":
			if (event.toolCallId) {
				upsertTool(session, { toolCallId: event.toolCallId, toolName: event.toolName || "tool" });
			}
			break;

		case "tool_end":
			if (event.toolCallId) {
				session.activeTools = session.activeTools.filter((tool) => tool.toolCallId !== event.toolCallId);
			}
			break;

		case "busy":
			session.busy = !!event.busy;
			if (!session.busy) {
				session.streamingText = null;
				session.activeTools = [];
			}
			break;

		case "model":
			session.model = event.modelId || null;
			break;

		case "session_name":
			session.sessionName = event.sessionName || null;
			break;
	}
}

function upsertTool(session, tool) {
	const existingIndex = session.activeTools.findIndex((entry) => entry.toolCallId === tool.toolCallId);
	if (existingIndex >= 0) {
		session.activeTools[existingIndex] = tool;
	} else {
		session.activeTools.push(tool);
	}
}

function createEmptySession(sessionGuid) {
	return {
		sessionGuid,
		owner: null,
		hostId: null,
		sessionFile: null,
		sessionName: null,
		cwd: null,
		model: null,
		busy: false,
		history: [],
		streamingText: null,
		activeTools: [],
	};
}

function normalizeSession(session) {
	return {
		sessionGuid: session.sessionGuid || null,
		owner: session.owner || null,
		hostId: session.hostId || null,
		sessionFile: session.sessionFile || null,
		sessionName: session.sessionName || null,
		cwd: session.cwd || null,
		model: session.model || null,
		busy: !!session.busy,
		history: Array.isArray(session.history) ? session.history : [],
		streamingText: typeof session.streamingText === "string" ? session.streamingText : null,
		activeTools: Array.isArray(session.activeTools) ? session.activeTools : [],
	};
}

function findSessionSummary(sessionGuid) {
	for (const host of hosts) {
		for (const session of host.sessions || []) {
			if (session.sessionGuid === sessionGuid) {
				return { ...session, hostId: host.hostId };
			}
		}
	}
	return null;
}

function showNotice(message, level = "info", autoHide = true) {
	if (noticeTimer) clearTimeout(noticeTimer);
	noticeBarEl.textContent = message;
	noticeBarEl.className = `notice-bar ${level}`;
	if (autoHide) {
		noticeTimer = setTimeout(() => {
			noticeBarEl.textContent = "";
			noticeBarEl.className = "notice-bar";
		}, 3500);
	}
}

function shortId(value) {
	return value ? value.slice(0, 8) : "unknown";
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

sendBtnEl.onclick = () => {
	const text = messageInputEl.value.trim();
	if (!text || !currentSessionGuid) return;
	send({ type: "input", sessionGuid: currentSessionGuid, text });
	messageInputEl.value = "";
};

abortBtnEl.onclick = () => {
	if (!currentSessionGuid) return;
	send({ type: "abort", sessionGuid: currentSessionGuid });
};

startBtnEl.onclick = () => {
	if (!currentSessionGuid) return;
	const summary = findSessionSummary(currentSessionGuid);
	if (!summary) return;
	send({
		type: "start_background_session",
		hostId: summary.hostId,
		sessionGuid: summary.sessionGuid,
		sessionFile: summary.sessionFile || null,
		cwd: summary.cwd || null,
	});
	showNotice(`Requested background start for ${shortId(summary.sessionGuid)}`, "info");
};

refreshBtnEl.onclick = () => {
	const hostId = currentSession.hostId || selectedHostId || hosts[0]?.hostId;
	if (!hostId) return;
	send({ type: "refresh_host_sessions", hostId });
};

messageInputEl.onkeydown = (event) => {
	if (event.key === "Enter") {
		event.preventDefault();
		sendBtnEl.onclick();
	}
};

connect();
