# HoverDeck news

<!--
This file is shown in the HoverDeck chat whenever a chat is empty; the AI
Browser build reads NEWS.md instead (chosen by the build in chatView.ts,
`_readNews`). Same format as NEWS.md: the first paragraph below is the
introduction, then the features listed under it, then the newest six entries
as "What's new", smallest print. Keep the introduction to one or two sentences.

A feature is a bullet before the first entry, written exactly
`- $(codicon) **Name** — one short line`; any other bullet there is skipped.

An entry is a level-two heading — `## <version> — <date>` — followed by a
bullet list; inline `code`, **bold**, *italics* and [links](https://…) work.
Newest first. HoverDeck has no Connect commands and writes nothing into your
repository, so do not announce features of the AI Browser build here (Connect
Claude Code / Codex / Gemini, Add … to Claude Code, Share Tab with one agent,
Copy Recording Prompt). The format is read by src/chat/news.ts — see "The AI
Browser chat" in CLAUDE.md.
-->

One deck for all your AI agents: Claude Code, Codex, Gemini CLI, OpenCode, Pi and OpenRouter models in one chat, with VS Code's browser, Git and terminals beside them — and nothing written into your repository.

- $(hubot) **Every agent in one chat** — Claude Code, Codex, Gemini CLI, OpenCode, Pi and OpenRouter, each with the browser tools from its first message; add OpenRouter or local models in Chat Settings.
- $(globe) **A browser your agents can use** — open a page with the globe; agents read it, click through it, fill forms and take screenshots, in VS Code's browser or Google Chrome.
- $(terminal) **Terminal tabs** — open a shell or an agent's own CLI in a chat tab; pin it to a conversation and its agent reads it and, with your approval, types.
- $(coffee) **Keep awake** — use the cup at the top to prevent sleep for a set time or until all agents and sub-agents finish.
- $(eye) **View Mode** — choose Minimal, Compact or Standard in the approval menu to control how much work, tool use and thinking is shown.
- $(files) **Chats across tabs and windows** — open chats with the top +; right-click tabs to move them between the sidebar, tabs and windows with drafts and attachments intact.
- $(git-commit) **Commits and branches** — bottom right: commit with a generated message, switch branches or create one with a generated name.
- $(device-camera-video) **Record video** — record browser tabs from their toolbar, up to 4K, into the chat.
- $(location) **Page markers** — pin notes to page elements and send them to the agent as one prompt.
- $(settings-gear) **Chat Settings** — use the gear at the top to edit prompts for commit messages, branch names and chat titles, or clean up temporary files.

## 1.0.6 — 2026-11-22

- **When a turn ran** — beside each turn's tokens: its start and end time and how long ago, refreshed as time passes.
- **Easier to find** — search Open VSX for "hover deck", or for Claude Code, Codex, local LLM or DeepSeek, to find HoverDeck and its entry points.

## 1.0.5 — 2026-11-21

- **Several repositories** — a project folder holding nested repositories gets one Git window: a tab per repository, branches on the left, changes and commits on the right, opened by hovering the footer.
- **Copy in visualizations** — Cmd+C (Ctrl+C) copies what you select inside a chat visualization.

## 1.0.2 — 2026-11-21

- The empty chat now opens with the HoverDeck icon instead of a globe.

## 1.0.0 — 2026-11-20

- **Skills over MCP** — agents can list your toolbar skills and workflows with `skill_list`, load the one that fits with `skill_get` and follow it themselves, under their usual approvals; switch it off in Chat Settings → MCP → Skills.
- **Drafts** — put a message aside with Save as draft in the send menu (or ⌘/Ctrl+Shift+Enter); Prompts → Drafts brings it back to edit or sends it.
- **Logins in the page** — saved logins now show up in a list right under the sign-in field you click, and the offer to save appears as a small card on the page; nothing sits in the status bar any more.
- **Logins & passkeys in Chat Settings** — search your saved logins, copy a username or password, change, rename or delete them, manage passkeys and the sites never offered to save, import and export, all in one tab.
- **One HoverDeck button on the browser tab** — a single button, a globe with a blue dot, so it is easy to tell apart from AI Browser's when both are installed.
- **Nothing in the status bar** — HoverDeck's menu is **HoverDeck: Menu** in the command palette.
- **A tidier save card** — Save, Not now, Never and … on one line, an × in the corner, and it goes away by itself after 30 seconds.
- **Save offer fixed beside AI Browser** — with both installed, HoverDeck now asks to save the password after you sign in.
- **Close several chats at once** — right-click a chat tab for Close chat, Close other chats and Close all chats; working or pinned chats are asked about once.
- **Continue in terminal tab** — a chat tab's menu can continue the conversation in the agent's own CLI in one of the chat's terminal tabs, beside Continue in VS Code terminal.
- **Favorite sites** — **Add to Favorites…** in the browser tab's menu saves the page; the **Favorites** submenu opens one, and the chat's browser button has **Open from Favorites**, asking whether to open it in the VS Code browser or Google Chrome. Chat Settings → **Favorites** adds, renames, reorders and removes them, and switches an optional **star** beside the browser tab's HoverDeck button: filled when the page is a favorite, outlined when not, one click to add or remove.
- **Agents can upload files** — an agent can put a file into a page's upload field (`browser_upload_file`). In the chat it follows your approval menu (Files in the project / outside the project); files that look like secrets — `.env`, keys, credentials — are always asked about, and an agent outside the chat always asks. Switch the question off in Chat Settings → **Security**.

## 0.9.23 — 2026-11-12

- **HoverDeck for Gemini CLI, OpenCode, Pi and OpenRouter** — small Open VSX listings that install HoverDeck with that agent chosen for new chats. **Default Agent** (`aiBrowser.chat.defaultAgent`) sets the same in Settings; the agent you pick in the chat still wins.
- **Guards against prompt injection** — agents ask before opening a site the conversation has not been to (showing the whole address), do not see your own tabs in your everyday Chrome, cannot type into password or card fields, and are told page text is data, not instructions. Chat Settings → **Security** shows which are on, explains each, and lists the sites agents were allowed to open, each removable; **HoverDeck: Menu** has a Security row.
- **Paste cookies into a page** — for a site that will not sign in inside the editor's browser or a debugging Chrome: copy its cookies from a browser where you are signed in (a Cookie header, Set-Cookie lines, cookies.txt, a cURL command or a JSON export) and choose **Paste Cookies into Page…** in the browser tab's menu or **HoverDeck: Menu**; the page reloads signed in. Agents get `browser_get_cookies` (names only, never values) and `browser_set_cookies`, which works only for the site the tab is on and always asks you first.
- **Meet HoverDeck** — the AI Browser chat under a new name, built around one idea: every agent works inside the chat and its terminal tabs, so nothing is written into your project's `.mcp.json`, `.codex/` or `.gemini/`.
- **Runs beside AI Browser** — both can be installed at once, each with its own chat, commands and MCP server; settings are shared.
- **Bring your chats along** — with AI Browser installed, HoverDeck copies its chat history, toolbar skills and saved logins once, without writing them to disk on the way.
- **Tidy up old entries** — if this project still has AI Browser's entries in `.mcp.json` or `.codex/config.toml`, run **HoverDeck: Remove AI Browser's MCP Entries from Project Configs** from the command palette, so an agent does not see the browser tools twice.
- **Prompts where you are** — Translate Page and Copy Annotation Prompt put their prompt into the message box of the chat in front instead of the clipboard.
- **Badges in recalled messages work** — a message brought back with ↑ shows its file, folder, screenshot and page badges as live badges again, which open on a click and go with the message when it is sent; the draft you were writing is left alone until you edit the recalled one.
- **Deferred messages 2.0** — messages waiting for the agent are cards with their own colour (blue: Send now, yellow: Send later, purple: scheduled) and a cancel button; drag them, or press Alt+↑/↓, to choose which one goes next, and press **Send now** on a waiting one. **Schedule…** in the send menu, or the clock on a card, sends a message at a time you pick (in 15 minutes, tomorrow morning, or any date and time); scheduled messages survive a reload and are listed under **Waiting to send** in Prompts. A toolbar skill's first message can be set to go now or after this turn (the default).
- **Agents can call you** — `chat_alert` shows a system notification (even while VS Code is in front), a warning card in the conversation and plays a sound when an agent needs your answer or a decision; `chat_play_sound` plays one of the chat sounds when you asked for it ("beep when the tests pass"). Both reach VS Code and the Exchange website when it shows that chat.
- **Chat Settings → MCP** — switch off parts of what agents may use through the MCP server: alerts, sounds, chat cards, keep-awake, chat control, video recording, annotations, cookies and the code editor tools. A feature turned off is refused at once and leaves the agent's tool list at its next session.
