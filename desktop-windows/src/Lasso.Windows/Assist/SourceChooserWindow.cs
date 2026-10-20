//  A native source picker.
//
//  Choosing a result only previews it; insertion stays an explicit action after
//  focus has returned to the user's document. Built from ordinary Windows
//  controls so it reads, behaves, and is navigated exactly like any other
//  dialog on the system — including the keyboard: type to filter, Up and Down
//  to move through results without leaving the search box, Enter to choose,
//  Escape to cancel.

using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Lasso.Core;
using Lasso.Windows.Branding;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Assist;

internal sealed class SourceChooserWindow : Window
{
    private const int MaximumResults = 300;

    private readonly ComboBox _documents = new();
    private readonly TextBox _search = new();
    private readonly ListBox _results = new();
    private readonly TextBlock _status = new();
    private readonly Button _choose = new();

    private List<JsonElement> _objects = [];
    private List<JsonElement> _matches = [];
    private SourceChoice? _chosen;

    public static async Task<SourceChoice?> ChooseAsync(Uri server, string projectId, string? sourcePath)
    {
        // The window the user was typing in, so focus can be handed back.
        var host = NativeMethods.GetForegroundWindow();

        var window = new SourceChooserWindow();
        window.Show();
        window.Activate();
        await window.LoadAsync(server, projectId, sourcePath).ConfigureAwait(true);

        var completion = new TaskCompletionSource<SourceChoice?>();
        window.Closed += (_, _) => completion.TrySetResult(window._chosen);
        var result = await completion.Task.ConfigureAwait(true);

        // Give the host its focus back before anything is inserted into it.
        if (host != IntPtr.Zero) NativeMethods.SetForegroundWindow(host);
        await Task.Delay(200).ConfigureAwait(true);
        return result;
    }

    private SourceChooserWindow()
    {
        Title = "Choose a source";
        Width = 620;
        Height = 460;
        MinWidth = 460;
        MinHeight = 360;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        ShowInTaskbar = false;
        Icon = LassoGlyph.Image(64);
        SourceInitialized += (_, _) => WindowComposition.Apply(this, Backdrop.Mica);

        var layout = new Grid { Margin = new Thickness(16) };
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition());
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        _documents.Margin = new Thickness(0, 0, 0, 8);
        _documents.SelectionChanged += (_, _) => Filter();
        Grid.SetRow(_documents, 0);
        layout.Children.Add(_documents);

        _search.Margin = new Thickness(0, 0, 0, 8);
        _search.TextChanged += (_, _) => Filter();
        _search.PreviewKeyDown += OnSearchKey;
        Grid.SetRow(_search, 1);
        layout.Children.Add(_search);

        _results.ItemTemplate = BuildRowTemplate();
        _results.SelectionChanged += (_, _) => _choose.IsEnabled = _results.SelectedIndex >= 0;
        _results.MouseDoubleClick += (_, _) => Accept();
        ScrollViewer.SetHorizontalScrollBarVisibility(_results, ScrollBarVisibility.Disabled);
        Grid.SetRow(_results, 2);
        layout.Children.Add(_results);

        var footer = new Grid { Margin = new Thickness(0, 12, 0, 0) };
        footer.ColumnDefinitions.Add(new ColumnDefinition());
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _status.VerticalAlignment = VerticalAlignment.Center;
        _status.Opacity = 0.75;
        _status.Text = "Loading sources...";
        Grid.SetColumn(_status, 0);
        footer.Children.Add(_status);

        var buttons = new StackPanel { Orientation = Orientation.Horizontal };
        var cancel = new Button
        {
            Content = "Cancel",
            MinWidth = 96,
            Height = 32,
            IsCancel = true,
            Margin = new Thickness(0, 0, 8, 0),
        };
        cancel.Click += (_, _) => Close();
        _choose.Content = "Preview source";
        _choose.MinWidth = 132;
        _choose.Height = 32;
        _choose.IsDefault = true;
        _choose.IsEnabled = false;
        _choose.Click += (_, _) => Accept();
        buttons.Children.Add(cancel);
        buttons.Children.Add(_choose);
        Grid.SetColumn(buttons, 1);
        footer.Children.Add(buttons);
        Grid.SetRow(footer, 3);
        layout.Children.Add(footer);

