using System;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.SmartLists.Core.Models
{
    /// <summary>
    /// Represents a track that has been temporarily ignored/excluded from a smart playlist.
    /// Tracks can be ignored for a specified duration or permanently until manually removed.
    /// </summary>
    [Serializable]
    public class IgnoredTrack
    {
        /// <summary>
        /// Unique identifier for this ignore entry.
        /// </summary>
        public string Id { get; set; } = string.Empty;

        /// <summary>
        /// The Jellyfin item ID of the ignored track.
        /// </summary>
        public string TrackId { get; set; } = string.Empty;

        /// <summary>
        /// The smart playlist this ignore applies to.
        /// </summary>
        public string SmartPlaylistId { get; set; } = string.Empty;

        /// <summary>
        /// The user who created this ignore entry.
        /// </summary>
        public string UserId { get; set; } = string.Empty;

        /// <summary>
        /// When the track was added to the ignore list.
        /// </summary>
        public DateTime IgnoredAt { get; set; }

        /// <summary>
        /// Duration of the ignore in days.
        /// Null means permanent until manually removed.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? DurationDays { get; set; }

        /// <summary>
        /// When the ignore expires. Calculated from IgnoredAt + DurationDays.
        /// Null if DurationDays is null (permanent ignore).
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public DateTime? ExpiresAt { get; set; }

        /// <summary>
        /// Cached track name for display purposes.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? TrackName { get; set; }

        /// <summary>
        /// Cached artist name for display purposes.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? ArtistName { get; set; }

        /// <summary>
        /// Cached album name for display purposes.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? AlbumName { get; set; }

        /// <summary>
        /// Optional reason for ignoring this track.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Reason { get; set; }

        /// <summary>
        /// Checks if this ignore entry has expired.
        /// </summary>
        /// <returns>True if expired or no expiry set (permanent), false otherwise.</returns>
        public bool IsExpired()
        {
            // If no expiry date, it's permanent - not expired
            if (ExpiresAt == null)
            {
                return false;
            }

            return DateTime.UtcNow > ExpiresAt.Value;
        }

        /// <summary>
        /// Checks if this ignore entry is currently active (not expired).
        /// </summary>
        /// <returns>True if the track should be ignored, false otherwise.</returns>
        public bool IsActive()
        {
            return !IsExpired();
        }

        /// <summary>
        /// Updates the duration and recalculates the expiry date.
        /// </summary>
        /// <param name="newDurationDays">New duration in days. Null for permanent.</param>
        public void UpdateDuration(int? newDurationDays)
        {
            DurationDays = newDurationDays;
            // Treat 0 as permanent (no expiration), same as null
            ExpiresAt = newDurationDays.HasValue && newDurationDays.Value > 0
                ? IgnoredAt.AddDays(newDurationDays.Value)
                : null;
        }

        /// <summary>
        /// Creates a new ignore entry with calculated expiry.
        /// </summary>
        public static IgnoredTrack Create(
            string trackId,
            string smartPlaylistId,
            string userId,
            int? durationDays,
            string? trackName = null,
            string? artistName = null,
            string? albumName = null,
            string? reason = null)
        {
            var now = DateTime.UtcNow;
            return new IgnoredTrack
            {
                Id = Guid.NewGuid().ToString(),
                TrackId = trackId,
                SmartPlaylistId = smartPlaylistId,
                UserId = userId,
                IgnoredAt = now,
                DurationDays = durationDays,
                // Treat 0 as permanent (no expiration), same as null
                ExpiresAt = durationDays.HasValue && durationDays.Value > 0 ? now.AddDays(durationDays.Value) : null,
                TrackName = trackName,
                ArtistName = artistName,
                AlbumName = albumName,
                Reason = reason
            };
        }
    }
}
