# 文件操作工具集 - 任务拆解 (tasks.md)

## 开发顺序说明

按照"从底层到上层、从简单到复杂"的顺序开发：

1. **基础设施层**：PathGuard + FsService + GitIgnoreFilter
2. **只读工具**：list_dir → read_file → search_by_regex
3. **写入工具**：write_file → edit_file（最复杂，最后做）
4. **集成**：Agent 构造函数内注册所有工具

---

## Task 1: 基础设施 - PathGuard 路径安全守卫

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [ ] 创建 `src/tools/file/PathGuard.ts`
- [ ] 实现 `resolveAndValidate` 方法
- [ ] 路径穿越检测（`../` 检测）
- [ ] 符号链接解析后校验
- [ ] `.git` 目录禁止访问
- [ ] 单元测试（各种路径穿越场景）

**验收标准**：
- 正常路径能正确解析
- `../` 路径穿越被拦截
- 符号链接指向项目外被拦截
- `.git` 目录被拦截

---

## Task 2: 基础设施 - FsService 文件系统服务

**优先级**：P0
**预估工作量**：中

**任务内容**：
- [ ] 创建 `src/tools/file/FsService.ts`
- [ ] 实现 `listDir`（递归 + 深度控制）
- [ ] 实现 `readFile`（支持 offset/limit 分段）
- [ ] 实现 `writeFile`（自动创建父目录）
- [ ] 实现 `searchByRegex`（基于 ripgrep）
- [ ] 实现辅助方法：`fileExists` / `isDirectory` / `getFileSize`
- [ ] 定义文件大小上限常量等配置

**验收标准**：
- 所有方法接收绝对路径，正确执行
- listDir 递归深度控制正确
- readFile 的 offset/limit 计算正确（行号从 1 开始）
- writeFile 自动创建不存在的父目录
- searchByRegex 基于 ripgrep，正确返回匹配结果，遵守 max_results

---

## Task 3: 基础设施 - GitIgnore 过滤

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [ ] 安装 `ignore` 依赖包
- [ ] 创建 `src/tools/file/gitignore.ts`
- [ ] 读取项目根目录的 `.gitignore`
- [ ] 提供 `isIgnored(relativePath)` 方法
- [ ] 如果没有 `.gitignore` 文件，不做过滤

**验收标准**：
- .gitignore 中的文件/目录被正确过滤
- 没有 .gitignore 时正常工作
- 嵌套目录的 ignore 规则正确（`node_modules` 下所有文件都被忽略）

---

## Task 4: 工具 - list_dir

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [ ] 创建 `src/tools/file/ListDirTool.ts`
- [ ] 继承 BaseTool，定义 name/description/parameters
- [ ] 实现 `execute` 方法：
  - 校验参数
  - PathGuard 校验路径
  - 调用 FsService.listDir
  - GitIgnoreFilter 过滤结果
  - 格式化为树形文本输出
- [ ] `requiresConfirmation = false`

**验收标准**：
- 正确列出目录结构
- 遵守 .gitignore
- 深度参数生效
- 路径穿越被拦截

---

## Task 5: 工具 - read_file

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [ ] 创建 `src/tools/file/ReadFileTool.ts`
- [ ] 继承 BaseTool，定义 name/description/parameters
- [ ] 实现 `execute` 方法：
  - 校验参数
  - PathGuard 校验路径
  - 检查文件大小（超限则提示分段读取）
  - 调用 FsService.readFile
  - 给内容加行号
- [ ] `requiresConfirmation = false`

**验收标准**：
- 正确读取文件内容并带行号
- offset/limit 分段读取正确
- 大文件超限返回明确提示
- 二进制文件返回错误提示
- 路径穿越被拦截

---

## Task 6: 工具 - search_by_regex

**优先级**：P0
**预估工作量**：中

**任务内容**：
- [ ] 创建 `src/tools/file/SearchByRegexTool.ts`
- [ ] 继承 BaseTool，定义 name/description/parameters
- [ ] 实现 `execute` 方法：
  - 校验参数，编译正则
  - PathGuard 校验搜索路径
  - 调用 FsService.searchByRegex（ripgrep）
  - 格式化输出结果（文件 + 行号 + 内容）
  - 超过 max_results 时提示截断
- [ ] `requiresConfirmation = false`

**验收标准**：
- 正则搜索返回正确结果
- 遵守 .gitignore
- max_results 截断生效
- 错误的正则表达式返回明确错误
- 路径穿越被拦截

---

## Task 7: 工具 - write_file

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [ ] 创建 `src/tools/file/WriteFileTool.ts`
- [ ] 继承 BaseTool，定义 name/description/parameters
- [ ] 实现 `execute` 方法：
  - 校验参数
  - PathGuard 校验路径
  - 调用 FsService.writeFile
- [ ] `requiresConfirmation = true`（写操作需要确认）

**验收标准**：
- 成功创建新文件
- 成功覆盖已有文件
- 自动创建不存在的父目录
- 路径穿越被拦截
- requiresConfirmation 为 true

---

## Task 8: 工具 - edit_file

**优先级**：P1
**预估工作量**：中

**任务内容**：
- [ ] 创建 `src/tools/file/EditFileTool.ts`
- [ ] 继承 BaseTool，定义 name/description/parameters
- [ ] 实现 `execute` 方法：
  - 校验参数
  - PathGuard 校验路径
  - 读取文件内容
  - 检查 old_string 匹配情况
    - 0 处匹配 → 报错
    - 1 处匹配 → 替换
    - 多处匹配且 replace_all=false → 报错
    - 多处匹配且 replace_all=true → 全部替换
  - 写回文件
- [ ] `requiresConfirmation = true`（编辑操作需要确认）

**验收标准**：
- 单匹配替换正确
- 多匹配 + replace_all 替换正确
- 多处匹配且未设 replace_all 时报错
- 未找到匹配时报错
- 路径穿越被拦截
- requiresConfirmation 为 true

---

## Task 9: 工具注册与集成

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [ ] 创建 `src/tools/file/index.ts` 统一导出文件工具
- [ ] 在 `Agent` 构造函数中注册所有文件工具到 ToolManager
- [ ] 确认 Agent 能正确调用文件工具

**验收标准**：
- Agent 启动后能看到所有文件工具
- Agent 对话中能触发工具调用
- 工具执行结果能正确回灌给 Agent

---

## 依赖关系图

```
Task 1 (PathGuard) ──┐
Task 2 (FsService) ───┼──→ Task 4 (list_dir) ──┐
Task 3 (GitIgnore) ───┘    Task 5 (read_file) ──┼──→ Task 9 (注册集成)
                            Task 6 (search) ─────┤
                            Task 7 (write) ──────┤
                            Task 8 (edit) ───────┘
```

- Tasks 1/2/3 可以并行（都是基础设施）
- Tasks 4/5/6/7 可以并行（依赖 1+2+3）
- Task 8 可以和其他工具并行（依赖 1+2）
- Task 9 最后做
