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

test('dense sheets pack small formulas into columns and keep wide formulas complete and nonoverlapping', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chaoxing-image-test-'));
  try {
    const helper = path.join(root, 'skill/scripts/prepare-images.ps1');
    powershell(`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Drawing
$entries=New-Object 'System.Collections.Generic.List[object]'
for($i=0;$i -lt 15;$i++){
 $w=if($i -eq 6){700}else{80};$b=New-Object Drawing.Bitmap($w,30);$g=[Drawing.Graphics]::FromImage($b);$g.Clear([Drawing.Color]::White);$g.FillRectangle([Drawing.Brushes]::Blue,($w-10),0,10,30)
 $p=Join-Path ${psQuote(directory)} ('source-'+$i+'.png');$b.Save($p,[Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$b.Dispose()
 $s=[Security.Cryptography.SHA256]::Create();$h=([BitConverter]::ToString($s.ComputeHash([IO.File]::ReadAllBytes($p)))).Replace('-','').ToLowerInvariant();$s.Dispose()
 $entries.Add(@{path=$p;sha256=$h;imageKey=('a'+$i);assetId=('a'+$i);questionKey='q1';questionKeys=@('q1');aliases=@()})
}
$m=@{captureHash=('a'*64);images=$entries.ToArray()};$mf=Join-Path ${psQuote(directory)} 'manifest.json';[IO.File]::WriteAllText($mf,($m|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(helper)}))) -ManifestPath $mf -OutputDirectory ${psQuote(path.join(directory,'dense'))} -SheetHeight 900 -SheetWidth 1200 -Columns 3
& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(helper)}))) -ManifestPath $mf -OutputDirectory ${psQuote(path.join(directory,'single'))} -SheetHeight 900 -SheetWidth 1200 -Columns 1`);
    const dense = JSON.parse(readFileSync(path.join(directory, 'dense/images.json'))), single = JSON.parse(readFileSync(path.join(directory, 'single/images.json')));
    assert.equal(dense.images.length, 15); assert.ok(dense.sheets.length < single.sheets.length);
    const all = dense.sheets.flatMap(s => s.tiles);
    assert.equal(all.length, 15); assert.ok(all.some(t => t.x > 12)); assert.ok(all.some(t => t.width > 1000));
    for (const sheet of dense.sheets) for (const [i, a] of sheet.tiles.entries()) {
      assert.ok(a.x >= 0 && a.y >= 32 && a.x + a.width <= sheet.width && a.y + a.height <= sheet.height);
      for (const b of sheet.tiles.slice(i + 1)) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height + 32 <= b.y || b.y + b.height + 32 <= a.y, 'images and labels must not overlap');
    }
  } finally {
    const absolute = path.resolve(directory), boundary = path.resolve(tmpdir()) + path.sep;
    if (!absolute.startsWith(boundary) || !path.basename(absolute).startsWith('chaoxing-image-test-')) throw new Error('Unsafe temporary cleanup');
    rmSync(absolute, { recursive: true, force: true });
  }
});

test('JPEG screenshot normalization verifies hash and aspect and never re-arms a discarded page', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chaoxing-image-test-'));
  try {
    const helper = path.join(root, 'skill/scripts/normalize-screenshots.ps1');
    powershell(`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Drawing
$b=New-Object Drawing.Bitmap(600,1200);$g=[Drawing.Graphics]::FromImage($b);$g.Clear([Drawing.Color]::White);$g.FillRectangle([Drawing.Brushes]::Black,10,10,40,40)
$p=${psQuote(path.join(directory, 'browser.jpg'))};$b.Save($p,[Drawing.Imaging.ImageFormat]::Jpeg);$g.Dispose();$b.Dispose()
$h=[Security.Cryptography.SHA256]::Create();$hash=([BitConverter]::ToString($h.ComputeHash([IO.File]::ReadAllBytes($p)))).Replace('-','').ToLowerInvariant();$h.Dispose()
$m=@{captureHash=('a'*64);screenshots=@(@{path=$p;sha256=$hash;frame='top';cssBounds=@{x=100;y=50;width=300;height=600};ready=$false;needsNormalization=$true;assetIds=@('a')})}
$mf=${psQuote(path.join(directory, 'screenshots.json'))};[IO.File]::WriteAllText($mf,($m|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(helper)}))) -ManifestPath $mf -OutputDirectory ${psQuote(path.join(directory, 'normalized'))}`);
    const result = JSON.parse(readFileSync(path.join(directory, 'normalized/screenshots.json')));
    const shot = result.screenshots[0];
    assert.equal(shot.ready, true); assert.equal(shot.needsNormalization, false); assert.deepEqual(shot.pixelSize, { width: 600, height: 1200 }); assert.equal(shot.assetIds[0], 'a');
    assert.equal(readFileSync(shot.path).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const input = JSON.parse(readFileSync(path.join(directory, 'screenshots.json')));
    for (const issue of ['hash', 'aspect', 'discarded']) {
      const bad = structuredClone(input);
      if (issue === 'hash') bad.screenshots[0].sha256 = 'b'.repeat(64);
      if (issue === 'aspect') bad.screenshots[0].cssBounds.width = 200;
      if (issue === 'discarded') bad.screenshots[0].discarded = true;
      const badPath = path.join(directory, `bad-${issue}.json`); writeFileSync(badPath, JSON.stringify(bad));
      const script = `& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(helper)}))) -ManifestPath ${psQuote(badPath)} -OutputDirectory ${psQuote(path.join(directory, 'bad-' + issue))}`;
      const failure = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      assert.notEqual(failure.status, 0, issue + ' must be rejected');
    }
  } finally {
    const absolute = path.resolve(directory), boundary = path.resolve(tmpdir()) + path.sep;
    if (!absolute.startsWith(boundary) || !path.basename(absolute).startsWith('chaoxing-image-test-')) throw new Error('Unsafe temporary cleanup');
    rmSync(absolute, { recursive: true, force: true });
  }
});
