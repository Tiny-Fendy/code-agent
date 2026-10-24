import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebFetchTool } from '@/tools/web-fetch';
import type { Logger, ToolContext } from '@code-agent/contracts';

/** 记录日志调用，供埋点断言 */
class FakeLogger implements Logger {
  readonly logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  debug(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'debug', message, context });
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'info', message, context });
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'warn', message, context });
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'error', message, context });
  }
}

const tool = new WebFetchTool();
const ctx: ToolContext = { projectPath: '/tmp/test' };

interface FakeResponseInit {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ReadableStream<Uint8Array> | null;
  redirected?: boolean;
  url?: string;
}

/** 构造 Response；redirected / url 为只读属性，用 defineProperty 覆盖 */
function res(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const bodyAllowed = status !== 204 && status !== 205 && status !== 304;
  const body = bodyAllowed && init.body !== undefined ? init.body : null;
  const response = new Response(body as BodyInit | null, {
    status,
    statusText: init.statusText ?? '',
    headers: new Headers(init.headers ?? {}),
  });
  Object.defineProperty(response, 'redirected', { value: init.redirected ?? false });
  Object.defineProperty(response, 'url', { value: init.url ?? '' });
  return response;
}

/** 按块产出字节的流，用于构造超大响应 */
function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
  });
}

/** 安装 fetch stub 并返回 mock */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

const HTML_PAGE =
  '<html><head><title>示例页</title></head><body><h1>标题</h1><p>Hello <strong>World</strong></p></body></html>';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebFetchTool 元数据', () => {
  it('名称、确认策略与参数 schema 正确', () => {
    expect(tool.name).toBe('web_fetch');
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.parameters.required).toEqual(['url']);
    expect(tool.parameters.properties.format.enum).toEqual(['markdown', 'text', 'html']);
    expect(Object.keys(tool.parameters.properties)).toEqual(['url', 'format', 'timeout_ms']);
  });

  it('toDefinition 输出可直接交给 LLM', () => {
    const def = tool.toDefinition();
    expect(def.name).toBe('web_fetch');
    expect(def.parameters.type).toBe('object');
  });
});

