const MOBILE_MEDIA = window.matchMedia("(max-width: 900px)");

let ws = null;
let reconnectTimer = null;
let noticeTimer = null;
let hosts = [];
let currentView = "sessions";
let currentSessionGuid = null;
let currentSession = createEmptySession(null);
let selectedProjectContext = null;
let stickToBottom = true;
let isAuthenticated = false;
let machineConnectToken = null;
let isMintingMachineConnectToken = false;
const pendingLaunchRequests = new Map();
const thinkingOpenStateByKey = new Map();
const collapsedThinkingSessions = new Set();
const expandedToolKeys = new Set();
let scheduledSessionUiFrame = null;
let scheduledSessionUiForceScroll = false;
let scheduledSessionUiHeader = false;
let scheduledSessionUiControls = false;
let collapseLiveTurnDetails = loadStoredBoolean("toilet-pi-collapse-live-turn-details", false);

const bodyEl = document.body;
const sidebarSummaryEl = document.getElementById("sidebar-summary");
const sidebarScrimEl = document.getElementById("sidebar-scrim");
const connectionStatusEl = document.getElementById("connection-status");
const browserListEl = document.getElementById("browser-list");
const installationPanelEl = document.getElementById("installation-panel");
const installationBtnEl = document.getElementById("installation-btn");
const authModalScrimEl = document.getElementById("auth-modal-scrim");
const authFormEl = document.getElementById("auth-form");
const authFieldEl = authFormEl?.querySelector(".auth-field");
const authSubmitBtnEl = authFormEl?.querySelector('button[type="submit"]');
const authTokenInputEl = document.getElementById("auth-token-input");
const authCloseBtnEl = document.getElementById("auth-close-btn");
const authCancelBtnEl = document.getElementById("auth-cancel-btn");
const authForgetBtnEl = document.getElementById("auth-forget-btn");
const authConnectionStatusEl = document.getElementById("auth-connection-status");
const authConnectionDetailEl = document.getElementById("auth-connection-detail");
const installationModalScrimEl = document.getElementById("installation-modal-scrim");
const installationCloseBtnEl = document.getElementById("installation-close-btn");
const confirmModalScrimEl = document.getElementById("confirm-modal-scrim");
const confirmCloseBtnEl = document.getElementById("confirm-close-btn");
const confirmCancelBtnEl = document.getElementById("confirm-cancel-btn");
const confirmSubmitBtnEl = document.getElementById("confirm-submit-btn");
const confirmModalCopyEl = document.getElementById("confirm-modal-copy");
const viewSessionsBtnEl = document.getElementById("view-sessions-btn");
const viewProjectsBtnEl = document.getElementById("view-projects-btn");
const menuBtnEl = document.getElementById("menu-btn");
const sidebarCloseBtnEl = document.getElementById("sidebar-close");
const sessionTitleEl = document.getElementById("session-title");
const sessionSubtitleEl = document.getElementById("session-subtitle");
const sessionPathEl = document.getElementById("session-path");
const sessionWorkingIndicatorEl = document.getElementById("session-working-indicator");
const headerMenuEl = document.getElementById("header-menu");
const toggleLiveTurnDetailsBtnEl = document.getElementById("toggle-live-turn-details-btn");
const newSessionBtnEl = document.getElementById("new-session-btn");
const newSessionFabEl = document.getElementById("new-session-fab");
const killSessionBtnEl = document.getElementById("kill-session-btn");
const noticeBarEl = document.getElementById("notice-bar");
const messagesEl = document.getElementById("messages");
const messagesContentEl = document.getElementById("messages-content");
const workingPlaceholderRowEl = document.getElementById("working-placeholder-row");
const workingPlaceholderLabelEl = document.getElementById("working-placeholder-label");
const workingPlaceholderMetaEl = document.getElementById("working-placeholder-meta");
const messageInputEl = document.getElementById("message-input");
const sendBtnEl = document.getElementById("send-btn");
const abortBtnEl = document.getElementById("abort-btn");

function resizeMessageInput() {
	if (!messageInputEl) return;
	messageInputEl.style.height = "auto";
	messageInputEl.style.height = `${Math.min(messageInputEl.scrollHeight, 160)}px`;
}

registerPwa();
updateLiveTurnDetailsToggleUi();
renderInstallation();
renderBrowserList();
renderSession({ forceScroll: true });
updateHeader();
updateControls();
updateViewButtons();
setConnection(false, true);
void initializeAuth();

async function initializeAuth() {
	const hashParams = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
	const tokenFromHash = hashParams.get("token")?.trim() || null;
	if (tokenFromHash) {
		history.replaceState(null, "", `${location.pathname}${location.search}`);
		const success = await loginWithAdminToken(tokenFromHash, { showNoticeOnSuccess: false });
		if (!success) showNotice("Admin token rejected", "error");
		return;
	}
	await refreshAuthState({ connectWhenAuthenticated: true, suppressNotice: true });
}

function loadStoredBoolean(key, fallback = false) {
	try {
		const raw = localStorage.getItem(key);
		if (raw == null) return fallback;
		return raw === "1";
	} catch {
		return fallback;
	}
}

function storeBoolean(key, value) {
	try {
		localStorage.setItem(key, value ? "1" : "0");
	} catch {
		// Ignore storage errors.
	}
}

function updateLiveTurnDetailsToggleUi() {
	if (!toggleLiveTurnDetailsBtnEl) return;
	toggleLiveTurnDetailsBtnEl.textContent = collapseLiveTurnDetails
		? "Show live turn details"
		: "Collapse live turn details";
}

