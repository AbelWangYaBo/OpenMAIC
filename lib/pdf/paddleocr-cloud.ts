/**
 * Baidu Cloud document parsing (文档解析 PaddleOCR-VL).
 *
 * An asynchronous API: an access token (API Key + Secret Key exchanged at the
 * OAuth endpoint) authorizes a submit call that answers a `task_id`, a query
 * call polled until `status: "success"`, and two result URLs — the markdown
 * document and the structured parse result — served from Baidu's object
 * storage. The result URLs are response-supplied, so they are held to the
 * strict public policy with bounded reads, exactly like MinerU Cloud's
 * response-supplied URLs after GHSA-cpjc-vgjh-c5jp.
 */

import { extractPaddleCloudParseResult } from './paddleocr-parser';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import type { PDFParserConfig } from './types';
import { createLogger } from '@/lib/logger';
import { createHash } from 'node:crypto';

import {
  isRejectedRedirectError,
  providerFetch,
  resolveAllowLocalNetworks,
  type ProviderFetchPolicy,
} from '@/lib/server/provider-fetch';
import { validateUrlForSSRFWithPolicy } from '@/lib/server/ssrf-guard';

const log = createLogger('PaddleCloud');

export const PADDLE_CLOUD_DEFAULT_BASE = 'https://aip.baidubce.com';

const SUBMIT_PATH = '/rest/2.0/brain/online/v2/paddle-vl-parser/task';
const QUERY_PATH = '/rest/2.0/brain/online/v2/paddle-vl-parser/task/query';

/** The submit API is rate-limited to 2 QPS and the poll API to 5 QPS. */
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_MS = 15 * 60 * 1_000; // 15 minutes, matching MinerU Cloud
const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Baidu caps file_data at 50 MB; file_url is the documented route above that. */
export const MAX_FILE_DATA_BYTES = 50 * 1024 * 1024;
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_MARKDOWN_BYTES = 32 * 1024 * 1024;

/** The strict public policy: result URLs are response-supplied, never ours,
 * and HTTPS-only on every hop — the payloads carry the parsed document. */
const RESPONSE_URL_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: false,
  requireHttps: true,
};

/**
 * The API root is operator configuration when managed (it may sit on a
 * private gateway), otherwise it falls back to the env opt-in — the same
 * first-hop split the MinerU Cloud integration applies.
 */
function apiRootPolicy(managed: boolean | undefined): ProviderFetchPolicy {
  return managed
    ? { allowLocalNetworks: true, redirectAllowLocalNetworks: resolveAllowLocalNetworks() }
    : { allowLocalNetworks: undefined };
}

// ---------------------------------------------------------------------------
// Access token (API Key + Secret Key → short-lived token), cached per key.
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * The cache key hashes the full credential context — base URL plus both
 * credentials — so a rotated secret, or the same key id against a different
 * endpoint, can never reuse (or leak into) another origin's token. Only the
 * digest is stored, never the credentials themselves.
 */
function cacheKey(baseUrl: string, accessKeyId: string, accessKeySecret: string): string {
  return createHash('sha256')
    .update(`${baseUrl}\n${accessKeyId}\n${accessKeySecret}`)
    .digest('hex');
}

export function clearPaddleCloudTokenCache(): void {
  tokenCache.clear();
}

