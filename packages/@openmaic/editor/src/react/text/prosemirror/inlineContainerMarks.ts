import { Fragment, Slice, type Mark, type Node } from 'prosemirror-model';

export const isInlineContainer = (node: Node): boolean =>
  node.type.name === 'inline_text_box' || node.type.name === 'pptx_tab_column';

function usesGlyphUnits(node: Node): boolean {
  return (
    Object.values(node.attrs).some(
      (value) => typeof value === 'string' && /[\d.](?:ch|ex)\b/i.test(value),
    ) || Array.from({ length: node.childCount }, (_, i) => node.child(i)).some(usesGlyphUnits)
  );
}

/** Semantic formatting belongs to editable contents, not their fixed-width wrapper.
 * Otherwise selecting text inside the wrapper cannot remove inherited marks.
 * Font family/size and sub/sup stay on wrappers: em/ex/ch dimensions and relative child
 * font sizes depend on that inherited typography context. Sub/sup also supply
 * an implicit smaller font size and position the whole box on the baseline.
 * Inner marks override outer marks of the same type, just as in the source HTML.
 */
export function normalizeInlineContainerMarks(node: Node, inherited: readonly Mark[] = []): Node {
  let marks = inherited;
  for (const mark of node.marks) marks = mark.addToSet(marks);
  const container = isInlineContainer(node);
  if (node.isLeaf) return node.mark(marks);
  const fontContext = marks.filter(
    (mark) =>
      mark.type.name === 'fontname' ||
      mark.type.name === 'fontsize' ||
      mark.type.name === 'subscript' ||
      mark.type.name === 'superscript' ||
      (['strong', 'em', 'code'].includes(mark.type.name) && usesGlyphUnits(node)),
  );
  const editableMarks = marks.filter((mark) => !fontContext.includes(mark));
  const children: Node[] = [];
  node.forEach((child) =>
    children.push(normalizeInlineContainerMarks(child, container ? editableMarks : [])),
  );
  return node.copy(Fragment.fromArray(children)).mark(container ? fontContext : marks);
}

// Open slice wrappers can be discarded when pasted into ordinary text. Carry
// their inherited formatting onto the selected contents before serialization.
export function preserveOpenContainerMarks(slice: Slice): Slice {
  const map = (node: Node, start: number, end: number, inherited: readonly Mark[] = []): Node => {
    let marks = inherited;
    for (const mark of node.marks) marks = mark.addToSet(marks);
    const open = isInlineContainer(node) && (start > 0 || end > 0);
    if (node.isLeaf) return node.mark(marks);
    const children: Node[] = [];
    node.forEach((child, _offset, index) =>
      children.push(
        map(
          child,
          index === 0 ? start - 1 : 0,
          index === node.childCount - 1 ? end - 1 : 0,
          open ? marks : [],
        ),
      ),
    );
    return node.copy(Fragment.fromArray(children)).mark(open ? [] : marks);
  };
  const children: Node[] = [];
  slice.content.forEach((node, _offset, index) =>
    children.push(
      map(
        node,
        index === 0 ? slice.openStart : 0,
        index === slice.content.childCount - 1 ? slice.openEnd : 0,
      ),
    ),
  );
  return new Slice(Fragment.fromArray(children), slice.openStart, slice.openEnd);
}
