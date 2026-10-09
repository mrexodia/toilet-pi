/**
 * The memory's durable state, as pi-durable documents of the chat's conversation.
 *
 * - `ChatDoc`: one document: the message count, the index pointer, the two views, the ready queues, the running
 *   compactions, the sizes of the nodes the views may merge, and the frozen view of the current turn.
 * - `MessageDoc`: one small document per message, keyed by its id: where its text lives.
 * - `NodeDoc`: one document per built tree node, keyed "l/i". Built once, never changed.
 *
 * Every change to them happens in a commit together with the entries or tasks it belongs to.
 */

import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { Part, ViewState } from "./tree.ts";

export type Kind = "user" | "optchat" | "tool" | "echo" | "work" | "note";

export type ModelChoice = { provider: string; modelId: string; thinkingLevel?: string };

export type Usage = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

/** The view a turn was given: frozen for the run, so every request of the run shares one cached prefix. */
export type TurnState = {
	/** The id of the run's first message: the view covers the messages before it. */
	first: number;
	parts: Part[];
	/** The start of the run's first message, to tell a stale turn from the current one. */
	head: string;
	/** Per-turn state shown after the view: the date and the working directory. */
	state: string;
};

export type ChatState = {
	/** Messages indexed so far: ids 0 to count-1. */
	count: number;
	/** The newest transcript entry indexed; 0 before any. */
	indexed: number;
	view: ViewState;
	seen: ViewState;
	/** Sizes of built nodes the views may need: their parts, those parts' ancestors, and nodes just built. */
	sizes: Record<string, number>;
	/** Per level, the sorted ids of nodes ready to build. */
	ready: number[][];
	/** Nodes being built, "l/i" to the task building them. */
	busy: Record<string, number>;
	turn?: TurnState;
	usage: Usage;
	/** The compactions' model; the turns' model when absent. */
	compactor?: ModelChoice;
};

export function initialChat(): ChatState {
	return {
		count: 0,
		indexed: 0,
		view: { parts: [], batch: false },
		seen: { parts: [], batch: false },
		sizes: {},
		ready: [[]],
		busy: {},
		usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};
}

export const ChatDoc = defineDoc<ChatState>({
	kind: "optchat.chat",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: initialChat,
});

/** Where message i's text lives: block `block` of entry `entry`, page `page` of it. */
export type MessageState = {
	entry: number;
	block: number;
	page: number;
	kind: Kind;
	/** Bytes of "kind: text". */
	size: number;
	/** Unix milliseconds. */
	date: number;
	/** The next message continues this text. */
	more: boolean;
};

export const MessageDoc = defineDocFamily<MessageState, MessageState>({
	kind: "optchat.message",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({ ...seed }),
});

export type NodeState = { text: string; size: number };

export const NodeDoc = defineDocFamily<NodeState, NodeState>({
	kind: "optchat.node",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({ ...seed }),
});

/** A memory imported from before the chat: a passive entry the model never sees whole, only through the tree. */
export type NoteData = { text: string; date: number };
