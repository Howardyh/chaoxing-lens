# 考试界面快速读取

本流程针对已观察到的学习通考试模板：答题页有题量、倒计时、答题卡和“整卷预览”；预览页有连续的 `sigleQuestionDiv_…` 题目。用户仅要答案时默认只读。作业页仍按作业流程识别，批改页仅作复习或测试输入。

## 少做浏览器往返

复用当前会话已验证的 Edge/tab 绑定；换卷后先读新页面状态，不复用旧题号、答案、DOM索引或身份。绑定失效时重新列出当前页面，不能用历史 tab ID 猜测。不要把一次任务内的每次读取都变成重新发现、重新绑定和完整 snapshot。

在当前 UI 确认“整卷预览”后正常打开；将点击及后续提取放在同一 `cua_repl` 调用。不得猜预览接口、修改 URL 参数或触发提交。在工具已提供并读过文档时，直接使用受支持的 `playwright.evaluate` 和 `screenshot`。

一次工具调用内运行：

```js
var fs = await import('node:fs/promises');
var source = await fs.readFile('/absolute/skill/scripts/extract-questions.js', 'utf8');
var fast = await import('/absolute/skill/scripts/exam-capture.mjs');
nodeRepl.write(await fast.captureExamFast(tab, {
  extractorSource: source,
  outputDirectory: '/absolute/local/NEW-exam-run',
  // 仅当本次答题页已经明确显示总题数时，传 observedExpectedCount。
}));
```

`observedExpectedCount` 必须来自本次可见题量，不能填历史卷的题数。提取器也会读取可见“题量: N”、章节标题“共N题”和 `118' 52''` 格式倒计时；未知总数继续保持未知。模板标记 `exam-answering/exam-preview` 只是路由信号，全卷覆盖仍须题量和题号共同验证。

## 截图批量补读

过去两次实际任务中，浏览器调用需几十秒；23张原图 bundle 耗时约65秒，122张约90秒。这些是特定会话观测，不是固定延迟。此模板默认先将缺图合并为有界截图，避免启动几十张原图下载；全部源码可读时不截图。需要放大某图或截图失败时再取该图原图。

`captureExamFast` 仅调用当前 tab 的只读 evaluate 和截图，不导航、不获取任意 URL、不读脚本状态、不填写。截图前后比较正文、公式来源、选项和坐标；变化后全部截图标记不可用，先重新读取。截图仅在资产完全覆盖、frame一致、长宽比例符合时可进入裁剪；图片未加载、错误frame或单图超预算都保留明确回退项。子frame不可套用顶层坐标。

输出：`capture.json`、`screenshots.json`、`band-N.png/jpg`。当前 Edge 实测返回 JPEG；它先标记 `needsNormalization`，不能直接当作可裁剪 PNG。先运行本地转换，核验原始哈希、真实尺寸和 CSS 长宽比例；失效截图不能重新启用：

```powershell
& .\scripts\normalize-screenshots.ps1 -ManifestPath .\local\NEW-exam-run\screenshots.json -OutputDirectory .\local\NEW-normalized
```

再用便携脚本在本地裁剪、去重和排版：

```sh
node scripts/prepare-assets.mjs --capture local/NEW-exam-run/capture.json --screenshots local/NEW-normalized/screenshots.json --out local/NEW-plan
```

随后执行 `crop-assets.ps1`，再将裁剪 mappings 交给 `prepare-assets.mjs`，最后运行 `prepare-images.ps1`。具体参数见 [浏览器与本地处理](browser-workflow.md)。新拼图默认3列，小公式并排，长公式跨整行；`-Columns 1` 可恢复逐行预览。OCR 始终使用独立完整图，不能识别拼图后猜关联。

若截图不受支持或只剩少量难辨认公式，正常使用已观测 `pageAssets` inventory/bundle，只获取 `fallbackAssetIds` 对应的观测 ID。失败一次就换补读方式，不循环重试。页面发生变化时不能用旧 fallback ID 继续原图获取，须重新提取。

读取/补图在一条调用内批量进行；资料完整的题可先推理。检查否定条件、奇点阶数、留数系数、积分方向/边界及当前选项字母后，再统一按 `题号 | 答案 | 简短对照` 输出。不靠减少核验或把不确定项标成已完成来提速。

记录工具墙钟、DOM、截图/下载、本地处理及推理耗时；本地毫秒级 benchmark 不代表浏览器端到端速度。未完成实际对比前不承诺固定倍数或“秒出全卷”。
