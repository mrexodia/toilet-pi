// The optchat memory visualizer. Plays the memory's history commit by commit (frames from /api/history), draws the tree
// of summaries, and shows what goes into a model request as colored blocks: the memory view at any moment, a request
// rebuilt from the store, or a recorded request exactly as it was sent.

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- palette

const KIND = { user: "#f778ba", optchat: "#3fb950", tool: "#d29922", echo: "#8b949e", work: "#a371f7", note: "#79c0ff" };
const KIND_NAME = { user: "you", optchat: "optchat", tool: "tool call", echo: "tool result", work: "agent report", note: "note" };

const SEG = {
	prompt: { color: "#5b6b82", group: "system", name: "system prompt" },
	section: { color: "#8a7fd6", group: "system", name: "system section" },
	tool: { color: "#2f8f86", group: "tools", name: "tool definition" },
	view: { color: null, group: "view", name: "memory line" },
	state: { color: "#b08a3e", group: "input", name: "turn state" },
	head: { color: "#9c7a2e", group: "input", name: "turn header" },
	input: { color: "#f778ba", group: "input", name: "your message" },
	steer: { color: "#ff9bd2", group: "run", name: "message while working" },
	work: { color: "#a371f7", group: "run", name: "agent report" },
	assistant: { color: "#3fb950", group: "run", name: "reply" },
	thinking: { color: "#25683a", group: "run", name: "thinking" },
	call: { color: "#d29922", group: "run", name: "tool call" },
	result: { color: "#8b949e", group: "run", name: "tool result" },
	task: { color: "#e3b341", group: "compaction", name: "compaction task" },
	source: { color: "#ffa657", group: "compaction", name: "what it compresses" },
	retry: { color: "#f0883e", group: "compaction", name: "retry note" },
	other: { color: "#3a4555", group: "other", name: "markup" },
};
const GROUPS = {
	system: { name: "system prompt", color: "#6b7894" },
	tools: { name: "tools", color: "#2f8f86" },
	view: { name: "memory view", color: "#58a6ff" },
	input: { name: "turn input", color: "#f778ba" },
	run: { name: "run so far", color: "#3fb950" },
	compaction: { name: "compaction", color: "#ffa657" },
	other: { name: "markup", color: "#3a4555" },
};

function levelColor(l, a = 1) {
	const h = 205 + l * 9;
	const li = Math.max(50, 68 - l * 1.6);
	return a === 1 ? `hsl(${h} 82% ${li}%)` : `hsl(${h} 82% ${li}% / ${a})`;
}
const segColor = (s) => (s.kind === "view" ? levelColor(s.level ?? s.part?.[0] ?? 0) : (SEG[s.kind] ?? SEG.other).color);

// ---------------------------------------------------------------- format

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
function fmtBytes(n) {
	if (n < 1000) return `${n} B`;
	if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)} KB`;
	return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)} MB`;
}
const fmtTok = (n) => (n == null ? "–" : n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 1e5 ? 1 : 0)}k`);
function fmtDur(ms) {
	if (ms == null) return "";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
	if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
	return `${(ms / 86_400_000).toFixed(1)} days`;
}
const pad2 = (n) => String(n).padStart(2, "0");
function fmtDate(t) {
	if (!t) return "";
	const d = new Date(t);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
const fmtClock = (t) => (t ? fmtDate(t).slice(11) : "");
const keyOf = (p) => `${p[0]}/${p[1]}`;
const parseKey = (k) => k.split("/").map(Number);
const spanOf = (l, i) => [i * 2 ** l, (i + 1) * 2 ** l - 1];
const refOf = (l, i) => `${i * 2 ** l}+${2 ** l}`;

async function api(path) {
	const res = await fetch(path, { cache: "no-store" });
	const body = await res.json().catch(() => ({ error: res.statusText }));
	if (!res.ok) throw new Error(body.error ?? res.statusText);
	return body;
}

function lowerBound(arr, x) {
	let a = 0;
	let z = arr.length;
	while (a < z) {
		const m = (a + z) >> 1;
		if (arr[m] < x) a = m + 1;
		else z = m;
	}
	return a;
}

// ---------------------------------------------------------------- state

const S = (window.optchatViz = {
	frames: [],
	seqs: [],
	times: [],
	kinds: [],
	/** Frame index → node keys whose compaction is running from that frame on. */
	startsAt: new Map(),
	pending: [],
	cur: -1,
	st: fresh(),
	playing: false,
	speed: 12,
	server: null,
	reqs: [],
	reqById: new Map(),
	reqFilter: "all",
	reqShown: 300,
	selReq: null,
	reqDetail: null,
	recon: null,
	mode: "view",
	selNode: null,
	hoverNode: null,
	highlight: new Set(),
	target: null,
});

function fresh() {
	return { count: 0, built: new Map(), building: new Set(), failed: new Map(), view: [], seen: [], viewKeys: new Set(), seenKeys: new Set(), turn: null, viewAt: -1e9 };
}

// ---------------------------------------------------------------- frames

function ingest(from, frames) {
	let rebuild = false;
	if (from < S.frames.length) {
		rebuild = from <= S.cur;
		S.frames.length = from;
		S.seqs.length = from;
		S.times.length = from;
	}
	for (const f of frames) {
		S.frames.push(f);
		S.seqs.push(f.seq);
		S.times.push(f.t);
		if (f.msgs) f.msgs.kinds.forEach((k, j) => (S.kinds[f.msgs.from + j] = k));
	}
	S.startsAt = new Map();
	S.frames.forEach((f, j) => {
		for (const b of f.built ?? []) {
			if (b.from === undefined) continue;
			const i = lowerBound(S.seqs, b.from);
			if (i >= j) continue;
			if (!S.startsAt.has(i)) S.startsAt.set(i, []);
			S.startsAt.get(i).push(b.key);
		}
	});
	if (rebuild) {
		const k = Math.min(S.cur, S.frames.length - 1);
		S.cur = -1;
		S.st = fresh();
		seek(k, false);
	}
}

function splice(parts, s) {
	parts.splice(s[0], s[1], ...s[2].map((p) => [p[0], p[1]]));
}

function applyFrame(k, anim) {
	const f = S.frames[k];
	const st = S.st;
	const now = anim ? performance.now() : -1e9;
	if (f.msgs) st.count = f.msgs.from + f.msgs.kinds.length;
	for (const key of S.startsAt.get(k) ?? []) st.building.add(key);
	for (const b of f.built ?? []) {
		const [l, i] = parseKey(b.key);
		st.built.set(b.key, { l, i, size: b.size, ms: b.ms, born: now });
		st.building.delete(b.key);
		st.failed.delete(b.key);
	}
	if (f.view) {
		splice(st.view, f.view);
		st.viewKeys = new Set(st.view.map(keyOf));
		st.viewAt = now;
	}
	if (f.seen) {
		splice(st.seen, f.seen);
		st.seenKeys = new Set(st.seen.map(keyOf));
	}
	if (f.turn) st.turn = { frame: k, first: f.turn.first, state: f.turn.state, parts: (f.turn.parts ?? st.view).map((p) => [p[0], p[1]]) };
	if (f.fail) for (const key of f.fail.keys) st.failed.set(key, now);
	S.cur = k;
}

/** Move to frame k: forward by applying frames, backward by replaying from the start. */
function seek(k, anim = false) {
	k = Math.max(-1, Math.min(k, S.frames.length - 1));
	const from = S.cur;
	if (k < S.cur) {
		S.st = fresh();
		S.cur = -1;
	}
	for (let j = S.cur + 1; j <= k; j++) applyFrame(j, anim);
	afterSeek(from);
}

function atEnd() {
	return S.cur >= S.frames.length - 1;
}

// ---------------------------------------------------------------- playback

let last = 0;
let carry = 0;
function play(on) {
	S.playing = on;
	S.catching = false;
	$("#b-play").textContent = on ? "⏸" : "▶";
	if (on) {
		if (atEnd()) seek(-1);
		last = performance.now();
		carry = 0;
		requestAnimationFrame(tick);
	}
}
function tick(now) {
	if (!S.playing) return;
	// Following a live agent, the playhead speeds up to stay within a couple of seconds of it.
	const backlog = S.frames.length - 1 - S.cur;
	carry += ((now - last) / 1000) * (S.catching ? Math.max(S.speed, backlog / 2) : S.speed);
	last = now;
	const steps = Math.floor(carry);
	if (steps > 0) {
		carry -= steps;
		const from = S.cur;
		const k = Math.min(S.frames.length - 1, S.cur + steps);
		for (let j = S.cur + 1; j <= k; j++) applyFrame(j, true);
		afterSeek(from);
		if (atEnd()) {
			S.playing = false;
			$("#b-play").textContent = "▶";
			return;
		}
	}
	requestAnimationFrame(tick);
}
/** New frames while sitting at the end: play them in, at the chosen speed. */
function catchUp() {
	if (S.playing) return;
	S.playing = true;
	S.catching = true;
	$("#b-play").textContent = "⏸";
	last = performance.now();
	carry = 1;
	requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- after each move

let reconTimer = 0;
function afterSeek(from) {
	dirtyTree();
	drawTimeline();
	updateLabel();
	if (S.playing && $("#follow-req").checked && S.reqs.length > 0 && S.cur > from && from >= 0) {
		const t0 = S.times[from];
		const t1 = S.times[S.cur];
		let hit = null;
		for (const r of S.reqs) if (r.started > t0 && r.started <= t1) hit = r;
		if (hit) selectRequest(hit.id, { seek: false, quiet: true });
	}
	if (S.mode === "view") renderContext();
	// Throttled, not debounced: while playing, the rebuilt request keeps up a few times a second.
	if (S.mode === "recon" && !reconTimer) {
		reconTimer = setTimeout(() => {
			reconTimer = 0;
			loadRecon();
		}, S.playing ? 350 : 80);
	}
}

function describe(f) {
	if (!f) return "";
	const out = [];
	if (f.turn) out.push(`a turn starts at message ${f.turn.first}; its view is frozen for the run`);
	if (f.msgs) {
		const n = f.msgs.kinds.length;
		const by = {};
		for (const k of f.msgs.kinds) by[k] = (by[k] ?? 0) + 1;
		out.push(`+${plural(n, "message")} (${Object.entries(by).map(([k, c]) => `${c} ${KIND_NAME[k] ?? k}`).join(", ")}), from #${f.msgs.from}`);
	}
	if (f.built) {
		if (f.built.length === 1) {
			const b = f.built[0];
			const [l, i] = parseKey(b.key);
			out.push(`built ${refOf(l, i)} (level ${l}, ${fmtBytes(b.size)})${b.ms ? ` in ${fmtDur(b.ms)}` : l === 0 ? ", short enough to keep whole" : ""}`);
		} else out.push(`built ${plural(f.built.length, "node")}`);
	}
	if (f.view) {
		const [, del, ins] = f.view;
		if (del > ins.length) out.push(`view merged ${del} lines into ${ins.length}`);
		else if (ins.length > del) out.push(`view +${ins.length - del} line${ins.length - del === 1 ? "" : "s"}`);
	}
	if (f.seen && f.seen[1] > f.seen[2].length) out.push(`compactor view merged ${f.seen[1]} → ${f.seen[2].length}`);
	if (f.fail) out.push(`${plural(f.fail.n, "compaction")} failed${f.fail.until > f.t ? ` over ${fmtDur(f.fail.until - f.t)}` : ""}${f.fail.error ? `: ${f.fail.error.split("\n")[0].slice(0, 160)}` : ""}`);
	return out.join(" · ");
}

