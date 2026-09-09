// Zotero -> Tools -> Developer -> Run JavaScript, tick "async", paste, Run.
//
// getInstallForFile() collapses every manifest problem into ERROR_CORRUPT_FILE.
// This runs the same parser directly so the actual schema errors are visible.
// It checks the unpacked directory too, which isolates the manifest from the
// packaging entirely.

var { ExtensionData } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");

async function probe(label, uriStr) {
	let r = { label, uri: uriStr };
	try {
		let ed = new ExtensionData(Services.io.newURI(uriStr));
		try {
			await ed.loadManifest();
		}
		catch (e) {
			r.threw = String(e);
		}
		r.errors = ed.errors && ed.errors.length ? ed.errors : null;
		r.warnings = ed.warnings && ed.warnings.length ? ed.warnings : null;
		r.id = ed.id;
		r.type = ed.type;
		r.manifestVersion = ed.manifest && ed.manifest.manifest_version;
		r.applications = ed.manifest && ed.manifest.applications;
	}
	catch (e) {
		r.constructThrew = String(e);
	}
	return r;
}

var out = [];
out.push(await probe(
	"unpacked directory",
	"file:///C:/Users/you/Repositories/zotero-graph-plugin/addon/"
));
out.push(await probe(
	"packed xpi",
	"jar:file:///C:/Users/you/Repositories/zotero-graph-plugin/dist/zotero-citation-graph-0.1.0.xpi!/"
));

return JSON.stringify(out, null, 1);
