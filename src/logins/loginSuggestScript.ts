/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { loginsBinding } from './loginFormScript';

/*
 * The in-page half of HoverDeck's logins: a list of saved logins under the
 * field the user is in, and the save offer as a card at the top of the page.
 * It replaced the status bar item, which with AI Browser installed beside it
 * meant two key items in one status bar.
 *
 * MIT, a file of its own, so nothing lands in the MPL-2.0 `loginFormScript.ts`.
 * It runs in the same isolated world and reports through the same binding,
 * which that script leaves in place for exactly this.
 *
 * What it may show and what it may not:
 *
 * - **Usernames and site titles, never a password.** The host pushes choices
 *   as `{ id, username, detail }`; a pick reports the id, and the host fills
 *   the field through the form script with the password it alone holds.
 * - **Inside a closed shadow root**, styled through a constructed stylesheet
 *   (a `<style>` element would meet the page's CSP). The page can see that a
 *   host element exists, not what it holds.
 * - **Trusted input only.** A page dispatching clicks cannot pick a login or
 *   answer the offer; only the user's own pointer and keys do.
 * - **Pressing inside the list keeps the focus in the field** (`pointerdown`
 *   is prevented), so a fill lands where the user was typing.
 *
 * `String.raw`, for the reasons written above `loginFormSource`: no backtick
 * anywhere inside, and no dollar-brace but the three interpolations.
 */

export function loginSuggestApiName(owner: string): string {
	return `__hoverdeckSuggest_${owner}`;
}

