import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { attachmentMarker, readAttachmentMarkers } from './attachmentMarkers.ts';
import { portableAttachmentText, prepareAttachmentText, readAttachmentText } from '../src/chat/attachmentText.ts';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const lift = (name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)![0];
const compile = (code: string) => transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

function view() {
	const posted: any[] = [];
	const input = {
		value: '', selectionStart: 0, selectionEnd: 0,
		setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
		setRangeText(text: string, start: number, end: number) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.setSelectionRange(start + text.length, start + text.length); },
		dispatchEvent() { api.syncAttachmentTokens(context.state); },
	};
	let sequence = 0;
	const context: any = {
		input, state: { chatId: 'chat', attachments: [], agents: [{ available: true }] }, draftChat: 'chat', drafts: {}, fromHistory: false,
		tokenedChips: new Map(), pastedTokens: new Map(), pendingAttachmentPastes: new Map(), removedByToken: new Set(),
		attachmentClipboardType: 'application/x-ai-browser-attachments', attachmentCaret: undefined, pendingPasteCount: 0,
		attachmentMarker, readAttachmentMarkers, portableAttachmentText, prepareAttachmentText, readAttachmentText,
		recallShown: undefined, sendWhenReady: undefined, walkDraftLive: false, inputHistory: [], historyAt: 0, historyDraft: '',
		paletteMode: undefined, closePalette() {}, send() {}, previewChips: new Map(), previewKey: (chat: string, reference: string) => `${chat}\u0000${reference}`,
		post: (message: any) => posted.push(message), gate: () => ({ s: 'on' }), isPinChip: () => false,
		newId: () => `paste-${++sequence}`, Event: class {}, autosize() {}, renderSend() {}, paintInput() {},
		rememberAttachmentCaret() { context.attachmentCaret = { chat: context.draftChat, value: input.value, start: input.selectionStart, end: input.selectionEnd }; },
		saveDraft() { context.drafts[context.draftChat] = input.value; },
	};
	const api = runInNewContext(compile([source.match(/const attachmentTokenPattern = [^\n]+/)![0],
		...['attachmentToken', 'draftChips', 'tokensIn', 'setInputText', 'spacedToken', 'plainToken', 'syncAttachmentTokens', 'pasteAttachmentTokens', 'pastedAttachments', 'canSend',
			'forgetPreviews', 'requestAttachments', 'enterBadgedText', 'sendWhenSettled',
			'draftText', 'walking', 'endRecall', 'settleRecall', 'recall'].map(lift),
		'({ attachmentToken, syncAttachmentTokens, pasteAttachmentTokens, pastedAttachments, canSend, recall, walking, settleRecall });',
	].join('\n')), context);
	const paste = (chip: any, text = api.attachmentToken(chip)) => {
		api.pasteAttachmentTokens({ preventDefault() {}, clipboardData: { getData: () => JSON.stringify({ text, items: [{ ...chip, token: text }] }) } });
		return posted.findLast(message => message.type === 'pasteAttachments');
	};
	return { context, input, api, posted, paste };
}

test('pasting a colliding reference before or over a badge keeps the correct attachment in place', () => {
	for (const replace of [false, true]) {
		for (const stateFirst of [false, true]) {
			const f = view();
			const destination = { id: 'destination', reference: '@1', label: 'destination.txt', kind: 'file' };
			const copied = { id: 'source', reference: '@1', label: 'source.txt', kind: 'file' };
			f.context.state.attachments = [destination];
			f.api.syncAttachmentTokens(f.context.state);
			const original = f.api.attachmentToken(destination);
			f.input.setSelectionRange(0, replace ? original.length : 0);
			const request = f.paste(copied);
			assert.notEqual(request.items[0].token, f.api.attachmentToken(copied));
			assert.ok(f.input.value.startsWith(request.items[0].token));
			assert.equal(f.api.canSend(), false);
			assert.equal(f.posted.some(message => message.type === 'removeAttachment' && message.id === destination.id), replace);
			const clone = { ...copied, id: 'clone', reference: '@2' };
			const next = { ...f.context.state, attachments: replace ? [clone] : [destination, clone] };
			if (stateFirst) { f.context.state = next; f.api.syncAttachmentTokens(next); }
			f.api.pastedAttachments([{ token: request.items[0].token, id: clone.id }], request.request, request.chatId);
			f.context.state = next;
			f.api.syncAttachmentTokens(next);
			assert.equal(f.input.value.split(f.api.attachmentToken(clone)).length - 1, 1);
			assert.ok(f.input.value.startsWith(f.api.attachmentToken(clone)));
			assert.equal(f.input.value.includes(original), !replace);
			assert.equal(f.api.canSend(), true);
		}
	}
});

