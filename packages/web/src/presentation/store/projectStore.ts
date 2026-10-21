/**
 * 项目上下文 store：项目路径与文件树
 *
 * 文件预览（activeFile）在文件树阶段接入；此处先承载「打开项目 → 加载树」链路。
 * 错误处理约定同 settingsStore：异常抛给调用方，由组件层提示。
 */

import { create } from 'zustand';
import type { FileNode } from '@code-agent/contracts';
import { rpc } from '@/infrastructure/bridge';

interface ProjectState {
  /** 当前打开的项目根目录（未打开时为 null） */
  projectPath: string | null;
  fileTree: FileNode[];
  treeLoading: boolean;
  treeError: string | null;

  /** 设置项目根目录并加载文件树 */
  openProject: (projectPath: string) => Promise<void>;
  /** 重新加载当前项目的文件树 */
  refreshTree: () => Promise<void>;
  /** 关闭项目（回到未打开态） */
  closeProject: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectPath: null,
  fileTree: [],
  treeLoading: false,
  treeError: null,

  openProject: async (projectPath) => {
    set({ projectPath, treeLoading: true, treeError: null });
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
    set({ projectPath: null, fileTree: [], treeLoading: false, treeError: null }),
}));
