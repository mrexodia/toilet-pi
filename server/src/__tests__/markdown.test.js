// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../client/markdown.js';
import { groupCollapsedHistory } from '../../public/history-grouping.js';
import { createModelPicker } from '../../public/model-picker.js';

const renderMarkdownSpy = vi.fn(renderMarkdown);
let renderMessage, renderAssistantStream, renderToolMessage, renderHistoryFragments;
beforeAll(() => {
	document.body.innerHTML = readFileSync('public/index.html', 'utf8');
	vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
	vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => '{"authenticated":false}' }));
	vi.stubGlobal('requestAnimationFrame', () => 0);
	const source = readFileSync('public/app.js', 'utf8')
		.replace(/^import .*;\n/gm, '');
	({ renderMessage, renderAssistantStream, renderToolMessage, renderHistoryFragments } = new Function(
		'renderMarkdown', 'groupCollapsedHistory', 'createModelPicker',
		`${source}\nreturn { renderMessage, renderAssistantStream, renderToolMessage, renderHistoryFragments };`,
	)(renderMarkdownSpy, groupCollapsedHistory, createModelPicker));
});

const markdown = '**Bold**\n\n| Name | Value |\n| --- | --- |\n| Test | 42 |\n\n## Heading\n\n- Item\n\n`code`\n\n```js\nconst x = "<tag>";\n```';

describe('assistant Markdown', () => {
	for (const mode of ['history', 'stream']) {
		it(`renders formatting in ${mode}`, () => {
			const row = mode === 'history'
				? renderMessage({ role: 'assistant', text: markdown })
				: renderAssistantStream(markdown);
			expect(row.querySelector('strong').textContent).toBe('Bold');
			expect(row.querySelector('td').textContent).toBe('Test');
			expect(row.querySelector('h2').textContent).toBe('Heading');
			expect(row.querySelector('li').textContent).toBe('Item');
			expect(row.querySelector('pre code').textContent).toContain('<tag>');
		});
	}
	it('handles every partial streaming prefix and the completed message', () => {
		for (let i = 1; i <= markdown.length; i++) {
			expect(() => renderAssistantStream(markdown.slice(0, i))).not.toThrow();
		}
		expect(renderAssistantStream(markdown).querySelector('.message-text').innerHTML)
			.toBe(renderMessage({ role: 'assistant', text: markdown }).querySelector('.message-text').innerHTML);
	});
	it('removes executable HTML, styling, and unsafe URLs but retains safe links', () => {
		const row = renderAssistantStream('<script>alert(1)</script><img src=x onerror=alert(1)><svg onload=alert(1)></svg><iframe src=x></iframe><p style="position:fixed" onclick="alert(1)">Hi</p>\n\n[bad](javascript:alert%281%29) [good](https://example.com)');
		expect(row.querySelector('script,img,svg,iframe,[style],[onclick],[onerror]')).toBeNull();
		expect(row.querySelector('a').hasAttribute('href')).toBe(false);
		expect(row.querySelector('a[href]').getAttribute('href')).toBe('https://example.com');
	});
	it('only makes full HTTP URLs clickable', () => {
		const row = renderAssistantStream('[relative](./docs/cli.md) [root](/docs/cli.md) [fragment](#usage) [protocol-relative](//example.com/docs) [http](http://example.com/docs) [https](https://example.com/docs)');
		const links = Object.fromEntries([...row.querySelectorAll('a')]
			.map((link) => [link.textContent, link.getAttribute('href')]));
		expect(links).toEqual({
			relative: null,
			root: null,
			fragment: null,
			'protocol-relative': null,
			http: 'http://example.com/docs',
			https: 'https://example.com/docs',
		});
	});
	it('reuses completed Markdown while streaming instead of reparsing history', () => {
		const session = { history: Array.from({ length: 200 }, (_, i) => ({
			role: 'assistant', text: `**Reply ${i}**`,
		})) };
		renderMarkdownSpy.mockClear();
		renderHistoryFragments(session);
		expect(renderMarkdownSpy).toHaveBeenCalledTimes(200);
		for (const text of ['**Live', '**Live reply**']) {
			renderHistoryFragments(session);
			renderAssistantStream(text);
		}
		expect(renderMarkdownSpy).toHaveBeenCalledTimes(202);
	});
	it('invalidates cached Markdown when message text changes', () => {
		const message = { role: 'assistant', text: '**Before**' };
		renderMessage(message);
		message.text = '**After**';
		renderMarkdownSpy.mockClear();
		const row = renderMessage(message);
		expect(row.querySelector('strong').textContent).toBe('After');
		expect(renderMarkdownSpy).toHaveBeenCalledTimes(1);
	});
	it('keeps cached HTML sanitized and distinct messages independent', () => {
		const message = { role: 'assistant', timestamp: 1, text: '**Safe**<img src=x onerror=alert(1)>' };
		renderMessage(message);
		renderMarkdownSpy.mockClear();
		const cached = renderMessage(message);
		expect(cached.querySelector('strong').textContent).toBe('Safe');
		expect(cached.querySelector('img,[onerror]')).toBeNull();
		expect(renderMarkdownSpy).not.toHaveBeenCalled();
		const other = renderMessage({ ...message, text: '**Other**' });
		expect(other.querySelector('strong').textContent).toBe('Other');
		expect(renderMarkdownSpy).toHaveBeenCalledTimes(1);
	});
	it('keeps user messages, thinking, and tool output literal', () => {
		expect(renderMessage({ role: 'user', text: markdown }).querySelector('strong,table')).toBeNull();
		const thinking = renderMessage({ role: 'assistant', thinkingText: '**thinking**' });
		expect(thinking.querySelector('.thinking-text').textContent).toBe('**thinking**');
		const tool = renderToolMessage({ toolName: 'bash', text: '**output**' });
		expect(tool.querySelector('.tool-body').textContent).toBe('**output**');
	});
});
