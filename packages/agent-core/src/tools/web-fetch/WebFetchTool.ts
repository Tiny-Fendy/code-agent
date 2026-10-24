/**
 * web_fetch 工具 - 抓取网页 / 接口内容
 *
 * 让 Agent 具备出网能力：查阅在线文档、读取 API 返回、拉取远程文本资源。
 *
 * 设计对标 opencode 的 `webfetch` 与 Claude Code 的 `WebFetch`：
 * 1. 仅支持 GET，只做「读」，不发写请求
 * 2. 参数只有 url / format / timeout_ms 三个
 * 3. 响应体上限 5 MiB，超限即停止读取
 * 4. HTML 按 format 转 markdown / text / html
 * 5. 图片等二进制只回显元信息（Agent 消息模型暂无附件通道）
 *
 * 安全设计：
 * - 协议白名单（仅 http/https）与 URL 长度上限，非法输入在 I/O 之前拦截
 * - requiresConfirmation = true，每次请求前由宿主确认
 * - 超时自动中止，避免请求挂起阻塞 Agent 循环
 * - 正文按字符上限截断，避免单次回灌撑爆上下文
 *
 * 注意：收到 4xx/5xx 仍算成功观察（状态码是 LLM 需要推理的信息），
 * 只有「没拿到响应」（DNS / 连接 / TLS / 超时）才是失败。
 */

import TurndownService from 'turndown';
import Type from 'typebox';
import { BaseTool } from '../base.js';
import type { ToolResult, ToolContext, Logger } from '@code-agent/contracts';

/** URL 长度上限（对齐 Claude Code 的约 2k 限制） */
const MAX_URL_CHARS = 2_000;
/** 响应体字节上限（对齐 opencode 的 5 MiB） */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** 回灌给 LLM 的内容字符上限（与 run_command 保持一致） */
const MAX_OUTPUT_CHARS = 10_000;
/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 最大超时（毫秒，对齐 opencode 的 120s） */
const MAX_TIMEOUT_MS = 120_000;
/**
 * 请求 UA：对齐 opencode，使用浏览器 UA
 * 不少站点会直接拒绝非浏览器 UA 的请求
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** 请求头：优先接受文档类内容，其次任意类型 */
const ACCEPT_HEADER = 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7';

/** 输出形态（enum 产出形态对 LLM provider 兼容性优于 anyOf/const） */
const FORMATS = { markdown: 'markdown', text: 'text', html: 'html' } as const;
type OutputFormat = (typeof FORMATS)[keyof typeof FORMATS];

