// Runtime-independent model control. Pi API access is injected so tests never
// start a real agent, read credentials, or make provider calls.
const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

class ControlError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function failure(code, message) {
  return new ControlError(code, message);
}

export function createModelController({ pi, getContext, loadThinkingLevels, hasPendingInput = () => false }) {
  let configuring = false;

  function configuration() {
    const ctx = getContext();
    const level = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : ctx?.thinkingLevel;
    return {
      provider: ctx?.model?.provider || null,
      modelId: ctx?.model?.id || null,
      thinkingLevel: LEVELS.has(level) ? level : null,
    };
  }

  function checkContext(ctx, sessionGuid) {
    if (!ctx || getContext() !== ctx || ctx.sessionManager.getSessionId() !== sessionGuid) {
      throw failure("session_changed", "Session changed; inspect state before retrying");
    }
  }

  function checkIdle(ctx) {
    if (!ctx.isIdle() || ctx.hasPendingMessages() || hasPendingInput()) {
      throw failure("busy", "Session is busy or has queued input; wait or abort first");
    }
  }

  async function run(request) {
    const reply = { type: "session_response", requestId: request.requestId, sessionGuid: request.sessionGuid };
    let ownsLock = false;
    let mutationStarted = false;
    try {
      const ctx = getContext();
      checkContext(ctx, request.sessionGuid);
      if (configuring) throw failure("busy", "Session is being configured");
      if (request.operation === "get_config") {
        return { ...reply, success: true, data: { configuration: configuration() } };
      }
      if (!["get_models", "configure"].includes(request.operation)) {
        throw failure("unsupported", "Unknown session operation");
      }
      if (request.operation === "configure") {
        checkIdle(ctx);
        configuring = ownsLock = true;
        if (typeof pi.setModel !== "function" || typeof pi.setThinkingLevel !== "function") {
          throw failure("unsupported", "This runtime cannot configure model/thinking through the extension API");
        }
      }
      if (typeof ctx.modelRegistry?.getAvailable !== "function") {
        throw failure("unsupported", "This runtime cannot enumerate available models");
      }
      let levelsFor;
      try {
        levelsFor = await loadThinkingLevels();
      } catch {
        throw failure("unsupported", "Runtime thinking-level enumeration is unavailable; a compatible Pi API is required");
      }
      if (typeof levelsFor !== "function") throw failure("unsupported", "Runtime does not expose supported thinking levels");
      const available = await ctx.modelRegistry.getAvailable();
      checkContext(ctx, request.sessionGuid);
      const models = available.map(model => {
        const levels = levelsFor(model);
        if (!Array.isArray(levels) || !levels.length || !levels.every(level => LEVELS.has(level))) {
          throw failure("unsupported", "Runtime returned unsupported thinking-level metadata");
        }
        // Explicit projection: model objects can contain authentication headers.
        return { provider: model.provider, id: model.id, name: model.name || model.id, thinkingLevels: levels };
      });
      if (request.operation === "get_models") {
        return { ...reply, success: true, data: { configuration: configuration(), models } };
      }
      checkIdle(ctx);
      const hasModel = request.provider !== undefined || request.modelId !== undefined;
      if ((!hasModel && request.thinkingLevel === undefined) ||
          (hasModel && (!request.provider || !request.modelId))) {
        throw failure("invalid_selection", "Specify provider/model together, a thinking level, or both");
      }
      const target = hasModel
        ? available.find(model => model.provider === request.provider && model.id === request.modelId)
        : ctx.model;
      if (!target) throw failure("unavailable_model", "Model is not available in this session's runtime");
      if (request.thinkingLevel !== undefined && !levelsFor(target).includes(request.thinkingLevel)) {
        throw failure("unsupported_level", `Thinking level ${request.thinkingLevel} is not supported by ${target.provider}/${target.id}`);
      }
      // Both selections are validated before the first mutation. This is a
      // serialized remote operation, NOT a transaction in the native Pi API.
      if (hasModel) {
        mutationStarted = true;
        if (await pi.setModel(target) === false) throw failure("unavailable_model", "Runtime refused the model (authentication may be unavailable)");
        checkContext(ctx, request.sessionGuid);
        checkIdle(ctx);
      }
      if (request.thinkingLevel !== undefined) {
        mutationStarted = true;
        pi.setThinkingLevel(request.thinkingLevel);
      }
      const effective = configuration();
      if (effective.provider !== target.provider || effective.modelId !== target.id ||
          (request.thinkingLevel !== undefined && effective.thinkingLevel !== request.thinkingLevel)) {
        throw failure("configuration_changed", "Runtime did not retain the requested configuration");
      }
      return { ...reply, success: true, data: { configuration: effective } };
    } catch (error) {
      const known = error instanceof ControlError;
      const message = known ? error.message : "Runtime model operation failed";
      return { ...reply, success: false, error: {
        code: known ? error.code : "runtime_error",
        message: mutationStarted ? `${message}; configuration may have changed. Inspect state before retrying.` : message,
      } };
    } finally {
      if (ownsLock) configuring = false;
    }
  }

  return { run, configuration, isConfiguring: () => configuring };
}
