/**
 * A workbench video that completed through the asset pool must actually render.
 *
 * The storage half of #1522 can be entirely correct — bytes in the pool, a
 * `document_asset_refs` row, a committed entry, quota accounted — and the
 * video still be invisible, because what renders it is a different chain
 * altogether: `getVideoMediaRefForElement` reads `mediaRef` before `src`,
 * `resolveVideoMediaForElement` derives `sourceRef` from that, and
 * `poolLeasableSlideRefs` leases only `sourceRef`. A completion patch that
 * wrote the allocated id into `src` and left `mediaRef` on `gen_vid_…` would
 * leave the pool never asked about the id at all, and no storage test would
 * notice.
 *
 * So this file runs the REAL completion patch and feeds its output to the REAL
 * resolvers, in the two states a viewer can be in: the live pane, and a reload
 * where the document holds the ids and no task exists in memory.
 */
import { describe, expect, it } from 'vitest';
import type { PPTVideoElement, Slide } from '@openmaic/dsl';

import { patchStageVideoPlaceholder } from '@/lib/server/agent-runtime/generate-video';
import { collectUnresolvedMediaPlaceholders } from '@/lib/server/agent-runtime/generation-tools';
import { poolLeasableSlideRefs } from '@/components/slide-renderer/use-resolved-slide';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import { resolveVideoMediaForElement } from '@/lib/media/media-task-resolution';
import {
  MISSING_ASSET_LEASE,
  renderableMediaUrl,
  resolveMediaRef,
} from '@/lib/media/resolve-media-ref';
import type { AssetUrlLeaseState } from '@/lib/media/use-asset-url';
import type { AppScene, Scene } from '@/lib/types/stage';

import { createFakeDocumentStore } from '../agent-runtime/_fake-document-store';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const STAGE = 'stage-owner';
const REF = 'gen_vid_1';
const VIDEO_ID = 'ast_video_1';
const POSTER_ID = 'ast_poster_1';
const pooled = { status: 'resolved', url: 'blob:pool-video' } satisfies AssetUrlLeaseState;

/** Run the real completion patch over one element and return what it persisted. */
async function completeJobOn(element: Record<string, unknown>): Promise<PPTVideoElement> {
  const fake = createFakeDocumentStore();
  const scene = makeSlideScene('scene-1', STAGE, 1) as AppScene;
  (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push(element);
  fake.docs.set(STAGE, makeDocument(STAGE, 'Course', [scene]));

  const patched = await patchStageVideoPlaceholder(fake.store, STAGE, REF, {
    src: VIDEO_ID,
    poster: POSTER_ID,
  });
  expect(patched).toBe(1);

  const persisted = await fake.store.getScene(STAGE, 'scene-1');
  return (persisted!.content as { canvas: { elements: PPTVideoElement[] } }).canvas.elements[0]!;
}

function slideOf(element: PPTVideoElement): Slide {
  return {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements: [element],
  } as unknown as Slide;
}

describe('a completed workbench video resolves through the real chain', () => {
  // This is the shape the tool itself instructs the model to write:
  // "patch_stage set mediaRef (or src) of an existing element".
  it('leases the allocated id for the documented mediaRef binding', async () => {
    const element = await completeJobOn({ id: 'el-video', type: 'video', mediaRef: REF });

    // Every step of the chain, in the order the renderer walks it.
    expect(getVideoMediaRefForElement(element)).toBe(VIDEO_ID);
    const binding = resolveVideoMediaForElement({}, element, STAGE);
    expect(binding.sourceRef).toBe(VIDEO_ID);
    expect(binding.posterRef).toBe(POSTER_ID);
    // The pool is asked about the video and its poster -- the fact that makes
    // the bytes reachable at all.
    expect(poolLeasableSlideRefs(slideOf(element), STAGE, {})).toEqual([VIDEO_ID, POSTER_ID]);
  });

  it('leases the allocated id when the placeholder lived in src', async () => {
    const element = await completeJobOn({ id: 'el-video', type: 'video', src: REF });

    expect(resolveVideoMediaForElement({}, element, STAGE).sourceRef).toBe(VIDEO_ID);
    expect(poolLeasableSlideRefs(slideOf(element), STAGE, {})).toEqual([VIDEO_ID, POSTER_ID]);
  });

  // The reload path: the document holds the ids and nothing is in memory.
  it('renders after a reload, with no task in the media store', async () => {
    const element = await completeJobOn({ id: 'el-video', type: 'video', mediaRef: REF });
    const binding = resolveVideoMediaForElement({}, element, STAGE);
    expect(binding.task).toBeUndefined();

    const resolution = resolveMediaRef(binding.sourceRef, undefined, pooled);
    expect(resolution).toEqual({ kind: 'url', url: 'blob:pool-video' });
    expect(renderableMediaUrl(resolution)).toBe('blob:pool-video');
  });

  it('stops reporting the patched element as an unrendered placeholder', async () => {
    const fake = createFakeDocumentStore();
    const scene = makeSlideScene('scene-1', STAGE, 1) as AppScene;
    (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
      id: 'el-video',
      type: 'video',
      mediaRef: REF,
    });
    fake.docs.set(STAGE, makeDocument(STAGE, 'Course', [scene]));
    expect(
      collectUnresolvedMediaPlaceholders((await fake.store.getScene(STAGE, 'scene-1')) as Scene),
    ).toHaveLength(1);

    await patchStageVideoPlaceholder(fake.store, STAGE, REF, { src: VIDEO_ID, poster: POSTER_ID });

    expect(
      collectUnresolvedMediaPlaceholders((await fake.store.getScene(STAGE, 'scene-1')) as Scene),
    ).toEqual([]);
  });

  // The bug this file exists for, pinned so it cannot come back quietly: a
  // patch that writes only `src` leaves the pool unasked and the element
  // unrenderable, in both states.
  it('would lease nothing if the completion patch left mediaRef on the placeholder', () => {
    const stale = {
      id: 'el-video',
      type: 'video',
      mediaRef: REF,
      src: VIDEO_ID,
    } as unknown as PPTVideoElement;

    expect(resolveVideoMediaForElement({}, stale, STAGE).sourceRef).toBe(REF);
    expect(poolLeasableSlideRefs(slideOf(stale), STAGE, {})).toEqual([]);
    expect(
      renderableMediaUrl(resolveMediaRef(REF, undefined, MISSING_ASSET_LEASE)),
    ).toBeUndefined();
  });
});
