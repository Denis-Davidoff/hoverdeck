# HoverDeck — one deck for all your AI agents

**Claude Code, Codex, Gemini CLI, OpenCode, Pi and OpenRouter (or a local Ollama / LM Studio
model) in one chat inside VS Code — with a real browser the agent can see and drive, Git,
GitHub and terminal tabs beside it.** HoverDeck drives the CLIs you already have installed, on
your own subscription and sign-in; there is no extra account and no proxy in between.

> **Coming from AI Browser?** HoverDeck is its successor for the chat, the Chrome side panel and
> the Exchange website. On first start your `aiBrowser.*` settings are copied to `hoverdeck.*`
> where those are unset. AI Browser (`DenysDavydov.tab-browser-ultimate`) is frozen at 1.0.0 and
> keeps the **Connect** entries for agents running outside a chat; the two can be installed side
> by side.

## What you get

- 💬 **A chat for every agent.** Up to 10 conversations as tabs (30 if you raise the limit),
  grouped by project, each working on while you read another. Model and effort pickers come from
  the CLI itself; plan limits and context fill are always in sight, and one click compacts.
- ✅ **Approvals in the chat.** Every question an agent asks — run a command, edit a file, use the
  browser — is a card in the conversation, with **Auto / Ask / Deny** per category. Agents can ask
  you multiple-choice questions and wait for the answer.
- 🌐 **A browser your agent shares with you.** VS Code's built-in browser or Google Chrome, driven
  over the Chrome DevTools Protocol: snapshot, read, click, type, fill, scroll, wait, screenshot,
  upload files, read the console — inside iframes too. Pick an element on the page and attach it
  to your message with its markup and the CSS that applies to it.
- 🛡️ **Guards against prompt injection**, each switchable in **Chat Settings → Security**: agents
  ask before opening a site the conversation has not been to, cannot type into password or card
  fields, see only their own tabs in your Chrome profile, and are told that page text is data.
- ⌨️ **Terminal tabs.** A real shell, or an agent's own CLI, as a tab in the chat. Pin it to a
  conversation and its agent can read the screen and — after you approve each input — type into it.
  **Continue in terminal tab** moves a conversation into the agent's CLI.
- 🧩 **Workflows.** Buttons above the message box that send a prompt, a chain of prompts with
  checks between them, shell steps, routes and decisions — run in the chat or quietly in the
  background, with the result on your clipboard.
- 🌿 **Git and GitHub.** Branches, commit (with a message the agent writes) and push from the chat;
  a GitHub tab with your pull requests, their checks and Actions runs, a bell when a run ends, and
  one-click Create PR and Merge. Work in a separate copy of a GitHub repository without touching
  your own checkout.
- 🔑 **Saved logins and passkeys** in VS Code's secret storage: offered under the sign-in field,
  saved only after a sign-in that worked, imported from Chrome, Firefox, Safari, Bitwarden or
  1Password. No tool ever hands a password to an agent.
- 📍 **More around the page:** annotation markers your agent reads, silent video recording,
  translating a page in place with your own agent, pasting cookies from another browser, favorite
  sites.
- 📱 **Beyond the editor:** the same chat in a **Chrome side panel** on the same computer, and —
  opt-in, end-to-end encrypted — on the **Exchange website** from your phone.
- 🎙️ **Voice messages** on macOS 26, transcribed on the device.
- 🔌 **A local MCP server** (loopback only, a token per workspace) gives the chat's agents the
  browser, editor, chat and terminal tools — nothing to configure.

## Getting started

1. Install HoverDeck from [Open VSX](https://open-vsx.org/extension/DenysDavydov/hoverdeck), or
   install [`hoverdeck.vsix`](https://github.com/Denis-Davidoff/hoverdeck/raw/main/hoverdeck.vsix)
   with **Extensions: Install from VSIX…** (the VS Code Marketplace does not accept extensions that
   use API proposals).
2. Have at least one agent installed: the `claude`, `codex`, `gemini`, `opencode` or `pi` CLI, or
   an OpenRouter key / a local Ollama or LM Studio server (**Chat Settings → OpenRouter**).
3. Open the **HoverDeck** chat in the secondary (right) side bar and send a message.
4. For pages inside the editor, run **HoverDeck: Enable Integrated Browser API** once and quit and
   reopen the editor. Google Chrome works without this step.

Everything else is in **HoverDeck: Menu** in the command palette.

## Editor support

The chat needs VS Code 1.106 or newer (or a fork based on it); browser tabs inside the editor
need the `browser` API, which only some editors ship. Google Chrome works everywhere.

| Editor | Browser tab in the editor | Google Chrome |
|---|---|---|
| VS Code 1.112+ | ✅ | ✅ |
| VSCodium | ✅ | ✅ |
| Devin (Windsurf) | ✅ | ✅ |
| Cursor, Antigravity, Kiro, Trae | — | ✅ |

Checked in shipped builds on 2026-09-09; newer releases may differ.

## Agent-specific listings

To start new chats with one agent by default, install **HoverDeck for Gemini CLI**, **for
OpenCode**, **for Pi** or **for OpenRouter, Ollama & LM Studio** from Open VSX — each installs
HoverDeck and sets `hoverdeck.chat.defaultAgent`. The agent you last picked still wins.

## Use from another extension

```ts
await vscode.commands.executeCommand('hoverdeck.api.open', 'http://localhost:3000', {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
});
```

A string is relayed exactly as given; a `vscode.Uri` works too. HoverDeck also offers to open
`localhost`-like addresses in the editor; every other address still goes to your system browser.

## More

- [Changelog](CHANGELOG.md) · [Privacy Policy](PRIVACY.md) ·
  [Chrome side panel](chrome-extension/README.md)
- The full reference — every setting, command and design decision — is [CLAUDE.md](CLAUDE.md).
- Issues: [github.com/Denis-Davidoff/hoverdeck/issues](https://github.com/Denis-Davidoff/hoverdeck/issues)

## License

Outside `exchange-server/`, MIT, with both copyright lines — Microsoft's, for the forked and copied
code, and this project's. The per-file MIT headers on everything copied from vscode stay where they
are. One file, `src/logins/loginFormScript.ts`, is ported from Firefox's password manager and stays
under the Mozilla Public License 2.0 — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Exchange Server is licensed separately under [Elastic License 2.0](exchange-server/LICENSE).
Personal and internal company use are free. Providing its substantial functionality to third
parties as a hosted or managed service, whether paid or free, requires separate permission. See
[licensing scope and exceptions](exchange-server/LICENSING.md). Previously granted MIT rights and
third-party licenses remain in effect.
