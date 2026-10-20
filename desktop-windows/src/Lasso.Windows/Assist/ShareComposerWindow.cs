//  Privacy-aware source sharing.
//
//  The composer makes the public boundary visible before a token is minted:
//  the whole document, the indexed context only, or a preview with redactions
//  the user selects by clicking the cells or sections they want masked. No
//  grant exists until the action button is pressed, and cancelling creates
//  nothing.

using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Lasso.Core;
using Lasso.Windows.Branding;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Assist;

internal sealed class ShareComposerWindow : Window
{
    // The server ends every share link 48 hours after it is created.
    private const string LinkLifetimeNote = "Link expires in 48 hours.";

    private readonly TextBlock _subtitle = new();
    private readonly TextBlock _badge = new();
    private readonly TextBlock _reach = new();
    private readonly TextBlock _previewCaption = new();
    private readonly Border _previewHost = new();
    private readonly ComboBox _effect = new();
    private readonly StackPanel _effectRow = new();
    private readonly Button _action = new();
    private readonly RadioButton _documentOption = new();
    private readonly RadioButton _indexedOption = new();
    private readonly RadioButton _redactedOption = new();

    private readonly Dictionary<string, ShareRedaction> _masks = [];
    private AssistDocumentPreview? _preview;
    private AssistHttp.FullDocument? _document;
    private ShareAccessScope _scope = ShareAccessScope.Indexed;
    private ShareConfiguration? _result;

    public static async Task<ShareConfiguration?> ComposeAsync(Uri server, string objectId,
        string? versionId, string label, string sourcePath, string actionTitle)
    {
        var host = NativeMethods.GetForegroundWindow();
        var window = new ShareComposerWindow();
        window.Prepare(label, sourcePath, actionTitle);
        window.Show();
        window.Activate();

        var completion = new TaskCompletionSource<ShareConfiguration?>();
        window.Closed += (_, _) => completion.TrySetResult(window._result);
        _ = window.LoadAsync(server, objectId, versionId);

        var result = await completion.Task.ConfigureAwait(true);
        if (host != IntPtr.Zero) NativeMethods.SetForegroundWindow(host);
        await Task.Delay(200).ConfigureAwait(true);
        return result;
    }

    private ShareComposerWindow()
    {
        Width = 720;
        Height = 560;
        MinWidth = 560;
        MinHeight = 460;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        ShowInTaskbar = false;
        Icon = LassoGlyph.Image(64);
        SourceInitialized += (_, _) => WindowComposition.Apply(this, Backdrop.Mica);
        Content = BuildLayout();
    }

    private void Prepare(string label, string sourcePath, string actionTitle)
    {
        Title = actionTitle == "Insert link" ? "Insert source hyperlink" : "Share source";
        _subtitle.Text = $"{label}  -  {Path.GetFileName(sourcePath)}";
        _action.Content = actionTitle;
        _indexedOption.IsChecked = true;
    }

