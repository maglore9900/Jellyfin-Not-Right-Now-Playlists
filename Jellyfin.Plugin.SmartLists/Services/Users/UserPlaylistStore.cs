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
    /// Store implementation for user-created smart playlists.
    /// Each user has their own isolated storage directory.
    /// </summary>
    public class UserPlaylistStore
    {
        private readonly ISmartListFileSystem _fileSystem;
        private readonly ILogger<UserPlaylistStore>? _logger;

        public UserPlaylistStore(ISmartListFileSystem fileSystem, ILogger<UserPlaylistStore>? logger = null)
        {
            _fileSystem = fileSystem;
            _logger = logger;
        }

        /// <summary>
        /// Gets a user smart playlist by ID.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <param name="playlistId">The playlist ID.</param>
        /// <returns>The playlist, or null if not found.</returns>
        public async Task<UserSmartPlaylistDto?> GetByIdAsync(string userId, string playlistId)
        {
            if (!Guid.TryParse(userId, out _) || !Guid.TryParse(playlistId, out _))
            {
                return null;
            }

            var filePath = _fileSystem.GetUserPlaylistPath(userId, playlistId);
            if (!File.Exists(filePath))
            {
                return null;
            }

            try
            {
                await using var stream = File.OpenRead(filePath);
                var playlist = await JsonSerializer.DeserializeAsync<UserSmartPlaylistDto>(
                    stream, SmartListFileSystem.SharedJsonOptions).ConfigureAwait(false);

                // Verify the playlist belongs to this user
                if (playlist != null && !string.Equals(playlist.UserId, userId, StringComparison.OrdinalIgnoreCase))
                {
                    _logger?.LogWarning("Playlist {PlaylistId} does not belong to user {UserId}", playlistId, userId);
                    return null;
                }

                return playlist;
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "Failed to load user playlist {PlaylistId} for user {UserId}", playlistId, userId);
                return null;
            }
        }

        /// <summary>
        /// Gets all smart playlists for a specific user.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <returns>Array of user's smart playlists.</returns>
        public async Task<UserSmartPlaylistDto[]> GetAllAsync(string userId)
        {
            if (!Guid.TryParse(userId, out _))
            {
                return [];
            }

            var filePaths = _fileSystem.GetAllUserPlaylistFilePaths(userId);
            var playlists = new List<UserSmartPlaylistDto>();

            foreach (var filePath in filePaths)
            {
                try
                {
                    await using var stream = File.OpenRead(filePath);
                    var playlist = await JsonSerializer.DeserializeAsync<UserSmartPlaylistDto>(
                        stream, SmartListFileSystem.SharedJsonOptions).ConfigureAwait(false);

                    if (playlist != null && string.Equals(playlist.UserId, userId, StringComparison.OrdinalIgnoreCase))
                    {
                        playlists.Add(playlist);
                    }
                }
                catch (Exception ex)
                {
                    _logger?.LogWarning(ex, "Skipping invalid user playlist file {FilePath}", filePath);
                }
            }

            return playlists.ToArray();
        }

        /// <summary>
        /// Saves a user smart playlist.
        /// </summary>
        /// <param name="playlist">The playlist to save.</param>
        /// <returns>The saved playlist.</returns>
        public async Task<UserSmartPlaylistDto> SaveAsync(UserSmartPlaylistDto playlist)
        {
            ArgumentNullException.ThrowIfNull(playlist);

            // Validate user ID
            if (string.IsNullOrWhiteSpace(playlist.UserId) || !Guid.TryParse(playlist.UserId, out var parsedUserId))
            {
                throw new ArgumentException("Playlist must have a valid user ID", nameof(playlist));
            }

            // Generate ID if not provided
            if (string.IsNullOrWhiteSpace(playlist.Id) || !Guid.TryParse(playlist.Id, out _))
            {
                playlist.Id = Guid.NewGuid().ToString();
            }

            // Set creation date if new
            playlist.DateCreated ??= DateTime.UtcNow;

            // Normalize user ID
            playlist.UserId = parsedUserId.ToString();

            var filePath = _fileSystem.GetUserPlaylistPath(playlist.UserId, playlist.Id);
            var tempPath = filePath + ".tmp";

            try
            {
                await using (var writer = File.Create(tempPath))
                {
                    await JsonSerializer.SerializeAsync(writer, playlist, SmartListFileSystem.SharedJsonOptions)
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

                _logger?.LogDebug("Saved user playlist {PlaylistId} for user {UserId}", playlist.Id, playlist.UserId);
            }
            finally
            {
                // Clean up temp file if it still exists
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

            return playlist;
        }

        /// <summary>
        /// Deletes a user smart playlist.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <param name="playlistId">The playlist ID.</param>
        public Task DeleteAsync(string userId, string playlistId)
        {
            if (!Guid.TryParse(userId, out _) || !Guid.TryParse(playlistId, out _))
            {
                throw new ArgumentException("User ID and Playlist ID must be valid GUIDs");
            }

            var filePath = _fileSystem.GetUserPlaylistPath(userId, playlistId);
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
                _logger?.LogDebug("Deleted user playlist {PlaylistId} for user {UserId}", playlistId, userId);
            }

            return Task.CompletedTask;
        }

        /// <summary>
        /// Checks if a user has any smart playlists.
        /// </summary>
        /// <param name="userId">The user ID.</param>
        /// <returns>True if the user has smart playlists.</returns>
        public bool HasPlaylists(string userId)
        {
            if (!Guid.TryParse(userId, out _))
            {
                return false;
            }

            var filePaths = _fileSystem.GetAllUserPlaylistFilePaths(userId);
            return filePaths.Length > 0;
        }

        /// <summary>
        /// Gets all user IDs that have smart playlists.
        /// </summary>
        /// <returns>List of user IDs.</returns>
        public Task<List<string>> GetAllUserIdsAsync()
        {
            var userIds = _fileSystem.GetAllUserIds().ToList();
            return Task.FromResult(userIds);
        }
    }
}
