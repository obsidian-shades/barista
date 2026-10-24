# Extract every material from the purchased "5000+ PBR Asset Browser V3" .blend files.
#
#   pwsh tools/extract-pack.ps1 -Source "C:\...\5000+ Pbr Asset Browser V3" -Raw "D:\barista-pack-raw"
#   python tools/build-pack.py --raw "D:\barista-pack-raw"
#
# The raw stage is intentionally outside the repo (D: by default): it holds the original 2K
# packed maps and is only a cache. `build-pack.py` writes the 1024 px browser library to
# public/materials-pack, which is git-ignored.
param(
  [Parameter(Mandatory = $true)] [string] $Source,
  [string] $Raw = 'D:\barista-pack-raw',
  [string] $Blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe',
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $Blender)) { throw "Blender not found: $Blender" }
if (!(Test-Path -LiteralPath $Source)) { throw "Pack folder not found: $Source" }
if ((Test-Path -LiteralPath $Raw) -and $Force) { Remove-Item -LiteralPath $Raw -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Raw | Out-Null

$script = Join-Path $PSScriptRoot 'blender-extract.py'
$files = Get-ChildItem -LiteralPath $Source -Filter '* Asset Browser.blend' | Sort-Object Length
if ($files.Count -eq 0) { throw "No '* Asset Browser.blend' files in $Source" }

foreach ($file in $files) {
  $category = ($file.BaseName -replace '^\d+\+\s*', '') -replace '\s+Asset Browser$', ''
  if (!$category) { $category = 'Randoms' }
  Write-Host "=== $category  ($([math]::Round($file.Length / 1GB, 2)) GB) ==="
  # Blender's warnings go to stderr; under Stop, Windows PowerShell would treat them as failures.
  $ErrorActionPreference = 'Continue'
  & $Blender -b --factory-startup $file.FullName --python $script -- $Raw $category 2>&1 |
    Select-Object -Last 6 | ForEach-Object { Write-Host $_ }
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { throw "Blender failed on $($file.Name)" }
}

$materials = (Get-Content -LiteralPath (Join-Path $Raw 'materials.jsonl') | Measure-Object -Line).Lines
Write-Host "Extracted $materials materials to $Raw"
Write-Host "Next: python tools/build-pack.py --raw `"$Raw`""
