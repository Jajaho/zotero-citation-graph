// Zotero -> Tools -> Developer -> Run JavaScript, tick "async", paste, Run.
//
// getInstallForFile() collapses every manifest problem into ERROR_CORRUPT_FILE.
// This runs the same parser directly so the actual schema errors are visible.
// It checks the unpacked directory too, which isolates the manifest from the
// packaging entirely.

// Both probes are read from these two lines, so a checkout somewhere else -- or a
// version other than the one last built -- is a one-line edit rather than a hunt
// through the file. ROOT takes forward slashes on every platform because it is
// spliced into a file:// URI, not handed to the shell.
var ROOT = "C:/Users/you/Repositories/zotero-graph-plugin";
var XPI  = "zotero-citation-graph-0.72.2.xpi";

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
	"file:///" + ROOT + "/addon/"
));
out.push(await probe(
	"packed xpi",
	"jar:file:///" + ROOT + "/dist/" + XPI + "!/"
));

return JSON.stringify(out, null, 1);
