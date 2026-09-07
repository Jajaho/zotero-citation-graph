<#
    Installs the plugin into Zotero as a development "pointer file".

    Zotero's XPIProvider reads the FIRST LINE of a file in <profile>/extensions/
    whose NAME is exactly the addon id, and treats it as an absolute native path
    to the plugin directory.

    The encoding matters: it must be UTF-8 with NO BOM. A BOM gets prepended to
    the path, nsIFile.initWithPath throws, and XPIProvider then silently DELETES
    the pointer file. So if the file vanishes after a restart, the encoding was
    wrong -- that disappearance is the diagnostic.
#>
param(
    [string]$ProfileDir = "$env:APPDATA\Zotero\Zotero\Profiles\mq6r9f4v.default",
    [string]$AddonId    = "zotero-graph@jajaho.dev"
)

$ErrorActionPreference = "Stop"

$srcRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\addon")).Path.TrimEnd('\')
$extDir  = Join-Path $ProfileDir "extensions"

if (-not (Test-Path $srcRoot))  { throw "Plugin source not found: $srcRoot" }
if (-not (Test-Path $ProfileDir)) { throw "Zotero profile not found: $ProfileDir" }
if (-not (Test-Path $extDir))   { New-Item -ItemType Directory -Path $extDir | Out-Null }

$pointer = Join-Path $extDir $AddonId

# UTF8Encoding($false) => no BOM. Do NOT use Set-Content/Out-File here.
[System.IO.File]::WriteAllText($pointer, $srcRoot, (New-Object System.Text.UTF8Encoding($false)))

$bytes = [System.IO.File]::ReadAllBytes($pointer)
Write-Host "Wrote pointer file:"
Write-Host "  $pointer"
Write-Host "  -> $srcRoot"
Write-Host "  $($bytes.Length) bytes, first byte 0x$('{0:X2}' -f $bytes[0]) (must not be 0xEF)"
Write-Host ""
Write-Host "Now start Zotero:"
Write-Host '  & "C:\Program Files\Zotero\zotero.exe" -ZoteroDebugText -purgecaches | Out-Host'