export function loginSuggestSource(owner: string): string {
	return String.raw`(() => {
'use strict';
const OWNER = ${JSON.stringify(owner)};
const notify = globalThis[${JSON.stringify(loginsBinding)}];
if (typeof notify !== 'function') { return; }
const registry = Array.isArray(globalThis.__hoverdeckSuggestRegistry)
  ? globalThis.__hoverdeckSuggestRegistry : (globalThis.__hoverdeckSuggestRegistry = []);
for (const off of registry.splice(0)) { try { off(); } catch (e) { /* already gone */ } }
let stopped = false;
const send = (message) => {
  if (stopped) return;
  try { notify(JSON.stringify(message)); } catch (e) { /* the session is gone */ }
};
const teardown = [];
const listen = (target, type, handler, options) => {
  target.addEventListener(type, handler, options);
  teardown.push(() => target.removeEventListener(type, handler, options));
};

const CSS = [
  ':host { all: initial; }',
  '.box { position: fixed; z-index: 2147483647; box-sizing: border-box; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;',
  '  color: #1f1f1f; background: #ffffff; border: 1px solid rgba(0,0,0,.14); border-radius: 10px;',
  '  box-shadow: 0 10px 28px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08); overflow: hidden; }',
  '@media (prefers-color-scheme: dark) { .box { color: #ececec; background: #252526; border-color: rgba(255,255,255,.14); } }',
  '.head { display: flex; align-items: center; gap: 6px; padding: 7px 10px 5px; font-size: 11px; opacity: .7; }',
  '.mark { width: 14px; height: 14px; border-radius: 4px; background: linear-gradient(135deg, #5b8cff, #8f5bff); flex: none; }',
  '.row { display: flex; flex-direction: column; gap: 1px; padding: 7px 12px; cursor: pointer; border: 0; background: none;',
  '  width: 100%; text-align: left; color: inherit; font: inherit; }',
  '.row .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.row .detail { font-size: 11px; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.row.on, .row:hover { background: rgba(91,140,255,.16); }',
  '.foot { border-top: 1px solid rgba(127,127,127,.22); }',
  '.foot .row { flex-direction: row; font-size: 12px; opacity: .85; padding: 6px 12px; }',
  '.card { top: 12px; right: 12px; width: max-content; min-width: 260px; max-width: calc(100vw - 24px); padding: 12px 14px; }',
  '.card .title { font-weight: 600; margin-bottom: 2px; padding-right: 22px; }',
  '.card .x { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px;',
  '  background: none; color: inherit; opacity: .6; cursor: pointer; font: 16px/22px system-ui, sans-serif; text-align: center; }',
  '.card .x:hover { opacity: 1; background: rgba(127,127,127,.18); }',
  '.card .who { font-size: 12px; opacity: .75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 10px; }',
  '.card .actions { display: flex; flex-wrap: nowrap; gap: 6px; white-space: nowrap; }',
  '.btn.dots { padding: 4px 8px; letter-spacing: 1px; }',
  '.btn { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; color: inherit;',
  '  background: rgba(127,127,127,.14); border: 1px solid rgba(127,127,127,.25); }',
  '.btn.primary { background: #4f7cff; border-color: #4f7cff; color: #fff; }',
  '.btn:hover { filter: brightness(1.08); }',
].join('\n');

// The host's own look is pinned inline with !important, which outranks any
// rule of the page's, so the page cannot make the list or the card invisible
// and lure a click onto it (clickjacking). What it can still do from outside
// (cover it, fade an ancestor) is checked at the click: see genuine().
const HOST_STYLE = [
  ['all', 'initial'], ['display', 'block'], ['position', 'fixed'], ['inset', 'auto'],
  ['z-index', '2147483647'], ['opacity', '1'], ['visibility', 'visible'], ['pointer-events', 'auto'],
  ['transform', 'none'], ['filter', 'none'], ['clip-path', 'none'], ['mask', 'none'],
  ['mix-blend-mode', 'normal'], ['contain', 'none'], ['width', '0'], ['height', '0'], ['overflow', 'visible'],
];
function pinHost(host) {
  for (const [name, value] of HOST_STYLE) host.style.setProperty(name, value, 'important');
}
// How long a list or card must have been on screen before a click on it counts.
const settleMs = 350;
function genuine(e, view, target) {
  if (!e.isTrusted || !view || !view.host.isConnected) return false;
  if (performance.now() - view.shownAt < settleMs) return false;
  // The page may have rewritten the host's inline style since it was shown.
  pinHost(view.host);
  // A click from the keyboard (Enter or Space on a focused button) has no point.
  if (e.detail !== 0) {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (hit !== view.host) return false;
    // The row clicked must be drawn at its own size and under the pointer: an
    // ancestor scaled, zoomed or clipped could shrink it to a dot under a lure.
    if (target) {
      const r = target.getBoundingClientRect();
      if (r.width < 24 || r.height < 12) return false;
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return false;
    }
  }
  for (let node = view.host; node && node.nodeType === 1; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility !== 'visible' || Number(style.opacity) < 0.95) return false;
    if (style.filter !== 'none' || style.mixBlendMode !== 'normal') return false;
    if (style.transform !== 'none' || style.clipPath !== 'none') return false;
    if (style.zoom && style.zoom !== '1' && style.zoom !== 'normal') return false;
  }
  return true;
}

function makeHost() {
  const host = document.createElement('hoverdeck-logins');
  pinHost(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  if (typeof CSSStyleSheet === 'function') {
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); shadow.adoptedStyleSheets = [sheet]; }
    catch (e) { const s = document.createElement('style'); s.textContent = CSS; shadow.append(s); }
  } else { const s = document.createElement('style'); s.textContent = CSS; shadow.append(s); }
  const box = document.createElement('div');
  box.className = 'box';
  shadow.append(box);
  return { host, box, shownAt: performance.now() };
}
const mount = (host) => { (document.body || document.documentElement).appendChild(host); };
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

// ---- which fields get the list ----
const attr = (node, name) => (node.getAttribute && node.getAttribute(name)) || '';
const visible = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const isPassword = (node) => node.type === 'password' && !/\bnew-password\b/i.test(attr(node, 'autocomplete'));
function scopeOf(node) { return node.form || node.getRootNode(); }
function hasSignInPassword(scope) {
  try { return [...scope.querySelectorAll('input[type=password]')].some(p => isPassword(p) && visible(p)); }
  catch (e) { return false; }
}
function hasAnyPassword() {
  try { return [...document.querySelectorAll('input[type=password]')].some(visible); } catch (e) { return false; }
}
function isLoginField(node) {
  if (!(node instanceof HTMLInputElement) || node.disabled || node.readOnly) return false;
  if (node.type === 'password') return isPassword(node);
  if (!['text', 'email', 'tel'].includes(node.type)) return false;
  const auto = attr(node, 'autocomplete').toLowerCase();
  const named = node.type === 'email' || /\b(username|email|webauthn)\b/.test(auto)
    || /user|login|e-?mail|account|identifier|phone/i.test(attr(node, 'name') + ' ' + node.id);
  if (!named) return false;
  // A username box beside a sign-in password, or the first step of a two-step
  // sign-in with no password on the page yet. A search box named "user" in a
  // page with a password elsewhere does not qualify.
  return hasSignInPassword(scopeOf(node)) || !hasAnyPassword();
}

// ---- the list under the field ----
let choices = [];
let labels = { title: '', other: '', manage: '' };
let list = null;
let anchor = null;
let active = -1;
let dismissedFor = null;
// A pick fills the fields and moves the focus between them; that focus is the
// fill's, not the user's, so the list stays closed for a moment after it.
let pickedAt = -Infinity;
const pickQuietMs = 1500;
const justPicked = () => performance.now() - pickedAt < pickQuietMs;

function hideList() {
  if (list) { list.host.remove(); list = null; }
  anchor = null;
  active = -1;
}
function place() {
  if (!list || !anchor) return;
  if (!anchor.isConnected || !visible(anchor)) { hideList(); return; }
  const r = anchor.getBoundingClientRect();
  const width = Math.max(240, Math.min(r.width, 420));
  const left = Math.max(8, Math.min(r.left, innerWidth - width - 8));
  const below = innerHeight - r.bottom;
  list.box.style.width = width + 'px';
  list.box.style.left = left + 'px';
  if (below < 180 && r.top > below) {
    list.box.style.top = '';
    list.box.style.bottom = (innerHeight - r.top + 4) + 'px';
  } else {
    list.box.style.bottom = '';
    list.box.style.top = (r.bottom + 4) + 'px';
  }
}
function rows() { return list ? [...list.box.querySelectorAll('.row')] : []; }
function highlight(index) {
  const all = rows();
  active = all.length ? (index + all.length) % all.length : -1;
  all.forEach((row, i) => row.classList.toggle('on', i === active));
}
function act(row) {
  const pick = row.dataset.pick;
  const action = row.dataset.action;
  hideList();
  if (pick) { pickedAt = performance.now(); send({ type: 'suggestPick', id: pick }); }
  else if (action) send({ type: 'suggestAction', action });
}
function row(cls, name, detail, data) {
  const button = el('button', cls);
  button.type = 'button';
  button.tabIndex = -1;
  button.append(el('span', 'name', name));
  if (detail) button.append(el('span', 'detail', detail));
  Object.assign(button.dataset, data);
  button.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
  button.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  button.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (genuine(e, list, button)) act(button); });
  return button;
}
function showList(field) {
  if (!choices.length || stopped) { hideList(); return; }
  if (dismissedFor === field) return;
  if (!list) { list = makeHost(); mount(list.host); list.shownAt = performance.now(); }
  anchor = field;
  const box = list.box;
  box.replaceChildren();
  const head = el('div', 'head');
  head.append(el('span', 'mark'), el('span', '', labels.title));
  box.append(head);
  for (const choice of choices) {
    box.append(row('row', choice.username, choice.detail, { pick: choice.id }));
  }
  const foot = el('div', 'foot');
  if (labels.other) foot.append(row('row', labels.other, '', { action: 'other' }));
  if (labels.manage) foot.append(row('row', labels.manage, '', { action: 'manage' }));
  if (foot.childNodes.length) box.append(foot);
  active = -1;
  place();
}

listen(document, 'focusin', e => {
  if (!e.isTrusted) return;
  const target = e.composedPath()[0];
  if (isLoginField(target)) {
    if (justPicked()) { dismissedFor = target; return; }
    dismissedFor = null; showList(target);
  }
  else if (!list || !list.host.contains(target)) hideList();
}, true);
listen(document, 'pointerdown', e => {
  if (!e.isTrusted) return;
  const target = e.composedPath()[0];
  if (list && e.composedPath().includes(list.host)) return;
  if (target === anchor) { dismissedFor = null; showList(target); return; }
  if (isLoginField(target)) { dismissedFor = null; showList(target); return; }
  hideList();
}, true);
listen(document, 'focusout', e => {
  if (!e.isTrusted || e.composedPath()[0] !== anchor) return;
  setTimeout(() => { if (anchor && document.activeElement !== anchor) hideList(); }, 0);
}, true);
listen(document, 'input', e => {
  if (e.isTrusted && list && e.composedPath()[0] === anchor) { dismissedFor = anchor; hideList(); }
}, true);
listen(document, 'keydown', e => {
  if (!e.isTrusted || !list || e.composedPath()[0] !== anchor) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); highlight(active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); highlight(active - 1); }
  else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopPropagation(); act(rows()[active]); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismissedFor = anchor; hideList(); }
}, true);
listen(globalThis, 'scroll', () => place(), true);
listen(globalThis, 'resize', () => place(), true);

// ---- the save offer ----
let card = null;
let cardTimer = 0;
// The card goes on its own after this long, as if left unanswered: the
// offer itself stays with the host until its own timer ends it.
const cardLifetimeMs = 30000;
function hideOffer() {
  if (cardTimer) { clearTimeout(cardTimer); cardTimer = 0; }
  if (card) { card.host.remove(); card = null; }
}
function showOffer(offer) {
  hideOffer();
  if (stopped || !offer || typeof offer.token !== 'string') return;
  const view = card = makeHost();
  const box = view.box;
  box.classList.add('card');
  const button = (text, action, cls, tip) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (tip) { b.title = tip; b.setAttribute('aria-label', tip); }
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      if (!genuine(e, view, b) || card !== view) return;
      if (action !== 'more') hideOffer();
      send({ type: 'offerAnswer', token: offer.token, action });
    });
    return b;
  };
  box.append(button('\u00d7', 'later', 'x', offer.close || offer.later));
  box.append(el('div', 'title', offer.title), el('div', 'who', offer.who));
  const actions = el('div', 'actions');
  actions.append(button(offer.primary, offer.kind === 'update' ? 'update' : 'save', 'btn primary'));
  actions.append(button(offer.later, 'later', 'btn'));
  actions.append(button(offer.never, 'never', 'btn', offer.neverTitle));
  actions.append(button('\u2026', 'more', 'btn dots', offer.more));
  box.append(actions);
  cardTimer = setTimeout(hideOffer, cardLifetimeMs);
  mount(view.host);
  view.shownAt = performance.now();
}

const api = {
  setChoices(next, nextLabels) {
    choices = Array.isArray(next) ? next.slice(0, 20).map(c => ({
      id: String(c.id), username: String(c.username).slice(0, 200), detail: String(c.detail || '').slice(0, 200),
    })) : [];
    if (nextLabels) labels = { title: String(nextLabels.title || ''), other: String(nextLabels.other || ''), manage: String(nextLabels.manage || '') };
    if (!choices.length) { hideList(); return; }
    const focused = document.activeElement;
    if (list && anchor) showList(anchor);
    else if (focused && isLoginField(focused) && dismissedFor !== focused && !justPicked()) showList(focused);
  },
  showOffer(offer) { showOffer(offer); },
  hideOffer() { hideOffer(); },
  uninstall(who) {
    if (who !== OWNER || stopped) return;
    stopped = true;
    hideList();
    hideOffer();
    for (const off of teardown.splice(0)) { try { off(); } catch (e) { /* already gone */ } }
    try { delete globalThis[${JSON.stringify(loginSuggestApiName(owner))}]; } catch (e) { /* gone */ }
  },
};
registry.push(() => api.uninstall(OWNER));
Object.defineProperty(globalThis, ${JSON.stringify(loginSuggestApiName(owner))}, { value: api, configurable: true });
})();`;
}
