/**
 * 文件树面板：项目目录浏览 + 打开/刷新 + 文件预览入口
 *
 * 薄组件：状态从 projectStore 读取，交互统一交给 useProjectActions。
 * 目录只会展开（Tree 默认行为），只有叶子节点触发 readFile。
 */

import { useMemo } from 'react';
import { Alert, Button, Empty, Spin, Tooltip, Tree, Typography } from 'antd';
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import { useProjectStore } from '@/presentation/store/projectStore';
import { useProjectActions } from '@/presentation/hooks/useProjectActions';
import { basename, toTreeData, topLevelDirectoryKeys } from '@/domain/file/tree';
import FilePreviewDrawer from './FilePreviewDrawer';

const { Text } = Typography;

export default function FileTreePanel() {
  const projectPath = useProjectStore((s) => s.projectPath);
  const fileTree = useProjectStore((s) => s.fileTree);
  const treeLoading = useProjectStore((s) => s.treeLoading);
  const treeError = useProjectStore((s) => s.treeError);
  const { openFolder, refresh, selectFile } = useProjectActions();

  const treeData = useMemo(() => toTreeData(fileTree), [fileTree]);
  // 只默认展开第一层目录：真实项目全展开会一次渲染上千节点
  const defaultExpandedKeys = useMemo(() => topLevelDirectoryKeys(fileTree), [fileTree]);

  const renderBody = () => {
    if (treeLoading) {
      return (
        <div className="file-tree-center">
          <Spin />
        </div>
      );
    }

    if (treeError) {
      return (
        <div className="file-tree-error">
          <Alert type="error" showIcon message="加载文件树失败" description={treeError} />
        </div>
      );
    }

    if (!projectPath) {
      return (
        <div className="file-tree-center">
          <Empty
            description="打开项目后展示文件结构"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          >
            <Button type="primary" size="small" icon={<FolderOpenOutlined />} onClick={openFolder}>
              打开项目
            </Button>
          </Empty>
        </div>
      );
    }

    if (!treeData.length) {
      return (
        <div className="file-tree-center">
          <Empty description="目录为空" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </div>
      );
    }

    return (
      <Tree
        className="file-tree"
        treeData={treeData}
        defaultExpandedKeys={defaultExpandedKeys}
        blockNode
        onSelect={(_, info) => {
          // 只有文件需要读取；目录的展开由 Tree 自己处理
          if (info.node.isLeaf) void selectFile(String(info.node.key));
        }}
      />
    );
  };

  return (
    <div className="file-tree-panel">
      <div className="file-tree-header">
        <Text strong ellipsis className="file-tree-project">
          {projectPath ? basename(projectPath) : '未打开项目'}
        </Text>
        <div className="file-tree-actions">
          <Tooltip title={projectPath ? '切换项目' : '打开项目'}>
            <Button
              type="text"
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={openFolder}
              aria-label="打开项目"
            />
          </Tooltip>
          {projectPath && (
            <Tooltip title="刷新">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                onClick={refresh}
                aria-label="刷新文件树"
              />
            </Tooltip>
          )}
        </div>
      </div>

      <div className="file-tree-body">{renderBody()}</div>

      <FilePreviewDrawer />
    </div>
  );
}
