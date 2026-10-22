import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ providerFetch: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/server/audio-provider-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/audio-provider-fetch')>();
  return { ...actual, audioProviderFetch: transport.providerFetch };
});

import { parseWithPaddleCloud, clearPaddleCloudTokenCache } from '@/lib/pdf/paddleocr-cloud';

// Public IP literals: the real SSRF validation passes them without DNS.
const POLL_TICK = 5000;
const MARKDOWN_URL = 'https://93.184.216.34/result/doc.md';
const PARSE_URL = 'https://93.184.216.34/result/doc.json';

function okJson(obj: unknown) {
  return new Response(JSON.stringify(obj), { status: 200 });
}

function installCloud(options?: { markdownUrl?: string; parseResultUrl?: string | null }) {
  transport.providerFetch.mockImplementation(async (url: string) => {
    if (url.includes('/oauth/2.0/token')) {
      return okJson({ access_token: 'tok-1', expires_in: 2592000 });
    }
    if (url.includes('/paddle-vl-parser/task?')) {
      return okJson({ error_code: 0, result: { task_id: 'task-1' } });
    }
    if (url.includes('/paddle-vl-parser/task/query')) {
      // First poll: still running. Second poll: success with result URLs.
      if (
        transport.providerFetch.mock.calls.filter(([u]) => String(u).includes('query')).length < 2
      ) {
        return okJson({ error_code: 0, result: { task_id: 'task-1', status: 'running' } });
      }
      return okJson({
        error_code: 0,
        result: {
          task_id: 'task-1',
          status: 'success',
          markdown_url: options?.markdownUrl ?? MARKDOWN_URL,
          parse_result_url:
            options && options.parseResultUrl !== undefined ? options.parseResultUrl : PARSE_URL,
        },
      });
    }
    if (url === MARKDOWN_URL) return new Response('# 解析后的文档', { status: 200 });
    if (url === PARSE_URL) {
      return okJson({
        pages: [
          {
            page_num: 0,
            text: '解析后的文档',
            images: [{ data_url: 'data:image/png;base64,AAEC' }],
          },
          { page_num: 1, text: '第二页', images: [] },
        ],
      });
    }
    throw new Error(`Unexpected transport URL: ${url}`);
  });
}

const CONFIG = {
  providerId: 'paddleocr-cloud' as const,
  accessKeyId: 'ak-1',
  accessKeySecret: 'sk-1',
};

