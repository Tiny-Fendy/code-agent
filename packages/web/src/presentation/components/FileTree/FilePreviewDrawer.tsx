/**
 * 文件预览抽屉（只读）
 *
 * 从右侧滑出，展示文件内容；复用 Markdown 渲染器做语法高亮，
 * 通过 toCodeFence 把原始代码包成围栏（自动处理内容自带反引号的情况）。
 */

import { Alert, Drawer, Spin, Typography } from 'antd';
import { FileTextOutlined } from '@ant-design/icons';
import { useProjectStore } from '@/presentation/store/projectStore';
import { useProjectActions } from '@/presentation/hooks/useProjectActions';
import { toCodeFence } from '@/domain/file/tree';
import Markdown from '../Chat/Markdown';

const { Text } = Typography;

export default function FilePreviewDrawer() {
  const activeFile = useProjectStore((s) => s.activeFile);
  const fileLoading = useProjectStore((s) => s.fileLoading);
  const fileError = useProjectStore((s) => s.fileError);
  const { closeFile } = useProjectActions();

  const open = Boolean(activeFile) || fileLoading || Boolean(fileError);

  return (
    <Drawer
      open={open}
      onClose={closeFile}
      width={720}
      placement="right"
      title={
        activeFile ? (
          <div className="file-preview-title">
            <FileTextOutlined />
            <Text strong ellipsis>
              {activeFile.name}
            </Text>
            <Text type="secondary" ellipsis className="file-preview-path">
              {activeFile.path}
            </Text>
          </div>
        ) : (
          '文件预览'
        )
      }
      styles={{ body: { padding: 16 } }}
    >
      {fileLoading ? (
        <div className="file-preview-center">
          <Spin />
        </div>
      ) : fileError ? (
        <Alert type="error" showIcon message="读取文件失败" description={fileError} />
      ) : activeFile ? (
        <div className="file-preview-body">
          <Markdown>{toCodeFence(activeFile.content, activeFile.language)}</Markdown>
        </div>
      ) : null}
    </Drawer>
  );
}
