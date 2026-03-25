const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const MOBILE_MEDIA = window.matchMedia("(max-width: 900px)");

let ws = null;
let reconnectTimer = null;
let noticeTimer = null;
let hosts = [];
let currentView = "sessions";
let currentSessionGuid = null;
let currentSession = createEmptySession(null);
let selectedProjectContext = null;
const pendingLaunchRequests = new Map();

const bodyEl = document.body;
const sidebarSummaryEl = document.getElementById("sidebar-summary");
const sidebarScrimEl = document.getElementById("sidebar-scrim");
const connectionStatusEl = document.getElementById("connection-status");
const browserListEl = document.getElementById("browser-list");
const viewSessionsBtnEl = document.getElementById("view-sessions-btn");
const viewProjectsBtnEl = document.getElementById("view-projects-btn");
const menuBtnEl = document.getElementById("menu-btn");
const sidebarCloseBtnEl = document.getElementById("sidebar-close");
const sessionTitleEl = document.getElementById("session-title");
const sessionSubtitleEl = document.getElementById("session-subtitle");
const sessionPathEl = document.getElementById("session-path");
const newSessionBtnEl = document.getElementById("new-session-btn");
const noticeBarEl = document.getElementById("notice-bar");
const messagesEl = document.getElementById("messages");
const messageInputEl = document.getElementById("message-input");
const sendBtnEl = document.getElementById("send-btn");
const abortBtnEl = document.getElementById("abort-btn");

connect();
renderBrowserList();
renderSession({ forceScroll: true });
updateHeader();
updateControls();
updateViewButtons();

