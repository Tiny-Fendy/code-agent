# 客户端解耦与模块重组 - 验收清单 (check.md)

## 1. 端无关性

- [ ] `src/` 全目录 grep 无 `document` / `window` / `navigator` / `globalThis` 残留
- [ ] 仅使用 WHATWG 标准 API（fetch / URL / TextDecoder / AbortController 等，Node 18+ 原生具备）

## 2. 删除项无残留

- [ ] 无 `reconnectOnVisible` / `visibilitychange` / `waitForVisible` / `hiddenController`
- [ ] 无 `lastEventId` / `Last-Event-ID`
- [ ] `SSEReconnectingInfo` 无 `reason` 字段
- [ ] `index.ts` 导出面 = `SSEClient` + `SSEClientError` + `SSEClientErrorType` + types 类型，无 `createSSEParser` / `SSEParser`

## 3. 模块结构

- [ ] `client.ts` 不再存在 runStream；SSEClient 仅含状态机、事件分发、重连循环编排
- [ ] `connection.ts` ConnectionAttempt 承载单次尝试完整生命周期，结局归类无 hidden 分支
- [ ] `ConnectionAttempt.run()` 仅做编排（信号合并 + 超时 + 分段调用 + try/catch/finally），请求/校验/读取/归类分别落在 `fetchResponse` / `assertResponseUsable` / `readStream` / `handleError` 私有方法，单函数不超过 100 行
- [ ] `request.ts` prepareRequest 为纯函数（无副作用、不依赖实例状态）
- [ ] parser / timeout / reconnect 均为类形态；依赖方向单向（编排层 → 尝试层 → 基础件），无反向 import
- [ ] [DONE] 哨兵与严格 JSON 解析在 ConnectionAttempt 读取循环内，未进入 SSEParser

## 4. 行为保持（必须有测试锁定）

- [ ] 状态机：start() 一次性重复调用抛错；abort() 在 idle / closed 态 no-op
- [ ] 终局互斥且只发一次：done / error 不同时出现
- [ ] abort（含重试等待期间）→ done { reason: 'aborted' }，eventCount 正确
- [ ] [DONE] 哨兵：不透传、不解析、不计入 eventCount，主动关流
- [ ] data 严格 JSON 解析：失败即 parse 错误终结，retryable=true 但不自动重试
- [ ] 重试边界：fetch 拒绝 / connect 超时 / 429 / 5xx / 无 body 且首字节前 → 自动重试；流中途失败 → 终结
- [ ] 重试延迟：Retry-After（retry-after-ms 优先）→ 指数退避+jitter，封顶 maxDelay
- [ ] HTTP 非 2xx 错误带 status；onOpen 抛错归 http 且 retryable=false；total 超时不被重试绕过
- [ ] 三层超时默认值 connect 10s / read 30s / total 0

## 5. 工程验证

- [ ] `pnpm vitest run` 全量通过（无假通过：行为类断言针对语义而非实现细节）
- [ ] `tsc --noEmit` 通过
- [ ] agent-core 构建与测试通过（消费方零改动，验证删除的导出无人使用）

## 6. 文档

- [ ] `openspec/systems/fetch-sse-client.md` 同步（模块结构、配置表、变更记录）
- [ ] README 同步（删可见性章节与 parser 导出行，配置示例更新）
