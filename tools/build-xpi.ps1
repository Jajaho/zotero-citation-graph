<#
    Packs addon/ into a distributable .xpi (a plain zip with manifest.json at the
    archive ROOT -- not inside a wrapper folder).

    Install it via Zotero: Tools -> Plugins -> gear icon -> "Install Plugin From File".
    This path does not depend on the extensions-directory rescan at all, so it is
    the reliable fallback when proxy-file development install misbehaves.
#>
param(
    [string]$OutDir = (Join-Path $PSScriptRoot "..\dist")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$addon = (Resolve-Path (Join-Path $PSScriptRoot "..\addon")).Path
$manifest = Get-Content (Join-Path $addon "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$id = $manifest.applications.zotero.id

# --- manifest validation -------------------------------------------------
# Zotero's schema rejects a manifest missing any of these, and the failure
# surfaces as ERROR_CORRUPT_FILE / "may be incompatible with this version of
# Zotero" -- which points nowhere near the real cause. Fail loudly here instead.
#
# update_url is the non-obvious one: Zotero REQUIRES it even for a plugin that
# will never auto-update. Omitting it cost hours once; don't repeat it.
$manifestPath = Join-Path $addon "manifest.json"
$mBytes = [System.IO.File]::ReadAllBytes($manifestPath)
if ($mBytes.Length -ge 3 -and $mBytes[0] -eq 0xEF -and $mBytes[1] -eq 0xBB -and $mBytes[2] -eq 0xBF) {
    throw "manifest.json starts with a UTF-8 BOM. Zotero's parser rejects it. (Windows PowerShell 5.1's 'Set-Content -Encoding utf8' adds one -- use [IO.File]::WriteAllText with UTF8Encoding(`$false) instead.)"
}

$z = $manifest.applications.zotero
$missing = @()
foreach ($f in 'id', 'update_url', 'strict_min_version') {
    if (-not $z.$f) { $missing += "applications.zotero.$f" }
}
foreach ($f in 'manifest_version', 'name', 'version') {
    if (-not $manifest.$f) { $missing += $f }
}
if ($z.strict_min_version -and $z.strict_min_version.Contains('*')) {
    $missing += "applications.zotero.strict_min_version must not contain '*'"
}
if ($missing.Count) {
    throw "manifest.json is invalid for Zotero:`n  - " + ($missing -join "`n  - ")
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$xpi = Join-Path (Resolve-Path $OutDir) "zotero-graph-$version.xpi"
if (Test-Path $xpi) { Remove-Item $xpi -Force }

# Exclude the Node-only adapter -- it requires node:sqlite/zlib/child_process and
# is never loaded inside Zotero (only tools/cli.js uses it).
$exclude = @('citation-graph\adapters')

$zip = [System.IO.Compression.ZipFile]::Open($xpi, 'Create')
try {
    Get-ChildItem $addon -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($addon.Length + 1)
        $skip = $false
        foreach ($e in $exclude) { if ($rel.StartsWith($e)) { $skip = $true } }
        if (-not $skip) {
            $entryName = $rel -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
}
finally { $zip.Dispose() }

$check = [System.IO.Compression.ZipFile]::OpenRead($xpi)
$hasManifest = ($check.Entries | Where-Object { $_.FullName -eq 'manifest.json' }) -ne $null
$hasBootstrap = ($check.Entries | Where-Object { $_.FullName -eq 'bootstrap.js' }) -ne $null
$count = $check.Entries.Count
$check.Dispose()

"built  $xpi"
"       id={0} version={1}" -f $id, $version
"       {0} entries; manifest.json at root={1}; bootstrap.js at root={2}" -f $count, $hasManifest, $hasBootstrap
if (-not ($hasManifest -and $hasBootstrap)) { throw "XPI is missing manifest.json or bootstrap.js at the archive root" }
""
"Install:  Zotero -> Tools -> Plugins -> gear icon -> Install Plugin From File"
"          then pick $xpi"