function getWebSocketUrl(token = null) {
	const url = new URL(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${getWebSocketPathname()}`);
	if (token) url.searchParams.set("token", token);
	return url.toString();
}

function getWebSocketPathname() {
	const publicPathname = normalizePublicPathname(location.pathname || "/");
	if (publicPathname === "/") return "/ws";
	return `${publicPathname.replace(/\/+$/, "")}/ws`;
}

function normalizePublicPathname(pathname) {
	if (!pathname || pathname === "/") return "/";
	if (pathname.endsWith("/ws")) return pathname.slice(0, -"/ws".length) || "/";
	if (pathname.endsWith("/index.html")) return pathname.slice(0, -"/index.html".length) || "/";
	return pathname;
}

function getConnectUrl() {
	return machineConnectToken ? getWebSocketUrl(machineConnectToken) : null;
}

function getAuthPath(pathname) {
	const publicPathname = normalizePublicPathname(location.pathname || "/");
	const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
	if (publicPathname === "/") return suffix;
	return `${publicPathname.replace(/\/+$/, "")}${suffix}`;
}

function getServiceWorkerPath() {
	const publicPathname = normalizePublicPathname(location.pathname || "/");
	if (publicPathname === "/") return "/sw.js";
	return `${publicPathname.replace(/\/+$/, "")}/sw.js`;
}

async function requestJson(path, options = {}) {
	const response = await fetch(path, {
		...options,
		credentials: "same-origin",
		headers: {
			Accept: "application/json",
			...(options.headers || {}),
		},
	});
	const text = await response.text();
	let payload = null;
	if (text) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = null;
		}
	}
	if (!response.ok) {
		throw new Error(payload?.message || `Request failed (${response.status})`);
	}
	return payload;
}

async function refreshAuthState({ connectWhenAuthenticated = false, suppressNotice = false, keepCurrentOnError = false } = {}) {
	try {
		const status = await requestJson(getAuthPath("/auth/status"), { method: "GET" });
		isAuthenticated = !!status?.authenticated;
	} catch {
		if (!keepCurrentOnError) isAuthenticated = false;
	}

	if (!isAuthenticated) {
		machineConnectToken = null;
		resetConnection("unauthenticated");
	}

	setConnection(ws?.readyState === WebSocket.OPEN, suppressNotice);
	if (isAuthenticated && connectWhenAuthenticated) connect();
	return isAuthenticated;
}

async function loginWithAdminToken(token, { showNoticeOnSuccess = true } = {}) {
	const normalized = String(token || "").trim();
	if (!normalized) return false;

	try {
		await requestJson(getAuthPath("/auth/login"), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ token: normalized }),
		});
		isAuthenticated = true;
		resetAuthState();
		setConnection(false, true);
		connect();
		if (showNoticeOnSuccess) showNotice("Logged in", "info");
		return true;
	} catch (error) {
		isAuthenticated = false;
		resetAuthState();
		showNotice(error instanceof Error ? error.message : "Login failed", "error");
		return false;
	}
}

async function logoutOfServer() {
	try {
		await requestJson(getAuthPath("/auth/logout"), { method: "POST" });
	} catch (error) {
		showNotice(error instanceof Error ? error.message : "Logout failed", "error");
	}
	isAuthenticated = false;
	machineConnectToken = null;
	resetAuthState();
	setConnection(false, true);
}

async function generateMachineConnectToken({ copyAfter = false } = {}) {
	if (!isAuthenticated) {
		showNotice("Sign in to mint a machine connect URL", "error");
		return null;
	}
	if (isMintingMachineConnectToken) return null;

	isMintingMachineConnectToken = true;
	renderInstallation();
	try {
		const response = await requestJson(getAuthPath("/auth/machine-token"), { method: "POST" });
		machineConnectToken = typeof response?.token === "string" ? response.token : null;
		if (!machineConnectToken) {
			showNotice("Server did not return a machine connect token", "error");
			return null;
		}
		if (copyAfter) {
			await copyText(`/toilet-pi ${getConnectUrl()}`);
		}
		return machineConnectToken;
	} catch (error) {
		showNotice(error instanceof Error ? error.message : "Failed to mint machine connect URL", "error");
		return null;
	} finally {
		isMintingMachineConnectToken = false;
		renderInstallation();
	}
}

function registerPwa() {
	if (!("serviceWorker" in navigator)) return;
	window.addEventListener("load", () => {
		navigator.serviceWorker.register(getServiceWorkerPath()).catch(() => {
			// Ignore PWA registration errors.
		});
	});
}

function resetConnection(reason = "reset") {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (!ws) return;
	const socket = ws;
	ws = null;
	socket.onopen = null;
	socket.onclose = null;
	socket.onerror = null;
	socket.onmessage = null;
	try {
		socket.close(1000, reason);
	} catch {
		// Ignore.
	}
}

function connect() {
	if (!isAuthenticated) {
		setConnection(false, true);
		return;
	}
	const wsUrl = getWebSocketUrl();
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
		return;
	}

	let opened = false;
	ws = new WebSocket(wsUrl);

	ws.onopen = () => {
		opened = true;
		setConnection(true);
		send({ type: "hello", role: "web" });
		if (currentSessionGuid) {
			setTimeout(() => send({ type: "attach", sessionGuid: currentSessionGuid }), 50);
		}
	};

	ws.onclose = async () => {
		ws = null;
		setConnection(false);
		if (!opened) {
			await refreshAuthState({
				connectWhenAuthenticated: false,
				suppressNotice: true,
				keepCurrentOnError: true,
			});
		}
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
	if (!isAuthenticated || reconnectTimer) return;
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

function scheduleSessionUiRefresh({ forceScroll = false, header = true, controls = true } = {}) {
	scheduledSessionUiForceScroll = scheduledSessionUiForceScroll || !!forceScroll;
	scheduledSessionUiHeader = scheduledSessionUiHeader || !!header;
	scheduledSessionUiControls = scheduledSessionUiControls || !!controls;
	if (scheduledSessionUiFrame) return;
	scheduledSessionUiFrame = requestAnimationFrame(() => {
		scheduledSessionUiFrame = null;
		const nextForceScroll = scheduledSessionUiForceScroll;
		const nextHeader = scheduledSessionUiHeader;
		const nextControls = scheduledSessionUiControls;
		scheduledSessionUiForceScroll = false;
		scheduledSessionUiHeader = false;
		scheduledSessionUiControls = false;
		renderSession({ forceScroll: nextForceScroll });
		if (nextHeader) updateHeader();
		if (nextControls) updateControls();
	});
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
				&& !currentSession.streamingThinkingText
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
			scheduleSessionUiRefresh();
			break;

		case "session_meta":
			if (message.sessionGuid !== currentSessionGuid) return;
			currentSession.owner = message.owner ?? null;
			currentSession.hostId = message.hostId ?? null;
			currentSession.hostname = message.hostname ?? currentSession.hostname ?? null;
			currentSession.sessionFile = message.sessionFile ?? null;
			currentSession.sessionName = message.sessionName ?? null;
			currentSession.cwd = message.cwd ?? null;
			currentSession.model = message.model ?? null;
			currentSession.contextWindowTokens = Number.isFinite(message.contextWindowTokens)
				? message.contextWindowTokens
				: currentSession.contextWindowTokens ?? null;
			currentSession.contextTokens = Number.isFinite(message.contextTokens)
				? message.contextTokens
				: currentSession.contextTokens ?? null;
			currentSession.costUsd = Number.isFinite(message.costUsd)
				? message.costUsd
				: currentSession.costUsd ?? null;
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
			showNotice(`Background session started on ${pending.hostname || message.hostname || message.hostId || "unknown computer"}`, "info");
			attachSession(message.sessionGuid, {
				hostId: message.hostId,
				hostname: message.hostname || pending.hostname || null,
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

function setConnection(connected, suppressNotice = false) {
	const connectionLabel = connected ? "Connected" : isAuthenticated ? "Disconnected" : "Unauthenticated";
	connectionStatusEl.textContent = connectionLabel;
	connectionStatusEl.className = `status-pill clickable ${connected ? "connected" : "disconnected"}`;
	connectionStatusEl.tabIndex = 0;
	connectionStatusEl.setAttribute("role", "button");
	connectionStatusEl.title = isAuthenticated
		? connected
			? "Connected. Click to manage your admin session."
			: "Disconnected. Click to manage your admin session."
		: "Unauthenticated. Click to sign in with your admin token.";
	updateSidebarSummary();
	updateAuthConnectionState();
	renderInstallation();
	updateControls();
	if (connected && noticeBarEl.textContent === "Disconnected from server. Reconnecting…") {
		clearNotice();
	}
	if (!connected && isAuthenticated && !suppressNotice) showNotice("Disconnected from server. Reconnecting…", "error", false);
}

function updateSidebarSummary() {
	if (!isAuthenticated) {
		sidebarSummaryEl.textContent = "Open toilet-pi and sign in with your admin token.";
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
	const connectUrl = getConnectUrl();
	installationPanelEl.innerHTML = "";

	const installSection = document.createElement("section");
	installSection.className = "install-section";
	const installTitle = document.createElement("div");
	installTitle.className = "install-copy";
	installTitle.textContent = "Install package";
	const installActions = document.createElement("div");
	installActions.className = "install-actions";
	const installCopyBtn = document.createElement("button");
	installCopyBtn.type = "button";
	installCopyBtn.textContent = "Copy";
	installCopyBtn.onclick = () => copyText(`pi install git:https://github.com/mrexodia/toilet-pi`);
	installActions.appendChild(installCopyBtn);
	const installCode = document.createElement("pre");
	installCode.className = "install-code";
	installCode.textContent = "pi install git:https://github.com/mrexodia/toilet-pi";
	installSection.appendChild(installTitle);
	installSection.appendChild(installActions);
	installSection.appendChild(installCode);
	installationPanelEl.appendChild(installSection);

	const connectSection = document.createElement("section");
	connectSection.className = "install-section";
	const connectTitle = document.createElement("div");
	connectTitle.className = "install-copy";
	connectTitle.textContent = "Configure a machine";
	const connectHint = document.createElement("div");
	connectHint.className = "install-hint";
	connectHint.textContent = isMintingMachineConnectToken
		? "Minting a machine-scoped connect URL…"
		: connectUrl
			? "This machine-scoped connect URL is meant for one computer. Generate a fresh one for each new machine you set up."
			: isAuthenticated
				? "Generate a machine-scoped connect URL for the computer you are setting up."
				: "Sign in first, then mint a machine-scoped connect URL.";
	const connectActions = document.createElement("div");
	connectActions.className = "install-actions";
	if (isAuthenticated) {
		const generateBtn = document.createElement("button");
		generateBtn.type = "button";
		generateBtn.textContent = isMintingMachineConnectToken
			? "Generating…"
			: connectUrl
				? "Generate new machine URL"
				: "Generate machine URL";
		generateBtn.disabled = isMintingMachineConnectToken;
		generateBtn.onclick = async () => {
			await generateMachineConnectToken();
		};
		connectActions.appendChild(generateBtn);

		const copyBtn = document.createElement("button");
		copyBtn.type = "button";
		copyBtn.textContent = "Copy";
		copyBtn.disabled = !connectUrl || isMintingMachineConnectToken;
		copyBtn.onclick = async () => {
			if (!getConnectUrl()) {
				const token = await generateMachineConnectToken();
				if (!token) return;
			}
			await copyText(`/toilet-pi ${getConnectUrl()}`);
		};
		connectActions.appendChild(copyBtn);
	} else {
		const signInBtn = document.createElement("button");
		signInBtn.type = "button";
		signInBtn.textContent = "Sign in";
		signInBtn.onclick = () => openAuthModal();
		connectActions.appendChild(signInBtn);
	}
	const connectCode = document.createElement("pre");
	connectCode.className = "install-code";
	connectCode.textContent = isMintingMachineConnectToken
		? "Minting machine connect URL…"
		: connectUrl
			? `/toilet-pi ${connectUrl}`
			: isAuthenticated
				? "Generate a machine connect URL, then paste it into `/toilet-pi` on that computer."
				: "Sign in to generate a machine connect URL.";
	connectSection.appendChild(connectTitle);
	connectSection.appendChild(connectHint);
	connectSection.appendChild(connectActions);
	connectSection.appendChild(connectCode);
	installationPanelEl.appendChild(connectSection);

	const pwaSection = document.createElement("section");
	pwaSection.className = "install-section";
	const pwaTitle = document.createElement("div");
	pwaTitle.className = "install-copy";
	pwaTitle.textContent = "Install on mobile";
	const pwaHint = document.createElement("div");
	pwaHint.className = "install-hint";
	pwaHint.textContent = "Install toilet-pi to hide most browser navigation chrome. On iPhone/iPad use Share → Add to Home Screen. On Android use Install app / Add to Home screen from the browser menu.";
	pwaSection.appendChild(pwaTitle);
	pwaSection.appendChild(pwaHint);
	installationPanelEl.appendChild(pwaSection);
}

async function copyText(text) {
	const value = String(text || "");
	if (!value) return;
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(value);
		} else {
			const input = document.createElement("textarea");
			input.value = value;
			input.setAttribute("readonly", "true");
			input.style.position = "fixed";
			input.style.opacity = "0";
			document.body.appendChild(input);
			input.select();
			document.execCommand("copy");
			input.remove();
		}
		showNotice("Copied", "info");
	} catch {
		showNotice("Copy failed", "error");
	}
}

