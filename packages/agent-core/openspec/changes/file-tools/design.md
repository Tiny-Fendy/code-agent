# 文件操作工具集 - 设计方案 (design.md)

## 1. 架构定位

文件工具直接实现在 **agent-core** 包内，在 `Agent` 构造函数中自动注册。

**设计决策**：
- 所有运行环境（Electron / CLI）都有 Node.js，工具可以安全依赖 Node API
- 工具是 Agent 的核心能力，不是可选插件，因此直接内置
- 上层（electron-main / 未来 CLI）只需 `new Agent(config, projectPath)`，零配置

```
packages/agent-core/src/
├── agent/
│   └── Agent.ts              # 构造函数内注册所有内置工具
├── tools/
│   ├── base.ts               # Tool 接口 + BaseTool 基类
│   ├── ToolManager.ts        # 工具调度
│   └── file/                 # 文件工具集
│       ├── PathGuard.ts      # 路径安全校验
│       ├── FsService.ts      # 文件系统服务（Node fs + ripgrep）
│       ├── gitignore.ts      # .gitignore 过滤
│       ├── ListDirTool.ts
│       ├── ReadFileTool.ts
│       ├── SearchByRegexTool.ts
│       ├── WriteFileTool.ts
│       ├── EditFileTool.ts
│       └── index.ts          # 统一导出
├── llm/
└── context/
```

---

## 2. 核心模块设计

### 2.1 PathGuard - 路径安全守卫

**职责**：统一的路径安全校验，所有文件操作必须经过它。

**核心方法**：
```typescript
class PathGuard {
  constructor(projectRoot: string)

  /**
   * 解析并校验路径
   * - 解析为绝对路径
   * - 解析符号链接（如路径存在）
   * - 校验是否在 projectRoot 范围内
   * - 返回安全的绝对路径，校验失败抛出错误
   */
  resolveAndValidate(relativePath: string): string
}
```

**安全策略**：
1. `path.resolve(projectRoot, relativePath)` 得到绝对路径
2. 如路径存在，用 `fs.realpath` 解析符号链接
3. 检查解析后路径是否以 `projectRoot` 开头
4. 禁止直接访问 `.git` 目录

### 2.2 FsService - 文件系统服务

**职责**：封装 Node.js fs API + ripgrep，提供统一的异步文件操作接口。

**核心方法**：
```typescript
class FsService {
  listDir(dirPath: string, maxDepth: number): Promise<DirEntry[]>
  readFile(filePath: string, offset?: number, limit?: number): Promise<string>
  writeFile(filePath: string, content: string): Promise<void>
  searchByRegex(searchPath: string, pattern: RegExp, maxResults: number): Promise<SearchResult[]>
  fileExists(filePath: string): Promise<boolean>
  isDirectory(path: string): Promise<boolean>
  getFileSize(filePath: string): Promise<number>
}
```

**搜索实现（ripgrep）**：
- 使用 `child_process.execFile` 调用 `rg` 二进制
- `--json` 参数获取结构化输出
- ripgrep 默认遵守 `.gitignore`

### 2.3 GitIgnore 过滤

使用 `ignore` npm 包解析 `.gitignore`：

```typescript
class GitIgnoreFilter {
  constructor(projectRoot: string)
  isIgnored(relativePath: string): boolean
}
```

**使用场景**：
- `list_dir`：过滤被 ignore 的文件/目录
- `FsService.listDir` 内部调用

---

## 3. 工具实现

每个工具继承 `BaseTool`，通过 PathGuard + FsService 完成操作。

### 3.1 ListDirTool
- 参数：`dir_path`（可选）、`max_depth`（默认 1，上限 5）
- 流程：PathGuard 校验 → FsService.listDir → GitIgnore 过滤 → 树形文本输出

### 3.2 ReadFileTool
- 参数：`file_path`、`offset`（行号，从 1 开始）、`limit`（行数）
- 流程：PathGuard 校验 → 大小检查 → FsService.readFile → 加行号
- 大文件（>100KB）强制分段读取

### 3.3 SearchByRegexTool
- 参数：`pattern`、`search_path`（可选）、`max_results`（默认 50）
- 流程：编译正则 → PathGuard 校验 → FsService.searchByRegex（ripgrep）→ 格式化输出

### 3.4 WriteFileTool
- 参数：`file_path`、`content`
- `requiresConfirmation = true`
- 流程：PathGuard 校验 → FsService.writeFile（自动建父目录）

### 3.5 EditFileTool
- 参数：`file_path`、`old_string`、`new_string`、`replace_all`（默认 false）
- `requiresConfirmation = true`
- 流程：PathGuard 校验 → 读文件 → 匹配检查 → 替换 → 写回

---

## 4. 工具注册

在 `Agent` 构造函数中注册：

```typescript
constructor(config: AgentConfig, projectPath: string) {
  this.toolManager = new ToolManager();
  this.toolManager.registerAll([
    new ListDirTool(projectPath),
    new ReadFileTool(projectPath),
    new SearchByRegexTool(projectPath),
    new WriteFileTool(projectPath),
    new EditFileTool(projectPath),
  ]);
}
```

---

## 5. 配置常量

```typescript
export const FILE_CONFIG = {
  MAX_FILE_SIZE_READ: 100 * 1024,   // 单次读取最大 100KB
  MAX_SEARCH_RESULTS: 50,             // 搜索最多返回 50 条
  MAX_LIST_DEPTH: 5,                  // 列目录最大深度
  DEFAULT_LIST_DEPTH: 1,              // 默认列目录深度
};
```
