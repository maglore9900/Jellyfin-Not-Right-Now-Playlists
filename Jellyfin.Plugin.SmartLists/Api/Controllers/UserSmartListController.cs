using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.SmartLists.Core.Models;
using Jellyfin.Plugin.SmartLists.Services.Shared;
using Jellyfin.Plugin.SmartLists.Services.Users;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SmartLists.Api.Controllers
{
    /// <summary>
    /// API controller for user-created smart playlists.
    /// This is separate from the admin SmartListController and uses regular user authorization.
    /// </summary>
    [ApiController]
    [Authorize] // Regular user auth, not RequiresElevation
    [Route("Plugins/SmartLists/User")]
    [Produces("application/json")]
    public class UserSmartListController : ControllerBase
    {
        private readonly ILogger<UserSmartListController> _logger;
        private readonly IServerApplicationPaths _applicationPaths;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IPlaylistManager _playlistManager;
        private readonly UserPlaylistService _userPlaylistService;
        private readonly UserPlaylistStore _userPlaylistStore;
        private readonly IgnoreStore _ignoreStore;
        private readonly ISmartListFileSystem _fileSystem;

        public UserSmartListController(
            ILogger<UserSmartListController> logger,
            IServerApplicationPaths applicationPaths,
            IUserManager userManager,
            ILibraryManager libraryManager,
            IPlaylistManager playlistManager,
            UserPlaylistService userPlaylistService,
            UserPlaylistStore userPlaylistStore,
            IgnoreStore ignoreStore,
            ISmartListFileSystem fileSystem)
        {
            _logger = logger;
            _applicationPaths = applicationPaths;
            _userManager = userManager;
            _libraryManager = libraryManager;
            _playlistManager = playlistManager;
            _userPlaylistService = userPlaylistService;
            _userPlaylistStore = userPlaylistStore;
            _ignoreStore = ignoreStore;
            _fileSystem = fileSystem;
        }

        private UserPlaylistStore GetUserPlaylistStore()
        {
            return _userPlaylistStore;
        }

        private IgnoreStore GetIgnoreStore()
        {
            return _ignoreStore;
        }

        /// <summary>
        /// Gets the current user ID from Jellyfin claims.
        /// </summary>
        private Guid GetCurrentUserId()
        {
            try
            {
                var userIdClaim = User.FindFirst("Jellyfin-UserId")?.Value;
                if (!string.IsNullOrEmpty(userIdClaim) && Guid.TryParse(userIdClaim, out var userId))
                {
                    return userId;
                }

                _logger.LogWarning("Could not determine current user ID from Jellyfin-UserId claim");
                return Guid.Empty;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error getting current user ID");
                return Guid.Empty;
            }
        }

        // ==================== Smart Playlist CRUD ====================

        /// <summary>
        /// Gets all smart playlists for the current user.
        /// </summary>
        [HttpGet]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public async Task<ActionResult<IEnumerable<UserSmartPlaylistDto>>> GetAll()
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            var store = GetUserPlaylistStore();
            var ignoreStore = GetIgnoreStore();
            var playlists = await store.GetAllAsync(userId.ToString()).ConfigureAwait(false);

            // Check for and clean up orphaned playlists (Jellyfin playlist deleted externally)
            var validPlaylists = new List<UserSmartPlaylistDto>();
            foreach (var playlist in playlists)
            {
                if (_userPlaylistService.IsOrphaned(playlist))
                {
                    _logger.LogInformation("Smart playlist '{PlaylistName}' is orphaned (Jellyfin playlist deleted). Removing configuration.", playlist.Name);
                    await store.DeleteAsync(userId.ToString(), playlist.Id).ConfigureAwait(false);
                    await ignoreStore.RemoveAllForPlaylistAsync(userId.ToString(), playlist.Id).ConfigureAwait(false);
                    continue;
                }

                // Populate ignore count
                playlist.IgnoreCount = await ignoreStore.GetActiveCountAsync(userId.ToString(), playlist.Id).ConfigureAwait(false);
                validPlaylists.Add(playlist);
            }

            _logger.LogDebug("Retrieved {Count} smart playlists for user {UserId}", validPlaylists.Count, userId);
            return Ok(validPlaylists);
        }

        /// <summary>
        /// Gets a smart playlist by its Jellyfin playlist ID.
        /// Used by the context menu integration to determine if a playlist is a smart playlist.
        /// </summary>
        [HttpGet("ByJellyfinPlaylistId/{jellyfinPlaylistId}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<UserSmartPlaylistDto>> GetByJellyfinPlaylistId(string jellyfinPlaylistId)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(jellyfinPlaylistId, out _))
            {
                return BadRequest("Invalid Jellyfin playlist ID format");
            }

            var store = GetUserPlaylistStore();
            var playlists = await store.GetAllAsync(userId.ToString()).ConfigureAwait(false);

            // Find the smart playlist that has this Jellyfin playlist ID
            var playlist = playlists.FirstOrDefault(p =>
                string.Equals(p.JellyfinPlaylistId, jellyfinPlaylistId, StringComparison.OrdinalIgnoreCase));

            if (playlist == null)
            {
                return NotFound($"No smart playlist found for Jellyfin playlist {jellyfinPlaylistId}");
            }

            return Ok(playlist);
        }

        /// <summary>
        /// Gets a specific smart playlist by ID.
        /// </summary>
        [HttpGet("{id}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<UserSmartPlaylistDto>> GetById(string id)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(id, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            var store = GetUserPlaylistStore();
            var playlist = await store.GetByIdAsync(userId.ToString(), id).ConfigureAwait(false);

            if (playlist == null)
            {
                return NotFound($"Playlist {id} not found");
            }

            return Ok(playlist);
        }

        /// <summary>
        /// Creates a new smart playlist for the current user.
        /// </summary>
        [HttpPost]
        [ProducesResponseType(StatusCodes.Status201Created)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public async Task<ActionResult<UserSmartPlaylistDto>> Create([FromBody] UserSmartPlaylistDto playlist)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (string.IsNullOrWhiteSpace(playlist.Name))
            {
                return BadRequest("Playlist name is required");
            }

            // Set user ID and generate new ID
            playlist.UserId = userId.ToString();
            playlist.Id = Guid.NewGuid().ToString();
            playlist.DateCreated = DateTime.UtcNow;

            // If cloning from a source playlist, copy items to IncludedItemIds
            // This gives us a stable "original list" that we own
            if (!string.IsNullOrEmpty(playlist.SourcePlaylistId) &&
                Guid.TryParse(playlist.SourcePlaylistId, out var sourceId))
            {
                var sourcePlaylist = _libraryManager.GetItemById(sourceId) as Playlist;
                if (sourcePlaylist?.LinkedChildren != null)
                {
                    playlist.IncludedItemIds ??= [];
                    foreach (var child in sourcePlaylist.LinkedChildren)
                    {
                        if (child.ItemId.HasValue)
                        {
                            // Use Jellyfin's format (no dashes) for consistency
                            var itemIdStr = child.ItemId.Value.ToString("N");
                            if (!playlist.IncludedItemIds.Contains(itemIdStr, StringComparer.OrdinalIgnoreCase))
                            {
                                playlist.IncludedItemIds.Add(itemIdStr);
                            }
                        }
                    }
                    _logger.LogDebug("Copied {Count} items from source playlist to IncludedItemIds", playlist.IncludedItemIds.Count);
                }
            }

            var store = GetUserPlaylistStore();
            var saved = await store.SaveAsync(playlist).ConfigureAwait(false);

            _logger.LogInformation("Created smart playlist {PlaylistId} '{Name}' for user {UserId}",
                saved.Id, saved.Name, userId);

            // Immediately refresh to create the Jellyfin playlist and populate items
            var (success, message, jellyfinPlaylistId) = await _userPlaylistService.RefreshAsync(saved).ConfigureAwait(false);
            if (success)
            {
                // Save the updated playlist with JellyfinPlaylistId and item count
                await store.SaveAsync(saved).ConfigureAwait(false);
                _logger.LogInformation("Created Jellyfin playlist {JellyfinPlaylistId} for smart playlist {PlaylistId}",
                    jellyfinPlaylistId, saved.Id);
            }
            else
            {
                _logger.LogWarning("Failed to create Jellyfin playlist for {PlaylistId}: {Message}",
                    saved.Id, message);
            }

            return CreatedAtAction(nameof(GetById), new { id = saved.Id }, saved);
        }

        /// <summary>
        /// Updates an existing smart playlist.
        /// </summary>
        [HttpPut("{id}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<UserSmartPlaylistDto>> Update(string id, [FromBody] UserSmartPlaylistDto playlist)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(id, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            var store = GetUserPlaylistStore();
            var existing = await store.GetByIdAsync(userId.ToString(), id).ConfigureAwait(false);

            if (existing == null)
            {
                return NotFound($"Playlist {id} not found");
            }

            // Preserve ID and user ID
            playlist.Id = id;
            playlist.UserId = userId.ToString();
            playlist.DateCreated = existing.DateCreated;

            var saved = await store.SaveAsync(playlist).ConfigureAwait(false);

            _logger.LogInformation("Updated smart playlist {PlaylistId} '{Name}' for user {UserId}",
                saved.Id, saved.Name, userId);

            return Ok(saved);
        }

        /// <summary>
        /// Deletes a smart playlist.
        /// </summary>
        /// <param name="id">The smart playlist ID.</param>
        /// <param name="deleteJellyfinPlaylist">If true, also delete the associated Jellyfin playlist.</param>
        [HttpDelete("{id}")]
        [ProducesResponseType(StatusCodes.Status204NoContent)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult> Delete(string id, [FromQuery] bool deleteJellyfinPlaylist = false)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(id, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            var store = GetUserPlaylistStore();
            var existing = await store.GetByIdAsync(userId.ToString(), id).ConfigureAwait(false);

            if (existing == null)
            {
                return NotFound($"Playlist {id} not found");
            }

            // Optionally delete the Jellyfin playlist
            if (deleteJellyfinPlaylist && !string.IsNullOrEmpty(existing.JellyfinPlaylistId))
            {
                await _userPlaylistService.DeleteAsync(existing).ConfigureAwait(false);
                _logger.LogInformation("Deleted Jellyfin playlist {JellyfinPlaylistId} for smart playlist {PlaylistId}",
                    existing.JellyfinPlaylistId, id);
            }

            // Delete the smart playlist config
            await store.DeleteAsync(userId.ToString(), id).ConfigureAwait(false);

            // Also delete associated ignores
            var ignoreStore = GetIgnoreStore();
            await ignoreStore.RemoveAllForPlaylistAsync(userId.ToString(), id).ConfigureAwait(false);

            _logger.LogInformation("Deleted smart playlist {PlaylistId} for user {UserId}", id, userId);

            return NoContent();
        }

        // ==================== Refresh Operations ====================

        /// <summary>
        /// Refreshes a specific smart playlist.
        /// </summary>
        [HttpPost("{id}/refresh")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<RefreshResult>> RefreshPlaylist(string id)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(id, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            var store = GetUserPlaylistStore();
            var playlist = await store.GetByIdAsync(userId.ToString(), id).ConfigureAwait(false);

            if (playlist == null)
            {
                return NotFound($"Playlist {id} not found");
            }

            _logger.LogInformation("Refreshing smart playlist {PlaylistId} for user {UserId}", id, userId);

            var (success, message, jellyfinPlaylistId) = await _userPlaylistService.RefreshAsync(playlist).ConfigureAwait(false);

            if (success)
            {
                // Save the updated playlist (with new JellyfinPlaylistId if created)
                await store.SaveAsync(playlist).ConfigureAwait(false);
            }

            return Ok(new RefreshResult
            {
                Success = success,
                Message = message,
                JellyfinPlaylistId = jellyfinPlaylistId,
                ItemCount = playlist.ItemCount,
                TotalRuntimeMinutes = playlist.TotalRuntimeMinutes
            });
        }

        /// <summary>
        /// Refreshes all smart playlists for the current user.
        /// </summary>
        [HttpPost("refresh")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public async Task<ActionResult<RefreshAllResult>> RefreshAll()
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            var store = GetUserPlaylistStore();
            var playlists = await store.GetAllAsync(userId.ToString()).ConfigureAwait(false);

            var results = new List<RefreshResult>();
            var successCount = 0;
            var failureCount = 0;

            foreach (var playlist in playlists.Where(p => p.Enabled))
            {
                _logger.LogDebug("Refreshing smart playlist {PlaylistName} for user {UserId}", playlist.Name, userId);

                var (success, message, jellyfinPlaylistId) = await _userPlaylistService.RefreshAsync(playlist).ConfigureAwait(false);

                if (success)
                {
                    await store.SaveAsync(playlist).ConfigureAwait(false);
                    successCount++;
                }
                else
                {
                    failureCount++;
                }

                results.Add(new RefreshResult
                {
                    PlaylistId = playlist.Id,
                    PlaylistName = playlist.Name,
                    Success = success,
                    Message = message,
                    JellyfinPlaylistId = jellyfinPlaylistId,
                    ItemCount = playlist.ItemCount,
                    TotalRuntimeMinutes = playlist.TotalRuntimeMinutes
                });
            }

            _logger.LogInformation("Refreshed {SuccessCount} playlists successfully, {FailureCount} failed for user {UserId}",
                successCount, failureCount, userId);

            return Ok(new RefreshAllResult
            {
                TotalPlaylists = results.Count,
                SuccessCount = successCount,
                FailureCount = failureCount,
                Results = results
            });
        }

        /// <summary>
        /// Result of a single playlist refresh.
        /// </summary>
        public class RefreshResult
        {
            public string? PlaylistId { get; set; }
            public string? PlaylistName { get; set; }
            public bool Success { get; set; }
            public string? Message { get; set; }
            public string? JellyfinPlaylistId { get; set; }
            public int? ItemCount { get; set; }
            public double? TotalRuntimeMinutes { get; set; }
        }

        /// <summary>
        /// Result of refreshing all playlists.
        /// </summary>
        public class RefreshAllResult
        {
            public int TotalPlaylists { get; set; }
            public int SuccessCount { get; set; }
            public int FailureCount { get; set; }
            public List<RefreshResult> Results { get; set; } = [];
        }

        // ==================== Playlist Items ====================

        /// <summary>
        /// Gets all items in a smart playlist from the SOURCE (IncludedItemIds) with their ignore status.
        /// This returns the ORIGINAL list before ignore filtering, so users can see all items and toggle ignores.
        /// </summary>
        [HttpGet("{playlistId}/items")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<PlaylistItemsResult>> GetPlaylistItems(string playlistId, [FromQuery] string? search = null)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(playlistId, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            // Verify smart playlist exists and belongs to user
            var playlistStore = GetUserPlaylistStore();
            var smartPlaylist = await playlistStore.GetByIdAsync(userId.ToString(), playlistId).ConfigureAwait(false);
            if (smartPlaylist == null)
            {
                return NotFound($"Smart playlist {playlistId} not found");
            }

            // Get all ignored track IDs for this playlist (including expired for display)
            var ignoreStore = GetIgnoreStore();
            var ignores = await ignoreStore.GetForPlaylistAsync(userId.ToString(), playlistId, includeExpired: false).ConfigureAwait(false);

            // Build a map of TrackId -> IgnoredTrack, normalizing Guid format for reliable lookup
            var ignoredTrackMap = new Dictionary<Guid, IgnoredTrack>();
            foreach (var ignore in ignores)
            {
                if (Guid.TryParse(ignore.TrackId, out var trackGuid))
                {
                    ignoredTrackMap[trackGuid] = ignore;
                }
            }

            // Get source item IDs - this is the ORIGINAL list before ignore filtering
            var sourceItemGuids = new List<Guid>();

            // Priority 1: IncludedItemIds (items explicitly added via wizard or cloned from source)
            if (smartPlaylist.IncludedItemIds != null && smartPlaylist.IncludedItemIds.Count > 0)
            {
                foreach (var itemIdStr in smartPlaylist.IncludedItemIds)
                {
                    if (Guid.TryParse(itemIdStr, out var itemGuid))
                    {
                        sourceItemGuids.Add(itemGuid);
                    }
                }
                _logger.LogDebug("Using {Count} items from IncludedItemIds for playlist {PlaylistId}",
                    sourceItemGuids.Count, playlistId);
            }

            // Priority 2: If no IncludedItemIds, try to get from source playlist
            if (sourceItemGuids.Count == 0 && !string.IsNullOrEmpty(smartPlaylist.SourcePlaylistId) &&
                Guid.TryParse(smartPlaylist.SourcePlaylistId, out var sourcePlaylistGuid))
            {
                var sourcePlaylist = _libraryManager.GetItemById(sourcePlaylistGuid) as MediaBrowser.Controller.Playlists.Playlist;
                if (sourcePlaylist?.LinkedChildren != null)
                {
                    foreach (var child in sourcePlaylist.LinkedChildren)
                    {
                        if (child.ItemId.HasValue)
                        {
                            sourceItemGuids.Add(child.ItemId.Value);
                        }
                    }
                    _logger.LogDebug("Using {Count} items from source playlist for playlist {PlaylistId}",
                        sourceItemGuids.Count, playlistId);
                }
            }

            // Priority 3: Fall back to current Jellyfin playlist + ignored items
            if (sourceItemGuids.Count == 0 && !string.IsNullOrEmpty(smartPlaylist.JellyfinPlaylistId) &&
                Guid.TryParse(smartPlaylist.JellyfinPlaylistId, out var jellyfinPlaylistGuid))
            {
                var jellyfinPlaylist = _libraryManager.GetItemById(jellyfinPlaylistGuid) as MediaBrowser.Controller.Playlists.Playlist;
                if (jellyfinPlaylist?.LinkedChildren != null)
                {
                    foreach (var child in jellyfinPlaylist.LinkedChildren)
                    {
                        if (child.ItemId.HasValue)
                        {
                            sourceItemGuids.Add(child.ItemId.Value);
                        }
                    }
                }
                // Also add ignored items that may not be in the Jellyfin playlist
                foreach (var ignore in ignores)
                {
                    if (Guid.TryParse(ignore.TrackId, out var trackGuid) && !sourceItemGuids.Contains(trackGuid))
                    {
                        sourceItemGuids.Add(trackGuid);
                    }
                }
                _logger.LogDebug("Using {Count} items from Jellyfin playlist + ignores for playlist {PlaylistId}",
                    sourceItemGuids.Count, playlistId);
            }

            // Remove duplicates while preserving order
            sourceItemGuids = sourceItemGuids.Distinct().ToList();

            // Build the items list with ignore status
            var items = new List<PlaylistItemInfo>();
            foreach (var itemGuid in sourceItemGuids)
            {
                var item = _libraryManager.GetItemById(itemGuid);
                if (item == null)
                    continue;

                // Apply search filter if specified
                if (!string.IsNullOrWhiteSpace(search))
                {
                    var nameMatch = item.Name?.Contains(search, StringComparison.OrdinalIgnoreCase) == true;

                    string? artistName = null;
                    string? albumName = null;
                    if (item is MediaBrowser.Controller.Entities.Audio.Audio audio)
                    {
                        artistName = string.Join(", ", audio.Artists);
                        albumName = audio.Album;
                    }

                    var artistMatch = artistName?.Contains(search, StringComparison.OrdinalIgnoreCase) == true;
                    var albumMatch = albumName?.Contains(search, StringComparison.OrdinalIgnoreCase) == true;

                    if (!nameMatch && !artistMatch && !albumMatch)
                        continue;
                }

                // Check if this item is ignored (use Guid comparison for reliability)
                IgnoredTrack? ignoreInfo = null;
                ignoredTrackMap.TryGetValue(itemGuid, out ignoreInfo);

                var playlistItem = new PlaylistItemInfo
                {
                    Id = itemGuid.ToString("N"), // Use Jellyfin's format (no dashes)
                    Name = item.Name ?? "Unknown",
                    RuntimeTicks = item.RunTimeTicks,
                    IsIgnored = ignoreInfo != null,
                    IgnoreExpiresAt = ignoreInfo?.ExpiresAt,
                    IgnoreId = ignoreInfo?.Id,
                    IsPermanentIgnore = ignoreInfo != null && !ignoreInfo.ExpiresAt.HasValue
                };

                // Add audio-specific metadata
                if (item is MediaBrowser.Controller.Entities.Audio.Audio audioItem)
                {
                    playlistItem.Artist = string.Join(", ", audioItem.Artists);
                    playlistItem.Album = audioItem.Album;
                }
                else if (item is MediaBrowser.Controller.Entities.Video videoItem)
                {
                    playlistItem.Artist = null;
                    playlistItem.Album = videoItem.Album;
                }

                items.Add(playlistItem);
            }

            return Ok(new PlaylistItemsResult
            {
                PlaylistId = playlistId,
                JellyfinPlaylistId = smartPlaylist.JellyfinPlaylistId,
                Items = items,
                TotalCount = items.Count
            });
        }

        /// <summary>
        /// Removes items from a smart playlist's IncludedItemIds.
        /// </summary>
        [HttpPost("{playlistId}/remove-items")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<RemoveItemsResult>> RemoveItems(string playlistId, [FromBody] RemoveItemsRequest request)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(playlistId, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            if (request.ItemIds == null || request.ItemIds.Count == 0)
            {
                return BadRequest("No item IDs provided");
            }

            // Verify playlist exists and belongs to user
            var playlistStore = GetUserPlaylistStore();
            var playlist = await playlistStore.GetByIdAsync(userId.ToString(), playlistId).ConfigureAwait(false);
            if (playlist == null)
            {
                return NotFound($"Playlist {playlistId} not found");
            }

            // If IncludedItemIds is empty, populate it from available sources
            // This handles playlists where items are displayed from other sources but not yet tracked in IncludedItemIds
            if (playlist.IncludedItemIds == null || playlist.IncludedItemIds.Count == 0)
            {
                playlist.IncludedItemIds = [];

                // Try SourcePlaylistId first (Priority 2 in GetPlaylistItems)
                if (!string.IsNullOrEmpty(playlist.SourcePlaylistId) &&
                    Guid.TryParse(playlist.SourcePlaylistId, out var sourcePlaylistGuid))
                {
                    var sourcePlaylist = _libraryManager.GetItemById(sourcePlaylistGuid) as Playlist;
                    if (sourcePlaylist?.LinkedChildren != null)
                    {
                        foreach (var child in sourcePlaylist.LinkedChildren)
                        {
                            if (child.ItemId.HasValue)
                            {
                                playlist.IncludedItemIds.Add(child.ItemId.Value.ToString("N"));
                            }
                        }
                        _logger.LogDebug("Populated IncludedItemIds with {Count} items from source playlist for {PlaylistId}",
                            playlist.IncludedItemIds.Count, playlistId);
                    }
                }

                // If still empty, try JellyfinPlaylistId (Priority 3 in GetPlaylistItems)
                if (playlist.IncludedItemIds.Count == 0 &&
                    !string.IsNullOrEmpty(playlist.JellyfinPlaylistId) &&
                    Guid.TryParse(playlist.JellyfinPlaylistId, out var jellyfinPlaylistGuid))
                {
                    var jellyfinPlaylist = _libraryManager.GetItemById(jellyfinPlaylistGuid) as Playlist;
                    if (jellyfinPlaylist?.LinkedChildren != null)
                    {
                        foreach (var child in jellyfinPlaylist.LinkedChildren)
                        {
                            if (child.ItemId.HasValue)
                            {
                                playlist.IncludedItemIds.Add(child.ItemId.Value.ToString("N"));
                            }
                        }
                        _logger.LogDebug("Populated IncludedItemIds with {Count} items from Jellyfin playlist for {PlaylistId}",
                            playlist.IncludedItemIds.Count, playlistId);
                    }
                }
            }

            // Remove items from IncludedItemIds
            var removed = 0;
            if (playlist.IncludedItemIds != null)
            {
                foreach (var itemId in request.ItemIds)
                {
                    // Parse as GUID to handle different formats (with/without dashes)
                    if (Guid.TryParse(itemId, out var incomingGuid))
                    {
                        // Find matching item by GUID comparison (handles format differences)
                        var existingItem = playlist.IncludedItemIds
                            .FirstOrDefault(id => Guid.TryParse(id, out var storedGuid) && storedGuid == incomingGuid);
                        if (existingItem != null && playlist.IncludedItemIds.Remove(existingItem))
                        {
                            removed++;
                        }
                    }
                }
            }

            if (removed > 0)
            {
                // Save the updated playlist
                await playlistStore.SaveAsync(playlist).ConfigureAwait(false);

                _logger.LogInformation("Removed {Count} items from playlist {PlaylistId} for user {UserId}",
                    removed, playlistId, userId);

                // Refresh the playlist to update the Jellyfin playlist
                var (success, _, _) = await _userPlaylistService.RefreshAsync(playlist).ConfigureAwait(false);
                if (success)
                {
                    await playlistStore.SaveAsync(playlist).ConfigureAwait(false);
                }
            }

            return Ok(new RemoveItemsResult
            {
                Removed = removed,
                ItemCount = playlist.ItemCount
            });
        }

        /// <summary>
        /// Adds items to a smart playlist's IncludedItemIds.
        /// </summary>
        [HttpPost("{playlistId}/add-items")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<AddItemsResult>> AddItems(string playlistId, [FromBody] AddItemsRequest request)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(playlistId, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            if (request.ItemIds == null || request.ItemIds.Count == 0)
            {
                return BadRequest("No item IDs provided");
            }

            // Verify playlist exists and belongs to user
            var playlistStore = GetUserPlaylistStore();
            var playlist = await playlistStore.GetByIdAsync(userId.ToString(), playlistId).ConfigureAwait(false);
            if (playlist == null)
            {
                return NotFound($"Playlist {playlistId} not found");
            }

            // Add items to IncludedItemIds
            playlist.IncludedItemIds ??= [];
            var added = 0;

            foreach (var itemId in request.ItemIds)
            {
                // Only add if not already present (case-insensitive)
                if (!playlist.IncludedItemIds.Any(id => string.Equals(id, itemId, StringComparison.OrdinalIgnoreCase)))
                {
                    playlist.IncludedItemIds.Add(itemId);
                    added++;
                }
            }

            if (added > 0)
            {
                // Save the updated playlist
                await playlistStore.SaveAsync(playlist).ConfigureAwait(false);

                _logger.LogInformation("Added {Count} items to playlist {PlaylistId} for user {UserId}",
                    added, playlistId, userId);

                // Refresh the playlist to update the Jellyfin playlist
                var (success, _, _) = await _userPlaylistService.RefreshAsync(playlist).ConfigureAwait(false);
                if (success)
                {
                    await playlistStore.SaveAsync(playlist).ConfigureAwait(false);
                }
            }

            return Ok(new AddItemsResult
            {
                Added = added,
                ItemCount = playlist.ItemCount
            });
        }

        /// <summary>
        /// Bulk ignore multiple tracks. Automatically refreshes the playlist to apply changes.
        /// </summary>
        [HttpPost("{playlistId}/ignores/bulk")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<BulkIgnoreResult>> BulkIgnore(string playlistId, [FromBody] BulkIgnoreRequest request)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(playlistId, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            if (request.TrackIds == null || request.TrackIds.Count == 0)
            {
                return BadRequest("No track IDs provided");
            }

            // Verify playlist exists and belongs to user
            var playlistStore = GetUserPlaylistStore();
            var playlist = await playlistStore.GetByIdAsync(userId.ToString(), playlistId).ConfigureAwait(false);
            if (playlist == null)
            {
                return NotFound($"Playlist {playlistId} not found");
            }

            var ignoreStore = GetIgnoreStore();
            var added = 0;
            var errors = new List<string>();

            // Use default duration from playlist if not specified
            int? durationDays = request.DurationDays ?? playlist.DefaultIgnoreDurationDays;
            if (durationDays == 0)
            {
                durationDays = null; // Treat 0 as permanent
            }

            foreach (var trackId in request.TrackIds)
            {
                try
                {
                    // Get track metadata if available
                    string? trackName = null;
                    string? artistName = null;
                    string? albumName = null;

                    if (Guid.TryParse(trackId, out var trackGuid))
                    {
                        var item = _libraryManager.GetItemById(trackGuid);
                        if (item != null)
                        {
                            trackName = item.Name;
                            if (item is MediaBrowser.Controller.Entities.Audio.Audio audio)
                            {
                                artistName = string.Join(", ", audio.Artists);
                                albumName = audio.Album;
                            }
                        }
                    }

                    var ignoredTrack = IgnoredTrack.Create(
                        trackId,
                        playlistId,
                        userId.ToString(),
                        durationDays,
                        trackName,
                        artistName,
                        albumName,
                        request.Reason);

                    await ignoreStore.AddAsync(ignoredTrack).ConfigureAwait(false);
                    added++;
                }
                catch (Exception ex)
                {
                    errors.Add($"Failed to ignore {trackId}: {ex.Message}");
                }
            }

            _logger.LogInformation("Bulk ignored {Count} tracks in playlist {PlaylistId} for user {UserId}",
                added, playlistId, userId);

            // Auto-refresh the playlist to apply ignore changes to the Jellyfin playlist
            var refreshed = false;
            if (added > 0 && request.AutoRefresh != false)
            {
                var (success, _, _) = await _userPlaylistService.RefreshAsync(playlist).ConfigureAwait(false);
                if (success)
                {
                    await playlistStore.SaveAsync(playlist).ConfigureAwait(false);
                    refreshed = true;
                    _logger.LogDebug("Auto-refreshed playlist {PlaylistId} after bulk ignore", playlistId);
                }
            }

            return Ok(new BulkIgnoreResult
            {
                Added = added,
                Errors = errors,
                Refreshed = refreshed,
                ItemCount = playlist.ItemCount
            });
        }

        /// <summary>
        /// Bulk remove ignores for multiple tracks. Automatically refreshes the playlist to apply changes.
        /// </summary>
        [HttpDelete("{playlistId}/ignores/bulk")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<BulkRemoveIgnoreResult>> BulkRemoveIgnore(string playlistId, [FromBody] BulkRemoveIgnoreRequest request)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (request.IgnoreIds == null || request.IgnoreIds.Count == 0)
            {
                return BadRequest("No ignore IDs provided");
            }

            var ignoreStore = GetIgnoreStore();
            var userIdStr = userId.ToString();
            var removed = 0;
            var errors = new List<string>();

            // Get all ignores to find the track IDs we're un-ignoring
            var allIgnores = await ignoreStore.GetForPlaylistAsync(userIdStr, playlistId, includeExpired: true).ConfigureAwait(false);
            var ignoreIdToTrackId = allIgnores.ToDictionary(i => i.Id, i => i.TrackId, StringComparer.OrdinalIgnoreCase);

            // Get the playlist so we can add un-ignored tracks to IncludedItemIds
            var playlistStore = GetUserPlaylistStore();
            var playlist = await playlistStore.GetByIdAsync(userIdStr, playlistId).ConfigureAwait(false);
            var tracksToAdd = new List<string>();

            foreach (var ignoreId in request.IgnoreIds)
            {
                try
                {
                    // Track the track ID before removing
                    if (ignoreIdToTrackId.TryGetValue(ignoreId, out var trackId))
                    {
                        tracksToAdd.Add(trackId);
                    }

                    var success = await ignoreStore.RemoveAsync(userIdStr, ignoreId).ConfigureAwait(false);
                    if (success)
                    {
                        removed++;
                    }
                    else
                    {
                        errors.Add($"Ignore {ignoreId} not found");
                    }
                }
                catch (Exception ex)
                {
                    errors.Add($"Failed to remove ignore {ignoreId}: {ex.Message}");
                }
            }

            // Add un-ignored tracks to IncludedItemIds to ensure they persist
            if (playlist != null && tracksToAdd.Count > 0)
            {
                playlist.IncludedItemIds ??= [];
                var added = 0;
                foreach (var trackId in tracksToAdd)
                {
                    if (!playlist.IncludedItemIds.Contains(trackId, StringComparer.OrdinalIgnoreCase))
                    {
                        playlist.IncludedItemIds.Add(trackId);
                        added++;
                    }
                }
                if (added > 0)
                {
                    await playlistStore.SaveAsync(playlist).ConfigureAwait(false);
                    _logger.LogDebug("Added {Count} tracks to IncludedItemIds for playlist {PlaylistId}", added, playlistId);
                }
            }

            _logger.LogInformation("Bulk removed {Count} ignores in playlist {PlaylistId} for user {UserId}",
                removed, playlistId, userId);

            // Auto-refresh the playlist to apply changes to the Jellyfin playlist
            var refreshed = false;
            if (removed > 0 && playlist != null && request.AutoRefresh != false)
            {
                var (success, _, _) = await _userPlaylistService.RefreshAsync(playlist).ConfigureAwait(false);
                if (success)
                {
                    await playlistStore.SaveAsync(playlist).ConfigureAwait(false);
                    refreshed = true;
                    _logger.LogDebug("Auto-refreshed playlist {PlaylistId} after bulk unignore", playlistId);
                }
            }

            return Ok(new BulkRemoveIgnoreResult
            {
                Removed = removed,
                Errors = errors,
                Refreshed = refreshed,
                ItemCount = playlist?.ItemCount
            });
        }

        // ==================== Ignore List CRUD ====================

        /// <summary>
        /// Gets all ignored tracks for a smart playlist.
        /// </summary>
        [HttpGet("{playlistId}/ignores")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<IEnumerable<IgnoredTrack>>> GetIgnores(string playlistId, [FromQuery] bool includeExpired = false)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(playlistId, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            // Verify playlist exists and belongs to user
            var playlistStore = GetUserPlaylistStore();
            var playlist = await playlistStore.GetByIdAsync(userId.ToString(), playlistId).ConfigureAwait(false);
            if (playlist == null)
            {
                return NotFound($"Playlist {playlistId} not found");
            }

            var ignoreStore = GetIgnoreStore();
            var ignores = await ignoreStore.GetForPlaylistAsync(userId.ToString(), playlistId, includeExpired).ConfigureAwait(false);

            return Ok(ignores);
        }

        /// <summary>
        /// Adds a track to the ignore list.
        /// </summary>
        [HttpPost("{playlistId}/ignores")]
        [ProducesResponseType(StatusCodes.Status201Created)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<IgnoredTrack>> AddIgnore(string playlistId, [FromBody] AddIgnoreRequest request)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(playlistId, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            if (string.IsNullOrWhiteSpace(request.TrackId))
            {
                return BadRequest("Track ID is required");
            }

            // Verify playlist exists and belongs to user
            var playlistStore = GetUserPlaylistStore();
            var playlist = await playlistStore.GetByIdAsync(userId.ToString(), playlistId).ConfigureAwait(false);
            if (playlist == null)
            {
                return NotFound($"Playlist {playlistId} not found");
            }

            // Get track metadata if available
            string? trackName = null;
            string? artistName = null;
            string? albumName = null;

            if (Guid.TryParse(request.TrackId, out var trackGuid))
            {
                var item = _libraryManager.GetItemById(trackGuid);
                if (item != null)
                {
                    trackName = item.Name;
                    if (item is MediaBrowser.Controller.Entities.Audio.Audio audio)
                    {
                        artistName = string.Join(", ", audio.Artists);
                        albumName = audio.Album;
                    }
                }
            }

            // Use default duration from playlist if not specified
            int? durationDays = request.DurationDays ?? playlist.DefaultIgnoreDurationDays;
            if (durationDays == 0)
            {
                durationDays = null; // Treat 0 as permanent
            }

            var ignoredTrack = IgnoredTrack.Create(
                request.TrackId,
                playlistId,
                userId.ToString(),
                durationDays,
                trackName,
                artistName,
                albumName,
                request.Reason);

            var ignoreStore = GetIgnoreStore();
            var saved = await ignoreStore.AddAsync(ignoredTrack).ConfigureAwait(false);

            _logger.LogInformation("Added ignore for track {TrackId} in playlist {PlaylistId} for user {UserId}, duration: {Duration} days",
                request.TrackId, playlistId, userId, durationDays);

            return CreatedAtAction(nameof(GetIgnores), new { playlistId }, saved);
        }

        /// <summary>
        /// Updates an ignore entry's duration.
        /// </summary>
        [HttpPut("{playlistId}/ignores/{ignoreId}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<IgnoredTrack>> UpdateIgnore(string playlistId, string ignoreId, [FromBody] UpdateIgnoreRequest request)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            var ignoreStore = GetIgnoreStore();
            var updated = await ignoreStore.UpdateDurationAsync(userId.ToString(), ignoreId, request.DurationDays).ConfigureAwait(false);

            if (updated == null)
            {
                return NotFound($"Ignore entry {ignoreId} not found");
            }

            _logger.LogInformation("Updated ignore {IgnoreId} duration to {Duration} days for user {UserId}",
                ignoreId, request.DurationDays, userId);

            return Ok(updated);
        }

        /// <summary>
        /// Removes a track from the ignore list.
        /// When un-ignoring, the track is added to IncludedItemIds to ensure it persists.
        /// </summary>
        [HttpDelete("{playlistId}/ignores/{ignoreId}")]
        [ProducesResponseType(StatusCodes.Status204NoContent)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult> RemoveIgnore(string playlistId, string ignoreId)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            var ignoreStore = GetIgnoreStore();
            var userIdStr = userId.ToString();

            // Get the ignore entry first so we know which track is being un-ignored
            var ignores = await ignoreStore.GetForPlaylistAsync(userIdStr, playlistId, includeExpired: true).ConfigureAwait(false);
            var ignoreEntry = ignores.FirstOrDefault(i => string.Equals(i.Id, ignoreId, StringComparison.OrdinalIgnoreCase));

            if (ignoreEntry == null)
            {
                return NotFound($"Ignore entry {ignoreId} not found");
            }

            // Add the track to IncludedItemIds to ensure it persists after un-ignoring
            var playlistStore = GetUserPlaylistStore();
            var playlist = await playlistStore.GetByIdAsync(userIdStr, playlistId).ConfigureAwait(false);
            if (playlist != null)
            {
                playlist.IncludedItemIds ??= [];
                if (!playlist.IncludedItemIds.Contains(ignoreEntry.TrackId, StringComparer.OrdinalIgnoreCase))
                {
                    playlist.IncludedItemIds.Add(ignoreEntry.TrackId);
                    await playlistStore.SaveAsync(playlist).ConfigureAwait(false);
                    _logger.LogDebug("Added track {TrackId} to IncludedItemIds for playlist {PlaylistId}",
                        ignoreEntry.TrackId, playlistId);
                }
            }

            // Now remove the ignore entry
            var removed = await ignoreStore.RemoveAsync(userIdStr, ignoreId).ConfigureAwait(false);

            if (!removed)
            {
                return NotFound($"Ignore entry {ignoreId} not found");
            }

            _logger.LogInformation("Removed ignore {IgnoreId} for user {UserId}", ignoreId, userId);

            return NoContent();
        }

        /// <summary>
        /// Clears all ignores for a playlist.
        /// </summary>
        [HttpDelete("{playlistId}/ignores")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult<int>> ClearIgnores(string playlistId)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (!Guid.TryParse(playlistId, out _))
            {
                return BadRequest("Invalid playlist ID format");
            }

            // Verify playlist exists
            var playlistStore = GetUserPlaylistStore();
            var playlist = await playlistStore.GetByIdAsync(userId.ToString(), playlistId).ConfigureAwait(false);
            if (playlist == null)
            {
                return NotFound($"Playlist {playlistId} not found");
            }

            var ignoreStore = GetIgnoreStore();
            var count = await ignoreStore.RemoveAllForPlaylistAsync(userId.ToString(), playlistId).ConfigureAwait(false);

            _logger.LogInformation("Cleared {Count} ignores for playlist {PlaylistId} for user {UserId}",
                count, playlistId, userId);

            return Ok(count);
        }

        // ==================== Utility Endpoints ====================

        /// <summary>
        /// Previews items that would match the given rules.
        /// Used by the wizard to show what a rule-based playlist would contain.
        /// </summary>
        [HttpPost("preview-rules")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult<PreviewRulesResult> PreviewRules([FromBody] PreviewRulesRequest request)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (request.MediaTypes == null || request.MediaTypes.Count == 0)
            {
                return BadRequest("No media types specified");
            }

            if (request.ExpressionSets == null || request.ExpressionSets.Count == 0 ||
                !request.ExpressionSets.Any(es => es.Expressions != null && es.Expressions.Count > 0))
            {
                return BadRequest("No rules specified");
            }

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return Unauthorized("User not found");
            }

            // Get all user media
            var query = new InternalItemsQuery(user)
            {
                IncludeItemTypes = Utilities.MediaTypeConverter.GetBaseItemKindsFromMediaTypes(request.MediaTypes, null, _logger),
                Recursive = true
            };
            var allUserMedia = _libraryManager.GetItemsResult(query).Items;

            // Create a temporary SmartPlaylistDto to use existing filtering logic
            var tempDto = new Core.Models.SmartPlaylistDto
            {
                Id = Guid.NewGuid().ToString(),
                Name = "Preview",
                UserId = userId.ToString(),
                ExpressionSets = request.ExpressionSets,
                MediaTypes = request.MediaTypes
            };

            var smartList = new Core.SmartList(tempDto)
            {
                UserManager = _userManager
            };

            // Create a temporary RefreshCache
            var refreshCache = new Services.Shared.RefreshQueueService.RefreshCache();

            var filteredIdsList = smartList.FilterPlaylistItems(
                allUserMedia,
                _libraryManager,
                user,
                refreshCache,
                null, // userDataManager not needed for basic filtering
                _logger,
                null).ToList();

            // Apply limit for preview (don't return thousands of items)
            var limitedIds = filteredIdsList.Take(request.Limit ?? 200).ToList();

            // Build the result with item details
            var items = new List<PreviewRulesItem>();
            foreach (var itemId in limitedIds)
            {
                var item = _libraryManager.GetItemById(itemId);
                if (item == null) continue;

                var previewItem = new PreviewRulesItem
                {
                    Id = itemId.ToString("N"),
                    Name = item.Name ?? "Unknown",
                    RuntimeTicks = item.RunTimeTicks
                };

                if (item is MediaBrowser.Controller.Entities.Audio.Audio audio)
                {
                    previewItem.Artist = string.Join(", ", audio.Artists);
                    previewItem.Album = audio.Album;
                }

                items.Add(previewItem);
            }

            _logger.LogDebug("Rules preview returned {Count} items (total matching: {TotalCount})",
                items.Count, filteredIdsList.Count);

            return Ok(new PreviewRulesResult
            {
                Items = items,
                TotalMatching = filteredIdsList.Count,
                LimitApplied = filteredIdsList.Count > (request.Limit ?? 200)
            });
        }

        /// <summary>
        /// Gets available Jellyfin playlists for the current user (for cloning).
        /// </summary>
        [HttpGet("playlists")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public ActionResult<IEnumerable<PlaylistInfo>> GetAvailablePlaylists()
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return Unauthorized("User not found");
            }

            // Get all playlists visible to this user
            var query = new InternalItemsQuery(user)
            {
                IncludeItemTypes = [Jellyfin.Data.Enums.BaseItemKind.Playlist],
                Recursive = true
            };

            var playlists = _libraryManager.GetItemsResult(query);

            var result = playlists.Items
                .Select(p => new PlaylistInfo
                {
                    Id = p.Id.ToString(),
                    Name = p.Name,
                    ItemCount = GetPlaylistItemCount(p)
                })
                .ToList();

            return Ok(result);
        }

        /// <summary>
        /// Gets the item count for a playlist.
        /// </summary>
        private static int GetPlaylistItemCount(BaseItem playlist)
        {
            try
            {
                // For Playlist items, use LinkedChildren
                if (playlist is MediaBrowser.Controller.Playlists.Playlist pl)
                {
                    return pl.LinkedChildren?.Length ?? 0;
                }
                // Fallback for other folder types
                if (playlist is Folder folder)
                {
                    return folder.GetChildren(null, true).Count;
                }
                return 0;
            }
            catch
            {
                return 0;
            }
        }

        /// <summary>
        /// Gets available filter fields and operators (same as admin).
        /// </summary>
        [HttpGet("fields")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ActionResult<object> GetFields()
        {
            var fields = new
            {
                ContentFields = new[]
                {
                    new { Value = "Name", Label = "Name" },
                    new { Value = "SeriesName", Label = "Series Name" },
                    new { Value = "SimilarTo", Label = "Similar To" },
                    new { Value = "OfficialRating", Label = "Parental Rating" },
                    new { Value = "Overview", Label = "Overview" },
                    new { Value = "ProductionYear", Label = "Production Year" },
                    new { Value = "ReleaseDate", Label = "Release Date" }
                },
                VideoFields = new[]
                {
                    new { Value = "Resolution", Label = "Resolution" },
                    new { Value = "Framerate", Label = "Framerate" },
                    new { Value = "VideoCodec", Label = "Video Codec" },
                    new { Value = "VideoProfile", Label = "Video Profile" },
                    new { Value = "VideoRange", Label = "Video Range" },
                    new { Value = "VideoRangeType", Label = "Video Range Type" },
                },
                AudioFields = new[]
                {
                    new { Value = "AudioLanguages", Label = "Audio Languages" },
                    new { Value = "AudioBitrate", Label = "Audio Bitrate (kbps)" },
                    new { Value = "AudioSampleRate", Label = "Audio Sample Rate (Hz)" },
                    new { Value = "AudioBitDepth", Label = "Audio Bit Depth" },
                    new { Value = "AudioCodec", Label = "Audio Codec" },
                    new { Value = "AudioProfile", Label = "Audio Profile" },
                    new { Value = "AudioChannels", Label = "Audio Channels" },
                },
                RatingsPlaybackFields = new[]
                {
                    new { Value = "CommunityRating", Label = "Community Rating" },
                    new { Value = "CriticRating", Label = "Critic Rating" },
                    new { Value = "IsFavorite", Label = "Is Favorite" },
                    new { Value = "IsPlayed", Label = "Is Played" },
                    new { Value = "LastPlayedDate", Label = "Last Played" },
                    new { Value = "NextUnwatched", Label = "Next Unwatched" },
                    new { Value = "PlayCount", Label = "Play Count" },
                    new { Value = "RuntimeMinutes", Label = "Runtime (Minutes)" },
                },
                FileFields = new[]
                {
                    new { Value = "FileName", Label = "File Name" },
                    new { Value = "FolderPath", Label = "Folder Path" },
                    new { Value = "DateModified", Label = "Date Modified" },
                },
                LibraryFields = new[]
                {
                    new { Value = "DateCreated", Label = "Date Added to Library" },
                    new { Value = "DateLastRefreshed", Label = "Last Metadata Refresh" },
                    new { Value = "DateLastSaved", Label = "Last Database Save" },
                },
                PeopleFields = new[]
                {
                    new { Value = "People", Label = "People" },
                },
                PeopleSubFields = new[]
                {
                    new { Value = "People", Label = "People (All)" },
                    new { Value = "Actors", Label = "Actors" },
                    new { Value = "Directors", Label = "Directors" },
                    new { Value = "Composers", Label = "Composers" },
                    new { Value = "Writers", Label = "Writers" },
                    new { Value = "GuestStars", Label = "Guest Stars" },
                    new { Value = "Producers", Label = "Producers" },
                    new { Value = "Conductors", Label = "Conductors" },
                    new { Value = "Lyricists", Label = "Lyricists" },
                    new { Value = "Arrangers", Label = "Arrangers" },
                    new { Value = "SoundEngineers", Label = "Sound Engineers" },
                    new { Value = "Mixers", Label = "Mixers" },
                    new { Value = "Remixers", Label = "Remixers" },
                    new { Value = "Creators", Label = "Creators" },
                    new { Value = "PersonArtists", Label = "Artists (Person Role)" },
                    new { Value = "PersonAlbumArtists", Label = "Album Artists (Person Role)" },
                    new { Value = "Authors", Label = "Authors" },
                    new { Value = "Illustrators", Label = "Illustrators" },
                    new { Value = "Pencilers", Label = "Pencilers" },
                    new { Value = "Inkers", Label = "Inkers" },
                    new { Value = "Colorists", Label = "Colorists" },
                    new { Value = "Letterers", Label = "Letterers" },
                    new { Value = "CoverArtists", Label = "Cover Artists" },
                    new { Value = "Editors", Label = "Editors" },
                    new { Value = "Translators", Label = "Translators" },
                },
                CollectionFields = new[]
                {
                    new { Value = "Collections", Label = "Collections" },
                    new { Value = "Genres", Label = "Genres" },
                    new { Value = "Studios", Label = "Studios" },
                    new { Value = "Tags", Label = "Tags" },
                    new { Value = "Album", Label = "Album" },
                    new { Value = "Artists", Label = "Artists" },
                    new { Value = "AlbumArtists", Label = "Album Artists" },
                },
                Operators = Core.Constants.Operators.AllOperators,
                FieldOperators = Core.Constants.Operators.GetFieldOperatorsDictionary(),
            };

            return Ok(fields);
        }

        /// <summary>
        /// Gets available operators (same as admin).
        /// </summary>
        [HttpGet("operators")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ActionResult<object> GetOperators()
        {
            return Ok(Core.Constants.Operators.AllOperators);
        }

        // ==================== Export/Import ====================

        /// <summary>
        /// Exports all smart playlists for the current user.
        /// </summary>
        [HttpPost("export")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public async Task<ActionResult> Export()
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            var store = GetUserPlaylistStore();
            var playlists = await store.GetAllAsync(userId.ToString()).ConfigureAwait(false);

            if (playlists.Length == 0)
            {
                return Ok(new { message = "No playlists to export" });
            }

            using var memoryStream = new MemoryStream();
            using (var archive = new ZipArchive(memoryStream, ZipArchiveMode.Create, true))
            {
                foreach (var playlist in playlists)
                {
                    var entry = archive.CreateEntry($"{playlist.Id}.json");
                    await using var entryStream = entry.Open();
                    await JsonSerializer.SerializeAsync(entryStream, playlist, SmartListFileSystem.SharedJsonOptions)
                        .ConfigureAwait(false);
                }
            }

            memoryStream.Position = 0;
            return File(memoryStream.ToArray(), "application/zip", $"smartlists-export-{DateTime.UtcNow:yyyyMMdd}.zip");
        }

        /// <summary>
        /// Imports smart playlists from a ZIP file.
        /// </summary>
        [HttpPost("import")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status401Unauthorized)]
        public async Task<ActionResult<ImportResult>> Import(IFormFile file)
        {
            var userId = GetCurrentUserId();
            if (userId == Guid.Empty)
            {
                return Unauthorized("User not authenticated");
            }

            if (file == null || file.Length == 0)
            {
                return BadRequest("No file provided");
            }

            var result = new ImportResult();
            var store = GetUserPlaylistStore();

            try
            {
                using var stream = file.OpenReadStream();
                using var archive = new ZipArchive(stream, ZipArchiveMode.Read);

                foreach (var entry in archive.Entries)
                {
                    if (!entry.Name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    try
                    {
                        await using var entryStream = entry.Open();
                        var playlist = await JsonSerializer.DeserializeAsync<UserSmartPlaylistDto>(
                            entryStream, SmartListFileSystem.SharedJsonOptions).ConfigureAwait(false);

                        if (playlist == null)
                        {
                            result.Errors.Add($"Failed to parse {entry.Name}");
                            continue;
                        }

                        // Override user ID with current user and generate new ID
                        playlist.UserId = userId.ToString();
                        playlist.Id = Guid.NewGuid().ToString();
                        playlist.JellyfinPlaylistId = null; // Clear - will be created on refresh
                        playlist.DateCreated = DateTime.UtcNow;

                        await store.SaveAsync(playlist).ConfigureAwait(false);
                        result.Imported++;
                    }
                    catch (Exception ex)
                    {
                        result.Errors.Add($"Error importing {entry.Name}: {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                return BadRequest($"Invalid ZIP file: {ex.Message}");
            }

            _logger.LogInformation("Imported {Count} playlists for user {UserId}", result.Imported, userId);

            return Ok(result);
        }

        // ==================== Helper Classes ====================

        // Generic wrapper class for logger adapters
        private sealed class ServiceLoggerAdapter<T>(ILogger logger) : ILogger<T>
        {
            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            {
                logger.Log(logLevel, eventId, state, exception, formatter);
            }

            public bool IsEnabled(LogLevel logLevel) => logger.IsEnabled(logLevel);
            IDisposable? ILogger.BeginScope<TState>(TState state) => logger.BeginScope(state);
        }

        /// <summary>
        /// Request model for adding a track to ignore list.
        /// </summary>
        public class AddIgnoreRequest
        {
            [Required]
            public string TrackId { get; set; } = string.Empty;
            public int? DurationDays { get; set; }
            public string? Reason { get; set; }
        }

        /// <summary>
        /// Request model for updating an ignore entry.
        /// </summary>
        public class UpdateIgnoreRequest
        {
            public int? DurationDays { get; set; }
        }

        /// <summary>
        /// Info about an available Jellyfin playlist.
        /// </summary>
        public class PlaylistInfo
        {
            public string Id { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public int ItemCount { get; set; }
        }

        /// <summary>
        /// Info about a filter field.
        /// </summary>
        public class FieldInfo
        {
            public string Name { get; set; } = string.Empty;
            public string DisplayName { get; set; } = string.Empty;
            public List<string> Operators { get; set; } = [];
        }

        /// <summary>
        /// Result of import operation.
        /// </summary>
        public class ImportResult
        {
            public int Imported { get; set; }
            public List<string> Errors { get; set; } = [];
        }

        /// <summary>
        /// Info about a single item in a playlist.
        /// </summary>
        public class PlaylistItemInfo
        {
            public string Id { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public string? Artist { get; set; }
            public string? Album { get; set; }
            public long? RuntimeTicks { get; set; }
            public bool IsIgnored { get; set; }
            public DateTime? IgnoreExpiresAt { get; set; }
            public string? IgnoreId { get; set; }
            public bool IsPermanentIgnore { get; set; }
        }

        /// <summary>
        /// Result of getting playlist items.
        /// </summary>
        public class PlaylistItemsResult
        {
            public string PlaylistId { get; set; } = string.Empty;
            public string? JellyfinPlaylistId { get; set; }
            public List<PlaylistItemInfo> Items { get; set; } = [];
            public int TotalCount { get; set; }
        }

        /// <summary>
        /// Request for bulk ignore operation.
        /// </summary>
        public class BulkIgnoreRequest
        {
            public List<string> TrackIds { get; set; } = [];
            public int? DurationDays { get; set; }
            public string? Reason { get; set; }
            /// <summary>
            /// Whether to automatically refresh the playlist after adding ignores.
            /// Defaults to true if not specified.
            /// </summary>
            public bool? AutoRefresh { get; set; }
        }

        /// <summary>
        /// Result of bulk ignore operation.
        /// </summary>
        public class BulkIgnoreResult
        {
            public int Added { get; set; }
            public List<string> Errors { get; set; } = [];
            /// <summary>
            /// Whether the playlist was refreshed after the operation.
            /// </summary>
            public bool Refreshed { get; set; }
            /// <summary>
            /// Current item count after refresh.
            /// </summary>
            public int? ItemCount { get; set; }
        }

        /// <summary>
        /// Request for bulk remove ignore operation.
        /// </summary>
        public class BulkRemoveIgnoreRequest
        {
            public List<string> IgnoreIds { get; set; } = [];
            /// <summary>
            /// Whether to automatically refresh the playlist after removing ignores.
            /// Defaults to true if not specified.
            /// </summary>
            public bool? AutoRefresh { get; set; }
        }

        /// <summary>
        /// Result of bulk remove ignore operation.
        /// </summary>
        public class BulkRemoveIgnoreResult
        {
            public int Removed { get; set; }
            public List<string> Errors { get; set; } = [];
            /// <summary>
            /// Whether the playlist was refreshed after the operation.
            /// </summary>
            public bool Refreshed { get; set; }
            /// <summary>
            /// Current item count after refresh.
            /// </summary>
            public int? ItemCount { get; set; }
        }

        /// <summary>
        /// Request for removing items from a playlist.
        /// </summary>
        public class RemoveItemsRequest
        {
            public List<string> ItemIds { get; set; } = [];
        }

        /// <summary>
        /// Result of removing items from a playlist.
        /// </summary>
        public class RemoveItemsResult
        {
            public int Removed { get; set; }
            public int? ItemCount { get; set; }
        }

        /// <summary>
        /// Request for adding items to a playlist.
        /// </summary>
        public class AddItemsRequest
        {
            public List<string> ItemIds { get; set; } = [];
        }

        /// <summary>
        /// Result of adding items to a playlist.
        /// </summary>
        public class AddItemsResult
        {
            public int Added { get; set; }
            public int? ItemCount { get; set; }
        }

        /// <summary>
        /// Request for previewing rule matches.
        /// </summary>
        public class PreviewRulesRequest
        {
            public List<string> MediaTypes { get; set; } = [];
            public List<Core.Models.ExpressionSet> ExpressionSets { get; set; } = [];
            public int? Limit { get; set; }
        }

        /// <summary>
        /// Result of rule preview.
        /// </summary>
        public class PreviewRulesResult
        {
            public List<PreviewRulesItem> Items { get; set; } = [];
            public int TotalMatching { get; set; }
            public bool LimitApplied { get; set; }
        }

        /// <summary>
        /// A single item in the rules preview result.
        /// </summary>
        public class PreviewRulesItem
        {
            public string Id { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public string? Artist { get; set; }
            public string? Album { get; set; }
            public long? RuntimeTicks { get; set; }
        }
    }
}
