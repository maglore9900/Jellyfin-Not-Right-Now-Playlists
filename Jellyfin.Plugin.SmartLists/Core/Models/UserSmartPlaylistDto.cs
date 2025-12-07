using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.SmartLists.Core.QueryEngine;

namespace Jellyfin.Plugin.SmartLists.Core.Models
{
    /// <summary>
    /// DTO for user-created smart playlists (non-admin).
    /// These are stored separately from admin playlists and are user-scoped.
    /// </summary>
    [Serializable]
    public class UserSmartPlaylistDto
    {
        /// <summary>
        /// Unique identifier for this smart playlist configuration.
        /// </summary>
        public string Id { get; set; } = string.Empty;

        /// <summary>
        /// The user who owns this smart playlist.
        /// </summary>
        public string UserId { get; set; } = string.Empty;

        /// <summary>
        /// Display name for the smart playlist.
        /// </summary>
        public required string Name { get; set; }

        /// <summary>
        /// Optional: ID of an existing Jellyfin playlist to use as source.
        /// If set, the smart playlist will be based on items from this playlist,
        /// with additional filtering applied (including ignore rules).
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? SourcePlaylistId { get; set; }

        /// <summary>
        /// Optional: Additional filter rules to apply.
        /// These work the same as admin smart list rules.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public List<ExpressionSet>? ExpressionSets { get; set; }

        /// <summary>
        /// Sort order for the playlist items.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public OrderDto? Order { get; set; }

        /// <summary>
        /// Pre-filter by media types (e.g., "Audio", "Movie").
        /// </summary>
        public List<string> MediaTypes { get; set; } = [];

        /// <summary>
        /// Whether the resulting Jellyfin playlist should be public.
        /// </summary>
        public bool Public { get; set; } = false;

        /// <summary>
        /// Whether this smart playlist is enabled for refresh.
        /// </summary>
        public bool Enabled { get; set; } = true;

        /// <summary>
        /// Maximum number of items in the playlist.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? MaxItems { get; set; }

        /// <summary>
        /// Maximum total playtime in minutes.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? MaxPlayTimeMinutes { get; set; }

        /// <summary>
        /// The ID of the actual Jellyfin playlist that was created.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? JellyfinPlaylistId { get; set; }

        /// <summary>
        /// When the playlist was last refreshed.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public DateTime? LastRefreshed { get; set; }

        /// <summary>
        /// When this smart playlist configuration was created.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public DateTime? DateCreated { get; set; }

        /// <summary>
        /// Number of items currently in the playlist.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? ItemCount { get; set; }

        /// <summary>
        /// Total runtime of all items in minutes.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public double? TotalRuntimeMinutes { get; set; }

        /// <summary>
        /// Number of ignored items for this playlist.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? IgnoreCount { get; set; }

        /// <summary>
        /// Default duration in days for ignoring tracks.
        /// Users can override this per-track.
        /// </summary>
        public int DefaultIgnoreDurationDays { get; set; } = 30;

        /// <summary>
        /// Optional: Specific item IDs to include in the playlist.
        /// These are added in addition to items matched by rules or source playlist.
        /// Used by the wizard to add manually selected items.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public List<string>? IncludedItemIds { get; set; }
    }
}
