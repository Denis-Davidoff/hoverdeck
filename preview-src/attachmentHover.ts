/**
 * The one hover card every attachment badge shows — in the message box, in a sent or queued
 * message, and on the chips under the box (suggestions, pinned browser tabs and terminals).
 * It replaces the native `title`, which a VS Code webview often does not show on these
 * elements, and which can hold neither a picture nor the attachment's text.
 *
 * What it shows: the kind's icon and name, the label whole, the path or address when it says
 * more than the label, a preview — the picture of a screenshot or an image, or the first lines
 * of a text — and a line saying what a click and a right-click do. A preview the chip does not
 * carry (`thumbnail`) is asked of the host once per attachment and kept (`request`); the card
 * redraws itself when the answer arrives while it is still up.
 *
 * DOM only through the callbacks it is given, so the module stays a leaf.
 */

export interface AttachmentHoverInfo {
	/** A key for the preview cache and the host's answer: the chip id (and the entry for a sent badge). */
	readonly key?: string;
	/** The kind's name, shown small above the label: "Screenshot", "File", "Page"… */
	readonly kind: string;
	readonly label: string;
	/** A path or an address shown under the label when it is not the label itself. */
	readonly detail?: string;
	/** The icon, already built (the file icon theme's or the kind's codicon). */
	readonly icon?: () => HTMLElement;
	/** A picture the chip carries already. */
	readonly image?: string;
	/** What a click, a drag and a right-click do, one short line. */
	readonly hint?: string;
	/** Asks the host for a preview; called at most once per key. */
	readonly request?: () => void;
}

export interface AttachmentPreview { readonly image?: string; readonly text?: string }

export interface AttachmentHoverDeps {
	/** Where the card is put (the chat's `#app`). */
	readonly root: HTMLElement;
	/** Places an open overlay against its anchor and keeps it there. */
	readonly place: (node: HTMLElement, anchor: HTMLElement) => void;
	readonly codicon: (name: string) => HTMLElement;
	/** Delay before the card shows, in ms. */
	readonly delay?: number;
}

export interface AttachmentHover {
	/** The anchor the card is shown for, if any. */
	readonly anchor: HTMLElement | undefined;
	/** Wires an element: the card shows on hover and keyboard focus. `info` is read when it shows. */
	attach(anchor: HTMLElement, info: () => AttachmentHoverInfo | undefined): void;
	/** Shows the card for `anchor` after the delay (or now, if a card is already up), for a target with no element events of its own. */
	hover(anchor: HTMLElement, info: AttachmentHoverInfo): void;
	show(anchor: HTMLElement, info: AttachmentHoverInfo): void;
	hide(): void;
	/** The host's answer to a request. */
	preview(key: string, preview: AttachmentPreview): void;
}

/** At most this many characters of a text preview are drawn; the card shows a few lines of them. */
export const previewTextShown = 600;
/** Previews kept, the oldest dropped first. */
const previewCacheSize = 40;
/** And at most this many lines. */
const previewLines = 8;

export function createAttachmentHover(deps: AttachmentHoverDeps): AttachmentHover {
	const node = document.createElement('div');
	node.className = 'hover-tip att-hover';
	node.setAttribute('role', 'tooltip');
	const previews = new Map<string, AttachmentPreview | 'pending'>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let current: { anchor: HTMLElement; info: AttachmentHoverInfo } | undefined;

	const span = (className: string, text?: string) => {
		const s = document.createElement('span');
		s.className = className;
		if (text !== undefined) { s.textContent = text; }
		return s;
	};

	const draw = (info: AttachmentHoverInfo) => {
		const cached = info.key ? previews.get(info.key) : undefined;
		const preview = cached && cached !== 'pending' ? cached : undefined;
		const image = info.image ?? preview?.image;
		const parts: HTMLElement[] = [];
		if (image) {
			const frame = span('att-hover-image');
			const img = document.createElement('img');
			img.alt = '';
			img.decoding = 'async';
			img.src = image;
			// Re-placed once its size is known, or the card keeps the height it had without it.
			img.addEventListener('load', () => { if (current) { deps.place(node, current.anchor); } }, { once: true });
			img.addEventListener('error', () => frame.remove(), { once: true });
			frame.append(img);
			parts.push(frame);
		}
		const head = span('att-hover-head');
		const mark = info.icon?.() ?? deps.codicon('file');
		mark.classList.add('att-hover-icon');
		head.append(mark, span('att-hover-kind', info.kind));
		parts.push(head, span('att-hover-label', info.label));
		if (info.detail && info.detail !== info.label) { parts.push(span('att-hover-detail', info.detail)); }
		if (!image && preview?.text) {
			const lines = preview.text.slice(0, previewTextShown).split('\n');
			const cut = lines.length > previewLines || preview.text.length > previewTextShown;
			const text = `${lines.slice(0, previewLines).join('\n').trimEnd()}${cut ? '\n…' : ''}`;
			parts.push(span('att-hover-text', text));
		} else if (!image && cached === 'pending') {
			parts.push(span('att-hover-loading', 'Loading preview…'));
		}
		if (info.hint) { parts.push(span('att-hover-hint', info.hint)); }
		node.replaceChildren(...parts);
	};

	const api: AttachmentHover = {
		get anchor() { return current?.anchor; },
		show(anchor, info) {
			clearTimeout(timer);
			timer = undefined;
			if (!anchor.isConnected) { api.hide(); return; }
			current = { anchor, info };
			if (info.key && !info.image && info.request && !previews.has(info.key)) {
				previews.set(info.key, 'pending');
				info.request();
			}
			draw(info);
			if (!node.isConnected) { deps.root.append(node); }
			deps.place(node, anchor);
		},
		hover(anchor, info) {
			if (current?.anchor === anchor) { return; }
			clearTimeout(timer);
			if (current) { api.show(anchor, info); return; }
			timer = setTimeout(() => api.show(anchor, info), deps.delay ?? 350);
		},
		hide() {
			clearTimeout(timer);
			timer = undefined;
			current = undefined;
			node.classList.remove('open');
		},
		attach(anchor, info) {
			anchor.addEventListener('mouseenter', () => { const i = info(); if (i) { api.hover(anchor, i); } });
			anchor.addEventListener('mouseleave', () => { if (current?.anchor === anchor || timer) { api.hide(); } });
			anchor.addEventListener('mousedown', () => api.hide());
			anchor.addEventListener('focus', () => { const i = info(); if (i && anchor.matches(':focus-visible')) { api.show(anchor, i); } });
			anchor.addEventListener('blur', () => { if (current?.anchor === anchor) { api.hide(); } });
		},
		preview(key, preview) {
			previews.delete(key);
			previews.set(key, preview);
			// A picture can be megabytes: only the latest few are kept.
			while (previews.size > previewCacheSize) { previews.delete(previews.keys().next().value!); }
			if (current?.info.key === key) { api.show(current.anchor, current.info); }
		},
	};
	window.addEventListener('scroll', () => api.hide(), true);
	window.addEventListener('blur', () => api.hide());
	document.addEventListener('keydown', () => api.hide(), true);
	return api;
}
