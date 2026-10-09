/**
 * What the home directory adds to the agent, never from pi's global directories:
 *
 * - `.env`: KEY=VALUE lines put into the process environment, for tools, skills and extensions.
 * - `skills/<name>/SKILL.md`: pi-format skills, listed in the prompt; the model reads one when a task matches.
 * - `extensions/*.ts` (or `*.js`, or a directory with `index.ts`): pi-durable extensions, as a default export that
 *   is an `Extension`, or a function given a kit of durable's helpers that returns one.
 *
 * `Home` loads them at start and reloads them in place: on the agent's `reload` tool, and when a file changes.
 */

import { existsSync, type FSWatcher, watch } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import {
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	hook,
	type PromptSection,
	type Registry,
	section,
	wrapSection,
	wrapTool,
} from "@earendil-works/pi-durable";

/** Parse a .env file: KEY=VALUE per line, optional quotes, # comments, `export` prefix allowed. */
export function parseEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (m === null) continue;
		let value = m[2]!.trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			const quote = value[0];
			value = value.slice(1, -1);
			if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
		} else {
			const hash = value.indexOf(" #");
			if (hash >= 0) value = value.slice(0, hash).trim();
		}
		out[m[1]!] = value;
	}
	return out;
}

/**
 * Load `<home>/.env` into the process environment. Variables the process already had win; `owned` names the ones an
 * earlier load set, which a reload may change or remove. Returns the names now set from the file.
 */
export async function loadEnv(home: string, owned: Set<string> = new Set()): Promise<string[]> {
	let text = "";
	try {
		text = await readFile(join(home, ".env"), "utf8");
	} catch {
		// no file: the variables it set before go away
	}
	const values = parseEnv(text);
	for (const name of owned) if (!(name in values)) delete process.env[name];
	const loaded: string[] = [];
	for (const [name, value] of Object.entries(values)) {
		if (process.env[name] !== undefined && !owned.has(name)) continue;
		process.env[name] = value;
		owned.add(name);
		loaded.push(name);
	}
	for (const name of [...owned]) if (!(name in values)) owned.delete(name);
	return loaded;
}

/** The skills of `<home>/skills` as one prompt section, in pi's format; undefined when there are none. */
export function loadSkillSection(home: string, report: (error: unknown) => void): PromptSection | undefined {
	const dir = join(home, "skills");
	if (!existsSync(dir)) return undefined;
	const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "home" });
	for (const diagnostic of diagnostics) report(new Error(`skills: ${String((diagnostic as { message?: string }).message ?? diagnostic)}`));
	const text = formatSkillsForPrompt(skills, "read").trim();
	if (text === "") return undefined;
	return section("skills", () => text, { tag: false });
}

/** What an extension file's default export may use without importing anything. */
export const kit = {
	Type,
	defineExtension,
	defineTool,
	defineTask,
	defineDoc,
	defineDocFamily,
	section,
	hook,
	wrapTool,
	wrapSection,
};

export type ExtensionKit = typeof kit & { readonly home: string; readonly env: NodeJS.ProcessEnv };

async function extensionFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	for (const name of (await readdir(dir)).sort()) {
		if (name.startsWith(".") || name.startsWith("_")) continue;
		const path = join(dir, name);
		const info = await stat(path);
		if (info.isDirectory()) {
			for (const entry of ["index.ts", "index.js", "index.mjs"]) if (existsSync(join(path, entry))) files.push(join(path, entry));
		} else if (/\.(ts|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) files.push(path);
	}
	return files;
}

