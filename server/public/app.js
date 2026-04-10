const MOBILE_MEDIA = window.matchMedia("(max-width: 900px)");
const TOKEN_STORAGE_KEY = "toilet-pi.token";

let ws = null;
let reconnectTimer = null;
let noticeTimer = null;
let hosts = [];
let currentView = "sessions";
let currentSessionGuid = null;
let currentSession = createEmptySession(null);
let selectedProjectContext = null;
let toolsExpanded = false;
let stickToBottom = true;
let installationSecretsVisible = false;
let authToken = loadAuthToken();
const pendingLaunchRequests = new Map();

const bodyEl = document.body;
const sidebarSummaryEl = document.getElementById("sidebar-summary");
const sidebarScrimEl = document.getElementById("sidebar-scrim");
const connectionStatusEl = document.getElementById("connection-status");
const browserListEl = document.getElementById("browser-list");
const installationPanelEl = document.getElementById("installation-panel");
const installationBtnEl = document.getElementById("installation-btn");
const installationModalScrimEl = document.getElementById("installation-modal-scrim");
const installationCloseBtnEl = document.getElementById("installation-close-btn");
const viewSessionsBtnEl = document.getElementById("view-sessions-btn");
const viewProjectsBtnEl = document.getElementById("view-projects-btn");
const menuBtnEl = document.getElementById("menu-btn");
const sidebarCloseBtnEl = document.getElementById("sidebar-close");
const sessionTitleEl = document.getElementById("session-title");
const sessionSubtitleEl = document.getElementById("session-subtitle");
const sessionPathEl = document.getElementById("session-path");
const toolsExpandBtnEl = document.getElementById("tools-expand-btn");
const newSessionBtnEl = document.getElementById("new-session-btn");
const noticeBarEl = document.getElementById("notice-bar");
const messagesEl = document.getElementById("messages");
const messageInputEl = document.getElementById("message-input");
const sendBtnEl = document.getElementById("send-btn");
const abortBtnEl = document.getElementById("abort-btn");

renderInstallation();
connect();
renderBrowserList();
renderSession({ forceScroll: true });
updateHeader();
updateControls();
updateViewButtons();

function loadAuthToken() {
	const hashParams = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
	const tokenFromHash = hashParams.get("token")?.trim() || null;
	if (tokenFromHash) {
		localStorage.setItem(TOKEN_STORAGE_KEY, tokenFromHash);
		history.replaceState(null, "", `${location.pathname}${location.search}`);
		return tokenFromHash;
	}
	const stored = localStorage.getItem(TOKEN_STORAGE_KEY)?.trim();
	return stored || null;
}

