/**
 * 项目上下文 store：项目路径、文件树、文件预览
 *
 * 文件预览的加载/错误状态也在这里：抽屉组件只读状态、不发请求。
 * 错误处理约定同 settingsStore：异常在 store 中记录后继续抛给调用方，
 * 由 hook 统一提示（避免 store 依赖 UI 库）。
 */

import { create } from 'zustand';
import type { FileNode } from '@code-agent/contracts';
import { rpc } from '@/infrastructure/bridge';
import { basename, fileLanguage } from '@/domain/file/tree';

/** 当前预览中的文件（只读） */
export interface ActiveFile {
  path: string;
  name: string;
  content: string;
  /** highlight.js 语言名；未知为 undefined（按纯文本展示） */
  language: string | undefined;
}

interface ProjectState {
  /** 当前打开的项目根目录（未打开时为 null） */
  projectPath: string | null;
  fileTree: FileNode[];
  treeLoading: boolean;
  treeError: string | null;

  /** 预览中的文件；null 表示抽屉关闭 */
  activeFile: ActiveFile | null;
  fileLoading: boolean;
  fileError: string | null;

  /** 设置项目根目录并加载文件树（同时关闭上一个项目的预览） */
  openProject: (projectPath: string) => Promise<void>;
  /** 重新加载当前项目的文件树 */
  refreshTree: () => Promise<void>;
  /** 关闭项目（回到未打开态） */
  closeProject: () => void;
  /** 读取并预览文件 */
  openFile: (filePath: string) => Promise<void>;
  /** 关闭预览抽屉（清理错误态） */
  closeFile: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectPath: null,
  fileTree: [],
  treeLoading: false,
  treeError: null,

  activeFile: null,
  fileLoading: false,
  fileError: null,

  openProject: async (projectPath) => {
    set({
      projectPath,
      treeLoading: true,
      treeError: null,
      activeFile: null,
      fileError: null,
    });
    try {
      const fileTree = await rpc.file.getFileTree(projectPath);
      set({ fileTree, treeLoading: false });
    } catch (err) {
      set({
        treeLoading: false,
        treeError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  refreshTree: async () => {
    const { projectPath } = get();
    if (!projectPath) return;
    await get().openProject(projectPath);
  },

  closeProject: () =>
    set({
      projectPath: null,
      fileTree: [],
      treeLoading: false,
      treeError: null,
      activeFile: null,
      fileLoading: false,
      fileError: null,
    }),

  openFile: async (filePath) => {
    set({ fileLoading: true, fileError: null });
    try {
      const content = await rpc.file.readFile(filePath);
      set({
        fileLoading: false,
        activeFile: {
          path: filePath,
          name: basename(filePath),
          content,
          language: fileLanguage(filePath),
        },
      });
    } catch (err) {
      set({
        fileLoading: false,
        fileError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  closeFile: () => set({ activeFile: null, fileLoading: false, fileError: null }),
}));
