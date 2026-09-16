import { splitBlock } from 'prosemirror-commands';
import type { NodeType } from 'prosemirror-model';
import { EditorState, type Command } from 'prosemirror-state';

/** Split editable inline wrappers, their paragraph, and its containing list item. */
export const splitListItemInInlineContainer = (itemType: NodeType): Command => {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    let paragraphDepth = $from.depth;
    while (paragraphDepth > 0 && !$from.node(paragraphDepth).isTextblock) paragraphDepth--;
    if (
      paragraphDepth < 2 ||
      ($from.depth === paragraphDepth && $to.depth === paragraphDepth) ||
      $from.node(paragraphDepth - 1).type !== itemType ||
      $to.sharedDepth($from.pos) < paragraphDepth
    )
      return false;

    // Delete first: a selection can remove its inline wrapper, changing the
    // depth splitBlock must split. Its input state must reflect that new depth.
    const tr = state.tr.deleteSelection();
    const afterDeletion = EditorState.create({ doc: tr.doc, selection: tr.selection });
    return splitBlock(
      afterDeletion,
      dispatch &&
        ((split) => {
          // Keep deletion and both splits in one transaction for undo/selection.
          for (const step of split.steps) tr.step(step);
          tr.setSelection(split.selection.getBookmark().resolve(tr.doc));
          const secondParagraph = tr.selection.$from.before(paragraphDepth);
          dispatch(tr.split(secondParagraph).scrollIntoView());
        }),
    );
  };
};