function updateAuthConnectionState() {
	if (!authConnectionStatusEl || !authConnectionDetailEl) return;
	const connected = ws?.readyState === WebSocket.OPEN;
	authConnectionStatusEl.textContent = connected ? "Connected" : isAuthenticated ? "Disconnected" : "Unauthenticated";
	authConnectionStatusEl.className = `status-pill ${connected ? "connected" : "disconnected"}`;
	authConnectionDetailEl.textContent = connected
		? "You are signed in. Open Machine setup to mint machine connect URLs or log out here."
		: isAuthenticated
			? "You are signed in, but the live server connection is currently down."
			: "Enter your admin token to sign in.";
}

function closeHeaderMenu() {
	if (headerMenuEl) headerMenuEl.open = false;
}

function setCollapseLiveTurnDetails(value) {
	collapseLiveTurnDetails = !!value;
	storeBoolean("toilet-pi-collapse-live-turn-details", collapseLiveTurnDetails);
	updateLiveTurnDetailsToggleUi();
	renderSession();
}

function openAuthModal() {
	closeInstallationModal();
	closeHeaderMenu();
	updateAuthConnectionState();
	if (authTokenInputEl) authTokenInputEl.value = "";
	if (authForgetBtnEl) {
		authForgetBtnEl.disabled = !isAuthenticated;
		authForgetBtnEl.textContent = "Log out";
	}
	if (authFieldEl) authFieldEl.hidden = !!isAuthenticated;
	if (authSubmitBtnEl) authSubmitBtnEl.hidden = !!isAuthenticated;
	if (authCancelBtnEl) authCancelBtnEl.textContent = isAuthenticated ? "Close" : "Cancel";
	bodyEl.classList.add("auth-open");
	requestAnimationFrame(() => {
		if (isAuthenticated) installationBtnEl?.focus();
		else authTokenInputEl?.focus();
	});
}

function closeAuthModal() {
	bodyEl.classList.remove("auth-open");
}

function resetAuthState() {
	hosts = [];
	currentSessionGuid = null;
	currentSession = createEmptySession(null);
	selectedProjectContext = null;
	pendingLaunchRequests.clear();
	machineConnectToken = null;
	resetConnection("reauth");
	setConnection(false, true);
	renderBrowserList();
	updateHeader();
	updateControls();
	renderSession({ forceScroll: true });
}

async function applyAuthToken(token) {
	return loginWithAdminToken(token);
}

async function forgetAuthToken() {
	return logoutOfServer();
}

async function openInstallationModal() {
	closeAuthModal();
	closeHeaderMenu();
	renderInstallation();
	bodyEl.classList.add("installation-open");
	if (isAuthenticated && !machineConnectToken && !isMintingMachineConnectToken) {
		await generateMachineConnectToken();
	}
}

function closeInstallationModal() {
	renderInstallation();
	bodyEl.classList.remove("installation-open");
}

function openConfirmModal(message) {
	if (confirmModalCopyEl) confirmModalCopyEl.textContent = message;
	closeHeaderMenu();
	bodyEl.classList.add("confirm-open");
	requestAnimationFrame(() => confirmSubmitBtnEl?.focus());
}