function updateLabel() {
	const f = S.frames[S.cur];
	$("#tl-time").textContent = f ? `${fmtDate(f.t)}  ·  ${S.cur + 1}/${S.frames.length}` : S.frames.length ? `before the first commit · 0/${S.frames.length}` : "no history yet";
	$("#tl-what").textContent = f ? describe(f) : "";
	$("#tl-what").style.color = f?.fail ? "#ff9a92" : "";
}

// ---------------------------------------------------------------- the tree

const tree = $("#tree");
const T = { fit: true, x0: 0, scale: 1, dirty: true, drag: null, layout: null };

function dirtyTree() {
	T.dirty = true;
}

function layout() {
	const W = tree.clientWidth;
	const H = tree.clientHeight;
	const total = Math.max(S.kinds.length, 1);
	const levels = Math.max(1, Math.floor(Math.log2(total)) + 1);
	const padL = 40;
	const padR = 14;
	const padT = 18;
	const lane = 9;
	const padB = lane + 18;
	const rowH = Math.max(6, Math.min(34, (H - padT - padB) / levels));
	const fitScale = (W - padL - padR) / total;
	if (T.fit) {
		T.scale = fitScale;
		T.x0 = 0;
	}
	T.scale = Math.max(T.scale, fitScale);
	T.x0 = Math.max(0, Math.min(T.x0, total - (W - padL - padR) / T.scale));
	const base = H - padB;
	return {
		W, H, total, levels, padL, padR, padT, lane, padB, rowH, base,
		X: (i) => padL + (i - T.x0) * T.scale,
		Y: (l) => base - (l + 1) * rowH,
		index: (x) => T.x0 + (x - padL) / T.scale,
	};
}

