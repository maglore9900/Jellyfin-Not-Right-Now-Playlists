using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SmartLists.Services.Users
{
    /// <summary>
    /// Service for handling automatic refresh of user smart playlists.
    /// Triggers on user login and periodic 15-minute intervals.
    /// </summary>
    public class UserAutoRefreshService : IHostedService, IDisposable
    {
        private readonly ISessionManager _sessionManager;
        private readonly IServiceScopeFactory _serviceScopeFactory;
        private readonly UserPlaylistStore _playlistStore;
        private readonly IgnoreStore _ignoreStore;
        private readonly ILogger<UserAutoRefreshService> _logger;

        // Timer for periodic refresh (15-minute intervals)
        private Timer? _periodicTimer;

        // Track users who have pending refreshes to avoid duplicate work
        private readonly ConcurrentDictionary<Guid, DateTime> _pendingUserRefreshes = new();

        // Delay after login before refreshing (allow Jellyfin to fully initialize)
        private static readonly TimeSpan LoginRefreshDelay = TimeSpan.FromSeconds(10);

        // Cooldown between refreshes for same user (prevent spam)
        private static readonly TimeSpan UserRefreshCooldown = TimeSpan.FromMinutes(5);

        private volatile bool _disposed;

        public UserAutoRefreshService(
            ISessionManager sessionManager,
            IServiceScopeFactory serviceScopeFactory,
            UserPlaylistStore playlistStore,
            IgnoreStore ignoreStore,
            ILogger<UserAutoRefreshService> logger)
        {
            _sessionManager = sessionManager;
            _serviceScopeFactory = serviceScopeFactory;
            _playlistStore = playlistStore;
            _ignoreStore = ignoreStore;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _logger.LogInformation("Starting UserAutoRefreshService...");

            // Subscribe to session events for login detection
            _sessionManager.SessionStarted += OnSessionStarted;

            // Initialize periodic timer - align to 15-minute boundaries
            InitializePeriodicTimer();

            _logger.LogInformation("UserAutoRefreshService started - login hook and 15-minute periodic refresh enabled");
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _logger.LogInformation("Stopping UserAutoRefreshService...");

            // Unsubscribe from events
            _sessionManager.SessionStarted -= OnSessionStarted;

            // Stop timer
            _periodicTimer?.Change(Timeout.Infinite, 0);

            _logger.LogInformation("UserAutoRefreshService stopped");
            return Task.CompletedTask;
        }

        /// <summary>
        /// Called when a user session starts (login).
        /// </summary>
        private void OnSessionStarted(object? sender, SessionEventArgs e)
        {
            if (_disposed) return;

            var session = e.SessionInfo;
            if (session?.UserId == null || session.UserId == Guid.Empty)
            {
                return;
            }

            var userId = session.UserId;
            _logger.LogDebug("User session started: {UserId} ({UserName})", userId, session.UserName);

            // Check cooldown - don't refresh if we recently refreshed for this user
            if (_pendingUserRefreshes.TryGetValue(userId, out var lastRefresh))
            {
                if (DateTime.UtcNow - lastRefresh < UserRefreshCooldown)
                {
                    _logger.LogDebug("Skipping login refresh for user {UserId} - within cooldown period", userId);
                    return;
                }
            }

            // Schedule delayed refresh
            _ = Task.Run(async () =>
            {
                try
                {
                    _logger.LogDebug("Scheduling login refresh for user {UserId} in {Delay}s", userId, LoginRefreshDelay.TotalSeconds);
                    await Task.Delay(LoginRefreshDelay).ConfigureAwait(false);

                    if (_disposed) return;

                    await RefreshUserPlaylistsAsync(userId).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error during login refresh for user {UserId}", userId);
                }
            });
        }

        /// <summary>
        /// Initializes the periodic timer to run at 15-minute boundaries.
        /// </summary>
        private void InitializePeriodicTimer()
        {
            var now = DateTime.UtcNow;
            var nextQuarterHour = CalculateNextQuarterHour(now);
            var delayToNextQuarter = nextQuarterHour - now;

            _logger.LogDebug("Periodic timer: next check at {NextCheck}, delay {Delay}",
                nextQuarterHour, delayToNextQuarter);

            _periodicTimer = new Timer(OnPeriodicTimerTick, null, delayToNextQuarter, Timeout.InfiniteTimeSpan);
        }

        /// <summary>
        /// Reschedules the timer for the next 15-minute boundary.
        /// </summary>
        private void RescheduleTimer()
        {
            if (_disposed || _periodicTimer == null) return;

            var now = DateTime.UtcNow;
            var nextQuarterHour = CalculateNextQuarterHour(now);
            var delayToNextQuarter = nextQuarterHour - now;

            _logger.LogDebug("Rescheduling periodic timer: next check at {NextCheck}", nextQuarterHour);
            _periodicTimer.Change(delayToNextQuarter, Timeout.InfiniteTimeSpan);
        }

        /// <summary>
        /// Calculates the next 15-minute boundary.
        /// </summary>
        private static DateTime CalculateNextQuarterHour(DateTime now)
        {
            var currentMinute = now.Minute;
            var nextQuarterMinute = ((currentMinute / 15) + 1) * 15;

            var baseTime = new DateTime(now.Year, now.Month, now.Day, now.Hour, 0, 0, now.Kind);
            return baseTime.AddMinutes(nextQuarterMinute);
        }

        /// <summary>
        /// Called every 15 minutes to refresh all user playlists.
        /// </summary>
        private async void OnPeriodicTimerTick(object? state)
        {
            if (_disposed) return;

            try
            {
                _logger.LogDebug("Periodic user playlist refresh triggered");
                await RefreshAllUserPlaylistsAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during periodic user playlist refresh");
            }
            finally
            {
                RescheduleTimer();
            }
        }

        /// <summary>
        /// Refreshes all playlists for a specific user.
        /// </summary>
        private async Task RefreshUserPlaylistsAsync(Guid userId)
        {
            var userIdStr = userId.ToString();

            try
            {
                // Mark user as having a pending refresh
                _pendingUserRefreshes[userId] = DateTime.UtcNow;

                // Cleanup expired ignores first
                var cleanedUp = await _ignoreStore.CleanupExpiredAsync(userIdStr).ConfigureAwait(false);
                if (cleanedUp > 0)
                {
                    _logger.LogInformation("Cleaned up {Count} expired ignores for user {UserId}", cleanedUp, userId);
                }

                // Get all enabled playlists for this user
                var playlists = await _playlistStore.GetAllAsync(userIdStr).ConfigureAwait(false);
                var enabledPlaylists = playlists.Where(p => p.Enabled).ToList();

                if (enabledPlaylists.Count == 0)
                {
                    _logger.LogDebug("No enabled user playlists for user {UserId}", userId);
                    return;
                }

                _logger.LogInformation("Refreshing {Count} user playlists for user {UserId}", enabledPlaylists.Count, userId);

                // Create a scope for the scoped UserPlaylistService
                using var scope = _serviceScopeFactory.CreateScope();
                var playlistService = scope.ServiceProvider.GetRequiredService<UserPlaylistService>();

                foreach (var playlist in enabledPlaylists)
                {
                    if (_disposed) break;

                    try
                    {
                        // Check if the playlist is orphaned (Jellyfin playlist was deleted externally)
                        if (playlistService.IsOrphaned(playlist))
                        {
                            _logger.LogInformation("Smart playlist '{PlaylistName}' is orphaned (Jellyfin playlist deleted). Removing configuration.", playlist.Name);
                            await _playlistStore.DeleteAsync(userIdStr, playlist.Id).ConfigureAwait(false);
                            await _ignoreStore.RemoveAllForPlaylistAsync(userIdStr, playlist.Id).ConfigureAwait(false);
                            continue;
                        }

                        var (success, message, _) = await playlistService.RefreshAsync(playlist).ConfigureAwait(false);

                        if (success)
                        {
                            // Save updated playlist (with new LastRefreshed, ItemCount, etc.)
                            await _playlistStore.SaveAsync(playlist).ConfigureAwait(false);
                            _logger.LogDebug("Refreshed user playlist '{PlaylistName}': {Message}", playlist.Name, message);
                        }
                        else
                        {
                            _logger.LogWarning("Failed to refresh user playlist '{PlaylistName}': {Message}", playlist.Name, message);
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Error refreshing user playlist '{PlaylistName}'", playlist.Name);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error refreshing playlists for user {UserId}", userId);
            }
        }

        /// <summary>
        /// Refreshes playlists for all users (periodic refresh).
        /// </summary>
        private async Task RefreshAllUserPlaylistsAsync()
        {
            try
            {
                // Get all user IDs that have playlists
                var userIds = await _playlistStore.GetAllUserIdsAsync().ConfigureAwait(false);

                if (userIds.Count == 0)
                {
                    _logger.LogDebug("No users with smart playlists found");
                    return;
                }

                _logger.LogInformation("Periodic refresh: processing {Count} users with smart playlists", userIds.Count);

                foreach (var userIdStr in userIds)
                {
                    if (_disposed) break;

                    if (!Guid.TryParse(userIdStr, out var userId))
                    {
                        continue;
                    }

                    await RefreshUserPlaylistsAsync(userId).ConfigureAwait(false);
                }

                _logger.LogInformation("Periodic user playlist refresh completed");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during periodic refresh of all user playlists");
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            _sessionManager.SessionStarted -= OnSessionStarted;
            _periodicTimer?.Dispose();
            _pendingUserRefreshes.Clear();

            _logger.LogDebug("UserAutoRefreshService disposed");
        }
    }
}
