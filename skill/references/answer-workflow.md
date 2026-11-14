# 解题包与填写清单

默认直接在对话中按原题号返回答案；长卷、导出或需要确定性检查时才使用以下本地工具。脚本不求解、不访问网页、不填写、不提交。

## 准备一次，按同一份题目解答

```sh
node scripts/prepare-answers.mjs local/capture.json local/answer-run-1
```

在 skill 目录运行时命令相同。输出目录必须不存在；生成 `solve-packet.json`、v2 `answers.json` 模板和独立的 `evaluation-reference.json`。解题包保留正文、有序选项、公式、输入空位、材料、警告和补读关联。省略操作元数据，隔离 `visibleReview`、已选项及 `currentText`；参考文件只在解答完成后评估使用。原 capture 留供图片获取和 UI 匹配。

已补读时可提供第三个参数：`node scripts/prepare-answers.mjs local/capture.json local/run-2 local/verified-readings.json`。该文件由 OCR 关联结果人工核验后生成，包含 `readings` 和 `assetContent`；资产 ID、内容 SHA256 和消费者均须匹配。`verified` 不能仅因 OCR 非空或 Jev 置信高而设为真。题目 `reuse` 信息只建议精确重复题的推理复用；选项换序须调用 `remapChoiceAnswer` 并重新核验映射。

图片仍按原资产 ID 补读；`reviewAssetIds` 列出本题及共享材料需要确认的资产。相同资产只处理一次，核验结果适用于同次 capture 的所有使用者。先读完整材料；如工具支持后台处理，等待图片期间可先思考其他资料完整的题。截图与 OCR 是按缺失内容选择的读题方式，清晰图片可直接视觉阅读，源码可读公式可直接使用。

填好模板中对应 `questionKey` 的条目；保留 `captureId` 和 `captureHash`。例如合成记录：

```json
{
  "questionKey": "top::question-example",
  "status": "ready",
  "choices": ["A", "C"],
  "reviewedAssetIds": [],
  "reviewedWarnings": [],
  "checks": {
    "reading": {"status": "passed", "evidence": "已对照题干否定条件和全部选项"},
    "solving": {"status": "passed", "evidence": "此处记录本题实际推理依据"},
    "numeric": {"status": "not-applicable", "evidence": "本题不涉及数值计算"},
    "mapping": {"status": "passed", "evidence": "所选内容已对应当前页面 A、C"}
  },
  "note": ""
}
```

- 单选 / 多选 / 判断：`choices` 使用解题包中准确的 `options[].label`；页面没有字母标记时使用完整的 `options[].text`（例如“错误”），多个选项的标记或原文不唯一时必须回看原题。判断题由格式化器输出所选项的实际文字；禁止假设 A=正确。
- 已得到选项内容时，可提供 `choiceTexts` 字符串数组。按当前选项原文匹配，忽略空白和 Unicode 组合形式差异，保留符号、标点、数值与单位。判断题允许明确的同义词（如 `true` 和 `正确`）。若同时给出 `choices`，两者必须一致；重复、不完整、冲突或仍有未转写选项图片时显示待确认。
- 填空：`blanks` 为按页面空位顺序的字符串数组，空数须与可见输入区域一致；一个空内的多个答案保留在同一个字符串内。
- 简答 / 计算：`text` 保存可直接填写的完整答案，题目要求过程时包含过程。
- 尚未核验：保留 `status: "review"`，`note` 写具体原因；可以保留草稿，但格式化器只展示“待确认”，不把猜测当成答案。
- 已完成推理和核验：设 `status: "ready"`。读题、解题、数值和映射四项 `checks` 都须分别给出实际依据，数值不适用时才用 `not-applicable`。`reviewedAssetIds` 仅写确实查看并确认的资产；其他读取警告须核查后逐项记入 `reviewedWarnings`。图片未加载或题目缺失时先补读，不用字段替代读题。

模板没有自动答案、可信概率或默认核验。数学公式、否定条件和约定不清时回到原题；仅在影响选项结论时附必要说明。

## 导出

```sh
node scripts/format-answers.mjs local/capture.json local/answer-run-1/answers.json local/answer-sheet-1.md
```

输出文件必须不存在。题目按 capture 顺序显示；空题号或重复题号带页面序号和题干，未提供的题目显示待确认，重复 / 未知题目键及不匹配的 capture 会报错。无效选项、漏空、未核验图片不会进入可填写答案。共享材料的待核验项也要覆盖。非空 OCR 文本、缓存命中、格式校验成功均不等于学科答案正确。

填写清单默认使用方案3：`题号 | 答案 | 简短对照`，对照不重复字母。图片选项须在顶层 `readings` 提供对应 `assetId`、`verified: true` 和转写 `text`，否则待确认。可靠公式源码优先于识别文本；不输出内部图片占位符。可选 `comparison` 提供人工核验后的简短对照；缺省时取完整选项，超过120字符省略尾部，完整内容保存在行数据中。填空及简答保留独立复制块；必要说明在后。页面警告保留；不能把单页结果称为全卷完成。`pending` 仅指已读但未确认的题，`unread` 单独报告未读题量，总数未知时为 `null`。

答案绑定同次 capture；题目、选项或 capture 变化后重新解答/核对，格式化器拒绝直接复用旧答案。实际填写前另核对当前 UI，哈希不证明页面从未改变。

## 测量提速

`npm run bench` 对比同一批合成题的原 capture 和解题包字节数，并报告处理耗时。测试保证题干、选项、公式来源、共享材料等关键内容逐项一致。字节不是模型 token，合成 Node 耗时不是浏览器、OCR 或模型的端到端耗时；不据此承诺固定倍数或正确率提升。
