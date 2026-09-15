import { it, expect, afterEach } from 'vitest';
import { sampleInteractiveReference } from '@/lib/interactive/chat-observation';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
const source = '<main id="experiment"><script data-maic-observation></script></main>';
const reference = { kind: 'interactive_component' as const, sceneId: 's', selector: '#experiment' };
const store = { currentSceneId: 's', scenes: [{ id: 's', content: { html: source } }] };
afterEach(() => useWidgetIframeStore.setState({ captureByScene: {} }));
it('captures only at send and freezes detached request evidence', async () => {
  let calls = 0;
  useWidgetIframeStore.getState().registerObservation('s', async (html) => {
    expect(html).toBe(source);
    calls++;
    return {
      source: 'browser-reported',
      identity: { sceneId: 's', scopeId: 'experiment', documentId: 'd' },
      requestedAt: 1,
      receivedAt: 2,
      status: 'unavailable',
      reason: 'not-ready',
    };
  });
  expect(calls).toBe(0);
  const packet = await sampleInteractiveReference(reference, store, new AbortController().signal);
  expect(calls).toBe(1);
  expect(packet?.sourceHtmlHash).toHaveLength(64);
  expect(Object.isFrozen(packet?.snapshot)).toBe(true);
});
it('old content without an interface explicitly remains unavailable', async () => {
  const packet = await sampleInteractiveReference(
    reference,
    {
      ...store,
      scenes: [{ id: 's', content: { html: '<main id="experiment">Default 1000</main>' } }],
    },
    new AbortController().signal,
  );
  expect(packet?.snapshot).toMatchObject({ status: 'unavailable', reason: 'no-interface' });
  expect(packet?.snapshot).not.toHaveProperty('observation');
});
it('cancelled sampling cannot proceed to send', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    sampleInteractiveReference(reference, store, controller.signal),
  ).rejects.toHaveProperty('name', 'AbortError');
});
it('unmounted or changed documents never reuse previous evidence', async () => {
  expect(
    (await sampleInteractiveReference(reference, store, new AbortController().signal))?.snapshot,
  ).toMatchObject({ status: 'unavailable', reason: 'document-changed' });
});