function drawTree(now) {
	const dpr = window.devicePixelRatio || 1;
	const W = tree.clientWidth;
	const H = tree.clientHeight;
	if (tree.width !== Math.round(W * dpr) || tree.height !== Math.round(H * dpr)) {
		tree.width = Math.round(W * dpr);
		tree.height = Math.round(H * dpr);
	}
	const g = tree.getContext("2d");
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, W, H);
	const L = (T.layout = layout());
	const st = S.st;
	let animating = false;

	// Level rows and labels.
	g.font = "10px ui-monospace, Consolas, monospace";
	g.textBaseline = "middle";
	for (let l = 0; l < L.levels; l++) {
		const y = L.Y(l);
		if (l % 2 === 0) {
			g.fillStyle = "rgba(255,255,255,0.018)";
			g.fillRect(0, y, W, L.rowH);
		}
		if (L.rowH >= 9) {
			g.fillStyle = levelColor(l, 0.75);
			g.fillText(l === 0 ? "msg" : `×${2 ** l}`, 6, y + L.rowH / 2);
		}
	}
	g.save();
	g.beginPath();
	g.rect(L.padL - 2, 0, W - L.padL + 2, H);
	g.clip();

	const visible = (a, n) => L.X(a + n) >= L.padL - 2 && L.X(a) <= W;
	const gap = (w) => (w > 5 ? 1 : 0);

	// Messages waiting for their leaf: hollow.
	g.strokeStyle = "rgba(160,175,195,0.35)";
	g.lineWidth = 1;
	if (T.scale >= 2) {
		for (let id = 0; id < st.count; id++) {
			if (st.built.has(`0/${id}`) || !visible(id, 1)) continue;
			const x = L.X(id);
			g.strokeRect(x + 0.5, L.Y(0) + 1.5, Math.max(1, T.scale - gap(T.scale) - 1), L.rowH - 3);
		}
	}

	// Built nodes.
	for (const [key, n] of st.built) {
		const len = 2 ** n.l;
		const a = n.i * len;
		if (!visible(a, len)) continue;
		const x = L.X(a);
		const w = Math.max(1, len * T.scale - gap(len * T.scale));
		let y = L.Y(n.l) + 1;
		let h = L.rowH - 2;
		const age = now - n.born;
		const inView = st.viewKeys.has(key);
		if (age < 900) {
			animating = true;
			const e = 1 - (1 - age / 900) ** 3;
			const hh = h * (0.35 + 0.65 * e);
			y += h - hh;
			h = hh;
		}
		g.fillStyle = levelColor(n.l, inView ? 0.95 : 0.24);
		g.fillRect(x, y, w, h);
		if (age < 900) {
			g.fillStyle = `rgba(255,255,255,${0.75 * (1 - age / 900)})`;
			g.fillRect(x, y, w, h);
		}
		if (inView && w > 3) {
			g.strokeStyle = "rgba(255,255,255,0.55)";
			g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
		}
		if (st.seenKeys.has(key)) {
			g.fillStyle = "#e3b341";
			g.fillRect(x, y + h - 2, w, 2);
		}
		if (S.highlight.has(key)) {
			g.strokeStyle = "#ff9f43";
			g.lineWidth = 2;
			g.strokeRect(x + 1, y + 1, Math.max(1, w - 2), h - 2);
			g.lineWidth = 1;
		}
	}

	// Compactions running: pulsing dashed outlines.
	const pending = S.pending.filter((p) => atEnd() || lowerBound(S.seqs, p.from) <= S.cur).map((p) => p.key);
	const building = new Set([...st.building, ...pending]);
	if (building.size > 0) {
		animating = true;
		const pulse = 0.55 + 0.45 * Math.sin(now / 180);
		g.setLineDash([4, 3]);
		g.lineDashOffset = -now / 60;
		g.lineWidth = 1.5;
		for (const key of building) {
			if (st.built.has(key)) continue;
			const [l, i] = parseKey(key);
			const len = 2 ** l;
			if (!visible(i * len, len)) continue;
			const x = L.X(i * len);
			const w = Math.max(2, len * T.scale - gap(len * T.scale));
			g.fillStyle = `rgba(227,179,65,${0.12 * pulse})`;
			g.fillRect(x, L.Y(l) + 1, w, L.rowH - 2);
			g.strokeStyle = `rgba(227,179,65,${pulse})`;
			g.strokeRect(x + 0.75, L.Y(l) + 1.75, w - 1.5, L.rowH - 3.5);
		}
		g.setLineDash([]);
		g.lineWidth = 1;
	}

	// Failed compactions.
	for (const [key, born] of st.failed) {
		const [l, i] = parseKey(key);
		const len = 2 ** l;
		if (!visible(i * len, len)) continue;
		const age = now - born;
		if (age < 1200) animating = true;
		g.strokeStyle = age < 1200 && Math.floor(age / 150) % 2 === 0 ? "#ffd2cf" : "#f85149";
		g.lineWidth = 2;
		g.strokeRect(L.X(i * len) + 1, L.Y(l) + 1, Math.max(2, len * T.scale - 2), L.rowH - 2);
		g.lineWidth = 1;
	}

	// The compaction a selected request builds.
	if (S.target) {
		const [l, i] = S.target;
		const len = 2 ** l;
		g.setLineDash([3, 2]);
		g.strokeStyle = "#ff9f43";
		g.lineWidth = 2;
		g.strokeRect(L.X(i * len) + 1, L.Y(l) + 1, Math.max(3, len * T.scale - 2), L.rowH - 2);
		g.setLineDash([]);
		g.lineWidth = 1;
	}

	// Message kinds lane.
	const laneY = L.base + 4;
	for (let id = 0; id < st.count; id++) {
		if (!visible(id, 1)) continue;
		g.fillStyle = KIND[S.kinds[id]] ?? "#555";
		g.fillRect(L.X(id), laneY, Math.max(1, T.scale - gap(T.scale)), L.lane - 2);
	}

	// Hover and selection.
	for (const [key, color, width] of [
		[S.hoverNode, "#ffffff", 1.5],
		[S.selNode, "#ffffff", 2.5],
	]) {
		if (!key || !(st.built.has(key) || building.has(key) || st.failed.has(key))) continue;
		const [l, i] = parseKey(key);
		const len = 2 ** l;
		g.strokeStyle = color;
		g.lineWidth = width;
		g.strokeRect(L.X(i * len) + 0.5, L.Y(l) + 0.5, Math.max(2, len * T.scale - 1), L.rowH - 1);
		g.lineWidth = 1;
	}

	// The frozen turn and the present.
	if (st.turn) {
		const x = L.X(st.turn.first);
		const fresh = S.cur === st.turn.frame;
		g.strokeStyle = fresh ? "#d2a8ff" : "rgba(210,168,255,0.45)";
		g.setLineDash([5, 4]);
		g.beginPath();
		g.moveTo(x + 0.5, 12);
		g.lineTo(x + 0.5, laneY + L.lane);
		g.stroke();
		g.setLineDash([]);
		g.fillStyle = g.strokeStyle;
		g.textBaseline = "top";
		g.fillText("turn", Math.min(x + 4, W - 30), 2);
		g.textBaseline = "middle";
	}
	g.restore();

	if (S.frames.length === 0) {
		g.fillStyle = "#7b8796";
		g.font = "13px system-ui, sans-serif";
		g.textAlign = "center";
		g.fillText("No memory yet: messages appear here as the agent indexes them.", W / 2, H / 2);
		g.textAlign = "left";
	}
	return animating;
}

function treeLoop(now) {
	if (T.dirty || T.animating) {
		T.dirty = false;
		T.animating = drawTree(now);
	}
	requestAnimationFrame(treeLoop);
}

function hitNode(ev) {
	const L = T.layout;
	if (!L) return null;
	const r = tree.getBoundingClientRect();
	const x = ev.clientX - r.left;
	const y = ev.clientY - r.top;
	if (x < L.padL) return null;
	const idx = Math.floor(L.index(x));
	if (idx < 0 || idx >= S.st.count) return null;
	if (y >= L.base + 2 && y <= L.base + 4 + L.lane + 2) return { msg: idx };
	const l = Math.floor((L.base - y) / L.rowH);
	if (l < 0 || l >= L.levels) return null;
	const key = `${l}/${idx >> l}`;
	if (S.st.built.has(key) || S.st.building.has(key) || S.st.failed.has(key)) return { key };
	return null;
}

tree.addEventListener("mousemove", (ev) => {
	if (T.drag) {
		const dx = ev.clientX - T.drag.x;
		T.drag.moved ||= Math.abs(dx) > 3;
		T.x0 = T.drag.x0 - dx / T.scale;
		T.fit = false;
		dirtyTree();
		hideTip();
		return;
	}
	const hit = hitNode(ev);
	const key = hit?.key ?? null;
	if (key !== S.hoverNode) {
		S.hoverNode = key;
		dirtyTree();
	}
	if (hit?.key) tipNode(hit.key, ev);
	else if (hit?.msg !== undefined) tipMessage(hit.msg, ev);
	else hideTip();
});
tree.addEventListener("mouseleave", () => {
	S.hoverNode = null;
	T.drag = null;
	dirtyTree();
	hideTip();
});
tree.addEventListener("mousedown", (ev) => {
	T.drag = { x: ev.clientX, x0: T.x0, moved: false };
});
window.addEventListener("mouseup", (ev) => {
	if (T.drag && !T.drag.moved && ev.target === tree) {
		const hit = hitNode(ev);
		if (hit?.key) showNode(hit.key);
		else if (hit?.msg !== undefined) showMessages(hit.msg, hit.msg);
	}
	T.drag = null;
});
tree.addEventListener("wheel", (ev) => {
	ev.preventDefault();
	const L = T.layout;
	if (!L) return;
	const r = tree.getBoundingClientRect();
	const x = ev.clientX - r.left;
	const at = L.index(x);
	T.fit = false;
	T.scale *= Math.exp(-ev.deltaY * 0.0015);
	T.x0 = at - (x - L.padL) / T.scale;
	dirtyTree();
}, { passive: false });
tree.addEventListener("dblclick", () => {
	T.fit = true;
	dirtyTree();
});

function renderTreeLegend() {
	$("#tree-legend").innerHTML = [
		[levelColor(1), "in the view"],
		[levelColor(1, 0.24), "built, not in view"],
		["#e3b341", "in the compactor's view"],
		["transparent; outline: 1px dashed #e3b341", "being built"],
		["#f85149", "failed"],
		["#ff9f43", "in the selected request"],
	].map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("") +
		`<span>·</span>` + Object.entries(KIND).map(([k, c]) => `<span><i style="background:${c}"></i>${KIND_NAME[k]}</span>`).join("");
}

// ---------------------------------------------------------------- tooltips

const tip = $("#tip");
let tipToken = 0;
function placeTip(ev) {
	const pad = 14;
	const r = tip.getBoundingClientRect();
	let x = ev.clientX + pad;
	let y = ev.clientY + pad;
	if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
	if (y + r.height > innerHeight - 8) y = Math.max(8, ev.clientY - r.height - pad);
	tip.style.left = `${Math.max(8, x)}px`;
	tip.style.top = `${y}px`;
}
function showTip(html, ev) {
	tip.innerHTML = html;
	tip.hidden = false;
	placeTip(ev);
	return ++tipToken;
}
function hideTip() {
	tip.hidden = true;
	tipToken++;
}

