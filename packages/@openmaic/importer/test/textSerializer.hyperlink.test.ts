import { describe, expect, it } from 'vitest';
import { minimalCtx, parseTxBody } from './helpers';
import { renderTextBody } from '../src/serializer/textSerializer';
const render = (props = '', text = 'https://example.com') => {
  const ctx = minimalCtx();
  ctx.theme.colorScheme.set('hlink', '4472C4');
  ctx.theme.colorScheme.set('dk1', '000000');
  ctx.slide.rels.set('rId2', {
    type: 'hyperlink',
    target: 'https://example.com',
    targetMode: 'External',
  });
  return renderTextBody(
    parseTxBody(
      `<a:p><a:r><a:rPr ${props.includes('u=') ? 'u="none"' : ''}><a:solidFill>${props.includes('custom') ? '<a:srgbClr val="FF0000"/>' : '<a:schemeClr val="tx1"/>'}</a:solidFill><a:hlinkClick id="rId2"/></a:rPr><a:t>${text}</a:t></a:r></a:p>`,
    ),
    undefined,
    ctx,
  );
};
describe('hyperlink presentation defaults', () => {
  it('uses hyperlink theme color for ordinary text-theme fill', () =>
    expect(render()).toContain('color: #4472C4'));
  it('emits an explicit underline independent of browser reset styles', () =>
    expect(render()).toContain('text-decoration: underline'));
  it('preserves custom RGB hyperlink colors', () =>
    expect(render('custom')).toContain('color: #FF0000'));
  it('respects explicit no-underline', () =>
    expect(render('u=none')).not.toContain('text-decoration: underline'));
});

it('preserves explicit text-theme color on named navigation links', () => {
  expect(render('', '下一页')).toContain('color: #000000');
  expect(render('', '下一页')).not.toContain('color: #4472C4');
});


function hyperlinkHtml(properties = '', prefix = '', text = '海龟编辑器 (codemao.cn)') {
  const ctx = minimalCtx();
  ctx.slide.rels.set('rId6', {
    type: 'hyperlink',
    target: 'https://turtle.codemao.cn/editor/python_web/242157784',
    targetMode: 'External',
  });
  return renderTextBody(
    parseTxBody(`${prefix}<a:p><a:r><a:rPr ${properties}>
    <a:hlinkClick id="rId6"/></a:rPr><a:t>${text}</a:t></a:r></a:p>`),
    undefined,
    ctx,
  );
}

it('makes implicit hyperlink underlining explicit so slide CSS resets cannot remove it', () => {
  expect(hyperlinkHtml()).toContain('text-decoration: underline');
});
it('preserves explicit no-underline settings', () => {
  expect(hyperlinkHtml('u="none"')).not.toContain('text-decoration: underline');
  expect(
    hyperlinkHtml('', '<a:lstStyle><a:lvl1pPr><a:defRPr u="none"/></a:lvl1pPr></a:lstStyle>'),
  ).not.toContain('text-decoration: underline');
});
it('combines default hyperlink underline with strike-through', () => {
  expect(hyperlinkHtml('strike="sngStrike"')).toContain('text-decoration: underline line-through');
});
it('retains hyperlink underline inside editable tab columns', () => {
  expect(hyperlinkHtml('', '', '链接\t下一列')).toContain('data-pptx-tab-column="true"');
  expect(hyperlinkHtml('', '', '链接\t下一列')).toContain('text-decoration: underline');
});
