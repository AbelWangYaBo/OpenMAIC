import type { ElementReference } from '@/lib/types/chat';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import { freezeEvidence } from './observation';
import type { ObservationSnapshot } from './observation-bridge';

export interface InteractiveStateEvidence {
  sourceHtmlHash: string;
  snapshot: ObservationSnapshot;
}

/** One awaited send-time sample. No snapshot cache or business-specific collection. */
export async function sampleInteractiveReference(
  reference: ElementReference | undefined,
  storeState: { currentSceneId: string | null; scenes: unknown[] },
  signal: AbortSignal,
): Promise<InteractiveStateEvidence | undefined> {
  if (reference?.kind !== 'interactive_component') return undefined;
  const scene = storeState.scenes.find(
    (value): value is { id: string; content: unknown } =>
      !!value &&
      typeof value === 'object' &&
      'id' in value &&
      value.id === reference.sceneId &&
      'content' in value,
  );
  const content = scene?.content;
  if (
    !content ||
    typeof content !== 'object' ||
    !('html' in content) ||
    typeof content.html !== 'string'
  )
    return undefined;
  const sourceHtml = content.html;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceHtml));
  const sourceHtmlHash = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const unavailable = (reason: 'no-interface' | 'document-changed'): ObservationSnapshot => ({
    source: 'browser-reported',
    identity: {
      sceneId: reference.sceneId,
      scopeId: reference.selector.slice(1),
      documentId: 'unavailable',
    },
    requestedAt: Date.now(),
    receivedAt: Date.now(),
    status: 'unavailable',
    reason,
  });
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  let snapshot: ObservationSnapshot;
  if (reference.selector !== '#experiment' || !sourceHtml.includes('data-maic-observation'))
    snapshot = unavailable('no-interface');
  else if (storeState.currentSceneId !== reference.sceneId)
    snapshot = unavailable('document-changed');
  else {
    const capture = useWidgetIframeStore.getState().captureByScene[reference.sceneId];
    snapshot = (await capture?.(sourceHtml, signal)) ?? unavailable('document-changed');
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return freezeEvidence({ sourceHtmlHash, snapshot });
}