function closeConfirmModal() {
	bodyEl.classList.remove("confirm-open");
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

		const projectLabel = getProjectLabel(session.cwd);
		row.appendChild(makeTitleLine("item-title", projectLabel || getSessionTitle(session), formatSessionUsage(session)));
		const detailLabel = getSessionDetailLabel(session);
		if (detailLabel) row.appendChild(makeLine("item-subtitle", detailLabel));
		row.appendChild(makeLine("item-meta", `${session.model || "no model"}${session.hostname ? ` • ${session.hostname}` : ""}`));
		if (session.cwd) {
			const pathEl = makeLine("item-path", session.cwd);
			pathEl.title = session.cwd;
			row.appendChild(pathEl);
		}

		const badges = document.createElement("div");
		badges.className = "item-badges";
		for (const badge of buildSessionBadges(session)) badges.appendChild(badge);
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
		const selectBtn = document.createElement("button");
		selectBtn.type = "button";
		selectBtn.className = `project-select ${isSelectedProject(project) ? "active" : ""}`;
		selectBtn.onclick = () => {
			selectedProjectContext = { hostId: project.hostId, hostname: project.hostname, cwd: project.cwd, hostConnected: project.hostConnected };
			currentSessionGuid = null;
			currentSession = createEmptySession(null);
			send({ type: "attach", sessionGuid: null });
			renderBrowserList();
			renderSession({ forceScroll: true });
			updateHeader();
			updateControls();
			if (MOBILE_MEDIA.matches) showNotice(`Selected ${basenamePath(project.cwd)}`, "info");
		};
		selectBtn.appendChild(makeTitleLine("project-title", basenamePath(project.cwd), formatProjectUsage(project)));
		selectBtn.appendChild(makeLine("project-meta", `${project.sessions.length} session${project.sessions.length === 1 ? "" : "s"} • ${project.hostConnected ? "online" : "offline"}${project.hostname ? ` • ${project.hostname}` : ""}`));
		const projectPathEl = makeLine("project-path", project.cwd);
		projectPathEl.title = project.cwd;
		selectBtn.appendChild(projectPathEl);
		header.appendChild(selectBtn);
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
			row.appendChild(makeTitleLine("session-mini-title", getSessionDetailLabel(session) || session.sessionName || session.preview || shortId(session.sessionGuid), formatSessionUsage(session)));
			const subtitle = `${session.model || "no model"}${session.hostname ? ` • ${session.hostname}` : ""}`;
			row.appendChild(makeLine("session-mini-subtitle", subtitle));
			const itemBadges = document.createElement("div");
			itemBadges.className = "item-badges";
			for (const badge of buildSessionBadges(session)) itemBadges.appendChild(badge);
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

function makeTitleLine(className, text, meta = "") {
	const el = document.createElement("div");
	el.className = `${className} title-with-meta`;
	const textEl = document.createElement("span");
	textEl.className = "title-text";
	textEl.textContent = text;
	el.appendChild(textEl);
	if (meta) {
		const metaEl = document.createElement("span");
		metaEl.className = "title-inline-meta";
		metaEl.textContent = meta;
		metaEl.title = meta;
		el.appendChild(metaEl);
	}
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
	currentSession.hostId = currentSession.hostId || summary.hostId;
	currentSession.hostname = currentSession.hostname || summary.hostname || null;
	currentSession.sessionFile = currentSession.sessionFile || summary.sessionFile || null;
	currentSession.sessionName = summary.sessionName ?? currentSession.sessionName;
	currentSession.cwd = summary.cwd ?? currentSession.cwd;
	currentSession.model = summary.model ?? currentSession.model;
	currentSession.contextWindowTokens = summary.contextWindowTokens ?? currentSession.contextWindowTokens;
	currentSession.contextTokens = summary.contextTokens ?? currentSession.contextTokens;
	currentSession.costUsd = summary.costUsd ?? currentSession.costUsd;
	currentSession.owner = currentSession.owner ?? summary.owner ?? null;
	currentSession.busy = currentSession.busy || !!summary.busy;
	selectedProjectContext = summary.cwd
		? { hostId: summary.hostId, hostname: summary.hostname, cwd: summary.cwd, hostConnected: summary.hostConnected }
		: selectedProjectContext;
}

function renderSession({ forceScroll = false } = {}) {
	const shouldStick = forceScroll || stickToBottom;
	messagesContentEl.innerHTML = "";

	if (!currentSessionGuid) {
		messagesContentEl.appendChild(renderMessagesEmpty("Select a session to watch it live, or switch to Projects to start a brand-new background session."));
		workingPlaceholderRowEl.hidden = true;
		return;
	}

	const summary = findSessionSummary(currentSessionGuid);
	const fragments = renderHistoryFragments(currentSession, summary);

	const showCollapsedLiveTurnBubble = collapseLiveTurnDetails && isSessionWorking(summary);
	if (showCollapsedLiveTurnBubble) {
		fragments.push(renderCollapsedLiveTurnBubble());
	} else {
		for (const tool of currentSession.activeTools) {
			fragments.push(renderActiveTool(tool));
		}
		if (currentSession.streamingText || currentSession.streamingThinkingText) {
			fragments.push(renderAssistantStream(currentSession.streamingText, currentSession.streamingThinkingText));
		}
	}

	for (const queuedInput of currentSession.queuedInputs) {
		fragments.push(renderQueuedInput(queuedInput));
	}

	const showWorkingPlaceholder = shouldRenderWorkingPlaceholder(summary);
	updateWorkingPlaceholder(summary, showWorkingPlaceholder);
	workingPlaceholderRowEl.hidden = !showWorkingPlaceholder;

	if (fragments.length === 0) {
		messagesContentEl.appendChild(renderMessagesEmpty("No messages in this session yet. Send a message to start working."));
		return;
	}

	for (const fragment of fragments) {
		messagesContentEl.appendChild(fragment);
	}

	requestAnimationFrame(() => {
		if (shouldStick) {
			scrollMessagesToBottom();
		}
	});
}

function renderMessagesEmpty(text) {
	const empty = document.createElement("div");
	empty.className = "messages-empty";
	empty.textContent = text;
	return empty;
}

function getVisibleHistoryMessages(session, summary) {
	const history = Array.isArray(session?.history) ? session.history : [];
	if (!collapseLiveTurnDetails || !isSessionWorking(summary)) return history;
	const startIndex = Number.isInteger(session?.liveTurnStartHistoryIndex)
		? session.liveTurnStartHistoryIndex
		: null;
	if (startIndex == null || startIndex < 0) return history;
	return history.slice(0, startIndex);
}

function renderHistoryFragments(session, summary) {
	const history = getVisibleHistoryMessages(session, summary);
	if (!collapseLiveTurnDetails) {
		return history.map((message) => renderMessage(message));
	}

	const fragments = [];
	let turnPhaseBuffer = [];
	let inCollapsedTurn = false;

	const flushTurnPhaseBuffer = () => {
		if (!turnPhaseBuffer.length) return;
		fragments.push(renderCollapsedHistoryTurnSummary(turnPhaseBuffer));
		turnPhaseBuffer = [];
	};

	for (const message of history) {
		if (message?.role === "user") {
			flushTurnPhaseBuffer();
			inCollapsedTurn = true;
			fragments.push(renderMessage(message));
			continue;
		}

		if (isCollapsedTurnPhaseMessage(message)) {
			turnPhaseBuffer.push(message);
			inCollapsedTurn = true;
			continue;
		}

		if (message?.role === "assistant") {
			flushTurnPhaseBuffer();
			fragments.push(renderMessage(message));
			inCollapsedTurn = false;
			continue;
		}

		flushTurnPhaseBuffer();
		fragments.push(renderMessage(message));
		inCollapsedTurn = false;
	}

	if (inCollapsedTurn) flushTurnPhaseBuffer();
	return fragments;
}

function isCollapsedTurnPhaseMessage(message) {
	if (!message || typeof message !== "object") return false;
	if (message.role === "toolResult") return true;
	return message.role === "assistant" && message.stopReason === "toolUse";
}

function renderCollapsedHistoryTurnSummary(messages) {
	const toolMessages = Array.isArray(messages)
		? messages.filter((message) => message?.role === "toolResult")
		: [];
	const count = toolMessages.length;
	const errorCount = toolMessages.filter((message) => !!message?.isError).length;
	const detail = getCollapsedHistoryTurnDetail(messages);
	const row = document.createElement("div");
	row.className = "message-row tool";
	const el = document.createElement("div");
	el.className = `message tool ${errorCount > 0 ? "error" : "success"} compact`;
	const headerEl = document.createElement("div");
	headerEl.className = "tool-header";
	headerEl.textContent = formatCollapsedHistoryToolSummaryText(count, errorCount);
	el.appendChild(headerEl);
	if (detail) {
		const textEl = document.createElement("div");
		textEl.className = "message-text";
		textEl.textContent = detail;
		el.appendChild(textEl);
	}
	row.appendChild(el);
	return row;
}

function getCollapsedHistoryTurnDetail(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role === "assistant" && message?.thinkingText) {
			return `Thinking: ${collapseThinkingPreview(message.thinkingText)}`;
		}
		if (message?.role === "toolResult") {
			const label = formatToolHeader(message);
			if (message?.isError) return `${label} • error`;
			return label;
		}
	}
	return "Working…";
}

function formatCollapsedHistoryToolSummaryText(count, errorCount) {
	const safeCount = Math.max(0, Number(count || 0));
	const safeErrors = Math.max(0, Number(errorCount || 0));
	const toolLabel = safeCount <= 0
		? "Working"
		: safeCount === 1
			? "1 tool called"
			: `${safeCount} tools called`;
		if (!safeErrors) return toolLabel;
	return `${toolLabel} • ${safeErrors} error${safeErrors === 1 ? "" : "s"}`;
}

function renderMessage(message) {
	if (message.role === "user") {
		return buildMessageElement("user", message.text || "", message.timestamp);
	}
	if (message.role === "assistant") {
		return buildMessageElement(
			"assistant",
			getAssistantMessageText(message),
			message.timestamp,
			getAssistantMessageStatus(message),
			message.thinkingText || "",
			getThinkingKey(message),
			getThinkingScope(),
		);
	}
	if (message.role === "toolResult") {
		return renderToolMessage(message);
	}
	return renderSystemMessage(message.text || "");
}

function renderQueuedInput(queuedInput) {
	const isLocalTuiPlaceholder = queuedInput?.inputId === "__local_pending__";
	return buildMessageElement(
		"user queued",
		isLocalTuiPlaceholder ? "Queued in local pi TUI" : (queuedInput?.text || ""),
		queuedInput?.timestamp || null,
		isLocalTuiPlaceholder ? "local queue" : "queued",
	);
}

function shouldRenderWorkingPlaceholder(summary) {
	return !!(
		isSessionWorking(summary)
		&& !currentSession.activeTools.length
		&& !currentSession.streamingText
		&& !currentSession.streamingThinkingText
	);
}

function updateWorkingPlaceholder(summary, visible) {
	if (!workingPlaceholderLabelEl || !workingPlaceholderMetaEl) return;
	workingPlaceholderLabelEl.textContent = visible ? "Working…" : "Working...";
	const meta = visible ? getWorkingPlaceholderMeta(summary) : null;
	workingPlaceholderMetaEl.textContent = meta?.label || "";
	workingPlaceholderMetaEl.title = meta?.title || "";
	workingPlaceholderMetaEl.hidden = !meta?.label;
}

function getWorkingPlaceholderMeta(summary) {
	const exactUsage = formatSessionUsage(currentSession);
	if (exactUsage) {
		return {
			label: exactUsage,
			title: buildUsageTitle(currentSession, summary),
		};
	}
	const stats = estimateApproxContextUsage(currentSession);
	if (!stats) return null;
	if (stats.contextWindowTokens) {
		return {
			label: `${stats.percentLabel}/${formatPiTokenCount(stats.approxTokens)}`,
			title: `Approx context usage: ~${formatCompactNumber(stats.approxTokens)} / ${formatCompactNumber(stats.contextWindowTokens)} tokens`,
		};
	}
	return {
		label: `~${formatCompactNumber(stats.approxChars)} chars`,
		title: `Approx visible context size: ~${formatCompactNumber(stats.approxChars)} characters${summary?.model ? ` • ${summary.model}` : ""}`,
	};
}

function estimateApproxContextUsage(session) {
	if (!session) return null;
	let approxChars = 0;
	for (const message of Array.isArray(session.history) ? session.history : []) {
		approxChars += estimateMessageContextChars(message);
	}
	if (session.streamingText) approxChars += String(session.streamingText).length;
	if (!approxChars) return null;
	const approxTokens = Math.max(1, Math.round(approxChars / 4));
	const contextWindowTokens = Number.isFinite(session.contextWindowTokens) && session.contextWindowTokens > 0
		? session.contextWindowTokens
		: null;
	const percent = contextWindowTokens
		? Math.max(1, Math.round((approxTokens / contextWindowTokens) * 100))
		: null;
	return {
		approxChars,
		approxTokens,
		contextWindowTokens,
		percent,
		percentLabel: percent == null ? "" : percent >= 100 ? "100%+" : `~${percent}%`,
	};
}

