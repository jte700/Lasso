function sentenceStartsAt(text) {
  const before = String(text ?? '').trimEnd();
  return !before || /[.!?]\s*$/.test(before) || /\n\s*$/.test(String(text ?? ''));
}

export function contextualCompletionCase(value, typed, before, style = 'phrase') {
  const replacement = String(value ?? '');
  if (!replacement || style === 'proper-name') return replacement;
  const typedLetter = String(typed ?? '').match(/[A-Za-z]/)?.[0] ?? '';
  const shouldStartLower = typedLetter
    ? typedLetter === typedLetter.toLocaleLowerCase()
    : !sentenceStartsAt(before);
  if (!shouldStartLower || !/^[A-Z][a-z]/.test(replacement)) return replacement;
  if (style === 'label') {
    const words = replacement.match(/[A-Za-z]+/g) ?? [];
    const containsIdentifier = /\d/.test(replacement)
      || words.some((word) => word.length > 1 && word === word.toLocaleUpperCase());
    if (!containsIdentifier) return replacement.toLocaleLowerCase();
  }
  return `${replacement[0].toLocaleLowerCase()}${replacement.slice(1)}`;
}

export function caretPointForTextLengths(lengths, requestedOffset) {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const offset = Math.max(0, Math.min(Number(requestedOffset) || 0, total));
  if (!lengths.length || offset >= total) return { atEnd: true };
  let consumed = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const end = consumed + lengths[index];
    if (offset < end) return { atEnd: false, nodeIndex: index, offset: offset - consumed };
    if (offset === end) {
      if (index + 1 < lengths.length) return { atEnd: false, nodeIndex: index + 1, offset: 0 };
      return { atEnd: true };
    }
    consumed = end;
  }
  return { atEnd: true };
}
