import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
function powershell(code) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

test('Windows image preparation retains transparent edges, whitens background and fits complete previews', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chaoxing-image-test-'));
  const helper = path.join(root, 'skill/scripts/prepare-images.ps1');
  try {
    powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing
$p=${psQuote(path.join(directory, 'long.png'))}
$b=New-Object Drawing.Bitmap(2400,80); $g=[Drawing.Graphics]::FromImage($b)
$g.Clear([Drawing.Color]::Transparent); $g.FillRectangle([Drawing.Brushes]::Black,0,10,40,60); $g.FillRectangle([Drawing.Brushes]::Blue,2360,10,40,60)
$b.Save($p,[Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$b.Dispose()
$sha=[Security.Cryptography.SHA256]::Create();$h=([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($p)))).Replace('-','').ToLowerInvariant();$sha.Dispose()
$m=@{captureHash=('a'*64);images=@(@{path=$p;sha256=$h;imageKey='asset-1';assetId='asset-1';questionKey='q1';questionKeys=@('q1');aliases=@(@{assetId='asset-1';path=$p;sha256=$h;questionKey='q1';questionKeys=@('q1')})})}
[IO.File]::WriteAllText(${psQuote(path.join(directory, 'manifest.json'))},($m|ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(helper)}))) -ManifestPath ${psQuote(path.join(directory, 'manifest.json'))} -OutputDirectory ${psQuote(path.join(directory, 'prepared'))}
$normalized=[Drawing.Bitmap]::FromFile(${psQuote(path.join(directory, 'prepared/image-0001.png'))})
if($normalized.Width -ne 7232 -or $normalized.Height -ne 272){throw 'Scaled size mismatch'}
if($normalized.GetPixel(0,0).ToArgb() -ne [Drawing.Color]::White.ToArgb()){throw 'Background not white'}
if($normalized.GetPixel(7200,100).B -lt 200 -or $normalized.GetPixel(7200,100).R -gt 50){throw 'Right edge clipped'}
$normalized.Dispose()`);
    const manifest = JSON.parse(readFileSync(path.join(directory, 'prepared/images.json'), 'utf8'));
    assert.equal(manifest.images.length, 1); assert.equal(manifest.sheets.length, 1);
    assert.notEqual(manifest.images[0].sha256, manifest.images[0].originalSha256);
    assert.equal(manifest.images[0].aliases[0].sha256, manifest.images[0].sha256);
    const tile = manifest.sheets[0].tiles[0];
    assert.ok(tile.x + tile.width <= manifest.sheets[0].width); assert.ok(tile.y + tile.height <= manifest.sheets[0].height);
    assert.ok(tile.previewScale < 1);
    // Existing directory must be refused, leaving original outputs intact.
    const before = readFileSync(path.join(directory, 'prepared/image-0001.png'));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(helper)}))) -ManifestPath ${psQuote(path.join(directory, 'manifest.json'))} -OutputDirectory ${psQuote(path.join(directory, 'prepared'))}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0); assert.deepEqual(readFileSync(path.join(directory, 'prepared/image-0001.png')), before);
  } finally {
    const absolute = path.resolve(directory), boundary = path.resolve(tmpdir()) + path.sep;
    if (!absolute.startsWith(boundary) || !path.basename(absolute).startsWith('chaoxing-image-test-')) throw new Error('Unsafe temporary cleanup');
    rmSync(absolute, { recursive: true, force: true });
  }
});