function estimateMessageContextChars(message) {
	if (!message || typeof message !== "object") return 0;
	if (message.role === "toolResult") {
		if (isToolExcludedFromContext(message)) return 0;
		return [
			String(message.toolName || "").length,
			measureStructuredValue(message.args),
			String(message.text || "").length,
		].reduce((sum, value) => sum + value, 0);
	}
	return [
		String(message.text || "").length,
		String(message.thinkingText || "").length,
	].reduce((sum, value) => sum + value, 0);
}

function measureStructuredValue(value) {
	if (value == null) return 0;
	if (typeof value === "string") return value.length;
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function formatCompactNumber(value) {
	const number = Number(value || 0);
	if (!Number.isFinite(number) || number <= 0) return "0";
	if (number >= 1000000) return `${(number / 1000000).toFixed(number >= 10000000 ? 0 : 1)}M`;
	if (number >= 1000) return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k`;
	return String(Math.round(number));
}

function formatPiTokenCount(value) {
	const number = Number(value || 0);
	if (!Number.isFinite(number) || number <= 0) return "0";
	if (number < 1000) return `${Math.round(number)}`;
	if (number < 10000) return `${(number / 1000).toFixed(1)}k`;
	if (number < 1000000) return `${Math.round(number / 1000)}k`;
	return `${(number / 1000000).toFixed(1)}M`;
}

function formatUsd(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return "";
	return `$${number.toFixed(3)}`;
}

function formatUsagePercent(contextTokens, contextWindowTokens) {
	const used = Number(contextTokens || 0);
	const total = Number(contextWindowTokens || 0);
	if (!Number.isFinite(used) || !Number.isFinite(total) || used <= 0 || total <= 0) return "";
	const percent = Math.max(1, Math.round((used / total) * 100));
	return percent >= 100 ? "100%+" : `${percent}%`;
}

function formatSessionUsage(session) {
	if (!session || typeof session !== "object") return "";
	const contextTokens = Number.isFinite(session.contextTokens) && session.contextTokens > 0
		? session.contextTokens
		: null;
	const contextWindowTokens = Number.isFinite(session.contextWindowTokens) && session.contextWindowTokens > 0
		? session.contextWindowTokens
		: null;
	const costUsd = Number.isFinite(session.costUsd) && session.costUsd > 0
		? session.costUsd
		: null;
	const parts = [];
	if (contextTokens) {
		const tokenLabel = formatPiTokenCount(contextTokens);
		const percentLabel = contextWindowTokens ? formatUsagePercent(contextTokens, contextWindowTokens) : "";
		parts.push(percentLabel ? `${percentLabel}/${tokenLabel}` : tokenLabel);
	}
	if (costUsd) parts.push(formatUsd(costUsd));
	return parts.filter(Boolean).join(", ");
}

function formatProjectUsage(project) {
	if (!project?.sessions?.length) return "";
	for (const session of project.sessions) {
		const usage = formatSessionUsage(session);
		if (usage) return usage;
	}
	return "";
}

function buildUsageTitle(session, summary) {
	const parts = [];
	if (Number.isFinite(session?.contextTokens) && session.contextTokens > 0) {
		const percentLabel = Number.isFinite(session?.contextWindowTokens) && session.contextWindowTokens > 0
			? formatUsagePercent(session.contextTokens, session.contextWindowTokens)
			: "";
		const tokenLabel = formatPiTokenCount(session.contextTokens);
		parts.push(percentLabel ? `Context: ${percentLabel}/${tokenLabel}` : `Context: ${tokenLabel}`);
	}
	if (Number.isFinite(session?.costUsd) && session.costUsd > 0) {
		parts.push(`Cost: ${formatUsd(session.costUsd)}`);
	}
	if (summary?.model || session?.model) parts.push(`Model: ${summary?.model || session?.model}`);
	return parts.join(" • ");
}

function renderToolMessage(message) {
	return buildToolElement(message, {
		timestamp: message?.timestamp || null,
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
		compact: collapseLiveTurnDetails,
	});
}

function renderCollapsedLiveTurnBubble() {
	const totalCount = Math.max(currentSession.liveTurnToolCount || 0, currentSession.activeTools.length || 0);
	const activeCount = currentSession.activeTools.length || 0;
	const detail = getCollapsedLiveTurnDetail();
	const row = document.createElement("div");
	row.className = "message-row tool";
	const el = document.createElement("div");
	el.className = `message tool ${currentSession.liveTurnLastActivity?.isError ? "error" : "running"} compact`;
	const headerEl = document.createElement("div");
	headerEl.className = "tool-header";
	headerEl.textContent = formatCollapsedLiveToolSummary(totalCount, activeCount);
	el.appendChild(headerEl);
	if (detail) {
		const textEl = document.createElement("div");
		textEl.className = "message-text";
		textEl.textContent = detail;
		el.appendChild(textEl);
	}
	row.appendChild(el);
	return row;
}

function getCollapsedLiveTurnDetail() {
	if (currentSession.streamingThinkingText) {
		return `Thinking: ${collapseThinkingPreview(currentSession.streamingThinkingText)}`;
	}
	if (currentSession.activeTools.length > 0) {
		return formatToolHeader(currentSession.activeTools[currentSession.activeTools.length - 1]);
	}
	if (currentSession.liveTurnLastActivity?.text) {
		return currentSession.liveTurnLastActivity.text;
	}
	if (currentSession.streamingText) {
		return clampText(currentSession.streamingText, 160);
	}
	return "Working…";
}

function formatCollapsedLiveToolSummary(totalCount, activeCount) {
	const total = Math.max(0, Number(totalCount || 0));
	const active = Math.max(0, Number(activeCount || 0));
	if (active > 0 && total > active) return `${total} tools called • ${active} running`;
	if (active > 1) return `${active} tools running`;
	if (active === 1 && total <= 1) return "1 tool running";
	if (total === 1) return "1 tool called";
	return `${total} tools called`;
}

function buildToolElement(tool, options = {}) {
	const row = document.createElement("div");
	row.className = "message-row tool";

	const el = document.createElement("div");
	const toolStateClass = options.isActive ? "running" : options.isError ? "error" : "success";
	const isExcludedBash = isToolExcludedFromContext(tool);
	const compact = !!options.compact;
	el.className = `message tool ${toolStateClass}${isExcludedBash ? " excluded" : ""}${compact ? " compact" : ""}`.trim();

	const toolKey = getToolUiKey(tool, options);
	const expanded = isToolExpanded(tool, options, toolKey);

	const headerEl = document.createElement("div");
	headerEl.className = "tool-header";
	headerEl.textContent = formatToolHeader(tool);
	el.appendChild(headerEl);

	if (!compact) {
		const bodyEl = createToolBodyElement(tool, options.isActive, expanded);
		if (bodyEl) el.appendChild(bodyEl);

		const footerEl = createToolFooterElement(tool, options, toolKey, expanded);
		if (footerEl) el.appendChild(footerEl);
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
		case "write": {
			const lineCount = typeof args.content === "string" ? args.content.split("\n").length : 0;
			const lineInfo = lineCount > 0 ? ` (${lineCount} line${lineCount === 1 ? "" : "s"})` : "";
			return `write ${path || "..."}${lineInfo}`;
		}
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

function formatToolBody(tool, isActive = false, expanded = false) {
	const toolName = String(tool?.toolName || "tool").toLowerCase();
	if (toolName === "write") return formatWriteToolBody(tool, isActive, expanded);

	const text = extractToolText(tool);
	if (!text) return isActive ? "" : "(no output)";
	if (expanded) return text;
	return previewToolText(toolName, text);
}

function extractToolText(tool) {
	const toolName = String(tool?.toolName || "tool").toLowerCase();
	const details = tool?.details || {};
	const fallbackErrorText = [details?.errorMessage, details?.error, details?.message]
		.find((value) => typeof value === "string" && value.trim()) || "";
	if (toolName === "edit") {
		if (typeof details?.diff === "string" && details.diff) {
			return details.diff;
		}
		return String(tool?.text || fallbackErrorText || "");
	}
	return String(tool?.text || fallbackErrorText || "");
}

function formatWriteToolBody(tool, isActive = false, expanded = false) {
	const content = typeof tool?.args?.content === "string" ? tool.args.content : "";
	const rawText = String(tool?.text || "");
	const errorText = tool?.isError ? rawText : "";
	if (!content) {
		if (isWriteSuccessMessage(rawText)) return "";
		return errorText || (isActive ? "" : "(no output)");
	}
	const preview = expanded ? content : previewToolText("write", content);
	if (!errorText || isWriteSuccessMessage(errorText)) return preview;
	return `${preview}\n\n${errorText}`;
}

function isWriteSuccessMessage(text) {
	return /^Successfully wrote \d+ bytes to /i.test(String(text || ""));
}

function previewToolText(toolName, text) {
	const lines = text.split("\n");
	const maxLines = getToolPreviewLines(toolName);
	if (lines.length <= maxLines) return text;

	if (toolName === "bash") {
		const visibleLines = lines.slice(-maxLines);
		const earlierLines = Math.max(0, lines.length - visibleLines.length);
		return `... (${earlierLines} earlier lines)\n${visibleLines.join("\n")}`;
	}

	const visibleLines = lines.slice(0, maxLines);
	const remaining = lines.length - visibleLines.length;
	if (toolName === "write") {
		return `${visibleLines.join("\n")}\n... (${remaining} more lines, ${lines.length} total)`;
	}
	return `${visibleLines.join("\n")}\n... (${remaining} more lines)`;
}

function createToolBodyElement(tool, isActive = false, expanded = false) {
	const toolName = String(tool?.toolName || "tool").toLowerCase();
	const body = document.createElement("div");
	body.className = `tool-body${toolName === "edit" ? " diff" : ""}`;

	if (toolName === "edit") {
		const diff = String(tool?.details?.diff || "");
		if (diff) {
			renderDiffBody(body, diff);
			return body;
		}
		const text = String(tool?.text || "");
		if (!text) {
			body.textContent = isActive ? "" : "(no output)";
			return body.textContent ? body : null;
		}
		body.textContent = expanded ? text : previewToolText(toolName, text);
		return body;
	}

	const text = formatToolBody(tool, isActive, expanded);
	if (!text) return null;
	body.textContent = text;
	return body;
}

function renderDiffBody(bodyEl, diffText) {
	for (const line of String(diffText || "").split("\n")) {
		const lineEl = document.createElement("div");
		lineEl.className = `tool-diff-line ${getDiffLineClass(line)}`;
		lineEl.textContent = line;
		bodyEl.appendChild(lineEl);
	}
}

function getDiffLineClass(line) {
	if (/^\+/.test(line)) return "added";
	if (/^-/.test(line)) return "removed";
	return "context";
}

function formatToolFooter(tool, isActive = false) {
	const parts = [];
	if (!isActive) {
		const durationMs = Number(tool?.durationMs || 0);
		if (durationMs) parts.push(`Took ${(durationMs / 1000).toFixed(1)}s`);
	}
	const truncation = getToolTruncation(tool);
	if (truncation?.truncated) {
		if (Number.isFinite(truncation.outputLines) && Number.isFinite(truncation.totalLines)) {
			parts.push(`Showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
		} else {
			parts.push("Truncated");
		}
	}
	const fullOutputPath = getToolFullOutputPath(tool);
	if (fullOutputPath) parts.push(`Full output: ${fullOutputPath}`);
	return parts.join(" • ");
}

