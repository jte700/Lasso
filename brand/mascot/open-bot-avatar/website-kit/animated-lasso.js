// Optional: npm install open-bot-avatar@0.2.1
import { mountAvatar } from 'open-bot-avatar/dom';
import definition from './lasso-definition.js';
import { palettes } from './lasso-avatar.js';
export function mountAnimatedLasso(element, options = {}) {
  const { palette = 'forest', ...rest } = options;
  if (!Object.hasOwn(palettes, palette)) throw new Error('Unknown palette');
  return mountAvatar(element, { definition, ...palettes[palette], followPointer: true, ...rest });
}