test('a paste response for another chat never rewrites the active draft', () => {
	const f = view();
	const request = f.paste({ id: 'source', reference: '@1', label: 'source.txt', kind: 'file' });
	f.context.drafts.chat = f.input.value;
	f.context.draftChat = 'other';
	f.context.state = { chatId: 'other', attachments: [], agents: [] };
	f.input.value = 'Keep this draft';
	f.api.pastedAttachments([{ token: request.items[0].token, id: 'clone' }], request.request, 'chat');
	assert.equal(f.input.value, 'Keep this draft');
	f.context.draftChat = 'chat';
	f.input.value = f.context.drafts.chat;
	f.context.state = { chatId: 'chat', attachments: [{ id: 'clone', reference: '@1', label: 'source.txt', kind: 'file' }] };
	f.api.syncAttachmentTokens(f.context.state);
	assert.equal(f.input.value, f.api.attachmentToken(f.context.state.attachments[0]));
});

test('deleting a pending badge does not resurrect it when the host responds', () => {
	const f = view();
	const request = f.paste({ id: 'source', reference: '@1', label: 'source.txt', kind: 'file' });
	f.input.value = '';
	f.api.pastedAttachments([{ token: request.items[0].token, id: 'clone' }], request.request, 'chat');
	f.context.state = { chatId: 'chat', attachments: [{ id: 'clone', reference: '@1', label: 'source.txt', kind: 'file' }] };
	f.api.syncAttachmentTokens(f.context.state);
	assert.equal(f.input.value, '');
	assert.ok(f.posted.some(message => message.type === 'removeAttachment' && message.id === 'clone'));
});

test('plain-text att markers restore a badge even after rich clipboard data is stripped', () => {
	const f = view();
	const original = { id: 'original-screenshot', label: 'Screenshot', reference: '@1', kind: 'screenshot' };
	const text = `Inspect ${attachmentMarker(original)} please`;
	assert.equal(f.api.pasteAttachmentTokens({ preventDefault() {}, clipboardData: { getData: (type: string) => type === 'text/plain' ? text : '' } }), true);
	const request = f.posted.find(message => message.type === 'pasteAttachments');
	assert.equal(request.items[0].id, original.id);
	f.api.pastedAttachments([{ token: request.items[0].token, id: 'clone' }], request.request, 'chat');
	f.context.state = { chatId: 'chat', attachments: [{ ...original, id: 'clone', reference: '@2' }] };
	f.api.syncAttachmentTokens(f.context.state);
	assert.equal(f.input.value, `Inspect ${f.api.attachmentToken(f.context.state.attachments[0])} please`);
});