function isExtension(value: unknown): value is Extension {
	return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

/** The newest contents of a directory tree, for telling a changed extension from an unchanged one. */
async function newest(path: string): Promise<number> {
	const info = await stat(path);
	if (!info.isDirectory()) return info.mtimeMs;
	let latest = info.mtimeMs;
	for (const name of await readdir(path)) latest = Math.max(latest, await newest(join(path, name)));
	return latest;
}

/**
 * The extensions of `<home>/extensions`, each loaded in a try so one broken file does not stop the agent. A file is
 * imported with its change time in the URL, so a reload sees the new code rather than Node's cached module.
 */
export async function loadExtensions(
	home: string,
	report: (error: unknown) => void,
): Promise<{ extensions: { file: string; extension: Extension }[]; errors: string[] }> {
	const dir = join(home, "extensions");
	const extensions: { file: string; extension: Extension }[] = [];
	const errors: string[] = [];
	if (!existsSync(dir)) return { extensions, errors };
	// Node reads the nearest package.json to know the files are ES modules; without one it warns and reparses.
	if (!existsSync(join(dir, "package.json"))) await writeFile(join(dir, "package.json"), '{ "type": "module" }\n', "utf8");
	for (const file of await extensionFiles(dir)) {
		try {
			const version = await newest(resolve(file, ".."));
			const url = `${pathToFileURL(resolve(file)).href}?v=${Math.round(version)}`;
			const module = (await import(url)) as { default?: unknown };
			let value = module.default;
			if (typeof value === "function") value = await (value as (k: ExtensionKit) => unknown)({ ...kit, home, env: process.env });
			if (!isExtension(value)) throw new Error("the default export is not an extension (an object with a name) or a function returning one");
			extensions.push({ file, extension: value });
		} catch (error) {
			const message = `extension ${relative(home, file)}: ${error instanceof Error ? error.message : String(error)}`;
			errors.push(message);
			report(new Error(message));
		}
	}
	return { extensions, errors };
}

export type Reload = {
	/** Names set from .env. */
	env: string[];
	/** Whether the prompt lists skills. */
	skills: boolean;
	/** The extensions installed, with their tools. */
	extensions: { name: string; tools: string[] }[];
	/** The extensions removed, by name. */
	removed: string[];
	errors: string[];
};

const SKILLS_EXTENSION = "home-skills";

/** The home's additions in a registry, loadable again in place. */
export class Home {
	readonly home: string;
	readonly #registry: Registry;
	readonly #report: (error: unknown) => void;
	readonly #env = new Set<string>();
	#installed = new Map<string, Extension>();
	#skills = false;
	#watcher: FSWatcher | undefined;
	#timer: NodeJS.Timeout | undefined;
	#reloading: Promise<Reload> | undefined;
	#onReload: ((result: Reload) => void) | undefined;

	constructor(home: string, registry: Registry, report: (error: unknown) => void) {
		this.home = home;
		this.#registry = registry;
		this.#report = report;
	}

	/** Load `.env` alone, early, so the model runtime sees provider keys kept there. */
	loadEnv(): Promise<string[]> {
		return loadEnv(this.home, this.#env);
	}

	/** Load everything; on a later call, replace what changed and remove what is gone. */
	reload(): Promise<Reload> {
		if (this.#reloading !== undefined) return this.#reloading;
		this.#reloading = this.#reload().finally(() => {
			this.#reloading = undefined;
		});
		return this.#reloading;
	}

	async #reload(): Promise<Reload> {
		const env = await loadEnv(this.home, this.#env);
		const errors: string[] = [];
		const skills = loadSkillSection(this.home, (error) => errors.push(error instanceof Error ? error.message : String(error)));
		if (skills !== undefined) {
			this.#registry.install(defineExtension({ name: SKILLS_EXTENSION, sections: [skills] }));
			this.#skills = true;
		} else if (this.#skills) {
			this.#registry.uninstall({ name: SKILLS_EXTENSION });
			this.#skills = false;
		}
		const loaded = await loadExtensions(this.home, () => {});
		errors.push(...loaded.errors);
		const next = new Map<string, Extension>();
		for (const { extension } of loaded.extensions) {
			if (next.has(extension.name)) {
				errors.push(`extension ${extension.name}: two files define it; the first one wins`);
				continue;
			}
			next.set(extension.name, extension);
			this.#registry.install(extension);
		}
		const removed: string[] = [];
		for (const [name, extension] of this.#installed) {
			if (next.has(name)) continue;
			this.#registry.uninstall(extension);
			removed.push(name);
		}
		this.#installed = next;
		const result: Reload = {
			env,
			skills: this.#skills,
			extensions: [...next.values()].map((e) => ({ name: e.name, tools: (e.tools ?? []).map((t) => t.name) })),
			removed,
			errors,
		};
		this.#onReload?.(result);
		return result;
	}

	/** Reload a moment after a file under skills/, extensions/ or .env changes. */
	watch(onReload?: (result: Reload) => void): void {
		this.#onReload = onReload;
		if (this.#watcher !== undefined) return;
		try {
			this.#watcher = watch(this.home, { recursive: true }, (_event, filename) => {
				const path = String(filename ?? "").split(sep).join("/");
				if (!(path === ".env" || path.startsWith("skills/") || path.startsWith("extensions/"))) return;
				if (this.#timer !== undefined) clearTimeout(this.#timer);
				this.#timer = setTimeout(() => {
					this.#timer = undefined;
					void this.reload().catch(this.#report);
				}, 500);
			});
			this.#watcher.on("error", (error) => this.#report(error));
			this.#watcher.unref();
		} catch (error) {
			this.#report(error);
		}
	}

	stop(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#watcher?.close();
		this.#watcher = undefined;
	}
}

