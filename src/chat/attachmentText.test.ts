import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { attachmentTextLimit, portableAttachmentText, prepareAttachmentText, readAttachmentText } from './attachmentText.ts';

const token = (reference: string, label: string) => `[${reference} ${label}]`;
const chips: Record<string, { id: string; kind: 'file' | 'screenshot'; label: string; filePath?: string }> = {
	'@1': { id: 'a', kind: 'file', label: 'a.ts', filePath: '/p/a.ts' },
	'@2': { id: 'b', kind: 'screenshot', label: 'shot.png' },
};

test('portable text lists each token once, with the chip it stood for', () => {
	const text = `see ${token('@1', 'a.ts')} and ${token('@2', 'shot.png')} and ${token('@1', 'a.ts')} and ${token('@9', 'gone')}`;
	const portable = portableAttachmentText(text, reference => chips[reference]);
	assert.equal(portable.text, text);
	assert.deepEqual(portable.items?.map(item => [item.token, item.id, item.filePath]), [
		[token('@1', 'a.ts'), 'a', '/p/a.ts'],
		[token('@2', 'shot.png'), 'b', undefined],
	]);
	assert.deepEqual(portableAttachmentText('plain', () => undefined), { text: 'plain' });
});

test('reading stored text keeps a plain string and drops malformed items only', () => {
	assert.deepEqual(readAttachmentText('older entry'), { text: 'older entry' });
	assert.equal(readAttachmentText(undefined), undefined);
	assert.equal(readAttachmentText({ items: [] }), undefined);
	const good = { token: 'x', id: 'i', label: 'l', kind: 'file' };
	assert.deepEqual(readAttachmentText({ text: 't', items: [good, { token: 1 }, null, { ...good, filePath: 3 }] }), { text: 't', items: [good] });
	assert.deepEqual(readAttachmentText({ text: 't', items: 'no' }), { text: 't' });
	const many = Array.from({ length: attachmentTextLimit + 5 }, (_, n) => ({ ...good, id: `i${n}` }));
	assert.equal(readAttachmentText({ text: 't', items: many })?.items?.length, attachmentTextLimit);
});

test('prepared text renumbers each badge clear of the references the box uses', () => {
	const data = portableAttachmentText(`${token('@1', 'a.ts')} ${token('@2', 'shot.png')} ${token('@3', 'lost')}`, reference => chips[reference]);
	const prepared = prepareAttachmentText(data, ['@999999', '@1'], (item, reference) => token(reference, item.label));
	assert.equal(prepared.text, `${token('@999998', 'a.ts')} ${token('@999997', 'shot.png')} lost`);
	assert.deepEqual(prepared.pending.map(item => [item.token, item.id]), [[token('@999998', 'a.ts'), 'a'], [token('@999997', 'shot.png'), 'b']]);
});

test('with nothing to make, a badge reads as its path or its label', () => {
	const data = portableAttachmentText(`${token('@1', 'a.ts')} ${token('@2', 'shot.png')}`, reference => chips[reference]);
	const prepared = prepareAttachmentText(data, [], () => assert.fail('nothing is made'), false);
	assert.equal(prepared.text, '/p/a.ts shot.png');
	assert.deepEqual(prepared.pending, []);
});
