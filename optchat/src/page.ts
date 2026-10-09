/** A static HTML page of the whole memory: the view, every level of the tree, and every message. */

import { MessageDoc, NodeDoc, type Optchat, tree } from "./optchat/index.ts";

const { key, nbytes, ref, span } = tree;

function esc(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function when(ms: number | undefined): string {
	return ms === undefined ? "" : new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export async function renderPage(optchat: Optchat): Promise<string> {
	const context = optchat.context;
	const chat = await optchat.state();
	const conversationId = optchat.root.id;
	const dates = new Map<number, number>();
	const dateOf = async (i: number): Promise<number | undefined> => {
		if (!dates.has(i)) {
			const record = await optchat.harness.snapshot(MessageDoc, conversationId, String(i), context);
			if (record !== undefined) dates.set(i, record.date);
		}
		return dates.get(i);
	};
	const item = (head: string[], text: string): string => `<h4>${esc(head.join(" · "))}</h4><pre>${esc(text)}</pre>`;
	const node = async (p: tree.Part, text: string): Promise<string> => {
		const [a, z] = span(p);
		const from = when(await dateOf(a));
		const to = when(await dateOf(z));
		return item([`${ref(p)}  (level ${p[0]})`, from === to ? from : `${from} – ${to}`, `${nbytes(text)} B`], text);
	};
	const levels = chat.count === 0 ? [] : Array.from({ length: chat.count.toString(2).length }, (_, l) => l);
	const sections: string[] = [];

	let view = "";
	for (const p of chat.view.parts) {
		const found = await optchat.harness.snapshot(NodeDoc, conversationId, key(p), context);
		view += await node(p, found?.text ?? tree.WAIT);
	}
	sections.push(`<section id="VIEW"><p>${chat.view.parts.length} lines, ${tree.vsize(chat.sizes, chat.view.parts)} bytes: what every turn starts with.</p>${view}</section>`);

	let root = "";
	for (let i = 0; i < chat.count; i++) {
		const text = await optchat.zoom(i, 1);
		const record = await optchat.harness.snapshot(MessageDoc, conversationId, String(i), context);
		root += item([`#${i}`, when(record?.date), record?.kind ?? "", `${record?.size ?? 0} B`], text.replace(/^\d+\+1\|/, ""));
	}
	sections.push(`<section id="ROOT"><p>${chat.count} messages, whole.</p>${root}</section>`);

	for (const l of levels) {
		let level = "";
		for (let i = 0; (i + 1) * 2 ** l <= chat.count; i++) {
			const found = await optchat.harness.snapshot(NodeDoc, conversationId, key([l, i]), context);
			if (found !== undefined) level += await node([l, i], found.text);
		}
		sections.push(`<section id="LVL${l}"><p>Level ${l}: each line covers ${2 ** l} message${l === 0 ? "" : "s"}.</p>${level}</section>`);
	}

	const menu = ["VIEW", "ROOT", ...levels.map((l) => `LVL${l}`)].map((name) => `<a href="#${name}">${name}</a>`).join("");
	return `<!doctype html><meta charset="utf-8"><title>optchat memory</title>
<style>
body { font: 13px/1.4 ui-monospace, monospace; margin: 2em; max-width: 120ch; } nav a { margin-right: 1em; }
section { display: none; } section:target { display: block; } p { color: #666; }
h4 { margin: .8em 0 .2em; color: #888; font-weight: normal; } pre { margin: 0; white-space: pre-wrap; font: inherit; }
</style>
<script>location.hash = location.hash || "VIEW";</script>
<h2>optchat memory</h2><nav>${menu}</nav>
${sections.join("\n")}
`;
}
