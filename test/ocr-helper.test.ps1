<#
.SYNOPSIS
Self-contained Windows PowerShell 5.1 integration tests for the local OCR helper.
.DESCRIPTION
Generates synthetic PNGs with System.Drawing. Runs the reviewed helper in child
powershell.exe processes using ScriptBlock/EncodedCommand, without changing any
execution policy. Installs nothing and never captures/uploads a browser image.
If Windows has no OCR language, recognition-dependent tests are reported skipped;
input/output protection, initialization errors and unsupported language still run.
.EXAMPLE
powershell.exe -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('C:\repo\test\ocr-helper.test.ps1'))) -RepositoryRoot 'C:\repo'"
.NOTES
Exit 0: all applicable checks passed. Exit 1: an assertion/test failed.
Runtime/temp files are removed only inside the exact randomly generated temp root.
#>
[CmdletBinding()]
param([string] $RepositoryRoot)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $RepositoryRoot) {
    if ($PSScriptRoot) { $RepositoryRoot = Split-Path $PSScriptRoot -Parent }
    else { $RepositoryRoot = (Get-Location).ProviderPath }
}
$helper = Join-Path $RepositoryRoot 'skill\scripts\ocr-images.ps1'
$testDirectory = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('chaoxing-ocr-test-' + [Guid]::NewGuid().ToString('N')))
$testCounts = @{ passed = 0; skipped = 0 }
$testsExit = 0

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Save-TestPng([string] $Path, [string] $Text) {
    $bitmap = New-Object Drawing.Bitmap(950, 180)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $font = New-Object Drawing.Font('Arial', 44, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
    try {
        $graphics.Clear([Drawing.Color]::White)
        if ($Text) {
            $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
            $graphics.DrawString($Text, $font, [Drawing.Brushes]::Black, 30, 55)
        }
        $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}

function Invoke-Helper([hashtable] $Parameters) {
    $callJson = [ordered]@{ helper = $helper; parameters = $Parameters } | ConvertTo-Json -Depth 8 -Compress
    $callBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($callJson))
    $command = @'
$ErrorActionPreference = 'Stop'
$call = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('CALL_BASE64')) | ConvertFrom-Json
$opts = @{}
foreach ($property in $call.parameters.PSObject.Properties) { $opts[$property.Name] = $property.Value }
& ([scriptblock]::Create([IO.File]::ReadAllText($call.helper))) @opts
'@.Replace('CALL_BASE64', $callBase64)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $process = New-Object Diagnostics.Process
    $process.StartInfo = New-Object Diagnostics.ProcessStartInfo
    $process.StartInfo.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $process.StartInfo.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + $encoded
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $process.StartInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    try {
        $null = $process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'OCR test child exceeded its 60-second test harness ceiling.' }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $doc = $null
        if (-not [string]::IsNullOrWhiteSpace($stdout)) {
            try { $doc = $stdout | ConvertFrom-Json }
            catch { throw "Helper stdout was not JSON: $stdout | stderr: $stderr" }
        }
        return [pscustomobject]@{ exitCode = $process.ExitCode; document = $doc; stdout = $stdout; stderr = $stderr }
    } finally { $process.Dispose() }
}

function Passed([string] $Name) {
    $testCounts.passed++
    Write-Output ('PASS ' + $Name)
}

