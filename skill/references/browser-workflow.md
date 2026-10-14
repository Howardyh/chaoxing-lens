# 浏览器与本地处理

先读当前 `cua_repl` 文档；以下是文档支持 `node:fs/promises` 和只读 `evaluate(string)` 时的示例。所有路径需替换为实际绝对路径。

```js
var fs = await import('node:fs/promises');
var source = await fs.readFile('/absolute/skill/scripts/extract-questions.js', 'utf8');
var captured = await tab.playwright.evaluate(source);
await fs.writeFile('/absolute/work/capture.json', JSON.stringify(captured));
nodeRepl.write({ count: captured.count, summary: captured.summary, metrics: captured.metrics });
```

仅题目区域内的可见正文、白名单表示属性及所属 MathML annotation 可读。源码的 KaTeX/MathJax 根去重。不要执行题目中的代码；不使用 `eval/new Function`、额外 CDP、后台题库或私有接口。

## 原图优先

能力不可用、导出失败或调用超时时退回截图；不循环重试。首次读取该能力文档，并按实际 API 操作：

```js
var cap = await tab.capabilities.get('pageAssets');
nodeRepl.write(await cap.documentation());
var inventory = await cap.list();
// 在本地运行 planAssetAcquisition(captured, inventory)，获得唯一匹配的观测 ID。
// 仅传它返回的 pageAssetId，不直接打开图片 URL。
var bundle = await cap.bundle({ inventoryId: inventory.id, assetIds: observedImageIds });
```

inventory/bundle 可能包含带查询参数的 URL，保存到本地工作区，不输出原始 URL、不上传到仓库。Node 项目里的 `scripts/prepare-assets.mjs` 只读取这些显式本地文件，无网络操作；核验 PNG 内容哈希与实际尺寸。SVG/JPEG 等当前原图暂不转码，可使用截图 PNG。

```sh
node scripts/prepare-assets.mjs --capture local/capture.json --inventory local/inventory.json --bundle local/bundle.json --screenshots local/screenshots.json --out local/run-1
```

该命令生成 `acquisition-plan.json`、`asset-mappings.json`、`ocr-images.json`。只有原图已确认或裁剪完成的映射会进入 OCR 清单。出现 `rejections` 时补读对应位置，不能宣称题目已读全。

## 截图及 frame 坐标

在提取后对需要的 frame 获取截图并保留描述；例：

```json
{
  "screenshots": [{
    "path": "/absolute/local/screen.png",
    "sha256": "64-character-actual-file-sha256",
    "capturedAt": "actual-ISO-timestamp",
    "frame": "top",
    "coordinateSpace": "frame-document",
    "cssBounds": {"x": 0, "y": 0, "width": 1280, "height": 4000},
    "pixelSize": {"width": 1280, "height": 4000}
  }]
}
```

值必须来自同次截图和 `captured.frames`/实际页面。viewport 截图的 CSS 原点使用对应 frame 的滚动位置；整页截图原点通常为文档0,0。不要盲用 devicePixelRatio，因为工具可能输出 CSS 像素图。缺失 frame、图片未加载、截图过旧、旋转/倾斜变换、覆盖不完整或有多个候选时会明确拒绝。CSS 伪元素、shadow DOM、自定义数学布局需要手动视觉补读。

Windows 本地裁剪：

```powershell
& .\skill\scripts\crop-assets.ps1 -PlanPath .\local\run-1\asset-mappings.json -OutputDirectory .\local\crops-1
```

裁剪输出回到 Node 验证及生成最终 OCR 清单：

```sh
node scripts/prepare-assets.mjs --capture local/capture.json --mappings local/crops-1/asset-mappings.json --out local/run-2
```

缓存以实际图像字节和语言/引擎/预处理配置为键；脱敏 URL、题号或 CSS 路径不能证明内容一致。多题共享资产保留 `questionKeys` 及 `references`，在结果关联时使用资产 ID，不能按文本或数组序号硬接。

## 本地 OCR

Windows PowerShell 5.1：

```powershell
powershell.exe -NoProfile -File .\skill\scripts\ocr-images.ps1 -ManifestPath .\local\run-2\ocr-images.json -CacheDirectory .\local\ocr-cache -ImageTimeoutMs 30000 -BatchTimeoutMs 120000 -OutputPath .\local\ocr-result-1.json
```

输出文件必须是新的。执行策略禁止 `.ps1` 时，确认本地 helper 内容后可运行同一代码的脚本块，无需更改执行策略：

```powershell
powershell.exe -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('C:\path\skill\scripts\ocr-images.ps1'))) -ManifestPath 'C:\path\local\ocr-images.json' -CacheDirectory 'C:\path\local\ocr-cache' -OutputPath 'C:\path\local\ocr-result-1.json'"
```

不存在所需语言/WinRT 时给出明确状态，回到视觉补读；不安装语言包或下载模型。计时区分初始化、读取、解码、识别、缓存和整批；超时及部分失败保留其题目归属。结果中的非空文字和缓存命中都不代表已验证正确。

识别后通过捕获文件与图片内容哈希关联到原题，多题共享资产会展开引用；失败、空白、超时仍保留为未解决，不覆盖原始公式：

```sh
node scripts/associate-ocr.mjs local/capture.json local/run-2/ocr-images.json local/ocr-result-1.json local/readings-1.json
```

图形关系由视觉核验。公式后端可另测 [PaddleOCR 公式识别](https://www.paddleocr.ai/main/en/version3.x/module_usage/formula_recognition.html)；当前包不自带其权重或运行时。[Windows OCR API](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine) 提供普通文字识别。
