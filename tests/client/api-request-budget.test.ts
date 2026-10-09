import { describe, expect, it } from 'vitest';
import { budgetForRequest, readWithBudget } from '../../src/core/api/retry-fetch';
import { ApiError, PrismApiClient } from '../../src/core/api/client';

describe('网络请求超时与预算分配（AC-OPT-02）', () => {
  it('不同端点路径分配匹配的请求预算', () => {
    expect(budgetForRequest('/api/channels', 'GET')).toBe(8000);
    expect(budgetForRequest('/api/version', 'GET')).toBe(8000);
    expect(budgetForRequest('/api/search/discoveries', 'GET')).toBe(8000);
    expect(budgetForRequest('/api/search/suggestions?q=a', 'GET')).toBe(12000);
    expect(budgetForRequest('/api/titles/drama_1/related', 'GET')).toBe(12000);
    expect(budgetForRequest('/api/search?q=test', 'GET')).toBe(35000);
    expect(budgetForRequest('/assets/catalog-bundle.json', 'GET')).toBe(60000);
    expect(budgetForRequest('/api/redeem', 'POST')).toBe(15000);
    expect(budgetForRequest('/api/private-sessions', 'POST')).toBe(15000);
    expect(budgetForRequest('/api/private-sessions', 'DELETE')).toBe(15000);
  });

  it('普通请求超时按限时触发 TimeoutError 并收敛为 NETWORK_ERROR', async () => {
    const hangFetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('请求已被中止', 'AbortError'));
        });
      });

    await expect(readWithBudget(hangFetch, 'https://test.local/api/channels', {}, 50)).rejects.toThrow();

    const client = new PrismApiClient({
      baseUrl: 'https://test.local',
      fetchImpl: hangFetch
    });

    await expect(client.channels()).rejects.toThrow(ApiError);
  });

  it('调用方主动中止时优先抛出调用方原因，不吞掉取消信号', async () => {
    const controller = new AbortController();
    controller.abort('caller cancelled');

    const hangFetch = (_url: string, _init?: RequestInit): Promise<Response> =>
      new Promise(() => {});

    await expect(readWithBudget(hangFetch, 'https://test.local/api/channels', { signal: controller.signal }, 5000)).rejects.toBe('caller cancelled');
  });

  it('长时间搜索在预算内成功返回，不被短超时误伤', async () => {
    const delayedFetch = async (): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return new Response(JSON.stringify({ items: [], page: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const client = new PrismApiClient({
      baseUrl: 'https://test.local',
      fetchImpl: delayedFetch
    });

    const result = await client.search({ q: 'long search' });
    expect(result.items).toEqual([]);
  });
});
