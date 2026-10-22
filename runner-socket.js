import { lookup as systemLookup } from "node:dns";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";

const CONNECT_TIMEOUT_MS = 15_000;
const PEER_MAX_AGE_MS = 5 * 60_000;

/** @typedef {{ hostname: string, address: string, family: number, verifiedAt: number }} Peer */

/**
 * One factory per runner (extension or optchat). No resources are opened until it is called.
 * Keep normal DNS/TLS behavior, with a bounded fallback to a recently live peer.
 * @param {{ log: (text: string) => void, lookup?: import('node:net').LookupFunction,
 *   now?: () => number, connectTimeoutMs?: number }} options Dependency overrides support offline tests.
 * @returns {(url: string) => WebSocket}
 */
export function createRunnerSocketFactory(options) {
	const resolve = options.lookup ?? systemLookup;
	const now = options.now ?? (() => performance.now());
	/** @type {Peer | undefined} */
	let lastPeer;

	/** @type {import('node:net').LookupFunction} */
	const lookup = (hostname, lookupOptions, callback) => {
		resolve(hostname, lookupOptions, (error, address, family) => {
			if (!error) {
				callback(null, address, family);
				return;
			}
			const peer = lastPeer;
			const requestedFamily = lookupOptions.family === "IPv4" ? 4 : lookupOptions.family === "IPv6" ? 6 : lookupOptions.family;
			// Never mask NXDOMAIN, borrow another host's address, or retain an offline peer indefinitely.
			if (error.code === "ENOTFOUND" && peer?.hostname === hostname) lastPeer = undefined;
			if (error.code !== "EAI_AGAIN" || !peer || peer.hostname !== hostname ||
				now() - peer.verifiedAt >= PEER_MAX_AGE_MS ||
				(requestedFamily && requestedFamily !== peer.family)) {
				callback(error, address, family);
				return;
			}
			options.log(`temporary DNS failure for ${hostname}; trying recently connected address (last live ${Math.round((now() - peer.verifiedAt) / 1000)}s ago)`);
			if (lookupOptions.all) callback(null, [{ address: peer.address, family: peer.family }]);
			else callback(null, peer.address, peer.family);
		});
	};

	return (url) => {
		const hostname = new URL(url).hostname;
		// Only replace DNS lookup: the URL hostname, Host header, SNI and certificate verification stay intact.
		const ws = new WebSocket(url, { lookup });
		/** @type {Peer | undefined} */
		let peer;
		ws.once("upgrade", (response) => {
			const socket = response.socket;
			if (socket.remoteAddress && socket.remoteFamily) {
				peer = { hostname, address: socket.remoteAddress, family: socket.remoteFamily === "IPv6" ? 6 : 4, verifiedAt: now() };
			}
		});
		const rememberLivePeer = () => {
			if (peer) lastPeer = { ...peer, verifiedAt: now() };
		};
		// A healthy long-lived connection keeps the fallback useful even hours after its original DNS lookup.
		ws.once("open", rememberLivePeer);
		ws.on("pong", rememberLivePeer);

		// An absolute deadline also covers stuck DNS/TCP/TLS, not just inactivity after TCP connects.
		const timeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
		const deadline = setTimeout(() => {
			if (ws.readyState !== WebSocket.CONNECTING) return;
			options.log(`connection attempt timed out after ${timeoutMs}ms; reconnecting`);
			ws.terminate();
		}, timeoutMs);
		ws.once("open", () => clearTimeout(deadline));
		ws.once("close", () => clearTimeout(deadline));
		return ws;
	};
}
