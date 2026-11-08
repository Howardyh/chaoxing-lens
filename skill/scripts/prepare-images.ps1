<# Offline PNG normalization and adaptive contact sheets. Originals are retained.
   Run with Windows PowerShell 5.1. Manifest is createOcrManifest output; it may
   contain aliases for equal content. OCR uses separate normalized images, never
   the downscaled overview sheets. All output files are new. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ManifestPath,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [ValidateRange(1,4)][int]$Scale = 3,
    [ValidateRange(4,64)][int]$Padding = 16,
    [ValidateRange(600,2400)][int]$SheetWidth = 1600,
    [ValidateRange(600,6000)][int]$SheetHeight = 2400,
    [ValidateRange(1,4)][int]$Columns = 3
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
function LocalPath([string]$Value, [string]$Base) {
    if (!$Value -or $Value -match '^[a-zA-Z][a-zA-Z0-9+.-]*:' -and $Value -notmatch '^[a-zA-Z]:[\\/]' -or $Value.StartsWith('\\') -or $Value.StartsWith('//')) { throw 'Explicit local drive paths only' }
    if (![IO.Path]::IsPathRooted($Value)) { $Value = [IO.Path]::Combine($Base,$Value) }
    $resolved = [IO.Path]::GetFullPath($Value)
    if ($resolved -notmatch '^[a-zA-Z]:\\' -or $resolved.Substring(2).Contains(':')) { throw 'Only local drive paths are supported' }
    $probe = [IO.Path]::GetPathRoot($resolved)
    if ((New-Object IO.DriveInfo($probe)).DriveType -eq [IO.DriveType]::Network) { throw 'Network drives are unsupported' }
    foreach ($part in $resolved.Substring($probe.Length).Split('\')) {
        $probe = [IO.Path]::Combine($probe,$part)
        if (([IO.File]::Exists($probe) -or [IO.Directory]::Exists($probe)) -and ([IO.File]::GetAttributes($probe) -band [IO.FileAttributes]::ReparsePoint)) { throw 'Symlinks and junctions are unsupported' }
    }
    return $resolved
}
function Hash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
$base = (Get-Location).ProviderPath
$inputPath = LocalPath $ManifestPath $base
$out = LocalPath $OutputDirectory $base
if ([IO.File]::Exists($out) -or [IO.Directory]::Exists($out)) { throw 'OutputDirectory must be new' }
$manifest = [IO.File]::ReadAllText($inputPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
if (!$manifest.images -or @($manifest.images).Count -eq 0) { throw 'A nonempty images manifest is required' }
$null = [IO.Directory]::CreateDirectory($out)
$images = New-Object 'System.Collections.Generic.List[object]'
$tiles = New-Object 'System.Collections.Generic.List[object]'
$sheets = New-Object 'System.Collections.Generic.List[object]'
$font = New-Object Drawing.Font('Arial',14)
$sheet = $null; $graphics = $null; $sheetNumber = 0; $cursorY = 12; $cursorX = 12; $rowHeight = 0
$cellWidth = [int][Math]::Floor(($SheetWidth-24.0)/$Columns)
function Save-Sheet($Bitmap,$Canvas,$SheetTiles,[int]$Number) {
    if (!$Bitmap) { return }
    $filename = Join-Path $out ('sheet-{0:d3}.png' -f $Number)
    $Bitmap.Save($filename,[Drawing.Imaging.ImageFormat]::Png)
    $sheets.Add([pscustomobject]@{ path=$filename; width=$SheetWidth; height=$SheetHeight; tiles=$SheetTiles.ToArray() })
    $Canvas.Dispose(); $Bitmap.Dispose()
}
try {
    $index = 0
    foreach ($entry in $manifest.images) {
        $source = LocalPath $entry.path ([IO.Path]::GetDirectoryName($inputPath))
        $bytes = [IO.File]::ReadAllBytes($source)
        if ((Hash $bytes) -ne $entry.sha256) { throw 'Source image hash changed' }
        if ($bytes.Length -lt 24 -or [BitConverter]::ToString($bytes[0..7]) -ne '89-50-4E-47-0D-0A-1A-0A') { throw 'Supply PNG originals or screenshot crops' }
        $memory = New-Object IO.MemoryStream(,$bytes)
        $original = $null; $normalized=$null; $g=$null
        try {
            $original = [Drawing.Image]::FromStream($memory)
            $width = $original.Width * $Scale + 2*$Padding
            $height = $original.Height * $Scale + 2*$Padding
            if ($width -gt 16000 -or $height -gt 16000 -or [long]$width*$height -gt 40000000) { throw 'Image too large; supply a smaller crop' }
            $normalized = New-Object Drawing.Bitmap($width,$height)
            $g = [Drawing.Graphics]::FromImage($normalized); $g.Clear([Drawing.Color]::White)
            $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $rect = New-Object Drawing.Rectangle($Padding,$Padding,($original.Width*$Scale),($original.Height*$Scale))
            $g.DrawImage($original,$rect); $g.Dispose(); $g=$null
            $index++; $destination=Join-Path $out ('image-{0:d4}.png' -f $index)
            $normalized.Save($destination,[Drawing.Imaging.ImageFormat]::Png)
            $entry | Add-Member -NotePropertyName originalSha256 -NotePropertyValue $entry.sha256 -Force
            $entry | Add-Member -NotePropertyName originalPath -NotePropertyValue $source -Force
            $entry.sha256=Hash ([IO.File]::ReadAllBytes($destination)); $entry.path=$destination
            $entry | Add-Member -NotePropertyName pixelSize -NotePropertyValue ([pscustomobject]@{width=$width;height=$height}) -Force
            $entry | Add-Member -NotePropertyName preprocess -NotePropertyValue ([pscustomobject]@{version=1;background='white';scale=$Scale;padding=$Padding}) -Force
            foreach ($alias in @($entry.aliases)) { if ($alias) { $alias.sha256=$entry.sha256; $alias.path=$destination } }
            $images.Add($entry)
            # Preserve full formulas. Wide images span a complete row; small
            # snippets share columns. Independent OCR images are unchanged.
            $wide = $width -gt ($cellWidth-12)
            $slotWidth = if ($wide) {$SheetWidth-24} else {$cellWidth-12}
            if ($cursorX -gt 12 -and ($wide -or $cursorX+$cellWidth -gt $SheetWidth-12)) {
                $cursorY+=$rowHeight; $cursorX=12; $rowHeight=0
            }
            $factor=[Math]::Min(1.0,[Math]::Min(($slotWidth*1.0)/$width,($SheetHeight-64.0)/$height))
            $tileW=[Math]::Max(1,[int][Math]::Floor($width*$factor)); $tileH=[Math]::Max(1,[int][Math]::Floor($height*$factor))
            if ($sheet -and $cursorY+32+$tileH+12 -gt $SheetHeight) { Save-Sheet $sheet $graphics $sheetTiles $sheetNumber; $sheet=$null; $graphics=$null; $cursorX=12; $cursorY=12; $rowHeight=0 }
            if (!$sheet) {
                $sheetNumber++; $sheet=New-Object Drawing.Bitmap($SheetWidth,$SheetHeight)
                $graphics=[Drawing.Graphics]::FromImage($sheet); $graphics.Clear([Drawing.Color]::White)
                $graphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $cursorY=12; $cursorX=12; $rowHeight=0; $sheetTiles=New-Object 'System.Collections.Generic.List[object]'
            }
            $labelRect=New-Object Drawing.RectangleF($cursorX,$cursorY,$slotWidth,30)
            $graphics.DrawString(('image-{0:d4}  ({1} x {2})' -f $index,$original.Width,$original.Height),$font,[Drawing.Brushes]::Black,$labelRect)
            $rect=New-Object Drawing.Rectangle($cursorX,($cursorY+32),$tileW,$tileH)
            $graphics.DrawImage($normalized,$rect)
            $tile=[pscustomobject]@{ imageKey=$entry.imageKey; assetIds=@($entry.aliases | ForEach-Object {$_.assetId}); x=$cursorX;y=($cursorY+32);width=$tileW;height=$tileH;sourceWidth=$width;sourceHeight=$height;previewScale=$factor }
            $sheetTiles.Add($tile); $tiles.Add($tile)
            $rowHeight=[Math]::Max($rowHeight,32+$tileH+12)
            if ($wide) {$cursorY+=$rowHeight;$cursorX=12;$rowHeight=0} else {$cursorX+=$cellWidth}
        } finally { if ($g) {$g.Dispose()}; if ($normalized) {$normalized.Dispose()}; if ($original) {$original.Dispose()}; $memory.Dispose() }
    }
    Save-Sheet $sheet $graphics $sheetTiles $sheetNumber; $sheet=$null; $graphics=$null
    $report=[ordered]@{schema='chaoxing-prepared-images/v1';captureHash=$manifest.captureHash;images=$images.ToArray();sheets=$sheets.ToArray();verified=$false;preprocessKey=('white-scale{0}-padding{1}/v1' -f $Scale,$Padding)}
    [IO.File]::WriteAllText((Join-Path $out 'images.json'),($report | ConvertTo-Json -Depth 24),(New-Object Text.UTF8Encoding($false)))
    Write-Output ([ordered]@{schema=$report.schema;captureHash=$report.captureHash;preprocessKey=$report.preprocessKey;images=$images.Count;sheets=$sheets.Count;columns=$Columns} | ConvertTo-Json -Compress)
} finally { if ($graphics) {$graphics.Dispose()}; if ($sheet) {$sheet.Dispose()}; $font.Dispose() }
