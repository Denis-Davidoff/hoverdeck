import type { ChatViewState, ViewToHost } from '../src/chat/chatProtocol';

/** Real layout and pointer events: pins must cost no height and Stop must stay reachable. */
export async function checkComposerControls(frame: HTMLIFrameElement, initial: ChatViewState, received: ViewToHost[]): Promise<void> {
	const doc = frame.contentDocument!;
	const win = frame.contentWindow!;
	const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
	const check = (value: unknown, message: string) => { if (!value) { throw new Error(message); } };
	const event = (target: HTMLElement, name: string) => {
		const e = doc.createEvent('Event'); e.initEvent(name, true, false); target.dispatchEvent(e);
	};
	const base: ChatViewState = {
		...initial, running: true, entries: [], visualizations: {},
		agents: [{ id: 'codex', name: 'Codex', available: true, models: [{ id: 'test', label: 'Test', efforts: [], isDefault: true }] }],
		selection: { agent: 'codex', model: 'test' }, attachments: [],
		access: { tabs: [], chrome: false, terminals: [] },
	};
	const pinned: ChatViewState = {
		...base,
		attachments: [{ id: 'terminal-pin', kind: 'terminal', label: 'Terminal 1', pinned: true, terminalId: 'terminal', terminalStatus: 'running' }],
		access: { chrome: false, terminals: [], tabs: [
			{ id: 'browser', title: 'A long browser tab title', url: 'https://example.test', owner: 'this', focused: true, chrome: false },
		] },
	};
	const show = async (state: ChatViewState) => { win.postMessage({ type: 'state', state }, location.origin); await wait(); };
	for (const width of [320, 540, 900]) {
		frame.style.width = `${width}px`; frame.style.height = '700px';
		await show(base);
		const composer = doc.querySelector<HTMLElement>('.composer')!;
		const height = composer.getBoundingClientRect().height;
		await show(pinned);
		check(Math.abs(composer.getBoundingClientRect().height - height) < 1, `Pins increased composer height at ${width}px: ${height} to ${composer.getBoundingClientRect().height}, input ${doc.querySelector<HTMLElement>('textarea.input')?.style.height}.`);
		check(doc.querySelectorAll('.input-wrap > .attachments .chip').length === 2, 'Browser and terminal are missing from the message input.');
		check(!doc.querySelector('.queue-button'), 'The separate queue button still exists.');
	}
	const input = doc.querySelector<HTMLTextAreaElement>('textarea.input')!;
	const send = doc.querySelector<HTMLButtonElement>('.input-actions .send')!;
	check(send.getAttribute('aria-label') === 'Stop' && !send.disabled, 'A pin hid or disabled Stop.');
	event(send, 'mouseenter'); await wait(240);
	const rows = () => [...doc.querySelectorAll<HTMLButtonElement>('.menu.open .menu-item')];
	check(rows().length === 4, 'Stop hover did not offer four actions.');
	check(rows()[1].disabled && rows()[2].disabled && rows()[3].disabled, 'Pins were treated as sendable content.');
	input.value = 'Follow up'; event(input, 'input'); await wait();
	check(send.getAttribute('aria-label') === 'Stop', 'Typing hid Stop.');
	check(rows().length === 4 && !rows()[1].disabled && !rows()[2].disabled && !rows()[3].disabled, 'Send choices did not update after typing.');
	check(rows()[1].textContent?.includes('Enter') && rows()[2].textContent?.includes('Enter'), 'Send shortcuts are missing.');
	const menuRect = doc.querySelector<HTMLElement>('.menu.open')!.getBoundingClientRect();
	check(menuRect.bottom <= send.getBoundingClientRect().top + 1, 'Send menu did not open above the button.');
	rows()[1].click(); await wait();
	check(received.some(message => message.type === 'send' && message.text === 'Follow up' && message.mode === undefined), 'Immediate send did not reach the host.');
	input.value = 'Later'; event(input, 'input'); event(send, 'mouseenter'); await wait(240);
	rows()[2].click(); await wait();
	check(received.some(message => message.type === 'send' && message.text === 'Later' && message.mode === 'queue'), 'Deferred send did not reach the queue.');
	send.click(); await wait();
	check(received.some(message => message.type === 'stop'), 'Direct click on Stop did not stop the turn.');
	await show({ ...pinned, running: false });
	input.value = 'Idle'; event(input, 'input'); event(send, 'mouseenter'); await wait(240);
	check(rows().length === 3 && rows()[1].disabled && !rows()[2].disabled, 'Idle send menu should offer Send now, an unavailable Send later and Schedule.');
	// Schedule…: the picker opens, a preset posts a queued send with a time.
	rows()[2].click(); await wait();
	const presets = [...doc.querySelectorAll<HTMLButtonElement>('.sched-preset')];
	check(presets.length >= 5 && doc.querySelector('.sched-input'), 'The schedule picker did not open with presets and a time field.');
	const before = Date.now();
	presets[0].click(); await wait();
	const scheduled = received.find(message => message.type === 'send' && message.text === 'Idle' && message.mode === 'queue');
	check(scheduled && scheduled.type === 'send' && typeof scheduled.at === 'number' && scheduled.at >= before + 14 * 60_000, 'The schedule picker did not send with a time.');

	// The waiting cards: one of each kind, their own colours, Cancel on each.
	received.length = 0;
	const at = Date.now() + 90 * 60_000;
	await show({ ...base, pendingSends: [
		{ id: 'a', text: 'Steered in', kind: 'steer', attachments: [], withdrawable: true },
		{ id: 'b', text: 'First later', kind: 'queue', attachments: [] },
		{ id: 'c', text: 'Second later', kind: 'queue', attachments: [] },
		{ id: 'd', text: 'At a time', kind: 'queue', at, attachments: [] },
	] });
	const cards = [...doc.querySelectorAll<HTMLElement>('.pending-send')];
	check(cards.length === 4, `Expected four waiting cards, found ${cards.length}.`);
	check(cards[0].classList.contains('steer') && cards[1].classList.contains('queue') && cards[3].classList.contains('scheduled'), 'Card kinds are wrong.');
	const border = (card: HTMLElement) => win.getComputedStyle(card).borderLeftColor;
	check(border(cards[0]) !== border(cards[1]) && border(cards[1]) !== border(cards[3]), `The three kinds share a colour: ${border(cards[0])}, ${border(cards[1])}, ${border(cards[3])}.`);
	check(cards.every(card => card.querySelector('.pending-remove')), 'A waiting card has no Cancel.');
	check(cards[1].querySelector('.pending-status')?.textContent?.includes('Next'), 'The first queued card does not say it is next.');
	check(cards[3].querySelector('.pending-status[data-at]'), 'The scheduled card does not show its time.');
	check(!cards[0].querySelector('.pending-grip') && cards[1].querySelector('.pending-grip') && cards[1].draggable, 'Only queued cards should be draggable.');
	for (const card of cards) {
		const remove = card.querySelector<HTMLElement>('.pending-remove')!;
		const rect = remove.getBoundingClientRect();
		check(rect.width > 0 && doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.pending-remove') === remove, 'A Cancel button is covered or off screen.');
	}
	cards[2].querySelector<HTMLElement>('.pending-remove')!.click(); await wait();
	check(received.some(message => message.type === 'unqueue' && message.id === 'c'), 'Cancel did not reach the host.');
	// Alt+↑ on the second queued card moves it before the first.
	const grip = cards[2].querySelector<HTMLElement>('.pending-grip')!;
	grip.dispatchEvent(new (win as unknown as typeof globalThis).KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
	await wait();
	check(received.some(message => message.type === 'queueAction' && message.id === 'c' && message.action === 'move' && message.before === 'b'), 'Alt+Up did not move the card.');
	cards[1].querySelector<HTMLElement>('.pending-now')!.click(); await wait();
	check(received.some(message => message.type === 'queueAction' && message.id === 'b' && message.action === 'sendNow'), 'Send now on a queued card did not reach the host.');
	cards[3].querySelector<HTMLElement>('.pending-when')!.click(); await wait();
	doc.querySelector<HTMLElement>('.sched-clear')!.click(); await wait();
	check(received.some(message => message.type === 'queueAction' && message.id === 'd' && message.action === 'unschedule'), 'Taking the time away did not reach the host.');
}