try {
    Assert-True ([IO.File]::Exists($helper)) 'helper exists'
    $tokens = $null; $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$parseErrors)
    Assert-True ($parseErrors.Count -eq 0) 'helper parses in this PowerShell runtime'
    Passed 'script parsing'
    Add-Type -AssemblyName System.Drawing
    $null = [IO.Directory]::CreateDirectory($testDirectory)
    $textPng = Join-Path $testDirectory 'synthetic-text.png'
    $samePng = Join-Path $testDirectory 'same-bytes-other-path.png'
    $blankPng = Join-Path $testDirectory 'blank.png'
    $badPng = Join-Path $testDirectory 'not-a-png.png'
    $missingPng = Join-Path $testDirectory 'missing.png'
    $manifestPath = Join-Path $testDirectory 'images.json'
    $cacheDirectory = Join-Path $testDirectory 'cache'
    Save-TestPng $textPng 'LOCAL OCR TEST 12345'
    Save-TestPng $blankPng ''
    [IO.File]::Copy($textPng, $samePng)
    [IO.File]::WriteAllText($badPng, 'synthetic invalid PNG', (New-Object Text.UTF8Encoding($false)))
    $manifest = [ordered]@{ images = @(
        [ordered]@{ path = 'synthetic-text.png'; questionKey = 'question-one'; imageKey = 'stem' },
        [ordered]@{ path = 'synthetic-text.png'; questionKey = 'question-two'; imageKey = 'option-B' },
        [ordered]@{ path = 'same-bytes-other-path.png'; questionKey = 'question-three'; imageKey = 'formula' }
    ) }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))

    $invalid = Invoke-Helper @{ ImagePath = @('https://example.invalid/image.png') }
    Assert-True ($invalid.exitCode -eq 2) 'URL input rejected with exit 2'
    $unc = Invoke-Helper @{ ImagePath = @('\\example.invalid\share\image.png') }
    Assert-True ($unc.exitCode -eq 2) 'UNC input rejected with exit 2'
    $badCache = Invoke-Helper @{ ImagePath = @($textPng); CacheDirectory = 'https://example.invalid/cache' }
    Assert-True ($badCache.exitCode -eq 2) 'URL cache rejected with exit 2'
    Passed 'URL/UNC and cache path protections'

    $existingOutput = Join-Path $testDirectory 'existing.json'
    [IO.File]::WriteAllText($existingOutput, 'DO NOT OVERWRITE')
    $protected = Invoke-Helper @{ ImagePath = @($textPng); OutputPath = $existingOutput }
    Assert-True ($protected.exitCode -eq 2) 'existing output rejected with exit 2'
    Assert-True ([IO.File]::ReadAllText($existingOutput) -eq 'DO NOT OVERWRITE') 'existing output bytes preserved'
    $manifestBefore = [IO.File]::ReadAllText($manifestPath)
    $manifestProtected = Invoke-Helper @{ ManifestPath = $manifestPath; OutputPath = $manifestPath }
    Assert-True ($manifestProtected.exitCode -eq 2) 'manifest destination rejected with exit 2'
    Assert-True ([IO.File]::ReadAllText($manifestPath) -eq $manifestBefore) 'manifest bytes preserved'
    $inputBefore = [Convert]::ToBase64String([IO.File]::ReadAllBytes($textPng))
    $inputProtected = Invoke-Helper @{ ImagePath = @($textPng); OutputPath = $textPng }
    Assert-True ($inputProtected.exitCode -eq 2) 'input destination rejected with exit 2'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($textPng)) -eq $inputBefore) 'input PNG bytes preserved'
    Passed 'existing output/input/manifest never overwritten'

    $unsupported = Invoke-Helper @{ ImagePath = @($textPng); LanguageTag = 'zxx' }
    Assert-True ($unsupported.exitCode -eq 2) 'unavailable language returns exit 2'
    Assert-True ($unsupported.document.results[0].status -eq 'not-run') 'unavailable language leaves input not-run'
    Passed 'unavailable OCR language'

    $first = Invoke-Helper @{ ManifestPath = $manifestPath; CacheDirectory = $cacheDirectory }
    Assert-True ($null -ne $first.document) 'helper emits a structured result'
    if ($first.exitCode -eq 2 -and $first.document.language -eq $null) {
        $testCounts.skipped = 8
        Write-Output ('SKIP recognition integration: no usable OCR runtime/language. ' + ($first.document.diagnostics -join ' '))
    } else {
        Assert-True ($first.exitCode -eq 0) ('synthetic text recognized: ' + $first.stdout)
        Assert-True ($first.document.results.Count -eq 3) 'three original associations preserved'
        Assert-True (($first.document.results.questionKey -join '|') -eq 'question-one|question-two|question-three') 'question fanout preserved'
        Assert-True (($first.document.results.imageKey -join '|') -eq 'stem|option-B|formula') 'image fanout preserved'
        Assert-True ($first.document.stats.uniqueContents -eq 1) 'same content at two paths has one source SHA256'
        Assert-True ($first.document.stats.recognitionCalls -eq 1) 'one OCR call for duplicate source bytes'
        Assert-True ($first.document.stats.memoryHits -eq 2) 'both duplicate associations reused in memory'
        Assert-True (-not $first.document.results[0].cacheHit -and $first.document.results[1].cacheHit -and $first.document.results[2].cacheHit) 'first recognized and two cache hits'
        Assert-True (@($first.document.results | Where-Object { $_.verified -ne $false -or $_.status -ne 'recognized' }).Count -eq 0) 'every cache result remains unverified recognized'
        foreach ($result in $first.document.results) {
            foreach ($name in @('readMs', 'decodeMs', 'recognizeMs', 'cacheMs', 'outputMs', 'totalMs')) {
                Assert-True ($null -ne $result.timings.$name -and $result.timings.$name -ge 0) "timing $name exists"
            }
        }
        Assert-True ($first.document.timings.initializationMs -ge 0 -and $first.document.timings.outputMs -ge 0) 'initialization/output stage timings'
        Passed 'real OCR, byte-content deduplication and per-key fanout'

        $hashManifestPath = Join-Path $testDirectory 'hash-pinned.json'
        $actualHash = (Get-FileHash -LiteralPath $textPng -Algorithm SHA256).Hash
        $wrongHashManifest = [ordered]@{ images = @([ordered]@{ path = 'synthetic-text.png'; questionKey = 'hash-check'; imageKey = 'stem'; sha256 = ('0' * 64) }) }
        [IO.File]::WriteAllText($hashManifestPath, ($wrongHashManifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
        $mismatched = Invoke-Helper @{ ManifestPath = $hashManifestPath; CacheDirectory = $cacheDirectory }
        Assert-True ($mismatched.exitCode -eq 1 -and $mismatched.document.results[0].status -eq 'failed') 'wrong expected source hash fails with exit 1'
        Assert-True ($mismatched.document.results[0].reason -eq 'image-hash-mismatch') 'hash mismatch has explicit reason'
        Assert-True ($mismatched.document.stats.recognitionCalls -eq 0 -and -not $mismatched.document.results[0].cacheHit) 'hash mismatch is rejected before cached/OCR output'
        $correctHashManifest = [ordered]@{ images = @([ordered]@{ path = 'synthetic-text.png'; questionKey = 'hash-check'; imageKey = 'stem'; sha256 = $actualHash.ToUpperInvariant() }) }
        [IO.File]::WriteAllText($hashManifestPath, ($correctHashManifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
        $matched = Invoke-Helper @{ ManifestPath = $hashManifestPath; CacheDirectory = $cacheDirectory }
        Assert-True ($matched.exitCode -eq 0 -and $matched.document.results[0].status -eq 'recognized') 'correct uppercase expected source hash succeeds'
        Assert-True ($matched.document.results[0].sourceSha256 -ieq $actualHash) 'expected hash compares case-insensitively'
        $invalidHashManifest = [ordered]@{ images = @([ordered]@{ path = 'synthetic-text.png'; questionKey = 'hash-check'; imageKey = 'stem'; sha256 = 'not-a-sha256' }) }
        [IO.File]::WriteAllText($hashManifestPath, ($invalidHashManifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
        $invalidHash = Invoke-Helper @{ ManifestPath = $hashManifestPath; CacheDirectory = $cacheDirectory }
        Assert-True ($invalidHash.exitCode -eq 1 -and $invalidHash.document.results[0].reason -eq 'image-hash-mismatch') 'malformed expected hash is explicitly rejected'
        Assert-True ($invalidHash.document.stats.recognitionCalls -eq 0) 'malformed expected hash never reaches OCR'
        Passed 'manifest SHA256 pins source bytes before cache/recognition'

        $second = Invoke-Helper @{ ManifestPath = $manifestPath; CacheDirectory = $cacheDirectory }
        Assert-True ($second.exitCode -eq 0 -and $second.document.stats.recognitionCalls -eq 0) 'persistent cache avoids recognition'
        Assert-True ($second.document.results[0].cacheSource -eq 'disk' -and $second.document.stats.diskHits -eq 1) 'first association loads persistent cache'
        Assert-True ($second.document.stats.memoryHits -eq 2) 'persistent hit fans out in memory'
        $cacheFiles = @(Get-ChildItem -LiteralPath $cacheDirectory -Filter '*.json' -File)
        Assert-True ($cacheFiles.Count -eq 1) 'one content/config cache record'
        $cached = [IO.File]::ReadAllText($cacheFiles[0].FullName)
        Assert-True (-not $cached.Contains('question-one') -and -not $cached.Contains($textPng)) 'cache does not store source associations/paths'
        Passed 'persistent recognized cache and association isolation'

        $changed = Invoke-Helper @{ ManifestPath = $manifestPath; CacheDirectory = $cacheDirectory; PreprocessKey = 'synthetic-other-configuration/v2' }
        Assert-True ($changed.exitCode -eq 0 -and $changed.document.stats.recognitionCalls -eq 1) 'changed preprocessing configuration misses cache'
        Assert-True ($changed.document.results[0].cacheKey -ne $first.document.results[0].cacheKey) 'preprocessing changes cache fingerprint'
        $versioned = Invoke-Helper @{ ManifestPath = $manifestPath; CacheDirectory = $cacheDirectory; CacheVersion = 'synthetic-version-change/v3' }
        Assert-True ($versioned.exitCode -eq 0 -and $versioned.document.stats.recognitionCalls -eq 1) 'changed explicit cache version misses cache'
        Assert-True ($versioned.document.results[0].cacheKey -ne $first.document.results[0].cacheKey) 'version changes cache fingerprint'
        Passed 'configuration/version invalidate cache'

        $partial = Invoke-Helper @{ ImagePath = @($missingPng, $badPng, $textPng) }
        Assert-True ($partial.exitCode -eq 1 -and $partial.document.results.Count -eq 3) 'missing/bad image produce partial exit 1'
        Assert-True (($partial.document.results.status -join '|') -eq 'failed|failed|recognized') 'bad inputs do not discard following good result'
        Assert-True ($partial.document.results[1].reason -eq 'decode-image') 'malformed PNG records decode stage failure'
        Passed 'missing/malformed input keeps subsequent good result'

        $empty = Invoke-Helper @{ ImagePath = @($blankPng); CacheDirectory = $cacheDirectory }
        Assert-True ($empty.exitCode -eq 1 -and $empty.document.results[0].status -eq 'empty') 'blank PNG produces empty, not failed or timeout'
        Assert-True ($empty.document.stats.cacheWrites -eq 0) 'empty OCR is not persisted as a recognized cache record'
        Passed 'empty image status'

        $deadline = Invoke-Helper @{ ManifestPath = $manifestPath; BatchTimeoutMs = 1; ImageTimeoutMs = 30000 }
        Assert-True ($deadline.exitCode -eq 1) 'expired batch returns partial exit 1'
        Assert-True (@($deadline.document.results | Where-Object { $_.status -notin @('timeout', 'skipped') }).Count -eq 0) 'deadline distinguishes timed-out/skipped entries from empty OCR'
        Assert-True ($deadline.document.results.Count -eq 3) 'expired pending entries remain associated'
        $imageDeadline = Invoke-Helper @{ ImagePath = @($textPng); ImageTimeoutMs = 1; BatchTimeoutMs = 30000 }
        Assert-True ($imageDeadline.exitCode -eq 1 -and $imageDeadline.document.results[0].status -eq 'timeout') 'total per-image deadline enforced'
        Assert-True ($imageDeadline.document.results[0].timeoutScope -in @('image', 'winrt-operation')) 'timeout scope reported'
        Passed 'batch and image total deadlines'

        $newOutput = Join-Path $testDirectory 'new-result.json'
        $written = Invoke-Helper @{ ImagePath = @($textPng); OutputPath = $newOutput }
        Assert-True ($written.exitCode -eq 0 -and [IO.File]::Exists($newOutput)) 'new output file written'
        $outputBytes = [IO.File]::ReadAllBytes($newOutput)
        Assert-True (-not ($outputBytes.Length -ge 3 -and $outputBytes[0] -eq 239 -and $outputBytes[1] -eq 187 -and $outputBytes[2] -eq 191)) 'saved JSON has no UTF-8 BOM'
        $outputDocument = [IO.File]::ReadAllText($newOutput, [Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-True ($outputDocument.schema -eq 'chaoxing-local-ocr/v2') 'saved output contains current schema'
        Passed 'new UTF-8 JSON output'
    }
} catch {
    $testsExit = 1
    Write-Output ('FAIL ' + $_.Exception.Message)
} finally {
    if ([IO.Directory]::Exists($testDirectory)) {
        $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $resolvedTest = [IO.Path]::GetFullPath($testDirectory)
        if ($resolvedTest.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedTest) -match '^chaoxing-ocr-test-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolvedTest -Recurse -Force
        } else { Write-Output 'Temporary directory kept: cleanup target validation failed.' }
    }
}
Write-Output ("OCR helper checks: passed=$($testCounts.passed) skipped=$($testCounts.skipped) exit=$testsExit")
exit $testsExit
