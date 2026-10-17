//  Inside the suggestion panel.
//
//  The same information the macOS panel shows, in the same order, laid out the
//  way Windows 11 lays out a flyout: Segoe UI Variable type, a 4px selection
//  shape with an accent pill, the shell's own file-type icons, key chips in the
//  footer, and an acrylic surface with an 8px radius. Nothing here imitates
//  macOS, and nothing invents a Windows idiom that does not exist.
//
//  The left column is the suggestions; the right is the exact document evidence
//  behind the selected one. In the confirmation and message modes only the left
//  column is shown, which is what the macOS panel does too.

using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Lasso.Core;

namespace Lasso.Windows.Assist;

internal enum AssistMode
{
    Suggestions,
    ConfirmShare,
    Message,
}

internal sealed class AssistFlyoutContent : Border
{
    // Wider than the macOS panel's left column on purpose: Windows spells its
    // shortcuts out ("Ctrl+Shift+Enter") where macOS uses single glyphs, and
    // the footer has to show all three without truncating.
    public const double LeftWidth = 430;
    public const double RightWidth = 394;
    private const double RowHeight = 72;
    private const double NavHeight = 32;
    private const double FooterHeight = 56;
    private const double BodyHeight = 384;

    private readonly Grid _columns = new();
    private readonly StackPanel _left = new();
    private readonly Grid _right = new();
    private readonly TablePreviewView _table = new();
    private readonly ModelPlanView _plan = new();
    private readonly TextBlock _previewMessage = new();
    private readonly Image _previewIcon = new();
    private readonly TextBlock _previewTitle = new();
    private readonly TextBlock _previewSubtitle = new();
    private readonly TextBlock _matched = new();
    private readonly Border _openSource;
    private readonly Border _insertLink;

    public AssistMode Mode { get; set; } = AssistMode.Suggestions;
    public IReadOnlyList<AssistSuggestion> Suggestions { get; set; } = [];
    public int Selected { get; set; }
    public string Title { get; set; } = "Dependency";
    public IReadOnlyList<string> ConfirmChoices { get; set; } = [];
    public IReadOnlyList<string> MessageLines { get; set; } = [];
    public bool SourceScoped { get; set; }
    public AssistDocumentPreview? Preview { get; set; }
    public bool IsPreviewLoading { get; set; }
    public string? PreviewError { get; set; }

    public Action<int>? OnSelectRow { get; set; }
    public Action? OnInsert { get; set; }
    public Action? OnLocalLink { get; set; }
    public Action? OnShare { get; set; }
    public Action? OnOpenSource { get; set; }
    public Action? OnChooseSource { get; set; }
    public Action? OnAllSources { get; set; }
    public Action? OnDismiss { get; set; }

    private FluentPalette Palette => FluentPalette.Current;

