import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './presentation/styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{
      algorithm: undefined, // 默认浅色主题，后续可切换暗色
      token: {
        colorPrimary: '#12B886',
        borderRadius: 6,
      },
    }}>
      {/* AntdApp 提供 message/notification 的上下文，消除静态方法警告 */}
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
