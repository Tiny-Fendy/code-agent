import { describe, it, expect, vi } from 'vitest';
import { prepareRequest } from '@/request';

describe('prepareRequest', () => {
  it('默认 GET 方法，params 序列化（undefined 忽略，number/boolean 转字符串）', () => {
    const { url, init } = prepareRequest({
      url: 'http://test/s',
      params: { a: 1, b: 'x', c: true, d: undefined },
    });

    expect(init.method).toBe('GET');
    const u = new URL(url);
    expect(u.searchParams.get('a')).toBe('1');
    expect(u.searchParams.get('b')).toBe('x');
    expect(u.searchParams.get('c')).toBe('true');
    expect(u.searchParams.has('d')).toBe(false);
  });

  it('body 普通对象自动 JSON 序列化并补 Content-Type', () => {
    const { init } = prepareRequest({
      url: 'http://test/s',
      body: { q: 'hi' },
    });

    expect(init.body).toBe(JSON.stringify({ q: 'hi' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('body 已有 Content-Type 时不覆盖', () => {
    const { init } = prepareRequest({
      url: 'http://test/s',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: { q: 'hi' },
    });

    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('body 为字符串时原样透传，不补 Content-Type', () => {
    const { init } = prepareRequest({
      url: 'http://test/s',
      body: 'raw-text',
    });

    expect(init.body).toBe('raw-text');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('headers 函数形式调用求值（每次调用独立求值）', () => {
    const headersFn = vi.fn(() => ({ Authorization: 'Bearer dyn' }));
    const { init } = prepareRequest({
      url: 'http://test/s',
      headers: headersFn,
    });

    expect(headersFn).toHaveBeenCalledTimes(1);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer dyn');
  });

  it('headers 对象形式浅拷贝，不修改原对象', () => {
    const original = { 'X-Custom': '1' };
    const { init } = prepareRequest({
      url: 'http://test/s',
      headers: original,
    });

    expect(init.headers).not.toBe(original);
    expect((init.headers as Record<string, string>)['X-Custom']).toBe('1');
  });

  it('无 body 时 init.body 为 undefined', () => {
    const { init } = prepareRequest({ url: 'http://test/s' });
    expect(init.body).toBeUndefined();
  });

  it('自定义 method 透传', () => {
    const { init } = prepareRequest({ url: 'http://test/s', method: 'POST' });
    expect(init.method).toBe('POST');
  });
});
