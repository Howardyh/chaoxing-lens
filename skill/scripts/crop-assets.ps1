<# Crops only explicitly supplied, hash-verified PNG screenshots from a frame-local plan.
   No browser capture, network, global settings or OCR. Output directory must be new. #>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PlanPath,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
function LocalPath([string]$p) { if ($p -match '^[a-zA-Z][a-zA-Z0-9+.-]*://' -or $p.StartsWith('\\')) { throw 'Local paths only' }; return [IO.Path]::GetFullPath($p) }
$planFile=LocalPath $PlanPath; $out=LocalPath $OutputDirectory
if (Test-Path -LiteralPath $out) { throw 'OutputDirectory must be new; previous results are preserved.' }
$plan=[IO.File]::ReadAllText($planFile) | ConvertFrom-Json
if ($plan.schema -ne 'chaoxing-asset-mappings/v1' -or $plan.captureHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid asset mapping plan' }
New-Item -ItemType Directory -Path $out | Out-Null
$images=@{}; $verifiedHashes=@{}; $failures=@(); $completed=@()
try {
 foreach ($mapping in $plan.mappings) {
  if ($mapping.status -ne 'pending-crop') { $completed += $mapping; continue }
  try {
   $source=LocalPath $mapping.screenshotPath
   if (-not $images.ContainsKey($source)) {
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $mapping.screenshotHash) { throw 'Screenshot hash changed' }
    $images[$source]=[Drawing.Bitmap]::FromFile($source)
    $verifiedHashes[$source]=$mapping.screenshotHash
   }
   if ($verifiedHashes[$source] -ine $mapping.screenshotHash) { throw 'Conflicting screenshot hash for the same path' }
   $image=$images[$source]
   if ($image.Width -ne $mapping.screenshotPixelSize.width -or $image.Height -ne $mapping.screenshotPixelSize.height) { throw 'Screenshot dimensions changed' }
   $b=$mapping.pixelBounds
   foreach ($v in @($b.x,$b.y,$b.width,$b.height)) { if ($null -eq $v -or $v -ne [Math]::Floor($v)) { throw 'Integer pixel bounds required' } }
   if ($b.x -lt 0 -or $b.y -lt 0 -or $b.width -le 0 -or $b.height -le 0 -or $b.x+$b.width -gt $image.Width -or $b.y+$b.height -gt $image.Height) { throw 'Crop outside image' }
   $algorithm=[Security.Cryptography.SHA256]::Create()
   try { $name=([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($mapping.assetId)))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
   $destination=Join-Path $out ($name+'.png')
   if (Test-Path -LiteralPath $destination) { throw 'Duplicate asset output' }
   $crop=$image.Clone([Drawing.Rectangle]::new($b.x,$b.y,$b.width,$b.height),[Drawing.Imaging.PixelFormat]::Format32bppArgb)
   try { $crop.Save($destination,[Drawing.Imaging.ImageFormat]::Png) } finally { $crop.Dispose() }
   $mapping.status='ready'
   $mapping | Add-Member -NotePropertyName path -NotePropertyValue $destination -Force
   $mapping | Add-Member -NotePropertyName sha256 -NotePropertyValue ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()) -Force
   $mapping | Add-Member -NotePropertyName pixelSize -NotePropertyValue @{width=$b.width;height=$b.height} -Force
   $completed += $mapping
  } catch { $failures += @{assetId=$mapping.assetId;code='crop-failed';reason=$_.Exception.Message} }
 }
} finally { foreach ($image in $images.Values) {$image.Dispose()} }
$result=@{schema=$plan.schema;captureHash=$plan.captureHash;mappings=$completed;rejections=@($plan.rejections)+$failures;warnings=@($plan.warnings)}
[IO.File]::WriteAllText((Join-Path $out 'asset-mappings.json'),($result|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))
Write-Output ('Cropped='+@($completed|Where-Object{$_.acquisition -eq 'screenshot-crop'}).Count+';Failed='+$failures.Count)
if ($failures.Count) {exit 1}
