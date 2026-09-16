import { Fragment, type Mark, type Node } from 'prosemirror-model';

/** Semantic formatting belongs to editable contents, not their fixed-width wrapper.
 * Otherwise selecting text inside the wrapper cannot remove inherited marks.
 * Font family/size stay on wrappers: em/ex/ch dimensions and relative child
 * font sizes depend on that inherited typography context.
 * Inner marks override outer marks of the same type, just as in the source HTML.
 */
export function normalizeInlineContainerMarks(node: Node, inherited: readonly Mark[] = []): Node {
  let marks = inherited;
  for (const mark of node.marks) marks = mark.addToSet(marks);
  const container = node.type.name === 'inline_text_box' || node.type.name === 'pptx_tab_column';
  if (node.isLeaf) return node.mark(marks);
  const fontContext = marks.filter(
    (mark) => mark.type.name === 'fontname' || mark.type.name === 'fontsize',
  );
  const editableMarks = marks.filter((mark) => !fontContext.includes(mark));
  const children: Node[] = [];
  node.forEach((child) =>
    children.push(normalizeInlineContainerMarks(child, container ? editableMarks : [])),
  );
  return node.copy(Fragment.fromArray(children)).mark(container ? fontContext : marks);
}
