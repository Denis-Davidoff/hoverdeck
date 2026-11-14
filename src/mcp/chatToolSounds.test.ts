import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chatSounds } from '../chat/chatProtocol.ts';

test('the sounds chat_play_sound accepts are the chat\'s own sounds', () => {
	// chatTools.ts is not a leaf, so its copy is read as text.
	const list = /export const chatToolSounds[^=]*= (\[[^\]]*\])/.exec(readFileSync('src/mcp/chatTools.ts', 'utf8'))![1];
	assert.deepEqual(JSON.parse(list.replace(/'/g, '"')), [...chatSounds]);
});
