// Paste into Zotero: Tools -> Developer -> Run JavaScript  (tick "async")
// Reports exactly what the AddonManager thinks of the plugin.
var ID = "zotero-graph@jajaho.dev";
var out = [];

var a = await AddonManager.getAddonByID(ID);
out.push("getAddonByID: " + (a ? "FOUND" : "NOT FOUND"));
if (a) {
  out.push("  name=" + a.name + " version=" + a.version);
  out.push("  active=" + a.isActive + " enabled=" + !a.userDisabled);
  out.push("  appDisabled=" + a.appDisabled + " (true => version range excludes this Zotero)");
  out.push("  isCompatible=" + a.isCompatible);
  out.push("  scope=" + a.scope + " type=" + a.type);
}

var all = await AddonManager.getAllAddons();
out.push("all addons: " + all.map(x => x.id + (x.isActive ? "*" : "")).join(", "));

out.push("app version: " + Services.appinfo.version);
out.push("autoDisableScopes: " + Services.prefs.getIntPref("extensions.autoDisableScopes", -1));
out.push("signatures.required: " + Services.prefs.getBoolPref("xpinstall.signatures.required", true));

// Can Zotero even see the files?
var f = Services.dirsvc.get("ProfD", Ci.nsIFile);
f.append("extensions"); f.append(ID);
out.push("extensions entry exists=" + f.exists() + " isDir=" + (f.exists() && f.isDirectory()));
if (f.exists() && f.isDirectory()) {
  var m = f.clone(); m.append("manifest.json");
  out.push("  manifest.json exists=" + m.exists());
}

return out.join("\n");
