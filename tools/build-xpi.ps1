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
