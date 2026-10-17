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

import { Agent } from '@/index';
import type { SendResult } from '@code-agent/contracts';

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

  // 3. 运行 Agent，处理流式事件（for-await 拿不到返回值，手动迭代收集终局结果）
  let currentAssistantContent = '';
  let finalResult: SendResult | undefined;

  try {
    const gen = agent.run(userMessage);
    let r = await gen.next();
    while (!r.done) {
      const event = r.value;
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
          const toolResult = event.data.result;
          if (toolResult.success) {
            console.log(`   ✅ 结果: ${toolResult.content}`);
          } else {
            console.log(`   ❌ 错误: ${toolResult.error}`);
          }
          console.log();
          break;

        case 'message_complete':
          console.log();
          console.log(`\n--- 第 ${event.data.step} 轮思考完成 ---`);
          break;
      }
      r = await gen.next();
    }
    finalResult = r.value;
  } catch (err) {
    console.error('运行失败:', err);
    process.exit(1);
  }

  // 4. 终局收口（生成器返回值，穷尽四个退出点）
  console.log();
  console.log('='.repeat(60));
  switch (finalResult.status) {
    case 'completed':
      console.log(`任务完成！共 ${finalResult.steps} 步`);
      break;
    case 'llmFailed':
      console.error(`❌ LLM 调用失败: ${finalResult.message}`);
      break;
    case 'maxSteps':
      console.log(`已达最大思考步数 (${finalResult.steps})，任务未完成`);
      break;
    case 'aborted':
      console.log('任务被中断');
      break;
  }
  console.log('='.repeat(60));
}

main();
