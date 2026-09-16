import { keymap } from 'prosemirror-keymap';
import { Fragment, Slice, type Schema } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { normalizeInlineContainerMarks, preserveOpenContainerMarks } from '../inlineContainerMarks';
import { history } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';

import { buildKeymap } from './keymap';
import { buildInputRules } from './inputrules';
import { placeholderPlugin } from './placeholder';

export interface PluginOptions {
  placeholder?: string;
}

export const buildPlugins = (schema: Schema, options?: PluginOptions) => {
  const placeholder = options?.placeholder;

  const plugins = [
    new Plugin({
      props: {
        transformCopied: preserveOpenContainerMarks,
        transformPasted(slice) {
          const children = [];
          for (let i = 0; i < slice.content.childCount; i++) {
            children.push(normalizeInlineContainerMarks(slice.content.child(i)));
          }
          return new Slice(Fragment.fromArray(children), slice.openStart, slice.openEnd);
        },
      },
    }),
    buildInputRules(schema),
    keymap(buildKeymap(schema)),
    keymap(baseKeymap),
    dropCursor(),
    gapCursor(),
    history(),
  ];

  if (placeholder) plugins.push(placeholderPlugin(placeholder));

  return plugins;
};
