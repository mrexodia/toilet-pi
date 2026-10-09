// Jina web search and page reader, as an optchat extension. Copy to <home>/extensions/jina.ts and put
// JINA_API_KEY=... in <home>/.env. The file needs no imports: the kit gives it durable's helpers.
export default ({ defineExtension, defineTool, Type, env }) => {
	const key = () => {
		const value = env.JINA_API_KEY;
		if (!value) throw new Error("JINA_API_KEY is not set: put it in the home's .env and restart");
		return value;
	};
	const reply = (text) => ({ content: [{ type: "text", text }] });
	async function get(url, headers) {
		const response = await fetch(url, { headers: { Authorization: `Bearer ${key()}`, ...headers } });
		const text = await response.text();
		if (!response.ok) throw new Error(`Jina answered ${response.status}: ${text.slice(0, 300)}`);
		return text;
	}
	return defineExtension({
		name: "jina",
		tools: [
			defineTool({
				name: "web_search",
				description: "Search the web with Jina: titles, URLs and descriptions for a query, without page contents. Read a result with web_fetch.",
				parameters: Type.Object({ query: Type.String() }),
				replay: "safe",
				execute: async (args) =>
					reply(
						await get(`https://s.jina.ai/?${new URLSearchParams({ q: args.query })}`, {
							"User-Agent": "jina-search/1.0",
							"X-Respond-With": "no-content",
						}),
					),
			}),
			defineTool({
				name: "web_fetch",
				description: "Fetch a web page as clean text, through Jina's reader. Use it to read a search result or any URL.",
				parameters: Type.Object({ url: Type.String() }),
				replay: "safe",
				execute: async (args) => reply(await get(`https://r.jina.ai/${args.url}`, { "User-Agent": "jina-reader/1.0" })),
			}),
		],
	});
};
