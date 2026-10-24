/**
 * run_command 工具 - 在项目目录内执行 Shell 命令
 *
 * 让 Agent 具备"验证结果"的能力：跑测试、安装依赖、执行 git 等。
 *
 * 安全设计：
 * 1. 工作目录必须位于项目根目录内（PathGuard 校验，防止 cd 逃逸）
 * 2. requiresConfirmation = true，执行前需用户确认（高危操作）
 * 3. 超时自动终止（防止命令挂起阻塞整个 Agent 循环）
 * 4. 输出截断（stdout 太长回灌会撑爆上下文窗口）
 *
 * 注意：每次命令独立执行，不保留状态（cd / export 不会影响下次调用）。
 */

import { spawn } from 'node:child_process';
import Type from 'typebox';
import { BaseTool } from '../base.js';
import type { ToolResult, ToolContext } from '@code-agent/contracts';
import { PathGuard, PathGuardError } from '../support/PathGuard.js';

/** 输出上限（字符数），超出部分丢弃并提示 */
const MAX_OUTPUT_CHARS = 10_000;
/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 最大超时（毫秒） */
const MAX_TIMEOUT_MS = 300_000;
/** SIGTERM 后强杀的宽限期（毫秒） */
const KILL_GRACE_MS = 3_000;

/** 参数 schema：唯一事实来源 */
const runCommandParams = Type.Object({
  command: Type.String({ minLength: 1, description: '要执行的 Shell 命令' }),
  cwd: Type.Optional(
    Type.String({ description: '工作目录，相对项目根目录。不填默认为项目根目录' }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `超时时间（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}`,
    }),
  ),
});

export class RunCommandTool extends BaseTool<typeof runCommandParams> {
  name = 'run_command';
  description = `在项目目录内执行 Shell 命令并返回输出。适用于：运行测试、安装依赖、git 操作、构建项目等。
注意：
1. 每次执行相互独立，cd / export 等状态不会保留，需要用 cwd 参数或组合命令（如 "cd dir && cmd"）
2. 长时间运行的常驻进程（如 dev server）会在超时后被终止，请改用可退出的命令
3. 优先使用非交互式命令，避免需要用户输入的场景`;
  readonly parameters = runCommandParams;
  requiresConfirmation = true;

  private pathGuard: PathGuard;

  constructor(projectPath: string) {
    super();
    this.pathGuard = new PathGuard(projectPath);
  }

  protected async run(
    params: Type.Static<typeof runCommandParams>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const { command } = params;

    // 语义校验：trim 后空白（schema 的 minLength 不 trim）
    if (!command.trim()) {
      return this.error('command 参数不能为空');
    }

    const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    // 校验工作目录，防止 cd 逃逸出项目
    let cwd = this.pathGuard.getProjectRoot();
    if (params.cwd) {
      try {
        cwd = await this.pathGuard.resolveAndValidate(params.cwd);
      } catch (err) {
        return this.error(
          err instanceof PathGuardError
            ? err.message
            : `cwd 校验失败: ${(err as Error).message}`,
        );
      }
    }

    // 执行命令
    return new Promise<ToolResult>((resolve) => {
      // stdio: stdin 忽略（避免命令等待输入挂起），stdout/stderr 捕获
      const child = spawn(command, {
        shell: true,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let truncated = false;

      const append = (chunk: Buffer) => {
        if (output.length >= MAX_OUTPUT_CHARS) {
          truncated = true;
          return;
        }
        output += chunk.toString();
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS);
          truncated = true;
        }
      };

      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // 宽限期后强杀
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        // spawn 本身失败（如 shell 不存在等极端情况）
        resolve(this.error(`命令执行失败: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);

        if (timedOut) {
          resolve(
            this.success(
              this.formatOutput(output, truncated, `命令超时（${timeoutMs}ms），已被终止`),
            ),
          );
          return;
        }

        // 退出码为 null 且有 signal，说明是被信号终止的
        const exitInfo = code !== null ? `退出码: ${code}` : `被信号终止: ${signal}`;
        resolve(this.success(this.formatOutput(output, truncated, exitInfo)));
      });
    });
  }

  /** 组装返回给 LLM 的输出 */
  private formatOutput(output: string, truncated: boolean, exitInfo: string): string {
    const parts: string[] = [exitInfo];

    if (output.trim()) {
      parts.push('--- 输出 ---', output.trimEnd());
    } else {
      parts.push('（无输出）');
    }

    if (truncated) {
      parts.push(`[输出超过 ${MAX_OUTPUT_CHARS} 字符，已截断]`);
    }

    return parts.join('\n');
  }
}
