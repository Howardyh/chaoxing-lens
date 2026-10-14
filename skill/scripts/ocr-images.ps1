<#
.SYNOPSIS
Offline OCR for explicitly supplied local PNG files. Windows PowerShell 5.1 only.
.DESCRIPTION
No browser capture, downloads, language installation or cloud API. Supply ImagePath
or a JSON array / { "images": [...] }. Entries have path, questionKey and imageKey;
optional sha256 pins the expected source bytes (64 hexadecimal digits). Mismatches
are reported before cache lookup or OCR, so a prepared image cannot silently change.
relative entries resolve against the manifest directory. Every entry remains in the
output, including duplicate paths/content with different question or image keys.

Optional CacheDirectory contains local JSON records keyed by source-byte SHA256,
CacheVersion, Windows.Media.Ocr, resolved language, Windows version and PreprocessKey.
No pixel normalization is done. PreprocessKey declares the caller's preprocessing
configuration, so change it whenever that configuration changes. Identical pixels
with different PNG encodings can miss the cache. Only recognized nonempty output is
cached. Cache hits are reading aids, never verified mathematical transcription.

ImageTimeoutMs is the total per-image budget; BatchTimeoutMs covers input setup,
initialization and all image operations. The final JSON report is still emitted
after a deadline so every pending association has an explicit status.
TimeoutMs remains the per-WinRT-wait ceiling and the default
image budget for older callers. Each wait is bounded by both remaining budgets.
Synchronous local reads cannot be preempted; budgets are checked before/after them.
OutputPath must be a new file in an existing directory. Existing files, inputs and
the manifest are never overwritten. Invalid output configuration returns JSON on
stdout with exit 2. Cache records never contain questionKey/imageKey or input paths.
.EXAMPLE
& .\ocr-images.ps1 -ManifestPath .\images.json -CacheDirectory .\ocr-cache -OutputPath .\new-result.json
.EXAMPLE
powershell.exe -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('C:\work\ocr-images.ps1'))) -ImagePath 'C:\work\q01.png'"
.NOTES
Exit 0: every requested entry recognized nonempty text (including cache hits).
Exit 1: partial/failed/empty/timeout/skipped results after runtime initialization.
Exit 2: invalid input/output/cache configuration or unavailable runtime/language.
Parameter-binding errors happen before the helper runs: the PowerShell host returns
its native error exit (normally 1), without the helper's structured JSON.
Saved JSON is UTF-8 without BOM. The helper never changes execution policies.
timings.outputMs measures output preparation; it excludes its final serialization
and file/stdout transfer, which cannot be reported in the already emitted JSON.
Microsoft references (checked 2026-10-15):
https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine
https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrword.boundingrect
https://learn.microsoft.com/en-us/uwp/api/windows.graphics.imaging.bitmapdecoder.getsoftwarebitmapasync
#>
[CmdletBinding()]
param(
    [string[]] $ImagePath = @(),
    [string] $ManifestPath,
    [string] $OutputPath,
    [string] $LanguageTag,
    [ValidateRange(1, 120000)] [int] $TimeoutMs = 30000,
    [ValidateRange(0, 120000)] [int] $ImageTimeoutMs = 0,
    [ValidateRange(1, 3600000)] [int] $BatchTimeoutMs = 120000,
    [string] $CacheDirectory,
    [ValidateNotNullOrEmpty()] [string] $CacheVersion = 'windows-media-ocr/v2',
    [ValidateNotNullOrEmpty()] [string] $PreprocessKey = 'source-png/bgra8-ignore-alpha/v1'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$clock = [Diagnostics.Stopwatch]::StartNew()
if ($ImageTimeoutMs -eq 0) { $ImageTimeoutMs = $TimeoutMs }
$document = [ordered]@{
    schema = 'chaoxing-local-ocr/v2'; engine = 'Windows.Media.Ocr'; status = 'failed'
    generatedAt = [DateTime]::UtcNow.ToString('o'); requestedLanguage = $LanguageTag
    language = $null; availableLanguages = @(); verified = $false
    cache = [ordered]@{ enabled = [bool]$CacheDirectory; version = $CacheVersion; preprocessKey = $PreprocessKey; hashMode = 'source-bytes-sha256'; runtimeVersion = [Environment]::OSVersion.Version.ToString() }
    budgets = [ordered]@{ batchTimeoutMs = $BatchTimeoutMs; imageTimeoutMs = $ImageTimeoutMs; winRtWaitCeilingMs = $TimeoutMs }
    stats = [ordered]@{ requested = 0; uniqueContents = 0; recognitionCalls = 0; memoryHits = 0; diskHits = 0; cacheWrites = 0 }
    timings = [ordered]@{ inputMs = 0; initializationMs = 0; outputMs = 0; totalMs = 0 }
    diagnostics = @('OCR is unverified. Review formulas, signs, units and diagrams against the source image. No confidence score is supplied by this API.')
    results = @(); elapsedMs = 0
}
$exitCode = 2
$inputItems = New-Object 'System.Collections.Generic.List[object]'
$allResults = New-Object 'System.Collections.Generic.List[object]'
$memoryCache = @{}
$contentHashes = New-Object 'System.Collections.Generic.HashSet[string]'
$destination = $null
$manifestFile = $null
$cacheRoot = $null
$inputTimer = [Diagnostics.Stopwatch]::StartNew()

function Get-EntryValue($Entry, [string] $Name) {
    if ($null -eq $Entry) { return $null }
    $property = $Entry.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Get-ErrorDetail($Failure) {
    $exception = $Failure.Exception
    $messages = @()
    while ($null -ne $exception) {
        $messages += $exception.Message
        $exception = $exception.InnerException
    }
    return ($messages | Select-Object -Unique) -join ' | '
}

function Resolve-LocalPath([string] $Value, [string] $BaseDirectory) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'A non-empty local file/directory path is required.' }
    if ($Value -match '^[a-zA-Z][a-zA-Z0-9+.-]*://' -or $Value.StartsWith('\\') -or $Value.StartsWith('//')) {
        throw 'Only local paths are accepted; URLs, device paths and UNC network paths are rejected.'
    }
    if (-not [IO.Path]::IsPathRooted($Value)) { $Value = Join-Path $BaseDirectory $Value }
    $resolved = [IO.Path]::GetFullPath($Value)
    if ($resolved -notmatch '^[a-zA-Z]:\\' -or $resolved.Substring(2).Contains(':')) {
        throw 'Only local drive paths are accepted; providers, URLs, UNC and alternate data streams are rejected.'
    }
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($resolved))
    if ($drive.DriveType -eq [IO.DriveType]::Network) { throw 'Mapped network drives are not supported.' }
    # Walk from the local drive downwards, before opening a file. A local junction
    # or symlink can redirect to UNC; reject reparse points rather than follow them.
    $rootPath = [IO.Path]::GetPathRoot($resolved)
    $probe = $rootPath
    foreach ($part in $resolved.Substring($rootPath.Length).Split('\')) {
        if (-not $part) { continue }
        $probe = [IO.Path]::Combine($probe, $part)
        try { $attributes = [IO.File]::GetAttributes($probe) }
        catch [IO.FileNotFoundException] { break }
        catch [IO.DirectoryNotFoundException] { break }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points/symlinks are not supported; supply a direct local path.' }
    }
    return $resolved
}

