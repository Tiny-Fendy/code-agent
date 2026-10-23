/**
 * 项目操作 hook：编排「选择目录 → 加载树 → 预览文件」的交互副作用
 *
 * 组件只负责触发，错误提示与 rpc 调用集中在这里，
 * 避免打开项目/刷新/预览三个动作的反馈逻辑散落在各组件。
 */

import { useCallback } from 'react';
import { message } from 'antd';
import { rpc } from '@/infrastructure/bridge';
import { useProjectStore } from '@/presentation/store/projectStore';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useProjectActions() {
  const openProject = useProjectStore((s) => s.openProject);
  const refreshTree = useProjectStore((s) => s.refreshTree);
  const closeProject = useProjectStore((s) => s.closeProject);
  const openFile = useProjectStore((s) => s.openFile);
  const closeFile = useProjectStore((s) => s.closeFile);

  /** 打开系统目录选择框；用户取消（返回 null）时静默不做任何事 */
  const openFolder = useCallback(async () => {
    try {
      const path = await rpc.file.openFolderDialog();
      if (!path) return;
      await openProject(path);
    } catch (err) {
      message.error(`打开项目失败：${errText(err)}`);
    }
  }, [openProject]);

  const refresh = useCallback(async () => {
    try {
      await refreshTree();
    } catch (err) {
      message.error(`刷新文件树失败：${errText(err)}`);
    }
  }, [refreshTree]);

  /** 点击树节点：文件则预览（目录由 Tree 自身展开，不触发读取） */
  const selectFile = useCallback(
    async (filePath: string) => {
      try {
        await openFile(filePath);
      } catch (err) {
        message.error(`读取文件失败：${errText(err)}`);
      }
    },
    [openFile],
  );

  return { openFolder, refresh, selectFile, closeProject, closeFile };
}