/** 参数 schema：唯一事实来源 */
const webFetchParams = Type.Object({
  url: Type.String({
    minLength: 1,
    maxLength: MAX_URL_CHARS,
    description: '完整 URL，必须以 http:// 或 https:// 开头',
  }),
  format: Type.Optional(
    Type.Enum(FORMATS, {
      description: 'HTML 的输出形态，默认 markdown；非 HTML 内容不受影响',
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}`,
    }),
  ),
});

/** 无需读响应体的状态码 */
const EMPTY_BODY_STATUS = new Set([204, 205]);

export class WebFetchTool extends BaseTool<typeof webFetchParams> {
  name = 'web_fetch';
  description = `抓取一个网页或接口并返回其内容。仅支持 GET，适用于：查阅在线文档、读取 API 返回、拉取远程文本资源。
注意：
1. 仅支持 http/https；响应体超过 5 MiB 或内容超过 10000 字符会被截断
2. format 决定 HTML 的输出形态：markdown（默认，适合阅读）/ text（纯文本）/ html（原始 HTML）；JSON、纯文本等非 HTML 内容原样返回
3. 4xx/5xx 也会返回状态码与内容，不会中断任务
4. 图片等二进制内容只返回类型与大小，不返回内容
5. 不支持自定义请求头，需要鉴权的地址无法抓取`;
  readonly parameters = webFetchParams;
  requiresConfirmation = true;

  private readonly turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  protected async run(
    params: Type.Static<typeof webFetchParams>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const logger = context.logger;

    // ---- URL 语义校验：可解析性与协议白名单无法由 schema 表达 ----
    const rawUrl = params.url.trim();
    if (!rawUrl) {
      return this.error('[invalid] url 参数不能为空');
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return this.error(`[invalid] 无法解析的 URL: ${rawUrl}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return this.error(`[invalid] 仅支持 http/https 协议，收到: ${url.protocol}`);
    }

    const format: OutputFormat = params.format ?? 'markdown';
    const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    logger?.info('web_fetch 请求', { host: url.host, format, timeoutMs });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startAt = Date.now();

    try {
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: 'GET',
          headers: { 'user-agent': USER_AGENT, accept: ACCEPT_HEADER },
          redirect: 'follow',
          signal: controller.signal,
        });
      } catch (err) {
        return this.requestError(err, controller, timeoutMs, url.host, startAt, logger);
      }

      let received: { bytes: Uint8Array; total: number; truncated: boolean };
      try {
        received = await this.readBody(response);
      } catch (err) {
        return this.requestError(err, controller, timeoutMs, url.host, startAt, logger);
      }

      const content = this.formatResponse(response, format, received);
      logger?.info('web_fetch 响应', {
        status: response.status,
        bytes: received.total,
        durationMs: Date.now() - startAt,
        truncated: received.truncated || content.truncated,
        redirected: response.redirected,
      });

      return this.success(content.text);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 流式读取响应体，超过字节上限即停止并标记截断
   *
   * 用流式读取而不是 response.text()，避免超大响应先完整进内存再被丢弃。
   */
  private async readBody(
    response: Response,
  ): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
    const stream = response.body;
    if (!stream) {
      return { bytes: new Uint8Array(0), total: 0, truncated: false };
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;

    try {
      while (total < MAX_RESPONSE_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          break;
        }
        const value = chunk.value;
        if (!value || value.byteLength === 0) {
          continue;
        }
        const remaining = MAX_RESPONSE_BYTES - total;
        const kept = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        chunks.push(kept);
        total += kept.byteLength;
      }
    } finally {
      if (!done) {
        // 达到上限后主动断流，不再消耗带宽与内存
        await reader.cancel().catch(() => {});
      }
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { bytes, total, truncated: !done };
  }

  /** 把响应拼装成回灌给 LLM 的观察文本 */
  private formatResponse(
    response: Response,
    format: OutputFormat,
    received: { bytes: Uint8Array; total: number; truncated: boolean },
  ): { text: string; truncated: boolean } {
    const parts: string[] = [`HTTP ${response.status} ${response.statusText}`.trim()];

    if (response.redirected && response.url) {
      parts.push(`最终 URL: ${response.url}`);
    }

    const contentType = (response.headers.get('content-type') ?? '').trim();
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (mime) {
      parts.push(`content-type: ${mime}`);
    }

    parts.push('--- 内容 ---');

    const hasNoBody =
      EMPTY_BODY_STATUS.has(response.status) || received.total === 0;
    if (hasNoBody) {
      parts.push('（无响应体）');
      return { text: parts.join('\n'), truncated: false };
    }

    // ---- 二进制：只报元信息 ----
    if (mime !== '' && !this.isTextual(mime)) {
      parts.push(`[二进制响应] content-type: ${mime}，${received.total} 字节，未回显内容`);
      if (received.truncated) {
        parts.push(`[响应体超过 ${MAX_RESPONSE_BYTES} 字节，已截断]`);
      }
      return { text: parts.join('\n'), truncated: received.truncated };
    }

    const raw = new TextDecoder('utf-8', { fatal: false }).decode(received.bytes);

    // ---- HTML 按 format 转换；其余文本原样返回 ----
    let body = raw;
    if (this.isHtml(mime)) {
      const title = extractTitle(raw);
      if (title) {
        parts.push(`标题: ${title}`);
      }
      if (format === 'markdown') {
        body = this.htmlToMarkdown(raw);
      } else if (format === 'text') {
        body = htmlToText(raw);
      }
    }

    let textTruncated = false;
    if (body.length > MAX_OUTPUT_CHARS) {
      body = body.slice(0, MAX_OUTPUT_CHARS);
      textTruncated = true;
    }
    parts.push(body.trim() || '（空内容）');
    if (textTruncated) {
      parts.push(`[内容超过 ${MAX_OUTPUT_CHARS} 字符，已截断]`);
    }
    if (received.truncated) {
      parts.push(`[响应体超过 ${MAX_RESPONSE_BYTES} 字节，已截断]`);
    }

    return { text: parts.join('\n'), truncated: textTruncated || received.truncated };
  }

  /** HTML → Markdown；转换失败降级为纯文本，绝不因页面结构异常中断 */
  private htmlToMarkdown(html: string): string {
    try {
      return this.turndown.turndown(html);
    } catch {
      return htmlToText(html);
    }
  }

  private isHtml(mime: string): boolean {
    return mime === 'text/html' || mime === 'application/xhtml+xml';
  }

  /** 文本类型判定：无 content-type 时按文本处理（常见于简易 API） */
  private isTextual(mime: string): boolean {
    if (mime.startsWith('text/')) {
      return true;
    }
    if (
      mime === 'application/json' ||
      mime === 'application/xml' ||
      mime === 'application/javascript' ||
      mime === 'application/x-www-form-urlencoded' ||
      mime === 'application/graphql'
    ) {
      return true;
    }
    return mime.endsWith('+json') || mime.endsWith('+xml');
  }

  /** 统一处理「没拿到响应」的两类失败：超时与网络错误 */
  private requestError(
    err: unknown,
    controller: AbortController,
    timeoutMs: number,
    host: string,
    startAt: number,
    logger?: Logger,
  ): ToolResult {
    const durationMs = Date.now() - startAt;

    if (controller.signal.aborted) {
      logger?.warn('web_fetch 超时', { host, timeoutMs, durationMs });
      return this.error(`[timeout] 请求超时（${timeoutMs}ms）`);
    }

    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code
      ? `${cause.code}${cause.message ? `: ${cause.message}` : ''}`
      : (err as Error).message;
    logger?.warn('web_fetch 失败', { host, error: detail, durationMs });
    return this.error(`[network] 请求失败: ${detail}`);
  }
}

/** 退出前把常见 HTML 实体还原成字符 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 提取 `<title>`，作为内容摘要之外的额外定位信息 */
function extractTitle(html: string): string | undefined {
  const matched = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!matched) {
    return undefined;
  }
  const title = decodeEntities(matched[1]).replace(/\s+/g, ' ').trim();
  return title || undefined;
}

/**
 * HTML → 纯文本（format=text）
 *
 * 不用 turndown 再剥 markdown 标记，直接按块级标签换行 + 去标签，
 * 避免把 `#` / `**` 之类的转换残留带进纯文本。
 */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
