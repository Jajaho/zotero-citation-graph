/**
 * The menu icons.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Eighteen of the nineteen icons below are Copyright (c) Corporation for Digital
 * Scholarship, taken from Zotero (AGPL-3.0) and carried here under that same
 * licence; `isolate` is this plugin's own drawing. See THIRD-PARTY-NOTICES.md
 * section 2 for the file-by-file provenance table.
 *
 * Zotero's own icon set, inlined. Every entry below but one is the path data of
 * a file under Zotero's chrome/skin/default/zotero/{16,20}/universal/, copied
 * verbatim so that a menu in this plugin and a menu in the library window are
 * drawn from the same shapes; redrawing them by hand would put a near-miss next
 * to the real thing. The exception is `isolate`, which is drawn here because
 * Zotero has no icon for what it means -- see the comment on the entry.
 *
 * These are Zotero's own artwork, NOT Mozilla's Acorn set -- an earlier version
 * of this comment claimed otherwise and was wrong. It matters: Acorn is MPL-2.0
 * marked "Incompatible With Secondary Licenses", which could not be carried
 * under this plugin's AGPL, whereas Zotero's own icons can. Checked against
 * FirefoxUX/acorn-icons, which has no icon of any of these names and whose
 * nearest equivalents (edit-16, filter-16, pin-16) are different path data in a
 * different drawing style.
 *
 * Copied rather than referenced because this page is a content docshell at a
 * resource:// URL: chrome:// is not reachable from here, and an <img> would need
 * a second round trip per entry anyway. Inlining also gets theming for free --
 * Zotero's files paint with `context-fill`, which only means anything to a
 * chrome image loader, so the fill is swapped for currentColor and the icon
 * follows the menu's text colour in both light and dark.
 *
 * `fill-rule="evenodd"` sits on the root and is inherited: the files that
 * declare it need it for their holes, and the ones that do not are simple
 * enough that the two rules agree.
 *
 * Loaded as a plain <script> and published as a global; the content page has no
 * module loader. tools/test-cjs-shim.js evaluates this same file.
 */
