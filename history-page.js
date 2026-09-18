const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_TEXT_BYTES = 50 * 1024;

/** Sanitized transcript of the branch, NOT reconstructed model context.
 * Compaction retainedTail is deliberately not expanded: its original messages
 * are already on the ancestor path. No abandoned branches are spliced in.
 */
export function buildHistoryPage(entries, { source = "runtime-branch", complete = true, leafId = null, since, last = 100 } = {}) {
  if (!Number.isInteger(last) || last < 1 || last > 1000) throw new Error("Invalid history limit");
  const messages = [];
  let truncated = false;
  for (const entry of entries) {
    let raw = entry.type === "message" ? entry.message : null;
    if (["compaction", "branch_summary"].includes(entry.type)) raw = {
      role: "assistant", content: `[${entry.type} summary]\n${entry.summary || ""}`, stopReason: "summary",
    };
    if (!raw || !["user", "assistant", "toolResult"].includes(raw.role)) continue;
    const content = typeof raw.content === "string" ? raw.content : (raw.content || [])
      .filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\n");
    let text = raw.role === "assistant" && raw.stopReason === "error" && !content ? `Error: ${raw.errorMessage || "provider error"}` : content;
    const bytes = encoder.encode(text);
    if (bytes.length > MAX_TEXT_BYTES) { text = decoder.decode(bytes.slice(0, MAX_TEXT_BYTES)) + "\n[truncated]"; truncated = true; }
    const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : Date.parse(entry.timestamp);
    messages.push({ role: raw.role, text, ...(entry.id ? { entryId: entry.id } : {}),
      ...(Number.isFinite(timestamp) ? { timestamp } : {}),
      ...(raw.role === "assistant" && raw.stopReason ? { stopReason: raw.stopReason } : {}),
      ...(raw.role === "toolResult" ? { toolName: raw.toolName || "tool", isError: !!raw.isError } : {}),
    });
  }
  let start = Math.max(0, messages.length - last);
  if (since !== undefined) {
    const index = messages.findIndex(m => m.entryId === since);
    if (index < 0) throw Object.assign(new Error("Cursor is absent from this branch; refresh history without --since"), { code: "cursor_not_found" });
    start = index + 1;
  }
  const page = [];
  let bytes = 0;
  for (const message of messages.slice(start, start + last)) {
    const size = encoder.encode(JSON.stringify(message)).length;
    if (bytes + size > 1024 * 1024) break;
    bytes += size; page.push(message);
  }
  const hasMore = start + page.length < messages.length;
  return { source, sanitized: true, complete: complete && !truncated && start === 0 && !hasMore,
    truncated: truncated || !complete, leafId, nextCursor: page.at(-1)?.entryId || null, hasMore, messages: page };
}

/** Pi restores its persisted leaf to the last entry. An in-memory navigation
 * without an append is not persisted; only the live runner can report that leaf.
 */
export function selectPersistedBranch(entries, tree = true) {
  if (!tree) return { entries, complete: true, leafId: entries.at(-1)?.id || null };
  const index = new Map();
  let complete = true;
  for (const entry of entries) {
    if (typeof entry.id !== "string" || index.has(entry.id)) { complete = false; continue; }
    index.set(entry.id, entry);
  }
  const leafId = entries.at(-1)?.id || null;
  const branch = [];
  const seen = new Set();
  let id = leafId;
  while (id !== null) {
    const entry = index.get(id);
    if (!entry || seen.has(id)) { complete = false; break; }
    seen.add(id); branch.push(entry);
    if (entry.parentId !== null && typeof entry.parentId !== "string") { complete = false; break; }
    id = entry.parentId;
  }
  return { entries: branch.reverse(), complete, leafId };
}
