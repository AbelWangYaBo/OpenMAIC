/**
 * `content` is an HTML-string contract. Only markup-free values can safely use
 * `white-space: pre-line`: a newline between rich HTML block tags is source
 * formatting, not visible slide content.
 */
const HTML_MARKUP_PATTERN = /<\/?[a-z][^>]*>|<![^>]*>/i;

export function preservesPlainTextLineBreaks(content: string): boolean {
  return !HTML_MARKUP_PATTERN.test(content);
}

/** Imported text containers (also preserved by the editor) own their insets. */
export function hasTextFrameInsets(content: string): boolean {
  const wrapper = content.match(/^\s*<div\b([^>]*)>/i);
  const style = wrapper?.[1].match(/(?:^|\s)style\s*=\s*(["'])(.*?)\1/i)?.[2];
  return !!style && /(?:^|;)\s*padding\s*:\s*[^;]+/i.test(style);
}
