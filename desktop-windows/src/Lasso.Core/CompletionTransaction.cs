//  Accepting a completion, as a checked text edit.
//
//  A completion may only rewrite the characters the user already typed towards
//  it. The replaceable length is therefore derived from the insertion itself —
//  the longest run immediately before the caret that already spells its
//  beginning — and can never exceed the insertion's own length. A completion
//  can never delete more text than it adds, whatever range a suggestion claims.
//
//  Every stage is pure so it can be tested without a host application.
//
//  Offsets are UTF-16 code units throughout, which is also how .NET indexes a
//  string and how UI Automation expresses a text range, so the units the macOS
//  build uses carry over unchanged.

namespace Lasso.Core;

public enum CompletionFailure
{
    HostChanged,            // focus moved to another element or document
    PrefixMismatch,         // the text to replace is not what was expected
    RangeOutOfBounds,
    OutsideRangeModified,   // the host changed text it was not asked to
    InsertionMissing,       // the phrase is not at the expected place afterwards
}

public static class CompletionFailureNames
{
    /// Stable identifiers for the typing log, matching the macOS build's names.
    public static string Name(this CompletionFailure failure) => failure switch
    {
        CompletionFailure.HostChanged => "hostChanged",
        CompletionFailure.PrefixMismatch => "prefixMismatch",
        CompletionFailure.RangeOutOfBounds => "rangeOutOfBounds",
        CompletionFailure.OutsideRangeModified => "outsideRangeModified",
        CompletionFailure.InsertionMissing => "insertionMissing",
        _ => "unknown",
    };
}

/// A half-open range of UTF-16 code units.
public readonly record struct UnitRange(int Start, int End)
{
    public int Count => End - Start;
    public bool IsEmpty => End <= Start;
    public override string ToString() => $"{Start}..<{End}";
}

public readonly record struct CompletionPlan(UnitRange Range, string ExpectedPrefix, string InsertText)
{
    public bool IsPureInsertion => Range.IsEmpty;
}

/// A bounded view of a host document. Browser editors such as Gmail expose the
/// text before the caret as a moving window rather than as one stable value,
/// so the window's absolute UTF-16 start is part of the evidence.
public readonly record struct CompletionSnapshot(int DocumentStart, string Text)
{
    public int DocumentEnd => DocumentStart + Text.Length;
}

public readonly record struct VerifiedCompletion(UnitRange SnapshotRange, UnitRange DocumentRange);

/// Either a value or the reason it could not be produced. The macOS build uses
/// Swift's Result for the same purpose.
public readonly struct Outcome<T> where T : struct
{
    private readonly T _value;
    public CompletionFailure? Failure { get; }
    public bool IsSuccess => Failure is null;
    public T Value => IsSuccess
        ? _value
        : throw new InvalidOperationException($"outcome failed: {Failure!.Value.Name()}");

    private Outcome(T value, CompletionFailure? failure)
    {
        _value = value;
        Failure = failure;
    }

    public static Outcome<T> Success(T value) => new(value, null);
    public static Outcome<T> Failed(CompletionFailure failure) => new(default, failure);
}

public static class CompletionTransaction
{
    /// Content-editable hosts commonly expose a trailing space as NBSP while
    /// it is at the caret, then turn it back into an ordinary space as soon as
    /// more text follows. Those code units are the same visible edit evidence;
    /// no other characters are treated as interchangeable.
    /// Written as code points so the source stays plain ASCII: U+00A0 no-break
    /// space, U+2007 figure space, U+202F narrow no-break space.
    private const char NoBreakSpace = (char)0x00A0;
    private const char FigureSpace = (char)0x2007;
    private const char NarrowNoBreakSpace = (char)0x202F;

    private static char CanonicalHostUnit(char unit) => unit switch
    {
        NoBreakSpace or FigureSpace or NarrowNoBreakSpace => ' ',
        _ => unit,
    };

    public static bool EquivalentHostText(ReadOnlySpan<char> left, ReadOnlySpan<char> right)
    {
        if (left.Length != right.Length) return false;
        for (var index = 0; index < left.Length; index++)
        {
            if (CanonicalHostUnit(left[index]) != CanonicalHostUnit(right[index])) return false;
        }
        return true;
    }

    /// A host write landed only when the insertion is immediately before the
    /// current caret. Merely finding the same short value elsewhere in the
    /// surrounding window is not evidence ("40" must not match an older "400").
    public static bool InsertionIsAtCaret(string insertion, string textBeforeCaret)
    {
        if (string.IsNullOrEmpty(insertion)) return false;
        if (textBeforeCaret.Length < insertion.Length) return false;
        var tail = textBeforeCaret.AsSpan(textBeforeCaret.Length - insertion.Length);
        return EquivalentHostText(tail, insertion.AsSpan());
    }

