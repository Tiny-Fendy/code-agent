/**
 * 根组件：三栏布局骨架（薄组件，只做布局编排）
 *
 * 结构：顶栏（TopBar）/ 左栏文件树（Sider）/ 中栏对话区（Content）。
 * 底部终端面板预留位：主进程 terminal 服务与契约落地后，在 app-body 下方
 * 挂载 TerminalPanel（可折叠横条布局），届时不再改动本文件的整体结构。
 */

import { Layout } from 'antd';
import TopBar from '@/presentation/components/TopBar';
import FileTreePanel from '@/presentation/components/FileTree/FileTreePanel';
import ChatArea from '@/presentation/components/Chat/ChatArea';

const { Sider, Content } = Layout;

function App() {
  return (
    <Layout className="app-layout">
      <TopBar />
      <Layout className="app-body">
        <Sider width={260} theme="light" className="app-sider">
          <FileTreePanel />
        </Sider>
        <Content className="app-content">
          <ChatArea />
        </Content>
      </Layout>
    </Layout>
  );
}

export default App;