function createToolFooterElement(tool, options = {}, toolKey = "", expanded = false) {
	const footerText = formatToolFooter(tool, options.isActive);
	const canToggle = canToggleToolBody(tool, options.isActive);
	if (!footerText && !canToggle) return null;

	const footerEl = document.createElement("div");
	footerEl.className = "tool-footer";

	if (footerText) {
		const metaEl = document.createElement("span");
		metaEl.className = "tool-footer-meta";
		metaEl.textContent = footerText;
		footerEl.appendChild(metaEl);
	}

	if (canToggle && toolKey) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "tool-toggle subtle";
		btn.textContent = expanded ? "collapse" : "expand";
		btn.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleToolExpanded(toolKey);
		};
		footerEl.appendChild(btn);
	}

	return footerEl;
}

function canToggleToolBody(tool, isActive = false) {
	if (isActive) return false;
	const toolName = String(tool?.toolName || "tool").toLowerCase();
	if (toolName === "edit") return false;
	const fullText = formatToolBody(tool, isActive, true);
	const collapsedText = formatToolBody(tool, isActive, false);
	return !!fullText && fullText !== collapsedText;
}

function getToolUiKey(tool, options = {}) {
	if (tool?.toolCallId) return `tool:${tool.toolCallId}`;
	return [
		options.timestamp || tool?.timestamp || "",
		tool?.toolName || "tool",
		formatToolHeader(tool),
	].join("|");
}

function isToolExpanded(tool, options = {}, toolKey = "") {
	const toolName = String(tool?.toolName || "tool").toLowerCase();
	if (toolName === "edit") return true;
	return !!(toolKey && expandedToolKeys.has(toolKey));
}

function toggleToolExpanded(toolKey) {
	if (!toolKey) return;
	if (expandedToolKeys.has(toolKey)) expandedToolKeys.delete(toolKey);
	else expandedToolKeys.add(toolKey);
	renderSession();
}

function getToolTruncation(tool) {
	const details = tool?.details || {};
	if (details?.truncation && typeof details.truncation === "object") return details.truncation;
	return null;
}

function getToolFullOutputPath(tool) {
	const details = tool?.details || {};
	if (typeof details?.fullOutputPath === "string" && details.fullOutputPath) return details.fullOutputPath;
	if (typeof tool?.fullOutputPath === "string" && tool.fullOutputPath) return tool.fullOutputPath;
	return "";
}