    /// How many characters immediately before the caret the completion may
    /// rewrite, compared case-insensitively.
    ///
    /// "…office sup" + "office supplies"   → 10  (rewrites "office sup")
    /// "The value is 61" + "612"            → 2   (rewrites "61")
    /// "…through the suppl" + "office supplies" → 5 (rewrites "suppl")
    /// "the cost is " + "400"               → 0   (pure insertion)
    ///
    /// Two things may be rewritten, and nothing else. The run before the caret
    /// that already spells the start of the insertion, which is the ordinary
    /// case of finishing a phrase. Or, failing that, the single word being
    /// typed, when that word begins a word of the insertion — someone typing
    /// "suppl" towards "Office supplies" means to replace it, not to be left
    /// with "supploffice supplies".
    ///
    /// Both are bounded by what was typed and by the insertion's own length,
    /// and the second can never reach past the current word. That is the point:
    /// a completion may only rewrite text the user typed towards it, which is
    /// what stops a suggestion deleting a sentence it has no relation to.
    public static int ReplaceableLength(ReadOnlySpan<char> typedBeforeCaret, ReadOnlySpan<char> insertText)
    {
        // Never more than the insertion itself, and never more than was typed.
        var limit = Math.Min(typedBeforeCaret.Length, insertText.Length);
        if (limit <= 0) return 0;
        for (var length = limit; length >= 1; length--)
        {
            var matches = true;
            for (var offset = 0; offset < length; offset++)
            {
                var typedUnit = typedBeforeCaret[typedBeforeCaret.Length - length + offset];
                var insertUnit = insertText[offset];
                if (!EqualIgnoringCase(typedUnit, insertUnit))
                {
                    matches = false;
                    break;
                }
            }
            if (matches) return length;
        }

        var word = TrailingWordLength(typedBeforeCaret);
        if (word > 0 && word <= insertText.Length
            && BeginsAWordOf(insertText, typedBeforeCaret[^word..]))
        {
            return word;
        }
        return 0;
    }

    /// The run of characters being typed right now: back to the nearest space
    /// or line break, and no further.
    private static int TrailingWordLength(ReadOnlySpan<char> typedBeforeCaret)
    {
        var start = typedBeforeCaret.Length;
        while (start > 0 && !IsWordBreak(typedBeforeCaret[start - 1])) start--;
        return typedBeforeCaret.Length - start;
    }

    private const char LineSeparatorUnit = (char)0x2028;
    private const char ParagraphSeparatorUnit = (char)0x2029;

    private static bool IsWordBreak(char unit) =>
        CanonicalHostUnit(unit) == ' ' || unit == '\n' || unit == '\r' || unit == '\t'
        || unit == LineSeparatorUnit || unit == ParagraphSeparatorUnit;

    /// Whether the typed word starts one of the insertion's words.
    private static bool BeginsAWordOf(ReadOnlySpan<char> insertText, ReadOnlySpan<char> typedWord)
    {
        if (typedWord.Length == 0) return false;
        var start = 0;
        for (var index = 0; index <= insertText.Length; index++)
        {
            var atEnd = index == insertText.Length;
            if (!atEnd && !IsWordBreak(insertText[index])) continue;
            var word = insertText[start..index];
            if (word.Length >= typedWord.Length)
            {
                var matches = true;
                for (var offset = 0; offset < typedWord.Length; offset++)
                {
                    if (!EqualIgnoringCase(word[offset], typedWord[offset]))
                    {
                        matches = false;
                        break;
                    }
                }
                if (matches) return true;
            }
            start = index + 1;
        }
        return false;
    }

    /// ASCII-only folding, deliberately: the macOS build compares the same way,
    /// so a completion rewrites the same number of units on both platforms.
    private static bool EqualIgnoringCase(char left, char right)
    {
        if (left == right) return true;
        static char Lower(char unit) => unit is >= 'A' and <= 'Z' ? (char)(unit + 32) : unit;
        return Lower(left) == Lower(right);
    }

    /// Builds the smallest edit that turns the typed prefix into the insertion.
    public static Outcome<CompletionPlan> Plan(string document, int caret, string insertText)
    {
        if (caret < 0 || caret > document.Length) return Outcome<CompletionPlan>.Failed(CompletionFailure.RangeOutOfBounds);
        var typed = document.AsSpan(0, caret);
        var length = ReplaceableLength(typed, insertText.AsSpan());
        var range = new UnitRange(caret - length, caret);
        var expected = document.Substring(range.Start, range.Count);
        return Outcome<CompletionPlan>.Success(new CompletionPlan(range, expected, insertText));
    }

    /// Confirms the plan is still valid immediately before the edit is applied.
    ///
    /// Both facts matter: the range must still hold what was expected, and the
    /// caret must still sit at its end. Text alone is not enough — after typing
    /// "per dish" the range still reads "office sup" while the caret has moved
    /// on, and applying the plan there would corrupt the sentence.
    public static CompletionFailure? Validate(CompletionPlan plan, string document, int? caret = null)
    {
        if (plan.Range.Start < 0 || plan.Range.End > document.Length) return CompletionFailure.RangeOutOfBounds;
        if (caret is { } position && position != plan.Range.End) return CompletionFailure.PrefixMismatch;
        var actual = document.Substring(plan.Range.Start, plan.Range.Count);
        return actual == plan.ExpectedPrefix ? null : CompletionFailure.PrefixMismatch;
    }

