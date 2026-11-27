/* global Zotero */

'use strict';

/**
 * Telling the user that something they asked for did not happen.
 *
 * Every promise this plugin starts from a click used to end in a catch that
 * did nothing but Zotero.logError(), which is right for the error console and
 * says nothing to the person who clicked. On the Zotero 11 beta that was the
 * whole of #26: the menu entry threw on its first line, and all anyone could
 * report was "nothing happens". So a failure the user started goes through
 * here, which logs it exactly as before and then says so, once, in the place
 * the user is looking:
 *
 *   no graph page yet   a Zotero.ProgressWindow notice over the window the
 *                       action came from -- the corner toast core uses for a
 *                       save. Non-modal: it closes on a click or by itself.
 *   inside a graph tab  the page's status line, in its error state; see
 *                       zgSetError in content/graph.js.
 *   in the item pane    a line of text in the pane; see lib/itemPane.js.
 *
 * The last two are a "surface": `{ win, say(text) }`, where say() puts the
 * line up and answers false when it could not -- a page that never loaded, a
 * pane that could not be built. A surface that cannot say it falls back to the
 * notice over its window, because a failure nobody sees is the thing being
 * fixed. (A surface whose tab has been closed answers true: there is nobody
 * left to tell, and the log has it.)
 *
 * What stays log-only is what nobody asked for at that moment: restoring tabs
 * at startup, retitling a tab, registering the Settings pane. Each of those
 * sites says why beside its catch, and a check in tools/test-cjs-shim.js keeps
 * the list from growing without one.
 */

let l10n = require('./l10n.js');

// How long a notice stays up.
const NOTICE_MS = 10000;
// How long the same words are not put up a second time. One gesture is one
// notice: a page that fails the same way on every slider tick, or a key held
// down, would otherwise stack a column of identical toasts up the side of the
// screen. Short, because it is a burst being folded and not a retry: someone
// who dismissed the notice and tries again a few seconds later has to be told
// again that it did not work.
const BURST_MS = 1500;

let last_ = { text: null, at: 0 };

/**
 * An action the user started has failed.
 *
 * @param {Window|Object} where  the window the action came from, or a surface
 *                               ({ win, say(text) -> Boolean }) to say it on
 * @param {String}        what   the message id of the sentence to show, which
 *                               takes the error as { $message }
 * @param {*}             error
 * @returns {String} what the user was told
 */
function failed(where, what, error) {
	try {
		Zotero.logError(error);
	}
	catch (e) { /* the notice below is still worth trying */ }

	let text = describe(what, error);
	let win = where;
	if (where && typeof where.say === 'function') {
		try {
			if (where.say(text) !== false) return text;
		}
		catch (e) {
			log(e);
		}
		win = where.win;
	}
	notice(win, text);
	return text;
}

/** The sentence, with the error's own words in it. */
function describe(what, error) {
	return l10n.t(what, { message: messageOf(error) });
}

function messageOf(error) {
	if (error && typeof error.message === 'string' && error.message) return error.message;
	let s = String(error);
	return s && s !== 'undefined' ? s : '?';
}

/**
 * A corner notice over `win`, or over the main window when there is no usable
 * one -- which is exactly the #26 case, where the window was what had gone
 * missing.
 */
function notice(win, text) {
	let now = module.exports.clock();
	if (last_.text === text && now - last_.at < BURST_MS) return;
	last_ = { text, at: now };
	try {
		// ProgressWindow opens its toast with window.openDialog() and stacks it
		// against that window's corner. Anything that is not a chrome window
		// (undefined, a stub, a window already closing) is left out, and
		// ProgressWindow falls back to Zotero.getMainWindow() itself.
		let opts = { closeOnClick: true };
		if (win && typeof win.openDialog === 'function' && !win.closed) opts.window = win;
		let pw = new Zotero.ProgressWindow(opts);
		pw.changeHeadline(l10n.t('notice-title'));
		// addDescription() turns `<a ...>...</a>` in its text into a link, and
		// puts everything else in as a text node -- so entities would arrive
		// as "&lt;", and the one thing to defuse is that pattern.
		pw.addDescription(defuseLinks(text));
		pw.show();
		pw.startCloseTimer(NOTICE_MS);
	}
	catch (e) {
		// No toast to be had -- Zotero half shut down, or a build of it without
		// ProgressWindow. The failure itself is already in the console.
		log(e);
	}
}

/** An error message is not markup: a word joiner after the "<" keeps
 *  Zotero.Utilities.parseMarkup() from reading `<a ...>` in one as a link,
 *  and changes nothing anyone can see. */
function defuseLinks(text) {
	return String(text).replace(/<a /g, '<⁠a ');
}

function log(e) {
	try {
		Zotero.logError(e);
	}
	catch (_) { /* nowhere left to say it */ }
}

/** For the checks: forget the last notice, so one check's toast does not
 *  swallow the next one's. */
function reset() {
	last_ = { text: null, at: 0 };
}

module.exports = {
	failed, describe, reset, NOTICE_MS, BURST_MS,
	// The time the burst is measured in. A property so the checks can move
	// it: this module's Date is its own sandbox's, out of their reach.
	clock: () => Date.now(),
};
