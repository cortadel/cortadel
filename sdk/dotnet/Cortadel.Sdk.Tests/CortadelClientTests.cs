using System.Reflection;
using Cortadel.Sdk;

namespace Cortadel.Sdk.Tests;

public class CortadelClientTests
{
    [Fact]
    public void Constructor_RejectsABlankBaseUrl()
    {
        Assert.Throws<ArgumentException>(() =>
            new CortadelClient("", "test-user"));
    }

    [Fact]
    public void Constructor_RejectsAMalformedBaseUrl()
    {
        // The shipped SDK leaked a UriFormatException here instead of honouring
        // its own documented ArgumentException contract.
        Assert.Throws<ArgumentException>(() =>
            new CortadelClient("not-a-url", "test-user"));
    }

    [Fact]
    public void Constructor_RejectsABlankUserId()
    {
        Assert.Throws<ArgumentException>(() =>
            new CortadelClient("http://localhost:3001", ""));
    }

    [Fact]
    public void PublicSurface_MatchesTheDocumentedContract()
    {
        var t = typeof(CortadelClient);
        foreach (var name in new[] { "AddAsync", "AddConversationAsync", "SearchAsync",
                                     "ListAsync", "GetAsync", "DeleteAsync", "HealthAsync" })
            Assert.NotNull(t.GetMethod(name));
    }

    /// <summary>
    /// Guards the plan's Global Constraint: "the generated client must not appear in the
    /// package's public API." A naive check on <c>CortadelClient.GetMethods()</c>'s bare
    /// <c>ReturnType</c> cannot see this - every facade method returns <c>Task&lt;T&gt;</c>,
    /// whose <c>Namespace</c> is <c>System.Threading.Tasks</c>, so a method that actually
    /// returns e.g. <c>Task&lt;GM.MemoryDetailResponse&gt;</c> would pass unnoticed. This walks
    /// every public type this assembly exports (excluding the generated transport itself, which
    /// is expected to reference its own internals freely), recursively unwraps generic type
    /// arguments/array element types/Nullable&lt;T&gt; on every constructor parameter, method
    /// return type, method parameter type, property type and field type, and fails if any of
    /// those resolved types belongs to <c>Cortadel.Sdk.Generated</c> or <c>Microsoft.Kiota.*</c>.
    /// </summary>
    [Fact]
    public void GeneratedTransportTypes_AreNeverReachableFromThePublicApi()
    {
        var assembly = typeof(CortadelClient).Assembly;
        var leaks = new List<string>();

        // The generated transport is excluded as a *root* to scan from (its own internals are
        // allowed to reference Kiota/itself freely - see README's "public today by deliberate,
        // revisitable choice"), but it is still a valid *destination*: any leak into it from a
        // facade-side type below is exactly what this test exists to catch.
        var publicApiRoots = assembly.GetExportedTypes().Where(t => !IsGeneratedOrKiota(t));

        foreach (var root in publicApiRoots)
        {
            const BindingFlags Flags = BindingFlags.Public | BindingFlags.Instance
                | BindingFlags.Static | BindingFlags.DeclaredOnly;

            foreach (var ctor in root.GetConstructors(BindingFlags.Public | BindingFlags.Instance))
                foreach (var p in ctor.GetParameters())
                    CheckReachable(p.ParameterType, $"{root.FullName}..ctor({p.Name})");

            foreach (var m in root.GetMethods(Flags))
            {
                // Property/event accessor methods (get_X/set_X/add_X/remove_X) are covered via
                // GetProperties/GetEvents below; skipping them here avoids duplicate reports for
                // the exact same leak (they'd otherwise show up once per accessor too).
                if (m.IsSpecialName) continue;
                CheckReachable(m.ReturnType, $"{root.FullName}.{m.Name}() return type");
                foreach (var p in m.GetParameters())
                    CheckReachable(p.ParameterType, $"{root.FullName}.{m.Name}({p.Name})");
            }

            foreach (var prop in root.GetProperties(Flags))
                CheckReachable(prop.PropertyType, $"{root.FullName}.{prop.Name}");

            foreach (var field in root.GetFields(Flags))
                CheckReachable(field.FieldType, $"{root.FullName}.{field.Name}");
        }

        Assert.True(leaks.Count == 0,
            "Generated transport / Kiota types are reachable from the public API:\n"
            + string.Join("\n", leaks.Distinct()));

        void CheckReachable(Type type, string location)
        {
            foreach (var resolved in UnwrapAll(type))
                if (IsGeneratedOrKiota(resolved))
                    leaks.Add($"{location} exposes {resolved.FullName}");
        }
    }

    private static bool IsGeneratedOrKiota(Type type) =>
        type.Namespace is { } ns
        && (ns.StartsWith("Cortadel.Sdk.Generated", StringComparison.Ordinal)
            || ns.StartsWith("Microsoft.Kiota", StringComparison.Ordinal));

    /// <summary>
    /// Recursively unwraps a type through array element types, <c>Nullable&lt;T&gt;</c>, and
    /// every generic type argument (so <c>Task&lt;List&lt;GM.Foo&gt;?&gt;</c> yields
    /// <c>Task&lt;&gt;</c>, <c>List&lt;&gt;</c>, and <c>GM.Foo</c>, not just the outermost
    /// <c>Task&lt;&gt;</c>), so no nesting depth can hide a leaked type from the guard above.
    /// </summary>
    private static IEnumerable<Type> UnwrapAll(Type type)
    {
        var seen = new HashSet<Type>();
        var stack = new Stack<Type>();
        stack.Push(type);
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            if (!seen.Add(current)) continue;
            yield return current;

            if (current.HasElementType)
            {
                stack.Push(current.GetElementType()!);
            }
            else if (current.IsGenericType)
            {
                foreach (var arg in current.GetGenericArguments())
                    stack.Push(arg);
            }
        }
    }
}
