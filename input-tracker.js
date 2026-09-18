// Pi's fire-and-forget sendUserMessage API has no input IDs or acceptance result.
// A visible correlation marker survives queue reordering; never guess by FIFO/text.
export function createInputTracker({ pi, getContext, configuring, emit }) {
  const records = new Map();
  const active = new Set();
  let lastStopReason;
  const marker = id => `[toilet-pi input ${id}]`;
  function inputIdFor(message) {
    if (message.role !== "user") return null;
    const text = typeof message.content === "string" ? message.content :
      (message.content || []).filter(p => p.type === "text").map(p => p.text).join("\n");
    const id = text.match(/^\[toilet-pi input ([a-zA-Z0-9_-]+)\]\n/)?.[1];
    return id && records.has(id) ? id : null;
  }
  function publish(id, state) {
    const record = records.get(id);
    if (!record) return;
    record.state = state;
    emit({ type: "input_status", input: { inputId: id, sessionGuid: record.sessionGuid, state, updatedAt: Date.now() } });
  }
  return {
    inputIdFor,
    pending: () => [...records.values()].some(r => ["submitted", "running"].includes(r.state)),
    dispatch(command) {
      const ctx = getContext();
      if (!ctx || ctx.sessionManager.getSessionId() !== command.sessionGuid) return;
      if (records.has(command.inputId)) return; // defense in depth; broker owns idempotency
      if (records.size >= 1024) {
        for (const [id, r] of records) if (!["submitted", "running"].includes(r.state)) records.delete(id);
      }
      records.set(command.inputId, { sessionGuid: command.sessionGuid, state: "submitted" });
      if (records.size > 1024 || configuring() || (command.mode === "prompt" && (!ctx.isIdle() || ctx.hasPendingMessages() || active.size ||
          [...records.entries()].some(([id, r]) => id !== command.inputId && ["submitted", "running"].includes(r.state))))) {
        publish(command.inputId, "failed");
        return;
      }
      publish(command.inputId, "submitted");
      try {
        pi.sendUserMessage(`${marker(command.inputId)}\n${command.text}`, {
          ...(command.mode !== "prompt" ? { deliverAs: command.mode } : {}), expandPromptTemplates: false,
        });
      } catch { publish(command.inputId, "failed"); }
    },
    messageStart(message) {
      const id = inputIdFor(message);
      if (!id || records.get(id)?.state !== "submitted") return;
      if (!active.size) lastStopReason = undefined;
      active.add(id);
      publish(id, "running");
    },
    messageEnd(message) {
      if (message.role === "assistant" && active.size) lastStopReason = message.stopReason;
    },
    settled() {
      const ctx = getContext();
      if (!ctx?.isIdle() || ctx.hasPendingMessages()) return;
      for (const id of active) publish(id, lastStopReason === "error" ? "failed" : lastStopReason === "aborted" ? "aborted" : lastStopReason ? "settled" : "unknown");
      active.clear();
      // Dropped/transformed/handled inputs are NOT proof of execution.
      for (const [id, r] of records) if (r.state === "submitted") publish(id, "unknown");
    },
    invalidate() {
      for (const [id, r] of records) if (["submitted", "running"].includes(r.state)) publish(id, "unknown");
      active.clear(); lastStopReason = undefined;
    },
    reset() { records.clear(); active.clear(); lastStopReason = undefined; },
  };
}
