// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using System.Reflection;
using System.Text.RegularExpressions;

namespace Cortadel.AgentFramework.Tests;

/// <summary>
/// Tests for the code and the tables we ask people to copy and paste.
/// </summary>
/// <remarks>
/// <para>
/// The outgoing Python leg of this integration carried a test that parsed its own README and
/// examples and bound every constructor call against the real library signature — after both had
/// shipped a call that raised <c>TypeError</c> on the line that built the agent. Untested docs are
/// still code.
/// </para>
/// <para>
/// .NET lets that guard be stronger in one half and needs it in the other. The <i>snippets</i> are
/// covered by the compiler: <c>examples/BasicMemoryAgent</c> is a real project in the solution, so
/// `dotnet build` type-checks it — which is exactly how the same bug (a system prompt set on
/// `ChatClientAgentOptions` instead of `ChatOptions`) was caught while writing this package. What
/// the compiler cannot check is the README's prose: the <i>tables</i> that name options and their
/// defaults. Those are checked here, in both directions — an option renamed in the code but not in
/// the table fails, and so does one renamed in the table but not the code. A half-finished rename is
/// the failure mode these tables have, and "the README says <c>TopK</c> is 5" is only true if the
/// type agrees.
/// </para>
/// </remarks>
public sealed class DocumentationTests
{
    private static readonly string PackageRoot = FindPackageRoot();
    private static readonly string Readme = File.ReadAllText(Path.Combine(PackageRoot, "README.md"));

    private const string ProviderTableMarker = "## Configuration";
    private const string ToolTableMarker = "The builders take these options:";

    /// <summary>Sentinel for a "Default" cell written as prose rather than a literal.</summary>
    private static readonly object NoDefault = new();