const cache = new Map();
function cached(url) {
	if (!cache.has(url)) cache.set(url, api(url).catch((e) => (cache.delete(url), Promise.reject(e))));
	return cache.get(url);
}
const nodeInfo = (key) => cached(`/api/node?key=${key}`);
const messagesIn = (a, z, limit, chars) => cached(`/api/messages?from=${a}&to=${z}&limit=${limit}&chars=${chars}`);

function msgHtml(m, { full = false } = {}) {
	return `<div class="msg ${esc(m.kind)}"><div class="h"><b>#${m.id}</b><span>${esc(KIND_NAME[m.kind] ?? m.kind)}</span><span>${fmtDate(m.date)}</span>${m.pages > 1 ? `<span>page ${m.page + 1}/${m.pages}</span>` : ""}<span>${fmtBytes(m.size)}</span></div><pre>${esc(m.text)}${m.cut ? "…" : ""}</pre>${m.cut && full ? `<button class="more" data-msg="${m.id}">show all ${m.length.toLocaleString()} characters</button>` : ""}</div>`;
}

function nodeHead(key) {
	const [l, i] = parseKey(key);
	const n = S.st.built.get(key);
	const [a, z] = spanOf(l, i);
	const where = [S.st.viewKeys.has(key) && "in the view", S.st.seenKeys.has(key) && "in the compactor's view", S.st.building.has(key) && "being built", S.st.failed.has(key) && "failed"].filter(Boolean);
	return {
		title: `<span class="badge other" style="background:${levelColor(l, 0.25)};color:${levelColor(l)}">${l === 0 ? "message" : `level ${l}`}</span> line ${refOf(l, i)}`,
		sub: `${a === z ? `message #${a}` : `messages #${a}–#${z} (${2 ** l})`}${n ? ` · ${fmtBytes(n.size)}` : ""}${n?.ms ? ` · summarized in ${fmtDur(n.ms)}` : ""}${where.length ? ` · ${where.join(", ")}` : ""}`,
	};
}

async function tipNode(key, ev) {
	if (!tip.hidden && tip.dataset.key === key) return placeTip(ev);
	const [l, i] = parseKey(key);
	const [a, z] = spanOf(l, i);
	const h = nodeHead(key);
	const token = showTip(`<div class="t">${h.title}</div><div class="s">${h.sub}</div><pre class="dim">loading…</pre>`, ev);
	tip.dataset.key = key;
	try {
		const [node, msgs] = await Promise.all([nodeInfo(key), messagesIn(a, z, 4, l === 0 ? 900 : 260)]);
		if (token !== tipToken) return;
		const text = node.text ?? "(not summarized yet)";
		const more = msgs.total - msgs.messages.length;
		tip.innerHTML = `<div class="t">${h.title}</div><div class="s">${h.sub}</div><pre>${esc(text)}</pre><div class="msgs"><div class="s">${l === 0 ? "the real message" : "your real messages"}</div>${msgs.messages.map((m) => msgHtml(m)).join("")}${more > 0 ? `<div class="s">… and ${plural(more, "more message")}. Click to read them.</div>` : ""}</div>`;
		placeTip(ev);
	} catch (e) {
		if (token === tipToken) tip.querySelector("pre").textContent = String(e.message ?? e);
	}
}

async function tipMessage(id, ev) {
	if (!tip.hidden && tip.dataset.key === `m${id}`) return placeTip(ev);
	const token = showTip(`<div class="t">message #${id}</div><pre class="dim">loading…</pre>`, ev);
	tip.dataset.key = `m${id}`;
	const msgs = await messagesIn(id, id, 1, 900).catch(() => null);
	if (token !== tipToken || !msgs) return;
	tip.innerHTML = msgs.messages.map((m) => msgHtml(m)).join("");
	placeTip(ev);
}

// ---------------------------------------------------------------- details panel

function setDetail(title, html) {
	$("#detail-title").textContent = title;
	$("#detail").innerHTML = html;
	$("#detail").scrollTop = 0;
}

async function showNode(key) {
	S.selNode = key;
	dirtyTree();
	const [l, i] = parseKey(key);
	const [a, z] = spanOf(l, i);
	const h = nodeHead(key);
	setDetail(`Line ${refOf(l, i)}`, `<h3>${h.title}</h3><div class="dim">${h.sub}</div><p class="dim">loading…</p>`);
	const node = await nodeInfo(key).catch(() => null);
	if (S.selNode !== key) return;
	const kids = l > 0 ? [[l - 1, 2 * i], [l - 1, 2 * i + 1]] : [];
	const up = [l + 1, i >> 1];
	const nav = [
		...kids.map((p) => `<button class="btn" data-node="${keyOf(p)}">▼ ${refOf(...p)}</button>`),
		S.st.built.has(keyOf(up)) ? `<button class="btn" data-node="${keyOf(up)}">▲ ${refOf(...up)}</button>` : "",
	].join("");
	$("#detail").innerHTML = `<h3>${h.title}</h3><div class="dim">${h.sub}${node?.dates?.[0] ? ` · ${fmtDate(node.dates[0])}${node.dates[1] && node.dates[1] !== node.dates[0] ? ` – ${fmtDate(node.dates[1])}` : ""}` : ""}</div>
		<div class="kids">${nav}</div>
		<div class="sum">${esc(node?.text ?? "(not summarized yet)")}</div>
		<h3 style="margin-top:12px">${l === 0 ? "The real message" : `Your real messages (${2 ** l})`}</h3>
		<div id="detail-msgs"></div>`;
	loadMessagesInto($("#detail-msgs"), a, z, a);
}

async function showMessages(a, z) {
	S.selNode = null;
	dirtyTree();
	setDetail(a === z ? `Message #${a}` : `Messages #${a}–#${z}`, `<div id="detail-msgs"></div>`);
	loadMessagesInto($("#detail-msgs"), a, z, a);
}

async function loadMessagesInto(box, a, z, from) {
	const page = 20;
	const msgs = await api(`/api/messages?from=${from}&to=${z}&limit=${page}&chars=4000`).catch((e) => ({ messages: [], error: e.message }));
	if (!box.isConnected) return;
	box.querySelector(".more.page")?.remove();
	box.insertAdjacentHTML("beforeend", msgs.messages.map((m) => msgHtml(m, { full: true })).join(""));
	const next = from + page;
	if (next <= z) {
		const btn = document.createElement("button");
		btn.className = "more page";
		btn.textContent = `show ${Math.min(page, z - next + 1)} more of ${z - next + 1}`;
		btn.onclick = () => loadMessagesInto(box, a, z, next);
		box.append(btn);
	}
}

$("#detail").addEventListener("click", async (ev) => {
	const t = ev.target.closest("[data-node],[data-msg],[data-req],[data-full]");
	if (!t) return;
	if (t.dataset.node) showNode(t.dataset.node);
	else if (t.dataset.msg) {
		const m = await api(`/api/message?id=${t.dataset.msg}`);
		t.closest(".msg").outerHTML = msgHtml({ ...m, cut: false });
	} else if (t.dataset.full) openModal();
});
$("#detail-close").onclick = () => {
	S.selNode = null;
	dirtyTree();
	setDetail("Details", `<p class="dim">Hover anything to peek; click to pin it here.</p>`);
};

// ---------------------------------------------------------------- the context panel

function viewItems() {
	const st = S.st;
	const atTurn = st.turn && st.turn.frame === S.cur;
	const parts = atTurn ? st.turn.parts.filter((p) => spanOf(...p)[1] < st.turn.first) : st.view;
	return {
		atTurn,
		items: parts.map((p) => {
			const key = keyOf(p);
			const n = st.built.get(key);
			return { key: `v:${key}`, kind: "view", label: refOf(...p), bytes: n ? n.size + refOf(...p).length + 2 : 30, part: p, level: p[0], node: key };
		}),
	};
}

function segItems(segments) {
	const seen = new Map();
	return segments.map((s, idx) => {
		let key;
		if (s.part) key = `v:${keyOf(s.part)}`;
		else {
			const base = `${s.kind}:${s.label}`;
			const n = (seen.get(base) ?? 0) + 1;
			seen.set(base, n);
			key = `${base}#${n}`;
		}
		return { ...s, key, idx, level: s.part?.[0], node: s.part ? keyOf(s.part) : undefined };
	});
}

