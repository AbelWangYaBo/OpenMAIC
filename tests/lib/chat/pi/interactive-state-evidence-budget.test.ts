import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INTERACTIVE_PACKET_LIMIT,
  codePointLength,
  type ResolvedInteractiveComponentReference,
} from '@/lib/chat/pi/element-reference';
import { attachInteractiveState } from '@/lib/chat/pi/interactive-state-evidence';

/** Mirrors the module's own budget: the static packet bound plus the note frame. */
const NOTE_FRAME_BUDGET = 8_000;
const COMBINED_EVIDENCE_LIMIT = INTERACTIVE_PACKET_LIMIT + NOTE_FRAME_BUDGET;

const html =
  '<main id="experiment"><input id="density" value="1000">' +
  '<script type="application/json" data-maic-observation>{}</script></main>';

function makeBody(observationGraph: unknown) {
  const graph = observationGraph as Record<string, unknown>;
  const now = Date.now();
  return {
    storeState: {
      currentSceneId: 'scene-1',
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          title: 'Activity',
          order: 0,
          type: 'interactive',
          content: { type: 'interactive', widgetType: 'simulation', html },
        },
      ],
    },
    interactiveState: {
      sourceHtmlHash: createHash('sha256').update(html).digest('hex'),
      snapshot: {
        source: 'browser-reported',
        identity: { sceneId: 'scene-1', scopeId: 'experiment', documentId: 'doc-1' },
        requestedAt: now,
        receivedAt: now,
        status: 'available',
        observation: {
          version: 1,
          scope: { id: 'experiment', label: 'Interactive area' },
          current: { revision: 1, updatedAt: now, graph },
          rendered: { status: 'known', basedOnRevision: 0, renderedAt: now, graph },
        },
      },
    },
  };
}

/** A component reference sitting exactly on the upstream static bound. */
function maximalReference(): ResolvedInteractiveComponentReference {
  const directorSummary = 'Selected Interactive component reference: ' + 'd'.repeat(2_000);
  const childEvidence = 'c'.repeat(INTERACTIVE_PACKET_LIMIT);
  return {
    reference: { kind: 'interactive_component', sceneId: 'scene-1', selector: '#density' },
    evidence: { selector: '#density', component: {}, truncatedFields: [], omittedItems: [] },
    directorSummary,
    childEvidence,
  } as unknown as ResolvedInteractiveComponentReference;
}

const smallGraph = {
  objects: [{ id: 'liquid', label: 'Liquid', facts: [] }],
  relations: { status: 'complete', items: [] },
  missing: [] as string[],
};

/** Legal content: `<` is allowed in labels and values, and escaping expands it sixfold. */
const oversizedGraph = {
  objects: Array.from({ length: 18 }, (_, i) => ({
    id: `object-${i}`,
    label: '<'.repeat(240),
    facts: [{ key: 'k', label: 'K', status: 'known', value: '<'.repeat(300) }],
  })),
  relations: {
    status: 'complete',
    items: [{ from: 'object-0', to: 'object-1', kind: 'link', label: 'A to B' }],
  },
  missing: [] as string[],
};

describe('interactive state evidence output budget', () => {
  const flag = 'NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED';
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[flag];
    process.env[flag] = 'true';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[flag];
    else process.env[flag] = original;
  });

  it('keeps the fixed note frame inside the room reserved for it', () => {
    // With no packet at all the note carries only its frame and a short body.
    // If a future prompt edit outgrows this, the degradation below stops
    // converging, so the budget has to fail here rather than silently.
    const { stateNote } = attachInteractiveState(
      { storeState: makeBody(smallGraph).storeState, interactiveState: undefined } as never,
      undefined,
    );
    expect(stateNote).toBeDefined();
    expect(codePointLength(stateNote as string)).toBeLessThanOrEqual(NOTE_FRAME_BUDGET);
  });

  it.each([
    ['an ordinary packet', smallGraph],
    ['a packet that escapes past the budget', oversizedGraph],
  ])('holds every exit inside the budget for %s', (_name, graph) => {
    const referencedResult = attachInteractiveState(makeBody(graph) as never, maximalReference());
    const attached = referencedResult.elementReference as ResolvedInteractiveComponentReference;
    expect(codePointLength(attached.childEvidence)).toBeLessThanOrEqual(COMBINED_EVIDENCE_LIMIT);
    expect(codePointLength(attached.directorSummary)).toBeLessThanOrEqual(COMBINED_EVIDENCE_LIMIT);

    const unreferencedResult = attachInteractiveState(makeBody(graph) as never, undefined);
    expect(codePointLength(unreferencedResult.stateNote as string)).toBeLessThanOrEqual(
      COMBINED_EVIDENCE_LIMIT,
    );
  });

  it('degrades structurally instead of truncating the packet', () => {
    const { stateNote } = attachInteractiveState(makeBody(oversizedGraph) as never, undefined);
    const note = stateNote as string;
    const body = note.slice(
      note.indexOf('<page_reported_state>') + '<page_reported_state>\n'.length,
      note.indexOf('</page_reported_state>') - 1,
    );
    // Still valid JSON, not a cut fragment, and it no longer claims a complete set.
    expect(JSON.parse(body)).toEqual({ status: 'unavailable', reason: 'too-large' });
    expect(note).toContain('Current relationship evidence is unavailable');
    expect(note).not.toContain('Current relationship evidence is COMPLETE');
  });
});