    private UIElement BuildLayout()
    {
        var layout = new Grid { Margin = new Thickness(18) };
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });   // header
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });   // options
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });   // caption
        layout.RowDefinitions.Add(new RowDefinition());                              // preview
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });   // footer

        // Header
        var header = new StackPanel { Margin = new Thickness(0, 0, 0, 12) };
        _subtitle.FontWeight = FontWeights.SemiBold;
        _subtitle.TextTrimming = TextTrimming.CharacterEllipsis;
        _badge.Opacity = 0.75;
        _badge.FontSize = 12;
        _badge.Margin = new Thickness(0, 2, 0, 0);
        _reach.Opacity = 0.75;
        _reach.FontSize = 12;
        _reach.TextWrapping = TextWrapping.Wrap;
        header.Children.Add(_subtitle);
        header.Children.Add(_badge);
        header.Children.Add(_reach);
        Grid.SetRow(header, 0);
        layout.Children.Add(header);

        // Scope options
        var options = new StackPanel { Margin = new Thickness(0, 0, 0, 12) };
        options.Children.Add(Option(_documentOption, "Whole document",
            "The recipient can open and download the original file.",
            ShareAccessScope.Document));
        options.Children.Add(Option(_indexedOption, "Indexed part",
            "Only the indexed evidence and its surrounding context.",
            ShareAccessScope.Indexed));
        options.Children.Add(Option(_redactedOption, "Selective redaction",
            "Choose cells or sections to mask before the recipient sees them.",
            ShareAccessScope.Redacted));
        Grid.SetRow(options, 1);
        layout.Children.Add(options);

        // Caption and redaction effect
        var captionRow = new Grid { Margin = new Thickness(0, 0, 0, 6) };
        captionRow.ColumnDefinitions.Add(new ColumnDefinition());
        captionRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _previewCaption.FontSize = 12;
        _previewCaption.Opacity = 0.75;
        _previewCaption.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(_previewCaption, 0);
        captionRow.Children.Add(_previewCaption);

        _effectRow.Orientation = Orientation.Horizontal;
        _effectRow.Visibility = Visibility.Collapsed;
        _effectRow.Children.Add(new TextBlock
        {
            Text = "Mask with",
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 8, 0),
            FontSize = 12,
            Opacity = 0.75,
        });
        _effect.Items.Add("Blur");
        _effect.Items.Add("Blank");
        _effect.SelectedIndex = 0;
        _effect.MinWidth = 110;
        _effectRow.Children.Add(_effect);
        Grid.SetColumn(_effectRow, 1);
        captionRow.Children.Add(_effectRow);
        Grid.SetRow(captionRow, 2);
        layout.Children.Add(captionRow);

        // Preview surface
        _previewHost.CornerRadius = new CornerRadius(FluentPalette.ControlRadius);
        _previewHost.BorderThickness = new Thickness(1);
        _previewHost.BorderBrush = FluentPalette.Current.ControlBorder;
        _previewHost.Background = FluentPalette.Current.CardBackground;
        _previewHost.Padding = new Thickness(1);
        _previewHost.Child = new TextBlock
        {
            Text = "Loading the recipient preview...",
            Margin = new Thickness(12),
            Opacity = 0.7,
        };
        Grid.SetRow(_previewHost, 3);
        layout.Children.Add(_previewHost);

        // Footer
        var footer = new Grid { Margin = new Thickness(0, 14, 0, 0) };
        footer.ColumnDefinitions.Add(new ColumnDefinition());
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var lifetime = new TextBlock
        {
            Text = LinkLifetimeNote,
            FontSize = 12,
            Opacity = 0.72,
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 12, 0),
        };
        Grid.SetColumn(lifetime, 0);
        footer.Children.Add(lifetime);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal };
        Grid.SetColumn(buttons, 1);
        footer.Children.Add(buttons);
        var cancel = new Button
        {
            Content = "Cancel",
            MinWidth = 96,
            Height = 32,
            IsCancel = true,
            Margin = new Thickness(0, 0, 8, 0),
        };
        cancel.Click += (_, _) => Close();
        _action.MinWidth = 132;
        _action.Height = 32;
        _action.IsDefault = true;
        _action.Click += (_, _) =>
        {
            _result = new ShareConfiguration(_scope, _masks.Values.ToList());
            Close();
        };
        buttons.Children.Add(cancel);
        buttons.Children.Add(_action);
        Grid.SetRow(footer, 4);
        layout.Children.Add(footer);

        return layout;
    }

    private UIElement Option(RadioButton button, string title, string description, ShareAccessScope scope)
    {
        button.GroupName = "scope";
        button.Margin = new Thickness(0, 4, 0, 4);
        button.Content = new StackPanel
        {
            Children =
            {
                new TextBlock { Text = title, FontWeight = FontWeights.SemiBold },
                new TextBlock
                {
                    Text = description,
                    FontSize = 12,
                    Opacity = 0.72,
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(0, 1, 0, 0),
                },
            },
        };
        button.Checked += (_, _) =>
        {
            _scope = scope;
            RefreshPreview();
        };
        return button;
    }

    private async Task LoadAsync(Uri server, string objectId, string? versionId)
    {
        var localOnly = await AssistHttp.ShareIsLocalOnlyAsync(server).ConfigureAwait(true);
        _reach.Text = localOnly
            ? "This link will resolve only on this PC unless a reachable server is configured."
            : "This link will resolve wherever the configured server is reachable.";

        var previewData = await AssistHttp.PreviewAsync(server, objectId, versionId, false,
            CancellationToken.None).ConfigureAwait(true);
        _preview = previewData is null ? null : AssistDocumentPreview.Parse(previewData);

        _document = await AssistHttp.FullDocumentAsync(server, objectId, versionId).ConfigureAwait(true);
        RefreshPreview();
    }

    private void RefreshPreview()
    {
        _badge.Text = _scope == ShareAccessScope.Document ? "Original available" : "Original protected";
        _effectRow.Visibility = _scope == ShareAccessScope.Redacted
            ? Visibility.Visible
            : Visibility.Collapsed;
        _previewCaption.Text = _scope switch
        {
            ShareAccessScope.Document => "COMPLETE DOCUMENT",
            ShareAccessScope.Redacted => "CLICK A CELL OR SECTION TO MASK IT",
            _ => "RECIPIENT PREVIEW",
        };

        if (_scope == ShareAccessScope.Indexed)
        {
            _previewHost.Child = BuildIndexedPreview();
            return;
        }
        _previewHost.Child = BuildFullDocument(interactive: _scope == ShareAccessScope.Redacted);
    }

    private UIElement BuildIndexedPreview()
    {
        if (_preview is not { Rows.Count: > 0 } preview)
        {
            return Message(_preview?.UnavailableReason
                ?? "This source has no tabular preview; the recipient sees its indexed context.");
        }

        var table = new Grid { Margin = new Thickness(8) };
        var columns = Math.Max(1, preview.Rows.Max(row => row.Cells.Count));
        for (var column = 0; column < columns; column++)
        {
            table.ColumnDefinitions.Add(new ColumnDefinition());
        }
        for (var index = 0; index < preview.Rows.Count; index++)
        {
            table.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var row = preview.Rows[index];
            for (var column = 0; column < row.Cells.Count; column++)
            {
                var cell = row.Cells[column];
                var block = new TextBlock
                {
                    Text = cell.Value,
                    Margin = new Thickness(8, 4, 8, 4),
                    FontWeight = cell.Cited ? FontWeights.SemiBold : FontWeights.Normal,
                    TextTrimming = TextTrimming.CharacterEllipsis,
                };
                if (cell.Cited) block.Foreground = FluentPalette.Current.CitedStroke;
                Grid.SetRow(block, index);
                Grid.SetColumn(block, column);
                table.Children.Add(block);
            }
        }
        return new ScrollViewer { Content = table, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    private UIElement BuildFullDocument(bool interactive)
    {
        if (_document is null) return Message("Loading the complete document...");

        if (_document.Kind == "text" || _document.Sheets.Count == 0)
        {
            if (_document.Blocks.Count == 0) return Message("This document has no readable sections.");
            var blocks = new StackPanel { Margin = new Thickness(8) };
            for (var index = 0; index < _document.Blocks.Count; index++)
            {
                blocks.Children.Add(MaskableBlock(_document.Blocks[index], index, interactive));
            }
            return new ScrollViewer { Content = blocks, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        }

        var sheets = new StackPanel { Margin = new Thickness(8) };
        for (var sheetIndex = 0; sheetIndex < _document.Sheets.Count; sheetIndex++)
        {
            var sheet = _document.Sheets[sheetIndex];
            sheets.Children.Add(new TextBlock
            {
                Text = sheet.Name,
                FontWeight = FontWeights.SemiBold,
                Margin = new Thickness(2, sheetIndex == 0 ? 0 : 12, 0, 6),
            });
            var table = new Grid();
            var columns = Math.Max(1, sheet.Rows.Count == 0 ? 1 : sheet.Rows.Max(row => row.Count));
            for (var column = 0; column < columns; column++)
            {
                table.ColumnDefinitions.Add(new ColumnDefinition());
            }
            for (var rowIndex = 0; rowIndex < sheet.Rows.Count; rowIndex++)
            {
                table.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                for (var column = 0; column < sheet.Rows[rowIndex].Count; column++)
                {
                    var element = MaskableCell(sheet.Rows[rowIndex][column], sheetIndex, rowIndex, column,
                        interactive);
                    Grid.SetRow(element, rowIndex);
                    Grid.SetColumn(element, column);
                    table.Children.Add(element);
                }
            }
            sheets.Children.Add(table);
        }
        return new ScrollViewer { Content = sheets, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    private static UIElement Message(string text) => new TextBlock
    {
        Text = text,
        Margin = new Thickness(12),
        Opacity = 0.7,
        TextWrapping = TextWrapping.Wrap,
    };

    private ShareRedactionEffect CurrentEffect =>
        _effect.SelectedIndex == 1 ? ShareRedactionEffect.Blank : ShareRedactionEffect.Blur;

    private FrameworkElement MaskableCell(string value, int sheet, int row, int column, bool interactive)
    {
        var key = $"CELL:{sheet}:{row}:{column}";
        return Maskable(value, key, interactive,
            () => new ShareRedaction("CELL", sheet, row, column, null, CurrentEffect));
    }

    private FrameworkElement MaskableBlock(string value, int block, bool interactive)
    {
        var key = $"BLOCK:{block}";
        return Maskable(value, key, interactive,
            () => new ShareRedaction("BLOCK", null, null, null, block, CurrentEffect));
    }

    private FrameworkElement Maskable(string value, string key, bool interactive,
        Func<ShareRedaction> build)
    {
        var masked = _masks.ContainsKey(key);
        var text = new TextBlock
        {
            Text = masked ? new string('*', Math.Clamp(value.Length, 3, 12)) : value,
            Margin = new Thickness(8, 4, 8, 4),
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextWrapping = key.StartsWith("BLOCK") ? TextWrapping.Wrap : TextWrapping.NoWrap,
            Opacity = masked ? 0.55 : 1,
        };
        var host = new Border
        {
            Child = text,
            CornerRadius = new CornerRadius(FluentPalette.ControlRadius),
            Background = masked ? FluentPalette.Current.AccentSelectionFill : Brushes.Transparent,
            Cursor = interactive ? Cursors.Hand : Cursors.Arrow,
        };
        if (!interactive) return host;

        host.MouseLeftButtonUp += (_, args) =>
        {
            args.Handled = true;
            if (!_masks.Remove(key)) _masks[key] = build();
            RefreshPreview();
        };
        return host;
    }
}
