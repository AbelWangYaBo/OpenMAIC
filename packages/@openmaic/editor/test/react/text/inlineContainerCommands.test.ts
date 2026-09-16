// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { executeTextCommand } from '../../../src/react/text/commandExecutor';
import { getMarkAttrs } from '../../../src/react/text/prosemirror/utils';
import { undo, redo } from 'prosemirror-history';
import { EditorView } from 'prosemirror-view';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../../src/react/text/prosemirror/document';
import { textSchema } from '../../../src/react/text/prosemirror/schema';
import { buildKeymap } from '../../../src/react/text/prosemirror/plugins/keymap';
import { buildPlugins } from '../../../src/react/text/prosemirror/plugins';

it.each(['sup', 'sub'])('can cancel %s on selected or newly typed text', (tag) => {
  const doc = createTextDocument(
    `<p><${tag}><span style="display:inline-block;width:10em">ABCD</span></${tag}></p>`,
  );
  const key = tag === 'sup' ? 'Mod-;' : "Mod-'";
  for (const end of [3, 4]) {
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3, end) });
    expect(
      buildKeymap(textSchema)[key](state, (tr) => {
        state = state.apply(tr);
      }),
    ).toBe(true);
    if (end === 3) state = state.apply(state.tr.insertText('Q'));
    const html = document.createElement('div');
    html.innerHTML = serializeTextDocument(state.doc);
    expect(
      Array.from(html.querySelectorAll(tag))
        .map((el) => el.textContent)
        .join(''),
    ).toBe(end === 3 ? 'ABCD' : 'ACD');
    expect(html.querySelector(`${tag} ${tag}`)).toBeNull();
  }
});

it.each(['sup', 'sub'])('retains %s when copying only inner text', (tag) => {
  const doc = createTextDocument(
    `<p><${tag}><span style="display:inline-block;width:10em">ABCD</span></${tag}></p>`,
  );
  const source = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  const targetDoc = createTextDocument('<p>YZ</p>');
  const target = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc: targetDoc,
      selection: TextSelection.create(targetDoc, 2),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    target.pasteHTML(
      source.serializeForClipboard(source.state.selection.content()).dom.innerHTML,
      {} as ClipboardEvent,
    );
    expect(serializeTextDocument(target.state.doc)).toContain(`<${tag}>B</${tag}>`);
  } finally {
    source.destroy();
    target.destroy();
  }
});

it('retains bold font metrics for ch dimensions', () => {
  const doc = createTextDocument(
    '<p><strong><span style="display:inline-block;width:10ch">ABCD</span></strong>X</p>',
  );
  expect(textSchema.marks.strong.isInSet(doc.firstChild!.firstChild!.marks)).toBeTruthy();
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3, 4) });
  buildKeymap(textSchema)['Mod-b'](state, (tr) => {
    state = state.apply(tr);
  });
  const html = document.createElement('div');
  html.innerHTML = serializeTextDocument(state.doc);
  expect(
    Array.from(html.querySelectorAll('strong'))
      .map((el) => el.textContent)
      .join(''),
  ).toBe('ACD');
});

it('keeps formatting changes in one undo step and preserves whole copied boxes', () => {
  const doc = createTextDocument(
    '<p><sup><span style="display:inline-block;width:10em">ABCD</span></sup>X</p>',
  );
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 3, 4),
    plugins: buildPlugins(textSchema),
  });
  const dispatch = (tr: Parameters<typeof state.apply>[0]) => {
    state = state.apply(tr);
  };
  buildKeymap(textSchema)['Mod-;'](state, dispatch);
  const edited = state.doc;
  expect(undo(state, dispatch)).toBe(true);
  expect(state.doc.eq(doc)).toBe(true);
  expect(redo(state, dispatch)).toBe(true);
  expect(state.doc.eq(edited)).toBe(true);

  const slice = TextSelection.create(doc, 1, 7).content();
  const plugin = buildPlugins(textSchema).find((p) => p.props.transformCopied)!;
  const copied = plugin.props.transformCopied!.call(plugin, slice, {} as never);
  expect(copied.eq(slice)).toBe(true);
});

it('reports inherited toolbar formatting and clears only the selected character', () => {
  const doc = createTextDocument(
    '<p><strong><span style="display:inline-block;width:10ch">ABCD</span></strong></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    expect(getMarkAttrs(view).some((mark) => mark.type.name === 'strong')).toBe(true);
    executeTextCommand(view, { command: 'clear' });
    const host = document.createElement('div');
    host.innerHTML = serializeTextDocument(view.state.doc);
    expect(
      Array.from(host.querySelectorAll('strong'))
        .map((el) => el.textContent)
        .join(''),
    ).toBe('ACD');
  } finally {
    view.destroy();
  }
});
