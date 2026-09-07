// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../client/markdown.js';
import { groupCollapsedHistory } from '../../public/history-grouping.js';

let renderMessage, renderAssistantStream, renderToolMessage;
beforeAll(() => {
	document.body.innerHTML = readFileSync('public/index.html', 'utf8');
	vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
	vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => '{"authenticated":false}' }));
	vi.stubGlobal('requestAnimationFrame', () => 0);
	const source = readFileSync('public/app.js', 'utf8')
		.replace(/^import .*;\n/gm, '');
	({ renderMessage, renderAssistantStream, renderToolMessage } = new Function(
		'renderMarkdown', 'groupCollapsedHistory',
		`${source}\nreturn { renderMessage, renderAssistantStream, renderToolMessage };`,
	)(renderMarkdown, groupCollapsedHistory));
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
	it('keeps user messages, thinking, and tool output literal', () => {
		expect(renderMessage({ role: 'user', text: markdown }).querySelector('strong,table')).toBeNull();
		const thinking = renderMessage({ role: 'assistant', thinkingText: '**thinking**' });
		expect(thinking.querySelector('.thinking-text').textContent).toBe('**thinking**');
		const tool = renderToolMessage({ toolName: 'bash', text: '**output**' });
		expect(tool.querySelector('.tool-body').textContent).toBe('**output**');
	});
});