function renderContext() {
	const tabs = $("#ctx-tabs");
	for (const b of tabs.querySelectorAll("button")) b.classList.toggle("on", b.dataset.mode === S.mode);
	tabs.querySelector('[data-mode="request"]').disabled = S.reqs.length === 0;
	let items;
	let sub;
	if (S.mode === "request" && S.reqDetail) {
		const r = S.reqDetail;
		items = segItems(r.segments);
		const u = r.usage;
		const cachePct = u && u.input + u.cacheRead > 0 ? Math.round((100 * u.cacheRead) / (u.input + u.cacheRead + u.cacheWrite)) : null;
		sub = `<span class="badge ${r.kind}">${r.kind}</span> <b>#${r.id}</b> ${esc(r.label)} · ${esc(r.provider)}/${esc(r.model)} · ${fmtDate(r.started)}${r.ended ? ` · ${fmtDur(r.ended - r.started)}` : ` · <span class="spin"></span> running`}${u ? ` · in ${fmtTok(u.input + u.cacheRead + u.cacheWrite)} tokens${cachePct !== null ? ` (${cachePct}% cached)` : ""} · out ${fmtTok(u.output)}${u.cost ? ` · $${u.cost.toFixed(4)}` : ""}` : ""}${r.error ? ` · <span style="color:#ff9a92">${esc(r.error.slice(0, 160))}</span>` : ""}<br><span class="dim">Recorded exactly as it was sent: each block is part of the provider-neutral context; <b>Full request…</b> shows the wire payload.</span>`;
	} else if (S.mode === "recon" && S.recon) {
		items = segItems(S.recon.segments);
		sub = `<b>${S.recon.mode === "turn" ? "A turn's first request" : "A turn starting now"}</b> · ${fmtDate(S.recon.t)}<br><span class="dim">${esc(S.recon.note)}</span>`;
	} else if (S.mode === "recon") {
		items = [];
		sub = `<span class="dim">rebuilding…</span>`;
	} else {
		const v = viewItems();
		items = v.items;
		const bytes = items.reduce((n, x) => n + x.bytes, 0);
		sub = v.atTurn
			? `<b>A turn starts:</b> the view frozen for its run — ${plural(items.length, "line")}, ${fmtBytes(bytes)}, covering messages #0–#${S.st.turn.first - 1}`
			: `<b>The memory view</b> a turn starting now would get — ${plural(items.length, "line")}, ${fmtBytes(bytes)}, covering ${plural(S.st.count, "message")}`;
		sub += `<br><span class="dim">Recent messages stay whole; older ones are merged into coarser lines. The system prompt, tools and your message come around it: see <b>Rebuilt request</b>.</span>`;
	}
	$("#ctx-sub").innerHTML = sub;
	renderBar(items);
	renderTiles(items);
	S.highlight = new Set(S.mode === "request" ? items.filter((x) => x.node).map((x) => x.node) : []);
	S.target = null;
	if (S.mode === "request" && S.reqDetail?.kind === "compaction") S.target = compactionTarget(S.reqDetail.label);
	dirtyTree();
	$("#full").disabled = S.mode === "request" ? !S.reqDetail : S.mode === "recon" ? !S.recon : S.frames.length === 0;
}

function compactionTarget(label) {
	let m = /compress message (\d+)/.exec(label);
	if (m) return [0, Number(m[1])];
	m = /merge (\d+)\+(\d+) and/.exec(label);
	if (m) {
		const n = Number(m[2]) * 2;
		return [Math.round(Math.log2(n)), Number(m[1]) / n];
	}
	return null;
}

const barEls = new Map();
function renderBar(items) {
	const bar = $("#ctx-bar");
	const groups = new Map();
	for (const it of items) {
		const g = it.kind === "view" ? "view" : (SEG[it.kind] ?? SEG.other).group;
		groups.set(g, (groups.get(g) ?? 0) + it.bytes);
	}
	const total = [...groups.values()].reduce((a, b) => a + b, 0) || 1;
	const order = Object.keys(GROUPS).filter((g) => groups.has(g));
	for (const [g, el] of barEls) if (!groups.has(g)) (el.remove(), barEls.delete(g));
	for (const g of order) {
		let el = barEls.get(g);
		if (!el) {
			el = document.createElement("div");
			el.style.flexGrow = "0";
			el.style.background = GROUPS[g].color;
			barEls.set(g, el);
		}
		bar.append(el);
		const share = groups.get(g) / total;
		requestAnimationFrame(() => (el.style.flexGrow = String(groups.get(g))));
		el.textContent = share > 0.08 ? `${GROUPS[g].name} ${fmtBytes(groups.get(g))}` : "";
		el.title = `${GROUPS[g].name}: ${fmtBytes(groups.get(g))} (${(share * 100).toFixed(1)}%)`;
	}
	$("#ctx-legend").innerHTML = order
		.map((g) => `<span><i style="background:${GROUPS[g].color}"></i>${GROUPS[g].name} <b>${fmtBytes(groups.get(g))}</b> ${((100 * groups.get(g)) / total).toFixed(1)}%</span>`)
		.join("") + (items.length ? `<span>total <b>${fmtBytes(total)}</b> in ${plural(items.length, "block")}</span>` : "");
}

const tileEls = new Map();
function renderTiles(items) {
	const box = $("#ctx-blocks");
	box.querySelector(".empty")?.remove();
	if (items.length === 0) {
		for (const el of tileEls.values()) el.remove();
		tileEls.clear();
		box.insertAdjacentHTML("beforeend", `<div class="empty">${S.frames.length === 0 ? "Nothing in the memory yet." : S.mode === "view" ? "The view is empty at this moment." : "…"}</div>`);
		return;
	}
	const W = Math.max(200, box.clientWidth - 28);
	const total = items.reduce((n, x) => n + Math.max(1, x.bytes), 0);
	const rows = Math.max(4, Math.floor((box.clientHeight - 16) / 24) - 1);
	const perByte = (W * rows) / total;
	const entering = [];
	let prev = null;
	const keep = new Set();
	for (const it of items) {
		let w = Math.max(4, it.bytes * perByte - 2);
		let h = 22;
		if (w > W) {
			const r = Math.min(8, Math.ceil(w / W));
			h = r * 22 + (r - 1) * 2;
			w = W;
		}
		let el = tileEls.get(it.key);
		if (!el) {
			el = document.createElement("div");
			el.className = "tile enter";
			tileEls.set(it.key, el);
			entering.push(el);
		}
		el._item = it;
		el.style.width = `${Math.round(w)}px`;
		el.style.height = `${h}px`;
		el.style.background = segColor(it);
		el.textContent = w > 44 ? it.label : "";
		el.classList.toggle("sel", S.selTile === it.key);
		const want = prev ? prev.nextSibling : box.firstChild;
		if (el !== want) box.insertBefore(el, want);
		prev = el;
		keep.add(it.key);
	}
	for (const [key, el] of tileEls) {
		if (keep.has(key)) continue;
		tileEls.delete(key);
		el.classList.add("leave");
		setTimeout(() => el.remove(), 420);
	}
	if (entering.length) requestAnimationFrame(() => requestAnimationFrame(() => entering.forEach((el) => el.classList.remove("enter"))));
}

async function tipTile(el, ev) {
	const it = el._item;
	if (!tip.hidden && tip.dataset.key === `t${it.key}`) return placeTip(ev);
	const seg = SEG[it.kind] ?? SEG.other;
	const head = `<div class="t"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${segColor(it)}"></i>${esc(it.label)}</div><div class="s">${esc(seg.name)} · ${fmtBytes(it.bytes)}${it.node ? ` · ${spanOf(...parseKey(it.node))[0] === spanOf(...parseKey(it.node))[1] ? `message #${spanOf(...parseKey(it.node))[0]}` : `messages #${spanOf(...parseKey(it.node))[0]}–#${spanOf(...parseKey(it.node))[1]}`}` : ""}</div>`;
	const text = it.text !== undefined ? it.text : null;
	const token = showTip(`${head}<pre>${text === null ? '<span class="dim">loading…</span>' : esc(text.slice(0, 1600)) + (text.length > 1600 ? "…" : "")}</pre>`, ev);
	tip.dataset.key = `t${it.key}`;
	if (!it.node) return;
	const [l, i] = parseKey(it.node);
	const [a, z] = spanOf(l, i);
	try {
		const [node, msgs] = await Promise.all([text === null ? nodeInfo(it.node) : null, messagesIn(a, z, 3, l === 0 ? 700 : 240)]);
		if (token !== tipToken) return;
		const shown = text ?? `${refOf(l, i)}|${node?.text ?? "(not summarized yet)"}`;
		const more = msgs.total - msgs.messages.length;
		tip.innerHTML = `${head}<pre>${esc(shown.slice(0, 1600))}</pre><div class="msgs"><div class="s">${l === 0 ? "the real message" : "your real messages behind this line"}</div>${msgs.messages.map((m) => msgHtml(m)).join("")}${more > 0 ? `<div class="s">… and ${plural(more, "more")}; click to read them all</div>` : ""}</div>`;
		placeTip(ev);
	} catch {}
}