    private static string FindPackageRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Cortadel.AgentFramework.slnx")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Could not locate the package root (no Cortadel.AgentFramework.slnx above the test output).");
    }

    // ── Guard the guards ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void The_package_ships_the_docs_and_examples_these_tests_check()
    {
        Assert.NotEmpty(CodeBlocks("csharp"));
        Assert.NotEmpty(Directory.GetFiles(Path.Combine(PackageRoot, "examples"), "*.cs", SearchOption.AllDirectories));
        Assert.NotEmpty(TableAfter(ProviderTableMarker));
        Assert.NotEmpty(TableAfter(ToolTableMarker));
    }

    [Fact]
    public void The_readme_covers_every_section_the_integrations_contract_requires()
    {
        foreach (var heading in new[]
                 {
                     "# Cortadel × Microsoft Agent Framework",
                     "## Install",
                     "## Quickstart",
                     "## What you get",
                     "## Configuration",
                     "## Running the tests",
                     "## Requirements",
                 })
        {
            Assert.Contains(heading, Readme, StringComparison.Ordinal);
        }

        Assert.Contains("https://cortadel.ai", Readme, StringComparison.Ordinal);
        Assert.Contains("https://github.com/cortadel/cortadel", Readme, StringComparison.Ordinal);
    }

    // ── The tables must describe the real types ──────────────────────────────────────────────

    [Fact]
    public void Provider_configuration_table_lists_exactly_the_real_options()
        => Assert.Equal(
            SettableProperties(typeof(CortadelContextProviderOptions)).Keys.OrderBy(n => n, StringComparer.Ordinal),
            DocumentedOptions(ProviderTableMarker).Keys.OrderBy(n => n, StringComparer.Ordinal));

    [Fact]
    public void Tool_options_table_lists_exactly_the_real_options()
        => Assert.Equal(
            SettableProperties(typeof(CortadelMemoryToolOptions)).Keys.OrderBy(n => n, StringComparer.Ordinal),
            DocumentedOptions(ToolTableMarker).Keys.OrderBy(n => n, StringComparer.Ordinal));

    [Fact]
    public void Provider_configuration_table_states_the_real_defaults()
        => AssertDocumentedDefaults(ProviderTableMarker, new CortadelContextProviderOptions(), atLeast: 14);

    [Fact]
    public void Tool_options_table_states_the_real_defaults()
        => AssertDocumentedDefaults(ToolTableMarker, new CortadelMemoryToolOptions(), atLeast: 8);

    [Fact]
    public void Documented_tool_names_are_the_names_the_builders_actually_produce()
    {
        var tools = CortadelMemoryTools.CreateAll(new FakeCortadelMemory());
        foreach (var name in tools.Select(t => t.Name))
        {
            Assert.Contains("`" + name + "`", Readme, StringComparison.Ordinal);
        }

        // The canonical names across every Cortadel integration, matching Cortadel's own MCP surface.
        Assert.Equal(["search_memory", "add_memories"], tools.Select(t => t.Name));
    }

    [Fact]
    public void Documented_hooks_are_the_methods_this_provider_really_overrides()
    {
        var overrides = typeof(CortadelContextProvider)
            .GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
            .Where(m => m.IsFamily && m.GetBaseDefinition().DeclaringType != typeof(CortadelContextProvider))
            .Select(m => m.Name)
            .ToList();

        Assert.Contains("ProvideAIContextAsync", overrides);
        Assert.Contains("StoreAIContextAsync", overrides);
        foreach (var hook in overrides)
        {
            Assert.Contains("`" + hook + "`", Readme, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void The_documented_app_name_default_is_the_published_package_id()
    {
        // Every Cortadel integration promises its app_name defaults to its own package name.
        Assert.Equal("Cortadel.AgentFramework", CortadelMemoryClient.DefaultAppName);
        Assert.Equal(CortadelMemoryClient.DefaultAppName, new CortadelContextProviderOptions().AppName);

        var csproj = File.ReadAllText(Path.Combine(PackageRoot, "Cortadel.AgentFramework", "Cortadel.AgentFramework.csproj"));
        Assert.Contains($"<PackageId>{CortadelMemoryClient.DefaultAppName}</PackageId>", csproj, StringComparison.Ordinal);
    }

    // ── Universal house rules ────────────────────────────────────────────────────────────────

    [Fact]
    public void No_source_file_contains_a_literal_NUL_byte()
    {
        // Verified by byte count, never by eye: a literal NUL makes a file binary to git — no diff
        // in the PR, invisible to `git grep`, unrenderable on GitHub.
        var offenders = PackageFiles()
            .Where(IsTextSource)
            .Where(path => Array.IndexOf(File.ReadAllBytes(path), (byte)0) >= 0)
            .ToList();

        Assert.Empty(offenders);
    }

    [Fact]
    public void Every_user_id_in_the_docs_tests_and_examples_is_test_scoped()
    {
        var pattern = new Regex(@"UserId\s*=\s*""(?<id>[^""]*)""|CortadelMemoryClient\.Create\(\s*""[^""]*""\s*,\s*""(?<id>[^""]*)""");
        var found = new List<string>();

        foreach (var path in PackageFiles().Where(p => p.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) || p.EndsWith(".md", StringComparison.OrdinalIgnoreCase)))
        {
            foreach (Match match in pattern.Matches(File.ReadAllText(path)))
            {
                found.Add(match.Groups["id"].Value);
            }
        }

        Assert.NotEmpty(found);
        Assert.All(found, id => Assert.StartsWith("e2e-", id, StringComparison.Ordinal));
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────────────────

    /// <summary>Every text file this package actually ships — the ones a NUL byte would corrupt.</summary>
    private static bool IsTextSource(string path)
        => Path.GetExtension(path).ToLowerInvariant() is ".cs" or ".csproj" or ".slnx" or ".md" or ".json" or ".gitignore" or ".yml" or ".yaml"
            || Path.GetFileName(path) is ".gitignore" or "LICENSE";

    private static IEnumerable<string> PackageFiles()
        => Directory.EnumerateFiles(PackageRoot, "*", SearchOption.AllDirectories)
            .Where(path =>
            {
                var relative = Path.GetRelativePath(PackageRoot, path).Replace('\\', '/');
                return !relative.Contains("/bin/", StringComparison.Ordinal)
                    && !relative.Contains("/obj/", StringComparison.Ordinal)
                    && !relative.StartsWith("bin/", StringComparison.Ordinal)
                    && !relative.StartsWith("obj/", StringComparison.Ordinal);
            });

    private static List<string> CodeBlocks(string language)
        => Regex.Matches(Readme, "^```" + language + "\r?\n(.*?)^```", RegexOptions.Multiline | RegexOptions.Singleline)
            .Select(m => m.Groups[1].Value)
            .ToList();

    /// <summary>Public properties with an initialiser/setter — the options a caller can actually set.</summary>
    private static Dictionary<string, PropertyInfo> SettableProperties(Type type)
        => type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.SetMethod is not null && p.SetMethod.IsPublic)
            .ToDictionary(p => p.Name, p => p, StringComparer.Ordinal);

    /// <summary>Rows (header dropped) of the first markdown table following <paramref name="marker"/>.</summary>
    private static List<string[]> TableAfter(string marker)
    {
        var occurrences = Regex.Matches(Readme, Regex.Escape(marker)).Count;
        Assert.True(occurrences == 1, $"'{marker}' must appear exactly once in the README (found {occurrences}).");

        var rows = new List<string[]>();
        var tail = Readme[(Readme.IndexOf(marker, StringComparison.Ordinal) + marker.Length)..];
        foreach (var line in tail.Split('\n').Select(l => l.Trim()))
        {
            if (line.StartsWith('|'))
            {
                // Split on unescaped pipes only: a cell may contain `string \| null`, and splitting
                // naively would shift every column after it and compare the wrong cells.
                var cells = Regex.Split(line.Trim('|'), @"(?<!\\)\|").Select(c => c.Trim()).ToArray();
                if (cells.All(c => c.Length > 0 && c.All(ch => ch is '-' or ':' or ' ')))
                {
                    continue; // the |---|---| separator
                }

                rows.Add(cells);
            }
            else if (rows.Count > 0)
            {
                break; // blank line or prose after the table: it ended
            }
        }

        return rows.Skip(1).ToList(); // drop the header row
    }

    /// <summary>Map each documented option name to its raw "Default" cell.</summary>
    private static Dictionary<string, string> DocumentedOptions(string marker)
    {
        var name = new Regex(@"^`([A-Z][A-Za-z0-9]*)`$");
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var cells in TableAfter(marker))
        {
            var match = name.Match(cells[0]);
            if (match.Success)
            {
                options[match.Groups[1].Value] = cells[2];
            }
        }

        return options;
    }

    /// <summary>The default a table cell states, or <see cref="NoDefault"/> when it is prose.</summary>
    private static object? DocumentedDefault(string cell)
    {
        var literal = Regex.Match(cell, "^`(.+)`$");
        if (!literal.Success)
        {
            return NoDefault;
        }

        var text = literal.Groups[1].Value;
        return text switch
        {
            "null" => null,
            "true" => true,
            "false" => false,
            _ when text.StartsWith('"') && text.EndsWith('"') && text.Length >= 2 => text[1..^1],
            _ when int.TryParse(text, out var number) => number,
            // An enum member spelled `Type.Member`, e.g. `MemoryInjectionMode.Message`.
            _ when text.Contains('.', StringComparison.Ordinal) => text,
            _ => NoDefault,
        };
    }

    private static void AssertDocumentedDefaults(string marker, object defaults, int atLeast)
    {
        var properties = SettableProperties(defaults.GetType());
        var checkedCount = 0;

        foreach (var (option, cell) in DocumentedOptions(marker))
        {
            var documented = DocumentedDefault(cell);
            if (ReferenceEquals(documented, NoDefault))
            {
                continue; // a prose default, e.g. "a generic `## Memories` header"
            }

            var actual = properties[option].GetValue(defaults);

            // Enums are documented as `Type.Member`; compare on the member's own spelling.
            var expected = actual is Enum
                ? documented as string ?? string.Empty
                : documented;
            var got = actual is Enum enumValue
                ? $"{enumValue.GetType().Name}.{enumValue}"
                : actual;

            Assert.Equal(expected, got);
            checkedCount++;
        }

        Assert.True(checkedCount >= atLeast, $"the defaults check went vacuous: only {checkedCount} of {atLeast} cells compared");
    }
}
