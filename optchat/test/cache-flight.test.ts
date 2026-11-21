import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { CacheFlights } from "../src/optchat/cache-flight.ts";

const tick = () => sleep(0);

test("a cold prefix has one writer; readiness releases all followers without deduplicating their requests", async () => {
	const flights = new CacheFlights();
	const leader = await flights.acquire(["a"]);
	let sent = 0;
	const followers = Array.from({ length: 5 }, async () => { const f = await flights.acquire(["a"]); sent++; return f; });
	await tick();
	assert.equal(sent, 0);
	leader.ready();
	const handles = await Promise.all(followers);
	assert.equal(sent, 5);
	for (const f of handles) f.end(true);
	leader.end(true);
	assert.equal(flights.size, 1);
});

test("a growing prefix waits on its ancestor, then leads only its new suffix; unrelated prefixes are parallel", async () => {
	const flights = new CacheFlights();
	const a = await flights.acquire(["a"]);
	let bStarted = false;
	const pendingB = flights.acquire(["a", "b"]).then(f => { bStarted = true; return f; });
	const independent = await flights.acquire(["x"]);
	assert.equal(bStarted, false);
	a.ready();
	const b = await pendingB;
	let cStarted = false;
	const pendingC = flights.acquire(["a", "b", "c"]).then(f => { cStarted = true; return f; });
	await tick();
	assert.equal(cStarted, false);
	b.ready();
	const c = await pendingC;
	c.end(true); b.end(true); a.end(true); independent.end(true);
});

test("aborting a waiter does not cancel the writer and leaves no abort listeners", async () => {
	const flights = new CacheFlights();
	const leaderSignal = new AbortController();
	const waiterSignal = new AbortController();
	const leader = await flights.acquire(["a"], leaderSignal.signal);
	const pending = flights.acquire(["a"], waiterSignal.signal);
	const rejected = assert.rejects(pending, /stop waiter/);
	waiterSignal.abort(new Error("stop waiter"));
	await rejected;
	assert.equal(getEventListeners(waiterSignal.signal, "abort").length, 0);
	assert.equal(leaderSignal.signal.aborted, false);
	assert.equal(flights.size, 1);
	leader.end(false);
	assert.equal(getEventListeners(leaderSignal.signal, "abort").length, 0);
	assert.equal(flights.size, 0);
	await assert.rejects(flights.acquire(["a"], waiterSignal.signal), /stop waiter/);
});

for (const why of ["failure", "abort"] as const) test(`writer ${why} releases followers; stale callbacks cannot delete a replacement writer`, async () => {
	const flights = new CacheFlights();
	const abort = new AbortController();
	const first = await flights.acquire(["a"], abort.signal);
	const pending = flights.acquire(["a"]);
	if (why === "abort") abort.abort(); else first.end(false);
	const replacement = await pending;
	first.ready(); first.end(false);
	assert.equal(flights.size, 1);
	let started = false;
	const later = flights.acquire(["a"]).then(f => { started = true; return f; });
	await tick();
	assert.equal(started, false);
	replacement.ready();
	(await later).end(true); replacement.end(true);
	assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("a missing provider event/settlement cannot hold followers forever", async () => {
	const flights = new CacheFlights({ waitMs: 20 });
	const leader = await flights.acquire(["a"]);
	const follower = await flights.acquire(["a"], AbortSignal.timeout(1000));
	follower.end(true);
	leader.end(false);
	assert.ok(flights.size <= 1);
});

test("warm hints expire and later stream failures invalidate them", async () => {
	let now = 0;
	const flights = new CacheFlights({ warmMs: 10, now: () => now });
	const first = await flights.acquire(["a"]);
	first.ready(); first.end(true);
	now = 11;
	const second = await flights.acquire(["a"]);
	let started = false;
	const later = flights.acquire(["a"]).then(f => { started = true; return f; });
	await tick();
	assert.equal(started, false);
	second.ready(); (await later).end(true);
	second.end(false);
	assert.equal(flights.size, 0);
});

test("the map stays bounded, does not evict active writers, and bypasses empty prefixes", async () => {
	const flights = new CacheFlights({ maxEntries: 2 });
	const a = await flights.acquire(["a"]);
	const b = await flights.acquire(["b"]);
	const overflow = await flights.acquire(["c"]);
	const empty = await flights.acquire([]);
	assert.equal(flights.size, 2);
	overflow.ready(); overflow.end(true); empty.end(true);
	assert.equal(flights.size, 2);
	a.ready();
	const c = await flights.acquire(["c"]); // Evicts a warm hint, never b.
	assert.equal(flights.size, 2);
	let started = false;
	const waiting = flights.acquire(["b"]).then(f => { started = true; return f; });
	await tick(); assert.equal(started, false);
	b.ready(); (await waiting).end(true);
	b.end(true); c.end(true); a.end(true);
	assert.equal(flights.size, 2);
});
