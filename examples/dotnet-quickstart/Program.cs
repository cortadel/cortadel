using Cortadel.Sdk;

// Quickstart: store a few memories, then search them back.
//
//   dotnet run
//
// Configure via environment variables (all optional):
//   CORTADEL_URL      base URL of the server   (default http://localhost:3001)
//   CORTADEL_USER     user id / memory scope    (default demo-user)
//   CORTADEL_API_KEY  bearer token, if auth is enabled

var baseUrl = Environment.GetEnvironmentVariable("CORTADEL_URL") ?? "http://localhost:3001";
var userId = Environment.GetEnvironmentVariable("CORTADEL_USER") ?? "demo-user";
var apiKey = Environment.GetEnvironmentVariable("CORTADEL_API_KEY");

using var cortadel = new CortadelClient(baseUrl, userId, apiKey);

// 0. Sanity-check the server.
try
{
    var health = await cortadel.HealthAsync();
    Console.WriteLine($"server: {health.Status}\n");
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Could not reach Cortadel at {baseUrl}: {ex.Message}");
    Console.Error.WriteLine("Start the server first — see docs/self-hosting.md.");
    return 1;
}

// 1. Store a few memories.
string[] facts =
{
    "Alice prefers dark mode and keyboard shortcuts.",
    "Alice ships releases on Fridays.",
    "Alice is allergic to peanuts.",
};

foreach (var fact in facts)
{
    var created = await cortadel.AddAsync(fact);
    Console.WriteLine($"stored {created.Id}  ({created.Event})");
}

// 2. Ingest a short conversation — the server extracts atomic facts.
await cortadel.AddConversationAsync(new[]
{
    new ChatMessage("user", "By the way, I just adopted a dog named Pixel."),
    new ChatMessage("assistant", "Congrats! I'll remember Pixel."),
});

Console.WriteLine();

// 3. Search.
foreach (var query in new[] { "what are alice's preferences?", "any allergies?", "pets" })
{
    var hits = await cortadel.SearchAsync(query, new SearchOptions { TopK = 3 });
    Console.WriteLine($"? {query}");
    foreach (var h in hits.Results)
        Console.WriteLine($"   {h.RrfScore:F2}  {h.Content}");
    Console.WriteLine();
}

return 0;
