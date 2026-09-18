// Same correlated model-control API as the CLI. No implicit resume or retry.
export function createModelPicker({ root, send, getSession, notify, document = root.ownerDocument }) {
  let sessionId = null;
  let models = [];
  let configuration = null;
  let pending = null;
  let connected = false;
  const load = document.createElement("button");
  load.textContent = "Load models";
  load.type = "button";
  const model = document.createElement("select");
  model.setAttribute("aria-label", "Session model");
  const thinking = document.createElement("select");
  thinking.setAttribute("aria-label", "Session thinking level");
  const apply = document.createElement("button");
  apply.textContent = "Apply to session";
  apply.type = "button";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  root.append(load, model, thinking, apply, status);
  function cancel() { if (pending) clearTimeout(pending.timer); pending = null; }
  function levels() {
    thinking.replaceChildren();
    const selected = models[Number(model.value)];
    for (const level of selected?.thinkingLevels || []) {
      const option = document.createElement("option");
      option.value = level; option.textContent = level;
      thinking.append(option);
    }
    if (selected?.thinkingLevels.includes(configuration?.thinkingLevel)) thinking.value = configuration.thinkingLevel;
  }
  function renderModels() {
    model.replaceChildren();
    models.forEach((m, i) => {
      const option = document.createElement("option");
      option.value = String(i); option.textContent = `${m.provider}/${m.id}`;
      model.append(option);
    });
    const selected = models.findIndex(m => m.provider === configuration?.provider && m.id === configuration?.modelId);
    if (selected >= 0) model.value = String(selected);
    levels();
  }
  function sync(isConnected) {
    connected = isConnected;
    const session = getSession();
    if (session.sessionGuid !== sessionId) {
      cancel(); sessionId = session.sessionGuid; models = []; configuration = session.configuration;
      renderModels(); status.textContent = "";
    }
    if (!connected && pending) { cancel(); status.textContent = "Disconnected; outcome unknown. Reload models before retrying."; models = []; renderModels(); }
    if (session.configuration && JSON.stringify(configuration) !== JSON.stringify(session.configuration)) {
      configuration = session.configuration; renderModels();
    }
    const unavailable = !connected || !sessionId || !session.owner || !!pending;
    load.disabled = unavailable;
    model.disabled = unavailable || !models.length || session.busy || !!session.queuedInputs?.length;
    thinking.disabled = model.disabled;
    apply.disabled = model.disabled;
  }
  function request(operation, selection = {}) {
    if (pending || !sessionId || !connected) return;
    const requestId = crypto.randomUUID();
    pending = { requestId, sessionGuid: sessionId, timer: setTimeout(() => {
      pending = null; models = []; renderModels(); status.textContent = "Timed out; outcome unknown. Reload models before retrying."; sync(connected);
    }, 20000) };
    status.textContent = operation === "configure" ? "Applying…" : "Loading…";
    if (!send({ type: "session_request", requestId, sessionGuid: sessionId, operation, ...selection })) {
      cancel(); status.textContent = "Not connected";
    }
    sync(connected);
  }
  load.addEventListener("click", () => request("get_models"));
  model.addEventListener("change", levels);
  apply.addEventListener("click", () => {
    const selected = models[Number(model.value)];
    if (!selected || apply.disabled) return;
    request("configure", { provider: selected.provider, modelId: selected.id, thinkingLevel: thinking.value });
  });
  function receive(message) {
    if (message.type !== "session_response" || !pending || message.requestId !== pending.requestId || message.sessionGuid !== pending.sessionGuid) return;
    cancel();
    if (message.sessionGuid !== getSession().sessionGuid) return;
    if (message.success) {
      configuration = message.data.configuration;
      getSession().configuration = configuration;
      getSession().model = configuration.modelId;
      if (message.data.models) models = message.data.models;
      renderModels(); status.textContent = `Current: ${configuration.provider}/${configuration.modelId} (${configuration.thinkingLevel})`;
    } else {
      status.textContent = message.error?.message || "Model request failed";
      notify(status.textContent, "error");
      models = []; renderModels();
    }
    sync(connected);
  }
  return { sync, receive, dispose: cancel };
}
