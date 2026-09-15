import { expect, test } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { TEST_STAGE_ID, SCENE_ID, IFRAME_TITLE, seedDatabase } from '../fixtures/interactive-state';
test.setTimeout(120_000);

test('actual classroom whole-scope reference samples on send without changing activity', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/chat/pi') {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'X-OpenMAIC-Element-Reference-Accepted': '1',
        },
        body:
          'data: ' +
          JSON.stringify({ type: 'done', data: { totalActions: 0, totalAgents: 0 } }) +
          '\n\n',
      });
      return;
    }
    // Keep this isolated test away from every provider/model endpoint.
    if (path.includes('/chat') || path.includes('/generate') || path.includes('/tts'))
      return route.abort();
    if (path === '/api/server-providers')
      return route.fulfill({ json: { providers: {}, mediaProviders: {}, defaultModel: null } });
    if (path === '/api/comfyui-workflows') return route.fulfill({ json: { workflows: [] } });
    await route.continue();
  });
  await seedDatabase(page);
  const classroom = new ClassroomPage(page);
  await classroom.goto(TEST_STAGE_ID);
  await classroom.waitForLoaded();
  const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);
  await expect(frame.locator('#value')).toBeVisible({ timeout: 30000 });
  await frame.locator('#pause').check();
  await frame.locator('#value').press('End');
  const before = await frame.locator('script[data-maic-observation]').textContent();
  await page.getByRole('button', { name: 'Reference courseware' }).click();
  await expect(page.getByTestId('slide-element-reference-pill')).toBeVisible();
  expect(await frame.locator('script[data-maic-observation]').textContent()).toBe(before);
  await expect(frame.locator('#result')).toHaveText('1');
  // Change after reference selection: request must sample 0, not selection-time 10.
  await frame.locator('#value').press('Home');
  const sending = await frame.locator('script[data-maic-observation]').textContent();
  await page.getByRole('heading', { name: 'Slider experiment' }).click();
  await page.keyboard.press('T');
  const input = page.getByPlaceholder('Type your message...', { exact: true });
  await expect(input).toBeVisible();
  await input.fill('What is the current value and last drawn value?');
  const requestPromise = page.waitForRequest('**/api/chat/pi');
  await input.press('Enter');
  const body = (await requestPromise).postDataJSON();
  expect(body.elementReference).toEqual({
    kind: 'interactive_component',
    sceneId: SCENE_ID,
    selector: '#experiment',
  });
  expect(body.interactiveState.snapshot.status).toBe('available');
  expect(body.interactiveState.snapshot.observation.current.graph.objects[0].facts[0].value).toBe(
    0,
  );
  expect(body.interactiveState.snapshot.observation.rendered.graph.objects[0].facts[0].value).toBe(
    1,
  );
  expect(await frame.locator('script[data-maic-observation]').textContent()).toBe(sending);
  await expect(frame.locator('#result')).toHaveText('1');
  await test.info().attach('send-time-state', {
    body: JSON.stringify(
      { elementReference: body.elementReference, interactiveState: body.interactiveState },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
