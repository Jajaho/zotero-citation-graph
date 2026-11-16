/* global Services, Cc, Ci */
'use strict';

/**
 * What the browser is drawing with. Chrome code: the benchmark page itself
 * cannot ask, because nothing in a web page says whether its canvas is on the
 * GPU.
 *
 * It is here because a "GPU" run can fall back to software without saying so.
 * A blocklisted driver, a remote desktop session or a crash guard is enough,
 * and the numbers that come out look just like GPU numbers. A run that says
 * which renderer it used can be checked; one that does not, cannot.
 *
 * One copy, two callers: run.js sends this file's text to Firefox over
 * Marionette, and the Zotero runner loads it with loadSubScript. Zotero cannot
 * be driven over Marionette at all: the session waits for
 * browser-idle-startup-tasks-finished, and Zotero never sends it.
 *
 * What it can NOT say is whether one particular canvas stayed on the GPU.
 * Gecko's accelerated canvas falls back per canvas: it draws a path more
 * complex than gfx.canvas.accelerated.gpu-path-complexity in software, and
 * moves a canvas whose frames are mostly software work back to the CPU for good
 * (profile-fallback-ratio). Nothing reports that. The way to check is to
 * compare a run against one with --canvas software. If the two match, the
 * accelerated canvas was not doing the work. See the README.
 */
function zgGfxProbe() {
	const out = {
		app: Services.appinfo.name + ' ' + Services.appinfo.version,
		gecko: Services.appinfo.platformVersion,
		headless: false,
	};
	// --headless sets this for the whole process, and a headless window is
	// always drawn in software whatever the features below say.
	try { out.headless = Services.env.get('MOZ_HEADLESS') === '1'; }
	catch (e) { /* no env service: the compositor below still tells */ }

	const gi = Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo);
	try { out.adapter = gi.adapterDescription || null; } catch (e) { out.adapter = null; }
	try { out.driver = gi.adapterDriverVersion || null; } catch (e) { out.driver = null; }

	// The features that decide where a canvas is drawn. "available" means in
	// use; anything else (blocked, disabled, failed) carries the reason.
	const want = ['HW_COMPOSITING', 'GPU_PROCESS', 'WEBRENDER', 'D3D11_COMPOSITING',
		'ACCELERATED_CANVAS2D', 'CANVAS_RENDERER_THREAD'];
	out.features = {};
	try {
		for (const f of gi.getFeatureLog().features) {
			if (want.indexOf(f.name) < 0) continue;
			const why = (f.log || []).filter((l) => l.status !== 'available')
				.map((l) => l.message).filter(Boolean).join('; ');
			out.features[f.name] = f.status + (why ? ' (' + why + ')' : '');
		}
	}
	catch (e) { out.featureError = String(e); }

	// The compositor a real window got. Software WebRender says so in the name.
	try {
		const w = Services.wm.getMostRecentWindow(null);
		out.compositor = w ? w.windowUtils.layerManagerType : null;
	}
	catch (e) { out.compositor = null; }

	const pref = (n) => {
		const t = Services.prefs.getPrefType(n);
		if (t === Services.prefs.PREF_INVALID) return null;
		if (t === Services.prefs.PREF_STRING) return Services.prefs.getStringPref(n);
		if (t === Services.prefs.PREF_INT) return Services.prefs.getIntPref(n);
		return Services.prefs.getBoolPref(n);
	};
	out.prefs = {};
	for (const n of ['gfx.canvas.accelerated', 'gfx.canvas.accelerated.gpu-path-complexity',
		'gfx.canvas.accelerated.profile-fallback-ratio', 'gfx.webrender.software',
		'layers.acceleration.disabled', 'widget.windows.window_occlusion_tracking.enabled']) {
		out.prefs[n] = pref(n);
	}

	// The verdict a report prints. The canvas is on the GPU only if all three
	// hold: Gecko may accelerate canvases (pref), it does on this machine
	// (feature), and windows are composited in hardware.
	const hwCompositor = !!out.compositor && /WebRender/.test(out.compositor)
		&& !/Software/i.test(out.compositor);
	const accel = out.prefs['gfx.canvas.accelerated'] === true
		&& /^available/.test(out.features.ACCELERATED_CANVAS2D || '');
	out.canvas = hwCompositor && accel && !out.headless ? 'gpu' : 'software';
	out.summary = out.app + ' (Gecko ' + out.gecko + '), canvas on '
		+ (out.canvas === 'gpu' ? 'the GPU' : 'the CPU')
		+ ', compositor ' + (out.compositor || 'unknown')
		+ (out.adapter ? ', ' + out.adapter : '');
	return out;
}
