/**
 * Shared PaddleOCR result parsers.
 *
 * The self-hosted PaddleX serving and the Baidu Cloud document-parsing API
 * answer in different shapes but describe the same thing — per-page layout
 * results with markdown text and optional images — so both normalize here into
 * {@link ParsedPdfContent}.
 */

import type { ParsedPdfContent } from '@/lib/types/pdf';
import { createLogger } from '@/lib/logger';

const log = createLogger('PaddleOCRParser');

function toDataUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
}

/**
 * Assemble the shared result. Image metadata keeps both the provider's own
 * reference (`path` — the file name the markdown cites, which the owner
 * rewrite matches against) and the sequential `img_n` id it is replaced by.
 */
function buildResult(
  text: string,
  images: Array<{ path: string; src: string; pageNumber: number }>,
  pageCount: number,
  parser: 'paddleocr' | 'paddleocr-cloud',
): ParsedPdfContent {
  const imageMapping: Record<string, string> = {};
  const dataUrls: string[] = [];
  const pdfImages = images.map(({ path, src, pageNumber }, index) => {
    const id = `img_${index + 1}`;
    imageMapping[id] = src;
    dataUrls.push(src);
    return { id, src, pageNumber, path };
  });

  log.info(
    `[PaddleOCR] Parsed successfully (${parser}): ${images.length} images, ` +
      `${text.length} chars of markdown, ${pageCount} page(s)`,
  );

  return {
    text,
    images: dataUrls,
    metadata: {
      pageCount,
      parser,
      imageMapping,
      pdfImages,
    },
  };
}

/**
 * Self-hosted PaddleX serving (`POST /layout-parsing`): one entry per page
 * (or the single image), each carrying `markdown: { text, images }` where the
 * images dict maps the markdown's file references to base64 payloads. The
 * dict key IS the path the markdown cites, so it is preserved per image, and
 * the entry's position in the array is the page it belongs to.
 */
export function extractPaddleLayoutParsing(
  layoutParsingResults: unknown,
  parser: 'paddleocr' | 'paddleocr-cloud' = 'paddleocr',
): ParsedPdfContent {
  const results = Array.isArray(layoutParsingResults) ? layoutParsingResults : [];
  const textParts: string[] = [];
  const images: Array<{ path: string; src: string; pageNumber: number }> = [];

  results.forEach((entry, pageIndex) => {
    const markdown = (entry as Record<string, unknown>)?.markdown as
      | { text?: unknown; images?: unknown }
      | undefined;
    if (typeof markdown?.text === 'string') {
      textParts.push(markdown.text);
    }
    if (markdown?.images && typeof markdown.images === 'object') {
      for (const [path, value] of Object.entries(markdown.images as Record<string, unknown>)) {
        const src = toDataUrl(value);
        if (src) images.push({ path, src, pageNumber: pageIndex + 1 });
      }
    }
  });

  return buildResult(textParts.join('\n\n'), images, results.length, parser);
}

/**
 * Baidu Cloud document parsing: `parse_result_url` serves a JSON document
 * whose `pages` array carries per-page plain text, layout entries, tables and
 * images. The markdown itself arrives separately (`markdown_url`).
 */
export function extractPaddleCloudParseResult(
  parseResult: unknown,
  markdown: string,
): ParsedPdfContent {
  const pages = (parseResult as { pages?: unknown })?.pages;
  const pageList = Array.isArray(pages) ? (pages as Record<string, unknown>[]) : [];
  const images: Array<{ path: string; src: string; pageNumber: number }> = [];

  pageList.forEach((page, index) => {
    const pageImages = Array.isArray(page.images) ? page.images : [];
    for (const image of pageImages as Record<string, unknown>[]) {
      const src = toDataUrl(image.data_url);
      if (src)
        images.push({
          path: String(image.layout_id ?? `p${index + 1}-img`),
          src,
          pageNumber: index + 1,
        });
    }
  });

  return buildResult(markdown, images, pageList.length, 'paddleocr-cloud');
}
