/**
 * 文件树面板：项目目录浏览 + 文件预览入口
 *
 * 阶段①骨架：承载布局与三种基础态（未打开 / 加载中 / 已打开）；
 * 树渲染、打开项目按钮、文件点击预览在阶段③接入。
 */

import { Empty, Spin } from 'antd';
import { useProjectStore } from '@/presentation/store/projectStore';

export default function FileTreePanel() {
  const projectPath = useProjectStore((s) => s.projectPath);
  const treeLoading = useProjectStore((s) => s.treeLoading);

  return (
    <div className="file-tree-panel">
      {treeLoading ? (
        <Spin />
      ) : projectPath ? (
        // 已打开项目：阶段③在此渲染 antd Tree
        <Empty description="目录为空" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Empty
          description="打开项目后展示文件结构"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      )}
    </div>
  );
}
