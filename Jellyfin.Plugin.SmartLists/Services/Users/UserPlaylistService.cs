using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.SmartLists.Core;
using Jellyfin.Plugin.SmartLists.Core.Constants;
using Jellyfin.Plugin.SmartLists.Core.Models;
using Jellyfin.Plugin.SmartLists.Services.Shared;
using Jellyfin.Plugin.SmartLists.Utilities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Playlists;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SmartLists.Services.Users
{
    /// <summary>
    /// Service for handling user-created smart playlist operations.
    /// Includes ignore list filtering support.
    /// </summary>
    public class UserPlaylistService
    {
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IPlaylistManager _playlistManager;
        private readonly IUserDataManager _userDataManager;
        private readonly ILogger<UserPlaylistService> _logger;
        private readonly IProviderManager _providerManager;
        private readonly IgnoreStore _ignoreStore;

        public UserPlaylistService(
            IUserManager userManager,
            ILibraryManager libraryManager,
            IPlaylistManager playlistManager,
            IUserDataManager userDataManager,
            ILogger<UserPlaylistService> logger,
            IProviderManager providerManager,
            IgnoreStore ignoreStore)
        {
            _userManager = userManager;
            _libraryManager = libraryManager;
            _playlistManager = playlistManager;
            _userDataManager = userDataManager;
            _logger = logger;
            _providerManager = providerManager;
            _ignoreStore = ignoreStore;
        }

        /// <summary>
        /// Refreshes a user smart playlist, applying rules and ignore list filtering.
        /// </summary>
        public async Task<(bool Success, string Message, string JellyfinPlaylistId)> RefreshAsync(
            UserSmartPlaylistDto dto,
            Action<int, int>? progressCallback = null,
            CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(dto);

            var stopwatch = Stopwatch.StartNew();
            try
            {
                _logger.LogDebug("Refreshing user smart playlist: {PlaylistName} for user {UserId}", dto.Name, dto.UserId);

                // Check if playlist is enabled
                if (!dto.Enabled)
                {
                    _logger.LogDebug("User smart playlist '{PlaylistName}' is disabled. Skipping refresh.", dto.Name);
                    return (true, "Playlist is disabled", string.Empty);
                }

                // Validate media types
                if (dto.MediaTypes == null || dto.MediaTypes.Count == 0)
                {
                    _logger.LogError("User smart playlist '{PlaylistName}' has no media types specified.", dto.Name);
                    return (false, "No media types specified. At least one media type must be selected.", string.Empty);
                }

                if (dto.MediaTypes.Contains(MediaTypes.Series))
                {
                    _logger.LogError("User smart playlist '{PlaylistName}' uses 'Series' media type which is not supported.", dto.Name);
                    return (false, "Series media type is not supported for Playlists. Use Episode media type instead.", string.Empty);
                }

                // Get the user
                var user = GetPlaylistUser(dto);
                if (user == null)
                {
                    _logger.LogWarning("No user found for playlist '{PlaylistName}'. Skipping.", dto.Name);
                    return (false, "No user found for playlist", string.Empty);
                }

                // Get all user media
                var allUserMedia = GetAllUserMedia(user, dto.MediaTypes).ToArray();
                _logger.LogDebug("Found {MediaCount} total media items for user {User}", allUserMedia.Length, user.Username);

                // Report initial total items count
                progressCallback?.Invoke(0, allUserMedia.Length);

                // Apply rules filtering
                var filteredItems = ApplyRulesFiltering(dto, allUserMedia, user, progressCallback);
                _logger.LogDebug("After rules filtering: {FilteredCount} items", filteredItems.Count);

                // Apply ignore list filtering
                var finalItems = await ApplyIgnoreListFilteringAsync(dto, filteredItems).ConfigureAwait(false);
                _logger.LogDebug("After ignore list filtering: {FinalCount} items", finalItems.Count);

                // Create LinkedChild array
                var mediaLookup = allUserMedia.ToDictionary(m => m.Id, m => m);
                var newLinkedChildren = finalItems
                    .Where(itemId => mediaLookup.ContainsKey(itemId))
                    .Select(itemId => new LinkedChild { ItemId = itemId, Path = mediaLookup[itemId].Path })
                    .ToArray();

                // Update statistics
                dto.ItemCount = newLinkedChildren.Length;
                dto.TotalRuntimeMinutes = RuntimeCalculator.CalculateTotalRuntimeMinutes(
                    newLinkedChildren.Where(lc => lc.ItemId.HasValue).Select(lc => lc.ItemId!.Value).ToArray(),
                    mediaLookup,
                    _logger);

                // Find or create the Jellyfin playlist
                var (success, message, jellyfinPlaylistId) = await UpdateOrCreatePlaylistAsync(
                    dto, user, newLinkedChildren, cancellationToken);

                if (success)
                {
                    dto.LastRefreshed = DateTime.UtcNow;
                    if (!string.IsNullOrEmpty(jellyfinPlaylistId))
                    {
                        dto.JellyfinPlaylistId = jellyfinPlaylistId;
                    }
                }

                stopwatch.Stop();
                _logger.LogDebug("User playlist refresh completed in {ElapsedMs}ms: {Message}",
                    stopwatch.ElapsedMilliseconds, message);

                return (success, message, jellyfinPlaylistId);
            }
            catch (Exception ex)
            {
                stopwatch.Stop();
                _logger.LogError(ex, "Error refreshing user playlist '{PlaylistName}' after {ElapsedMs}ms",
                    dto.Name, stopwatch.ElapsedMilliseconds);
                return (false, $"Error refreshing playlist: {ex.Message}", string.Empty);
            }
        }

        /// <summary>
        /// Applies the rule-based filtering to get matching items.
        /// Also includes manually selected items from IncludedItemIds.
        /// </summary>
        private List<Guid> ApplyRulesFiltering(
            UserSmartPlaylistDto dto,
            BaseItem[] allUserMedia,
            User user,
            Action<int, int>? progressCallback)
        {
            var resultItems = new List<Guid>();

            // If we have a source playlist to clone from, use its items
            if (!string.IsNullOrEmpty(dto.SourcePlaylistId) &&
                Guid.TryParse(dto.SourcePlaylistId, out var sourceId))
            {
                var sourcePlaylist = _libraryManager.GetItemById(sourceId) as Playlist;
                if (sourcePlaylist != null)
                {
                    _logger.LogDebug("Using items from source playlist: {SourceName}", sourcePlaylist.Name);
                    var sourceItems = sourcePlaylist.LinkedChildren?
                        .Where(lc => lc.ItemId.HasValue)
                        .Select(lc => lc.ItemId!.Value)
                        .ToList() ?? [];
                    resultItems.AddRange(sourceItems);
                }
            }

            // Add manually included items (from wizard)
            if (dto.IncludedItemIds != null && dto.IncludedItemIds.Count > 0)
            {
                _logger.LogDebug("Adding {Count} manually included items", dto.IncludedItemIds.Count);
                var includedGuids = dto.IncludedItemIds
                    .Where(id => Guid.TryParse(id, out _))
                    .Select(id => Guid.Parse(id))
                    .ToList();
                resultItems.AddRange(includedGuids);
            }

            // Apply expression sets if defined
            if (dto.ExpressionSets != null && dto.ExpressionSets.Count > 0 &&
                dto.ExpressionSets.Any(es => es.Expressions != null && es.Expressions.Count > 0))
            {
                // Create a temporary SmartPlaylistDto to use existing filtering logic
                var tempDto = new SmartPlaylistDto
                {
                    Id = dto.Id,
                    Name = dto.Name,
                    UserId = dto.UserId,
                    ExpressionSets = dto.ExpressionSets,
                    Order = dto.Order,
                    MediaTypes = dto.MediaTypes,
                    MaxItems = dto.MaxItems,
                    MaxPlayTimeMinutes = dto.MaxPlayTimeMinutes
                };

                var smartList = new SmartList(tempDto)
                {
                    UserManager = _userManager
                };

                // Create a temporary RefreshCache
                var refreshCache = new RefreshQueueService.RefreshCache();

                var filteredIds = smartList.FilterPlaylistItems(
                    allUserMedia,
                    _libraryManager,
                    user,
                    refreshCache,
                    _userDataManager,
                    _logger,
                    progressCallback);

                resultItems.AddRange(filteredIds);
            }

            // Remove duplicates while preserving order
            return resultItems.Distinct().ToList();
        }

        /// <summary>
        /// Applies ignore list filtering to remove ignored tracks.
        /// </summary>
        private async Task<List<Guid>> ApplyIgnoreListFilteringAsync(UserSmartPlaylistDto dto, List<Guid> items)
        {
            if (string.IsNullOrEmpty(dto.UserId) || string.IsNullOrEmpty(dto.Id))
            {
                _logger.LogDebug("Skipping ignore filtering - no UserId or playlist Id");
                return items;
            }

            // Get active (non-expired) ignored track IDs for this playlist
            var ignoredTrackIds = await _ignoreStore.GetActiveIgnoredTrackIdsAsync(dto.UserId, dto.Id).ConfigureAwait(false);
            _logger.LogInformation("Found {Count} ignored track IDs for playlist {PlaylistId}: {TrackIds}",
                ignoredTrackIds.Count, dto.Id, string.Join(", ", ignoredTrackIds.Take(5)));

            if (ignoredTrackIds.Count == 0)
            {
                _logger.LogDebug("No ignored tracks to filter");
                return items;
            }

            // Convert string IDs to Guids for filtering
            var ignoredGuids = new HashSet<Guid>(
                ignoredTrackIds
                    .Where(id => Guid.TryParse(id, out _))
                    .Select(id => Guid.Parse(id)));

            _logger.LogInformation("Converted to {Count} ignored Guids: {Guids}",
                ignoredGuids.Count, string.Join(", ", ignoredGuids.Take(5)));

            if (ignoredGuids.Count == 0)
            {
                return items;
            }

            _logger.LogInformation("Input items before filtering: {Count} items", items.Count);
            foreach (var item in items.Take(10))
            {
                var isIgnored = ignoredGuids.Contains(item);
                _logger.LogDebug("Item {ItemId}: ignored={IsIgnored}", item, isIgnored);
            }

            var filtered = items.Where(id => !ignoredGuids.Contains(id)).ToList();

            _logger.LogInformation("After ignore filtering: {FilteredCount} items (removed {RemovedCount})",
                filtered.Count, items.Count - filtered.Count);

            return filtered;
        }

        /// <summary>
        /// Updates an existing Jellyfin playlist or creates a new one.
        /// </summary>
        private async Task<(bool Success, string Message, string JellyfinPlaylistId)> UpdateOrCreatePlaylistAsync(
            UserSmartPlaylistDto dto,
            User user,
            LinkedChild[] linkedChildren,
            CancellationToken cancellationToken)
        {
            Playlist? existingPlaylist = null;

            // Try to find existing playlist by Jellyfin playlist ID
            if (!string.IsNullOrEmpty(dto.JellyfinPlaylistId) &&
                Guid.TryParse(dto.JellyfinPlaylistId, out var jellyfinPlaylistId))
            {
                existingPlaylist = _libraryManager.GetItemById(jellyfinPlaylistId) as Playlist;

                // Detect if the Jellyfin playlist was deleted externally (orphaned)
                if (existingPlaylist == null)
                {
                    _logger.LogWarning("Jellyfin playlist {JellyfinPlaylistId} for smart playlist '{PlaylistName}' no longer exists (orphaned)",
                        dto.JellyfinPlaylistId, dto.Name);
                    // Clear the reference so we can recreate
                    dto.JellyfinPlaylistId = null;
                }
            }

            var playlistName = NameFormatter.FormatPlaylistName(dto.Name);

            if (existingPlaylist != null)
            {
                // Update existing playlist
                _logger.LogInformation("Updating existing user playlist: {PlaylistName} (ID: {PlaylistId})",
                    existingPlaylist.Name, existingPlaylist.Id);

                var oldItemCount = existingPlaylist.LinkedChildren?.Length ?? 0;
                _logger.LogInformation("Current LinkedChildren count: {OldCount}, New count: {NewCount}",
                    oldItemCount, linkedChildren.Length);

                // Log the items being set
                foreach (var child in linkedChildren.Take(5))
                {
                    _logger.LogDebug("Setting LinkedChild: ItemId={ItemId}", child.ItemId);
                }
                if (linkedChildren.Length > 5)
                {
                    _logger.LogDebug("... and {MoreCount} more items", linkedChildren.Length - 5);
                }

                // Update name if changed
                if (existingPlaylist.Name != playlistName)
                {
                    existingPlaylist.Name = playlistName;
                }

                // Update ownership if needed
                if (existingPlaylist.OwnerUserId != user.Id)
                {
                    existingPlaylist.OwnerUserId = user.Id;
                }

                // Update public status
                UpdatePlaylistPublicStatus(existingPlaylist, dto.Public);

                // Update items - clear first to ensure clean state
                existingPlaylist.LinkedChildren = linkedChildren;

                // Set media type
                SetPlaylistMediaType(existingPlaylist, DeterminePlaylistMediaType(dto));

                // Save changes
                _logger.LogInformation("Calling UpdateToRepositoryAsync for playlist {PlaylistId}", existingPlaylist.Id);
                await existingPlaylist.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken);

                // Refresh metadata for cover image
                await RefreshPlaylistMetadataAsync(existingPlaylist, cancellationToken);

                _logger.LogInformation("Playlist update complete. Final LinkedChildren count: {FinalCount}",
                    existingPlaylist.LinkedChildren?.Length ?? 0);

                return (true, $"Updated playlist '{playlistName}' with {linkedChildren.Length} items",
                    existingPlaylist.Id.ToString("N"));
            }
            else
            {
                // Create new playlist
                _logger.LogDebug("Creating new user playlist: {PlaylistName}", playlistName);

                var result = await _playlistManager.CreatePlaylist(new PlaylistCreationRequest
                {
                    Name = playlistName,
                    UserId = user.Id,
                    Public = dto.Public
                });

                if (_libraryManager.GetItemById(result.Id) is Playlist newPlaylist)
                {
                    newPlaylist.LinkedChildren = linkedChildren;
                    SetPlaylistMediaType(newPlaylist, DeterminePlaylistMediaType(dto));
                    await newPlaylist.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken);
                    await RefreshPlaylistMetadataAsync(newPlaylist, cancellationToken);

                    return (true, $"Created playlist '{playlistName}' with {linkedChildren.Length} items",
                        newPlaylist.Id.ToString("N"));
                }

                return (false, $"Failed to create playlist '{playlistName}'", string.Empty);
            }
        }

        /// <summary>
        /// Checks if a smart playlist is orphaned (its Jellyfin playlist was deleted externally).
        /// </summary>
        public bool IsOrphaned(UserSmartPlaylistDto dto)
        {
            if (string.IsNullOrEmpty(dto.JellyfinPlaylistId))
            {
                // No Jellyfin playlist ID means it's not orphaned (it was never created or already cleaned up)
                return false;
            }

            if (!Guid.TryParse(dto.JellyfinPlaylistId, out var jellyfinPlaylistId))
            {
                return false;
            }

            var playlist = _libraryManager.GetItemById(jellyfinPlaylistId) as Playlist;
            return playlist == null;
        }

        /// <summary>
        /// Deletes a user smart playlist and its associated Jellyfin playlist.
        /// </summary>
        public Task DeleteAsync(UserSmartPlaylistDto dto, CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(dto);

            try
            {
                if (!string.IsNullOrEmpty(dto.JellyfinPlaylistId) &&
                    Guid.TryParse(dto.JellyfinPlaylistId, out var jellyfinPlaylistId))
                {
                    var playlist = _libraryManager.GetItemById(jellyfinPlaylistId) as Playlist;
                    if (playlist != null)
                    {
                        _logger.LogInformation("Deleting Jellyfin playlist '{PlaylistName}' (ID: {PlaylistId})",
                            playlist.Name, playlist.Id);
                        _libraryManager.DeleteItem(playlist, new DeleteOptions { DeleteFileLocation = true }, true);
                    }
                }

                return Task.CompletedTask;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error deleting user smart playlist {PlaylistName}", dto.Name);
                throw;
            }
        }

        private User? GetPlaylistUser(UserSmartPlaylistDto dto)
        {
            if (!string.IsNullOrEmpty(dto.UserId) && Guid.TryParse(dto.UserId, out var userId) && userId != Guid.Empty)
            {
                return _userManager.GetUserById(userId);
            }
            return null;
        }

        private IEnumerable<BaseItem> GetAllUserMedia(User user, List<string>? mediaTypes)
        {
            var query = new InternalItemsQuery(user)
            {
                IncludeItemTypes = MediaTypeConverter.GetBaseItemKindsFromMediaTypes(mediaTypes, null, _logger),
                Recursive = true
            };
            return _libraryManager.GetItemsResult(query).Items;
        }

        private static void UpdatePlaylistPublicStatus(Playlist playlist, bool isPublic)
        {
            var openAccessProperty = playlist.GetType().GetProperty("OpenAccess");
            if (openAccessProperty != null && openAccessProperty.CanWrite)
            {
                openAccessProperty.SetValue(playlist, isPublic);
            }
        }

        private static string DeterminePlaylistMediaType(UserSmartPlaylistDto dto)
        {
            if (dto.MediaTypes?.Count > 0)
            {
                if (dto.MediaTypes.All(mt => MediaTypes.AudioOnlySet.Contains(mt)))
                {
                    return MediaTypes.Audio;
                }

                bool hasVideoContent = dto.MediaTypes.Any(mt => MediaTypes.NonAudioSet.Contains(mt));
                bool hasAudioContent = dto.MediaTypes.Any(mt => MediaTypes.AudioOnlySet.Contains(mt));

                if (hasVideoContent && !hasAudioContent)
                {
                    return MediaTypes.Video;
                }
            }
            return MediaTypes.Audio;
        }

        private void SetPlaylistMediaType(Playlist playlist, string mediaType)
        {
            try
            {
                var playlistMediaTypeProperty = playlist.GetType().GetProperty("PlaylistMediaType");
                if (playlistMediaTypeProperty != null && playlistMediaTypeProperty.CanWrite)
                {
                    object mediaTypeValue;
                    if (playlistMediaTypeProperty.PropertyType == typeof(string))
                    {
                        mediaTypeValue = mediaType;
                    }
                    else if (playlistMediaTypeProperty.PropertyType.IsEnum)
                    {
                        if (Enum.TryParse(playlistMediaTypeProperty.PropertyType, mediaType, true, out var enumValue))
                        {
                            mediaTypeValue = enumValue;
                        }
                        else
                        {
                            return;
                        }
                    }
                    else if (playlistMediaTypeProperty.PropertyType.IsGenericType &&
                             playlistMediaTypeProperty.PropertyType.GetGenericTypeDefinition() == typeof(Nullable<>))
                    {
                        var underlyingType = Nullable.GetUnderlyingType(playlistMediaTypeProperty.PropertyType);
                        if (underlyingType != null && underlyingType.IsEnum)
                        {
                            if (Enum.TryParse(underlyingType, mediaType, true, out var enumValue))
                            {
                                mediaTypeValue = enumValue;
                            }
                            else
                            {
                                return;
                            }
                        }
                        else
                        {
                            mediaTypeValue = mediaType;
                        }
                    }
                    else
                    {
                        mediaTypeValue = mediaType;
                    }

                    playlistMediaTypeProperty.SetValue(playlist, mediaTypeValue);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error setting playlist MediaType to {MediaType}", mediaType);
            }
        }

        private async Task RefreshPlaylistMetadataAsync(Playlist playlist, CancellationToken cancellationToken)
        {
            try
            {
                var directoryService = new BasicDirectoryService();
                var refreshOptions = new MetadataRefreshOptions(directoryService)
                {
                    MetadataRefreshMode = MetadataRefreshMode.Default,
                    ImageRefreshMode = MetadataRefreshMode.Default,
                    ReplaceAllMetadata = true,
                    ReplaceAllImages = true
                };

                await _providerManager.RefreshSingleItem(playlist, refreshOptions, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to refresh metadata for playlist {PlaylistName}", playlist.Name);
            }
        }
    }
}