(function (global) {
	'use strict';

	var SVGNS = 'http://www.w3.org/2000/svg';

	/**
	 * name -> [ viewBox size, [ path data ] ].
	 *
	 * The names are this plugin's, not Zotero's: what an entry DOES is the
	 * stable half, and the file it happens to be drawn from is not. The mapping
	 * is in the comment on each one.
	 */
	var ICONS = {
		// 16/show-item -- the arrow back into the library, as Zotero's own "Show in Library" uses.
		'show-item': [16, [
			'M0 4.50001L4.50001 0L5.20703 0.70719L1.91422 4H10.5C13.5376 4 16 6.46243 16 9.5C16 12.5376 13.5376 15 10.5 15H8V14H10.5C12.9853 14 15 11.9853 15 9.5C15 7.01472 12.9853 5 10.5 5H1.91421L5.20703 8.29282L4.49999 9L0 4.50001Z',
		]],
		// 16/new-tab
		'new-tab': [16, [
			'M14 2H10.5H9C8.44772 2 8 2.44772 8 3V4C8 4.55228 7.55228 5 7 5H1V13C1 13.5523 1.44772 14 2 14H14C14.5523 14 15 13.5523 15 13V3C15 2.44772 14.5523 2 14 2ZM14 1H10.5H9H2C0.895431 1 0 1.89543 0 3V13C0 14.1046 0.895431 15 2 15H14C15.1046 15 16 14.1046 16 13V3C16 1.89543 15.1046 1 14 1ZM2 2H7.26756C7.09739 2.29417 7 2.63571 7 3V4H1V3C1 2.44772 1.44772 2 2 2ZM8.70711 9L13.0002 4.70696L13.0002 6.94975H14V3L10.0503 3V3.99985L12.293 3.99985L8 8.29289L8.70711 9Z',
		]],
		// 16/open-link
		'open-link': [16, [
			'M14 7V12C14 12.5304 13.7893 13.0391 13.4142 13.4142C13.0391 13.7893 12.5304 14 12 14H4C3.46957 14 2.96086 13.7893 2.58579 13.4142C2.21071 13.0391 2 12.5304 2 12V4C2 3.46957 2.21071 2.96086 2.58579 2.58579C2.96086 2.21071 3.46957 2 4 2H9V3H4C3.73478 3 3.48043 3.10536 3.29289 3.29289C3.10536 3.48043 3 3.73478 3 4V12C3 12.2652 3.10536 12.5196 3.29289 12.7071C3.48043 12.8946 3.73478 13 4 13H12C12.2652 13 12.5196 12.8946 12.7071 12.7071C12.8946 12.5196 13 12.2652 13 12V7H14ZM11 1V2H13.293L7.646 7.646L8.354 8.354L14 2.707V5H15V1H11Z',
		]],
		// 20/save-to-zotero -- the Z in a box, the connector's own gesture.
		'add-to-zotero': [20, [
			'M3.25 2C2.55964 2 2 2.55964 2 3.25V16.75C2 17.4404 2.55964 18 3.25 18H16.75C17.4404 18 18 17.4404 18 16.75V3.25C18 2.55964 17.4404 2 16.75 2H3.25ZM3.25 3.25H16.75V16.75H3.25V3.25ZM7.99147 13.7179L13.8467 6.02513V5H6.23933V6.28154H11.7944L5.94019 13.9739V15H14.0598V13.7179H7.99147Z',
		]],
		// A spotlight -- the one entry here that is not Zotero's, and the one
		// whose meaning Zotero has no drawing for. Isolating puts a
		// neighbourhood in the light and leaves the rest of the collection in the
		// dark, which is what a lamp and a pool of light say; the funnel this
		// borrowed from filter.svg says the rest was thrown away, which is the one
		// thing isolating does not do. Drawn on the same 16px grid at the same
		// stroke width as the rest so that it sits beside them, and left hollow
		// between the two beam edges by the fill rule on the root. Where it came
		// from: THIRD-PARTY-NOTICES.md section 2.
		'isolate': [16, [
			'M2.4 1.6L13.04 11.2C14.38 12.24 13.63 13.54 11.32 14.21C9.01 14.87 5.89 14.68 4.12 13.76C2.36 12.84 2.52 11.5 4.51 10.66ZM3.42 3.32L10.71 10.24C8.98 9.87 6.92 9.93 5.31 10.38Z',
		]],
		// 16/view -- the eye, for putting back what isolation dimmed.
		'show-all': [16, [
			'M8.00003 12C5.20911 12 2.79758 10.3664 1.67338 8C2.79758 5.6336 5.20911 4 8.00003 4C10.7909 4 13.2025 5.6336 14.3267 8C13.2025 10.3664 10.7909 12 8.00003 12ZM8.00003 3C11.3574 3 14.2317 5.06817 15.4185 8C14.2317 10.9318 11.3574 13 8.00003 13C4.64265 13 1.76832 10.9318 0.581543 8C1.76832 5.06817 4.64265 3 8.00003 3ZM10 8C10 9.10457 9.10457 10 8 10C6.89543 10 6 9.10457 6 8C6 6.89543 6.89543 6 8 6C9.10457 6 10 6.89543 10 8ZM11 8C11 9.65685 9.65685 11 8 11C6.34315 11 5 9.65685 5 8C5 6.34315 6.34315 5 8 5C9.65685 5 11 6.34315 11 8Z',
		]],
		// 16/plus-circle
		'plus-circle': [16, [
			'M8.5 13C11.5376 13 14 10.5376 14 7.5C14 4.46243 11.5376 2 8.5 2C5.46243 2 3 4.46243 3 7.5C3 10.5376 5.46243 13 8.5 13ZM8.5 14C12.0899 14 15 11.0899 15 7.5C15 3.91015 12.0899 1 8.5 1C4.91015 1 2 3.91015 2 7.5C2 11.0899 4.91015 14 8.5 14ZM9 7H12V8H9V11H8V8H5V7H8V4H9V7Z',
		]],
		// 16/minus-circle
		'minus-circle': [16, [
			'M14 7.5C14 10.5376 11.5376 13 8.5 13C5.46243 13 3 10.5376 3 7.5C3 4.46243 5.46243 2 8.5 2C11.5376 2 14 4.46243 14 7.5ZM15 7.5C15 11.0899 12.0899 14 8.5 14C4.91015 14 2 11.0899 2 7.5C2 3.91015 4.91015 1 8.5 1C12.0899 1 15 3.91015 15 7.5ZM12 7H5V8H12V7Z',
		]],
		// 16/pin
		'pin': [16, [
			'M9.45442 0.747313C8.91526 0.208154 7.99526 0.446553 7.78579 1.1797L7.07966 3.65115L0.896869 6.74255C0.286372 7.04779 0.154333 7.86144 0.636975 8.34408L3.79293 11.5L0 15.2929L9.87947e-05 16L0.707182 16L4.50004 12.2071L7.65592 15.363C8.13856 15.8457 8.9522 15.7136 9.25745 15.1031L12.3488 8.92033L14.8203 8.21421C15.5534 8.00474 15.7918 7.08473 15.2527 6.54558L9.45442 0.747313ZM8.74732 1.45442L14.5456 7.25268L11.8626 8.01924L11.6512 8.07966L11.5528 8.27639L8.36302 14.6559L1.34408 7.63697L7.72361 4.44721L7.92034 4.34885L7.98076 4.13736L8.74732 1.45442Z',
		]],
		// 16/pin-remove
		'unpin': [16, [
			'M0 0.70706L15.293 16L16 15.2928L0.707197 0L0 0.70706ZM10.499 12.6203L9.25753 15.1031C8.95228 15.7136 8.13864 15.8457 7.65599 15.363L4.50008 12.2071L0.707182 16L9.87947e-05 16L0 15.2929L3.79297 11.5L0.637052 8.34408C0.15441 7.86144 0.286449 7.04779 0.896946 6.74255L3.37981 5.50111L4.12517 6.24647L1.34416 7.63697L8.3631 14.6559L9.7536 11.8749L10.499 12.6203ZM11.9132 9.79184L12.3489 8.92033L14.8204 8.2142C15.5535 8.00473 15.7919 7.08473 15.2528 6.54558L9.4545 0.747313C8.91534 0.208154 7.99534 0.446553 7.78587 1.1797L7.07974 3.65115L6.20824 4.0869L6.95359 4.83226L7.72368 4.44721L7.92041 4.34885L7.98084 4.13736L8.74739 1.45442L14.5457 7.25268L11.8627 8.01923L11.6512 8.07966L11.5529 8.27639L11.1678 9.04648L11.9132 9.79184Z',
		]],
		// 20/maximize -- the two corner arrows, opening outwards.
		'zoom-to-fit': [20, [
			'M16.75 7H18V2H13V3.25L15.8661 3.25L11 8.11612L11.8839 9L16.75 4.13389V7ZM4.13389 16.75L9 11.8839L8.11612 11L3.25 15.8661V13H2V17.375V18H2.625H7V16.75H4.13389Z',
		]],
		// 16/library-lookup -- a magnifier over the shelf, for what is not on it.
		'gaps': [16, [
			'M13.8788 16L12.8788 15H11H1V16H13.8788ZM8.35418 14H2V13H3V5H2V3L8.5 0L15 3V5H14V8.35418C13.714 8.03018 13.3764 7.75287 13 7.53513V5H12V7.12602C11.6804 7.04375 11.3453 7 11 7V5H10V7.12602C9.64523 7.21733 9.30951 7.35609 9 7.53513V5H8V8.35418C7.37764 9.05931 7 9.98555 7 11V5H6V13H7V11C7 12.1947 7.52375 13.2671 8.35418 14ZM14 4V3.64L8.5 1.1L3 3.64V4H14ZM5 5H4V13H5V5ZM16.0001 15.2929L15.293 16L12.7383 13.4454C12.2479 13.7946 11.6479 14 11 14C9.34315 14 8 12.6569 8 11C8 9.34315 9.34315 8 11 8C12.6569 8 14 9.34315 14 11C14 11.6479 13.7946 12.2479 13.4454 12.7383L16.0001 15.2929ZM13 11C13 12.1046 12.1046 13 11 13C9.89543 13 9 12.1046 9 11C9 9.89543 9.89543 9 11 9C12.1046 9 13 9.89543 13 11Z',
		]],
		// 16/hide -- the struck-through eye, closing the card the entry above opens.
		'hide': [16, [
			'M2 2.70705L13.2929 14L14 13.2929L2.70705 2L2 2.70705Z',
			'M0.581543 7.99999C1.06648 6.80201 1.83317 5.74823 2.79944 4.92083L3.50889 5.63027C2.73879 6.27498 2.1093 7.0824 1.67338 7.99999C2.79758 10.3664 5.20911 12 8.00003 12C8.57782 12 9.13935 11.93 9.67657 11.7979L10.4851 12.6065C9.70287 12.8619 8.86758 13 8.00003 13C4.64265 13 1.76831 10.9318 0.581543 7.99999Z',
			'M6.32325 4.20211L5.51471 3.39357C6.29703 3.13812 7.13239 3 8.00002 3C11.3574 3 14.2317 5.06818 15.4185 8.00001C14.9335 9.19806 14.1668 10.2519 13.2004 11.0793L12.491 10.3699C13.2612 9.72513 13.8907 8.91767 14.3267 8.00001C13.2025 5.6336 10.7909 4 8.00002 4C7.42214 4 6.86053 4.07004 6.32325 4.20211Z',
			'M11 8C11 8.26879 10.9647 8.52933 10.8983 8.77721L9.99616 7.87502C9.93419 6.87 9.13 6.06581 8.12498 6.00384L7.22279 5.10165C7.47067 5.03535 7.73121 5 8 5C9.65685 5 11 6.34315 11 8Z',
			'M5.1016 7.22298L6.00386 8.12524C6.06594 9.13005 6.86995 9.93406 7.87476 9.99614L8.77702 10.8984C8.52919 10.9647 8.26872 11 8 11C6.34315 11 5 9.65685 5 8C5 7.73128 5.03533 7.47081 5.1016 7.22298Z',
		]],
		// 16/new-collection -- a collection being made, which is what an anchor is.
		'group-here': [16, [
			'M13 2H8L7.276 0.553C7.107 0.214 6.761 0 6.382 0H3.618C3.239 0 2.893 0.214 2.724 0.553L2 2H1C0.448 2 0 2.448 0 3V5V11C0 11.552 0.448 12 1 12H7.02746C7.27619 14.25 9.18372 16 11.5 16C13.9853 16 16 13.9853 16 11.5C16 9.93979 15.206 8.56504 14 7.75777V5V3C14 2.448 13.552 2 13 2ZM13 7.25606V5H1V11H7.02746C7.27619 8.75002 9.18372 7 11.5 7C12.026 7 12.5308 7.09023 13 7.25606ZM1 4V3H2C2.379 3 2.725 2.786 2.894 2.447L3.618 1H6.382L7.106 2.447C7.275 2.786 7.621 3 8 3H13V4H1ZM15 11.5C15 13.433 13.433 15 11.5 15C9.567 15 8 13.433 8 11.5C8 9.567 9.567 8 11.5 8C13.433 8 15 9.567 15 11.5ZM12 11H14V12H12V14H11V12H9V11H11V9H12V11Z',
		]],
		// 16/edit
		'edit': [16, [
			'M11.5857 0.707093C12.3668 -0.0739554 13.6331 -0.0739542 14.4141 0.707094L15.2928 1.58577C16.0739 2.36682 16.0739 3.63315 15.2928 4.4142L5.25555 14.4515L0.312744 15.6872L1.54845 10.7444L11.5857 0.707093ZM13.707 1.4142C13.3165 1.02368 12.6833 1.02368 12.2928 1.4142L11.207 2.49999L13.4999 4.79288L14.5857 3.70709C14.9762 3.31657 14.9762 2.6834 14.5857 2.29288L13.707 1.4142ZM12.7928 5.49999L10.4999 3.20709L2.45141 11.2556L1.68711 14.3128L4.7443 13.5485L12.7928 5.49999Z',
		]],
		// 20/sidebar -- the reader's own Toggle Sidebar button, and the library
		// sidenav's. The bar in this tab asks for exactly what those two ask for.
		'open-pane': [20, [
			'M7 7.25H4V6H7V7.25Z',
			'M7 10.25H4V9H7V10.25Z',
			'M7 13.25H4V12H7V13.25Z',
			'M2.25 3C1.55964 3 1 3.55964 1 4.25V15.75C1 16.4404 1.55964 17 2.25 17H17.75C18.4404 17 19 16.4404 19 15.75V4.25C19 3.55964 18.4404 3 17.75 3H2.25ZM17.75 4.25H10V15.75H17.75V4.25ZM2.25 4.25H8.75V15.75H2.25V4.25Z',
		]],
		// 16/magnifier -- the glass inside the search field, as core's
		// search-textbox draws it through ::part(search-icon). The file wraps its
		// path in a <clipPath> of the full 16px box, which clips nothing.
		'magnifier': [16, [
			'M11 6C11 8.76142 8.76142 11 6 11C3.23858 11 1 8.76142 1 6C1 3.23858 3.23858 1 6 1C8.76142 1 11 3.23858 11 6ZM9.87438 10.5816C8.82905 11.4664 7.47683 12 6 12C2.68629 12 0 9.31371 0 6C0 2.68629 2.68629 0 6 0C9.31371 0 12 2.68629 12 6C12 7.47687 11.4664 8.82911 10.5815 9.87446L16 15.2929L15.2929 16L9.87438 10.5816Z',
		]],
		// 16/x-8 -- the search field's clear button.
		'clear': [16, [
			'M11.2923 12L12 11.292L8.70711 7.99999L12 4.70796L11.2922 4L8.00011 7.29299L4.70798 4L4 4.70774L7.29311 7.99999L4 11.2922L4.70796 12L8.00011 8.70699L11.2923 12Z',
		]],
		// 16/chevron-12 -- the twisty on a <collapsible-section> header, which is
		// what the sidebar's two section headers now are. Core draws it pointing
		// down and rotates it 180 degrees when the section is open.
		'chevron-12': [16, [
			'M2 5.70711L8 11.7071L14 5.70711L13.2929 5L8 10.2929L2.70711 5L2 5.70711Z',
		]],
	};

	/**
	 * One icon, as an <svg> ready to go into a menu row.
	 *
	 * Rendered at 16px whatever grid it was drawn on: Zotero's 20px icons are
	 * the same weight on a roomier canvas, so scaling one down sits beside a
	 * 16px one without either looking out of place.
	 *
	 * An unknown name gives back an empty box rather than null, so a row whose
	 * icon has been renamed keeps its label aligned with the rows around it
	 * instead of sliding left on its own.
	 */
	function svg(name) {
		var spec = ICONS[name];
		var e = global.document.createElementNS(SVGNS, 'svg');
		e.setAttribute('class', 'menu-icon');
		e.setAttribute('viewBox', '0 0 ' + (spec ? spec[0] : 16) + ' ' + (spec ? spec[0] : 16));
		e.setAttribute('fill', 'currentColor');
		e.setAttribute('fill-rule', 'evenodd');
		// Decoration: the label beside it already says what the entry does, and
		// a screen reader announcing both would say it twice.
		e.setAttribute('aria-hidden', 'true');
		if (spec) {
			for (var i = 0; i < spec[1].length; i++) {
				var p = global.document.createElementNS(SVGNS, 'path');
				p.setAttribute('d', spec[1][i]);
				e.appendChild(p);
			}
		}
		return e;
	}

	function has(name) {
		return Object.prototype.hasOwnProperty.call(ICONS, name);
	}

	/**
	 * The same shape as raw path data, for a caller that is not building DOM.
	 *
	 * The graph canvas draws a pin over every pinned node, and a canvas takes
	 * Path2D, not <svg>. Handing out the grid alongside the paths is what lets
	 * it scale one: the data is in the icon's own units, and only the caller
	 * knows how many pixels it wants that box to be.
	 *
	 * The array is copied on the way out -- ICONS is the module's own table,
	 * and a caller that sorted or spliced what it was given would rewrite the
	 * icon for everybody.
	 */
	function paths(name) {
		var spec = ICONS[name];
		return spec ? { size: spec[0], d: spec[1].slice() } : null;
	}

	global.ZGIcons = {
		names: function () { return Object.keys(ICONS); },
		has: has,
		svg: svg,
		paths: paths,
	};
}(typeof window !== 'undefined' ? window : globalThis));
