import { useEffect, useRef, useState } from 'react';
import { Layout, Typography, Space, Tag, Card, Input, Button, message } from 'antd';
import { CodeOutlined, SendOutlined, StopOutlined } from '@ant-design/icons';
import { type AgentEvent, type AppConfig, type SendResult } from '@code-agent/contracts';
import { type RpcStreamHandle } from '@code-agent/rpc/protocol';
import rpc from './bridge';

const { Header, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

// 纯浏览器（无 preload）时 window.transport 不存在，走 mock
const IS_MOCK = typeof window === 'undefined' || !window.transport;

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [input, setInput] = useState('列出当前项目的目录结构');
  const [streaming, setStreaming] = useState(false);
  const [answer, setAnswer] = useState('');
  const streamRef = useRef<RpcStreamHandle<AgentEvent, SendResult> | null>(null);

  // 冒烟：读配置，显示当前模型名
  useEffect(() => {
    rpc.config.get().then(setConfig).catch((err: unknown) => {
      message.error(`读取配置失败：${err instanceof Error ? err.message : String(err)}`);
    });
  }, []);

  // 卸载时中断在途流，避免泄漏
  useEffect(() => () => streamRef.current?.abort(), []);

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;

    setAnswer('');
    setStreaming(true);

    const stream = rpc.chat.send(text);
    streamRef.current = stream;

    stream.on('text_delta', (data) => {
      setAnswer((prev) => prev + data.delta);
    });
    stream.on('tool_call_start', (data) => {
      setAnswer((prev) => `${prev}\n[调用工具] ${data.toolName}\n`);
    });
    // 唯一收口：协议层三态终局；completed 内再按 SendResult 分业务终局
    stream.onEnd((end) => {
      setStreaming(false);
      streamRef.current = null;

      if (end.status === 'aborted') return; // 用户主动停止，复位不报错
      if (end.status === 'failed') {
        message.error(`对话失败：${end.error.message}`);
        return;
      }

      const result = end.result;
      if (result.status === 'llmFailed') {
        message.error(`对话失败：${result.message}`);
      } else if (result.status === 'maxSteps') {
        message.warning(`已达最大思考步数（${result.steps}），任务可能未完成`);
      }
    });
  };

  const stop = () => {
    streamRef.current?.abort();
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          background: '#fff',
          borderBottom: '1px solid #f0f0f0',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <Space>
          <CodeOutlined style={{ fontSize: 20, color: '#12B886' }} />
          <Title level={4} style={{ margin: 0 }}>
            Code Agent
          </Title>
          <Tag color={IS_MOCK ? 'orange' : 'green'}>{IS_MOCK ? 'Mock 模式' : 'Electron'}</Tag>
        </Space>
      </Header>

      <Content style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
        <Space direction="vertical" size="middle" style={{ width: '100%', maxWidth: 720 }}>
          <Card size="small">
            <Text type="secondary">当前模型：</Text>
            <Text strong>{config?.api.model ?? '加载中…'}</Text>
          </Card>

          <Card
            title="RPC 冒烟对话"
            extra={
              streaming ? (
                <Button danger icon={<StopOutlined />} onClick={stop}>
                  停止
                </Button>
              ) : (
                <Button type="primary" icon={<SendOutlined />} onClick={send}>
                  发送
                </Button>
              )
            }
          >
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 4 }}
              disabled={streaming}
              style={{ marginBottom: 12 }}
            />
            <Paragraph
              style={{
                whiteSpace: 'pre-wrap',
                minHeight: 120,
                marginBottom: 0,
                background: '#fafafa',
                padding: 12,
                borderRadius: 6,
              }}
            >
              {answer || (
                <Text type="secondary">
                  {streaming ? '思考中…' : '点击发送，流式输出会显示在这里。'}
                </Text>
              )}
            </Paragraph>
          </Card>
        </Space>
      </Content>
    </Layout>
  );
}

export default App;