function isToolExcludedFromContext(tool) {
	const details = tool?.details || {};
	const args = tool?.args || {};
	return !!(details?.excludeFromContext || args?.excludeFromContext);
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

function renderAssistantStream(text, thinkingText = "") {
	return buildMessageElement(
		"assistant streaming",
		text || "",
		null,
		"",
		thinkingText || "",
		`stream:${currentSessionGuid || "none"}`,
		getThinkingScope(),
	);
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

function getAssistantMessageText(message) {
	const text = String(message?.text || "");
	if (text && text !== "[aborted]") return text;
	if (message?.stopReason === "aborted") return "Operation aborted";
	return text;
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

function buildMessageElement(className, text, timestamp, status = "", thinkingText = "", thinkingKey = "", thinkingScope = "") {
	const row = document.createElement("div");
	row.className = `message-row ${className}`;
	const el = document.createElement("div");
	el.className = `message ${className}`;
	const compactLiveThinking = collapseLiveTurnDetails && String(className || "").includes("assistant");
	const displayText = text || (compactLiveThinking && thinkingText ? "Thinking…" : "");
	if (timestamp || status) {
		const ts = document.createElement("div");
		ts.className = "timestamp";
		const parts = [];
		if (timestamp) parts.push(new Date(timestamp).toLocaleTimeString());
		if (status) parts.push(status);
		ts.textContent = parts.join(" • ");
		el.appendChild(ts);
	}
	if (thinkingText && !compactLiveThinking) {
		const thinkingEl = document.createElement("details");
		thinkingEl.className = "thinking-block";
		const sessionCollapsed = !!(thinkingScope && collapsedThinkingSessions.has(thinkingScope));
		const defaultOpen = thinkingKey && thinkingOpenStateByKey.has(thinkingKey)
			? !!thinkingOpenStateByKey.get(thinkingKey)
			: sessionCollapsed
				? false
				: false;
		thinkingEl.open = defaultOpen;
		if (thinkingKey) {
			thinkingEl.addEventListener("toggle", () => {
				thinkingOpenStateByKey.set(thinkingKey, thinkingEl.open);
				if (thinkingScope) {
					if (thinkingEl.open) collapsedThinkingSessions.delete(thinkingScope);
					else collapsedThinkingSessions.add(thinkingScope);
				}
			});
		}
		const summaryEl = document.createElement("summary");
		summaryEl.className = "thinking-label";
		const labelTextEl = document.createElement("span");
		labelTextEl.className = "thinking-label-text";
		labelTextEl.textContent = "Thinking";
		summaryEl.appendChild(labelTextEl);
		const previewEl = document.createElement("span");
		previewEl.className = "thinking-inline-preview";
		previewEl.textContent = collapseThinkingPreview(thinkingText);
		summaryEl.appendChild(previewEl);
		const textEl = document.createElement("div");
		textEl.className = "thinking-text";
		textEl.textContent = thinkingText;
		thinkingEl.appendChild(summaryEl);
		thinkingEl.appendChild(textEl);
		el.appendChild(thinkingEl);
	}
	if (displayText) {
		const textEl = document.createElement("div");
		textEl.className = "message-text";
		textEl.textContent = displayText;
		el.appendChild(textEl);
	}
	row.appendChild(el);
	return row;
}

function collapseThinkingPreview(text) {
	const collapsed = String(text || "")
		.replace(/\s+/g, " ")
		.trim();
	const maxChars = 220;
	if (collapsed.length <= maxChars) return collapsed;
	return `…${collapsed.slice(-maxChars)}`;
}

function getThinkingScope() {
	return currentSessionGuid ? `session:${currentSessionGuid}` : "";
}

function getThinkingKey(message) {
	if (!message || typeof message !== "object") return "";
	return [
		message.role || "assistant",
		message.timestamp || "",
		message.text || "",
		message.thinkingText || "",
	].join("|");
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
		if (selectedProjectContext?.cwd) {
			sessionTitleEl.textContent = basenamePath(selectedProjectContext.cwd);
			sessionSubtitleEl.textContent = `${selectedProjectContext.hostConnected ? "ready" : "offline"} • ${selectedProjectContext.hostname || "unknown computer"} • ${selectedProjectContext.cwd}`;
			sessionPathEl.textContent = selectedProjectContext.cwd || "";
		} else {
			sessionTitleEl.textContent = "No session selected";
			sessionSubtitleEl.textContent = currentView === "projects"
				? "Pick a project, then use + to start a new session."
				: "Select a session from the sidebar to watch it live.";
			sessionPathEl.textContent = "";
		}
		sessionWorkingIndicatorEl?.classList.remove("visible");
		return;
	}

	const summary = findSessionSummary(currentSessionGuid);
	const hostLabel = summary?.hostname || currentSession.hostname || selectedProjectContext?.hostname || "unknown computer";
	const owner = currentSession.owner || summary?.owner || "inactive";
	const queuedCount = currentSession.queuedInputs.length || summary?.queuedInputCount || 0;
	const queued = queuedCount ? ` • ${queuedCount} queued` : "";
	const model = currentSession.model || summary?.model || "no model";
	const hostname = hostLabel;
	const cwd = currentSession.cwd || summary?.cwd || currentSessionGuid;
	const sessionLabel = currentSession.sessionName || summary?.sessionName || summary?.preview || shortId(currentSessionGuid);
	const projectLabel = getProjectLabel(cwd);
	const title = projectLabel
		? clampText(sessionLabel && sessionLabel !== projectLabel ? `${projectLabel} — ${sessionLabel}` : projectLabel, 120)
		: clampText(sessionLabel, 120);
	const working = isSessionWorking(summary);

	sessionTitleEl.textContent = title;
	sessionSubtitleEl.textContent = `${owner}${working ? " • working" : ""}${queued} • ${model} • ${hostname} • ${cwd}`;
	sessionPathEl.textContent = cwd;
	sessionWorkingIndicatorEl?.classList.remove("visible");
}

function updateControls() {
	const connected = ws?.readyState === WebSocket.OPEN;
	const summary = currentSessionGuid ? findSessionSummary(currentSessionGuid) : null;
	const hasOwner = !!(currentSession.owner || summary?.owner);
	const canAutoStart = !!(summary && summary.hostConnected && (summary.sessionFile || summary.sessionGuid));
	const launchContext = getCurrentLaunchContext();
	const canCreateNewSession = !!(connected && launchContext && launchContext.hostConnected && launchContext.cwd && launchContext.cwd !== "(unknown project)");
	const canKillSession = !!(connected && currentSessionGuid && hasOwner);
	const showAbort = !!(connected && currentSessionGuid && hasOwner && isSessionWorking(summary));
	const showFab = MOBILE_MEDIA.matches && bodyEl.classList.contains("sidebar-open") && canCreateNewSession;

	sendBtnEl.disabled = !(connected && currentSessionGuid && (hasOwner || canAutoStart));
	abortBtnEl.disabled = !showAbort;
	abortBtnEl.hidden = !showAbort;
	newSessionBtnEl.disabled = !canCreateNewSession;
	if (newSessionFabEl) newSessionFabEl.disabled = !canCreateNewSession;
	if (killSessionBtnEl) killSessionBtnEl.disabled = !canKillSession;
	bodyEl.classList.toggle("show-fab", showFab);

	messageInputEl.placeholder = hasOwner
		? (MOBILE_MEDIA.matches ? "Send message…" : "Send a live message to the active session…")
		: currentSessionGuid && canAutoStart
			? (MOBILE_MEDIA.matches ? "Resume session…" : "Send a message — toilet-pi will auto-start this session in background…")
			: (MOBILE_MEDIA.matches ? "Select session…" : "Select a session to send a message…");
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

function isSessionWorking(summary = null) {
	return !!(
		currentSession.busy
		|| currentSession.streamingText
		|| currentSession.streamingThinkingText
		|| currentSession.activeTools.length
		|| summary?.runnerStatus === "starting"
	);
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
			if (event.message?.role === "assistant") {
				session.streamingText = null;
				session.streamingThinkingText = null;
				session.abortRequested = false;
				if (event.message?.stopReason !== "toolUse") {
					session.liveTurnToolCount = 0;
					session.liveTurnSeenToolIds = [];
					session.liveTurnStartHistoryIndex = null;
					session.liveTurnLastActivity = null;
				}
			}
			break;

		case "assistant_stream_start":
			session.streamingText = "";
			session.streamingThinkingText = "";
			if (!Number.isInteger(session.liveTurnStartHistoryIndex) || session.liveTurnStartHistoryIndex < 0) {
				session.liveTurnToolCount = 0;
				session.liveTurnSeenToolIds = [];
				session.liveTurnStartHistoryIndex = session.history.length;
			}
			session.liveTurnLastActivity = { text: "Thinking…", isError: false };
			break;

		case "assistant_stream_update":
			session.streamingText = event.text || "";
			session.streamingThinkingText = event.thinkingText || "";
			session.liveTurnLastActivity = {
				text: event.thinkingText
					? `Thinking: ${collapseThinkingPreview(event.thinkingText)}`
					: (event.text ? clampText(event.text, 160) : "Thinking…"),
				isError: false,
			};
			break;

		case "assistant_stream_end":
			break;

		case "tool_start":
			if (event.toolCallId) {
				const liveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName || "tool",
					args: event.args,
				};
				upsertTool(session, liveTool);
				if (!session.liveTurnSeenToolIds.includes(event.toolCallId)) {
					session.liveTurnSeenToolIds.push(event.toolCallId);
					session.liveTurnToolCount = (session.liveTurnToolCount || 0) + 1;
				}
				session.liveTurnLastActivity = {
					text: formatToolHeader(liveTool),
					isError: false,
				};
			}
			break;

		case "tool_update":
			if (event.toolCallId) {
				const liveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName || "tool",
					args: event.args,
					text: event.text,
					details: event.details,
				};
				upsertTool(session, liveTool);
				session.liveTurnLastActivity = {
					text: formatToolHeader(liveTool),
					isError: false,
				};
			}
			break;

		case "tool_end":
			if (event.toolCallId) {
				const finishedTool = session.activeTools.find((tool) => tool.toolCallId === event.toolCallId) || null;
				session.activeTools = session.activeTools.filter((tool) => tool.toolCallId !== event.toolCallId);
				session.liveTurnLastActivity = {
					text: finishedTool
						? `${formatToolHeader(finishedTool)}${event.isError ? " • error" : " • done"}`
						: `${event.toolName || "tool"}${event.isError ? " error" : " done"}`,
					isError: !!event.isError,
				};
			}
			break;

		case "busy": {
			const hadLiveContent = !!(
				session.streamingText
				|| session.streamingThinkingText
				|| session.activeTools.length
			);
			session.busy = !!event.busy;
			if (!session.busy) {
				if (session.abortRequested && hadLiveContent) {
					session.history.push({
						role: "system",
						text: "Operation aborted",
						timestamp: Date.now(),
					});
				}
				session.abortRequested = false;
				session.streamingText = null;
				session.streamingThinkingText = null;
				session.activeTools = [];
				session.liveTurnToolCount = 0;
				session.liveTurnSeenToolIds = [];
				session.liveTurnStartHistoryIndex = null;
				session.liveTurnLastActivity = null;
			}
			break;
		}

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
			if (Number.isFinite(event.contextWindowTokens)) {
				session.contextWindowTokens = event.contextWindowTokens;
			}
			break;

		case "usage":
			if (Number.isFinite(event.contextTokens)) session.contextTokens = event.contextTokens;
			if (Number.isFinite(event.costUsd)) session.costUsd = event.costUsd;
			break;

		case "session_name":
			session.sessionName = event.sessionName || null;
			break;
	}
}

function upsertTool(session, tool) {
	const existingIndex = session.activeTools.findIndex((entry) => entry.toolCallId === tool.toolCallId);
	if (existingIndex >= 0) {
		session.activeTools[existingIndex] = {
			...session.activeTools[existingIndex],
			...tool,
		};
	} else session.activeTools.push(tool);
}

function createEmptySession(sessionGuid) {
	return {
		sessionGuid,
		owner: null,
		hostId: null,
		hostname: null,
		sessionFile: null,
		sessionName: null,
		cwd: null,
		model: null,
		contextWindowTokens: null,
		contextTokens: null,
		costUsd: null,
		liveTurnToolCount: 0,
		liveTurnSeenToolIds: [],
		liveTurnStartHistoryIndex: null,
		liveTurnLastActivity: null,
		busy: false,
		history: [],
		streamingText: null,
		streamingThinkingText: null,
		activeTools: [],
		queuedInputs: [],
		abortRequested: false,
	};
}

