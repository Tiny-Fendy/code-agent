import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{
      algorithm: undefined, // 默认浅色主题，后续可切换暗色
      token: {
        colorPrimary: '#12B886',
        borderRadius: 6,
      },
    }}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