    public AssistFlyoutContent()
    {
        SnapsToDevicePixels = true;
        UseLayoutRounding = true;
        CornerRadius = new CornerRadius(FluentPalette.FlyoutRadius);
        BorderThickness = new Thickness(1);

        _columns.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(LeftWidth) });
        _columns.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(RightWidth) });
        Grid.SetColumn(_left, 0);
        Grid.SetColumn(_right, 1);
        _columns.Children.Add(_left);
        _columns.Children.Add(_right);
        Child = _columns;

        _openSource = ActionButton("Open source", () => OnOpenSource?.Invoke());
        _insertLink = ActionButton("Insert hyperlink", () => OnShare?.Invoke());
        BuildRightColumn();
    }

    public double PanelWidth => Mode == AssistMode.Suggestions ? LeftWidth + RightWidth : LeftWidth;

    public double PanelHeight
    {
        get
        {
            if (Mode == AssistMode.Suggestions) return BodyHeight;
            var rows = Mode == AssistMode.ConfirmShare
                ? Math.Max(1, ConfirmChoices.Count)
                : Math.Max(1, MessageLines.Count);
            var rowHeight = Mode == AssistMode.ConfirmShare ? 34 : 22;
            var footer = Mode == AssistMode.Message ? 10 : FooterHeight;
            return NavHeight + rows * rowHeight + footer;
        }
    }

    /// Rebuilds the panel from its current state. The macOS panel redraws
    /// wholesale for the same reason: every change is a new set of rows.
    public void Refresh()
    {
        var palette = Palette;
        Background = palette.FlyoutBackground;
        BorderBrush = palette.FlyoutBorder;

        _right.Visibility = Mode == AssistMode.Suggestions ? Visibility.Visible : Visibility.Collapsed;
        _columns.ColumnDefinitions[1].Width =
            new GridLength(Mode == AssistMode.Suggestions ? RightWidth : 0);

        _left.Children.Clear();
        switch (Mode)
        {
            case AssistMode.Suggestions:
                _left.Children.Add(BuildNavigation());
                _left.Children.Add(BuildSuggestionList());
                _left.Children.Add(BuildShortcutFooter());
                RefreshPreview();
                break;
            case AssistMode.ConfirmShare:
                _left.Children.Add(BuildHeader(Title));
                _left.Children.Add(BuildChoiceList());
                _left.Children.Add(BuildHint("Enter  Choose access       Up/Down  Select       Esc  Cancel"));
                break;
            case AssistMode.Message:
                _left.Children.Add(BuildHeader("Lasso"));
                _left.Children.Add(BuildMessageList());
                break;
        }

        Width = PanelWidth;
        Height = PanelHeight;
    }

    // MARK: - Left column

    private UIElement BuildNavigation()
    {
        var grid = new Grid { Height = NavHeight, Margin = new Thickness(14, 0, 14, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var all = Link(SourceScoped ? "All sources" : "All sources",
            SourceScoped ? Palette.Accent : Palette.TextTertiary,
            SourceScoped ? () => OnAllSources?.Invoke() : null,
            chevron: SourceScoped);
        Grid.SetColumn(all, 0);

        var choose = Link("Choose source", Palette.Accent, () => OnChooseSource?.Invoke());
        choose.HorizontalAlignment = HorizontalAlignment.Right;
        Grid.SetColumn(choose, 1);

        grid.Children.Add(all);
        grid.Children.Add(choose);
        return grid;
    }

    private UIElement BuildSuggestionList()
    {
        var list = new StackPanel { Height = BodyHeight - NavHeight - FooterHeight };
        if (Suggestions.Count == 0)
        {
            list.Children.Add(new TextBlock
            {
                Text = "No matching indexed source",
                Foreground = Palette.TextSecondary,
                FontFamily = Palette.BodyFont,
                FontSize = FluentPalette.CaptionSize,
                Margin = new Thickness(18, 10, 18, 0),
            });
            return list;
        }

        for (var index = 0; index < Math.Min(4, Suggestions.Count); index++)
        {
            list.Children.Add(BuildSuggestionRow(Suggestions[index], index));
        }
        return list;
    }

    private UIElement BuildSuggestionRow(AssistSuggestion suggestion, int index)
    {
        var isSelected = index == Selected;
        var row = new Border
        {
            Height = RowHeight - 8,
            Margin = new Thickness(6, 4, 6, 0),
            CornerRadius = new CornerRadius(FluentPalette.ControlRadius),
            Background = isSelected ? Palette.AccentSelectionFill : Brushes.Transparent,
            Cursor = Cursors.Arrow,
        };

        var layout = new Grid();
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3) });
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(48) });
        layout.ColumnDefinitions.Add(new ColumnDefinition());
        layout.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        // The accent pill Windows 11 puts beside a selected list item.
        if (isSelected)
        {
            var pill = new Border
            {
                Width = 3,
                Height = 20,
                CornerRadius = new CornerRadius(1.5),
                Background = Palette.Accent,
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(1, 0, 0, 0),
            };
            Grid.SetColumn(pill, 0);
            layout.Children.Add(pill);
        }

        var icon = new Image
        {
            Source = ShellIcons.ForPath(suggestion.Path),
            Width = 28,
            Height = 28,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Center,
        };
        RenderOptions.SetBitmapScalingMode(icon, BitmapScalingMode.HighQuality);
        Grid.SetColumn(icon, 1);
        layout.Children.Add(icon);

        var stack = new StackPanel
        {
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 8, 0),
        };
        stack.Children.Add(new TextBlock
        {
            Text = suggestion.Label,
            Foreground = Palette.TextPrimary,
            FontFamily = Palette.BodyFont,
            FontSize = FluentPalette.BodySize,
            FontWeight = FontWeights.SemiBold,
            TextTrimming = TextTrimming.CharacterEllipsis,
        });

        var source = Path.GetFileName(suggestion.Path);
        var breadcrumb = string.Join("  -  ", new[]
        {
            suggestion.RankingReason ?? "",
            source.Length == 0 ? "Project workspace" : source,
            suggestion.Location,
        }.Where(part => part.Length > 0));
        stack.Children.Add(new TextBlock
        {
            Text = breadcrumb,
            Foreground = Palette.TextSecondary,
            FontFamily = Palette.BodyFont,
            FontSize = FluentPalette.CaptionSize,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(0, 2, 0, 0),
        });
        Grid.SetColumn(stack, 2);
        layout.Children.Add(stack);

        if (suggestion.Detail.Length > 0)
        {
            var detail = new TextBlock
            {
                Text = suggestion.Detail,
                Foreground = Palette.TextPrimary,
                FontFamily = Palette.BodyFont,
                FontSize = FluentPalette.BodySize,
                FontWeight = FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 10, 0),
                MaxWidth = 92,
                TextTrimming = TextTrimming.CharacterEllipsis,
                TextAlignment = TextAlignment.Right,
            };
            Grid.SetColumn(detail, 3);
            layout.Children.Add(detail);
        }

        row.Child = layout;
        row.MouseLeftButtonUp += (_, args) =>
        {
            args.Handled = true;
            OnSelectRow?.Invoke(index);
        };
        if (!isSelected)
        {
            row.MouseEnter += (_, _) => row.Background = Palette.SubtleHover;
            row.MouseLeave += (_, _) => row.Background = Brushes.Transparent;
        }
        return row;
    }

    private UIElement BuildShortcutFooter()
    {
        var footer = new Grid { Height = FooterHeight };
        footer.Children.Add(new Border
        {
            BorderBrush = Palette.Divider,
            BorderThickness = new Thickness(0, 1, 0, 0),
            VerticalAlignment = VerticalAlignment.Top,
        });

        var chips = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };
        chips.Children.Add(Shortcut("Tab", "Insert", () => OnInsert?.Invoke()));
        chips.Children.Add(Shortcut("Ctrl+Enter", "Highlight", () => OnLocalLink?.Invoke()));
        chips.Children.Add(Shortcut("Ctrl+Shift+Enter", "Hyperlink", () => OnShare?.Invoke()));
        footer.Children.Add(chips);
        return footer;
    }

    private UIElement BuildHeader(string text)
    {
        var header = new Grid { Height = NavHeight };
        header.Children.Add(new Border
        {
            BorderBrush = Palette.Divider,
            BorderThickness = new Thickness(0, 0, 0, 1),
        });
        var stack = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 0, 0),
        };
        stack.Children.Add(new TextBlock
        {
            Text = "Lasso",
            Foreground = Palette.TextPrimary,
            FontFamily = Palette.BodyFont,
            FontSize = FluentPalette.CaptionSize,
            FontWeight = FontWeights.SemiBold,
        });
        stack.Children.Add(new TextBlock
        {
            Text = SourceScoped ? text.Replace("_", " ") : "Project sources",
            Foreground = Palette.TextSecondary,
            FontFamily = Palette.BodyFont,
            FontSize = FluentPalette.CaptionSize,
            Margin = new Thickness(8, 0, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
            MaxWidth = LeftWidth - 110,
        });
        header.Children.Add(stack);
        return header;
    }

    private UIElement BuildChoiceList()
    {
        var list = new StackPanel();
        for (var index = 0; index < ConfirmChoices.Count; index++)
        {
            var isSelected = index == Selected;
            var row = new Border
            {
                Height = 34,
                Margin = new Thickness(5, 0, 5, 0),
                CornerRadius = new CornerRadius(FluentPalette.ControlRadius),
                Background = isSelected ? Palette.AccentSelectionFill : Brushes.Transparent,
            };
            row.Child = new TextBlock
            {
                Text = ConfirmChoices[index],
                Foreground = Palette.TextPrimary,
                FontFamily = Palette.BodyFont,
                FontSize = FluentPalette.BodySize,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(10, 0, 0, 0),
            };
            list.Children.Add(row);
        }
        return list;
    }

    private UIElement BuildMessageList()
    {
        var list = new StackPanel { Margin = new Thickness(14, 4, 14, 0) };
        foreach (var line in MessageLines)
        {
            list.Children.Add(new TextBlock
            {
                Text = line,
                Foreground = Palette.TextSecondary,
                FontFamily = Palette.BodyFont,
                FontSize = FluentPalette.CaptionSize,
                Height = 22,
            });
        }
        return list;
    }

    private UIElement BuildHint(string text) => new Grid
    {
        Height = FooterHeight,
        Children =
        {
            new Border
            {
                BorderBrush = Palette.Divider,
                BorderThickness = new Thickness(0, 1, 0, 0),
                VerticalAlignment = VerticalAlignment.Top,
            },
            new TextBlock
            {
                Text = text,
                Foreground = Palette.TextSecondary,
                FontFamily = Palette.BodyFont,
                FontSize = FluentPalette.CaptionSize,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(16, 0, 0, 0),
            },
        },
    };

    // MARK: - Right column

    private void BuildRightColumn()
    {
        // The evidence pane sits on its own slightly raised surface, separated
        // by a hairline, so the suggestion list and the document it came from
        // read as two things.
        var surface = new Border
        {
            Background = Palette.LayerBackground,
            BorderBrush = Palette.Divider,
            BorderThickness = new Thickness(1, 0, 0, 0),
            CornerRadius = new CornerRadius(0, FluentPalette.FlyoutRadius, FluentPalette.FlyoutRadius, 0),
        };
        Grid.SetRowSpan(surface, 4);
        _right.Children.Add(surface);

        _right.RowDefinitions.Add(new RowDefinition { Height = new GridLength(64) });
        _right.RowDefinitions.Add(new RowDefinition());
        _right.RowDefinitions.Add(new RowDefinition { Height = new GridLength(24) });
        _right.RowDefinitions.Add(new RowDefinition { Height = new GridLength(56) });

        var header = new Grid { Margin = new Thickness(16, 16, 16, 0) };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(40) });
        header.ColumnDefinitions.Add(new ColumnDefinition());
        _previewIcon.Width = 28;
        _previewIcon.Height = 28;
        _previewIcon.VerticalAlignment = VerticalAlignment.Top;
        Grid.SetColumn(_previewIcon, 0);
        header.Children.Add(_previewIcon);

        var titles = new StackPanel();
        _previewTitle.FontWeight = FontWeights.SemiBold;
        _previewTitle.TextTrimming = TextTrimming.CharacterEllipsis;
        _previewSubtitle.Margin = new Thickness(0, 2, 0, 0);
        _previewSubtitle.TextTrimming = TextTrimming.CharacterEllipsis;
        titles.Children.Add(_previewTitle);
        titles.Children.Add(_previewSubtitle);
        Grid.SetColumn(titles, 1);
        header.Children.Add(titles);
        Grid.SetRow(header, 0);
        _right.Children.Add(header);

        var body = new Grid { Margin = new Thickness(16, 4, 16, 4) };
        _previewMessage.TextWrapping = TextWrapping.Wrap;
        _previewMessage.VerticalAlignment = VerticalAlignment.Top;
        body.Children.Add(_table);
        body.Children.Add(_plan);
        body.Children.Add(_previewMessage);
        Grid.SetRow(body, 1);
        _right.Children.Add(body);

        _matched.Margin = new Thickness(16, 0, 16, 0);
        _matched.TextTrimming = TextTrimming.CharacterEllipsis;
        Grid.SetRow(_matched, 2);
        _right.Children.Add(_matched);

        var buttons = new Grid { Margin = new Thickness(16, 0, 16, 14) };
        buttons.ColumnDefinitions.Add(new ColumnDefinition());
        buttons.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(8) });
        buttons.ColumnDefinitions.Add(new ColumnDefinition());
        Grid.SetColumn(_openSource, 0);
        Grid.SetColumn(_insertLink, 2);
        buttons.Children.Add(_openSource);
        buttons.Children.Add(_insertLink);
        Grid.SetRow(buttons, 3);
        _right.Children.Add(buttons);

    }

    private void RefreshPreview()
    {
        var palette = Palette;
        var fallback = Selected < Suggestions.Count ? Suggestions[Selected] : null;
        var path = Preview?.Path is { Length: > 0 } previewPath ? previewPath : fallback?.Path ?? "";
        var filename = Preview?.Filename is { Length: > 0 } name ? name : Path.GetFileName(path);

        _previewIcon.Source = ShellIcons.ForPath(path);
        _previewTitle.Text = filename.Length > 0 ? filename : "Document preview";
        _previewTitle.Foreground = palette.TextPrimary;
        _previewTitle.FontFamily = palette.BodyFont;
        _previewTitle.FontSize = FluentPalette.BodySize;

        var location = Preview?.Location ?? fallback?.Location ?? "";
        var sheet = location.Split('!').FirstOrDefault() ?? "";
        var parent = Path.GetFileName(Path.GetDirectoryName(path) ?? "");
        _previewSubtitle.Text = sheet.Length > 0 ? sheet
            : parent.Length > 0 ? parent
            : Preview?.ObjectType ?? "Indexed source";
        _previewSubtitle.Foreground = palette.TextSecondary;
        _previewSubtitle.FontFamily = palette.BodyFont;
        _previewSubtitle.FontSize = FluentPalette.CaptionSize;

        _table.Visibility = Visibility.Collapsed;
        _plan.Visibility = Visibility.Collapsed;
        _previewMessage.Visibility = Visibility.Collapsed;
        _previewMessage.Foreground = palette.TextSecondary;
        _previewMessage.FontFamily = palette.BodyFont;
        _previewMessage.FontSize = FluentPalette.CaptionSize;

        if (IsPreviewLoading)
        {
            _previewMessage.Text = "Loading document preview...";
            _previewMessage.Visibility = Visibility.Visible;
        }
        else if (Preview?.Model is { } model)
        {
            _plan.Model = model;
            _plan.Visibility = Visibility.Visible;
        }
        else if (Preview is { Rows.Count: > 0 })
        {
            _table.Preview = Preview;
            _table.Visibility = Visibility.Visible;
        }
        else
        {
            _previewMessage.Text = PreviewError
                ?? Preview?.UnavailableReason
                ?? (Preview?.Context is { Length: > 0 } context
                    ? context
                    : "Select a source-backed result to preview its exact document context.");
            _previewMessage.Visibility = Visibility.Visible;
        }

        if (location.Length > 0)
        {
            var extension = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
            var prefix = extension is "xls" or "xlsx" or "csv" or "tsv"
                ? "Matched cell:  "
                : "Matched location:  ";
            _matched.Text = prefix + location;
        }
        else
        {
            _matched.Text = "";
        }
        _matched.Foreground = palette.TextSecondary;
        _matched.FontFamily = palette.BodyFont;
        _matched.FontSize = FluentPalette.CaptionSize;

        StyleActionButton(_openSource);
        StyleActionButton(_insertLink);
    }

    // MARK: - Small parts

    private Border Shortcut(string keys, string label, Action action)
    {
        var chip = new Border
        {
            CornerRadius = new CornerRadius(FluentPalette.ControlRadius),
            Background = Palette.ControlFill,
            BorderBrush = Palette.ControlBorder,
            BorderThickness = new Thickness(1),
            Padding = new Thickness(6, 2, 6, 3),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new TextBlock
            {
                Text = keys,
                Foreground = Palette.TextSecondary,
                FontFamily = Palette.BodyFont,
                FontSize = FluentPalette.CaptionSize - 1,
            },
        };

        var group = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(0, 0, 16, 0),
            Cursor = Cursors.Arrow,
        };
        group.Children.Add(chip);
        group.Children.Add(new TextBlock
        {
            Text = label,
            Foreground = Palette.TextSecondary,
            FontFamily = Palette.BodyFont,
            FontSize = FluentPalette.CaptionSize,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 0, 0, 0),
        });
        group.MouseLeftButtonUp += (_, args) =>
        {
            args.Handled = true;
            action();
        };

        var host = new Border { Child = group };
        return host;
    }

    private Border Link(string text, Brush brush, Action? action, bool chevron = false)
    {
        var stack = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
        };
        if (chevron)
        {
            stack.Children.Add(new TextBlock
            {
                Text = "<",
                Foreground = brush,
                FontFamily = Palette.BodyFont,
                FontSize = FluentPalette.CaptionSize,
                Margin = new Thickness(0, 0, 4, 0),
            });
        }
        stack.Children.Add(new TextBlock
        {
            Text = text,
            Foreground = brush,
            FontFamily = Palette.BodyFont,
            FontSize = FluentPalette.CaptionSize,
            FontWeight = FontWeights.SemiBold,
        });

        var host = new Border
        {
            Child = stack,
            VerticalAlignment = VerticalAlignment.Center,
            Padding = new Thickness(2, 2, 2, 2),
            CornerRadius = new CornerRadius(FluentPalette.ControlRadius),
            Cursor = action is null ? Cursors.Arrow : Cursors.Hand,
        };
        if (action is not null)
        {
            host.MouseLeftButtonUp += (_, args) =>
            {
                args.Handled = true;
                action();
            };
            host.MouseEnter += (_, _) => host.Background = Palette.SubtleHover;
            host.MouseLeave += (_, _) => host.Background = Brushes.Transparent;
        }
        return host;
    }

    private Border ActionButton(string label, Action action)
    {
        var button = new Border
        {
            Height = 32,
            CornerRadius = new CornerRadius(FluentPalette.ControlRadius),
            Cursor = Cursors.Hand,
            Child = new TextBlock
            {
                Text = label,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis,
            },
        };
        button.MouseLeftButtonUp += (_, args) =>
        {
            args.Handled = true;
            action();
        };
        button.MouseEnter += (_, _) => button.Background = Palette.SubtleHover;
        button.MouseLeave += (_, _) => button.Background = Palette.ControlFill;
        return button;
    }

    private void StyleActionButton(Border button)
    {
        button.Background = Palette.ControlFill;
        button.BorderBrush = Palette.ControlBorder;
        button.BorderThickness = new Thickness(1);
        if (button.Child is TextBlock label)
        {
            label.Foreground = Palette.TextPrimary;
            label.FontFamily = Palette.BodyFont;
            label.FontSize = FluentPalette.CaptionSize;
        }
    }
}