    /// The document the plan should produce. Used by tests and by verification.
    public static string Apply(CompletionPlan plan, string document) =>
        string.Concat(
            document.AsSpan(0, plan.Range.Start),
            plan.InsertText.AsSpan(),
            document.AsSpan(plan.Range.End));

    /// Checks the host actually made the intended edit and nothing else, then
    /// returns the exact range the inserted phrase now occupies.
    public static Outcome<UnitRange> Verify(string before, string after, CompletionPlan plan)
    {
        var insertLength = plan.InsertText.Length;
        var start = plan.Range.Start;
        var finalRange = new UnitRange(start, start + insertLength);

        // Everything before the edit must be untouched. Checked first, so a host
        // that mangled the surrounding text is reported as such rather than as a
        // missing insertion.
        if (start > after.Length || !before.AsSpan(0, start).SequenceEqual(after.AsSpan(0, start)))
        {
            return Outcome<UnitRange>.Failed(CompletionFailure.OutsideRangeModified);
        }
        if (finalRange.End > after.Length) return Outcome<UnitRange>.Failed(CompletionFailure.InsertionMissing);
        // Everything after it must be untouched.
        var beforeSuffix = before.AsSpan(plan.Range.End);
        var afterSuffix = after.AsSpan(finalRange.End);
        if (!beforeSuffix.SequenceEqual(afterSuffix)) return Outcome<UnitRange>.Failed(CompletionFailure.OutsideRangeModified);
        // And the phrase must be where it was meant to land.
        if (!after.AsSpan(finalRange.Start, finalRange.Count).SequenceEqual(plan.InsertText.AsSpan()))
        {
            return Outcome<UnitRange>.Failed(CompletionFailure.InsertionMissing);
        }

        return Outcome<UnitRange>.Success(finalRange);
    }

    /// Verifies an edit when the host returns moving windows around the caret.
    ///
    /// In a long Gmail draft, inserting ten characters can move the beginning
    /// of the 1,200-character accessibility window ten characters forward.
    /// Comparing the strings directly would call that an unrelated edit. Absolute
    /// offsets let us compare their overlapping evidence instead, while still
    /// refusing a moved caret, a missing insertion, or altered surrounding text.
    public static Outcome<VerifiedCompletion> Verify(
        CompletionSnapshot before, CompletionSnapshot after, CompletionPlan plan)
    {
        if (Validate(plan, before.Text, before.Text.Length) is { } failure)
        {
            return Outcome<VerifiedCompletion>.Failed(failure);
        }
        if (before.DocumentStart < 0 || after.DocumentStart < 0)
        {
            return Outcome<VerifiedCompletion>.Failed(CompletionFailure.RangeOutOfBounds);
        }

        var insertLength = plan.InsertText.Length;
        var delta = insertLength - plan.Range.Count;
        var editStart = before.DocumentStart + plan.Range.Start;
        var finalDocumentRange = new UnitRange(editStart, editStart + insertLength);

        // Both snapshots end at the caret. Its absolute position must move by
        // exactly the edit delta and nothing else.
        if (after.DocumentEnd != before.DocumentEnd + delta)
        {
            return Outcome<VerifiedCompletion>.Failed(CompletionFailure.OutsideRangeModified);
        }

        var localStart = finalDocumentRange.Start - after.DocumentStart;
        var localEnd = finalDocumentRange.End - after.DocumentStart;
        if (localStart < 0 || localEnd > after.Text.Length)
        {
            return Outcome<VerifiedCompletion>.Failed(CompletionFailure.RangeOutOfBounds);
        }
        var finalSnapshotRange = new UnitRange(localStart, localEnd);
        if (!after.Text.AsSpan(finalSnapshotRange.Start, finalSnapshotRange.Count)
                .SequenceEqual(plan.InsertText.AsSpan()))
        {
            return Outcome<VerifiedCompletion>.Failed(CompletionFailure.InsertionMissing);
        }

        // Compare every pre-edit character visible in both moving windows. The
        // completion plan always ends at the caret, so this is the untouched
        // prefix. Keeping the overlap calculation explicit means normal window
        // trimming cannot be mistaken for an unrelated document edit.
        var overlapStart = Math.Max(before.DocumentStart, after.DocumentStart);
        var overlapEnd = Math.Min(editStart, Math.Min(before.DocumentEnd, after.DocumentEnd));
        if (overlapStart < overlapEnd)
        {
            var oldStart = overlapStart - before.DocumentStart;
            var newStart = overlapStart - after.DocumentStart;
            var length = overlapEnd - overlapStart;
            if (!EquivalentHostText(before.Text.AsSpan(oldStart, length), after.Text.AsSpan(newStart, length)))
            {
                return Outcome<VerifiedCompletion>.Failed(CompletionFailure.OutsideRangeModified);
            }
        }

        return Outcome<VerifiedCompletion>.Success(
            new VerifiedCompletion(finalSnapshotRange, finalDocumentRange));
    }
}