$("#ctx-blocks").addEventListener("mousemove", (ev) => {
	const el = ev.target.closest(".tile");
	if (!el || !el._item || el.classList.contains("leave")) return hideTip();
	tipTile(el, ev);
	if (el._item.node !== S.hoverNode) {
		S.hoverNode = el._item.node ?? null;
		dirtyTree();
	}
});
$("#ctx-blocks").addEventListener("mouseleave", () => {
	hideTip();
	S.hoverNode = null;
	dirtyTree();
});
$("#ctx-blocks").addEventListener("click", (ev) => {
	const el = ev.target.closest(".tile");
	if (!el?._item) return;
	const it = el._item;
	S.selTile = it.key;
	for (const t of tileEls.values()) t.classList.toggle("sel", t === el);
	if (it.node && it.text === undefined) return showNode(it.node);
	const seg = SEG[it.kind] ?? SEG.other;
	setDetail(`${seg.name}: ${it.label}`, `<h3>${esc(it.label)}</h3><div class="dim">${esc(seg.name)} · ${fmtBytes(it.bytes)}</div><div class="sum" style="margin-top:8px">${esc(it.text)}</div>${it.node ? `<div class="kids"><button class="btn" data-node="${it.node}">Open line ${esc(it.label)} in the tree</button></div><div id="detail-msgs"></div>` : ""}`);
	if (it.node) {
		const [a, z] = spanOf(...parseKey(it.node));
		loadMessagesInto($("#detail-msgs"), a, z, a);
		S.selNode = it.node;
		dirtyTree();
	}
});

$("#ctx-tabs").addEventListener("click", (ev) => {
	const b = ev.target.closest("button");
	if (!b || b.disabled) return;
	setMode(b.dataset.mode);
});

function setMode(mode) {
	S.mode = mode;
	if (mode === "recon") {
		S.recon = null;
		loadRecon();
	}
	if (mode === "request" && !S.selReq && S.reqs.length) {
		const t = S.times[S.cur] ?? Infinity;
		const before = S.reqs.filter((r) => r.started <= t).at(-1) ?? S.reqs.at(-1);
		return selectRequest(before.id, { seek: false });
	}
	renderContext();
}

let reconToken = 0;
async function loadRecon() {
	if (S.mode !== "recon") return;
	if (S.cur < 0) {
		S.recon = null;
		return renderContext();
	}
	const token = ++reconToken;
	const k = S.cur;
	try {
		const recon = await cached(`/api/context?frame=${k}`);
		if (token !== reconToken || S.mode !== "recon") return;
		S.recon = recon;
	} catch (e) {
		S.recon = { mode: "view", segments: [], note: String(e.message ?? e), t: S.times[k] };
	}
	renderContext();
}

// ---------------------------------------------------------------- requests

function reqRow(r) {
	const u = r.usage;
	const tokens = u ? `in ${fmtTok(u.input + u.cacheRead + u.cacheWrite)}${u.cacheRead ? ` (${fmtTok(u.cacheRead)} cached)` : ""} · out ${fmtTok(u.output)}` : "";
	const status = r.ended == null ? `<span class="spin"></span> running` : r.error ? `<span class="err">${esc(r.error.slice(0, 80))}</span>` : `${fmtDur(r.ended - r.started)}`;
	return `<div class="req${S.selReq === r.id ? " sel" : ""}" data-req="${r.id}">
		<span class="badge ${r.kind}">${r.kind === "compaction" ? "compact" : r.kind}</span>
		<span class="label" title="${esc(r.label)}">${esc(r.label)}</span>
		<span class="when">${fmtClock(r.started)}</span>
		<span class="meta">#${r.id} · ${esc(r.model)} · ${status}${tokens ? ` · ${tokens}` : ""}${u?.cost ? ` · $${u.cost.toFixed(4)}` : ""}</span>
	</div>`;
}

function renderRequests() {
	const box = $("#requests");
	const list = S.reqs.filter((r) => S.reqFilter === "all" || r.kind === S.reqFilter);
	if (S.reqs.length === 0) {
		const rec = S.server?.requests;
		box.innerHTML = `<div class="notice">${
			rec && !rec.recording
				? `Request recording is off for this home (<code>"recordRequests": false</code> in <code>optchat.json</code>).`
				: `No requests recorded yet. The agent records every model call once it runs this version: restart <code>serve</code>, then talk to it. Turns and compactions appear here, each with exactly what was sent.<br><br>Until then, <b>Memory view</b> and <b>Rebuilt request</b> show what the store can tell.`
		}</div>`;
		return;
	}
	const shown = list.slice(-S.reqShown).reverse();
	box.innerHTML = shown.map(reqRow).join("") + (list.length > shown.length ? `<button class="more" id="req-more" style="padding:8px 12px">show older (${list.length - shown.length})</button>` : "");
}

$("#requests").addEventListener("click", (ev) => {
	if (ev.target.id === "req-more") {
		S.reqShown += 300;
		return renderRequests();
	}
	const row = ev.target.closest("[data-req]");
	if (row) selectRequest(Number(row.dataset.req), { seek: true });
});
$("#req-filter").addEventListener("click", (ev) => {
	const b = ev.target.closest("button");
	if (!b) return;
	S.reqFilter = b.dataset.kind;
	for (const x of $("#req-filter").querySelectorAll("button")) x.classList.toggle("on", x === b);
	renderRequests();
});

function frameAtTime(t) {
	const k = lowerBound(S.times, t + 1) - 1;
	return Math.max(0, k);
}

let reqToken = 0;
async function selectRequest(id, { seek: move = false, quiet = false } = {}) {
	S.selReq = id;
	S.mode = "request";
	const meta = S.reqById.get(id);
	for (const el of $("#requests").querySelectorAll(".req")) el.classList.toggle("sel", Number(el.dataset.req) === id);
	if (move && meta && S.frames.length) {
		play(false);
		seek(frameAtTime(meta.started));
	}
	drawTimeline();
	const token = ++reqToken;
	const running = meta?.ended == null;
	try {
		const detail = running ? await api(`/api/request?id=${id}`) : await cached(`/api/request?id=${id}`);
		if (token !== reqToken) return;
		S.reqDetail = detail;
	} catch (e) {
		if (token !== reqToken) return;
		S.reqDetail = null;
		$("#ctx-sub").textContent = String(e.message ?? e);
	}
	renderContext();
	if (!quiet && S.reqDetail) showRequestDetail(S.reqDetail);
}

