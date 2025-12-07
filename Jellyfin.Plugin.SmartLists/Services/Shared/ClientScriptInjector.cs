using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SmartLists.Services.Shared
{
    /// <summary>
    /// Hosted service that attempts to register with the File Transformation plugin
    /// to inject the SmartLists client script into index.html.
    /// </summary>
    public class ClientScriptInjector : IHostedService
    {
        private readonly ILogger<ClientScriptInjector> _logger;
        private string? _registrationId;

        public ClientScriptInjector(ILogger<ClientScriptInjector> logger)
        {
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            try
            {
                _logger.LogInformation("[SmartLists] Attempting to register client script injection...");

                if (TryRegisterWithFileTransformation())
                {
                    _logger.LogInformation("[SmartLists] Successfully registered with File Transformation plugin");
                }
                else
                {
                    _logger.LogWarning(
                        "[SmartLists] File Transformation plugin not found. " +
                        "To enable the NrN Playlists navigation link, you can either: " +
                        "(1) Install the File Transformation plugin from https://github.com/IAmParadox27/jellyfin-plugin-file-transformation, or " +
                        "(2) Manually add this script tag to your Jellyfin index.html: " +
                        "<script plugin=\"SmartLists\" src=\"/Plugins/SmartLists/ClientScript\"></script>");
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[SmartLists] Error during client script registration");
            }

            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            if (!string.IsNullOrEmpty(_registrationId))
            {
                try
                {
                    TryUnregisterFromFileTransformation();
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[SmartLists] Error during client script unregistration");
                }
            }

            return Task.CompletedTask;
        }

        private bool TryRegisterWithFileTransformation()
        {
            try
            {
                // Find the File Transformation plugin assembly using AppDomain
                Assembly? fileTransformationAssembly = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.FullName?.Contains("FileTransformation", StringComparison.OrdinalIgnoreCase) ?? false);

                // Log all loaded assemblies for debugging
                var allAssemblies = AppDomain.CurrentDomain.GetAssemblies();
                _logger.LogInformation("[SmartLists] Searching {Count} loaded assemblies for FileTransformation", allAssemblies.Length);

                if (fileTransformationAssembly == null)
                {
                    // Log assembly names that contain "plugin" for debugging
                    var pluginAssemblies = allAssemblies
                        .Where(a => a.FullName?.Contains("Plugin", StringComparison.OrdinalIgnoreCase) ?? false)
                        .Select(a => a.GetName().Name)
                        .ToList();
                    _logger.LogInformation("[SmartLists] Plugin assemblies found: {Assemblies}", string.Join(", ", pluginAssemblies));
                    return false;
                }

                _logger.LogInformation("[SmartLists] Found File Transformation assembly: {AssemblyName}", fileTransformationAssembly.FullName);

                // Log all types in the assembly for debugging
                var types = fileTransformationAssembly.GetTypes().Select(t => t.FullName).ToList();
                _logger.LogInformation("[SmartLists] Types in FileTransformation: {Types}", string.Join(", ", types.Take(20)));

                // Get the PluginInterface type
                Type? pluginInterfaceType = fileTransformationAssembly
                    .GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");

                if (pluginInterfaceType == null)
                {
                    _logger.LogInformation("[SmartLists] PluginInterface type not found");
                    return false;
                }

                _logger.LogInformation("[SmartLists] Found PluginInterface type, creating JObject payload...");

                // Find Newtonsoft.Json.Linq.JObject type from loaded assemblies
                var newtonsoftAssembly = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.GetName().Name == "Newtonsoft.Json");

                if (newtonsoftAssembly == null)
                {
                    _logger.LogInformation("[SmartLists] Newtonsoft.Json assembly not found");
                    return false;
                }

                var jObjectType = newtonsoftAssembly.GetType("Newtonsoft.Json.Linq.JObject");
                if (jObjectType == null)
                {
                    _logger.LogInformation("[SmartLists] JObject type not found");
                    return false;
                }

                // Generate a unique registration ID
                _registrationId = Guid.NewGuid().ToString();

                // Create JObject using Parse method with JSON string
                var jsonString = $@"{{
                    ""id"": ""{_registrationId}"",
                    ""fileNamePattern"": ""^(?:.*/)?(index\\.html)$"",
                    ""callbackAssembly"": ""{typeof(ClientScriptInjector).Assembly.FullName!.Replace("\\", "\\\\")}"",
                    ""callbackClass"": ""Jellyfin.Plugin.SmartLists.Services.Shared.IndexHtmlTransformer"",
                    ""callbackMethod"": ""TransformIndexHtml""
                }}";

                var parseMethod = jObjectType.GetMethod("Parse", new[] { typeof(string) });
                if (parseMethod == null)
                {
                    _logger.LogInformation("[SmartLists] JObject.Parse method not found");
                    return false;
                }

                var payload = parseMethod.Invoke(null, new object[] { jsonString });

                // Invoke RegisterTransformation via reflection
                var method = pluginInterfaceType.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);
                if (method == null)
                {
                    _logger.LogInformation("[SmartLists] RegisterTransformation method not found");
                    return false;
                }

                _logger.LogInformation("[SmartLists] Invoking RegisterTransformation...");
                method.Invoke(null, new object[] { payload! });
                _logger.LogInformation("[SmartLists] RegisterTransformation invoked successfully!");
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[SmartLists] Exception during File Transformation registration");
                return false;
            }
        }

        private void TryUnregisterFromFileTransformation()
        {
            try
            {
                Assembly? fileTransformationAssembly = AppDomain.CurrentDomain.GetAssemblies()
                    .FirstOrDefault(a => a.FullName?.Contains("FileTransformation", StringComparison.OrdinalIgnoreCase) ?? false);

                if (fileTransformationAssembly == null) return;

                Type? pluginInterfaceType = fileTransformationAssembly
                    .GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");

                if (pluginInterfaceType == null) return;

                var method = pluginInterfaceType.GetMethod("UnregisterTransformation", BindingFlags.Public | BindingFlags.Static);
                method?.Invoke(null, new object[] { _registrationId! });
            }
            catch
            {
                // Ignore errors during unregistration
            }
        }
    }

    /// <summary>
    /// Static transformer class called by the File Transformation plugin.
    /// </summary>
    public static class IndexHtmlTransformer
    {
        // Inline script to inject navigation link and context menu
        private const string InlineScript = @"<script plugin=""SmartLists"">
(function() {
    'use strict';
    console.log('[SmartLists] Script loaded - version with context menu');
    var PLUGIN_ID = 'smartlists-nav';
    var NAV_TEXT = 'NrN Playlists';
    var NAV_URL = '/web/configurationpage?name=user-config.html';

    // ========== NAVIGATION LINK ==========
    function injectNav() {
        if (document.getElementById(PLUGIN_ID)) return true;
        var headerRight = document.querySelector('.headerRight');
        if (!headerRight) return false;

        // Create Smart Playlists link
        var link = document.createElement('a');
        link.id = PLUGIN_ID;
        link.href = NAV_URL;
        link.className = 'headerButton headerButtonRight';
        link.title = NAV_TEXT;
        link.style.cssText = 'display:flex;align-items:center;padding:0 10px;color:inherit;text-decoration:none;font-size:0.85em;opacity:0.85;cursor:pointer;';
        link.innerHTML = '<span class=""material-icons"" style=""font-size:1.4em;margin-right:4px;"">queue_music</span><span>' + NAV_TEXT + '</span>';
        link.onmouseenter = function() { this.style.opacity = '1'; };
        link.onmouseleave = function() { this.style.opacity = '0.85'; };

        // Create Settings link
        var settingsLink = document.createElement('a');
        settingsLink.id = PLUGIN_ID + '-settings';
        settingsLink.href = '/web/configurationpage?name=user-settings.html';
        settingsLink.className = 'headerButton headerButtonRight';
        settingsLink.title = 'NrN Playlists Settings';
        settingsLink.style.cssText = 'display:flex;align-items:center;padding:0 10px;color:inherit;text-decoration:none;font-size:0.85em;opacity:0.85;cursor:pointer;';
        settingsLink.innerHTML = '<span class=""material-icons"" style=""font-size:1.4em;"">settings</span>';
        settingsLink.onmouseenter = function() { this.style.opacity = '1'; };
        settingsLink.onmouseleave = function() { this.style.opacity = '0.85'; };

        var userBtn = headerRight.querySelector('.headerUserButton');
        if (userBtn) {
            headerRight.insertBefore(settingsLink, userBtn);
            headerRight.insertBefore(link, settingsLink);
        } else {
            headerRight.appendChild(link);
            headerRight.appendChild(settingsLink);
        }
        return true;
    }

    // ========== CONTEXT MENU INTEGRATION ==========
    var smartListsContextMenu = {
        currentSmartPlaylist: null,
        currentItemId: null,
        DEBUG: true,

        log: function() {
            if (this.DEBUG) console.log.apply(console, ['[SmartLists]'].concat(Array.prototype.slice.call(arguments)));
        },

        // Get user's default ignore days from localStorage settings
        getDefaultIgnoreDays: function() {
            try {
                var stored = localStorage.getItem('smartlists_user_settings');
                if (stored) {
                    var settings = JSON.parse(stored);
                    if (typeof settings.defaultIgnoreDays === 'number') {
                        return settings.defaultIgnoreDays;
                    }
                }
            } catch (e) {
                console.error('[SmartLists] Error reading settings:', e);
            }
            return 30; // Default fallback
        },

        // Get display text for ignore period
        getIgnoreText: function() {
            var days = this.getDefaultIgnoreDays();
            if (days === 0) return 'Ignore Permanently';
            if (days === 1) return 'Ignore for 1 day';
            if (days === 365) return 'Ignore for 1 year';
            return 'Ignore for ' + days + ' days';
        },

        // Get auth headers from localStorage (same as user-config.js)
        getAuthHeaders: function() {
            try {
                var credStr = localStorage.getItem('jellyfin_credentials');
                if (credStr) {
                    var credentials = JSON.parse(credStr);
                    var servers = credentials && credentials.Servers ? credentials.Servers : [];
                    var currentServer = servers.length > 0 ? servers[0] : null;
                    if (currentServer && currentServer.AccessToken) {
                        return {
                            'Authorization': 'MediaBrowser Token=""' + currentServer.AccessToken + '""'
                        };
                    }
                }
            } catch (e) {
                console.error('[SmartLists] Error getting auth headers:', e);
            }
            return {};
        },

        // Check if current page is a smart playlist or queue playing from one
        checkIfSmartPlaylist: function() {
            var self = this;
            var hash = window.location.hash || '';

            // Check if we're on the queue page
            if (hash.indexOf('#/queue') === 0) {
                // Try to restore smart playlist context from session storage
                try {
                    var stored = sessionStorage.getItem('smartlists_queue_context');
                    if (stored) {
                        self.currentSmartPlaylist = JSON.parse(stored);
                        self.log('Restored smart playlist context for queue:', self.currentSmartPlaylist);
                    } else {
                        self.currentSmartPlaylist = null;
                        self.log('No smart playlist context for queue');
                    }
                } catch (e) {
                    self.log('Error restoring queue context:', e);
                    self.currentSmartPlaylist = null;
                }
                return;
            }

            // Check URL for playlist/details page with id parameter
            var match = hash.match(/[?&]id=([a-f0-9-]+)/i);
            if (!match) {
                self.currentSmartPlaylist = null;
                return;
            }

            var playlistId = match[1];
            self.log('Checking playlist:', playlistId);

            // Query our API to see if this is a smart playlist
            fetch('/Plugins/SmartLists/User/ByJellyfinPlaylistId/' + playlistId, {
                headers: self.getAuthHeaders()
            })
                .then(function(response) {
                    if (response.ok) return response.json();
                    throw new Error('Not a smart playlist');
                })
                .then(function(smartPlaylist) {
                    self.log('Found smart playlist:', smartPlaylist);
                    self.currentSmartPlaylist = smartPlaylist;
                })
                .catch(function() {
                    self.log('Not a smart playlist or error');
                    self.currentSmartPlaylist = null;
                });
        },

        // Store or clear smart playlist context when user initiates playback
        handlePlayAction: function() {
            var self = this;
            if (self.currentSmartPlaylist) {
                try {
                    sessionStorage.setItem('smartlists_queue_context', JSON.stringify(self.currentSmartPlaylist));
                    self.log('Stored smart playlist context for queue:', self.currentSmartPlaylist.Id);
                } catch (e) {
                    self.log('Error storing queue context:', e);
                }
            } else {
                sessionStorage.removeItem('smartlists_queue_context');
                self.log('Cleared smart playlist queue context');
            }
        },

        // Capture the item ID when context menu is triggered
        captureItemFromEvent: function(e) {
            var self = this;
            var target = e.target;

            // Walk up the DOM to find an element with data-id or data-itemid
            while (target && target !== document.body) {
                var itemId = target.getAttribute('data-id') ||
                             target.getAttribute('data-itemid') ||
                             (target.dataset && (target.dataset.id || target.dataset.itemid));
                if (itemId) {
                    self.currentItemId = itemId;
                    self.log('Captured item ID:', itemId);
                    return;
                }
                target = target.parentElement;
            }

            // Also check for item in current playing bar
            var nowPlaying = document.querySelector('.nowPlayingBar [data-id], .nowPlayingBar [data-itemid]');
            if (nowPlaying) {
                self.currentItemId = nowPlaying.getAttribute('data-id') || nowPlaying.getAttribute('data-itemid');
                self.log('Captured from now playing bar:', self.currentItemId);
            }
        },

        // Add our menu item to the action sheet
        injectMenuItem: function(actionSheet) {
            var self = this;

            // Only inject if we're on a smart playlist
            if (!self.currentSmartPlaylist || !self.currentItemId) {
                self.log('Not injecting - no smart playlist or item');
                return;
            }

            // Check if already injected
            if (actionSheet.querySelector('[data-smartlists-ignore]')) {
                self.log('Already injected');
                return;
            }

            // Find the buttons container
            var buttonsContainer = actionSheet.querySelector('.actionSheetScroller') ||
                                   actionSheet.querySelector('.actionSheetContent');
            if (!buttonsContainer) {
                self.log('No buttons container found');
                return;
            }

            // Create our button
            var btn = document.createElement('button');
            btn.setAttribute('data-smartlists-ignore', 'true');
            btn.className = 'listItem listItem-button actionSheetMenuItem';
            btn.type = 'button';
            btn.innerHTML = '<span class=""material-icons listItemIcon listItemIcon-transparent"">block</span>' +
                            '<div class=""listItemBody actionSheetItemText""><div class=""listItemBodyText"">' + self.getIgnoreText() + '</div></div>';

            btn.onclick = function(e) {
                e.preventDefault();
                e.stopPropagation();
                self.ignoreItem();
                // Close the dialog using Jellyfin's dialogHelper
                var dlg = actionSheet.closest('.dialog') || actionSheet;
                if (window.require) {
                    window.require(['dialogHelper'], function(dialogHelper) {
                        dialogHelper.close(dlg);
                    });
                } else {
                    // Fallback if require not available
                    if (dlg && dlg.close) {
                        dlg.close();
                    }
                }
            };

            // Find a good position (after queue commands, before destructive ones)
            var existingButtons = buttonsContainer.querySelectorAll('button');
            var insertBefore = null;
            for (var i = 0; i < existingButtons.length; i++) {
                var text = existingButtons[i].textContent.toLowerCase();
                if (text.indexOf('delete') >= 0 || text.indexOf('remove') >= 0) {
                    insertBefore = existingButtons[i];
                    break;
                }
            }

            if (insertBefore) {
                buttonsContainer.insertBefore(btn, insertBefore);
            } else {
                buttonsContainer.appendChild(btn);
            }

            self.log('Injected ignore button');
        },

        // Call API to ignore the item
        ignoreItem: function() {
            var self = this;
            if (!self.currentSmartPlaylist || !self.currentItemId) {
                console.error('[SmartLists] Cannot ignore - missing playlist or item');
                return;
            }

            self.log('Ignoring item:', self.currentItemId, 'from playlist:', self.currentSmartPlaylist.Id);

            var ignoreDays = self.getDefaultIgnoreDays();
            var body = {
                TrackIds: [self.currentItemId],
                DurationDays: ignoreDays
            };

            var headers = self.getAuthHeaders();
            headers['Content-Type'] = 'application/json';

            fetch('/Plugins/SmartLists/User/' + self.currentSmartPlaylist.Id + '/ignores/bulk', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            })
            .then(function(response) {
                if (!response.ok) throw new Error('Failed to ignore');
                return response.json();
            })
            .then(function(result) {
                self.log('Ignore successful:', result);
                // Show notification
                var msg = ignoreDays === 0 ? 'Item ignored permanently' : 'Item ignored for ' + ignoreDays + ' day' + (ignoreDays === 1 ? '' : 's');
                self.showToast(msg);
                // Refresh the page to show updated playlist
                setTimeout(function() {
                    // Try Jellyfin's router first, fallback to page reload
                    if (window.Emby && window.Emby.Page && window.Emby.Page.refresh) {
                        window.Emby.Page.refresh();
                    } else {
                        location.reload();
                    }
                }, 500);
            })
            .catch(function(err) {
                console.error('[SmartLists] Ignore failed:', err);
                self.showToast('Failed to ignore item');
            });
        },

        showToast: function(message) {
            // Try to use Jellyfin's toast, fallback to simple alert
            if (window.require) {
                try {
                    window.require(['toast'], function(toast) {
                        toast(message);
                    });
                    return;
                } catch (e) {}
            }
            // Simple fallback toast
            var toast = document.createElement('div');
            toast.textContent = message;
            toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:12px 24px;border-radius:4px;z-index:10000;';
            document.body.appendChild(toast);
            setTimeout(function() { toast.remove(); }, 3000);
        },

        // Watch for action sheets appearing
        setupObserver: function() {
            var self = this;
            var observer = new MutationObserver(function(mutations) {
                mutations.forEach(function(mutation) {
                    mutation.addedNodes.forEach(function(node) {
                        if (node.nodeType === 1) {
                            // Check if this is an action sheet
                            if (node.classList && (node.classList.contains('actionSheet') ||
                                node.classList.contains('dialogContainer'))) {
                                var actionSheet = node.querySelector('.actionSheet') || node;
                                if (actionSheet) {
                                    self.log('Action sheet detected');
                                    // Small delay to let Jellyfin populate the menu
                                    setTimeout(function() { self.injectMenuItem(actionSheet); }, 50);
                                }
                            }
                            // Also check descendants
                            var sheets = node.querySelectorAll && node.querySelectorAll('.actionSheet');
                            if (sheets && sheets.length > 0) {
                                sheets.forEach(function(sheet) {
                                    setTimeout(function() { self.injectMenuItem(sheet); }, 50);
                                });
                            }
                        }
                    });
                });
            });

            observer.observe(document.body, { childList: true, subtree: true });
            self.log('Context menu observer started');
        },

        init: function() {
            var self = this;

            // Capture context menu triggers (right-click and three-dot button)
            document.addEventListener('contextmenu', function(e) { self.captureItemFromEvent(e); }, true);
            document.addEventListener('click', function(e) {
                var target = e.target;

                // Check if clicking a play action (to store/clear queue context)
                var playTarget = target.closest ? target.closest('[data-action=""play""], [data-action=""resume""], [data-action=""playallfromhere""], .btnPlay, .btnPlayAllFromHere, .btnResume') : null;
                if (playTarget) {
                    self.handlePlayAction();
                }

                // Check if clicking a more/menu button (for context menu capture)
                while (target && target !== document.body) {
                    if ((target.classList && (target.classList.contains('btnMoreCommands') ||
                        target.classList.contains('itemAction') ||
                        target.getAttribute('data-action') === 'menu')) ||
                        (target.querySelector && target.querySelector('.material-icons') &&
                         target.textContent.indexOf('more_vert') >= 0)) {
                        self.captureItemFromEvent(e);
                        break;
                    }
                    target = target.parentElement;
                }
            }, true);

            // Check for smart playlist on page changes
            document.addEventListener('viewshow', function() { self.checkIfSmartPlaylist(); });
            window.addEventListener('hashchange', function() { self.checkIfSmartPlaylist(); });

            // Setup observer for action sheets
            self.setupObserver();

            // Initial check
            self.checkIfSmartPlaylist();

            self.log('Context menu integration initialized');
        }
    };

    // ========== INIT ==========
    function init() {
        if (injectNav()) {
            // Nav link injected
        } else {
            var attempts = 0;
            var interval = setInterval(function() {
                if (injectNav() || ++attempts >= 20) clearInterval(interval);
            }, 500);
        }
        document.addEventListener('viewshow', function() { injectNav(); });

        // Initialize context menu integration
        smartListsContextMenu.init();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
</script>";

        /// <summary>
        /// Transforms index.html by injecting the SmartLists client script.
        /// Called by File Transformation plugin via reflection.
        /// </summary>
        /// <param name="contents">JSON object with "contents" field containing HTML (Newtonsoft JObject).</param>
        /// <returns>Transformed HTML string.</returns>
        public static string TransformIndexHtml(dynamic contents)
        {
            try
            {
                // Get the contents value - use ToString() for JToken/JValue
                var contentsToken = contents["contents"];
                if (contentsToken == null)
                {
                    return contents["contents"]?.ToString() ?? string.Empty;
                }

                string html = contentsToken.ToString();
                if (string.IsNullOrEmpty(html))
                {
                    return html;
                }

                // Don't inject if already present
                if (html.Contains("smartlists-nav", StringComparison.OrdinalIgnoreCase))
                {
                    return html;
                }

                // Inject script before closing body tag
                if (html.Contains("</body>", StringComparison.OrdinalIgnoreCase))
                {
                    html = html.Replace("</body>", $"{InlineScript}\n</body>");
                }

                return html;
            }
            catch
            {
                // Return unchanged if transformation fails
                return contents["contents"]?.ToString() ?? string.Empty;
            }
        }
    }
}
