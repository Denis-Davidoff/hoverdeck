import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { featureOfTool, mcpFeatures, readDisabledFeatures } from './mcpFeatures.ts';

test('tools map to their feature and the core tools to none', () => {
	assert.equal(featureOfTool('chat_play_sound'), 'sounds');
	assert.equal(featureOfTool('chat_alert'), 'alerts');
	assert.equal(featureOfTool('browser_recording_start'), 'recording');
	assert.equal(featureOfTool('editor_context'), 'editor');
	assert.equal(featureOfTool('browser_click'), undefined);
	assert.equal(featureOfTool('terminal_send'), undefined);
	assert.equal(featureOfTool('chat_state'), undefined);
});

test('the setting is read leniently', () => {
	assert.deepEqual([...readDisabledFeatures(['alerts', 'nope', 3, 'sounds'])], ['alerts', 'sounds']);
	assert.equal(readDisabledFeatures('alerts').size, 0);
});

test('the ids are the same in the protocol, the manifest and here', () => {
	const protocol = /export type McpFeatureId = ([^;]+);/.exec(readFileSync('src/chat/chatProtocol.ts', 'utf8'))![1];
	assert.deepEqual(protocol.split('|').map(s => s.trim().replace(/'/g, '')), [...mcpFeatures]);
	const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
	const setting = manifest.contributes.configuration.flatMap((c: any) => c ? [c] : []).map((c: any) => c.properties?.['hoverdeck.mcp.disabledFeatures']).find(Boolean)
		?? manifest.contributes.configuration.properties?.['hoverdeck.mcp.disabledFeatures'];
	assert.deepEqual(setting.items.enum, [...mcpFeatures]);
});
