/** Best-effort, process-local cache-writer coordination, never summary-result deduplication.
 * Only hashes live here. A cold prefix has one writer until prefill finishes; other tasks still make their own calls.
 * Waits and leases are bounded: a missing provider event, failed writer or ignored abort must not stall the tree.
 */
export type CacheFlight = { ready(): void; end(success: boolean): void };
const FREE: CacheFlight = { ready() {}, end() {} };
type Entry = { ready: boolean; until: number; released: Promise<void> };

export class CacheFlights {
	readonly #entries = new Map<string, Entry>();
	readonly #waitMs: number;
	readonly #warmMs: number;
	readonly #maxEntries: number;
	readonly #now: () => number;

	constructor(options: { waitMs?: number; warmMs?: number; maxEntries?: number; now?: () => number } = {}) {
		this.#waitMs = options.waitMs ?? 10_000;
		// A scheduling hint, not a claim about the provider's actual TTL or a cache-hit guarantee.
		this.#warmMs = options.warmMs ?? 60_000;
		this.#maxEntries = options.maxEntries ?? 512;
		this.#now = options.now ?? (() => performance.now());
	}

	get size(): number { return this.#entries.size; }

	async acquire(keys: readonly string[], signal?: AbortSignal): Promise<CacheFlight> {
		const deadline = this.#now() + this.#waitMs;
		for (;;) {
			signal?.throwIfAborted();
			const now = this.#now();
			for (const [key, entry] of this.#entries) if (entry.ready && entry.until <= now) this.#entries.delete(key);
			const last = keys.at(-1);
			if (last === undefined || now >= deadline) return FREE;
			const hit = keys.findLastIndex(key => this.#entries.has(key));
			const entry = hit < 0 ? undefined : this.#entries.get(keys[hit]!);
			if (entry !== undefined && !entry.ready) {
				if (!await wait(entry.released, deadline - now, signal)) return FREE;
				continue;
			}
			if (entry !== undefined && hit === keys.length - 1) return FREE;
			// Evict old warm hints, never an active writer. Under pressure simply stop coordinating.
			if (this.#entries.size >= this.#maxEntries) {
				for (const [key, cached] of this.#entries) if (cached.ready) { this.#entries.delete(key); break; }
				if (this.#entries.size >= this.#maxEntries) return FREE;
			}
			return this.#lead(last, signal);
		}
	}

	#lead(key: string, signal?: AbortSignal): CacheFlight {
		let release!: () => void;
		const entry: Entry = { ready: false, until: 0, released: new Promise(resolve => { release = resolve; }) };
		this.#entries.set(key, entry);
		let finished = false;
		const finish = (success: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			if (this.#entries.get(key) === entry) {
				if (success) { entry.ready = true; entry.until = this.#now() + this.#warmMs; }
				else this.#entries.delete(key);
			}
			release();
		};
		const aborted = () => finish(false);
		const timer = setTimeout(aborted, this.#waitMs);
		signal?.addEventListener("abort", aborted, { once: true });
		if (signal?.aborted) aborted();
		return {
			ready: () => finish(true),
			end: (success) => {
				finish(success);
				// A later stream failure invalidates our own warm hint, never a replacement writer's entry.
				if (!success && this.#entries.get(key) === entry) this.#entries.delete(key);
			},
		};
	}
}

/** Abort only this waiter, never the writer it is waiting on. Clean every listener/timer on every outcome. */
function wait(released: Promise<void>, ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const done = (ready: boolean) => { cleanup(); resolve(ready); };
		const aborted = () => { cleanup(); reject(signal!.reason); };
		const timer = setTimeout(() => done(false), Math.max(0, ms));
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); };
		signal?.addEventListener("abort", aborted, { once: true });
		if (signal?.aborted) aborted();
		else void released.then(() => done(true));
	});
}
