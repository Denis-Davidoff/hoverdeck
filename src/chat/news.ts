/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading NEWS.md for the chat's empty state.
 *
 * The file is written by hand, so the reader is forgiving: an HTML comment is
 * skipped, the first heading is the file's title, the paragraph before the
 * first `## ` is the introduction, and each `## ` heading starts an entry
 * whose `-` / `*` bullets are its items (an indented line continues the item
 * above it). Bullets before the first entry are the features the empty chat
 * lists, each written `$(icon) **Name** — what it does`; one in any other shape
 * is skipped. A `> ` quote before the first entry is a notice — an
 * announcement the empty chat draws as a highlighted card above the features,
 * written like a feature (`> $(icon) **Name** — text`; without the icon and
 * name it is shown with a megaphone and no title); consecutive `>` lines are
 * one notice and a bare `>` starts the next. Inside an entry a `> ` line is a
 * highlight, shown first and marked in the changelog. Anything else is ignored rather than refused — a typo in a news
 * file must not cost the chat its welcome. A leaf module, under test.
 */

import type { ChatNews } from './chatProtocol';

/** How many entries the empty state shows; the file may hold more. */
export const newsEntryLimit = 6;

export function parseNews(markdown: string, limit = newsEntryLimit): ChatNews {
	const text = markdown.replace(/<!--[\s\S]*?(-->|$)/g, '');
	const intro: string[] = [];
	const entries: { title: string; items: string[]; highlights: string[]; quoting: boolean }[] = [];
	const features: { icon: string; title: string; text: string }[] = [];
	const notices: string[][] = [];
	let quoting = false;
	let introDone = false;

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trimEnd();
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			if (heading[1].length === 2) {
				entries.push({ title: heading[2].trim(), items: [], highlights: [], quoting: false });
			}
			quoting = false;
			// A title heading, or a deeper one, starts nothing of its own; it does
			// end the introduction if text came before it.
			introDone = introDone || intro.length > 0 || heading[1].length === 2;
			continue;
		}
		const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
		const current = entries[entries.length - 1];
		if (current) {
			if (quote) {
				const body = quote[1].trim();
				if (!body) { current.quoting = false; continue; }
				if (current.quoting) {
					current.highlights[current.highlights.length - 1] += ` ${body}`;
				} else {
					current.highlights.push(body);
					current.quoting = true;
				}
				continue;
			}
			current.quoting = false;
			const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
			if (bullet) {
				current.items.push(bullet[1].trim());
			} else if (/^\s+\S/.test(line) && current.items.length) {
				current.items[current.items.length - 1] += ` ${line.trim()}`;
			}
			continue;
		}
		if (quote) {
			const body = quote[1].trim();
			if (!body) { quoting = false; continue; }
			if (quoting) {
				notices[notices.length - 1].push(body);
			} else {
				notices.push([body]);
				quoting = true;
			}
			introDone = introDone || intro.length > 0;
			continue;
		}
		quoting = false;
		const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			const feature = /^\$\(([a-z0-9-]+)\)\s+\*\*([^*]+)\*\*\s+[—–-]\s+(\S.*)$/.exec(bullet[1].trim());
			if (feature) {
				features.push({ icon: feature[1], title: feature[2].trim(), text: feature[3].trim() });
			}
			introDone = introDone || intro.length > 0;
			continue;
		}
		if (/^\s+\S/.test(line) && features.length) {
			const last = features[features.length - 1];
			last.text += ` ${line.trim()}`;
			continue;
		}
		if (!introDone) {
			if (line.trim()) {
				intro.push(line.trim());
			} else if (intro.length) {
				introDone = true;
			}
		}
	}

	const announced = notices.map(lines => {
		const body = lines.join(' ');
		const shaped = /^(?:\$\(([a-z0-9-]+)\)\s+)?\*\*([^*]+)\*\*\s+[—–-]\s+(\S.*)$/.exec(body);
		return shaped
			? { icon: shaped[1] || 'megaphone', title: shaped[2].trim(), text: shaped[3].trim() }
			: { icon: 'megaphone', title: '', text: body };
	});
	return {
		intro: intro.join(' '),
		features,
		...(announced.length ? { notices: announced } : {}),
		entries: entries
			.filter(e => e.title && (e.items.length || e.highlights.length))
			.slice(0, Math.max(0, limit))
			.map(e => e.highlights.length
				? { title: e.title, items: e.items, highlights: e.highlights }
				: { title: e.title, items: e.items }),
	};
}
