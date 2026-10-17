# Chaoxing Lens · 超星题镜

读取已打开的学习通 / 超星题目，优先使用正文与公式源码，再按位置获取原图或裁剪补读。项目提供只读提取器、本地图片处理、Windows OCR 缓存，以及可安装的 Codex skill。

[English](README.en.md)

## 能力

- **源码优先**：HTML 上下标、MathML、TeX annotation、KaTeX/MathJax 去重；描述标签与可靠公式来源分开。
- **紧凑数据**：v3 的图片和共享材料各存一份，题目通过 ID 引用，保留选项、控件及已有状态。
- **原图优先**：只匹配浏览器 `pageAssets` 已观测的图片；歧义匹配明确拒绝，不猜接口或资源 URL。
- **可追溯裁剪**：实际截图比例、frame 文档坐标、向外取整、边缘留白、截图哈希及多题关联。
- **本地 OCR 缓存**：图像内容与语言/配置共同生成缓存键，批量复用 engine，整图/整批时限和阶段计时。
- **方便填写**：按原题号给出答案和选项原文，判断题显示实际文字；多空逐空、简答独立复制。未核验题保留位置并标记待确认。
- **减少传输**：解题包保留完整题干、选项、公式、材料和核验项，省略操作坐标及定位器；答案绑定 capture，防止题目变化后套用旧结果。
- **可重建**：维护源码、固定依赖、合成测试、构建产物和 CI，不依赖历史备份目录。

它不会自动访问未打开的课程、调用后台题库、读取 Cookie/隐藏答案或自行提交。解答及 UI 操作由当前会话中的 Codex 按用户指令完成。图片、公式和 OCR 输出仍需核验。

## 开始使用

需要 Node.js 24+；仅 Windows OCR / 裁剪 helper 需要 Windows PowerShell 5.1。浏览器交互使用当前 Codex 会话支持的工具。

```sh
git clone https://github.com/Howardyh/chaoxing-lens.git
cd chaoxing-lens
npm ci --ignore-scripts
npm run check
npm run install:skill
```

安装位置默认是 `$CODEX_HOME/skills/chaoxing-study`，未设置时为用户目录下 `.codex/skills/chaoxing-study`。安装前备份旧目录，写入后逐文件校验；备份保存在本地 `local/backups/`。也可以指定目标：`node scripts/install-skill.mjs /absolute/skills/chaoxing-study`。

调用示例：

> 使用 $chaoxing-study 读取当前学习通题目，按题号给出答案和必要解释，先不要填写。

纯浏览器使用时，也可在已登录题目页的开发者工具 Console 执行 `skill/scripts/extract-questions.js`；返回 JSON 对象，不执行网页写入。

## 数据与处理流程

```text
当前题目 DOM → v3 题目 / 资产 / 共享材料 / 补读队列
                         ↓
           已观测原图 → 内容哈希校验
              缺失时 → frame 局部截图 → 定位裁剪
                         ↓
            本地 OCR 缓存 → 带出处的未核验文本
                         ↓
               Codex 看图核验与统一推理
```

默认表达式使用紧凑模式；诊断表达式额外返回 `fullText`。每次提取保留 `metrics` 和 frame 几何信息。具体 API、命令和裁剪描述见 [浏览器与本地流程](skill/references/browser-workflow.md)。

普通对话直接返回答案；长卷或需要导出时使用 [解题与填写清单流程](skill/references/answer-workflow.md)：

```sh
node scripts/prepare-answers.mjs local/capture.json local/answer-run-1
# 依据 solve-packet.json 解答并核验，填写同目录的 answers.json
node scripts/format-answers.mjs local/capture.json local/answer-run-1/answers.json local/answer-sheet-1.md
```

典型显示（合成示例）：

| 题号 | 填写内容 | 对照 / 说明 |
| --- | --- | --- |
| 1 | B | B. 2 |
| 2 | A、C | A. 红；C. 蓝 |
| 3 | 错误 | 错误 |
| 4 | 见下方可复制内容 | 第1空、第2空分别提供 |
| 5 | 待确认 | 图中的负号尚未看清 |

默认统一给出完整清单，说明后置。仅对缺失资产补读，图像可直接看清时无需再跑 OCR；保留原来的推理和核验要求。格式化器检查映射与答案结构，不证明学科答案正确，也不把待确认草稿列为可填写结果。

`local/` 用于题目 JSON、原图、截图、OCR 结果和缓存，已被 Git 忽略。公开仓库只包含代码、文档和合成题目，不包含任何真实课程或账户数据。

## 验证及限制

```sh
npm test
npm run bench
```

Node 测试覆盖题型、公式来源、隐藏内容、共享材料、稳定身份、原图歧义、DPR/滚动坐标、缓存失效及多题关联。jsdom 测试使用合成几何，不证明真实截图布局；真实浏览器 smoke test 与 Windows OCR 另行验证。`bench` 输出本地合成 DOM 的耗时及体积，不代表浏览器端到端速度。

源码不完整、跨域 frame、CSS 伪元素、shadow DOM、特殊公式模板仍需补读。原图入口当前接收 PNG，其他格式回退截图 PNG。通用 Windows OCR 无数学专用准确率保证；本项目没有自带 PaddleOCR/pix2tex 权重，也没有云端识别接口。
