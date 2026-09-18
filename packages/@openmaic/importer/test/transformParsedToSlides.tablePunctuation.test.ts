// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parseTableNode } from '../src/model/nodes/TableNode';
import { tableToElement } from '../src/serializer/tableSerializer';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';
import { minimalCtx } from './helpers';

const fixture = readFileSync(resolve(__dirname, 'fixtures/slide6-table.xml'), 'utf8');
async function importHeader(xml = fixture) {
  const parsed = tableToElement(parseTableNode(parseXml(xml)), minimalCtx(), 0);
  const raw = parsed.data[0][3].text;
  const { slides } = await transformParsedToSlides(
    {
      size: { width: 960, height: 540 },
      themeColors: [],
      slides: [
        {
          fill: { type: 'color', value: '#fff' },
          note: '',
          layoutElements: [],
          elements: [parsed],
        },
      ],
    } as Parameters<typeof transformParsedToSlides>[0],
    createMockImportContext({ viewportWidth: 1280 }),
  );
  const table = slides[0].elements[0];
  if (table.type !== 'table') throw new Error('Expected table');
  const cell = table.data[0][3];
  const host = document.createElement('div');
  host.innerHTML = cell.text;
  return { raw, cell, host };
}
describe('imported table hanging punctuation', () => {
  it('marks the source slide 6 heading and preserves its margins while compacting only the final punctuation', async () => {
    const { raw, cell, host } = await importHeader();
    expect(raw).toContain('data-pptx-hanging-punctuation="true"');
    const punctuation = host.querySelector<HTMLElement>('[data-pptx-hanging-punctuation="true"]');
    expect(punctuation?.textContent).toBe('？');
    expect(punctuation?.style.width).toBe('0.5em');
    expect(punctuation?.style.display).toBe('inline-block');
    expect(cell.padding).toBe('0pt 5.4pt');
    expect(host.textContent).toBe('你的活动高峰时间？');
    expect(host.querySelector('p')?.style.whiteSpace).not.toBe('nowrap');
  });
  it.each([
    ['disabled', fixture.replaceAll('hangingPunct="1"', 'hangingPunct="0"')],
    [
      'long prose',
      fixture.replace('你的活动高峰时间？', '你在一整天当中的活动高峰时间是什么时候？'),
    ],
    ['already fits', fixture.replace('你的活动高峰时间？', '高峰时间？')],
  ])('does not compact %s', async (_, xml) => {
    const { raw, host } = await importHeader(xml);
    expect(raw).not.toContain('data-pptx-hanging-punctuation');
    expect(host.querySelector('[data-pptx-hanging-punctuation]')).toBeNull();
  });
});
