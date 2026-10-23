/**
 * 文件领域逻辑（纯函数，可独立单测）
 *
 * - FileNode → antd Tree 数据转换
 * - 路径展示名 / 语言推断 / 代码围栏构造
 *
 * 放在领域层的原因：这些是「文件如何呈现」的稳定规则，
 * 组件只消费结果，不重复实现路径与语言判断。
 */

import type { FileNode } from '@code-agent/contracts';

/** antd Tree 使用的节点结构（key 即绝对路径，选中时可直接回传 readFile） */
export interface TreeDataNode {
  key: string;
  title: string;
  isLeaf: boolean;
  children?: TreeDataNode[];
}

/** FileNode[] → antd Tree 数据；目录递归转换，文件标记为叶子 */
export function toTreeData(nodes: FileNode[]): TreeDataNode[] {
  return nodes.map((node) => ({
    key: node.path,
    title: node.name,
    isLeaf: node.type === 'file',
    children: node.children?.length ? toTreeData(node.children) : undefined,
  }));
}

/** 取路径最后一段（同时兼容 POSIX 与 Windows 分隔符） */
export function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

// 扩展名 → highlight.js 语言名。
// 只映射确定且常用的类型；未命中返回 undefined，预览时按纯文本展示。
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  vue: 'xml',
};

/** 由文件路径推断高亮语言；未知返回 undefined */
export function fileLanguage(filePath: string): string | undefined {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined; // 无扩展名或隐藏文件（.gitignore）
  return LANGUAGE_BY_EXT[name.slice(dot + 1).toLowerCase()];
}

/**
 * 把原始代码包成 Markdown 代码围栏，交给统一的 Markdown 渲染器做高亮。
 *
 * 围栏长度取「内容中最长连续反引号 + 1」，且至少 3 个：
 * 否则文件内容自带 ``` 时会提前闭合围栏，导致预览错乱。
 */
export function toCodeFence(code: string, language?: string): string {
  const longestRun = Array.from(code.matchAll(/`+/g), (m) => m[0].length).reduce(
    (max, len) => Math.max(max, len),
    0,
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language ?? ''}\n${code}\n${fence}`;
}

/** 顶级目录的 key 集合：用于默认展开第一层，避免真实项目一次性全展开 */
export function topLevelDirectoryKeys(nodes: FileNode[]): string[] {
  return nodes.filter((node) => node.type === 'directory').map((node) => node.path);
}