function host(attachments: any[]) {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const methods = ['_rememberAttachments', '_attachmentFinder', '_pasteAttachments'].map(name => new RegExp(`\\tprivate (?:async )?${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source)![0]);
	let nextId = 0;
	const Host = runInNewContext(compile(`class ChatViewProvider { static _surfaces = new Map(); static _attachmentClipboard = new Map(); ${methods.join('\n')} }\nChatViewProvider;`), {
		generateUuid: () => `clone-${++nextId}`, vscode: { Uri: { parse: (uri: string) => ({ uri }) } },
	});
	const instance = new Host();
	const tab = { chat: { id: 'chat', entries: [] as any[] }, attachments };
	const messages: any[] = [];
	Object.assign(instance, { _active: tab, _tabs: [tab], _history: () => [], _blocked: () => false, _post() {}, _postMessage: (message: any) => messages.push(message) });
	Host._surfaces.set('view', instance);
	return { instance, tab, messages };
}

test('Cut/Paste preserves unsent screenshot, page and selection snapshots after source removal', async () => {
	for (const kind of ['screenshot', 'sharedPage', 'selection']) {
		const attachment = { chip: { id: 'original', kind, label: kind }, text: `Captured ${kind}`, ...(kind === 'screenshot' ? { image: { mediaType: 'image/png', base64: 'image bytes' } } : {}) };
		const f = host([attachment]);
		f.instance._rememberAttachments(['original']);
		f.tab.attachments = [];
		await f.instance._pasteAttachments([{ token: '[@999999 pending]', id: 'original' }], 'request', 'chat');
		assert.equal(f.tab.attachments.length, 1);
		assert.notEqual(f.tab.attachments[0].chip.id, 'original');
		assert.equal(f.tab.attachments[0].text, attachment.text);
		assert.equal(f.tab.attachments[0].image, attachment.image);
		assert.equal(f.messages[0].request, 'request');
		assert.equal(f.messages[0].chatId, 'chat');
		assert.ok(f.messages[0].results[0].id);
	}
});

test('a full 50-item cut remains available and sent snapshots can be dragged back', async () => {
	const attachments = Array.from({ length: 50 }, (_, index) => ({ chip: { id: `item-${index}`, kind: 'selection', label: `Item ${index}` }, text: `Snapshot ${index}` }));
	const f = host(attachments);
	f.instance._rememberAttachments(attachments.map(attachment => attachment.chip.id));
	f.tab.attachments = [];
	await f.instance._pasteAttachments(attachments.map(attachment => ({ id: attachment.chip.id, token: attachment.chip.id })), 'batch', 'chat');
	assert.equal(f.tab.attachments.length, 50);
	const sent = { chip: { id: 'sent', kind: 'screenshot', label: 'Sent screenshot' }, image: { mediaType: 'image/png', base64: 'sent bytes' } };
	f.tab.chat.entries = [{ kind: 'user', attachmentData: [sent] }];
	f.instance._rememberAttachments(['sent']);
	await f.instance._pasteAttachments([{ id: 'sent', token: 'sent-token' }], 'sent', 'chat');
	assert.equal(f.tab.attachments.at(-1).image, sent.image);
});

test('a marker can resolve a sent snapshot even when it was not retained in the clipboard cache', async () => {
	const f = host([]);
	const saved = { chip: { id: 'sent', kind: 'screenshot', label: 'Saved screenshot' }, image: { mediaType: 'image/png', base64: 'saved bytes' } };
	f.tab.chat.entries = [{ kind: 'user', attachmentData: [saved] }];
	const parsed = readAttachmentMarkers(attachmentMarker(saved.chip))!;
	await f.instance._pasteAttachments(parsed.items, 'plain-text', 'chat');
	assert.equal(f.tab.attachments.length, 1);
	assert.equal(f.tab.attachments[0].image, saved.image);
	assert.equal(f.tab.attachments[0].chip.kind, 'screenshot');
});

test('copied annotation badges keep their content without inheriting live page bindings', async () => {
	const original = { chip: { id: 'annotation', kind: 'annotation', label: 'Note' }, text: 'Snapshot of the note',
		chromeAnnotation: { tabId: 1, id: 'page-marker', chatId: 'source', url: 'https://example.com/' },
		exchangeAnnotation: { tabId: 'page', id: 'remote-marker' } };
	const f = host([original]);
	f.instance._rememberAttachments(['annotation']);
	f.tab.attachments = [];
	await f.instance._pasteAttachments(readAttachmentMarkers(attachmentMarker(original.chip))!.items, 'annotation', 'chat');
	const copy = f.tab.attachments[0];
	assert.equal(copy.text, original.text);
	assert.equal(copy.chip.kind, 'annotation');
	assert.equal(copy.chromeAnnotation, undefined);
	assert.equal(copy.exchangeAnnotation, undefined);
	assert.equal(original.chromeAnnotation.id, 'page-marker');
});

test('a message recalled with ↑ shows working badges, leaves the draft alone while walking, and is made on the first edit', () => {
	const f = view();
	const draftChip = { id: 'draft', reference: '@1', label: 'draft.txt', kind: 'file' };
	f.context.state.attachments = [draftChip];
	f.input.value = 'see ';
	f.input.setSelectionRange(4, 4);
	f.context.attachmentCaret = { chat: 'chat', value: f.input.value, start: 4, end: 4 };
	f.api.syncAttachmentTokens(f.context.state);
	const draft = f.input.value;
	const sentToken = '[@1\u00a0shot.png]';
	f.context.inputHistory = [{ text: `fix ${sentToken} please`, items: [{ token: sentToken, id: 'sent-shot', kind: 'screenshot', label: 'shot.png' }] }];
	f.context.historyAt = 1;

	// On show: the badge is a preview drawn from the saved attachment, under a reference the draft does not use.
	assert.equal(f.api.recall(-1), true);
	assert.ok(f.api.walking());
	const [preview] = [...f.context.previewChips.values()];
	assert.equal(preview.chip.id, 'sent-shot');
	assert.equal(preview.chip.kind, 'screenshot');
	assert.equal(f.input.value, `fix ${preview.token} please`);
	assert.notEqual(preview.chip.reference, '@1');
	assert.ok(!f.posted.some(message => message.type === 'pasteAttachments' || message.type === 'removeAttachment'));
	f.api.syncAttachmentTokens(f.context.state);
	assert.ok(!f.posted.some(message => message.type === 'removeAttachment'), 'walking leaves the draft chips alone');

	// Back down: the draft as it was, its chip still there.
	f.api.recall(1);
	assert.equal(f.input.value, draft);
	assert.equal(f.context.previewChips.size, 0);
	assert.ok(!f.posted.some(message => message.type === 'removeAttachment'));

	// Up again and edited: the recalled badge is made, the draft's own chip goes with its token and is kept as a marker.
	f.api.recall(-1);
	f.input.value += ' now';
	f.api.settleRecall();
	f.api.syncAttachmentTokens(f.context.state);
	const request = f.posted.findLast(message => message.type === 'pasteAttachments');
	assert.equal(request.items[0].id, 'sent-shot');
	assert.ok(f.posted.some(message => message.type === 'removeAttachment' && message.id === 'draft'));
	assert.ok(f.posted.some(message => message.type === 'rememberAttachments' && message.ids.includes('draft')));
	assert.equal(f.context.historyDraft, `see ${attachmentMarker(draftChip)}`);
	assert.equal(f.api.canSend(), false, 'the badge is still being made');
	const clone = { id: 'clone', reference: '@2', label: 'shot.png', kind: 'screenshot' };
	f.api.pastedAttachments([{ token: request.items[0].token, id: clone.id }], request.request, 'chat');
	f.context.state = { ...f.context.state, attachments: [clone] };
	f.api.syncAttachmentTokens(f.context.state);
	assert.equal(f.input.value, `fix ${f.api.attachmentToken(clone)} please now`);
	assert.equal(f.api.canSend(), true);
	assert.equal(f.context.previewChips.size, 0);
});
