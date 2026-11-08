<# Verify and convert observed browser JPEG/PNG screenshots to local PNGs.
   Input is exam-capture's screenshots.json. No browser or network access.
   Reject changed/discarded pages, wrong hashes, mismatched aspect ratios and
   excessive pixel budgets. New output directory only; keep originals. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ManifestPath,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [ValidateRange(10000,100000000)][long]$MaxPixels=40000000
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
function LocalPath([string]$Value,[string]$Base) {
    if (!$Value -or $Value.StartsWith('\\') -or $Value.StartsWith('//') -or $Value -match '^[a-zA-Z][a-zA-Z0-9+.-]*://' ) {throw 'Explicit local paths only'}
    if (![IO.Path]::IsPathRooted($Value)) {$Value=[IO.Path]::Combine($Base,$Value)}
    $resolved=[IO.Path]::GetFullPath($Value)
    if ($resolved -notmatch '^[a-zA-Z]:\\' -or $resolved.Substring(2).Contains(':')) {throw 'Only local drive paths are accepted'}
    $probe=[IO.Path]::GetPathRoot($resolved)
    if ((New-Object IO.DriveInfo($probe)).DriveType -eq [IO.DriveType]::Network){throw 'Network drives are unsupported'}
    foreach($part in $resolved.Substring($probe.Length).Split('\')) {
        $probe=[IO.Path]::Combine($probe,$part)
        if (([IO.File]::Exists($probe) -or [IO.Directory]::Exists($probe)) -and ([IO.File]::GetAttributes($probe) -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse points are unsupported'}
    }
    return $resolved
}
function Hash([byte[]]$Bytes) {$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
$manifestFile=LocalPath $ManifestPath (Get-Location).ProviderPath
$out=LocalPath $OutputDirectory (Get-Location).ProviderPath
if([IO.File]::Exists($out) -or [IO.Directory]::Exists($out)){throw 'OutputDirectory must be new'}
$manifest=[IO.File]::ReadAllText($manifestFile,[Text.Encoding]::UTF8)|ConvertFrom-Json
if(!$manifest.captureHash -or !$manifest.screenshots -or @($manifest.screenshots).Count -eq 0){throw 'A capture-bound nonempty screenshot manifest is required'}
if(@($manifest.failures|Where-Object {$_.reason -eq 'page-changed-during-capture'}).Count){throw 'Page changed; recapture before converting'}
$null=[IO.Directory]::CreateDirectory($out)
$result=New-Object 'System.Collections.Generic.List[object]'
$i=0
foreach($shot in $manifest.screenshots) {
    if($shot.discarded -or ($shot.ready -eq $false -and !$shot.needsNormalization)){throw 'Discarded or unverified screenshot cannot be re-armed'}
    $source=LocalPath $shot.path ([IO.Path]::GetDirectoryName($manifestFile))
    $bytes=[IO.File]::ReadAllBytes($source)
    if((Hash $bytes) -ne $shot.sha256){throw 'Screenshot bytes changed'}
    $isPng=$bytes.Length -ge 24 -and [BitConverter]::ToString($bytes[0..7]) -eq '89-50-4E-47-0D-0A-1A-0A'
    $isJpeg=$bytes.Length -ge 4 -and $bytes[0] -eq 255 -and $bytes[1] -eq 216 -and $bytes[2] -eq 255
    if(!$isPng -and !$isJpeg){throw 'Only observed PNG/JPEG screenshots are supported'}
    $stream=New-Object IO.MemoryStream(,$bytes);$original=$null;$bitmap=$null;$graphics=$null
    try {
        $original=[Drawing.Image]::FromStream($stream)
        if([long]$original.Width*$original.Height -gt $MaxPixels){throw 'Screenshot exceeds pixel budget'}
        $css=$shot.cssBounds
        if(!$css -or $css.width -le 0 -or $css.height -le 0){throw 'Missing screenshot CSS geometry'}
        $sx=$original.Width/$css.width;$sy=$original.Height/$css.height
        if([Math]::Abs($sx-$sy) -gt 0.02*[Math]::Max($sx,$sy)){throw 'Screenshot aspect ratio disagrees with CSS bounds'}
        $bitmap=New-Object Drawing.Bitmap($original.Width,$original.Height)
        $graphics=[Drawing.Graphics]::FromImage($bitmap);$graphics.Clear([Drawing.Color]::White)
        $rect=New-Object Drawing.Rectangle(0,0,$original.Width,$original.Height);$graphics.DrawImage($original,$rect)
        $i++;$destination=Join-Path $out ('band-{0:d3}.png'-f $i);$bitmap.Save($destination,[Drawing.Imaging.ImageFormat]::Png)
        $copy=$shot|ConvertTo-Json -Depth 20|ConvertFrom-Json
        $copy|Add-Member -NotePropertyName originalPath -NotePropertyValue $source -Force;$copy|Add-Member -NotePropertyName sourceSha256 -NotePropertyValue $shot.sha256 -Force
        $copy.path=$destination;$copy.sha256=Hash ([IO.File]::ReadAllBytes($destination));$copy|Add-Member -NotePropertyName pixelSize -NotePropertyValue ([pscustomobject]@{width=$original.Width;height=$original.Height}) -Force
        $copy|Add-Member -NotePropertyName contentType -NotePropertyValue 'image/png' -Force;$copy|Add-Member -NotePropertyName needsNormalization -NotePropertyValue $false -Force;$copy|Add-Member -NotePropertyName ready -NotePropertyValue $true -Force
        $result.Add($copy)
    } finally {if($graphics){$graphics.Dispose()};if($bitmap){$bitmap.Dispose()};if($original){$original.Dispose()};$stream.Dispose()}
}
$report=[ordered]@{schema='chaoxing-normalized-screenshots/v1';captureHash=$manifest.captureHash;screenshots=$result.ToArray();verified=$false}
[IO.File]::WriteAllText((Join-Path $out 'screenshots.json'),($report|ConvertTo-Json -Depth 24),(New-Object Text.UTF8Encoding($false)))
Write-Output ([ordered]@{screenshots=$result.Count;output=$out;verified=$false}|ConvertTo-Json -Compress)