describe('URL 校验', () => {
  const fetchMock = () => stubFetch(async () => res({ body: 'ok' }));

  it('缺失 url 返回 error 且不发请求', async () => {
    const mock = fetchMock();
    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(false);
    // 形状校验由基类 schema 层承担
    expect(result.error).toContain('参数校验失败');
    expect(result.error).toContain('url');
    expect(mock).not.toHaveBeenCalled();
  });

  it('空白 url 返回 error', async () => {
    const mock = fetchMock();
    const result = await tool.execute({ url: '   ' }, ctx);
    expect(result.success).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it('超过 2000 字符返回 error', async () => {
    const mock = fetchMock();
    const result = await tool.execute({ url: `https://a.test/${'x'.repeat(2000)}` }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('2000');
    expect(mock).not.toHaveBeenCalled();
  });

  it('无法解析的 url 返回 error', async () => {
    const mock = fetchMock();
    const result = await tool.execute({ url: 'not a url' }, ctx);
    expect(result.success).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it('file:// 协议被拒绝', async () => {
    const mock = fetchMock();
    const result = await tool.execute({ url: 'file:///etc/passwd' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('file:');
    expect(mock).not.toHaveBeenCalled();
  });

  it('ftp:// 协议被拒绝', async () => {
    const mock = fetchMock();
    const result = await tool.execute({ url: 'ftp://example.com/a.txt' }, ctx);
    expect(result.success).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('参数校验与请求形态', () => {
  it('非法 format 返回 error', async () => {
    const mock = stubFetch(async () => res({ body: 'ok' }));
    const result = await tool.execute({ url: 'https://a.test', format: 'pdf' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('format');
    expect(mock).not.toHaveBeenCalled();
  });

  it('timeout_ms 非正数返回 error', async () => {
    const mock = stubFetch(async () => res({ body: 'ok' }));
    for (const value of [0, -1, 'abc']) {
      const result = await tool.execute({ url: 'https://a.test', timeout_ms: value }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout_ms');
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('超过上限报错且不发请求（范围由 schema 约束）', async () => {
    const mock = stubFetch(async () => res({ body: 'ok' }));
    const result = await tool.execute({ url: 'https://a.test', timeout_ms: 999_999 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('参数校验失败');
    expect(result.error).toContain('/timeout_ms');
    expect(mock).not.toHaveBeenCalled();
  });

  it('上限边界 120000ms 正常透传', async () => {
    const logger = new FakeLogger();
    stubFetch(async () => res({ body: 'ok' }));
    await tool.execute({ url: 'https://a.test', timeout_ms: 120_000 }, { ...ctx, logger });
    const requestLog = logger.logs.find((l) => l.message === 'web_fetch 请求');
    expect(requestLog?.context?.timeoutMs).toBe(120_000);
  });

  it('请求固定为 GET，带浏览器 UA 与 Accept，跟随重定向', async () => {
    const mock = stubFetch(async () => res({ body: 'ok' }));
    await tool.execute({ url: 'https://a.test' }, ctx);

    const init = mock.mock.calls[0][1];
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('follow');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('Mozilla/5.0');
    expect(headers.accept).toContain('text/html');
  });
});

describe('内容转换（format）', () => {
  it('默认 markdown：HTML 转 Markdown 并提取标题', async () => {
    stubFetch(async () =>
      res({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: HTML_PAGE }),
    );
    const result = await tool.execute({ url: 'https://a.test/page' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('标题: 示例页');
    expect(result.content).toContain('# 标题');
    expect(result.content).toContain('**World**');
    expect(result.content).not.toContain('<h1>');
  });

  it('format=text：剥掉标签输出纯文本', async () => {
    stubFetch(async () =>
      res({ headers: { 'content-type': 'text/html' }, body: HTML_PAGE }),
    );
    const result = await tool.execute({ url: 'https://a.test/page', format: 'text' }, ctx);
    expect(result.content).toContain('Hello World');
    expect(result.content).not.toContain('<h1>');
    expect(result.content).not.toContain('# 标题');
  });

  it('format=html：保留原始 HTML', async () => {
    stubFetch(async () =>
      res({ headers: { 'content-type': 'text/html' }, body: HTML_PAGE }),
    );
    const result = await tool.execute({ url: 'https://a.test/page', format: 'html' }, ctx);
    expect(result.content).toContain('<h1>标题</h1>');
  });

  it('非 HTML 内容（JSON）不受 format 影响，原样返回', async () => {
    stubFetch(async () =>
      res({ headers: { 'content-type': 'application/json' }, body: '{"items":[1,2]}' }),
    );
    const result = await tool.execute({ url: 'https://api.test/items', format: 'markdown' }, ctx);
    expect(result.content).toContain('{"items":[1,2]}');
  });

  it('script / style 内容不会进入 text 输出', async () => {
    stubFetch(async () =>
      res({
        headers: { 'content-type': 'text/html' },
        body: '<body><script>alert(1)</script><p>正文</p></body>',
      }),
    );
    const result = await tool.execute({ url: 'https://a.test', format: 'text' }, ctx);
    expect(result.content).toContain('正文');
    expect(result.content).not.toContain('alert(1)');
  });
});

describe('响应与截断', () => {
  it('404 视为成功观察，状态码与内容照常返回', async () => {
    stubFetch(async () =>
      res({ status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' }, body: '{"error":"missing"}' }),
    );
    const result = await tool.execute({ url: 'https://a.test/missing' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('HTTP 404 Not Found');
    expect(result.content).toContain('{"error":"missing"}');
  });

  it('204 响应无内容', async () => {
    stubFetch(async () => res({ status: 204 }));
    const result = await tool.execute({ url: 'https://a.test' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('（无响应体）');
  });

  it('二进制类型只回显元信息', async () => {
    stubFetch(async () =>
      res({ headers: { 'content-type': 'image/png' }, body: new Uint8Array([1, 2, 3, 4]) }),
    );
    const result = await tool.execute({ url: 'https://a.test/logo.png' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('[二进制响应]');
    expect(result.content).toContain('image/png');
    expect(result.content).toContain('4 字节');
  });

  it('重定向后回显最终 URL', async () => {
    stubFetch(async () =>
      res({ redirected: true, url: 'https://final.test/page', headers: { 'content-type': 'text/plain' }, body: 'ok' }),
    );
    const result = await tool.execute({ url: 'https://a.test/old' }, ctx);
    expect(result.content).toContain('最终 URL: https://final.test/page');
  });

  it('内容超过 10000 字符被截断并提示', async () => {
    stubFetch(async () => res({ headers: { 'content-type': 'text/plain' }, body: 'a'.repeat(10_001) }));
    const result = await tool.execute({ url: 'https://a.test' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('a'.repeat(10_000));
    expect(result.content).not.toContain('a'.repeat(10_001));
    expect(result.content).toContain('[内容超过 10000 字符，已截断]');
  });

  it('响应体超过 5 MiB 时停止读取并提示', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    stubFetch(async () =>
      res({
        headers: { 'content-type': 'text/plain' },
        body: byteStream([chunk, chunk, chunk, chunk, chunk, chunk]),
      }),
    );
    const result = await tool.execute({ url: 'https://a.test' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('[响应体超过 5242880 字节，已截断]');
  });
});

describe('失败路径', () => {
  it('fetch 抛错返回 [network] 错误', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } });
    });
    const result = await tool.execute({ url: 'https://nonexistent.test' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('[network]');
    expect(result.error).toContain('ENOTFOUND');
  });

  it('超时中止返回 [timeout] 错误', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );
    const result = await tool.execute({ url: 'https://a.test', timeout_ms: 10 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('[timeout]');
    expect(result.error).toContain('10ms');
  });
});

describe('日志埋点', () => {
  it('发起与完成各记一条 info', async () => {
    const logger = new FakeLogger();
    stubFetch(async () => res({ headers: { 'content-type': 'text/plain' }, body: 'ok' }));
    await tool.execute({ url: 'https://a.test/path', format: 'text' }, { ...ctx, logger });

    const requestLog = logger.logs.find((l) => l.message === 'web_fetch 请求');
    expect(requestLog?.level).toBe('info');
    expect(requestLog?.context?.host).toBe('a.test');
    expect(requestLog?.context?.format).toBe('text');

    const responseLog = logger.logs.find((l) => l.message === 'web_fetch 响应');
    expect(responseLog?.context?.status).toBe(200);
    expect(responseLog?.context?.bytes).toBe(2);
    expect(typeof responseLog?.context?.durationMs).toBe('number');
  });

  it('失败记 warn', async () => {
    const logger = new FakeLogger();
    stubFetch(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    await tool.execute({ url: 'https://a.test' }, { ...ctx, logger });
    const warnLog = logger.logs.find((l) => l.level === 'warn');
    expect(warnLog?.message).toBe('web_fetch 失败');
  });
});