        Content = layout;
        Loaded += (_, _) => _search.Focus();
    }

    private static DataTemplate BuildRowTemplate()
    {
        // Two lines per result: what it is, then where it came from.
        var stack = new FrameworkElementFactory(typeof(StackPanel));
        stack.SetValue(MarginProperty, new Thickness(2, 4, 2, 4));

        var label = new FrameworkElementFactory(typeof(TextBlock));
        label.SetBinding(TextBlock.TextProperty, new System.Windows.Data.Binding("Label"));
        label.SetValue(TextBlock.FontWeightProperty, FontWeights.SemiBold);
        label.SetValue(TextBlock.TextTrimmingProperty, TextTrimming.CharacterEllipsis);
        stack.AppendChild(label);

        var detail = new FrameworkElementFactory(typeof(TextBlock));
        detail.SetBinding(TextBlock.TextProperty, new System.Windows.Data.Binding("Detail"));
        detail.SetValue(TextBlock.OpacityProperty, 0.7);
        detail.SetValue(TextBlock.FontSizeProperty, 12.0);
        detail.SetValue(TextBlock.TextTrimmingProperty, TextTrimming.CharacterEllipsis);
        stack.AppendChild(detail);

        return new DataTemplate { VisualTree = stack };
    }

    private sealed record Row(string Label, string Detail, JsonElement Source);

    private async Task LoadAsync(Uri server, string projectId, string? sourcePath)
    {
        var objects = await AssistHttp.SourceLibraryAsync(server, projectId, CancellationToken.None)
            .ConfigureAwait(true);
        if (objects.Count == 0)
        {
            _status.Text = "Sources could not be loaded. Close and try again.";
            return;
        }

        _objects = objects
            .OrderBy(item => (JsonReading.String(item, "path") ?? "") + (JsonReading.String(item, "label") ?? ""),
                StringComparer.CurrentCultureIgnoreCase)
            .ToList();

        var paths = _objects
            .Select(item => JsonReading.String(item, "path") ?? "")
            .Where(path => path.Length > 0)
            .Distinct()
            .OrderBy(path => path, StringComparer.CurrentCultureIgnoreCase)
            .ToList();

        _documents.Items.Add("All documents");
        foreach (var path in paths) _documents.Items.Add(path);
        _documents.SelectedIndex = sourcePath is not null && paths.IndexOf(sourcePath) is var index and >= 0
            ? index + 1
            : 0;
        Filter();
    }

    private void Filter()
    {
        var path = _documents.SelectedIndex > 0 ? _documents.SelectedItem as string : null;
        var query = _search.Text.Trim();
        var terms = query.Split(' ', StringSplitOptions.RemoveEmptyEntries);

        var results = _objects.Where(item =>
        {
            if (path is not null && JsonReading.String(item, "path") != path) return false;
            if (terms.Length == 0) return true;
            var content = string.Join(" ", new[]
            {
                JsonReading.String(item, "label"),
                JsonReading.String(item, "valueText"),
                JsonReading.String(item, "path"),
            }.Where(part => part is not null));
            return terms.All(term => content.Contains(term, StringComparison.CurrentCultureIgnoreCase));
        }).ToList();

        _matches = results.Take(MaximumResults).ToList();
        _results.ItemsSource = _matches.Select(item => new Row(
            JsonReading.String(item, "label") ?? "Source",
            string.Join(" - ", new[]
            {
                JsonReading.String(item, "path"),
                JsonReading.Object(item, "anchor") is { } anchor ? JsonReading.String(anchor, "column") : null,
                JsonReading.String(item, "valueText"),
            }.Where(part => part is { Length: > 0 })),
            item)).ToList();

        if (_matches.Count > 0) _results.SelectedIndex = 0;
        _choose.IsEnabled = _matches.Count > 0;
        _status.Text = results.Count == 0
            ? "No matching sources"
            : results.Count > MaximumResults
                ? $"Showing {MaximumResults} results. Search to narrow them."
                : $"{results.Count} sources - Up and Down to select";
    }

    /// Arrow keys move the selection while the caret stays in the search box,
    /// which is how Windows search fields with a result list behave.
    private void OnSearchKey(object sender, KeyEventArgs args)
    {
        if (args.Key is not (Key.Up or Key.Down)) return;
        if (_matches.Count == 0) return;
        var delta = args.Key == Key.Down ? 1 : -1;
        _results.SelectedIndex = Math.Max(0, Math.Min(_matches.Count - 1, _results.SelectedIndex + delta));
        _results.ScrollIntoView(_results.SelectedItem);
        args.Handled = true;
    }

    private void Accept()
    {
        if (_results.SelectedIndex < 0 || _results.SelectedIndex >= _matches.Count) return;
        var source = _matches[_results.SelectedIndex];
        var id = JsonReading.String(source, "id");
        if (id is null) return;

        _chosen = new SourceChoice(
            Id: id,
            Label: JsonReading.String(source, "label") ?? "Source",
            ValueText: JsonReading.String(source, "valueText"),
            Path: JsonReading.String(source, "path") ?? "",
            Location: PredictionParser.SourceLocation(source),
            ObjectType: JsonReading.String(source, "objectType") ?? "",
            VersionId: JsonReading.String(source, "versionId"),
            SnapshotId: JsonReading.String(source, "snapshotId"));
        Close();
    }
}
