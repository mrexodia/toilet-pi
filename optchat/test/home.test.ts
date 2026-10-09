// What the home directory adds: .env, skills, extensions, and reloading them in place.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { Home, loadEnv, loadExtensions, loadSkillSection, parseEnv, selfExtension } from "../src/home.ts";

let home: string;
before(async () => {
	home = await mkdtemp(join(tmpdir(), "optchat-home-"));
});
after(async () => {
	await rm(home, { recursive: true, force: true }).catch(() => {});
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(".env is parsed and loaded without overriding the environment", async () => {
	assert.deepEqual(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x#y\'\nD=plain # note\nbad line\n'), {
		A: "1",
		B: "two words",
		C: "x#y",
		D: "plain",
	});
	await writeFile(join(home, ".env"), "OPTCHAT_TEST_KEY=secret\nPATH=should-not-win\n");
	const owned = new Set<string>();
	assert.deepEqual(await loadEnv(home, owned), ["OPTCHAT_TEST_KEY"]);
	assert.equal(process.env.OPTCHAT_TEST_KEY, "secret");
	assert.notEqual(process.env.PATH, "should-not-win");
	// a reload changes what it owns and drops what is gone
	await writeFile(join(home, ".env"), "OPTCHAT_TEST_KEY=changed\n");
	assert.deepEqual(await loadEnv(home, owned), ["OPTCHAT_TEST_KEY"]);
	assert.equal(process.env.OPTCHAT_TEST_KEY, "changed");
	await writeFile(join(home, ".env"), "");
	await loadEnv(home, owned);
	assert.equal(process.env.OPTCHAT_TEST_KEY, undefined);
});

test("skills become one prompt section in pi's format", async () => {
	assert.equal(loadSkillSection(home, () => {}), undefined);
	await mkdir(join(home, "skills", "web-search"), { recursive: true });
	await writeFile(
		join(home, "skills", "web-search", "SKILL.md"),
		"---\nname: web-search\ndescription: Search the web with Jina\n---\n\nRun curl against s.jina.ai.\n",
	);
	const reports: unknown[] = [];
	const section = loadSkillSection(home, (e) => reports.push(e));
	assert.ok(section !== undefined);
	const text = await section.render({} as never, BACKGROUND_CONTEXT);
	assert.ok(typeof text === "string" && text.includes("web-search") && text.includes("Search the web with Jina"));
	assert.ok(text.includes("SKILL.md"));
	assert.deepEqual(reports, []);
});

test("extensions load from files and directories, with the kit, and a broken one is reported", async () => {
	await mkdir(join(home, "extensions", "dir"), { recursive: true });
	await writeFile(join(home, "extensions", "plain.ts"), "export default { name: 'plain', tools: [] };\n");
	await writeFile(
		join(home, "extensions", "dir", "index.ts"),
		"export default ({ defineExtension, defineTool, Type, home }) => defineExtension({ name: 'kit', tools: [defineTool({ name: 'where', description: 'the home', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: home }] }) })] });\n",
	);
	await writeFile(join(home, "extensions", "broken.ts"), "export default 42;\n");
	await writeFile(join(home, "extensions", "_ignored.ts"), "throw new Error('loaded');\n");
	const reports: unknown[] = [];
	const { extensions, errors } = await loadExtensions(home, (e) => reports.push(e));
	assert.deepEqual(extensions.map((e) => e.extension.name).sort(), ["kit", "plain"]);
	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /broken\.ts/);
	assert.equal(reports.length, 1);
	const where = extensions.find((e) => e.extension.name === "kit")!.extension.tools![0]!;
	const result = await where.execute({}, {} as never, BACKGROUND_CONTEXT);
	assert.deepEqual(result.content, [{ type: "text", text: home }]);
});

test("an extension can import a package installed under extensions/", async () => {
	await mkdir(join(home, "extensions", "node_modules", "shout"), { recursive: true });
	await writeFile(
		join(home, "extensions", "node_modules", "shout", "package.json"),
		'{ "name": "shout", "type": "module", "main": "index.js" }\n',
	);
	await writeFile(join(home, "extensions", "node_modules", "shout", "index.js"), "export const shout = (s) => s.toUpperCase();\n");
	await writeFile(
		join(home, "extensions", "loud.ts"),
		[
			"import { shout } from 'shout';",
			"export default ({ defineExtension, defineTool, Type }) => defineExtension({ name: 'loud', tools: [defineTool({ name: 'loud', description: 'shout', parameters: Type.Object({ text: Type.String() }), execute: async (args) => ({ content: [{ type: 'text', text: shout(args.text) }] }) })] });",
			"",
		].join("\n"),
	);
	const { extensions, errors } = await loadExtensions(home, () => {});
	assert.equal(errors.filter((e) => e.includes("loud")).length, 0, errors.join("; "));
	const loud = extensions.find((e) => e.extension.name === "loud")!.extension.tools![0]!;
	const result = await loud.execute({ text: "hi" }, {} as never, BACKGROUND_CONTEXT);
	assert.deepEqual(result.content, [{ type: "text", text: "HI" }]);
	await rm(join(home, "extensions", "loud.ts"));
});

test("a reload replaces changed extensions, removes deleted ones, and the reload tool reports", async () => {
	const registry = createRegistry();
	const additions = new Home(home, registry, () => {});
	registry.install(selfExtension(additions));
	const first = await additions.reload();
	assert.deepEqual(first.extensions.map((e) => e.name).sort(), ["kit", "plain"]);
	assert.equal(first.skills, true);
	assert.equal(first.errors.length, 1);
	const tools = () => registry.snapshot().tools().map((t) => t.tool.name).sort();
	assert.deepEqual(tools(), ["reload", "where"]);
	// a changed file is loaded fresh, not from Node's module cache
	await wait(20);
	await writeFile(
		join(home, "extensions", "dir", "index.ts"),
		"export default ({ defineExtension, defineTool, Type }) => defineExtension({ name: 'kit', tools: [defineTool({ name: 'roll', description: 'a die', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: '4' }] }) })] });\n",
	);
	await rm(join(home, "extensions", "plain.ts"));
	const second = await additions.reload();
	assert.deepEqual(second.removed, ["plain"]);
	assert.deepEqual(tools(), ["reload", "roll"]);
	// the tool's report
	const reload = registry.snapshot().tools().find((t) => t.tool.name === "reload")!.tool;
	const report = await reload.execute({}, {} as never, BACKGROUND_CONTEXT);
	const text = (report.content![0] as { text: string }).text;
	assert.match(text, /extensions: kit \[roll\]/);
	assert.match(text, /broken\.ts/);
	additions.stop();
});
