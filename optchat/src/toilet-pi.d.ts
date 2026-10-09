// The plain JavaScript modules of toilet-pi that the agent reuses.

declare module "*/toilet-pi-config.js" {
	export function readToiletPiConfig(agentDir?: string): Promise<{ serverUrl: string; token: string } | null>;
	export function parseToiletPiInput(input: string): { serverUrl: string; token: string };
	export function buildConnectUrl(config: { serverUrl: string; token: string }): string;
	export function redactUrlTokens(value: string): string;
	export function getAgentDir(): string;
	export function writeToiletPiConfig(config: { serverUrl: string; token: string }, agentDir?: string): Promise<{ serverUrl: string; token: string }>;
	export function toBrowserBaseUrl(serverUrl: string): string;
}

declare module "*/history-page.js" {
	export function buildHistoryPage(
		entries: unknown[],
		options?: { source?: string; complete?: boolean; leafId?: string | null; since?: string; last?: number },
	): {
		source: string;
		sanitized: true;
		complete: boolean;
		truncated: boolean;
		leafId: string | null;
		nextCursor: string | null;
		hasMore: boolean;
		messages: Record<string, unknown>[];
	};
}

declare module "*/model-control.js" {
	export function createModelController(deps: {
		pi: unknown;
		getContext: () => unknown;
		loadThinkingLevels: () => Promise<unknown>;
		hasPendingInput?: () => boolean;
	}): {
		run(request: Record<string, unknown>): Promise<Record<string, unknown>>;
		configuration(): { provider: string | null; modelId: string | null; thinkingLevel: string | null };
		isConfiguring(): boolean;
	};
}

declare module "*/cli/client.js" {
	export function authenticateAdmin(options: { serverUrl: string; token: string; timeoutMs?: number }): Promise<{ serverUrl: string; cookie: string; expiresAt?: number }>;
	export class ToiletPiClient {
		constructor(options: {
			serverUrl: string;
			token?: string;
			orchestratorToken?: string;
			sessionCookie?: string;
			timeoutMs?: number;
		});
		overview: { hosts: HubHost[]; capabilities?: string[] } | null;
		connect(): Promise<this>;
		request(sessionGuid: string, operation: string, selection?: Record<string, unknown>): Promise<Record<string, unknown>>;
		control(operation: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
		waitInput(sessionGuid: string, inputId: string): Promise<HubInput>;
		snapshot(sessionGuid: string): Promise<Record<string, unknown>>;
		close(): void;
	}
	export type HubInput = { inputId: string; sessionGuid: string; state: string; updatedAt: number };
	export type HubSession = {
		sessionGuid: string;
		sessionName: string | null;
		cwd: string | null;
		busy: boolean;
		owner: string | null;
		runnerStatus: string | null;
		model: string | null;
		queuedInputCount: number;
		updatedAt: number;
	};
	export type HubHost = { hostId: string; hostname: string; connected: boolean; sessions: HubSession[] };
}

declare module "*/cli/auth.js" {
	export function createAuthStore(file?: string): {
		path: string;
		read(): Promise<{ serverUrl: string; cookie: string; expiresAt?: number } | null>;
		write(value: { serverUrl: string; cookie: string; expiresAt?: number }): Promise<void>;
	};
	export function promptLogin(label: string, options?: { secret?: boolean }): Promise<string>;
	export function resolveCredentials(
		input: { serverUrl?: string; token?: string; orchestratorToken?: string },
		store: ReturnType<typeof createAuthStore>,
	): Promise<{ serverUrl: string; token?: string; orchestratorToken?: string; sessionCookie?: string }>;
}