function normalizeSession(session) {
	return {
		sessionGuid: session?.sessionGuid || null,
		owner: session?.owner || null,
		hostId: session?.hostId || null,
		hostname: session?.hostname || null,
		sessionFile: session?.sessionFile || null,
		sessionName: session?.sessionName || null,
		cwd: session?.cwd || null,
		model: session?.model || null,
		contextWindowTokens: Number.isFinite(session?.contextWindowTokens) ? session.contextWindowTokens : null,
		contextTokens: Number.isFinite(session?.contextTokens) ? session.contextTokens : null,
		costUsd: Number.isFinite(session?.costUsd) ? session.costUsd : null,
		liveTurnToolCount: Number.isFinite(session?.liveTurnToolCount) ? session.liveTurnToolCount : 0,
		liveTurnSeenToolIds: Array.isArray(session?.liveTurnSeenToolIds) ? session.liveTurnSeenToolIds : [],
		liveTurnStartHistoryIndex: Number.isInteger(session?.liveTurnStartHistoryIndex) ? session.liveTurnStartHistoryIndex : null,
		liveTurnLastActivity: session?.liveTurnLastActivity && typeof session.liveTurnLastActivity === "object"
			? {
				text: String(session.liveTurnLastActivity.text || ""),
				isError: !!session.liveTurnLastActivity.isError,
			}
			: null,
		busy: !!session?.busy,
		history: Array.isArray(session?.history) ? session.history : [],
		streamingText: typeof session?.streamingText === "string" ? session.streamingText : null,
		streamingThinkingText: typeof session?.streamingThinkingText === "string" ? session.streamingThinkingText : null,
		activeTools: Array.isArray(session?.activeTools) ? session.activeTools : [],
		queuedInputs: Array.isArray(session?.queuedInputs) ? session.queuedInputs : [],
		abortRequested: false,
	};
}

function findSessionSummary(sessionGuid) {
	return flattenSessions().find((session) => session.sessionGuid === sessionGuid) || null;
}

function getSessionTitle(session) {
	const projectLabel = getProjectLabel(session.cwd);
	const label = session.sessionName || session.preview || shortId(session.sessionGuid);
	if (!projectLabel) return clampText(label, 120);
	if (!label || label === projectLabel) return clampText(projectLabel, 120);
	return clampText(`${projectLabel} — ${label}`, 120);
}

function getSessionDetailLabel(session) {
	const detail = session.sessionName || session.preview || "";
	const projectLabel = getProjectLabel(session.cwd);
	if (!detail || detail === projectLabel) return "";
	return clampText(detail, 140);
}

function isSelectedProject(project) {
	return !!(
		!currentSessionGuid
		&& selectedProjectContext?.hostId === project.hostId
		&& selectedProjectContext?.cwd === project.cwd
	);
}

function clampText(value, max = 120) {
	const text = String(value || "").trim();
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function clearNotice() {
	if (noticeTimer) {
		clearTimeout(noticeTimer);
		noticeTimer = null;
	}
	noticeBarEl.textContent = "";
	noticeBarEl.className = "notice-bar";
}

function showNotice(message, level = "info", autoHide = true) {
	if (noticeTimer) clearTimeout(noticeTimer);
	noticeTimer = null;
	noticeBarEl.textContent = message;
	noticeBarEl.className = `notice-bar ${level}`;
	if (autoHide) {
		noticeTimer = setTimeout(() => {
			clearNotice();
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

function getProjectLabel(cwd) {
	if (!cwd || cwd === "(unknown project)") return "";
	return basenamePath(cwd);
}

function shortId(value) {
	return value ? value.slice(0, 8) : "unknown";
}

function openSidebar() {
	if (!MOBILE_MEDIA.matches) return;
	bodyEl.classList.add("sidebar-open");
	updateControls();
}

function closeSidebar() {
	bodyEl.classList.remove("sidebar-open");
	updateControls();
}

function updateViewButtons() {
	viewSessionsBtnEl.classList.toggle("active", currentView === "sessions");
	viewProjectsBtnEl.classList.toggle("active", currentView === "projects");
}

viewSessionsBtnEl.onclick = () => {
	currentView = "sessions";
	updateViewButtons();
	renderBrowserList();
	updateControls();
};

viewProjectsBtnEl.onclick = () => {
	currentView = "projects";
	updateViewButtons();
	renderBrowserList();
	updateControls();
};

menuBtnEl.onclick = () => {
	openSidebar();
	updateControls();
};
sidebarCloseBtnEl.onclick = () => {
	closeSidebar();
	updateControls();
};
sidebarScrimEl.onclick = () => {
	closeSidebar();
	updateControls();
};
connectionStatusEl.onclick = () => openAuthModal();
connectionStatusEl.onkeydown = (event) => {
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		openAuthModal();
	}
};
authCloseBtnEl.onclick = () => closeAuthModal();
authCancelBtnEl.onclick = () => closeAuthModal();
authForgetBtnEl.onclick = async () => {
	await forgetAuthToken();
	closeAuthModal();
	showNotice("Logged out", "info");
};
authModalScrimEl.onclick = (event) => {
	if (event.target === authModalScrimEl) closeAuthModal();
};
authFormEl.onsubmit = async (event) => {
	event.preventDefault();
	const token = authTokenInputEl.value.trim();
	if (!token) {
		showNotice("Enter your admin token", "error");
		authTokenInputEl.focus();
		return;
	}
	const success = await applyAuthToken(token);
	if (success) closeAuthModal();
};
installationBtnEl.onclick = () => openInstallationModal();
installationCloseBtnEl.onclick = () => closeInstallationModal();
installationModalScrimEl.onclick = (event) => {
	if (event.target === installationModalScrimEl) closeInstallationModal();
};
confirmCloseBtnEl.onclick = () => closeConfirmModal();
confirmCancelBtnEl.onclick = () => closeConfirmModal();
confirmModalScrimEl.onclick = (event) => {
	if (event.target === confirmModalScrimEl) closeConfirmModal();
};
confirmSubmitBtnEl.onclick = () => {
	closeConfirmModal();
	if (!currentSessionGuid) return;
	send({ type: "terminate_session", sessionGuid: currentSessionGuid });
};
if (toggleLiveTurnDetailsBtnEl) {
	toggleLiveTurnDetailsBtnEl.onclick = () => {
		setCollapseLiveTurnDetails(!collapseLiveTurnDetails);
		closeHeaderMenu();
	};
}
function triggerNewSession() {
	const context = getCurrentLaunchContext();
	if (!context) {
		showNotice("Select a project first", "error");
		return;
	}
	closeHeaderMenu();
	createNewBackgroundSession(context);
}

newSessionBtnEl.onclick = () => triggerNewSession();
if (newSessionFabEl) newSessionFabEl.onclick = () => triggerNewSession();
if (killSessionBtnEl) {
	killSessionBtnEl.onclick = () => {
		if (!currentSessionGuid) return;
		openConfirmModal(`This will close ${sessionTitleEl.textContent || "the selected session"}. Continue?`);
	};
}

sendBtnEl.onclick = () => {
	const text = messageInputEl.value.trim();
	if (!text || !currentSessionGuid) return;
	closeHeaderMenu();
	const sent = send({ type: "input", sessionGuid: currentSessionGuid, text });
	if (!sent) return;
	stickToBottom = true;
	requestAnimationFrame(() => scrollMessagesToBottom());
	if (!(currentSession.owner || findSessionSummary(currentSessionGuid)?.owner)) {
		showNotice("Starting background runner and delivering your message…", "info");
	}
	messageInputEl.value = "";
	resizeMessageInput();
};

abortBtnEl.onclick = () => {
	if (!currentSessionGuid) return;
	closeHeaderMenu();
	currentSession.abortRequested = true;
	send({ type: "abort", sessionGuid: currentSessionGuid });
};

messageInputEl.oninput = () => {
	resizeMessageInput();
};

messageInputEl.onkeydown = (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendBtnEl.onclick();
	}
};

resizeMessageInput();

messagesEl.addEventListener("scroll", () => {
	stickToBottom = isNearBottom();
});

document.addEventListener("click", (event) => {
	if (headerMenuEl?.open && !headerMenuEl.contains(event.target)) {
		closeHeaderMenu();
	}
});

window.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && bodyEl.classList.contains("auth-open")) {
		closeAuthModal();
		return;
	}
	if (event.key === "Escape" && bodyEl.classList.contains("installation-open")) {
		closeInstallationModal();
		return;
	}
	if (event.key === "Escape" && bodyEl.classList.contains("confirm-open")) {
		closeConfirmModal();
		return;
	}
	if (event.key === "Escape" && headerMenuEl?.open) {
		closeHeaderMenu();
		return;
	}
});

window.addEventListener("resize", () => {
	if (!MOBILE_MEDIA.matches) closeSidebar();
	updateControls();
	if (stickToBottom) {
		requestAnimationFrame(() => scrollMessagesToBottom());
	}
});

MOBILE_MEDIA.addEventListener?.("change", () => {
	if (!MOBILE_MEDIA.matches) closeSidebar();
	updateControls();
});
