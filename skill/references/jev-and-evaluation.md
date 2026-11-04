# Jev 局部读题辅助与盲测

默认由 Codex 直接读源码/看图并推理。只有局部歧义值得额外调用时才启用 Jev。服务未接通不会阻塞解题。

## 接口与数据

`jev-assist.mjs` 使用官方 REST `POST https://api.typesafe.ai/v1/systemone`，以 `TYPESAFE_API_KEY` 环境变量鉴权。模型默认 `jev-latest`，图像模型是否支持必须由实际服务确认。无需把密钥写入仓库或对话。当前连接器是否可用取决于会话；不能将已有其他 Jev 接入视为此 REST 适配器已通过实测。

支持的原子检查：

- `readability`：单幅局部裁剪是否完整可读。
- `transcription`：2–8 个明确的逐字转写候选；伴随可读性与“至少一个候选完全匹配”的 Noul。即使 Choice 高置信，存在性为否仍不能采用候选。
- `polarity`：题干是否明确要求不正确/不符合项，使用 Noul。
- `type`：明确题型的 Choice 和“原文明确指定格式”的 Noul；不能凭题意猜格式。

同一局部状态可批量检查；不同题目的图像不要混在一次请求里。Jev 不计算、不求学科答案，也不自动设置任何 `verified/ready`。缺少数据/权限/密钥、超时、429、响应结构异常或低置信均回到 Codex 阅读。默认超时5秒、最多一次请求、不自动重试，阈值0.9只是可调整的读题门槛，尚未在真实题库校准。

输入示例（保存在 `local/`）：

```json
{
  "text": "下列哪个不符合条件？",
  "checks": ["polarity"],
  "model": "jev-latest",
  "timeoutMs": 5000,
  "threshold": 0.9
}
```

视觉检查加上相对 `imagePath`、`imageFormat: "png"` 和 `candidates`。只传题目局部截图和必要短文本，不传整卷页面、姓名、学号、Cookie、登录地址。适配器会删除常见 URL、邮箱和显式身份字段，但它不是完整隐私检测器，发送前仍核对实际最小化状态。

```sh
node scripts/check-jev.mjs local/check.json local/jev-preview.json
# 明确当次发送的数据、请求上限与费用预算并获得授权后：
node scripts/check-jev.mjs local/check.json local/jev-result.json --send
```

预览文件包含本地图像 Base64，仅保存在本地。`--send` 才访问服务。执行真实 API 实验须已有用户许可和费用预算；没有时完成离线接口和回退验证，报告尚未实测，不能擅自付费试跑。常规已授权工作流中的已有预算可继续使用，不重复问许可。

结果记录请求哈希、payload版本、模型、时延、输入/输出 tokens 及可用的费用估计；不记录密钥和供应商错误正文。没有价格配置时费用为 `null`，不能将 token 用量当实际账单。

官方文档（接口实现核对日期：2026-11-04）：[System One](https://docs.typesafe.ai/api/system-one)、[Choice](https://docs.typesafe.ai/primitives/choice)、[Noul](https://docs.typesafe.ai/primitives/noul)。

## 三组公平评估

先用完全隔离参考答案的解题包完成作答，再运行评价器。真实题目及参考答案保留本地，公开测试只用合成题。批改页用于建立参考和回归输入，不作为实际作答入口；已看过批改内容的回放不能报告为盲测。

参考集：

```json
{"schema":"chaoxing-evaluation-set/v1","cases":[{"id":"set-1","expected":[{"questionKey":"q1","value":"B"},{"questionKey":"q2","value":["A","C"],"unordered":true}]}]}
```

记录数组：每条包含 `caseId`、`trial`、`mode`（`baseline` / `improved` / `improved+jev`）、`answers`（`questionKey/status/value`）和真实测量的 `timings`。阶段字段为 `extractionMs/toolWaitMs/imageMs/reasoningMs/outputMs/totalMs`；总耗时是实际端到端墙钟时间，不能把并行阶段简单相加。

```sh
node scripts/evaluate-runs.mjs local/reference.json local/runs.json local/report.json
```

报告同时给出已答准确率、覆盖率、总题正确率、缺失运行及各阶段样本数/P50/P95。未测时延为 `null`；未运行的模式覆盖为0。自由文本或等价数学形式需先由独立评估者统一标准答案，脚本只按预先定义的字符串/数组规则比对。禁止以减少回答数量换取表面准确率，禁止从体积下降推算端到端提速。
