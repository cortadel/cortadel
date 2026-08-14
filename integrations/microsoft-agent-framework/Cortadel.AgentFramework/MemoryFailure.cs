// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using Microsoft.Extensions.Logging;

namespace Cortadel.AgentFramework;

/// <summary>
/// One place where a Cortadel failure is turned into an observable event.
/// </summary>
/// <remarks>
/// Both legs of this package — <see cref="CortadelContextProvider"/> and
/// <see cref="CortadelMemoryTools"/> — promise the same thing: a Cortadel outage degrades the agent
/// to "no long-term memory", never to "no agent". That promise has exactly two knobs, and they are
/// the same pair across every Cortadel integration:
/// <list type="bullet">
///   <item><description><c>ThrowOnError</c> (<see cref="bool"/>, default <c>false</c>) — propagate the failure to the caller.</description></item>
///   <item><description><c>OnError</c> (callback, default <c>null</c>) — <i>observe</i> the failure. Always a callback, never a mode string.</description></item>
/// </list>
/// When a failure is swallowed and no callback is set, it is logged as a warning, so a
/// misconfigured server can never be silent.
/// </remarks>
internal static class MemoryFailure
{
    /// <summary>Report one swallowed Cortadel failure, then optionally rethrow it.</summary>
    /// <param name="exception">The failure. Never an <see cref="OperationCanceledException"/> — cancellation is the caller's intent, not a Cortadel failure, so callers rethrow it before reaching here.</param>
    /// <param name="message">Warning text, used only when the failure is swallowed unobserved.</param>
    /// <param name="logger">Logger of the calling component, or <c>null</c> to fall back to <see cref="Console.Error"/>.</param>
    /// <param name="throwOnError">Rethrow <paramref name="exception"/> after reporting it.</param>
    /// <param name="onError">
    /// Observer. When set it <i>replaces</i> the warning log — the caller asked to be told their own
    /// way. A callback that itself throws is logged and swallowed: an observer must not be able to
    /// take down the agent the observation was meant to protect.
    /// </param>
    /// <param name="propagate">
    /// <c>false</c> where there is no caller left to rethrow into (a fire-and-forget background
    /// write). Such a failure is always logged or observed, never lost.
    /// </param>
    public static void Report(
        Exception exception,
        string message,
        ILogger? logger,
        bool throwOnError,
        Action<Exception>? onError,
        bool propagate = true)
    {
        var willThrow = propagate && throwOnError;

        if (onError is not null)
        {
            try
            {
                onError(exception);
            }
#pragma warning disable CA1031 // an observer must never break the observed path
            catch (Exception callbackFailure)
#pragma warning restore CA1031
            {
                Warn(logger, callbackFailure, "Cortadel OnError callback threw; ignoring it.");
            }
        }
        else if (!willThrow)
        {
            // Swallowed and unobserved: the warning log is the last line of defence.
            Warn(logger, exception, message);
        }

        if (willThrow)
        {
            throw exception;
        }
    }

    private static void Warn(ILogger? logger, Exception exception, string message)
    {
        if (logger is not null)
        {
            logger.LogWarning(exception, "{Message}", message);
            return;
        }

        // No logger configured. Staying silent would turn a misconfigured server into a mystery,
        // so fall back to stderr — the one sink that exists in every host.
        Console.Error.WriteLine($"[Cortadel.AgentFramework] {message} {exception}");
    }
}
