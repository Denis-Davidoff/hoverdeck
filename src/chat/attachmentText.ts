import type { AttachmentChip, PastedAttachment } from './chatProtocol';

/**
 * Text that carries attachment badges, in a form that outlives the draft it was written in.
 *
 * A badge in the message box is a token, `[@N label]`, standing for a chip of the draft shown. The
 * `@N` means something only beside that draft: once the message is sent, or the text moves to
 * another chat, the clipboard or the ↑ history, nothing answers for it any more, and the badge is
 * drawn as dead text. So every path that carries badged text out of a draft carries it as
 * `AttachmentText` — the text, and for each token the attachment it stood for — and every path
 * that puts such text back into a box goes through `prepareAttachmentText`, which gives each token
 * a reference free in the box it lands in and lists what the host has to make again
 * (`pasteAttachments`). The paste of a copied selection and a message recalled with ↑ are the two
 * users; both used to have their own half of this.
 *
 * Leaf module: the host builds it when a message is remembered, the webview when it copies, and
 * `npm test` loads it directly.
 */
export interface AttachmentText {
	readonly text: string;
	/** One per token of `text` that stood for an attachment, matched by the token's exact text. */
	readonly items?: readonly PastedAttachment[];
}

/** One badge in a message: `[@N label]`, spaces or no-break spaces after the reference. */
export const attachmentTokenSource = '\\[@([1-9][0-9]{0,5})[ \\u00a0]([^\\]\\n]{0,200})\\]';
export function attachmentTokenPattern(): RegExp {
	return new RegExp(attachmentTokenSource, 'g');
}

/** At most this many badges are made again from one piece of text. */
export const attachmentTextLimit = 50;

type ChipLike = Pick<AttachmentChip, 'id' | 'kind' | 'label'> & Partial<Pick<AttachmentChip, 'filePath' | 'iconName'>>;

/**
 * The text with each token matched to the chip its reference names (`chipOf`), as `AttachmentText`.
 * A token with no chip is left as it is and listed nowhere: it reads as its label when put back.
 */
export function portableAttachmentText(text: string, chipOf: (reference: string) => ChipLike | undefined): AttachmentText {
	const items: PastedAttachment[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(attachmentTokenPattern())) {
		const token = match[0];
		if (seen.has(token) || items.length >= attachmentTextLimit) { continue; }
		const chip = chipOf(`@${match[1]}`);
		if (!chip?.id) { continue; }
		seen.add(token);
		items.push({
			token, id: chip.id, kind: chip.kind, label: chip.label,
			...(chip.filePath ? { filePath: chip.filePath } : {}),
			...(chip.iconName ? { iconName: chip.iconName } : {}),
		});
	}
	return items.length ? { text, items } : { text };
}

/** Whether a stored value is `AttachmentText` this build can use; anything else is refused whole. */
export function readAttachmentText(value: unknown): AttachmentText | undefined {
	if (typeof value === 'string') { return { text: value }; }
	if (!value || typeof value !== 'object') { return undefined; }
	const { text, items } = value as { text?: unknown; items?: unknown };
	if (typeof text !== 'string') { return undefined; }
	if (!Array.isArray(items)) { return { text }; }
	const kept = items.filter((item): item is PastedAttachment => !!item && typeof item === 'object'
		&& typeof item.token === 'string' && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.kind === 'string'
		&& (item.filePath === undefined || typeof item.filePath === 'string')
		&& (item.iconName === undefined || typeof item.iconName === 'string')).slice(0, attachmentTextLimit);
	return kept.length ? { text, items: kept } : { text };
}

export interface PreparedAttachmentText {
	/** The text to put into the box: each badge under a reference that box does not use. */
	readonly text: string;
	/** What the host is asked to make, each under the token now in `text`. */
	readonly pending: readonly PastedAttachment[];
}

/**
 * `data` made ready for a box whose references are `used`: each token with an item gets the next
 * free reference counting down from 999999 (well clear of a draft's own @1, @2, …) and is written
 * by `tokenFor`; a token with no item, or past the limit, or with `make` false (nothing can be made
 * again here), becomes the path it names or its label.
 */
export function prepareAttachmentText(
	data: AttachmentText,
	used: Iterable<string>,
	tokenFor: (item: PastedAttachment, reference: string) => string,
	make = true,
): PreparedAttachmentText {
	const taken = new Set(used);
	const items = data.items ?? [];
	const pending: PastedAttachment[] = [];
	let next = 999999;
	const text = data.text.replace(attachmentTokenPattern(), (whole: string, _n: string, label: string) => {
		const item = items.find(item => item.token === whole);
		if (!make || !item || pending.length >= attachmentTextLimit) { return item?.filePath ?? label.trim(); }
		while (taken.has(`@${next}`) && next > 0) { next--; }
		if (!next) { return item.filePath ?? label.trim(); }
		const reference = `@${next--}`;
		taken.add(reference);
		const token = tokenFor(item, reference);
		pending.push({ ...item, token });
		return token;
	});
	return { text, pending };
}
