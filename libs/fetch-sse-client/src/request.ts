/**
 * 请求组装（纯函数，无副作用）
 *
 * 职责：URL/params 拼接、headers 求值（支持函数形式）、body 序列化。
 * 每次调用独立求值 headers，重连场景支持动态刷新 token。
 */

import type { SSEClientOptions } from './types.js';

/** prepareRequest 的输入：SSEClientOptions 中与请求组装相关的字段 */
export type RequestOptions = Pick<
  SSEClientOptions,
  'url' | 'method' | 'headers' | 'body' | 'params'
>;

/** 组装完成的请求：fetch 可直接消费 */
export interface PreparedRequest {
  url: string;
  init: RequestInit;
}

/**
 * 组装 SSE 请求。
 * - URL 拼接 params（undefined 值忽略）
 * - headers：函数形式调用求值，对象形式浅拷贝
 * - body：BodyInit 原样透传；普通对象 → JSON 序列化并补默认 Content-Type
 */
export function prepareRequest(options: RequestOptions): PreparedRequest {
  const { url, method = 'GET', headers = {}, body, params } = options;

  const urlObj = new URL(url);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) urlObj.searchParams.set(key, String(value));
    }
  }

  const resolvedHeaders: Record<string, string> =
    typeof headers === 'function' ? headers() : { ...headers };

  let requestBody: BodyInit | undefined;
  if (body !== undefined) {
    if (
      typeof body === 'string' ||
      body instanceof FormData ||
      body instanceof URLSearchParams ||
      body instanceof Blob ||
      body instanceof ArrayBuffer ||
      body instanceof Uint8Array
    ) {
      requestBody = body as BodyInit;
    } else {
      // 普通对象 → JSON 序列化，并补默认 Content-Type
      requestBody = JSON.stringify(body);
      if (!resolvedHeaders['Content-Type']) {
        resolvedHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  return {
    url: urlObj.toString(),
    init: { method, headers: resolvedHeaders, body: requestBody },
  };
}