function Get-Sha256([byte[]] $Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Assert-Budget([long] $ImageDeadline, [string] $Stage) {
    if ($clock.ElapsedMilliseconds -ge $BatchTimeoutMs) {
        throw (New-Object TimeoutException("Batch deadline expired during $Stage."))
    }
    if ($clock.ElapsedMilliseconds -ge $ImageDeadline) {
        throw (New-Object TimeoutException("Image deadline expired during $Stage."))
    }
}

function New-ImageResult($Item) {
    return [ordered]@{
        path = $Item.path; questionKey = $Item.questionKey; imageKey = $Item.imageKey; expectedSha256 = $Item.expectedSha256
        status = 'failed'; reason = $null; timeoutScope = $null; language = $document.language
        text = ''; lines = @(); width = $null; height = $null; textAngle = $null
        verified = $false; cacheHit = $false; cacheSource = $null; cacheKey = $null; sourceSha256 = $null
        timings = [ordered]@{ readMs = 0; decodeMs = 0; recognizeMs = 0; cacheMs = 0; outputMs = 0; totalMs = 0 }
        elapsedMs = 0; diagnostics = @()
    }
}

function Copy-Payload($Payload, $Result) {
    $Result.text = [string]$Payload.text
    $Result.lines = @($Payload.lines)
    $Result.width = $Payload.width
    $Result.height = $Payload.height
    $Result.textAngle = $Payload.textAngle
    $Result.status = 'recognized'
}

try {
    $workingDirectory = (Get-Location).ProviderPath
    foreach ($path in $ImagePath) {
        $inputItems.Add([pscustomobject]@{ path = (Resolve-LocalPath $path $workingDirectory); questionKey = $null; imageKey = $null; expectedSha256 = $null })
    }
    if ($ManifestPath) {
        $manifestFile = Resolve-LocalPath $ManifestPath $workingDirectory
        $manifest = [IO.File]::ReadAllText($manifestFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
        $manifestImages = Get-EntryValue $manifest 'images'
        $entries = if ($null -ne $manifestImages) { @($manifestImages) } else { @($manifest) }
        foreach ($entry in $entries) {
            $inputItems.Add([pscustomobject]@{
                path = (Resolve-LocalPath ([string](Get-EntryValue $entry 'path')) ([IO.Path]::GetDirectoryName($manifestFile)))
                questionKey = (Get-EntryValue $entry 'questionKey'); imageKey = (Get-EntryValue $entry 'imageKey')
                expectedSha256 = (Get-EntryValue $entry 'sha256')
            })
        }
    }
    $document.stats.requested = $inputItems.Count
    if ($inputItems.Count -eq 0) { throw 'Supply -ImagePath or a non-empty -ManifestPath.' }
    if ($OutputPath) {
        $candidate = Resolve-LocalPath $OutputPath $workingDirectory
        if (@($inputItems | Where-Object { $_.path -ieq $candidate }).Count -gt 0) { throw 'OutputPath must not overwrite an input PNG.' }
        if ($manifestFile -and $candidate -ieq $manifestFile) { throw 'OutputPath must not overwrite the input manifest.' }
        if ([IO.File]::Exists($candidate) -or [IO.Directory]::Exists($candidate)) { throw 'OutputPath already exists; choose a new file. Nothing was overwritten.' }
        if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($candidate))) { throw 'Output directory does not exist.' }
        $destination = $candidate
    }
    if ($CacheDirectory) {
        $cacheRoot = Resolve-LocalPath $CacheDirectory $workingDirectory
        if ([IO.File]::Exists($cacheRoot)) { throw 'CacheDirectory must be a directory, not a file.' }
        $null = [IO.Directory]::CreateDirectory($cacheRoot)
    }
    $document.timings.inputMs = $inputTimer.ElapsedMilliseconds
    $inputTimer.Stop()
    $initTimer = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($PSVersionTable.PSEdition -eq 'Core' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
            throw 'Run with built-in Windows PowerShell 5.1 (powershell.exe), not PowerShell 7/pwsh.'
        }
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
        $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
        $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
        $null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime]
        $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
        $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
        $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
        $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and
            $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1
        if ($null -eq $script:asTask) { throw 'Windows Runtime async bridge is unavailable.' }
        function Wait-WinRt($Operation, [Type] $ResultType, [long] $ImageDeadline) {
            try { Assert-Budget $ImageDeadline 'WinRT operation' }
            catch { try { $Operation.Cancel() } catch { }; throw }
            $remaining = [Math]::Min(($BatchTimeoutMs - $clock.ElapsedMilliseconds), ($ImageDeadline - $clock.ElapsedMilliseconds))
            $waitMs = [int][Math]::Max(1, [Math]::Min($TimeoutMs, $remaining))
            $task = $script:asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
            if (-not $task.Wait($waitMs)) {
                try { $Operation.Cancel() } catch { }
                throw (New-Object TimeoutException("Windows Runtime operation reached its remaining wait budget ($waitMs ms)."))
            }
            $value = $task.GetAwaiter().GetResult()
            Assert-Budget $ImageDeadline 'completed WinRT operation'
            return $value
        }
        $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
        $document.availableLanguages = @($languages | ForEach-Object { $_.LanguageTag })
        if ($LanguageTag) {
            $requested = New-Object Windows.Globalization.Language($LanguageTag)
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($requested)
            if ($null -eq $engine) { throw "OCR language '$LanguageTag' is not available. Installed: $($document.availableLanguages -join ', '). No language pack was installed." }
        } else {
            $chinese = $languages | Where-Object { $_.LanguageTag -like 'zh-Hans*' } | Select-Object -First 1
            if ($null -ne $chinese) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($chinese) }
            else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
            if ($null -eq $engine) { throw "No usable OCR language is installed. Installed: $($document.availableLanguages -join ', '). No language pack was installed." }
        }
        $document.language = $engine.RecognizerLanguage.LanguageTag
    } finally { $document.timings.initializationMs = $initTimer.ElapsedMilliseconds }

    $exitCode = 0
    foreach ($item in $inputItems) {
        $imageClock = [Diagnostics.Stopwatch]::StartNew()
        $imageDeadline = $clock.ElapsedMilliseconds + $ImageTimeoutMs
        $result = New-ImageResult $item
        if ($clock.ElapsedMilliseconds -ge $BatchTimeoutMs) {
            $result.status = 'skipped'; $result.reason = 'batch-timeout'; $result.timeoutScope = 'batch'
            $result.diagnostics += 'Not started: the total batch deadline has expired.'
            $allResults.Add([pscustomobject]$result)
            $exitCode = 1
            continue
        }
        $stream = $null; $writer = $null; $bitmap = $null
        $stage = 'validate-input'; $stageTimer = $null; $timingField = $null
        try {
            Assert-Budget $imageDeadline $stage
            if ([IO.Path]::GetExtension($item.path) -ine '.png') { throw 'Only explicitly supplied local PNG files are supported.' }
            if (-not [IO.File]::Exists($item.path)) { throw 'Input PNG does not exist.' }
            $stage = 'read-local-file'; $timingField = 'readMs'; $stageTimer = [Diagnostics.Stopwatch]::StartNew()
            $bytes = [IO.File]::ReadAllBytes($item.path)
            $result.sourceSha256 = Get-Sha256 $bytes
            $null = $contentHashes.Add($result.sourceSha256)
            if ($null -ne $item.expectedSha256) {
                $stage = 'image-hash-mismatch'
                $expectedHash = [string]$item.expectedSha256
                if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Manifest sha256 must contain exactly 64 hexadecimal digits.' }
                if ($result.sourceSha256 -ine $expectedHash) { throw 'Source PNG bytes do not match the manifest sha256. Regenerate the prepared image and manifest.' }
                $stage = 'read-local-file'
            }
            Assert-Budget $imageDeadline $stage
            $result.timings.readMs += $stageTimer.ElapsedMilliseconds; $stageTimer = $null

            $stage = 'cache-lookup'; $timingField = 'cacheMs'; $stageTimer = [Diagnostics.Stopwatch]::StartNew()
            $fingerprint = [ordered]@{
                version = $CacheVersion; engine = $document.engine; language = $document.language
                runtimeVersion = $document.cache.runtimeVersion; preprocessKey = $PreprocessKey; sourceSha256 = $result.sourceSha256
            }
            $result.cacheKey = Get-Sha256 ([Text.Encoding]::UTF8.GetBytes(($fingerprint | ConvertTo-Json -Compress)))
            $payload = $null
            if ($memoryCache.ContainsKey($result.cacheKey)) {
                $payload = $memoryCache[$result.cacheKey]; $result.cacheHit = $true; $result.cacheSource = 'memory'
            } elseif ($cacheRoot) {
                $cacheFile = Join-Path $cacheRoot ($result.cacheKey + '.json')
                if ([IO.File]::Exists($cacheFile)) {
                    try {
                        $record = [IO.File]::ReadAllText($cacheFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
                        if ($record.schema -ne 'chaoxing-ocr-cache/v2' -or $record.cacheKey -ne $result.cacheKey -or
                            $record.fingerprint.sourceSha256 -ne $result.sourceSha256 -or $record.fingerprint.version -ne $CacheVersion -or
                            $record.fingerprint.engine -ne $document.engine -or $record.fingerprint.language -ne $document.language -or
                            $record.fingerprint.runtimeVersion -ne $document.cache.runtimeVersion -or $record.fingerprint.preprocessKey -ne $PreprocessKey -or
                            $record.payload.status -ne 'recognized' -or [string]::IsNullOrWhiteSpace([string]$record.payload.text)) { throw 'Cache metadata did not match this content/configuration.' }
                        $payload = $record.payload; $result.cacheHit = $true; $result.cacheSource = 'disk'
                        $memoryCache[$result.cacheKey] = $payload
                    } catch { $result.diagnostics += ('Cache ignored: ' + (Get-ErrorDetail $_)) }
                }
            }
            Assert-Budget $imageDeadline $stage
            $result.timings.cacheMs += $stageTimer.ElapsedMilliseconds; $stageTimer = $null
            if ($null -ne $payload) {
                $stage = 'prepare-cached-output'; $timingField = 'outputMs'; $stageTimer = [Diagnostics.Stopwatch]::StartNew()
                Copy-Payload $payload $result
                $result.diagnostics += 'Cache hit; text remains unverified. Review against the current source image.'
                Assert-Budget $imageDeadline $stage
                if ($result.cacheSource -eq 'memory') { $document.stats.memoryHits++ } else { $document.stats.diskHits++ }
                $result.timings.outputMs += $stageTimer.ElapsedMilliseconds; $stageTimer = $null
            } else {
                $stage = 'decode-image'; $timingField = 'decodeMs'; $stageTimer = [Diagnostics.Stopwatch]::StartNew()
                # In-memory streams avoid the desktop WinRT StorageFile broker.
                $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
                $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
                $writer.WriteBytes($bytes)
                $null = Wait-WinRt ($writer.StoreAsync()) ([uint32]) $imageDeadline
                $null = $writer.DetachStream(); $writer.Dispose(); $writer = $null
                $stream.Seek(0)
                $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]) $imageDeadline
                $result.width = $decoder.PixelWidth; $result.height = $decoder.PixelHeight
                $maximum = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
                if ($result.width -gt $maximum -or $result.height -gt $maximum) { throw "Image exceeds OCR maximum dimension $maximum pixels; supply a question/image crop." }
                $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)) ([Windows.Graphics.Imaging.SoftwareBitmap]) $imageDeadline
                $result.timings.decodeMs += $stageTimer.ElapsedMilliseconds; $stageTimer = $null

                $stage = 'recognize-image'; $timingField = 'recognizeMs'; $stageTimer = [Diagnostics.Stopwatch]::StartNew()
                Assert-Budget $imageDeadline $stage
                $document.stats.recognitionCalls++
                $recognized = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]) $imageDeadline
                $result.timings.recognizeMs += $stageTimer.ElapsedMilliseconds; $stageTimer = $null

                $stage = 'prepare-output'; $timingField = 'outputMs'; $stageTimer = [Diagnostics.Stopwatch]::StartNew()
                $result.text = $recognized.Text; $result.textAngle = $recognized.TextAngle
                $result.lines = @($recognized.Lines | ForEach-Object {
                    $line = $_
                    $words = @($line.Words | ForEach-Object {
                        $rect = $_.BoundingRect
                        [ordered]@{ text = $_.Text; bounds = [ordered]@{ x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height } }
                    })
                    $bounds = $null
                    if ($words.Count -gt 0) {
                        $x = ($words | ForEach-Object { $_.bounds.x } | Measure-Object -Minimum).Minimum
                        $y = ($words | ForEach-Object { $_.bounds.y } | Measure-Object -Minimum).Minimum
                        $right = ($words | ForEach-Object { $_.bounds.x + $_.bounds.width } | Measure-Object -Maximum).Maximum
                        $bottom = ($words | ForEach-Object { $_.bounds.y + $_.bounds.height } | Measure-Object -Maximum).Maximum
                        $bounds = [ordered]@{ x = $x; y = $y; width = ($right - $x); height = ($bottom - $y) }
                    }
                    [ordered]@{ text = $line.Text; bounds = $bounds; words = $words }
                })
                if ([string]::IsNullOrWhiteSpace($result.text)) {
                    $result.status = 'empty'; $result.reason = 'no-text'
                    $result.diagnostics += 'OCR completed but returned no text. Inspect the image visually.'
                    $exitCode = 1
                } else {
                    $result.status = 'recognized'; $result.diagnostics += 'Text is unverified; this API does not return a confidence score.'
                }
                Assert-Budget $imageDeadline $stage
                $result.timings.outputMs += $stageTimer.ElapsedMilliseconds; $stageTimer = $null
                if ($result.status -eq 'recognized') {
                    $stage = 'cache-store'; $timingField = 'cacheMs'; $stageTimer = [Diagnostics.Stopwatch]::StartNew()
                    $payload = [pscustomobject]@{ status = 'recognized'; text = $result.text; lines = $result.lines; width = $result.width; height = $result.height; textAngle = $result.textAngle }
                    $memoryCache[$result.cacheKey] = $payload
                    if ($cacheRoot) {
                        $cacheFile = Join-Path $cacheRoot ($result.cacheKey + '.json')
                        $cacheStream = $null; $cacheWriter = $null
                        try {
                            $record = [ordered]@{ schema = 'chaoxing-ocr-cache/v2'; cacheKey = $result.cacheKey; fingerprint = $fingerprint; createdAt = [DateTime]::UtcNow.ToString('o'); verified = $false; payload = $payload }
                            $cacheJson = $record | ConvertTo-Json -Depth 12
                            $cacheStream = New-Object IO.FileStream($cacheFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                            $cacheWriter = New-Object IO.StreamWriter($cacheStream, (New-Object Text.UTF8Encoding($false)))
                            $cacheWriter.Write($cacheJson); $cacheWriter.Flush()
                            $document.stats.cacheWrites++
                        } catch { $result.diagnostics += ('Cache not written: ' + (Get-ErrorDetail $_)) }
                        finally { if ($cacheWriter) { $cacheWriter.Dispose() }; if ($cacheStream) { $cacheStream.Dispose() } }
                    }
                    Assert-Budget $imageDeadline $stage
                    $result.timings.cacheMs += $stageTimer.ElapsedMilliseconds; $stageTimer = $null
                }
            }
        } catch {
            $isTimeout = $_.Exception -is [TimeoutException] -or $_.Exception.InnerException -is [TimeoutException]
            if ($isTimeout) {
                $result.status = 'timeout'; $result.reason = 'deadline-expired'
                $result.cacheHit = $false; $result.cacheSource = $null
                $result.timeoutScope = if ($clock.ElapsedMilliseconds -ge $BatchTimeoutMs) { 'batch' } elseif ($clock.ElapsedMilliseconds -ge $imageDeadline) { 'image' } else { 'winrt-operation' }
            } else { $result.status = 'failed'; $result.reason = $stage }
            $result.diagnostics += ($stage + ': ' + (Get-ErrorDetail $_))
            $exitCode = 1
        } finally {
            if ($null -ne $stageTimer -and $timingField) { $result.timings[$timingField] += $stageTimer.ElapsedMilliseconds }
            foreach ($disposable in @($bitmap, $writer, $stream)) {
                if ($null -ne $disposable) { try { $disposable.Dispose() } catch { $result.diagnostics += 'A timed-out image resource could not be disposed immediately.' } }
            }
            $result.elapsedMs = $imageClock.ElapsedMilliseconds; $result.timings.totalMs = $result.elapsedMs
        }
        $allResults.Add([pscustomobject]$result)
    }
    $document.status = if ($exitCode -eq 0) { 'recognized' } else { 'partial-or-failed' }
} catch {
    $exitCode = 2
    $document.diagnostics += (Get-ErrorDetail $_)
    $allResults.Clear()
    foreach ($item in $inputItems) {
        $result = New-ImageResult $item
        $result.status = 'not-run'; $result.reason = 'initialization-or-input'
        $result.diagnostics += 'Initialization or input validation failed; see document diagnostics.'
        $allResults.Add([pscustomobject]$result)
    }
}