function showRequestDetail(r) {
	const u = r.usage;
	const rows = [
		["kind", `<span class="badge ${r.kind}">${r.kind}</span>`],
		["model", `${esc(r.provider)}/${esc(r.model)} <span class="dim">(${esc(r.api)})</span>`],
		["settings", esc(JSON.stringify(r.settings))],
		["started", fmtDate(r.started)],
		["took", r.ended ? fmtDur(r.ended - r.started) : "running"],
		["stop", esc(r.stop ?? "")],
		...(u ? [["tokens", `in ${u.input.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · cache write ${u.cacheWrite.toLocaleString()} · out ${u.output.toLocaleString()}`], ["cost", `$${(u.cost ?? 0).toFixed(5)}`]] : []),
		["recorded", fmtBytes(r.bytes)],
	];
	const reply = (r.response?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
	setDetail(`Request #${r.id}`, `<h3>${esc(r.label)}</h3>
		<table class="dim" style="font-size:12px;margin:6px 0">${rows.map(([k, v]) => `<tr><td style="padding-right:10px;vertical-align:top">${k}</td><td style="color:var(--text)">${v}</td></tr>`).join("")}</table>
		${r.error ? `<div class="msg" style="border-color:var(--fail)"><pre>${esc(r.error)}</pre></div>` : ""}
		${reply ? `<h3 style="margin-top:10px">Reply</h3><div class="sum">${esc(reply)}</div>` : ""}
		<div class="kids"><button class="btn" data-full="1">Full request…</button></div>`);
}

// ---------------------------------------------------------------- the full request

const modal = $("#modal");
let modalTabs = [];
let modalText = "";
function highlight(json) {
	const s = esc(json);
	if (s.length > 1_500_000) return s;
	return s.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/g, (m, str, colon, lit, num) => {
		if (str) return colon ? `<span class="j-k">${str}</span>${colon}` : `<span class="j-s">${str}</span>`;
		if (lit) return `<span class="j-b">${lit}</span>`;
		return `<span class="j-n">${num}</span>`;
	});
}
/** A context as plain text, the way the model reads it: each message with its role, strings unescaped. */
function readable(context, response) {
	const out = [];
	const text = (content) => (typeof content === "string" ? content : (content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(""));
	const rule = (title) => out.push(`\n━━━━ ${title} ${"━".repeat(Math.max(4, 72 - title.length))}\n`);
	const assistant = (content) => {
		for (const b of content ?? []) {
			if (b.type === "text") out.push(b.text);
			else if (b.type === "thinking") out.push(`[thinking] ${b.thinking || "(encrypted)"}`);
			else if (b.type === "toolCall") out.push(`[call ${b.name}] ${JSON.stringify(b.arguments, null, 2)}`);
		}
	};
	if (context.systemPrompt) (rule("system prompt"), out.push(context.systemPrompt));
	for (const m of context.messages ?? []) {
		if (m.role === "system") {
			if (text(m.content)) (rule("system"), out.push(text(m.content)));
			for (const [k, v] of Object.entries(m.sections ?? {})) if (v != null) (rule(`system · ${k}`), out.push(v));
			if (m.toolsAdded?.length) {
				rule(`tools (${m.toolsAdded.length})`);
				for (const t of m.toolsAdded) out.push(`• ${t.name}: ${t.description}\n  ${JSON.stringify(t.parameters)}`);
			}
		} else if (m.role === "user") (rule("user"), out.push(text(m.content)));
		else if (m.role === "assistant") (rule("assistant"), assistant(m.content));
		else if (m.role === "toolResult") (rule(`tool result · ${m.toolName}${m.isError ? " (error)" : ""}`), out.push(text(m.content)));
	}
	if (response) (rule(`response · ${response.stopReason ?? ""}`), assistant(response.content));
	return out.join("\n").trimStart();
}

function showModalTab(k) {
	const tab = modalTabs[k];
	for (const [j, b] of [...$("#modal-tabs").children].entries()) b.classList.toggle("on", j === k);
	modalText = typeof tab.value === "string" ? tab.value : JSON.stringify(tab.value, null, 2);
	$("#modal-body").innerHTML = typeof tab.value === "string" ? esc(modalText) : highlight(modalText);
	$("#modal-body").scrollTop = 0;
	const dl = $("#modal-download");
	if (tab.href) {
		dl.href = tab.href;
		dl.removeAttribute("download");
		dl.setAttribute("download", "");
	} else {
		dl.href = URL.createObjectURL(new Blob([modalText], { type: "application/json" }));
		dl.setAttribute("download", tab.file ?? "optchat.json");
	}
}
async function openModal() {
	let title;
	let meta;
	if (S.mode === "request" && S.reqDetail) {
		const r = await api(`/api/request?id=${S.reqDetail.id}`);
		title = `Request #${r.id} — ${r.kind}`;
		meta = `${esc(r.provider)}/${esc(r.model)} · ${esc(r.api)} · ${fmtDate(r.started)} · ${esc(r.label)}`;
		const href = (part) => `/api/request/payload?id=${r.id}&part=${part}`;
		modalTabs = [
			...(r.payload != null ? [{ name: "Wire payload", value: r.payload, href: href("payload") }] : []),
			{ name: "Readable", value: readable(r.context, r.response), file: `optchat-request-${r.id}.txt` },
			{ name: "Context (provider-neutral)", value: r.context, href: href("context") },
			...(r.response ? [{ name: "Response", value: r.response, href: href("response") }] : []),
			{ name: "Settings", value: r.settings, file: `optchat-request-${r.id}-settings.json` },
		];
		if (r.payload == null) meta += ` · <span style="color:#ffb4ae">no wire payload: the call failed before the provider built one</span>`;
	} else {
		if (S.mode !== "recon" || !S.recon) {
			if (S.cur < 0) return;
			S.mode = "recon";
			await loadRecon();
		}
		const c = S.recon;
		title = c.mode === "turn" ? "Rebuilt request — a turn's first call" : "Rebuilt request — a turn starting now";
		meta = esc(c.note);
		modalTabs = [
			{ name: "Readable", value: readable(c.context), file: `optchat-rebuilt-frame-${c.frame}.txt` },
			{ name: "Context (provider-neutral)", value: c.context, file: `optchat-rebuilt-frame-${c.frame}.json` },
		];
	}
	$("#modal-title").textContent = title;
	$("#modal-meta").innerHTML = meta;
	$("#modal-tabs").innerHTML = modalTabs.map((t) => `<button>${esc(t.name)}</button>`).join("");
	showModalTab(0);
	modal.showModal();
}
$("#modal-tabs").addEventListener("click", (ev) => {
	const b = ev.target.closest("button");
	if (b) showModalTab([...$("#modal-tabs").children].indexOf(b));
});
$("#modal-close").onclick = () => modal.close();
$("#modal-copy").onclick = async () => {
	await navigator.clipboard.writeText(modalText);
	$("#modal-copy").textContent = "Copied";
	setTimeout(() => ($("#modal-copy").textContent = "Copy"), 1200);
};
modal.addEventListener("click", (ev) => {
	if (ev.target === modal) modal.close();
});
$("#full").onclick = openModal;

// ---------------------------------------------------------------- the timeline

const tl = $("#tl");
const TL = { hover: -1, drag: false };

function tlX(k, W) {
	const n = S.frames.length;
	return n <= 1 ? W / 2 : 6 + (k / (n - 1)) * (W - 12);
}
function tlIndex(x, W) {
	const n = S.frames.length;
	return Math.round(((x - 6) / (W - 12)) * (n - 1));
}
/** Where a request falls on the timeline: between the frames around its start. */
function reqX(r, W) {
	const k = lowerBound(S.times, r.started);
	if (k <= 0) return tlX(0, W);
	if (k >= S.frames.length) return tlX(S.frames.length - 1, W);
	const t0 = S.times[k - 1];
	const t1 = S.times[k];
	const f = t1 > t0 ? (r.started - t0) / (t1 - t0) : 0;
	return tlX(k - 1 + f, W);
}

function drawTimeline() {
	const dpr = window.devicePixelRatio || 1;
	const W = tl.clientWidth;
	const H = tl.clientHeight;
	if (tl.width !== Math.round(W * dpr) || tl.height !== Math.round(H * dpr)) {
		tl.width = Math.round(W * dpr);
		tl.height = Math.round(H * dpr);
	}
	const g = tl.getContext("2d");
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, W, H);
	const n = S.frames.length;
	if (n === 0) return;
	const cur = S.cur < 0 ? 6 : tlX(S.cur, W);
	g.fillStyle = "rgba(122,162,255,0.07)";
	g.fillRect(0, 0, cur, H);
	for (let k = 0; k < n; k++) {
		const f = S.frames[k];
		const x = Math.round(tlX(k, W)) + 0.5;
		if (f.fail) {
			g.fillStyle = "rgba(248,81,73,0.85)";
			g.fillRect(x - 1, H - 14, 3, 12);
		}
		if (f.turn) {
			g.strokeStyle = "rgba(210,168,255,0.85)";
			g.beginPath();
			g.moveTo(x, 13);
			g.lineTo(x, H - 2);
			g.stroke();
		}
		if (f.msgs) {
			const user = f.msgs.kinds.includes("user");
			g.strokeStyle = user ? KIND.user : "rgba(160,175,195,0.45)";
			g.beginPath();
			g.moveTo(x, H - 2);
			g.lineTo(x, H - (user ? 26 : 12));
			g.stroke();
		}
		if (f.built) {
			g.fillStyle = levelColor(Math.max(...f.built.map((b) => Number(b.key.split("/")[0]))), 0.8);
			g.fillRect(x - 0.5, H - 6 - Math.min(14, f.built.length * 3), 2, 3);
		}
	}
	for (const r of S.reqs) {
		const x = reqX(r, W);
		const sel = r.id === S.selReq;
		g.fillStyle = r.error ? "#f85149" : r.kind === "turn" ? "#d2a8ff" : "#ff9f43";
		g.beginPath();
		g.arc(x, 6, sel ? 4 : 2, 0, Math.PI * 2);
		g.fill();
		if (sel) {
			g.strokeStyle = "#fff";
			g.stroke();
		}
	}
	if (TL.hover >= 0) {
		g.strokeStyle = "rgba(255,255,255,0.25)";
		const x = Math.round(tlX(TL.hover, W)) + 0.5;
		g.beginPath();
		g.moveTo(x, 0);
		g.lineTo(x, H);
		g.stroke();
	}
	g.fillStyle = "#fff";
	g.fillRect(Math.round(cur) - 1, 0, 2, H);
	g.beginPath();
	g.moveTo(cur - 5, 0);
	g.lineTo(cur + 5, 0);
	g.lineTo(cur, 6);
	g.fill();
}

