/* global Zotero, ChromeUtils, IOUtils */

/**
 * Writing an exported graph to disk.
 *
 * The page builds the document -- it is the only side that knows where every
 * node is drawn and what colour it is -- and this saves it, because a content
 * page has no file picker and no file system. See exportGraph() in
 * content/graph.js.
 *
 * What crosses is text, and the page is not trusted with anything else about
 * the file: the format picks the extension and the filter from the table
 * below, the name is only ever the default offered in the picker, and the
 * path is the one the user chose in it.
 */

let l10n = require('./l10n.js');

const FORMATS = {
	svg: { ext: 'svg', filter: () => l10n.t('export-filter-svg') },
	graphml: { ext: 'graphml', filter: () => l10n.t('export-filter-graphml') },
};

// Long enough for any collection name anyone reads; short enough that the
// path stays well inside what Windows will take once a folder is in front.
const MAX_NAME = 120;

/** The name the picker offers: what the graph is of, made safe for a file
 *  name, with the format's extension. Null for a format there is no table
 *  row for. */
function fileName(name, format) {
	let f = FORMATS[format];
	if (!f) return null;
	// eslint-disable-next-line no-control-regex
	let base = String(name || '').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
	base = typeof Zotero !== 'undefined' && Zotero.File && Zotero.File.getValidFileName
		? Zotero.File.getValidFileName(base)
		: base.replace(/[\\/:*?"<>|]/g, '_');
	base = base.slice(0, MAX_NAME).trim() || 'citation-graph';
	return base + '.' + f.ext;
}

/**
 * Ask where, and write. Resolves to the path written, or null when the user
 * cancelled or the message was not one this can save.
 *
 * `status` is the page's status line: the one place a graph tab says what has
 * just happened, and where it says so for a build and an add as well.
 */
async function save(win, msg, status) {
	let f = msg && FORMATS[msg.format];
	if (!f || typeof msg.text !== 'string') return null;

	let { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
	let fp = new FilePicker();
	fp.init(win, l10n.t('export-title'), fp.modeSave);
	fp.appendFilter(f.filter(), '*.' + f.ext);
	fp.appendFilters(fp.filterAll);
	fp.defaultString = fileName(msg.name, msg.format);
	fp.defaultExtension = f.ext;
	let rv = await fp.show();
	if (rv !== fp.returnOK && rv !== fp.returnReplace) return null;

	let path = fp.file;
	try {
		await IOUtils.writeUTF8(path, msg.text, { tmpPath: path + '.tmp' });
	}
	catch (e) {
		Zotero.logError(e);
		if (status) status(l10n.t('export-failed'));
		return null;
	}
	if (status) status(l10n.t('export-saved', { file: path }));
	return path;
}

module.exports = { save, fileName, FORMATS };
