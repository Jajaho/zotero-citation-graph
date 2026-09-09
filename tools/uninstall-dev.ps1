param(
    [string]$ProfileDir = "$env:APPDATA\Zotero\Zotero\Profiles\mq6r9f4v.default",
    [string]$AddonId    = "zotero-citation-graph@jajaho.dev"
)
$pointer = Join-Path (Join-Path $ProfileDir "extensions") $AddonId
if (Test-Path $pointer) { Remove-Item $pointer -Force; Write-Host "Removed $pointer" }
else { Write-Host "No pointer file at $pointer" }
Write-Host "Restart Zotero to complete removal."
