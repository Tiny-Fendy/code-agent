/**
 * Agent 核心测试脚本
 *
 * 用法：
 *   1. 设置环境变量：export OPENAI_API_KEY=your_key
 *   2. 可选：export OPENAI_BASE_URL=https://api.openai.com/v1
 *   3. 可选：export MODEL=gpt-4o
 *   4. 运行：npx tsx test/agent.test.ts "你的问题"
 *
 * 这个脚本演示了 Agent 的完整 ReAct 循环：
 * - 用户发消息
 * - LLM 思考（流式输出）
 * - 如果需要，调用工具
 * - 把工具结果回灌给 LLM
 * - LLM 继续思考，直到给出最终答案
 */

import { Agent } from '../src/index';

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.MODEL || 'gpt-4o';

  if (!apiKey) {
    console.error('错误：请设置 OPENAI_API_KEY 环境变量');
    process.exit(1);
  }

  const userMessage = process.argv[2] || '列出当前项目的目录结构';

  console.log('='.repeat(60));
  console.log(`模型: ${model}`);
  console.log(`用户: ${userMessage}`);
  console.log('='.repeat(60));
  console.log();

  // 创建 Agent（内置文件工具自动注册）
  const agent = new Agent(
    {
      apiKey,
      baseUrl,
      model,
      temperature: 0.7,
      maxSteps: 5,
    },
    process.cwd(),
  );

  // 3. 运行 Agent，处理流式事件
  let currentAssistantContent = '';

  try {
    for await (const event of agent.run(userMessage)) {
      switch (event.type) {
        case 'text_delta':
          // 流式文本增量
          process.stdout.write(event.data.delta);
          currentAssistantContent += event.data.delta;
          break;

        case 'tool_call_delta':
          // 工具调用增量（arguments 还在拼接中）
          // 一般不需要展示，这里注释掉，想看可以打开
          // const tc = event.data.toolCalls[0];
          // if (tc) console.log(`\n[工具调用中] ${tc.name}: ${tc.arguments}`);
          break;

        case 'tool_call_start':
          console.log();
          console.log(`\n🛠  调用工具: ${event.data.toolName}`);
          console.log(`   参数: ${JSON.stringify(event.data.arguments)}`);
          break;

        case 'tool_call_result':
          const result = event.data.result;
          if (result.success) {
            console.log(`   ✅ 结果: ${result.content}`);
          } else {
            console.log(`   ❌ 错误: ${result.error}`);
          }
          console.log();
          break;

        case 'message_complete':
          console.log();
          console.log(`\n--- 第 ${event.data.step} 轮思考完成 ---`);
          break;

        case 'done':
          console.log();
          console.log('='.repeat(60));
          console.log(`任务完成！共 ${event.data.steps ?? '?'} 步`);
          console.log('='.repeat(60));
          break;

        case 'error':
          console.error(`\n❌ 错误: ${event.data.message}`);
          break;
      }
    }
  } catch (err) {
    console.error('运行失败:', err);
  }
}

main();
