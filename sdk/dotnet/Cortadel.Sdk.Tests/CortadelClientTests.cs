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

        // The generated transport must not leak into the public API.
        Assert.DoesNotContain(t.GetMethods(),
            m => m.ReturnType.Namespace?.StartsWith("Cortadel.Sdk.Generated") == true);
    }
}
