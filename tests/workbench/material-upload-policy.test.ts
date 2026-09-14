import { describe, expect, it } from 'vitest';

import {
  isWorkbenchMaterialMime,
  resolveWorkbenchMaterialMime,
} from '@/lib/workbench/material-upload-policy';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('resolveWorkbenchMaterialMime', () => {
  it('keeps specific MIME types verbatim after alias normalization', () => {
    expect(resolveWorkbenchMaterialMime({ mimeType: 'application/pdf', fileName: 'a.pdf' })).toBe(
      'application/pdf',
    );
    expect(resolveWorkbenchMaterialMime({ mimeType: 'audio/x-m4a', fileName: 'clip.m4a' })).toBe(
      'audio/mp4',
    );
  });

  it('resolves a missing or generic MIME from the filename extension', () => {
    // Older Linux XDG mime databases report every OOXML file as the generic
    // Office container (#1497); empty, octet-stream, and zip-family types
    // need the same fallback the document path already grants them.
    expect(
      resolveWorkbenchMaterialMime({
        mimeType: 'application/vnd.ms-office',
        fileName: 'slides.pptx',
      }),
    ).toBe(PPTX_MIME);
    expect(resolveWorkbenchMaterialMime({ mimeType: '', fileName: '讲义.pdf' })).toBe(
      'application/pdf',
    );
    expect(
      resolveWorkbenchMaterialMime({ mimeType: 'application/octet-stream', fileName: 'notes.md' }),
    ).toBe('text/markdown');
    expect(
      resolveWorkbenchMaterialMime({ mimeType: 'application/zip', fileName: 'book.xlsx' }),
    ).toBe(XLSX_MIME);
  });

  it('does not let a specific unknown MIME masquerade as a supported extension', () => {
    const resolved = resolveWorkbenchMaterialMime({
      mimeType: 'application/x-unknown',
      fileName: 'lesson.pdf',
    });
    expect(resolved).toBe('application/x-unknown');
    expect(isWorkbenchMaterialMime(resolved)).toBe(false);
  });

  it('keeps the generic MIME when the extension is not an accepted material', () => {
    const resolved = resolveWorkbenchMaterialMime({
      mimeType: 'application/vnd.ms-office',
      fileName: 'blob.bin',
    });
    expect(resolved).toBe('application/vnd.ms-office');
    expect(isWorkbenchMaterialMime(resolved)).toBe(false);
  });
});
