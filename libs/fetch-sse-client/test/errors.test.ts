import { describe, it, expect } from 'vitest';
import { SSEClientError } from '@/errors';

describe('SSEClientError', () => {
  it('构造：type 与 message 落位，name 为 SSEClientError，是 Error 实例', () => {
    const err = new SSEClientError('network', 'boom');

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SSEClientError');
    expect(err.type).toBe('network');
    expect(err.message).toBe('boom');
    expect(err.status).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it('构造：携带 status 与 cause', () => {
    const cause = new Error('orig');
    const err = new SSEClientError('http', 'HTTP 404: not found', { status: 404, cause });

    expect(err.type).toBe('http');
    expect(err.status).toBe(404);
    expect(err.cause).toBe(cause);
  });

  it('覆盖四种错误分类', () => {
    expect(new SSEClientError('network', 'x').type).toBe('network');
    expect(new SSEClientError('timeout', 'x').type).toBe('timeout');
    expect(new SSEClientError('http', 'x').type).toBe('http');
    expect(new SSEClientError('parse', 'x').type).toBe('parse');
  });
});
