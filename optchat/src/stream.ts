/**
 * The in-flight assistant message, rebuilt from durable's message changes. Durable sends the first partial, and any
 * block it cannot express as an append, as a whole message or block; the rest as deltas. Tracking the blocks keeps
 * the streamed text exact, and `apply()` returns what was newly added, for printing.
 */

import type { MessageChange } from "@earendil-works/pi-durable";

type Block = { kind: "text" | "thinking" | "other"; text: string };

export class StreamedMessage {
	#blocks = new Map<number, Block>();
	#shownText = "";
	#shownThinking = "";

	reset(): void {
		this.#blocks.clear();
		this.#shownText = "";
		this.#shownThinking = "";
	}

	get text(): string {
		return this.#join("text");
	}

	get thinking(): string {
		return this.#join("thinking");
	}

	#join(kind: "text" | "thinking"): string {
		return [...this.#blocks.entries()]
			.sort(([a], [b]) => a - b)
			.flatMap(([, block]) => (block.kind === kind ? [block.text] : []))
			.join(kind === "thinking" ? "\n\n" : "");
	}

	#set(index: number, block: { type: string; text?: string; thinking?: string }): void {
		const kind = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : "other";
		this.#blocks.set(index, { kind, text: kind === "text" ? (block.text ?? "") : kind === "thinking" ? (block.thinking ?? "") : "" });
	}

	/** Apply one batch of changes; returns the text and thinking added since the last call, when they only grew. */
	apply(changes: readonly MessageChange[]): { text: string; thinking: string } {
		for (const change of changes) {
			switch (change.type) {
				case "message":
					this.#blocks.clear();
					change.message.content.forEach((block, index) => this.#set(index, block));
					break;
				case "text_start":
				case "thinking_start":
				case "toolcall_start":
				case "block":
					this.#set(change.contentIndex, change.block);
					break;
				case "text_delta":
				case "thinking_delta": {
					const block = this.#blocks.get(change.contentIndex);
					if (block === undefined) this.#blocks.set(change.contentIndex, { kind: change.type === "text_delta" ? "text" : "thinking", text: change.delta });
					else block.text += change.delta;
					break;
				}
				default:
					break;
			}
		}
		const text = this.text;
		const thinking = this.thinking;
		const added = {
			text: text.startsWith(this.#shownText) ? text.slice(this.#shownText.length) : text,
			thinking: thinking.startsWith(this.#shownThinking) ? thinking.slice(this.#shownThinking.length) : thinking,
		};
		this.#shownText = text;
		this.#shownThinking = thinking;
		return added;
	}
}
