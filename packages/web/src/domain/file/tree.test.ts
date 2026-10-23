/**
 * 文件领域逻辑单测
 *
 * 按功能设计覆盖：树转换、路径取名、语言推断、代码围栏（含反引号边界）。
 */

import { describe, it, expect } from 'vitest';
import type { FileNode } from '@code-agent/contracts';
import {
  toTreeData,
  basename,
  fileLanguage,
  toCodeFence,
  topLevelDirectoryKeys,
} from './tree';

const tree: FileNode[] = [
  {
    name: 'src',
    path: '/demo/src',
    type: 'directory',
    children: [
      { name: 'index.ts', path: '/demo/src/index.ts', type: 'file' },
      {
        name: 'utils',
        path: '/demo/src/utils',
        type: 'directory',
        children: [{ name: 'format.ts', path: '/demo/src/utils/format.ts', type: 'file' }],
      },
    ],
  },
  { name: 'package.json', path: '/demo/package.json', type: 'file' },
];

describe('toTreeData', () => {
  it('目录递归转换，key 使用绝对路径', () => {
    const data = toTreeData(tree);
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ key: '/demo/src', title: 'src', isLeaf: false });
    expect(data[0].children).toHaveLength(2);
    expect(data[0].children?.[0]).toMatchObject({
      key: '/demo/src/index.ts',
      title: 'index.ts',
      isLeaf: true,
    });
    expect(data[0].children?.[1].children?.[0].key).toBe('/demo/src/utils/format.ts');
  });

  it('空目录不产出 children，避免渲染空展开器', () => {
    const data = toTreeData([{ name: 'empty', path: '/demo/empty', type: 'directory', children: [] }]);
    expect(data[0].isLeaf).toBe(false);
    expect(data[0].children).toBeUndefined();
  });
});

describe('basename', () => {
  it('支持 POSIX 路径', () => {
    expect(basename('/Users/tiny/Project/demo')).toBe('demo');
  });

  it('支持 Windows 路径', () => {
    expect(basename('C:\\Users\\tiny\\demo')).toBe('demo');
  });

  it('忽略末尾分隔符', () => {
    expect(basename('/demo/src/')).toBe('src');
  });
});

describe('fileLanguage', () => {
  it('常见扩展名映射到高亮语言', () => {
    expect(fileLanguage('/demo/src/index.ts')).toBe('typescript');
    expect(fileLanguage('/demo/src/App.tsx')).toBe('typescript');
    expect(fileLanguage('/demo/package.json')).toBe('json');
    expect(fileLanguage('/demo/README.md')).toBe('markdown');
    expect(fileLanguage('/demo/styles.css')).toBe('css');
  });

  it('大小写不敏感', () => {
    expect(fileLanguage('/demo/README.MD')).toBe('markdown');
  });

  it('未知或无扩展名返回 undefined', () => {
    expect(fileLanguage('/demo/.gitignore')).toBeUndefined();
    expect(fileLanguage('/demo/LICENSE')).toBeUndefined();
    expect(fileLanguage('/demo/a.unknownext')).toBeUndefined();
  });
});

describe('toCodeFence', () => {
  it('普通内容用三反引号并标注语言', () => {
    expect(toCodeFence('const a = 1;', 'typescript')).toBe(
      '```typescript\nconst a = 1;\n```',
    );
  });

  it('内容含三反引号时围栏自动加长，避免提前闭合', () => {
    const code = 'const md = `\n```\n`;';
    const fenced = toCodeFence(code, 'typescript');
    // 内容里最长连续反引号为 3 → 围栏应为 4
    expect(fenced.startsWith('````typescript\n')).toBe(true);
    expect(fenced.endsWith('\n````')).toBe(true);
  });

  it('无语言时围栏后直接换行', () => {
    expect(toCodeFence('plain', undefined)).toBe('```\nplain\n```');
  });

  it('空内容仍产出合法围栏', () => {
    expect(toCodeFence('', 'json')).toBe('```json\n\n```');
  });
});

describe('topLevelDirectoryKeys', () => {
  it('只返回顶级目录的 key', () => {
    expect(topLevelDirectoryKeys(tree)).toEqual(['/demo/src']);
  });
});