function connect() {
	ws = new WebSocket(WS_URL);

	ws.onopen = () => {
		setConnection(true);
		send({ type: "hello", role: "web" });
		if (currentSessionGuid) {
			setTimeout(() => send({ type: "attach", sessionGuid: currentSessionGuid }), 50);
		}
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

function send(message) {
	if (ws?.readyState !== WebSocket.OPEN) return false;
	ws.send(JSON.stringify(message));
	return true;
}

function handleMessage(message) {
	switch (message.type) {
		case "overview":
			hosts = Array.isArray(message.hosts) ? message.hosts : [];
			hydrateCurrentSessionFromOverview();
			syncSelectedProjectContext();
			updateSidebarSummary();
			renderBrowserList();
			updateHeader();
			updateControls();
			break;

		case "session_snapshot":
			currentSession = normalizeSession(message.session);
			hydrateCurrentSessionFromOverview();
			renderSession({ forceScroll: true });
			updateHeader();
			updateControls();
			break;

		case "session_event":
			if (message.sessionGuid !== currentSessionGuid) return;
			applySessionEvent(currentSession, message.event);
			renderSession({ forceScroll: true });
			updateHeader();
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
			updateHeader();
			updateControls();
			break;

		case "background_session_started": {
			const pending = pendingLaunchRequests.get(message.requestId);
			if (!pending) return;
			pendingLaunchRequests.delete(message.requestId);
			showNotice(`Background session started on ${message.hostId}`, "info");
			attachSession(message.sessionGuid, {
				hostId: message.hostId,
				cwd: message.cwd || pending.cwd,
				closeSidebar: true,
			});
			break;
		}

		case "launch_status": {
			const pending = pendingLaunchRequests.get(message.requestId);
			if (!pending) return;
			if (message.status === "error" || message.status === "exited") {
				pendingLaunchRequests.delete(message.requestId);
				showNotice(message.error || "Failed to start background session", "error");
			}
			break;
		}

		case "notice":
			showNotice(message.message || "Notice", message.level || "info");
			break;

		case "error":
			showNotice(message.message || "Unknown error", "error");
			break;
	}
}

function setConnection(connected) {
	connectionStatusEl.textContent = connected ? "Connected" : "Disconnected";
	connectionStatusEl.className = `status-pill ${connected ? "connected" : "disconnected"}`;
	updateSidebarSummary();
	updateControls();
	if (!connected) showNotice("Disconnected from server. Reconnecting…", "error", false);
}

function updateSidebarSummary() {
	const connectedHosts = hosts.filter((host) => host.connected).length;
	const sessionCount = flattenSessions().length;
	if (ws?.readyState === WebSocket.OPEN) {
		sidebarSummaryEl.textContent = `${connectedHosts} host${connectedHosts === 1 ? "" : "s"} • ${sessionCount} session${sessionCount === 1 ? "" : "s"}`;
	} else {
		sidebarSummaryEl.textContent = "Waiting for server…";
	}
}

function flattenSessions() {
	const list = [];
	for (const host of hosts) {
		if (!host.connected) continue;
		for (const session of host.sessions || []) {
			list.push({
				...session,
				hostId: host.hostId,
				hostname: host.hostname,
				hostConnected: !!host.connected,
				platform: host.platform,
			});
		}
	}
	list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	return list;
}

function buildProjects() {
	const groups = new Map();
	for (const session of flattenSessions()) {
		const cwd = session.cwd || "(unknown project)";
		const key = `${session.hostId}::${cwd}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				hostId: session.hostId,
				hostname: session.hostname,
				hostConnected: session.hostConnected,
				cwd,
				updatedAt: session.updatedAt || 0,
				sessions: [],
			};
			groups.set(key, group);
		}
		group.updatedAt = Math.max(group.updatedAt, session.updatedAt || 0);
		group.sessions.push(session);
	}

	const projects = Array.from(groups.values());
	for (const project of projects) {
		project.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	}
	projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	return projects;
}

function renderBrowserList() {
	browserListEl.innerHTML = "";
	if (currentView === "projects") {
		renderProjectBrowser();
	} else {
		renderSessionBrowser();
	}
}

function renderSessionBrowser() {
	const sessions = flattenSessions();
	if (sessions.length === 0) {
		browserListEl.appendChild(renderEmpty("No sessions visible yet. Start the host supervisor on a machine to discover local pi sessions."));
		return;
	}

	for (const session of sessions) {
		const row = document.createElement("button");
		row.type = "button";
		row.className = `list-item ${session.sessionGuid === currentSessionGuid ? "active" : ""}`;
		row.onclick = () => attachSession(session.sessionGuid, { hostId: session.hostId, cwd: session.cwd, closeSidebar: true });

		const main = document.createElement("div");
		main.className = "item-main";
		main.appendChild(makeLine("item-title", getSessionTitle(session)));
		main.appendChild(makeLine("item-subtitle", `${session.hostname} • ${session.cwd || shortId(session.sessionGuid)}`));
		if (session.preview && session.preview !== getSessionTitle(session)) {
			main.appendChild(makeLine("item-preview", session.preview));
		}

		const badges = document.createElement("div");
		badges.className = "item-badges";
		for (const badge of buildSessionBadges(session)) badges.appendChild(badge);

		row.appendChild(main);
		row.appendChild(badges);
		browserListEl.appendChild(row);
	}
}

function renderProjectBrowser() {
	const projects = buildProjects();
	if (projects.length === 0) {
		browserListEl.appendChild(renderEmpty("No project folders are visible yet. Once the supervisor discovers sessions, they will be grouped here by project."));
		return;
	}

	for (const project of projects) {
		const card = document.createElement("section");
		card.className = "project-card";

		const header = document.createElement("div");
		header.className = "project-header";
		const main = document.createElement("div");
		main.className = "project-main";
		main.appendChild(makeLine("project-title", basenamePath(project.cwd)));
		main.appendChild(makeLine("project-subtitle", `${project.hostname} • ${project.cwd}`));
		header.appendChild(main);

		const actions = document.createElement("div");
		actions.className = "project-actions";
		const meta = document.createElement("span");
		meta.className = `badge ${project.hostConnected ? "connected" : "disconnected"}`;
		meta.textContent = `${project.sessions.length} session${project.sessions.length === 1 ? "" : "s"}`;
		actions.appendChild(meta);

		const newBtn = document.createElement("button");
		newBtn.type = "button";
		newBtn.textContent = "New Session";
		newBtn.disabled = !(ws?.readyState === WebSocket.OPEN && project.hostConnected && project.cwd && project.cwd !== "(unknown project)");
		newBtn.onclick = (event) => {
			event.stopPropagation();
			selectedProjectContext = { hostId: project.hostId, hostname: project.hostname, cwd: project.cwd, hostConnected: project.hostConnected };
			createNewBackgroundSession(selectedProjectContext);
		};
		actions.appendChild(newBtn);
		header.appendChild(actions);
		card.appendChild(header);

		const sessionsEl = document.createElement("div");
		sessionsEl.className = "project-sessions";
		for (const session of project.sessions) {
			const row = document.createElement("button");
			row.type = "button";
			row.className = `session-mini ${session.sessionGuid === currentSessionGuid ? "active" : ""}`;
			row.onclick = () => attachSession(session.sessionGuid, { hostId: session.hostId, cwd: session.cwd, closeSidebar: true });

			const itemMain = document.createElement("div");
			itemMain.className = "session-mini-main";
			itemMain.appendChild(makeLine("session-mini-title", getSessionTitle(session)));
			itemMain.appendChild(makeLine("session-mini-subtitle", session.preview || shortId(session.sessionGuid)));

			const itemBadges = document.createElement("div");
			itemBadges.className = "item-badges";
			for (const badge of buildSessionBadges(session)) itemBadges.appendChild(badge);

			row.appendChild(itemMain);
			row.appendChild(itemBadges);
			sessionsEl.appendChild(row);
		}

		card.appendChild(sessionsEl);
		browserListEl.appendChild(card);
	}
}

function renderEmpty(text) {
	const empty = document.createElement("div");
	empty.className = "browser-empty";
	empty.textContent = text;
	return empty;
}

function buildSessionBadges(session) {
	const badges = [];
	if (!session.hostConnected) {
		badges.push(createBadge("offline", "disconnected"));
	}
	badges.push(createBadge(session.owner || "inactive", session.owner || "inactive"));
	if (session.busy) badges.push(createBadge("busy", "busy"));
	return badges;
}

function createBadge(text, kind) {
	const el = document.createElement("span");
	el.className = `badge ${kind}`;
	el.textContent = text;
	return el;
}

function makeLine(className, text) {
	const el = document.createElement("div");
	el.className = className;
	el.textContent = text;
	return el;
}

function attachSession(sessionGuid, context = {}) {
	currentSessionGuid = sessionGuid;
	selectedProjectContext = context.hostId && context.cwd
		? { hostId: context.hostId, hostname: context.hostname || context.hostId, cwd: context.cwd, hostConnected: true }
		: selectedProjectContext;
		currentSession = createEmptySession(sessionGuid);
		hydrateCurrentSessionFromOverview();
		renderBrowserList();
		renderSession({ forceScroll: true });
		updateHeader();
		updateControls();
		send({ type: "attach", sessionGuid });
		if (context.closeSidebar) closeSidebar();
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
	currentSession.busy = currentSession.busy || !!summary.busy;
	selectedProjectContext = summary.cwd
		? { hostId: summary.hostId, hostname: summary.hostname, cwd: summary.cwd, hostConnected: summary.hostConnected }
		: selectedProjectContext;
}

function renderSession({ forceScroll = false } = {}) {
	const previousDistanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
	messagesEl.innerHTML = "";

	if (!currentSessionGuid) {
		messagesEl.appendChild(renderMessagesEmpty("Select a session to watch it live, or switch to Projects to start a brand-new background session."));
		return;
	}

	const fragments = [];
	for (const message of currentSession.history) {
		fragments.push(renderMessage(message));
	}

	for (const tool of currentSession.activeTools) {
		fragments.push(renderSystemMessage(`Running ${tool.toolName}…`));
	}

	if (currentSession.streamingText) {
		fragments.push(renderAssistantStream(currentSession.streamingText));
	}

	if (fragments.length === 0) {
		messagesEl.appendChild(renderMessagesEmpty("No messages in this session yet. Send a message to start working."));
		return;
	}

	for (const fragment of fragments) {
		messagesEl.appendChild(fragment);
	}

	requestAnimationFrame(() => {
		const shouldStick = forceScroll || previousDistanceFromBottom < 140;
		if (shouldStick) {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		} else {
			messagesEl.scrollTop = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight - previousDistanceFromBottom);
		}
	});
}

function renderMessagesEmpty(text) {
	const empty = document.createElement("div");
	empty.className = "messages-empty";
	empty.textContent = text;
	return empty;
}

function renderMessage(message) {
	if (message.role === "user") {
		return buildMessageElement("user", message.text || "", message.timestamp);
	}
	if (message.role === "assistant") {
		return buildMessageElement("assistant", message.text || "", message.timestamp);
	}
	if (message.role === "toolResult") {
		return buildMessageElement(`tool ${message.isError ? "error" : ""}`.trim(), `${message.toolName}:\n${message.text || ""}`, message.timestamp);
	}
	return renderSystemMessage(message.text || "");
}

function renderAssistantStream(text) {
	return buildMessageElement("assistant streaming", text || "", null);
}

function renderSystemMessage(text) {
	const el = document.createElement("div");
	el.className = "message system";
	el.textContent = text;
	return el;
}

function buildMessageElement(className, text, timestamp) {
	const el = document.createElement("div");
	el.className = `message ${className}`;
	if (timestamp) {
		const ts = document.createElement("div");
		ts.className = "timestamp";
		ts.textContent = new Date(timestamp).toLocaleTimeString();
		el.appendChild(ts);
	}
	const textEl = document.createElement("div");
	textEl.textContent = text || "";
	el.appendChild(textEl);
	return el;
}

function updateHeader() {
	if (!currentSessionGuid) {
		sessionTitleEl.textContent = "No session selected";
		sessionSubtitleEl.textContent = currentView === "projects"
			? "Pick a project and start a new session, or select an existing session below it."
			: "Select a session from the sidebar to watch it live.";
		sessionPathEl.textContent = selectedProjectContext?.cwd || "";
		return;
	}

	const summary = findSessionSummary(currentSessionGuid);
	const hostLabel = currentSession.hostId || summary?.hostId || "unknown host";
	const owner = currentSession.owner || summary?.owner || "inactive";
	const busy = currentSession.busy ? " • busy" : "";
	const model = currentSession.model || summary?.model || "no model";
	const title = currentSession.sessionName || summary?.sessionName || summary?.preview || shortId(currentSessionGuid);
	const hostname = summary?.hostname || hostLabel;

		sessionTitleEl.textContent = title;
		sessionSubtitleEl.textContent = `${hostname} • ${owner}${busy} • ${model}`;
		sessionPathEl.textContent = currentSession.cwd || summary?.cwd || currentSessionGuid;
}

function updateControls() {
	const connected = ws?.readyState === WebSocket.OPEN;
	const summary = currentSessionGuid ? findSessionSummary(currentSessionGuid) : null;
	const session = summary || currentSession;
	const hasOwner = !!(currentSession.owner || summary?.owner);
	const canAutoStart = !!(summary && summary.hostConnected && (summary.sessionFile || summary.sessionGuid));
	const launchContext = getCurrentLaunchContext();

	sendBtnEl.disabled = !(connected && currentSessionGuid && (hasOwner || canAutoStart));
	abortBtnEl.disabled = !(connected && currentSessionGuid && hasOwner);
	newSessionBtnEl.disabled = !(connected && launchContext && launchContext.hostConnected && launchContext.cwd && launchContext.cwd !== "(unknown project)");

	messageInputEl.placeholder = hasOwner
		? "Send a live message to the active session…"
		: currentSessionGuid && canAutoStart
			? "Send a message — Toilet-Pi will auto-start this session in background…"
			: "Select a session to send a message…";
}

function getCurrentLaunchContext() {
	const summary = currentSessionGuid ? findSessionSummary(currentSessionGuid) : null;
	if (summary?.cwd) {
		return {
			hostId: summary.hostId,
			hostname: summary.hostname,
			cwd: summary.cwd,
			hostConnected: summary.hostConnected,
		};
	}
	if (selectedProjectContext?.cwd) return selectedProjectContext;
	return null;
}

function syncSelectedProjectContext() {
	if (!selectedProjectContext?.hostId || !selectedProjectContext?.cwd) return;
	const match = buildProjects().find(
		(project) => project.hostId === selectedProjectContext.hostId && project.cwd === selectedProjectContext.cwd,
	);
	if (!match) {
		selectedProjectContext = null;
		return;
	}
	selectedProjectContext = {
		hostId: match.hostId,
		hostname: match.hostname,
		cwd: match.cwd,
		hostConnected: match.hostConnected,
	};
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
			if (event.toolCallId) upsertTool(session, { toolCallId: event.toolCallId, toolName: event.toolName || "tool" });
			break;

		case "tool_end":
			if (event.toolCallId) session.activeTools = session.activeTools.filter((tool) => tool.toolCallId !== event.toolCallId);
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
	if (existingIndex >= 0) session.activeTools[existingIndex] = tool;
	else session.activeTools.push(tool);
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
		sessionGuid: session?.sessionGuid || null,
		owner: session?.owner || null,
		hostId: session?.hostId || null,
		sessionFile: session?.sessionFile || null,
		sessionName: session?.sessionName || null,
		cwd: session?.cwd || null,
		model: session?.model || null,
		busy: !!session?.busy,
		history: Array.isArray(session?.history) ? session.history : [],
		streamingText: typeof session?.streamingText === "string" ? session.streamingText : null,
		activeTools: Array.isArray(session?.activeTools) ? session.activeTools : [],
	};
}

function findSessionSummary(sessionGuid) {
	return flattenSessions().find((session) => session.sessionGuid === sessionGuid) || null;
}

function getSessionTitle(session) {
	return session.sessionName || session.preview || shortId(session.sessionGuid);
}

function showNotice(message, level = "info", autoHide = true) {
	if (noticeTimer) clearTimeout(noticeTimer);
	noticeBarEl.textContent = message;
	noticeBarEl.className = `notice-bar ${level}`;
	if (autoHide) {
		noticeTimer = setTimeout(() => {
			noticeBarEl.textContent = "";
			noticeBarEl.className = "notice-bar";
		}, 3600);
	}
}

function createNewBackgroundSession(context) {
	if (!context?.hostId || !context.cwd) return;
	const requestId = createId();
	pendingLaunchRequests.set(requestId, {
		hostId: context.hostId,
		hostname: context.hostname,
		cwd: context.cwd,
	});
	send({
		type: "create_background_session",
		requestId,
		hostId: context.hostId,
		cwd: context.cwd,
	});
}

function createId() {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function basenamePath(value) {
	const trimmed = String(value || "").replace(/[\\/]+$/, "");
	if (!trimmed || trimmed === "(unknown project)") return "Unknown project";
	const parts = trimmed.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) || trimmed;
}

function shortId(value) {
	return value ? value.slice(0, 8) : "unknown";
}

function openSidebar() {
	if (!MOBILE_MEDIA.matches) return;
	bodyEl.classList.add("sidebar-open");
}

function closeSidebar() {
	bodyEl.classList.remove("sidebar-open");
}

function updateViewButtons() {
	viewSessionsBtnEl.classList.toggle("active", currentView === "sessions");
	viewProjectsBtnEl.classList.toggle("active", currentView === "projects");
}

viewSessionsBtnEl.onclick = () => {
	currentView = "sessions";
	updateViewButtons();
	renderBrowserList();
};

viewProjectsBtnEl.onclick = () => {
	currentView = "projects";
	updateViewButtons();
	renderBrowserList();
};

menuBtnEl.onclick = () => openSidebar();
sidebarCloseBtnEl.onclick = () => closeSidebar();
sidebarScrimEl.onclick = () => closeSidebar();

newSessionBtnEl.onclick = () => {
	const context = getCurrentLaunchContext();
	if (!context) return;
	createNewBackgroundSession(context);
};

sendBtnEl.onclick = () => {
	const text = messageInputEl.value.trim();
	if (!text || !currentSessionGuid) return;
	const sent = send({ type: "input", sessionGuid: currentSessionGuid, text });
	if (!sent) return;
	if (!(currentSession.owner || findSessionSummary(currentSessionGuid)?.owner)) {
		showNotice("Starting background runner and delivering your message…", "info");
	}
	messageInputEl.value = "";
};

abortBtnEl.onclick = () => {
	if (!currentSessionGuid) return;
	send({ type: "abort", sessionGuid: currentSessionGuid });
};

messageInputEl.onkeydown = (event) => {
	if (event.key === "Enter") {
		event.preventDefault();
		sendBtnEl.onclick();
	}
};

window.addEventListener("resize", () => {
	if (!MOBILE_MEDIA.matches) closeSidebar();
});