async function getAccessToken(
  baseUrl: string,
  accessKeyId: string,
  accessKeySecret: string,
  managed: boolean | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const key = cacheKey(baseUrl, accessKeyId, accessKeySecret);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const response = await providerFetch(
    `${baseUrl}/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(accessKeyId)}&client_secret=${encodeURIComponent(accessKeySecret)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal },
    apiRootPolicy(managed),
  );
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
  } | null;
  if (!response.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
    const detail = typeof body?.error_description === 'string' ? body.error_description : '';
    throw new Error(`PaddleOCR Cloud authentication failed${detail ? `: ${detail}` : ''}`);
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 2592000;
  tokenCache.set(key, {
    token: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return body.access_token;
}

// ---------------------------------------------------------------------------
// Submit → poll → download
// ---------------------------------------------------------------------------

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}

interface SubmitResponse {
  error_code?: number;
  error_msg?: string;
  result?: { task_id?: unknown };
}

interface QueryResponse {
  error_code?: number;
  error_msg?: string;
  result?: {
    status?: unknown;
    task_error?: unknown;
    markdown_url?: unknown;
    parse_result_url?: unknown;
  } | null;
}

/** Validate a response-supplied URL, then fetch it under the strict policy. */
async function downloadResponseUrl(
  rawUrl: unknown,
  label: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    throw new Error(`PaddleOCR Cloud result is missing ${label}`);
  }
  if (!rawUrl.startsWith('https://')) {
    throw new Error(`PaddleOCR Cloud ${label} is not HTTPS`);
  }
  const ssrfError = await validateUrlForSSRFWithPolicy(rawUrl, { allowLocalNetworks: false });
  if (ssrfError) {
    throw new Error(`PaddleOCR Cloud ${label} was refused by the address policy`);
  }
  const response = await providerFetch(
    rawUrl,
    { signal: requestSignal(DOWNLOAD_TIMEOUT_MS, signal) },
    RESPONSE_URL_POLICY,
  );
  if (!response.ok) {
    throw new Error(`PaddleOCR Cloud ${label} download failed (${response.status})`);
  }
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error(`PaddleOCR Cloud ${label} exceeds the ${maxBytes}-byte read limit`);
    }
    return new TextDecoder().decode(buf);
  }
  // Count the bytes as they arrive and cancel mid-stream: a result URL that
  // lies about (or omits) its length must not buffer without bound.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`PaddleOCR Cloud ${label} exceeds the ${maxBytes}-byte read limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

export async function parseWithPaddleCloud(
  config: PDFParserConfig,
  documentBuffer: Buffer,
  sourceFileName?: string,
): Promise<ParsedPdfContent> {
  // Under the opt-in, the pair can live in the environment (the same fallback
  // the parsePDF precheck honors); resolve it here so every caller sees the
  // resolved credentials.
  const accessKeyId =
    config.accessKeyId ||
    (config.allowEnvFallback ? process.env.PADDLEOCR_CLOUD_ACCESS_KEY_ID : undefined);
  const accessKeySecret =
    config.accessKeySecret ||
    (config.allowEnvFallback ? process.env.PADDLEOCR_CLOUD_ACCESS_KEY_SECRET : undefined);
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('PaddleOCR Cloud requires an API Key and Secret Key pair');
  }
  if (documentBuffer.byteLength > MAX_FILE_DATA_BYTES) {
    throw new Error(
      `Document exceeds the ${MAX_FILE_DATA_BYTES}-byte submit limit of PaddleOCR Cloud's file_data upload`,
    );
  }

  const baseUrl = (config.baseUrl || PADDLE_CLOUD_DEFAULT_BASE).replace(/\/+$/, '');
  const fileName = sourceFileName || 'document.pdf';
  const token = await getAccessToken(
    baseUrl,
    accessKeyId,
    accessKeySecret,
    config.managed,
    config.signal,
  );

  // Step 1: submit the document as base64 form data.
  const submitBody = new URLSearchParams({
    file_data: documentBuffer.toString('base64'),
    file_name: fileName,
  }).toString();

  log.info(`[PaddleCloud] Submitting ${fileName} (${documentBuffer.byteLength} bytes)`);

  const submitResponse = await providerFetch(
    `${baseUrl}${SUBMIT_PATH}?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: submitBody,
      signal: requestSignal(SUBMIT_TIMEOUT_MS, config.signal),
    },
    apiRootPolicy(config.managed),
  );
  const submitJson = (await submitResponse.json().catch(() => null)) as SubmitResponse | null;
  if (!submitResponse.ok || !submitJson || (submitJson.error_code ?? 0) !== 0) {
    const msg = submitJson?.error_msg || `HTTP ${submitResponse.status}`;
    throw new Error(`PaddleOCR Cloud submit failed: ${msg}`);
  }
  const taskId = submitJson.result?.task_id;
  if (typeof taskId !== 'string' || !taskId) {
    throw new Error('PaddleOCR Cloud submit returned no task_id');
  }

  // Step 2: poll the query endpoint (5-10s cadence per the API docs).
  const deadline = Date.now() + POLL_MAX_MS;
  let result: NonNullable<QueryResponse['result']> | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (config.signal?.aborted) {
        reject(config.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      config.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(config.signal!.reason ?? new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const queryResponse = await providerFetch(
      `${baseUrl}${QUERY_PATH}?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ task_id: taskId }).toString(),
        signal: requestSignal(POLL_TIMEOUT_MS, config.signal),
      },
      apiRootPolicy(config.managed),
    );
    const queryJson = (await queryResponse.json().catch(() => null)) as QueryResponse | null;
    if (!queryJson || (queryJson.error_code ?? 0) !== 0) {
      const code = queryJson?.error_code;
      // A missing task right after submission is transient; other codes are not.
      if (code === 282007) continue;
      throw new Error(`PaddleOCR Cloud query failed: ${queryJson?.error_msg || `code ${code}`}`);
    }
    const current = queryJson.result ?? null;
    if (!current) continue;
    if (typeof current.status === 'string' && current.status !== 'success') {
      if (current.status === 'failed') {
        const detail = typeof current.task_error === 'string' ? current.task_error : '';
        throw new Error(`PaddleOCR Cloud parsing failed${detail ? `: ${detail}` : ''}`);
      }
      continue; // still running
    }
    result = current;
    break;
  }

  if (!result) {
    throw new Error(`PaddleOCR Cloud timed out after ${POLL_MAX_MS / 1000}s (task: ${taskId})`);
  }

  // Step 3: download the response-supplied results under the strict policy.
  const markdown = await downloadResponseUrl(
    result.markdown_url,
    'markdown URL',
    MAX_MARKDOWN_BYTES,
    config.signal,
  );
  let parseResult: unknown = null;
  if (typeof result.parse_result_url === 'string' && result.parse_result_url) {
    try {
      parseResult = JSON.parse(
        await downloadResponseUrl(
          result.parse_result_url,
          'parse result URL',
          MAX_JSON_BYTES,
          config.signal,
        ),
      );
    } catch (error) {
      if (isRejectedRedirectError(error)) throw error;
      // The caller stopped waiting: that is not an enrichment failure, and
      // reporting markdown-only success would let canceled work continue.
      if (config.signal?.aborted) throw error;
      // A structured result is optional enrichment; the markdown is the product.
      log.warn('[PaddleCloud] parse result download/parse failed, serving markdown only:', error);
    }
  }

  return extractPaddleCloudParseResult(parseResult, markdown);
}
