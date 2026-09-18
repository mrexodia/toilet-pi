import assert from "node:assert/strict";
import test from "node:test";
import { createModelController } from "../model-control.js";

function fixture() {
  const models = [
    { provider: "test", id: "small", name: "Small", levels: ["off"], headers: { Authorization: "secret" } },
    { provider: "test", id: "large", name: "Large", levels: ["off", "high", "max"], baseUrl: "secret-url" },
  ];
  let level = "off";
  const calls = [];
  const ctx = {
    model: models[0], isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: { getAvailable: () => models },
    sessionManager: { getSessionId: () => "session" },
  };
  let currentContext = ctx;
  const pi = {
    getThinkingLevel: () => level,
    async setModel(model) { calls.push(["model", model.id]); ctx.model = model; return true; },
    setThinkingLevel(value) { calls.push(["thinking", value]); level = value; },
  };
  const options = { pi, getContext: () => currentContext, loadThinkingLevels: async () => model => model.levels };
  const controller = createModelController(options);
  const request = (operation, fields = {}) => controller.run({ requestId: "request", sessionGuid: "session", operation, ...fields });
  return { models, pi, ctx, options, calls, controller, request, replaceContext: () => { currentContext = { ...ctx }; } };
}

test("enumerates models and their exact levels together without exposing private metadata", async () => {
  const f = fixture();
  const response = await f.request("get_models");
  assert.equal(response.success, true);
  assert.deepEqual(response.data.models, [
    { provider: "test", id: "small", name: "Small", thinkingLevels: ["off"] },
    { provider: "test", id: "large", name: "Large", thinkingLevels: ["off", "high", "max"] },
  ]);
  assert.deepEqual(response.data.configuration, { provider: "test", modelId: "small", thinkingLevel: "off" });
  assert.deepEqual(f.calls, []);
});

test("validates model and thinking together before either mutation", async () => {
  const f = fixture();
  const response = await f.request("configure", { provider: "test", modelId: "large", thinkingLevel: "low" });
  assert.equal(response.error.code, "unsupported_level");
  assert.deepEqual(f.calls, []);
  assert.equal((await f.request("configure", { provider: "test", modelId: "missing" })).error.code, "unavailable_model");
  assert.deepEqual(f.calls, []);
});

test("sets a validated model/thinking pair and reports effective configuration", async () => {
  const f = fixture();
  const response = await f.request("configure", { provider: "test", modelId: "large", thinkingLevel: "max" });
  assert.equal(response.success, true);
  assert.deepEqual(f.calls, [["model", "large"], ["thinking", "max"]]);
  assert.deepEqual(response.data.configuration, { provider: "test", modelId: "large", thinkingLevel: "max" });
});

test("busy and queued sessions reject mutations but allow enumeration", async () => {
  const f = fixture();
  f.ctx.isIdle = () => false;
  assert.equal((await f.request("configure", { thinkingLevel: "off" })).error.code, "busy");
  assert.equal((await f.request("get_models")).success, true);
  f.ctx.isIdle = () => true;
  f.ctx.hasPendingMessages = () => true;
  assert.equal((await f.request("configure", { thinkingLevel: "off" })).error.code, "busy");
  assert.deepEqual(f.calls, []);
});

test("input accepted by the extension but not yet in Pi's queue blocks configuration", async () => {
  const f = fixture();
  const controller = createModelController({ ...f.options, hasPendingInput: () => true });
  const response = await controller.run({ requestId: "r", sessionGuid: "session", operation: "configure", thinkingLevel: "off" });
  assert.equal(response.error.code, "busy");
  assert.deepEqual(f.calls, []);
});

test("holds configuration lock through async model changes and rejects concurrent requests", async () => {
  const f = fixture();
  let release;
  const original = f.pi.setModel;
  f.pi.setModel = async model => { await new Promise(resolve => { release = resolve; }); return original(model); };
  const first = f.request("configure", { provider: "test", modelId: "large", thinkingLevel: "high" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.isConfiguring(), true);
  assert.equal((await f.request("configure", { thinkingLevel: "off" })).error.code, "busy");
  release();
  assert.equal((await first).success, true);
  assert.equal(f.controller.isConfiguring(), false);
});

test("a session switch during enumeration prevents configuration", async () => {
  const f = fixture();
  f.ctx.modelRegistry.getAvailable = async () => { f.replaceContext(); return f.models; };
  assert.equal((await f.request("configure", { thinkingLevel: "off" })).error.code, "session_changed");
  assert.deepEqual(f.calls, []);
});

test("missing capability helper is an explicit unsupported error without mutations", async () => {
  const f = fixture();
  const controller = createModelController({ ...f.options, loadThinkingLevels: async () => { throw new Error("not installed"); } });
  const response = await controller.run({ requestId: "x", sessionGuid: "session", operation: "get_models" });
  assert.equal(response.error.code, "unsupported");
  assert.deepEqual(f.calls, []);
});

test("errors do not leak provider credentials and partial changes are reported honestly", async () => {
  const f = fixture();
  f.pi.setThinkingLevel = () => { throw Object.assign(new Error("Authorization: secret"), { code: "HTTP_ERROR" }); };
  const response = await f.request("configure", { provider: "test", modelId: "large", thinkingLevel: "high" });
  assert.equal(response.success, false);
  assert.match(response.error.message, /configuration may have changed/);
  assert.doesNotMatch(response.error.message, /secret/);
  assert.equal(f.controller.configuration().modelId, "large");
  assert.equal(f.controller.isConfiguring(), false);
});

test("runtime refusal or clamping never reports successful requested configuration", async () => {
  const f = fixture();
  f.pi.setModel = async () => false;
  assert.equal((await f.request("configure", { provider: "test", modelId: "large" })).error.code, "unavailable_model");
  f.ctx.model = f.models[1];
  f.pi.setThinkingLevel = () => {};
  assert.equal((await f.request("configure", { thinkingLevel: "high" })).error.code, "configuration_changed");
});
