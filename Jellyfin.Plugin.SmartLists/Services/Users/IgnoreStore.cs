using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.SmartLists.Core.Models;
using Jellyfin.Plugin.SmartLists.Services.Shared;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SmartLists.Services.Users
{
    /// <summary>
    /// Store implementation for user track ignore lists.
    /// Each user has a single ignores.json file containing all their ignored tracks.
    /// </summary>
    public class IgnoreStore
    {
        private readonly ISmartListFileSystem _fileSystem;
        private readonly ILogger<IgnoreStore>? _logger;

        // In-memory cache for performance (per-user)
        private readonly Dictionary<string, List<IgnoredTrack>> _cache = new(StringComparer.OrdinalIgnoreCase);
        private readonly object _cacheLock = new();

        public IgnoreStore(ISmartListFileSystem fileSystem, ILogger<IgnoreStore>? logger = null)
        {
            _fileSystem = fileSystem;
            _logger = logger;
        }

        /// <summary>
        /// Gets all ignored tracks for a user.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <returns>List of ignored tracks.</returns>
        public async Task<List<IgnoredTrack>> GetAllAsync(string userId)
        {
            ValidateUserId(userId);

            // Check cache first
            lock (_cacheLock)
            {
                if (_cache.TryGetValue(userId, out var cached))
                {
                    return new List<IgnoredTrack>(cached);
                }
            }

            // Load from file
            var filePath = _fileSystem.GetUserIgnoresPath(userId);
            if (!File.Exists(filePath))
            {
                return [];
            }

            try
            {
                await using var stream = File.OpenRead(filePath);
                var ignores = await JsonSerializer.DeserializeAsync<List<IgnoredTrack>>(
                    stream, SmartListFileSystem.SharedJsonOptions).ConfigureAwait(false);

                var result = ignores ?? [];

                // Update cache
                lock (_cacheLock)
                {
                    _cache[userId] = new List<IgnoredTrack>(result);
                }

                return result;
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "Failed to load ignore list for user {UserId}", userId);
                return [];
            }
        }

        /// <summary>
        /// Gets ignored tracks for a specific smart playlist.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <param name="smartPlaylistId">The smart playlist ID.</param>
        /// <param name="includeExpired">Whether to include expired ignores.</param>
        /// <returns>List of ignored tracks for the playlist.</returns>
        public async Task<List<IgnoredTrack>> GetForPlaylistAsync(string userId, string smartPlaylistId, bool includeExpired = false)
        {
            var allIgnores = await GetAllAsync(userId).ConfigureAwait(false);

            return allIgnores
                .Where(i => string.Equals(i.SmartPlaylistId, smartPlaylistId, StringComparison.OrdinalIgnoreCase))
                .Where(i => includeExpired || i.IsActive())
                .ToList();
        }

        /// <summary>
        /// Gets active (non-expired) ignored track IDs for a specific smart playlist.
        /// This is optimized for filtering during playlist refresh.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <param name="smartPlaylistId">The smart playlist ID.</param>
        /// <returns>HashSet of ignored track IDs for efficient lookup.</returns>
        public async Task<HashSet<string>> GetActiveIgnoredTrackIdsAsync(string userId, string smartPlaylistId)
        {
            var ignores = await GetForPlaylistAsync(userId, smartPlaylistId, includeExpired: false).ConfigureAwait(false);
            return ignores.Select(i => i.TrackId).ToHashSet(StringComparer.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Gets the count of active (non-expired) ignores for a specific smart playlist.
        /// </summary>
        public async Task<int> GetActiveCountAsync(string userId, string smartPlaylistId)
        {
            var ignores = await GetForPlaylistAsync(userId, smartPlaylistId, includeExpired: false).ConfigureAwait(false);
            return ignores.Count;
        }

        /// <summary>
        /// Adds a track to the ignore list.
        /// </summary>
        /// <param name="ignoredTrack">The ignore entry to add.</param>
        /// <returns>The added ignore entry.</returns>
        public async Task<IgnoredTrack> AddAsync(IgnoredTrack ignoredTrack)
        {
            ArgumentNullException.ThrowIfNull(ignoredTrack);
            ValidateUserId(ignoredTrack.UserId);

            // Generate ID if not set
            if (string.IsNullOrWhiteSpace(ignoredTrack.Id))
            {
                ignoredTrack.Id = Guid.NewGuid().ToString();
            }

            var allIgnores = await GetAllAsync(ignoredTrack.UserId).ConfigureAwait(false);

            // Check if track is already ignored for this playlist
            var existing = allIgnores.FirstOrDefault(i =>
                string.Equals(i.TrackId, ignoredTrack.TrackId, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(i.SmartPlaylistId, ignoredTrack.SmartPlaylistId, StringComparison.OrdinalIgnoreCase));

            if (existing != null)
            {
                // Update existing entry
                existing.IgnoredAt = ignoredTrack.IgnoredAt;
                existing.DurationDays = ignoredTrack.DurationDays;
                existing.ExpiresAt = ignoredTrack.ExpiresAt;
                existing.TrackName = ignoredTrack.TrackName ?? existing.TrackName;
                existing.ArtistName = ignoredTrack.ArtistName ?? existing.ArtistName;
                existing.AlbumName = ignoredTrack.AlbumName ?? existing.AlbumName;
                existing.Reason = ignoredTrack.Reason ?? existing.Reason;
            }
            else
            {
                allIgnores.Add(ignoredTrack);
            }

            await SaveAllAsync(ignoredTrack.UserId, allIgnores).ConfigureAwait(false);

            _logger?.LogDebug("Added/updated ignore for track {TrackId} in playlist {PlaylistId} for user {UserId}",
                ignoredTrack.TrackId, ignoredTrack.SmartPlaylistId, ignoredTrack.UserId);

            return existing ?? ignoredTrack;
        }

        /// <summary>
        /// Updates an ignore entry's duration.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <param name="ignoreId">The ignore entry ID.</param>
        /// <param name="newDurationDays">New duration in days. Null for permanent.</param>
        /// <returns>The updated ignore entry, or null if not found.</returns>
        public async Task<IgnoredTrack?> UpdateDurationAsync(string userId, string ignoreId, int? newDurationDays)
        {
            ValidateUserId(userId);

            var allIgnores = await GetAllAsync(userId).ConfigureAwait(false);
            var ignore = allIgnores.FirstOrDefault(i =>
                string.Equals(i.Id, ignoreId, StringComparison.OrdinalIgnoreCase));

            if (ignore == null)
            {
                return null;
            }

            ignore.UpdateDuration(newDurationDays);
            await SaveAllAsync(userId, allIgnores).ConfigureAwait(false);

            _logger?.LogDebug("Updated duration for ignore {IgnoreId} to {DurationDays} days for user {UserId}",
                ignoreId, newDurationDays, userId);

            return ignore;
        }

        /// <summary>
        /// Removes an ignore entry by ID.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <param name="ignoreId">The ignore entry ID.</param>
        /// <returns>True if removed, false if not found.</returns>
        public async Task<bool> RemoveAsync(string userId, string ignoreId)
        {
            ValidateUserId(userId);

            var allIgnores = await GetAllAsync(userId).ConfigureAwait(false);
            var removed = allIgnores.RemoveAll(i =>
                string.Equals(i.Id, ignoreId, StringComparison.OrdinalIgnoreCase)) > 0;

            if (removed)
            {
                await SaveAllAsync(userId, allIgnores).ConfigureAwait(false);
                _logger?.LogDebug("Removed ignore {IgnoreId} for user {UserId}", ignoreId, userId);
            }

            return removed;
        }

        /// <summary>
        /// Removes all ignores for a specific smart playlist.
        /// Used when a smart playlist is deleted.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <param name="smartPlaylistId">The smart playlist ID.</param>
        /// <returns>Number of ignores removed.</returns>
        public async Task<int> RemoveAllForPlaylistAsync(string userId, string smartPlaylistId)
        {
            ValidateUserId(userId);

            var allIgnores = await GetAllAsync(userId).ConfigureAwait(false);
            var removed = allIgnores.RemoveAll(i =>
                string.Equals(i.SmartPlaylistId, smartPlaylistId, StringComparison.OrdinalIgnoreCase));

            if (removed > 0)
            {
                await SaveAllAsync(userId, allIgnores).ConfigureAwait(false);
                _logger?.LogDebug("Removed {Count} ignores for playlist {PlaylistId} for user {UserId}",
                    removed, smartPlaylistId, userId);
            }

            return removed;
        }

        /// <summary>
        /// Removes all expired ignores for a user.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <returns>Number of ignores removed.</returns>
        public async Task<int> CleanupExpiredAsync(string userId)
        {
            ValidateUserId(userId);

            var allIgnores = await GetAllAsync(userId).ConfigureAwait(false);
            var removed = allIgnores.RemoveAll(i => i.IsExpired());

            if (removed > 0)
            {
                await SaveAllAsync(userId, allIgnores).ConfigureAwait(false);
                _logger?.LogDebug("Cleaned up {Count} expired ignores for user {UserId}", removed, userId);
            }

            return removed;
        }

        /// <summary>
        /// Saves all ignores for a user.
        /// </summary>
        private async Task SaveAllAsync(string userId, List<IgnoredTrack> ignores)
        {
            var filePath = _fileSystem.GetUserIgnoresPath(userId);
            var tempPath = filePath + ".tmp";

            try
            {
                await using (var writer = File.Create(tempPath))
                {
                    await JsonSerializer.SerializeAsync(writer, ignores, SmartListFileSystem.SharedJsonOptions)
                        .ConfigureAwait(false);
                    await writer.FlushAsync().ConfigureAwait(false);
                }

                if (File.Exists(filePath))
                {
                    File.Replace(tempPath, filePath, null);
                }
                else
                {
                    File.Move(tempPath, filePath);
                }

                // Update cache
                lock (_cacheLock)
                {
                    _cache[userId] = new List<IgnoredTrack>(ignores);
                }
            }
            finally
            {
                try
                {
                    if (File.Exists(tempPath))
                    {
                        File.Delete(tempPath);
                    }
                }
                catch
                {
                    // Ignore cleanup errors
                }
            }
        }

        /// <summary>
        /// Clears the in-memory cache for a user.
        /// </summary>
        /// <param name="userId">The user ID, or null to clear all.</param>
        public void ClearCache(string? userId = null)
        {
            lock (_cacheLock)
            {
                if (userId == null)
                {
                    _cache.Clear();
                }
                else
                {
                    _cache.Remove(userId);
                }
            }
        }

        private static void ValidateUserId(string userId)
        {
            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParse(userId, out _))
            {
                throw new ArgumentException("User ID must be a valid GUID", nameof(userId));
            }
        }
    }
}
