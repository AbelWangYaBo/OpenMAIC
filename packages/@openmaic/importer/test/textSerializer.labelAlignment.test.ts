import { describe, expect, it } from 'vitest';
import { renderTxBodyHtml } from './helpers';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';

const run = (text: string, props = '') =>
  `<a:r><a:rPr sz="1800">${props}</a:rPr><a:t>${text}</a:t></a:r>`;
const para = (runs: string, props = '') => `<a:p><a:pPr>${props}</a:pPr>${runs}</a:p>`;
const label = para(run('授课团队：清华大学党委学生部'));
const continuation = para(run('          ') + run('校史馆'));
const other = para(run('          注册中心'));
const render = (xml: string, width = 600) =>
  renderTxBodyHtml(xml, undefined, { frameWidthPx: width });

describe('WPS full-width label continuation alignment', () => {
  it('aligns split and combined leading-space runs with the label content', () => {
    const html = render(label + continuation + other);
    expect(html.match(/margin-left: 90pt/g)).toHaveLength(2);
    expect(html).not.toContain('width:2.50em');
    expect(html).toContain('校史馆');
    expect(html).toContain('注册中心');
  });

  it('does not depend on the supplied slide wording', () => {
    const html = render(
      para(run('联系人：张三')) + para(run('        李四')) + para(run('        王五')),
    );
    expect(html.match(/margin-left: 72pt/g)).toHaveLength(2);
  });

  it('does not infer alignment in table cells', () => {
    const html = renderTxBodyHtml(label + continuation + other, undefined, {
      frameWidthPx: 600,
      cellMargins: { lIns: 91440, rIns: 91440, tIns: 45720, bIns: 45720 },
    });
    expect(html).not.toContain('margin-left: 90pt');
  });

  it('requires a known frame width', () => {
    expect(renderTxBodyHtml(label + continuation + other)).not.toContain('margin-left: 90pt');
  });

  it.each([4 / 3, 2])('scales the alignment with the text at ratio %s', async (ratio) => {
    const { slides } = await transformParsedToSlides(
      {
        size: { width: 960, height: 540 },
        themeColors: [],
        slides: [
          {
            fill: { type: 'color', value: '#ffffff' },
            note: '',
            layoutElements: [],
            elements: [
              {
                type: 'text',
                left: 0,
                top: 0,
                width: 450,
                height: 200,
                order: 1,
                rotate: 0,
                content: render(label + continuation + other),
              },
            ],
          },
        ],
      } as Parameters<typeof transformParsedToSlides>[0],
      createMockImportContext({ ratio }),
    );
    const element = slides[0].elements[0];
    if (element.type !== 'text') throw new Error('Expected a text element');
    expect(element.content).toContain(`margin-left: ${(90 * ratio).toFixed(1)}px`);
    expect(element.content).toContain(`font-size: ${(18 * ratio).toFixed(1)}px`);
  });

  it.each(['vert="vert"', 'numCol="2"'])(
    'leaves non-horizontal/single-column layout unchanged: %s',
    (props) => {
      expect(render(`<a:bodyPr ${props}/>` + label + continuation + other)).not.toContain(
        'margin-left: 90pt',
      );
    },
  );

  it.each([
    ['standalone spaces', continuation + other, 600],
    ['single continuation', label + continuation, 600],
    ['different space counts', label + continuation + para(run('    注册中心')), 600],
    ['narrow frame', label + continuation + other, 140],
    ['tabs', label + continuation + para(run('\t注册中心')), 600],
    [
      'explicit indentation',
      label + continuation + '<a:p><a:pPr marL="91440"/>' + run('          注册中心') + '</a:p>',
      600,
    ],
    [
      'center alignment',
      label + continuation + '<a:p><a:pPr algn="ctr"/>' + run('          注册中心') + '</a:p>',
      600,
    ],
    [
      'bullets',
      label + continuation + para(run('          注册中心'), '<a:buChar char="•"/>'),
      600,
    ],
    [
      'mixed sizes',
      label + continuation + para('<a:r><a:rPr sz="2400"/><a:t>          注册中心</a:t></a:r>'),
      600,
    ],
  ])('preserves existing handling for %s', (_name, xml, width) => {
    expect(render(xml as string, width as number)).not.toContain('margin-left: 90pt');
  });
});
