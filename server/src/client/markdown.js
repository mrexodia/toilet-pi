import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(text) {
	return DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }), {
		ALLOWED_TAGS: ['p', 'br', 'hr', 'strong', 'em', 'del', 'a', 'code', 'pre',
			'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
			'table', 'thead', 'tbody', 'tr', 'th', 'td'],
		ALLOWED_ATTR: ['href', 'title', 'start', 'align'],
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
	});
}