function tlSeek(ev) {
	const r = tl.getBoundingClientRect();
	const k = tlIndex(ev.clientX - r.left, r.width);
	seek(Math.max(0, Math.min(S.frames.length - 1, k)));
}
tl.addEventListener("mousedown", (ev) => {
	play(false);
	TL.drag = true;
	tlSeek(ev);
});
window.addEventListener("mouseup", () => (TL.drag = false));
tl.addEventListener("mousemove", (ev) => {
	const r = tl.getBoundingClientRect();
	const x = ev.clientX - r.left;
	if (TL.drag) tlSeek(ev);
	const k = Math.max(0, Math.min(S.frames.length - 1, tlIndex(x, r.width)));
	TL.hover = k;
	drawTimeline();
	const near = S.reqs.filter((q) => Math.abs(reqX(q, r.width) - x) < 4 && ev.clientY - r.top < 14);
	const f = S.frames[k];
	if (!f) return hideTip();
	showTip(
		near.length
			? near.slice(0, 6).map((q) => `<div class="t"><span class="badge ${q.kind}">${q.kind}</span> #${q.id}</div><div class="s">${fmtDate(q.started)} · ${esc(q.label)}</div>`).join("") + `<div class="s">click to open</div>`
			: `<div class="t">${fmtDate(f.t)}</div><div class="s">commit ${k + 1} of ${S.frames.length}</div><div>${esc(describe(f))}</div>`,
		ev,
	);
	tl.dataset.req = near.length ? String(near.at(-1).id) : "";
});
tl.addEventListener("click", () => {
	if (tl.dataset.req) selectRequest(Number(tl.dataset.req), { seek: true });
});
tl.addEventListener("mouseleave", () => {
	TL.hover = -1;
	drawTimeline();
	hideTip();
});

// ---------------------------------------------------------------- controls

$("#b-play").onclick = () => play(!S.playing);
$("#b-start").onclick = () => (play(false), seek(-1));
$("#b-end").onclick = () => (play(false), seek(S.frames.length - 1));
$("#b-back").onclick = () => (play(false), seek(S.cur - 1));
$("#b-fwd").onclick = () => (play(false), seek(S.cur + 1, true));
$("#speed").onchange = (ev) => (S.speed = Number(ev.target.value));
window.addEventListener("keydown", (ev) => {
	if (ev.target.closest?.("input,select,textarea") || modal.open) return;
	if (ev.key === " ") (ev.preventDefault(), play(!S.playing));
	else if (ev.key === "ArrowRight") (play(false), seek(S.cur + (ev.shiftKey ? 10 : 1), !ev.shiftKey));
	else if (ev.key === "ArrowLeft") (play(false), seek(S.cur - (ev.shiftKey ? 10 : 1)));
	else if (ev.key === "Home") (play(false), seek(-1));
	else if (ev.key === "End") (play(false), seek(S.frames.length - 1));
});

// ---------------------------------------------------------------- header

function renderChips(s) {
	const chips = [
		`<b>${s.count.toLocaleString()}</b> messages`,
		`<b>${s.nodes.toLocaleString()}</b> tree nodes`,
		`view <b>${s.view.parts}</b> lines · ${fmtBytes(s.view.bytes)}`,
		`compactions <b>${s.usage.calls.toLocaleString()}</b> calls · $${s.usage.cost.toFixed(3)}`,
		...(s.pending.length ? [`<b>${s.pending.length}</b> building`] : []),
		`turns: <b>${esc(s.config.model ?? "pi default")}</b>`,
		`compactor: <b>${esc(s.compactor ? `${s.compactor.provider}/${s.compactor.modelId}` : s.config.compactor ?? "same")}</b>`,
	].map((c) => `<span class="chip">${c}</span>`);
	if (s.failed.length) chips.push(`<span class="chip warn">${s.failed.length} failed, waiting</span>`);
	$("#chips").innerHTML = chips.join("");
	$("#home").textContent = s.home;
	document.title = `optchat · ${s.home.split(/[\\/]/).pop()}`;
}

// ---------------------------------------------------------------- polling

async function pollHistory() {
	const wasEnd = atEnd();
	const h = await api(`/api/history?from=${Math.max(0, S.frames.length - 1)}`);
	const grew = h.from + h.frames.length > S.frames.length;
	ingest(h.from, h.frames);
	S.pending = h.pending;
	if (grew) {
		if (wasEnd && S.cur >= 0) catchUp();
		drawTimeline();
		updateLabel();
	}
	dirtyTree();
}

async function pollRequests() {
	const after = S.reqs.at(-1)?.id ?? 0;
	const again = S.reqs.filter((r) => r.ended == null).map((r) => r.id);
	const { requests } = await api(`/api/requests?after=${after}${again.length ? `&again=${again.join(",")}` : ""}`);
	if (requests.length === 0) return;
	for (const r of requests) {
		if (S.reqById.has(r.id)) Object.assign(S.reqById.get(r.id), r);
		else {
			S.reqById.set(r.id, r);
			S.reqs.push(r);
		}
		if (r.id === S.selReq && r.ended != null && S.reqDetail?.ended == null) selectRequest(r.id, { quiet: true });
	}
	renderRequests();
	drawTimeline();
	if (S.mode !== "request") renderContext();
}

async function pollState() {
	S.server = await api("/api/state");
	renderChips(S.server);
}

let failures = 0;
async function poll() {
	try {
		await pollHistory();
		await pollRequests();
		failures = 0;
		$("#live").className = "on";
		$("#live-text").textContent = "live";
	} catch {
		failures++;
		$("#live").className = "err";
		$("#live-text").textContent = "disconnected";
	}
	setTimeout(poll, failures ? Math.min(10_000, 1500 * failures) : 1500);
}
setInterval(() => pollState().catch(() => {}), 5000);

// ---------------------------------------------------------------- start

new ResizeObserver(() => {
	dirtyTree();
	drawTimeline();
	renderContext();
}).observe(document.body);

async function start() {
	renderTreeLegend();
	await pollState();
	const h = await api("/api/history?from=0");
	ingest(0, h.frames);
	S.pending = h.pending;
	await pollRequests().catch(() => {});
	seek(S.frames.length - 1);
	renderRequests();
	renderContext();
	requestAnimationFrame(treeLoop);
	if (S.frames.length > 1) $("#tl-what").textContent = "This is the memory now. Press ▶ (space) to replay how it was built, or drag along the timeline.";
	setTimeout(poll, 1500);
}
start().catch((e) => {
	document.body.insertAdjacentHTML("afterbegin", `<div style="padding:12px;background:#5a1d1d">Could not load: ${esc(e.message ?? e)}</div>`);
});
