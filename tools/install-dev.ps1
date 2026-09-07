<#
    Installs the plugin into Zotero for development.

    Two things are required, and the second is the one everybody misses:

    1. A "proxy file" in <profile>/extensions/ whose NAME is the addon id and
       whose FIRST LINE is the absolute path to the plugin directory. It must be
       UTF-8 with NO BOM -- a BOM makes nsIFile.initWithPath throw, and Zotero
       then silently DELETES the proxy file.

       DO NOT use a directory junction here. nsIFile reports a junction as a
       symlink, so Zotero routes it through _readLinkFile(); when that fails it
       calls entry.remove(true), which FOLLOWS THE JUNCTION and recursively
       deletes your source tree. This happened. Keep your work committed.

    2. `extensions.lastAppBuildId` and `extensions.lastAppVersion` must be
       removed from prefs.js. Zotero only rescans the extensions directory when
       these differ from the running build, so while they match, a newly added
       plugin is IGNORED ENTIRELY -- no log line, no extensions.json entry,
       nothing. -purgecaches does NOT help: it clears the startup cache, not
       this check.

    Zotero rewrites prefs.js on exit, so it must be CLOSED when this runs.
#>
param(
    [string]$ProfileDir = "$env:APPDATA\Zotero\Zotero\Profiles\mq6r9f4v.default",
    [string]$AddonId    = "zotero-graph@jajaho.dev"
)

$ErrorActionPreference = "Stop"

$proc = Get-Process zotero -ErrorAction SilentlyContinue
if ($proc) {
    throw "Zotero is running (pid $($proc.Id -join ',')). Quit it first -- it rewrites prefs.js on exit and would undo step 2."
}

$srcRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\addon")).Path.TrimEnd('\')
$extDir  = Join-Path $ProfileDir "extensions"
$prefs   = Join-Path $ProfileDir "prefs.js"

if (-not (Test-Path $srcRoot))   { throw "Plugin source not found: $srcRoot" }
if (-not (Test-Path $ProfileDir)){ throw "Zotero profile not found: $ProfileDir" }
if (-not (Test-Path $extDir))    { New-Item -ItemType Directory -Path $extDir | Out-Null }

# --- 1. install ----------------------------------------------------------
$target = Join-Path $extDir $AddonId

# Refuse to delete anything that is a reparse point (junction/symlink) -- deleting
# one recursively can take the target with it. Only ever remove a plain file here.
if (Test-Path $target) {
    $existing = Get-Item $target -Force
    if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$target is a junction/symlink. Remove it manually with 'cmd /c rmdir `"$target`"' (rmdir does NOT follow it), then re-run."
    }
    if ($existing.PSIsContainer) {
        throw "$target is a directory. Remove it manually and re-run."
    }
    Remove-Item $target -Force
}

[System.IO.File]::WriteAllText($target, $srcRoot, (New-Object System.Text.UTF8Encoding($false)))
$b = [System.IO.File]::ReadAllBytes($target)
if ($b[0] -eq 0xEF) { throw "proxy file was written with a BOM" }
Write-Host "[1/2] proxy file $target ($($b.Length) bytes, no BOM)"
Write-Host "      -> $srcRoot"

# --- 2. force a rescan ---------------------------------------------------
if (Test-Path $prefs) {
    $lines = Get-Content $prefs
    $kept  = $lines | Where-Object { $_ -notmatch 'extensions\.lastAppBuildId|extensions\.lastAppVersion' }
    $removed = $lines.Count - $kept.Count
    if ($removed -gt 0) {
        Copy-Item $prefs "$prefs.bak" -Force
        Set-Content -Path $prefs -Value $kept -Encoding utf8
        Write-Host "[2/2] removed $removed rescan-blocking pref line(s) from prefs.js (backup: prefs.js.bak)"
    }
    else {
        Write-Host "[2/2] no rescan-blocking prefs present"
    }
}

Write-Host ""
Write-Host "Now start Zotero:"
Write-Host '  & "C:\Program Files\Zotero\zotero.exe" -ZoteroDebugText -purgecaches'
Write-Host ""
Write-Host "NOTE: Zotero rewrites those prefs on every start, so re-run this script"
Write-Host "      (with Zotero closed) whenever you need it to notice a NEW plugin."
Write-Host "      Editing files inside an already-registered plugin only needs a restart."
