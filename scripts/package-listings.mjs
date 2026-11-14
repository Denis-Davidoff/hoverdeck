/*
 * The per-agent HoverDeck listings on Open VSX: `node scripts/package-listings.mjs [--publish] [name…]`.
 *
 * Each listing in `listings/listings.json` becomes a manifest-only extension in
 * `listings/dist/<name>/` and `listings/dist/<name>.vsix`. It carries no code: it
 * depends on HoverDeck (`extensionDependencies`, so installing it installs
 * HoverDeck) and sets `hoverdeck.chat.defaultAgent` through
 * `contributes.configurationDefaults`. All state — history, logins, the MCP
 * server — stays in HoverDeck, so installing several listings changes nothing
 * but which agent a new chat starts with.
 *
 * Open VSX only: HoverDeck uses API proposals and cannot be on the VS Code
 * Marketplace, and a dependency on an extension the gallery does not have
 * would not install.
 *
 * `--publish` runs `ovsx publish` on each package afterwards (token from
 * `OVSX_PAT` or the keychain, as `publish:ovsx`). Names select listings.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(root, 'listings', 'listings.json'), 'utf8'));
const args = process.argv.slice(2);
const publish = args.includes('--publish');
const wanted = args.filter(a => !a.startsWith('--'));

/** The agent ids `hoverdeck.chat.defaultAgent` takes, read from the manifest so the two cannot drift. */
const agentEnum = pkg.contributes.configuration
	.flatMap(c => Object.entries(c.properties ?? {}))
	.find(([key]) => key === 'hoverdeck.chat.defaultAgent')?.[1]?.enum;
if (!agentEnum) { fail('package.json has no hoverdeck.chat.defaultAgent setting.'); }

const [publisher, mainName] = config.main.split('.');
if (publisher !== pkg.publisher) { fail(`listings.json main "${config.main}" is not under the publisher ${pkg.publisher}.`); }

const names = new Set();
for (const listing of config.listings) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(listing.name)) { fail(`${listing.name}: not a valid extension name.`); }
	if (names.has(listing.name)) { fail(`${listing.name}: listed twice.`); }
	if (listing.name === mainName || listing.name === 'tab-browser-ultimate') { fail(`${listing.name}: takes a real build's name.`); }
	names.add(listing.name);
	if (!agentEnum.includes(listing.agent) || !listing.agent) { fail(`${listing.name}: agent "${listing.agent}" is not a value of hoverdeck.chat.defaultAgent.`); }
	if (!listing.displayName?.startsWith('HoverDeck')) { fail(`${listing.name}: the display name should start with HoverDeck.`); }
	if (listing.description.length > 300) { fail(`${listing.name}: description over 300 characters.`); }
}
for (const name of wanted) { if (!names.has(name)) { fail(`No listing named ${name}.`); } }

const dist = join(root, 'listings', 'dist');
mkdirSync(dist, { recursive: true });
const built = [];
for (const listing of config.listings) {
	if (wanted.length && !wanted.includes(listing.name)) { continue; }
	const dir = join(dist, listing.name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, 'media'), { recursive: true });
	copyFileSync(join(root, pkg.icon), join(dir, 'media', 'icon.png'));
	copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));
	writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest(listing), null, '\t') + '\n');
	writeFileSync(join(dir, 'README.md'), readme(listing));
	const out = join(dist, `${listing.name}.vsix`);
	execFileSync(join(root, 'node_modules', '.bin', 'vsce'),
		['package', '--no-dependencies', '--out', out], { cwd: dir, stdio: 'inherit' });
	built.push(out);
}

if (publish) {
	for (const out of built) {
		execFileSync(join(root, 'node_modules', '.bin', 'ovsx'), ['publish', out], { cwd: root, stdio: 'inherit' });
	}
}

function manifest(listing) {
	return {
		name: listing.name,
		displayName: listing.displayName,
		description: listing.description,
		version: config.version,
		publisher: pkg.publisher,
		icon: 'media/icon.png',
		license: 'MIT',
		repository: pkg.repository,
		homepage: pkg.homepage,
		engines: { vscode: pkg.engines.vscode },
		categories: ['AI', 'Chat'],
		keywords: [...new Set([...listing.keywords, 'hoverdeck', 'ai', 'agent'])].slice(0, 30),
		files: ['media/icon.png', 'README.md', 'LICENSE'],
		extensionDependencies: [config.main],
		contributes: {
			configurationDefaults: { 'hoverdeck.chat.defaultAgent': listing.agent },
		},
	};
}

function readme(listing) {
	const notes = listing.notes.length ? `\n## Good to know\n\n${listing.notes.map(n => `- ${n}`).join('\n')}\n` : '';
	return `# ${listing.displayName}

${listing.description}

This is a small entry point to **[HoverDeck](https://open-vsx.org/extension/${publisher}/${mainName})**. It has no code of its
own: installing it installs HoverDeck and makes **${listing.agentName}** the agent a new chat starts with. Everything
else — the chat, the browser, Git, terminals, history — is HoverDeck, shared with every other agent you use there.

## Get started

1. ${listing.install}
2. Open the HoverDeck chat in the secondary side bar (right) and send a message.

If you used HoverDeck before, it keeps the agent you chose last; pick **${listing.agentName}** in the chat's agent menu once.
To change the default later, set **Default Agent** (\`hoverdeck.chat.defaultAgent\`) in Settings.
${notes}
## What HoverDeck gives ${listing.agentName}

- A chat in VS Code with tabs, history, queued messages and an approval menu for every command, edit and tool call.
- VS Code's built-in browser (and Google Chrome) as tools: read pages, click, fill forms, take screenshots, record video.
- Git in the chat: changes, commits with generated messages, branches, pull requests and Actions runs.
- Terminal tabs and the same chat from the Chrome side panel and your phone.

HoverDeck needs VS Code 1.112 or later for the built-in browser tools, and the \`browser\` API proposal enabled — the
status bar's **Enable Browser API** does it in one click.
`;
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