/** How the agent extends itself: a prompt section, and the `reload` tool. */
export function selfExtension(home: Home): Extension {
	const text = `# Extending yourself

Your home directory is ${home.home}. You can add to yourself by writing files there with your write tool, then calling
reload(), which loads them in place and reports errors. Do this when the user asks for it, or when a task needs a
tool or a skill you lack: say so, and go ahead if the user agreed.

- skills/<name>/SKILL.md: instructions for a kind of task. Start with a frontmatter block (name, description), then
  the steps, commands and pitfalls. Skills are listed in your prompt and you read one when a task matches.
- extensions/<name>.ts: new tools. A file exports one default function and needs no imports:

  export default ({ defineExtension, defineTool, Type, env, home }) => defineExtension({
    name: "<name>",
    tools: [defineTool({
      name: "<tool>", description: "<what it does, for you>",
      parameters: Type.Object({ query: Type.String() }),
      execute: async (args) => ({ content: [{ type: "text", text: "<result>" }] }),
    })],
  });

  Tool names say what they do (web_search, not vendor_search). Use fetch for HTTP. Secrets go in .env as KEY=VALUE
  and are read as env.KEY; never write a secret into a file other than .env. The files under extensions/ are
  examples to read. An extension may import npm packages: install them first with bash, running
  "npm install <package>" inside extensions/, then import them at the top of the file as usual.

After reload(), new tools are available from your next step. A file with an error is skipped and the error reported.`;
	return defineExtension({
		name: "self",
		sections: [section("extending", () => text, { tag: false })],
		tools: [
			defineTool({
				name: "reload",
				description:
					"Load the home's .env, skills/ and extensions/ again, after you added or changed one. Reports what is installed and any errors.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => {
					const result = await home.reload();
					const lines = [
						`env: ${result.env.length === 0 ? "none" : result.env.join(", ")}`,
						`skills listed: ${result.skills ? "yes" : "no"}`,
						`extensions: ${result.extensions.length === 0 ? "none" : result.extensions.map((e) => `${e.name} [${e.tools.join(", ")}]`).join("; ")}`,
						...(result.removed.length === 0 ? [] : [`removed: ${result.removed.join(", ")}`]),
						...(result.errors.length === 0 ? [] : ["errors:", ...result.errors.map((e) => `  ${e}`)]),
					];
					return { content: [{ type: "text", text: lines.join("\n") }] };
				},
			}),
		],
	});
}
