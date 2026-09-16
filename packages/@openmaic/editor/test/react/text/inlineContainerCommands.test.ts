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

it.each(['sup', 'sub'])('does not duplicate %s when pasting back into its source box', (tag) => {
  const doc = createTextDocument(
    `<p><${tag}><span style="display:inline-block;width:10em">ABCD</span></${tag}></p>`,
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    const copied = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
    view.pasteHTML(copied, {} as ClipboardEvent);
    const host = document.createElement('div');
    host.innerHTML = serializeTextDocument(view.state.doc);
    expect(host.textContent).toBe('ABCBD');
    expect(host.querySelector(`${tag} ${tag}`)).toBeNull();
    expect(host.querySelector(tag)?.textContent).toBe('ABCBD');
  } finally {
    view.destroy();
  }
});

it('preserves nested relative font contexts when clearing a sibling', () => {
  const doc = createTextDocument(
    '<p><span style="font-size:2em"><span style="display:inline-block;width:10em">AB<span style="font-size:0.5em"><span style="display:inline-block;width:3em">CD</span></span>EF</span></span></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2, 3),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    executeTextCommand(view, { command: 'clear' });
    const outer = view.state.doc.firstChild!.firstChild!;
    expect(outer.marks.find((mark) => mark.type.name === 'fontsize')?.attrs.fontsize).toBe('2em');
    const inner = outer.child(1);
    expect(inner.marks.find((mark) => mark.type.name === 'fontsize')?.attrs.fontsize).toBe('0.5em');
    expect(inner.textContent).toBe('CD');
  } finally {
    view.destroy();
  }
});

it('keeps a complete pasted box independent of the destination script context', () => {
  const doc = createTextDocument(
    '<p><sup><span style="display:inline-block;width:10em">ABCD</span></sup></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    const slice = doc.slice(1, 7);
    const plugin = buildPlugins(textSchema).find((p) => p.props.transformPasted)!;
    expect(plugin.props.transformPasted!.call(plugin, slice, view, false).eq(slice)).toBe(true);
    expect(plugin.props.handlePaste!.call(plugin, view, {} as ClipboardEvent, slice)).toBe(false);
  } finally {
    view.destroy();
  }
});

it('does not strip script formatting in the shared paste/drop conversion hook', () => {
  const doc = createTextDocument(
    '<p><sup><span style="display:inline-block;width:10em">ABCD</span></sup></p>',
  );
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3, 4),
      plugins: buildPlugins(textSchema),
    }),
  });
  try {
    const plugin = buildPlugins(textSchema).find((p) => p.props.transformPasted)!;
    const copied = plugin.props.transformCopied!.call(plugin, view.state.selection.content(), view);
    const transformed = plugin.props.transformPasted!.call(plugin, copied, view, false);
    let scripted = false;
    transformed.content.descendants((node) => {
      if (node.isText && textSchema.marks.superscript.isInSet(node.marks)) scripted = true;
    });
    expect(scripted).toBe(true);
  } finally {
    view.destroy();
  }
});