$outputTimer = [Diagnostics.Stopwatch]::StartNew()
$document.results = @($allResults.ToArray())
$document.stats.uniqueContents = $contentHashes.Count
if ($document.timings.inputMs -eq 0) { $document.timings.inputMs = $inputTimer.ElapsedMilliseconds }
$null = $document | ConvertTo-Json -Depth 12
$document.timings.outputMs = $outputTimer.ElapsedMilliseconds
$document.elapsedMs = $clock.ElapsedMilliseconds; $document.timings.totalMs = $document.elapsedMs
$json = $document | ConvertTo-Json -Depth 12
if ($destination) {
    $outputStream = $null; $outputWriter = $null
    try {
        $outputStream = New-Object IO.FileStream($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $outputWriter = New-Object IO.StreamWriter($outputStream, (New-Object Text.UTF8Encoding($false)))
        $outputWriter.Write($json); $outputWriter.Flush()
    } catch {
        $exitCode = 2; $document.status = 'failed'
        $document.diagnostics += ('Output not written: ' + (Get-ErrorDetail $_))
        [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
        Write-Output ($document | ConvertTo-Json -Depth 12)
    } finally { if ($outputWriter) { $outputWriter.Dispose() }; if ($outputStream) { $outputStream.Dispose() } }
} else {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    Write-Output $json
}
exit $exitCode
