import * as assert from 'node:assert';
import { test } from 'node:test';
import { extensionIds, hasExternalAgents, mcpServerName, otherExtensionId, ownExtensionId, productName } from './flavor.ts';

test('this repository builds HoverDeck alone', () => {
	assert.strictEqual(ownExtensionId(), extensionIds.hoverdeck);
	assert.strictEqual(otherExtensionId(), extensionIds.aibrowser);
	assert.strictEqual(hasExternalAgents(), false);
	assert.strictEqual(mcpServerName(), 'hoverdeck');
	assert.strictEqual(productName(), 'HoverDeck');
});