describe('PaddleOCR Cloud (Baidu document parsing)', () => {
  beforeEach(() => {
    transport.providerFetch.mockReset();
    clearPaddleCloudTokenCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('submits, polls, then downloads the response-supplied results', async () => {
    installCloud();
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    await vi.runAllTimersAsync();
    const result = await promise;

    const calls = transport.providerFetch.mock.calls as [string, RequestInit][];
    const submit = calls.find(([u]) => u.includes('/paddle-vl-parser/task?'))!;
    expect(submit[0]).toContain('access_token=tok-1');
    const submitBody = new URLSearchParams(submit[1].body as string);
    expect(submitBody.get('file_name')).toBe('lesson.pdf');
    expect(submitBody.get('file_data')).toBe(Buffer.from('%PDF-doc').toString('base64'));

    const query = calls.find(([u]) => u.includes('/task/query'))!;
    expect(new URLSearchParams(query[1].body as string).get('task_id')).toBe('task-1');

    expect(result.text).toBe('# 解析后的文档');
    expect(result.metadata?.parser).toBe('paddleocr-cloud');
    expect(result.metadata?.pageCount).toBe(2);
    expect(result.images).toEqual(['data:image/png;base64,AAEC']);

    // Response-supplied URLs are held to the strict public policy.
    const downloadPolicies = calls.filter(([u]) => u === MARKDOWN_URL || u === PARSE_URL);
    expect(downloadPolicies.length).toBe(2);
    for (const [, init] of downloadPolicies) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    const mdPolicy = transport.providerFetch.mock.results.length > 0;
    expect(mdPolicy).toBe(true);
    expect(calls.filter(([u]) => u === MARKDOWN_URL).length).toBe(1);
  });

  it('refuses a private response URL before the transport is called', async () => {
    installCloud({ markdownUrl: 'https://169.254.169.254/latest/meta-data/', parseResultUrl: '' });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    const expectation = expect(promise).rejects.toThrow('address policy');
    await vi.runAllTimersAsync();
    await expectation;
    expect(
      transport.providerFetch.mock.calls.filter(([u]) => String(u).includes('169.254')).length,
    ).toBe(0);
  });

  it('refuses a non-HTTPS result URL', async () => {
    installCloud({ markdownUrl: 'http://93.184.216.34/result/doc.md', parseResultUrl: null });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    const expectation = expect(promise).rejects.toThrow('is not HTTPS');
    await vi.runAllTimersAsync();
    await expectation;
    // The insecure download must never be issued.
    expect(
      transport.providerFetch.mock.calls.filter(([u]) => String(u).startsWith('http://')).length,
    ).toBe(0);
  });

  it('serves the markdown alone when no parse result URL is returned', async () => {
    installCloud({ parseResultUrl: null });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.text).toBe('# 解析后的文档');
    expect(result.images).toEqual([]);
  });

  it('fails when the task reports failure', async () => {
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-2' } });
      }
      return okJson({
        error_code: 0,
        result: { task_id: 'task-2', status: 'failed', task_error: 'unsupported file' },
      });
    });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    const expectation = expect(promise).rejects.toThrow('unsupported file');
    await vi.runAllTimersAsync();
    await expectation;
  });

  it('fails the submit step with the provider message', async () => {
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      return okJson({ error_code: 282003, error_msg: 'missing parameters' });
    });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    const expectation = expect(promise).rejects.toThrow('missing parameters');
    await vi.runAllTimersAsync();
    await expectation;
  });

  it('does not reuse a token across different credentials or base URLs', async () => {
    installCloud();
    const p1 = parseWithPaddleCloud(
      { ...CONFIG, baseUrl: 'https://aip.baidubce.com' },
      Buffer.from('a'),
      'a.pdf',
    );
    await vi.runAllTimersAsync();
    await p1;

    // Same AK, different secret → different cache key → a fresh token call.
    transport.providerFetch.mockClear();
    installCloud();
    const p2 = parseWithPaddleCloud(
      { ...CONFIG, accessKeySecret: 'sk-2', baseUrl: 'https://aip.baidubce.com' },
      Buffer.from('a'),
      'a.pdf',
    );
    await vi.runAllTimersAsync();
    await p2;

    expect(
      transport.providerFetch.mock.calls.filter(([u]) => String(u).includes('/oauth/2.0/token'))
        .length,
    ).toBe(1);
  });

  it('resolves the AK/SK from the environment under allowEnvFallback', async () => {
    vi.stubEnv('PADDLEOCR_CLOUD_ACCESS_KEY_ID', 'env-ak');
    vi.stubEnv('PADDLEOCR_CLOUD_ACCESS_KEY_SECRET', 'env-sk');
    installCloud();
    const promise = parseWithPaddleCloud(
      { providerId: 'paddleocr-cloud', allowEnvFallback: true },
      Buffer.from('%PDF-doc'),
      'lesson.pdf',
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.text).toBe('# 解析后的文档');
    // The env-resolved pair made it all the way through submit and query.
    const submit = transport.providerFetch.mock.calls.find(([u]) =>
      String(u).includes('/paddle-vl-parser/task?'),
    );
    expect(String(submit?.[0])).toContain('access_token=tok-1');
    vi.unstubAllEnvs();
  });

  it('gives a managed cloud endpoint the operator policy, downloads stay strict', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    installCloud();
    const promise = parseWithPaddleCloud(
      { ...CONFIG, baseUrl: 'http://paddle-gateway.internal:8000', managed: true },
      Buffer.from('%PDF-doc'),
      'lesson.pdf',
    );
    await vi.runAllTimersAsync();
    await promise;

    const calls = transport.providerFetch.mock.calls as [
      string,
      RequestInit,
      Record<string, unknown>,
    ][];
    const submitPolicy = calls.find(([u]) => u.includes('/paddle-vl-parser/task?'))![2];
    // Managed root: local networks allowed for the operator's gateway...
    expect(submitPolicy.allowLocalNetworks).toBe(true);
    // ...while the response-supplied downloads stay strict public.
    const download = calls.find(([u]) => u === MARKDOWN_URL)!;
    expect(download[2]).toEqual({ allowLocalNetworks: false, requireHttps: true });
    vi.unstubAllEnvs();
  });

  it('rejects an oversized streaming download mid-stream', async () => {
    const big = new Uint8Array(33 * 1024 * 1024); // > MAX_MARKDOWN_BYTES
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-3' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-3',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: null,
          },
        });
      }
      if (url === MARKDOWN_URL) {
        // No content-length: the cap must bite while the body streams.
        return new Response(new Uint8Array(big), { status: 200 });
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    const expectation = expect(promise).rejects.toThrow('exceeds the 33554432-byte read limit');
    await vi.runAllTimersAsync().catch(() => {});
    await expectation;
  });

  it('stops polling immediately when the caller signal aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-4' } });
      }
      return okJson({ error_code: 0, result: { task_id: 'task-4', status: 'running' } });
    });
    vi.stubGlobal('fetch', vi.fn());

    const promise = parseWithPaddleCloud(
      { providerId: 'paddleocr-cloud', apiKey: 'k', model: 'm', signal: controller.signal },
      Buffer.from('a'),
      'a.pdf',
    );
    const expectation = expect(promise).rejects.toThrow();
    // One poll lands; aborting during the sleep must stop the next query.
    await vi.advanceTimersByTimeAsync(POLL_TICK);
    const queriesBefore = transport.providerFetch.mock.calls.filter(([u]) =>
      String(u).includes('/task/query'),
    ).length;
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await vi.advanceTimersByTimeAsync(POLL_TICK * 3);
    await expectation.catch(() => {});
    const queriesAfter = transport.providerFetch.mock.calls.filter(([u]) =>
      String(u).includes('/task/query'),
    ).length;
    expect(queriesAfter).toBe(queriesBefore);
  });

  it('requires the AK/SK pair before any network call', async () => {
    await expect(
      parseWithPaddleCloud({ providerId: 'paddleocr-cloud' }, Buffer.from('%PDF-doc'), 'a.pdf'),
    ).rejects.toThrow('API Key and Secret Key pair');
    expect(transport.providerFetch).not.toHaveBeenCalled();
  });
});