function getWebSocketUrl() {
	if (!authToken) return null;
	const url = new URL(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
	url.searchParams.set("token", authToken);
	return url.toString();
}

function getAdminUrl() {
	if (!authToken) return null;
	const url = new URL(`${location.origin}${location.pathname}`);
	url.hash = new URLSearchParams({ token: authToken }).toString();
	return url.toString();
}

function getConnectUrl() {
	return getWebSocketUrl();
}

function connect() {
	const wsUrl = getWebSocketUrl();
	if (!wsUrl) {
		setConnection(false);
		return;
	}

	ws = new WebSocket(wsUrl);

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
	if (!authToken || reconnectTimer) return;
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

		case "session_snapshot": {
			if ((message.session?.sessionGuid || null) !== currentSessionGuid) break;
			const shouldScroll = currentSession.history.length === 0
				&& currentSession.queuedInputs.length === 0
				&& !currentSession.streamingText
				&& currentSession.activeTools.length === 0;
			currentSession = normalizeSession(message.session);
			hydrateCurrentSessionFromOverview();
			renderSession({ forceScroll: shouldScroll });
			updateHeader();
			updateControls();
			break;
		}

		case "session_event":
			if (message.sessionGuid !== currentSessionGuid) return;
			applySessionEvent(currentSession, message.event);
			renderSession();
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
	connectionStatusEl.textContent = connected ? "Connected" : authToken ? "Disconnected" : "Unauthenticated";
	connectionStatusEl.className = `status-pill ${connected ? "connected" : "disconnected"}`;
	updateSidebarSummary();
	renderInstallation();
	updateControls();
	if (!connected && authToken) showNotice("Disconnected from server. Reconnecting…", "error", false);
}

function updateSidebarSummary() {
	if (!authToken) {
		sidebarSummaryEl.textContent = "Open your toilet-pi admin URL to authenticate.";
		return;
	}
	const connectedHosts = hosts.filter((host) => host.connected).length;
	const sessionCount = flattenSessions().length;
	if (ws?.readyState === WebSocket.OPEN) {
		sidebarSummaryEl.textContent = `${connectedHosts} host${connectedHosts === 1 ? "" : "s"} • ${sessionCount} session${sessionCount === 1 ? "" : "s"}`;
	} else {
		sidebarSummaryEl.textContent = "Waiting for server…";
	}
}

function renderInstallation() {
	if (!installationPanelEl) return;
	const adminUrl = getAdminUrl();
	const connectUrl = getConnectUrl();
	if (!authToken) {
		installationPanelEl.innerHTML = "";
		const hint = document.createElement("div");
		hint.className = "install-hint";
		hint.textContent = "Open the toilet-pi admin URL printed by the server. It contains #token=... and authenticates this browser automatically.";
		installationPanelEl.appendChild(hint);
		return;
	}

	installationPanelEl.innerHTML = "";
	const copy = document.createElement("div");
	copy.className = "install-copy";
	copy.textContent = "Install the extension package, then register the client inside pi using the connect URL below.";
	const actions = document.createElement("div");
	actions.className = "install-actions";
	const revealBtn = document.createElement("button");
	revealBtn.type = "button";
	revealBtn.textContent = installationSecretsVisible ? "Hide sensitive URLs" : "Reveal sensitive URLs";
	revealBtn.onclick = () => {
		installationSecretsVisible = !installationSecretsVisible;
		renderInstallation();
	};
	actions.appendChild(revealBtn);
	const installCode = document.createElement("pre");
	installCode.className = "install-code";
	installCode.textContent = "pi install <toilet-pi-package>\n/toilet-pi " + maskSensitive(connectUrl);
	const adminCode = document.createElement("pre");
	adminCode.className = "install-code";
	adminCode.textContent = `Admin URL\n${maskSensitive(adminUrl)}\n\nConnect URL\n${maskSensitive(connectUrl)}`;
	const hint = document.createElement("div");
	hint.className = "install-hint";
	hint.textContent = installationSecretsVisible
		? "Sensitive URLs are visible. Hide them before screen sharing."
		: "Sensitive URLs stay hidden until you explicitly reveal them.";
	installationPanelEl.appendChild(copy);
	installationPanelEl.appendChild(actions);
	installationPanelEl.appendChild(installCode);
	installationPanelEl.appendChild(adminCode);
	installationPanelEl.appendChild(hint);
}

function maskSensitive(value) {
	if (installationSecretsVisible) return value || "";
	return value ? value.replace(/token=[^&#\s]+/g, "token=••••••••").replace(/#token=[^&#\s]+/g, "#token=••••••••") : "";
}

function openInstallationModal() {
	installationSecretsVisible = false;
	renderInstallation();
	bodyEl.classList.add("installation-open");
}

function closeInstallationModal() {
	installationSecretsVisible = false;
	renderInstallation();
	bodyEl.classList.remove("installation-open");
}

function flattenSessions() {
	const list = [];
	for (const host of hosts) {
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
		browserListEl.appendChild(renderEmpty("No sessions visible yet. Start pi with the websocket extension, or run the host supervisor to discover inactive local sessions."));
		return;
	}

	for (const session of sessions) {
		const row = document.createElement("button");
		row.type = "button";
		row.className = `list-item ${session.sessionGuid === currentSessionGuid ? "active" : ""}`;
		row.onclick = () => attachSession(session.sessionGuid, {
			hostId: session.hostId,
			hostname: session.hostname,
			cwd: session.cwd,
			hostConnected: session.hostConnected,
			closeSidebar: true,
		});

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
		browserListEl.appendChild(renderEmpty("No project folders are visible yet. Live sessions and supervisor-discovered sessions will appear here grouped by project."));
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
		main.appendChild(makeLine("project-host", project.hostname));
		const projectPathEl = makeLine("project-path", project.cwd);
		projectPathEl.title = project.cwd;
		main.appendChild(projectPathEl);
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
			row.onclick = () => attachSession(session.sessionGuid, {
				hostId: session.hostId,
				hostname: session.hostname,
				cwd: session.cwd,
				hostConnected: session.hostConnected,
				closeSidebar: true,
			});

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
	if (!session.hostConnected && !session.owner) {
		badges.push(createBadge("offline", "disconnected"));
	}
	badges.push(createBadge(session.owner || "inactive", session.owner || "inactive"));
	if (session.busy) badges.push(createBadge("busy", "busy"));
	if (session.queuedInputCount > 0) badges.push(createBadge(`${session.queuedInputCount} queued`, "queued"));
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
		? {
			hostId: context.hostId,
			hostname: context.hostname || context.hostId,
			cwd: context.cwd,
			hostConnected: !!context.hostConnected,
		}
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
	const shouldStick = forceScroll || stickToBottom;
	messagesEl.innerHTML = "";

	if (!currentSessionGuid) {
		messagesEl.appendChild(renderMessagesEmpty("Select a session to watch it live, or switch to Projects to start a brand-new background session."));
		return;
	}

	const fragments = [];
	for (const message of currentSession.history) {
		fragments.push(renderMessage(message));
	}

	for (const queuedInput of currentSession.queuedInputs) {
		fragments.push(renderQueuedInput(queuedInput));
	}

	for (const tool of currentSession.activeTools) {
		fragments.push(renderActiveTool(tool));
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
		if (shouldStick) {
			scrollMessagesToBottom();
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
		return buildMessageElement(
			"assistant",
			message.text || "",
			message.timestamp,
			getAssistantMessageStatus(message),
		);
	}
	if (message.role === "toolResult") {
		return renderToolMessage(message);
	}
	return renderSystemMessage(message.text || "");
}

function renderQueuedInput(queuedInput) {
	return buildMessageElement("user queued", queuedInput?.text || "", queuedInput?.timestamp || null, "queued");
}

function renderToolMessage(message) {
	return buildToolElement(message, {
		timestamp: message?.timestamp || null,
		status: toolsExpanded ? "expanded" : "collapsed",
		isError: !!message?.isError,
		isActive: false,
	});
}

function renderActiveTool(tool) {
	return buildToolElement(tool, {
		timestamp: null,
		status: "running",
		isError: false,
		isActive: true,
	});
}

function buildToolElement(tool, options = {}) {
	const row = document.createElement("div");
	row.className = "message-row tool";

	const el = document.createElement("div");
	el.className = `message tool ${options.isError ? "error" : ""}`.trim();

	if (options.timestamp || options.status) {
		const ts = document.createElement("div");
		ts.className = "timestamp";
		const parts = [];
		if (options.timestamp) parts.push(new Date(options.timestamp).toLocaleTimeString());
		if (options.status) parts.push(options.status);
		ts.textContent = parts.join(" • ");
		el.appendChild(ts);
	}

	const headerEl = document.createElement("div");
	headerEl.className = "tool-header";
	headerEl.textContent = formatToolHeader(tool);
	el.appendChild(headerEl);

	const body = formatToolBody(tool, options.isActive);
	if (body) {
		const bodyEl = document.createElement("div");
		bodyEl.className = "tool-body";
		bodyEl.textContent = body;
		el.appendChild(bodyEl);
	}

	const footer = formatToolFooter(tool, options.isActive);
	if (footer) {
		const footerEl = document.createElement("div");
		footerEl.className = "tool-footer";
		footerEl.textContent = footer;
		el.appendChild(footerEl);
	}

	row.appendChild(el);
	return row;
}

function formatToolHeader(tool) {
	const toolName = String(tool?.toolName || "tool").toLowerCase();
	const args = tool?.args || {};
	const details = tool?.details || {};
	const path = shortenToolPath(args.file_path ?? args.path);

	switch (toolName) {
		case "bash": {
			const command = String(args.command || "...");
			const timeout = args.timeout ? ` (timeout ${args.timeout}s)` : "";
			return `$ ${command}${timeout}`;
		}
		case "read": {
			let suffix = "";
			if (args.offset !== undefined || args.limit !== undefined) {
				const start = Number(args.offset ?? 1);
				const end = args.limit !== undefined ? start + Number(args.limit) - 1 : "";
				suffix = `:${start}${end ? `-${end}` : ""}`;
			}
			return `read ${path || "..."}${suffix}`;
		}
		case "write":
			return `write ${path || "..."}`;
		case "edit": {
			const firstChangedLine = details?.firstChangedLine ? `:${details.firstChangedLine}` : "";
			return `edit ${path || "..."}${firstChangedLine}`;
		}
		case "ls":
			return `ls ${shortenToolPath(args.path || ".")}${args.limit !== undefined ? ` (limit ${args.limit})` : ""}`;
		case "find":
			return `find ${args.pattern || ""} in ${shortenToolPath(args.path || ".")}${args.limit !== undefined ? ` (limit ${args.limit})` : ""}`;
		case "grep": {
			const glob = args.glob ? ` (${args.glob})` : "";
			const limit = args.limit !== undefined ? ` limit ${args.limit}` : "";
			return `grep /${args.pattern || ""}/ in ${shortenToolPath(args.path || ".")}${glob}${limit}`;
		}
		default:
			return String(tool?.toolName || "tool");
	}
}

function formatToolBody(tool, isActive = false) {
	if (isActive) return "";

	const toolName = String(tool?.toolName || "tool").toLowerCase();
	const details = tool?.details || {};
	let text = "";

	if (toolName === "edit" && typeof details?.diff === "string" && details.diff) {
		text = details.diff;
	} else {
		text = String(tool?.text || "");
	}

	if (!text) return "(no output)";
	if (toolsExpanded) return text;

	const lines = text.split("\n");
	const maxLines = getToolPreviewLines(toolName);
	const visibleLines = lines.slice(0, maxLines);
	const remaining = lines.length - visibleLines.length;
	let output = visibleLines.join("\n");
	if (remaining > 0) {
		const label = toolName === "bash" ? "earlier lines" : "more lines";
		output += `\n... (${remaining} ${label}, Ctrl+O to expand)`;
	}
	return output;
}

function formatToolFooter(tool, isActive = false) {
	if (isActive) return "";
	const durationMs = Number(tool?.durationMs || 0);
	if (!durationMs) return "";
	return `Took ${(durationMs / 1000).toFixed(1)}s`;
}

function getToolPreviewLines(toolName) {
	switch (String(toolName || "").toLowerCase()) {
		case "bash":
			return 5;
		case "grep":
			return 15;
		case "ls":
		case "find":
			return 20;
		case "edit":
			return 20;
		case "read":
		case "write":
		default:
			return 10;
	}
}

function shortenToolPath(value) {
	const path = String(value || "");
	return path || "";
}

function renderAssistantStream(text) {
	return buildMessageElement("assistant streaming", text || "", null);
}

function getAssistantMessageStatus(message) {
	switch (message?.stopReason) {
		case "aborted":
			return "aborted";
		case "error":
			return "error";
		case "length":
			return "truncated";
		default:
			return "";
	}
}

function renderSystemMessage(text) {
	const row = document.createElement("div");
	row.className = "message-row system";
	const el = document.createElement("div");
	el.className = "message system";
	el.textContent = text;
	row.appendChild(el);
	return row;
}

function buildMessageElement(className, text, timestamp, status = "") {
	const row = document.createElement("div");
	row.className = `message-row ${className}`;
	const el = document.createElement("div");
	el.className = `message ${className}`;
	if (timestamp || status) {
		const ts = document.createElement("div");
		ts.className = "timestamp";
		const parts = [];
		if (timestamp) parts.push(new Date(timestamp).toLocaleTimeString());
		if (status) parts.push(status);
		ts.textContent = parts.join(" • ");
		el.appendChild(ts);
	}
	const textEl = document.createElement("div");
	textEl.textContent = text || "";
	el.appendChild(textEl);
	row.appendChild(el);
	return row;
}

function isNearBottom() {
	return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= 24;
}

function scrollMessagesToBottom() {
	messagesEl.scrollTop = messagesEl.scrollHeight;
	stickToBottom = true;
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
	const queuedCount = currentSession.queuedInputs.length || summary?.queuedInputCount || 0;
	const queued = queuedCount ? ` • ${queuedCount} queued` : "";
	const model = currentSession.model || summary?.model || "no model";
	const title = clampText(currentSession.sessionName || summary?.sessionName || summary?.preview || shortId(currentSessionGuid), 120);
	const hostname = summary?.hostname || hostLabel;

	sessionTitleEl.textContent = title;
	sessionSubtitleEl.textContent = `${hostname} • ${owner}${busy}${queued} • ${model}`;
	sessionPathEl.textContent = currentSession.cwd || summary?.cwd || currentSessionGuid;
}

function updateControls() {
	const connected = ws?.readyState === WebSocket.OPEN;
	const summary = currentSessionGuid ? findSessionSummary(currentSessionGuid) : null;
	const hasOwner = !!(currentSession.owner || summary?.owner);
	const canAutoStart = !!(summary && summary.hostConnected && (summary.sessionFile || summary.sessionGuid));
	const launchContext = getCurrentLaunchContext();

	sendBtnEl.disabled = !(connected && currentSessionGuid && (hasOwner || canAutoStart));
	abortBtnEl.disabled = !(connected && currentSessionGuid && hasOwner);
	newSessionBtnEl.disabled = !(connected && launchContext && launchContext.hostConnected && launchContext.cwd && launchContext.cwd !== "(unknown project)");
	toolsExpandBtnEl.classList.toggle("active", toolsExpanded);
	toolsExpandBtnEl.textContent = toolsExpanded ? "Collapse Tools" : "Expand Tools";

	messageInputEl.placeholder = hasOwner
		? "Send a live message to the active session…"
		: currentSessionGuid && canAutoStart
			? "Send a message — toilet-pi will auto-start this session in background…"
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
			if (event.toolCallId) {
				upsertTool(session, {
					toolCallId: event.toolCallId,
					toolName: event.toolName || "tool",
					args: event.args,
				});
			}
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

		case "queued_input_add":
			if (event.queuedInput?.inputId) {
				const existingIndex = session.queuedInputs.findIndex((entry) => entry.inputId === event.queuedInput.inputId);
				if (existingIndex >= 0) session.queuedInputs[existingIndex] = event.queuedInput;
				else session.queuedInputs.push(event.queuedInput);
			}
			break;

		case "queued_input_remove":
			if (event.inputId) {
				session.queuedInputs = session.queuedInputs.filter((entry) => entry.inputId !== event.inputId);
			} else {
				session.queuedInputs.shift();
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
		queuedInputs: [],
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
		queuedInputs: Array.isArray(session?.queuedInputs) ? session.queuedInputs : [],
	};
}

function findSessionSummary(sessionGuid) {
	return flattenSessions().find((session) => session.sessionGuid === sessionGuid) || null;
}

function getSessionTitle(session) {
	return clampText(session.sessionName || session.preview || shortId(session.sessionGuid), 120);
}

function clampText(value, max = 120) {
	const text = String(value || "").trim();
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
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

function toggleToolsExpanded() {
	toolsExpanded = !toolsExpanded;
	renderSession();
	updateControls();
	showNotice(toolsExpanded ? "Tool output expanded" : "Tool output collapsed", "info");
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
installationBtnEl.onclick = () => openInstallationModal();
installationCloseBtnEl.onclick = () => closeInstallationModal();
installationModalScrimEl.onclick = (event) => {
	if (event.target === installationModalScrimEl) closeInstallationModal();
};
toolsExpandBtnEl.onclick = () => toggleToolsExpanded();

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

messagesEl.addEventListener("scroll", () => {
	stickToBottom = isNearBottom();
});

window.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && bodyEl.classList.contains("installation-open")) {
		closeInstallationModal();
		return;
	}
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
		event.preventDefault();
		toggleToolsExpanded();
	}
});

window.addEventListener("resize", () => {
	if (!MOBILE_MEDIA.matches) closeSidebar();
	if (stickToBottom) {
		requestAnimationFrame(() => scrollMessagesToBottom());
	}
});
