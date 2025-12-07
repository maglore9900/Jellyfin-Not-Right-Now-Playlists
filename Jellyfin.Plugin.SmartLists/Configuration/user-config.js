/**
 * User Smart Playlists Configuration
 * This module extends the shared SmartLists namespace with user-specific functionality.
 * It uses the User API endpoints (/Plugins/SmartLists/User/*) instead of admin endpoints.
 */
(function (SmartLists) {
    'use strict';

    // Version for cache-busting during development
    var DEBUG_MODE = false; // Set to true for verbose logging

    // User-specific API endpoints
    var USER_ENDPOINTS = {
        base: 'Plugins/SmartLists/User',
        playlists: 'Plugins/SmartLists/User/playlists',
        fields: 'Plugins/SmartLists/User/fields',
        refresh: 'Plugins/SmartLists/User/refresh',
        export: 'Plugins/SmartLists/User/export',
        import: 'Plugins/SmartLists/User/import'
    };

    // ===== STANDALONE API CLIENT =====
    // Creates an API client from stored credentials when window.ApiClient is not available.
    // This happens when the page is accessed directly (not through Jellyfin's SPA navigation).
    // This is the proper approach for standalone pages - it mirrors how Jellyfin's ServerConnections
    // module works internally by reading credentials from localStorage and creating authenticated requests.
    function getFallbackApiClient() {
        // Read credentials from Jellyfin's localStorage (same storage used by ServerConnections)
        var credentials = null;
        try {
            var credStr = localStorage.getItem('jellyfin_credentials');
            if (credStr) {
                credentials = JSON.parse(credStr);
            }
        } catch (e) {
            console.error('[SmartLists] Error reading credentials from localStorage:', e);
            return null;
        }

        // Get the current server and user info
        var servers = credentials && credentials.Servers ? credentials.Servers : [];
        var currentServer = servers.length > 0 ? servers[0] : null;

        if (!currentServer) {
            console.error('[SmartLists] No server found in stored credentials');
            return null;
        }

        var accessToken = currentServer.AccessToken;
        var userId = currentServer.UserId;
        var serverAddress = currentServer.ManualAddress || currentServer.LocalAddress || window.location.origin;

        if (!accessToken) {
            console.error('[SmartLists] No access token found - user may not be logged in');
            return null;
        }

        if (DEBUG_MODE) {
            console.log('[SmartLists] Created standalone API client for server:', serverAddress);
        }

        return {
            _serverAddress: serverAddress,
            _accessToken: accessToken,
            _userId: userId,

            getUrl: function (path) {
                return this._serverAddress + '/' + path;
            },

            accessToken: function () {
                return this._accessToken;
            },

            getCurrentUserId: function () {
                return this._userId;
            },

            ajax: function (options) {
                var url = options.url;
                var headers = {
                    'Authorization': 'MediaBrowser Token="' + this._accessToken + '"'
                };
                if (options.contentType) {
                    headers['Content-Type'] = options.contentType;
                }

                var fetchOptions = {
                    method: options.type || 'GET',
                    headers: headers
                };

                if (options.data) {
                    fetchOptions.body = options.data;
                }

                return fetch(url, fetchOptions);
            }
        };
    }

    // Override getApiClient to use standalone client if window.ApiClient not available
    var originalGetApiClient = SmartLists.getApiClient;
    SmartLists.getApiClient = function () {
        if (window.ApiClient) {
            return window.ApiClient;
        }
        if (DEBUG_MODE) {
            console.log('[SmartLists] Using standalone API client');
        }
        return getFallbackApiClient();
    };

    // ===== STUB FUNCTIONS FOR SHARED SCRIPTS =====
    // config-rules.js calls loadUsersForRule which is defined in config-api.js (admin only).
    // For the user page, we provide a stub that only returns the current user.
    SmartLists.loadUsersForRule = function (userSelect, isOptional) {
        if (!userSelect) {
            return Promise.resolve();
        }
        // Clear existing options
        userSelect.innerHTML = '';

        // Add optional placeholder
        if (isOptional) {
            var optionAny = document.createElement('option');
            optionAny.value = '';
            optionAny.textContent = 'Any User';
            userSelect.appendChild(optionAny);
        }

        // Add "Current User" option - user playlists are user-scoped
        var currentUserOption = document.createElement('option');
        currentUserOption.value = 'current';
        currentUserOption.textContent = 'Current User (Me)';
        userSelect.appendChild(currentUserOption);

        return Promise.resolve();
    };

    // Media types for user playlists (no collections, so no Series)
    var USER_MEDIA_TYPES = [
        { Value: "Audio", Label: "Audio (Music)" },
        { Value: "Movie", Label: "Movie" },
        { Value: "Episode", Label: "Episode (TV Show)" },
        { Value: "MusicVideo", Label: "Music Video" },
        { Value: "Video", Label: "Video (Home Video)" },
        { Value: "AudioBook", Label: "Audiobook" }
    ];

    // ===== RESPONSE HANDLING HELPER =====
    // Handles both fetch Response objects (from standalone client) and direct data (from window.ApiClient)
    function parseApiResponse(response) {
        if (response && typeof response.ok !== 'undefined') {
            // This is a fetch Response object
            if (!response.ok) {
                throw new Error('API request failed: ' + response.status + ' ' + response.statusText);
            }
            return response.json();
        }
        // Direct data (from window.ApiClient)
        return Promise.resolve(response);
    }

    // ===== USER-SPECIFIC loadAndPopulateFields =====
    // Override the shared function to use user endpoints instead of admin endpoints
    function loadUserFields() {
        var apiClient = SmartLists.getApiClient();
        if (!apiClient) {
            return Promise.reject(new Error('No API client available'));
        }

        var url = apiClient.getUrl(USER_ENDPOINTS.fields);

        return apiClient.ajax({
            type: 'GET',
            url: url,
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (fields) {
            SmartLists.availableFields = fields;
            return fields;
        }).catch(function (err) {
            console.error('[SmartLists] Error loading fields:', err);
            // Don't fail initialization - fields are optional for basic playlist creation
            return {};
        });
    }

    // ===== PAGE INITIALIZATION =====
    SmartLists.initUserPage = function (page) {
        if (DEBUG_MODE) {
            console.log('[SmartLists] initUserPage called');
        }

        if (page._pageInitialized) {
            if (DEBUG_MODE) {
                console.log('[SmartLists] Page already initialized, skipping');
            }
            return;
        }
        page._pageInitialized = true;

        // Apply custom styles if available
        if (typeof SmartLists.applyCustomStyles === 'function') {
            SmartLists.applyCustomStyles(page);
        }

        // Disable form submission until initialization is complete
        var submitBtn = page.querySelector('#submitBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Loading...';
        }

        // Initialize all async operations
        // Use our user-specific loadUserFields instead of the admin loadAndPopulateFields
        var initPromises = [loadAvailablePlaylists(page), loadUserFields()];

        Promise.all(initPromises).then(function () {
            // Initialize media types (for edit form)
            generateUserMediaTypeCheckboxes(page);

            // Initialize rules container (for edit form)
            var rulesContainer = page.querySelector('#rules-container');
            if (rulesContainer && rulesContainer.children.length === 0) {
                SmartLists.createInitialLogicGroup(page);
            }

            // Initialize sort system (for edit form)
            if (SmartLists.initializeSortSystem) {
                SmartLists.initializeSortSystem(page);
            }
            var sortsContainer = page.querySelector('#sorts-container');
            if (sortsContainer && sortsContainer.querySelectorAll('.sort-box').length === 0) {
                SmartLists.addSortBox(page, { SortBy: 'Name', SortOrder: 'Ascending' });
            }

            // Enable form submission
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Update Playlist';
            }
        }).catch(function (error) {
            console.error('Error during user page initialization:', error);
            SmartLists.showNotification('Some configuration options failed to load. Please refresh the page.');

            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Update Playlist';
            }
        });

        // Set up form handler early (critical for preventing default submission)
        try {
            attachFormHandler(page);
        } catch (err) {
            console.error('[SmartLists] Error attaching form handler:', err);
        }

        // Set up event listeners
        setupUserEventListeners(page);

        // Set up navigation
        setupUserNavigation(page);

        // Set up landing page event listeners
        setupLandingPageListeners(page);
    };

    // ===== LANDING PAGE LISTENERS =====
    function setupLandingPageListeners(page) {
        // Radio button toggle for create mode
        var radioButtons = page.querySelectorAll('input[name="createMode"]');
        radioButtons.forEach(function (radio) {
            radio.addEventListener('change', function () {
                var newOptions = page.querySelector('#newPlaylistOptions');
                var convertOptions = page.querySelector('#convertPlaylistOptions');

                if (radio.value === 'new') {
                    if (newOptions) newOptions.style.display = '';
                    if (convertOptions) convertOptions.style.display = 'none';
                } else {
                    if (newOptions) newOptions.style.display = 'none';
                    if (convertOptions) convertOptions.style.display = '';
                }
            });
        });

        // Start wizard button
        var startWizardBtn = page.querySelector('#startWizardBtn');
        if (startWizardBtn) {
            startWizardBtn.addEventListener('click', function () {
                startWizard(page);
            });
        }
    }

    function startWizard(page) {
        var createMode = page.querySelector('input[name="createMode"]:checked');
        var isConvert = createMode && createMode.value === 'convert';

        var name, sourceId;

        if (isConvert) {
            var sourceSelect = page.querySelector('#sourcePlaylist');
            if (!sourceSelect || !sourceSelect.value) {
                SmartLists.showNotification('Please select a playlist to convert.', 'error');
                return;
            }
            sourceId = sourceSelect.value;
            // Get playlist name from the selected option
            name = sourceSelect.options[sourceSelect.selectedIndex].textContent.split(' (')[0];
        } else {
            var nameInput = page.querySelector('#newPlaylistName');
            name = nameInput ? nameInput.value.trim() : '';
            if (!name) {
                SmartLists.showNotification('Please enter a playlist name.', 'error');
                return;
            }
        }

        // Build wizard URL
        var wizardUrl = 'configurationpage?name=user-wizard.html';
        wizardUrl += '#?name=' + encodeURIComponent(name);
        if (isConvert) {
            wizardUrl += '&convert=true&sourceId=' + encodeURIComponent(sourceId);
        }

        window.location.href = wizardUrl;
    }

    // ===== MEDIA TYPE CHECKBOXES =====
    function generateUserMediaTypeCheckboxes(page) {
        var container = page.querySelector('#mediaTypesCheckboxList');
        if (!container) return;

        // Generate simple checkbox list (always visible, not collapsible)
        var html = '';
        USER_MEDIA_TYPES.forEach(function (mediaType) {
            html += '<label class="emby-checkbox-label" style="display: block; margin: 0.3em 0;">';
            html += '<input type="checkbox" is="emby-checkbox" class="media-type-checkbox emby-checkbox" ';
            html += 'data-embycheckbox="true" value="' + SmartLists.escapeHtmlAttribute(mediaType.Value) + '">';
            html += '<span class="checkboxLabel">' + SmartLists.escapeHtml(mediaType.Label) + '</span>';
            html += '<span class="checkboxOutline">';
            html += '<span class="material-icons checkboxIcon checkboxIcon-checked check" aria-hidden="true"></span>';
            html += '<span class="material-icons checkboxIcon checkboxIcon-unchecked" aria-hidden="true"></span>';
            html += '</span>';
            html += '</label>';
        });
        container.innerHTML = html;

        // Add change handler for field visibility updates
        container.addEventListener('change', function () {
            if (SmartLists.updateAllFieldSelects) {
                SmartLists.updateAllFieldSelects(page);
            }
        });
    }

    // Get selected media types from checkboxes
    SmartLists.getSelectedMediaTypes = function (page) {
        var checkboxes = page.querySelectorAll('.media-type-checkbox:checked');
        var selected = [];
        checkboxes.forEach(function (cb) {
            selected.push(cb.value);
        });
        return selected;
    };

    // Set selected media types on checkboxes
    SmartLists.setSelectedMediaTypesForUser = function (page, mediaTypes) {
        var checkboxes = page.querySelectorAll('.media-type-checkbox');
        checkboxes.forEach(function (cb) {
            cb.checked = mediaTypes && mediaTypes.indexOf(cb.value) !== -1;
        });
    };

    // Clear all media type checkboxes
    SmartLists.clearMediaTypeCheckboxes = function (page) {
        var checkboxes = page.querySelectorAll('.media-type-checkbox');
        checkboxes.forEach(function (cb) {
            cb.checked = false;
        });
    };

    // ===== LOAD AVAILABLE PLAYLISTS =====
    function loadAvailablePlaylists(page) {
        var apiClient = SmartLists.getApiClient();
        var sourceSelect = page.querySelector('#sourcePlaylist');

        if (!sourceSelect) {
            return Promise.resolve();
        }

        if (!apiClient) {
            console.error('[SmartLists] No API client available for loading playlists');
            return Promise.resolve();
        }

        var url = apiClient.getUrl(USER_ENDPOINTS.playlists);
        console.log('[SmartLists] Loading playlists from:', url);

        return apiClient.ajax({
            type: 'GET',
            url: url,
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (playlists) {
            console.log('[SmartLists] Loaded playlists:', playlists);

            // Clear existing options except first
            while (sourceSelect.options.length > 1) {
                sourceSelect.remove(1);
            }

            // Add playlist options
            if (playlists && playlists.length > 0) {
                playlists.forEach(function (playlist) {
                    var option = document.createElement('option');
                    option.value = playlist.Id;
                    option.textContent = playlist.Name + ' (' + playlist.ItemCount + ' items)';
                    sourceSelect.appendChild(option);
                });
                console.log('[SmartLists] Added', playlists.length, 'playlist options');
            } else {
                console.log('[SmartLists] No playlists returned from API');
            }
        }).catch(function (err) {
            console.error('[SmartLists] Error loading available playlists:', err);
        });
    }

    // ===== NAVIGATION =====
    function setupUserNavigation(page) {
        if (page._navInitialized) {
            return;
        }
        page._navInitialized = true;

        // Set initial tab
        var initialTab = getUserCurrentTab();
        switchUserTab(page, initialTab);

        // Handle navigation clicks (if nav container exists)
        var navContainer = page.querySelector('.localnav');
        if (navContainer) {
            SmartLists.applyStyles(navContainer, {
                marginBottom: '0.5em'
            });

            var navButtons = navContainer.querySelectorAll('a[data-tab]');
            navButtons.forEach(function (button) {
                button.addEventListener('click', function (e) {
                    e.preventDefault();
                    var tabId = button.getAttribute('data-tab');
                    switchUserTab(page, tabId);
                });
            });
        }

        // Handle browser back/forward
        window.addEventListener('hashchange', function () {
            var currentTab = getUserCurrentTab();
            switchUserTab(page, currentTab);
        });
    }

    function getUserCurrentTab() {
        var hash = window.location.hash;
        var match = hash.match(/[?&]tab=([^&]*)/);
        return match ? decodeURIComponent(match[1]) : 'manage';
    }

    function updateUserUrl(tabId) {
        var hash = window.location.hash || '#';
        var newHash;

        if (hash.includes('tab=')) {
            newHash = hash.replace(/([?&])tab=[^&]*/, '$1tab=' + encodeURIComponent(tabId));
        } else {
            var separator = hash.includes('?') ? '&' : '?';
            newHash = hash + separator + 'tab=' + encodeURIComponent(tabId);
        }

        window.history.replaceState({}, '', window.location.pathname + window.location.search + newHash);
    }

    function switchUserTab(page, tabId) {
        var navContainer = page.querySelector('.localnav');
        var navButtons = navContainer ? navContainer.querySelectorAll('a[data-tab]') : [];
        var tabContents = page.querySelectorAll('[data-tab-content]');

        // Update navigation buttons
        navButtons.forEach(function (btn) {
            if (btn.getAttribute('data-tab') === tabId) {
                btn.classList.add('ui-btn-active');
            } else {
                btn.classList.remove('ui-btn-active');
            }
        });

        // Update tab content visibility
        tabContents.forEach(function (content) {
            var contentTabId = content.getAttribute('data-tab-content');
            if (contentTabId === tabId) {
                content.classList.remove('hide');
            } else {
                content.classList.add('hide');
            }
        });

        // Load playlist list when switching to manage tab
        if (tabId === 'manage') {
            var shouldAutoRefresh = !page._initialRefreshDone;
            if (shouldAutoRefresh) {
                page._initialRefreshDone = true;
            }
            loadUserPlaylistList(page, shouldAutoRefresh);
        }

        updateUserUrl(tabId);
    }

    // Make switchToTab available for shared components
    SmartLists.switchToTab = function (page, tabId) {
        switchUserTab(page, tabId);
    };

    // ===== FORM HANDLER =====
    // Separate function to ensure form handler is attached reliably
    function attachFormHandler(page) {
        var playlistForm = page.querySelector('#playlistForm');
        var submitBtn = page.querySelector('#submitBtn');

        if (!playlistForm) {
            console.error('[SmartLists] Could not find playlist form');
            return;
        }

        // Skip if already attached
        if (playlistForm._submitHandlerAttached) {
            return;
        }
        playlistForm._submitHandlerAttached = true;

        // Handler function
        var handleSubmit = function (e) {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            createOrUpdateUserPlaylist(page);
            return false;
        };

        // Attach via onsubmit property and addEventListener for reliability
        playlistForm.onsubmit = handleSubmit;
        playlistForm.addEventListener('submit', handleSubmit, true);

        // Also attach click handler to submit button as extra safety
        if (submitBtn && !submitBtn._clickHandlerAttached) {
            submitBtn._clickHandlerAttached = true;
            submitBtn.addEventListener('click', function (e) {
                if (!submitBtn.disabled) {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSubmit(e);
                }
            }, true);
        }
    }

    // ===== EVENT LISTENERS =====
    function setupUserEventListeners(page) {
        var pageAbortController = SmartLists.createAbortController ? SmartLists.createAbortController() : null;
        var pageSignal = pageAbortController ? pageAbortController.signal : null;
        page._pageAbortController = pageAbortController;

        // Click event delegation
        page.addEventListener('click', function (e) {
            var target = e.target;

            // Handle rule action buttons
            if (target.classList.contains('and-btn')) {
                var ruleRow = target.closest('.rule-row');
                var logicGroup = ruleRow.closest('.logic-group');
                if (SmartLists.addRuleToGroup) {
                    SmartLists.addRuleToGroup(page, logicGroup);
                }
            }
            if (target.classList.contains('or-btn')) {
                if (SmartLists.addNewLogicGroup) {
                    SmartLists.addNewLogicGroup(page);
                }
            }
            if (target.classList.contains('delete-btn')) {
                var ruleRow = target.closest('.rule-row');
                if (ruleRow && SmartLists.removeRule) {
                    SmartLists.removeRule(page, ruleRow);
                }
            }

            // Clear form button
            if (target.closest('#clearFormBtn')) {
                clearUserForm(page);
            }

            // Cancel edit button
            if (target.closest('#cancelEditBtn')) {
                cancelUserEdit(page);
            }

            // Create playlist button (from manage tab)
            if (target.closest('#createPlaylistBtn')) {
                switchUserTab(page, 'create');
            }

            // Refresh all button
            if (target.closest('#refreshAllBtn')) {
                showRefreshConfirmModal(page);
            }

            // Toggle all playlists expand/collapse
            if (target.closest('#toggleAllPlaylistsBtn')) {
                toggleAllPlaylists(page);
            }

            // Export button
            if (target.closest('#exportPlaylistsBtn')) {
                exportUserPlaylists();
            }

            // Import button - triggers file dialog (handled by addEventListener)
            // (file selection change event auto-triggers import)

            // Playlist card actions
            if (target.closest('.delete-playlist-btn')) {
                var button = target.closest('.delete-playlist-btn');
                showDeleteConfirm(page, button.getAttribute('data-playlist-id'), button.getAttribute('data-playlist-name'));
            }
            if (target.closest('.edit-playlist-btn')) {
                var button = target.closest('.edit-playlist-btn');
                editUserPlaylist(page, button.getAttribute('data-playlist-id'));
            }
            if (target.closest('.refresh-playlist-btn')) {
                var button = target.closest('.refresh-playlist-btn');
                refreshUserPlaylist(button.getAttribute('data-playlist-id'), button.getAttribute('data-playlist-name'));
            }
            if (target.closest('.ignores-playlist-btn')) {
                var button = target.closest('.ignores-playlist-btn');
                showIgnoreListModal(page, button.getAttribute('data-playlist-id'), button.getAttribute('data-playlist-name'));
            }
            if (target.closest('.playlist-header')) {
                var playlistCard = target.closest('.playlist-card');
                if (playlistCard) {
                    togglePlaylistCard(playlistCard);
                }
            }

            // Modal buttons handled via direct event listeners below (more reliable with custom elements)
            // Only handle dynamically generated buttons here
            if (target.closest('.remove-ignore-btn')) {
                var btn = target.closest('.remove-ignore-btn');
                removeIgnore(page, btn.getAttribute('data-ignore-id'));
            }
        }, pageSignal ? { signal: pageSignal } : {});

        // Direct event listeners for modal buttons (more reliable with custom elements)
        // Use document.querySelector since modals may not be in the page element scope
        var deleteCancelBtn = document.querySelector('#delete-cancel-btn');
        var deleteConfirmBtn = document.querySelector('#delete-confirm-btn');
        var ignoreClearAllBtn = document.querySelector('#ignore-clear-all-btn');
        var ignoreCloseBtn = document.querySelector('#ignore-close-btn');
        var refreshCancelBtn = document.querySelector('.modal-cancel-btn');
        var refreshConfirmBtn = document.querySelector('.modal-confirm-btn');

        if (deleteCancelBtn) {
            deleteCancelBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                hideDeleteModal(page);
            });
        }
        if (deleteConfirmBtn) {
            deleteConfirmBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                confirmDelete(page);
            });
        }
        if (ignoreClearAllBtn) {
            ignoreClearAllBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                clearAllIgnores(page);
            });
        }
        if (ignoreCloseBtn) {
            ignoreCloseBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                hideIgnoreListModal(page);
            });
        }
        if (refreshCancelBtn) {
            refreshCancelBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                hideRefreshConfirmModal(page);
            });
        }
        if (refreshConfirmBtn) {
            refreshConfirmBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                hideRefreshConfirmModal(page);
                refreshAllUserPlaylists(page);
            });
        }

        // Search input
        var searchInput = page.querySelector('#playlistSearchInput');
        var clearSearchBtn = page.querySelector('#clearSearchBtn');
        if (searchInput) {
            searchInput.addEventListener('input', function () {
                if (clearSearchBtn) {
                    clearSearchBtn.style.display = searchInput.value.trim() ? 'flex' : 'none';
                }
                clearTimeout(page._searchTimeout);
                page._searchTimeout = setTimeout(function () {
                    applyUserSearchFilter(page);
                }, 300);
            });

            if (clearSearchBtn) {
                clearSearchBtn.addEventListener('click', function () {
                    searchInput.value = '';
                    clearSearchBtn.style.display = 'none';
                    applyUserSearchFilter(page);
                });
            }
        }

        // Import: Button click opens file dialog, file selection triggers import
        var importFileInput = page.querySelector('#importPlaylistsFile');
        var importBtn = page.querySelector('#importPlaylistsBtn');
        if (importBtn && importFileInput) {
            importBtn.addEventListener('click', function () {
                importFileInput.click();
            });
            importFileInput.addEventListener('change', function () {
                if (this.files && this.files.length > 0) {
                    importUserPlaylists(page);
                }
            });
        }
    }

    // ===== PLAYLIST LIST =====
    function loadUserPlaylistList(page, triggerAutoRefresh) {
        var container = page.querySelector('#playlist-list-container');
        if (!container) return;

        container.innerHTML = '<p>Loading playlists...</p>';

        var apiClient = SmartLists.getApiClient();

        apiClient.ajax({
            type: 'GET',
            url: apiClient.getUrl(USER_ENDPOINTS.base),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (playlists) {
            page._allPlaylists = playlists;
            renderUserPlaylistList(page, playlists);

            // Trigger auto-refresh after initial load if requested
            if (triggerAutoRefresh && playlists && playlists.length > 0) {
                autoRefreshAllPlaylists(page);
            }
        }).catch(function (err) {
            console.error('[SmartLists] Error loading user playlists:', err);
            container.innerHTML = '<p style="color: #f44336;">Error loading playlists. Please refresh the page.</p>';
        });
    }

    function renderUserPlaylistList(page, playlists) {
        var container = page.querySelector('#playlist-list-container');
        if (!container) return;

        if (!playlists || playlists.length === 0) {
            container.innerHTML = '<p style="color: #aaa;">No smart playlists found. Create one using the "Create Playlist" tab.</p>';
            return;
        }

        var searchInput = page.querySelector('#playlistSearchInput');
        var searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        var filteredPlaylists = playlists;
        if (searchTerm) {
            filteredPlaylists = playlists.filter(function (p) {
                return p.Name.toLowerCase().indexOf(searchTerm) !== -1;
            });
        }

        if (filteredPlaylists.length === 0) {
            container.innerHTML = '<p style="color: #aaa;">No playlists match your search.</p>';
            return;
        }

        var html = '<div class="playlist-list">';
        filteredPlaylists.forEach(function (playlist) {
            var statusClass = playlist.Enabled ? 'status-enabled' : 'status-disabled';
            var statusText = playlist.Enabled ? 'Enabled' : 'Disabled';
            var lastRefreshed = playlist.LastRefreshed ? new Date(playlist.LastRefreshed).toLocaleString() : 'Never';
            var itemCount = playlist.ItemCount || 0;
            var ignoreCount = playlist.IgnoreCount || 0;
            var runtime = playlist.TotalRuntimeMinutes ? Math.round(playlist.TotalRuntimeMinutes) + ' min' : '-';

            html += '<div class="playlist-card paperList" style="margin-bottom: 1em; background: #202020; border-radius: 4px;">';
            // Header row: Expand icon | Name + Status | Buttons
            html += '<div class="playlist-header" style="padding: 1em; cursor: pointer; display: flex; align-items: center; gap: 0.75em;" data-playlist-id="' + SmartLists.escapeHtmlAttribute(playlist.Id) + '">';
            html += '<span class="expand-icon" style="color: #888;">&#9662;</span>';
            html += '<div style="flex: 1; min-width: 0;">';
            html += '<span class="playlist-name" style="font-weight: bold; font-size: 1.1em;">' + SmartLists.escapeHtml(playlist.Name) + '</span>';
            html += '<span class="playlist-status ' + statusClass + '" style="margin-left: 0.75em; padding: 0.2em 0.5em; border-radius: 3px; font-size: 0.8em; background: ' + (playlist.Enabled ? '#2e7d32' : '#666') + ';">' + statusText + '</span>';
            html += '</div>';
            // Action buttons in header
            html += '<div class="playlist-actions" style="display: flex; gap: 0.5em; flex-wrap: wrap;">';
            html += '<button type="button" class="emby-button raised edit-playlist-btn" data-playlist-id="' + SmartLists.escapeHtmlAttribute(playlist.Id) + '" style="font-size: 0.8em; padding: 0.3em 0.6em;">Edit</button>';
            html += '<button type="button" class="emby-button raised refresh-playlist-btn" data-playlist-id="' + SmartLists.escapeHtmlAttribute(playlist.Id) + '" data-playlist-name="' + SmartLists.escapeHtmlAttribute(playlist.Name) + '" style="font-size: 0.8em; padding: 0.3em 0.6em;">Refresh</button>';
            html += '<button type="button" class="emby-button raised delete-playlist-btn button-delete" data-playlist-id="' + SmartLists.escapeHtmlAttribute(playlist.Id) + '" data-playlist-name="' + SmartLists.escapeHtmlAttribute(playlist.Name) + '" style="font-size: 0.8em; padding: 0.3em 0.6em;">Delete</button>';
            html += '</div>';
            html += '</div>';

            // Details section (collapsible)
            html += '<div class="playlist-details" style="display: block; padding: 0 1em 1em 1em; border-top: 1px solid #333;">';
            // Info grid
            html += '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.5em; margin-top: 1em; color: #aaa; font-size: 0.9em;">';
            html += '<div>Items: <strong style="color: #fff;">' + itemCount + '</strong></div>';
            html += '<div>Ignored: <strong style="color: ' + (ignoreCount > 0 ? '#ff9800' : '#fff') + ';">' + ignoreCount + '</strong></div>';
            html += '<div>Runtime: <strong style="color: #fff;">' + runtime + '</strong></div>';
            html += '<div>Media: <strong style="color: #fff;">' + (playlist.MediaTypes ? playlist.MediaTypes.join(', ') : '-') + '</strong></div>';
            html += '<div style="grid-column: span 2;">Last Refreshed: <strong style="color: #fff;">' + lastRefreshed + '</strong></div>';
            html += '</div>';

            // Tracks management section
            html += '<div class="playlist-tracks-section" data-playlist-id="' + SmartLists.escapeHtmlAttribute(playlist.Id) + '" style="margin-top: 1.5em;">';
            // Search and bulk actions bar
            html += '<div style="display: flex; gap: 0.5em; align-items: center; flex-wrap: wrap; margin-bottom: 0.75em; padding: 0.5em; background: #1a1a1a; border-radius: 4px;">';
            // Left side: All, selected count, Ignore, Unignore
            html += '<label style="display: flex; align-items: center; cursor: pointer;">';
            html += '<input type="checkbox" class="tracks-select-all" style="margin-right: 0.4em;">';
            html += '<span style="font-size: 0.85em;">All</span>';
            html += '</label>';
            html += '<span class="tracks-selection-count" style="color: #888; font-size: 0.85em; margin-right: 1em;">0 selected</span>';
            html += '<button type="button" class="emby-button raised tracks-ignore-btn" style="font-size: 0.8em; padding: 0.3em 0.5em;">Ignore</button>';
            html += '<button type="button" class="emby-button raised tracks-unignore-btn" style="font-size: 0.8em; padding: 0.3em 0.5em;">Unignore</button>';
            // Spacer between ignore actions and media actions
            html += '<span style="flex: 1;"></span>';
            // Media management buttons
            html += '<button type="button" class="emby-button raised tracks-add-media-btn" data-playlist-id="' + SmartLists.escapeHtmlAttribute(playlist.Id) + '" data-playlist-name="' + SmartLists.escapeHtmlAttribute(playlist.Name) + '" style="font-size: 0.8em; padding: 0.3em 0.5em;">Add Media</button>';
            html += '<button type="button" class="emby-button raised tracks-remove-btn" data-playlist-id="' + SmartLists.escapeHtmlAttribute(playlist.Id) + '" style="font-size: 0.8em; padding: 0.3em 0.5em;">Remove</button>';
            // Spacer before filter controls
            html += '<span style="flex: 1;"></span>';
            // Right side: Filter, Duration, Apply
            html += '<input type="text" class="tracks-search emby-input" placeholder="Filter tracks..." style="width: 150px; padding: 0.3em 0.5em; font-size: 0.85em;">';
            html += '<select class="tracks-ignore-duration emby-select" style="width: auto; min-width: 100px; padding: 0.3em; font-size: 0.85em;">';
            html += '<option value="default">Default</option>';
            html += '<option value="7">7 days</option>';
            html += '<option value="14">14 days</option>';
            html += '<option value="30">30 days</option>';
            html += '<option value="60">60 days</option>';
            html += '<option value="90">90 days</option>';
            html += '<option value="0">Permanent</option>';
            html += '</select>';
            html += '<button type="button" class="emby-button raised button-submit tracks-apply-btn" data-playlist-id="' + SmartLists.escapeHtmlAttribute(playlist.Id) + '" data-playlist-name="' + SmartLists.escapeHtmlAttribute(playlist.Name) + '" style="font-size: 0.8em; padding: 0.3em 0.5em;">Apply</button>';
            html += '</div>';

            // Tracks table container
            html += '<div class="tracks-table-container" style="border: 1px solid #333; border-radius: 4px;">';
            html += '<table style="width: 100%; border-collapse: collapse;">';
            html += '<thead style="background: #252525;">';
            html += '<tr style="border-bottom: 1px solid #444;">';
            html += '<th style="width: 35px; padding: 0.5em 0.3em; text-align: center;"></th>';
            html += '<th class="sortable-header" data-sort-key="ignored" style="width: 50px; padding: 0.5em 0.3em; text-align: center; font-size: 0.85em; cursor: pointer; user-select: none;">Ignored <span class="sort-indicator"></span></th>';
            html += '<th class="sortable-header" data-sort-key="name" style="padding: 0.5em 0.3em; text-align: left; font-size: 0.85em; cursor: pointer; user-select: none;">Name <span class="sort-indicator">▼</span></th>';
            html += '<th class="sortable-header" data-sort-key="artist" style="padding: 0.5em 0.3em; text-align: left; font-size: 0.85em; cursor: pointer; user-select: none;">Artist <span class="sort-indicator"></span></th>';
            html += '<th class="sortable-header" data-sort-key="duration" style="width: 70px; padding: 0.5em 0.3em; text-align: left; font-size: 0.85em; cursor: pointer; user-select: none;">Duration <span class="sort-indicator"></span></th>';
            html += '<th class="sortable-header" data-sort-key="expires" style="width: 90px; padding: 0.5em 0.3em; text-align: left; font-size: 0.85em; cursor: pointer; user-select: none;">Expires <span class="sort-indicator"></span></th>';
            html += '</tr>';
            html += '</thead>';
            html += '<tbody class="tracks-tbody">';
            html += '<tr><td colspan="6" style="padding: 1.5em; text-align: center; color: #888;">Loading tracks...</td></tr>';
            html += '</tbody>';
            html += '</table>';
            html += '</div>';
            // Pagination controls
            html += '<div class="tracks-pagination" style="display: flex; align-items: center; gap: 1em; margin-top: 0.75em; padding: 0.5em; background: #1a1a1a; border-radius: 4px;">';
            html += '<div style="display: flex; align-items: center; gap: 0.5em;">';
            html += '<span style="font-size: 0.85em; color: #888;">Show:</span>';
            html += '<select class="tracks-page-size emby-select" style="width: auto; min-width: 60px; padding: 0.3em; font-size: 0.85em;">';
            html += '<option value="20">20</option>';
            html += '<option value="50">50</option>';
            html += '<option value="100">100</option>';
            html += '</select>';
            html += '</div>';
            html += '<span style="flex: 1;"></span>';
            html += '<span class="tracks-page-info" style="font-size: 0.85em; color: #888;"></span>';
            html += '<button type="button" class="emby-button raised tracks-prev-btn" style="font-size: 0.8em; padding: 0.3em 0.6em;">← Prev</button>';
            html += '<button type="button" class="emby-button raised tracks-next-btn" style="font-size: 0.8em; padding: 0.3em 0.6em;">Next →</button>';
            html += '</div>';
            html += '</div>'; // end playlist-tracks-section

            html += '</div>'; // end playlist-details
            html += '</div>'; // end playlist-card
        });
        html += '</div>';

        container.innerHTML = html;

        // Load tracks for all expanded playlists
        var expandedSections = container.querySelectorAll('.playlist-details[style*="display: block"] .playlist-tracks-section');
        expandedSections.forEach(function (section) {
            var playlistId = section.getAttribute('data-playlist-id');
            if (playlistId) {
                loadInlineTracks(playlistId);
            }
        });

        // Set up inline tracks event handlers
        setupInlineTracksHandlers(container);
    }

    // ===== INLINE TRACKS MANAGEMENT =====
    // Load tracks for inline display in playlist card
    function loadInlineTracks(playlistId) {
        var section = document.querySelector('.playlist-tracks-section[data-playlist-id="' + playlistId + '"]');
        if (!section) return;

        var tbody = section.querySelector('.tracks-tbody');
        if (!tbody) return;

        // Check if already loaded
        if (section.getAttribute('data-tracks-loaded') === 'true') {
            return;
        }

        tbody.innerHTML = '<tr><td colspan="6" style="padding: 1.5em; text-align: center; color: #888;">Loading tracks...</td></tr>';

        var apiClient = SmartLists.getApiClient();
        var url = apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId + '/items');

        apiClient.ajax({
            type: 'GET',
            url: url,
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            var items = result.Items || [];
            // Store raw items for filtering/sorting
            section._tracksData = items;
            section.setAttribute('data-tracks-loaded', 'true');
            // Initialize pagination state
            section._paginationState = {
                currentPage: 1,
                pageSize: 20,
                sortKey: 'name',
                sortDirection: 'asc',
                filterTerm: ''
            };
            renderInlineTracksWithPagination(section, playlistId);
            updateInlineSelectionCount(section);
        }).catch(function (err) {
            console.error('[SmartLists] Error loading inline tracks:', err);
            tbody.innerHTML = '<tr><td colspan="6" style="padding: 1.5em; text-align: center; color: #f44336;">Error loading tracks.</td></tr>';
        });
    }

    // Sort items based on sort key and direction
    function sortTracksData(items, sortKey, sortDirection) {
        var sorted = items.slice(); // Clone array
        sorted.sort(function (a, b) {
            var valA, valB;
            switch (sortKey) {
                case 'name':
                    valA = (a.Name || '').toLowerCase();
                    valB = (b.Name || '').toLowerCase();
                    break;
                case 'artist':
                    valA = (a.Artist || '').toLowerCase();
                    valB = (b.Artist || '').toLowerCase();
                    break;
                case 'duration':
                    valA = a.RuntimeTicks || 0;
                    valB = b.RuntimeTicks || 0;
                    break;
                case 'ignored':
                    valA = a.IsIgnored ? 1 : 0;
                    valB = b.IsIgnored ? 1 : 0;
                    break;
                case 'expires':
                    // Sort by expiry date, permanent at end, non-ignored at start
                    if (!a.IsIgnored && !b.IsIgnored) return 0;
                    if (!a.IsIgnored) return -1;
                    if (!b.IsIgnored) return 1;
                    if (a.IsPermanentIgnore && b.IsPermanentIgnore) return 0;
                    if (a.IsPermanentIgnore) return 1;
                    if (b.IsPermanentIgnore) return -1;
                    valA = a.IgnoreExpiresAt ? new Date(a.IgnoreExpiresAt).getTime() : 0;
                    valB = b.IgnoreExpiresAt ? new Date(b.IgnoreExpiresAt).getTime() : 0;
                    break;
                default:
                    return 0;
            }
            if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
            return 0;
        });
        return sorted;
    }

    // Render tracks with pagination
    function renderInlineTracksWithPagination(section, playlistId) {
        if (!section || !section._tracksData) return;

        var tbody = section.querySelector('.tracks-tbody');
        if (!tbody) return;

        var state = section._paginationState || { currentPage: 1, pageSize: 20, sortKey: 'name', sortDirection: 'asc', filterTerm: '' };
        var items = section._tracksData;

        // Apply filter
        if (state.filterTerm) {
            var term = state.filterTerm.toLowerCase();
            items = items.filter(function (item) {
                var name = (item.Name || '').toLowerCase();
                var artist = (item.Artist || '').toLowerCase();
                return name.indexOf(term) !== -1 || artist.indexOf(term) !== -1;
            });
        }

        // Store filtered count for pagination
        section._filteredCount = items.length;

        // Apply sorting
        items = sortTracksData(items, state.sortKey, state.sortDirection);

        // Calculate pagination
        var totalItems = items.length;
        var totalPages = Math.ceil(totalItems / state.pageSize) || 1;
        if (state.currentPage > totalPages) state.currentPage = totalPages;
        if (state.currentPage < 1) state.currentPage = 1;

        var startIdx = (state.currentPage - 1) * state.pageSize;
        var endIdx = Math.min(startIdx + state.pageSize, totalItems);
        var pageItems = items.slice(startIdx, endIdx);

        // Render tracks
        renderInlineTracks(tbody, pageItems, playlistId);

        // Update pagination info
        updatePaginationControls(section, state.currentPage, totalPages, startIdx + 1, endIdx, totalItems);

        // Update sort indicators
        updateSortIndicators(section, state.sortKey, state.sortDirection);
    }

    // Update pagination controls
    function updatePaginationControls(section, currentPage, totalPages, startItem, endItem, totalItems) {
        var pageInfo = section.querySelector('.tracks-page-info');
        var prevBtn = section.querySelector('.tracks-prev-btn');
        var nextBtn = section.querySelector('.tracks-next-btn');

        if (pageInfo) {
            if (totalItems === 0) {
                pageInfo.textContent = 'No tracks';
            } else {
                pageInfo.textContent = startItem + '-' + endItem + ' of ' + totalItems;
            }
        }

        if (prevBtn) {
            prevBtn.disabled = currentPage <= 1;
            prevBtn.style.opacity = currentPage <= 1 ? '0.5' : '1';
        }

        if (nextBtn) {
            nextBtn.disabled = currentPage >= totalPages;
            nextBtn.style.opacity = currentPage >= totalPages ? '0.5' : '1';
        }
    }

    // Update sort indicators in table headers
    function updateSortIndicators(section, sortKey, sortDirection) {
        var headers = section.querySelectorAll('.sortable-header');
        headers.forEach(function (header) {
            var indicator = header.querySelector('.sort-indicator');
            var headerKey = header.getAttribute('data-sort-key');
            if (indicator) {
                if (headerKey === sortKey) {
                    indicator.textContent = sortDirection === 'asc' ? '▼' : '▲';
                } else {
                    indicator.textContent = '';
                }
            }
        });
    }

    // Render tracks in inline table
    function renderInlineTracks(tbody, items, playlistId) {
        if (!tbody) return;

        if (!items || items.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="padding: 1.5em; text-align: center; color: #888;">No tracks found.</td></tr>';
            return;
        }

        var html = '';
        items.forEach(function (item) {
            var duration = item.RuntimeTicks ? formatDuration(item.RuntimeTicks) : '--:--';
            var isIgnored = item.IsIgnored;
            var expires = '';

            if (isIgnored) {
                if (item.IsPermanentIgnore) {
                    expires = 'Never';
                } else if (item.IgnoreExpiresAt) {
                    expires = new Date(item.IgnoreExpiresAt).toLocaleDateString();
                }
            }

            var rowStyle = isIgnored ? 'border-bottom: 1px solid #333; color: #d32f2f;' : 'border-bottom: 1px solid #333;';

            html += '<tr data-item-id="' + SmartLists.escapeHtmlAttribute(item.Id) + '" ';
            html += 'data-ignore-id="' + SmartLists.escapeHtmlAttribute(item.IgnoreId || '') + '" ';
            html += 'data-is-ignored="' + (isIgnored ? 'true' : 'false') + '" ';
            html += 'data-item-name="' + SmartLists.escapeHtmlAttribute(item.Name || '') + '" ';
            html += 'data-item-artist="' + SmartLists.escapeHtmlAttribute(item.Artist || '') + '" ';
            html += 'style="' + rowStyle + '">';
            // Selection checkbox
            html += '<td style="padding: 0.4em 0.3em; text-align: center;">';
            html += '<input type="checkbox" class="inline-item-checkbox" data-item-id="' + SmartLists.escapeHtmlAttribute(item.Id) + '">';
            html += '</td>';
            // Ignored checkbox
            html += '<td style="padding: 0.4em 0.3em; text-align: center;">';
            html += '<input type="checkbox" class="inline-ignore-checkbox" data-item-id="' + SmartLists.escapeHtmlAttribute(item.Id) + '" ';
            html += 'data-ignore-id="' + SmartLists.escapeHtmlAttribute(item.IgnoreId || '') + '" ';
            html += 'data-playlist-id="' + SmartLists.escapeHtmlAttribute(playlistId) + '" ';
            html += isIgnored ? 'checked' : '';
            html += '>';
            html += '</td>';
            // Name
            html += '<td style="padding: 0.4em 0.3em; font-size: 0.9em;">' + SmartLists.escapeHtml(item.Name) + '</td>';
            // Artist
            html += '<td style="padding: 0.4em 0.3em; font-size: 0.9em; color: ' + (isIgnored ? '#d32f2f' : '#aaa') + ';">' + SmartLists.escapeHtml(item.Artist || '--') + '</td>';
            // Duration
            html += '<td style="padding: 0.4em 0.3em; font-size: 0.9em; color: ' + (isIgnored ? '#d32f2f' : '#888') + ';">' + duration + '</td>';
            // Expires
            html += '<td style="padding: 0.4em 0.3em; font-size: 0.9em; color: ' + (isIgnored ? '#ff9800' : '#666') + ';">' + (expires || '--') + '</td>';
            html += '</tr>';
        });

        tbody.innerHTML = html;
    }

    // Filter inline tracks by search term
    function filterInlineTracks(section, searchTerm) {
        if (!section || !section._tracksData) return;

        var playlistId = section.getAttribute('data-playlist-id');
        var state = section._paginationState;
        if (!state) return;

        // Update filter term and reset to page 1
        state.filterTerm = (searchTerm || '').trim();
        state.currentPage = 1;

        renderInlineTracksWithPagination(section, playlistId);
        updateInlineSelectionCount(section);
    }

    // Update selection count for inline tracks
    function updateInlineSelectionCount(section) {
        if (!section) return;
        var countEl = section.querySelector('.tracks-selection-count');
        var checkboxes = section.querySelectorAll('.inline-item-checkbox:checked');
        if (countEl) {
            countEl.textContent = checkboxes.length + ' selected';
        }
    }

    // Get selected item IDs from inline tracks
    function getInlineSelectedItemIds(section) {
        var checkboxes = section.querySelectorAll('.inline-item-checkbox:checked');
        var ids = [];
        checkboxes.forEach(function (cb) {
            ids.push(cb.getAttribute('data-item-id'));
        });
        return ids;
    }

    // Get selected ignore IDs from inline tracks
    function getInlineSelectedIgnoreIds(section) {
        var rows = section.querySelectorAll('.tracks-tbody tr');
        var ids = [];
        rows.forEach(function (row) {
            var checkbox = row.querySelector('.inline-item-checkbox');
            if (checkbox && checkbox.checked) {
                var ignoreId = row.getAttribute('data-ignore-id');
                if (ignoreId) {
                    ids.push(ignoreId);
                }
            }
        });
        return ids;
    }

    // Handle inline ignore checkbox change
    function handleInlineIgnoreCheckboxChange(checkbox) {
        var itemId = checkbox.getAttribute('data-item-id');
        var ignoreId = checkbox.getAttribute('data-ignore-id');
        var playlistId = checkbox.getAttribute('data-playlist-id');
        var isChecked = checkbox.checked;
        var section = checkbox.closest('.playlist-tracks-section');

        if (isChecked && !ignoreId) {
            // Add to ignore list
            addInlineSingleIgnore(playlistId, itemId, checkbox, section);
        } else if (!isChecked && ignoreId) {
            // Remove from ignore list
            removeInlineSingleIgnore(playlistId, ignoreId, checkbox, section);
        }
    }

    // Add single ignore from inline tracks
    function addInlineSingleIgnore(playlistId, itemId, checkbox, section) {
        var apiClient = SmartLists.getApiClient();
        var durationSelect = section ? section.querySelector('.tracks-ignore-duration') : null;
        var durationValue = durationSelect ? durationSelect.value : 'default';
        var durationDays;

        if (durationValue === 'default') {
            // Read from user's global settings in localStorage
            try {
                var stored = localStorage.getItem('smartlists_user_settings');
                if (stored) {
                    var settings = JSON.parse(stored);
                    if (typeof settings.defaultIgnoreDays === 'number') {
                        durationDays = settings.defaultIgnoreDays;
                    }
                }
            } catch (e) {
                console.error('[SmartLists] Error reading user settings:', e);
            }
            // Fall back to 30 if no user setting found
            if (durationDays === undefined) {
                durationDays = 30;
            }
        } else {
            durationDays = parseInt(durationValue, 10);
        }

        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId + '/ignores'),
            contentType: 'application/json',
            data: JSON.stringify({
                TrackId: itemId,
                DurationDays: durationDays
            })
        }).then(parseApiResponse).then(function (result) {
            // Update checkbox with new ignore ID
            checkbox.setAttribute('data-ignore-id', result.Id);
            // Update row styling and cells
            var row = checkbox.closest('tr');
            if (row) {
                row.setAttribute('data-is-ignored', 'true');
                row.setAttribute('data-ignore-id', result.Id);
                row.style.color = '#d32f2f';
                // Update Artist and Duration cell colors
                var cells = row.querySelectorAll('td');
                if (cells[3]) cells[3].style.color = '#d32f2f'; // Artist
                if (cells[4]) cells[4].style.color = '#d32f2f'; // Duration
                // Update Expires cell
                if (cells[5]) {
                    cells[5].style.color = '#ff9800';
                    if (result.ExpiresAt) {
                        cells[5].textContent = new Date(result.ExpiresAt).toLocaleDateString();
                    } else {
                        cells[5].textContent = 'Never';
                    }
                }
            }
            // Update cached data
            if (section && section._tracksData) {
                var item = section._tracksData.find(function (i) { return i.Id === itemId; });
                if (item) {
                    item.IsIgnored = true;
                    item.IgnoreId = result.Id;
                    item.IgnoreExpiresAt = result.ExpiresAt;
                    item.IsPermanentIgnore = !result.ExpiresAt;
                }
            }
            SmartLists.showNotification('Track ignored. Click "Apply" to update playlist.', 'success');
        }).catch(function (err) {
            console.error('Error adding ignore:', err);
            checkbox.checked = false; // Revert on error
            SmartLists.showNotification('Failed to ignore item', 'error');
        });
    }

    // Remove single ignore from inline tracks
    function removeInlineSingleIgnore(playlistId, ignoreId, checkbox, section) {
        var apiClient = SmartLists.getApiClient();
        var itemId = checkbox.getAttribute('data-item-id');

        apiClient.ajax({
            type: 'DELETE',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId + '/ignores/' + ignoreId),
            contentType: 'application/json'
        }).then(function (response) {
            // Handle fetch Response (check for ok) or direct response (assume success)
            if (response && typeof response.ok !== 'undefined' && !response.ok && response.status !== 204) {
                throw new Error('Failed to remove ignore');
            }
            // Clear ignore ID from checkbox
            checkbox.setAttribute('data-ignore-id', '');
            // Update row styling and cells
            var row = checkbox.closest('tr');
            if (row) {
                row.setAttribute('data-is-ignored', 'false');
                row.setAttribute('data-ignore-id', '');
                row.style.color = '';
                // Update Artist and Duration cell colors
                var cells = row.querySelectorAll('td');
                if (cells[3]) cells[3].style.color = '#aaa'; // Artist
                if (cells[4]) cells[4].style.color = '#888'; // Duration
                // Clear Expires cell
                if (cells[5]) {
                    cells[5].style.color = '#666';
                    cells[5].textContent = '--';
                }
            }
            // Update cached data
            if (section && section._tracksData) {
                var item = section._tracksData.find(function (i) { return i.Id === itemId; });
                if (item) {
                    item.IsIgnored = false;
                    item.IgnoreId = null;
                    item.IgnoreExpiresAt = null;
                    item.IsPermanentIgnore = false;
                }
            }
            SmartLists.showNotification('Ignore removed. Click "Apply" to update playlist.', 'success');
        }).catch(function (err) {
            console.error('Error removing ignore:', err);
            checkbox.checked = true; // Revert on error
            SmartLists.showNotification('Failed to remove ignore', 'error');
        });
    }

    // Bulk ignore for inline tracks
    function bulkInlineIgnore(section) {
        var playlistId = section.getAttribute('data-playlist-id');
        var selectedIds = getInlineSelectedItemIds(section);
        if (selectedIds.length === 0) {
            SmartLists.showNotification('Please select items to ignore.', 'warning');
            return;
        }

        var durationSelect = section.querySelector('.tracks-ignore-duration');
        var durationValue = durationSelect ? durationSelect.value : 'default';
        var durationDays;

        if (durationValue === 'default') {
            try {
                var stored = localStorage.getItem('smartlists_user_settings');
                if (stored) {
                    var settings = JSON.parse(stored);
                    if (typeof settings.defaultIgnoreDays === 'number') {
                        durationDays = settings.defaultIgnoreDays;
                    }
                }
            } catch (e) {
                console.error('[SmartLists] Error reading user settings:', e);
            }
            if (durationDays === undefined) {
                durationDays = 30;
            }
        } else {
            durationDays = parseInt(durationValue, 10);
        }

        SmartLists.showNotification('Ignoring ' + selectedIds.length + ' items...', 'info');

        var apiClient = SmartLists.getApiClient();
        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId + '/ignores/bulk'),
            data: JSON.stringify({
                TrackIds: selectedIds,
                DurationDays: durationDays,
                AutoRefresh: false
            }),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            SmartLists.showNotification('Ignored ' + result.Added + ' items.', 'success');
            // Reload tracks for this playlist
            section.setAttribute('data-tracks-loaded', 'false');
            loadInlineTracks(playlistId);
            // Uncheck select all
            var selectAll = section.querySelector('.tracks-select-all');
            if (selectAll) selectAll.checked = false;
        }).catch(function (err) {
            console.error('[SmartLists] Error bulk ignoring items:', err);
            SmartLists.showNotification('Failed to ignore items: ' + err.message, 'error');
        });
    }

    // Apply changes - refresh the playlist
    function applyInlineChanges(playlistId, playlistName) {
        SmartLists.showNotification('Applying changes and refreshing "' + playlistName + '"...', 'info');

        var apiClient = SmartLists.getApiClient();
        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId + '/refresh'),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            if (result.Success) {
                var itemCount = result.ItemCount || 0;
                var runtime = result.TotalRuntimeMinutes ? Math.round(result.TotalRuntimeMinutes) + ' min' : '';
                var message = 'Playlist "' + playlistName + '" updated with ' + itemCount + ' items';
                if (runtime) {
                    message += ' (' + runtime + ')';
                }
                SmartLists.showNotification(message + '.', 'success');
            } else {
                SmartLists.showNotification('Refresh failed: ' + (result.Message || 'Unknown error'), 'error');
            }
            // Reload the playlist list (this will also reload tracks for expanded playlists)
            var page = document.querySelector('.page');
            if (page) {
                loadUserPlaylistList(page, false);
            }
        }).catch(function (err) {
            console.error('Error refreshing playlist:', err);
            SmartLists.showNotification('Failed to refresh playlist: ' + err.message, 'error');
        });
    }

    // Bulk unignore for inline tracks
    function bulkInlineUnignore(section) {
        var playlistId = section.getAttribute('data-playlist-id');
        var selectedIgnoreIds = getInlineSelectedIgnoreIds(section);
        if (selectedIgnoreIds.length === 0) {
            SmartLists.showNotification('Please select ignored items to remove ignore from.', 'warning');
            return;
        }

        SmartLists.showNotification('Removing ignores from ' + selectedIgnoreIds.length + ' items...', 'info');

        var apiClient = SmartLists.getApiClient();
        apiClient.ajax({
            type: 'DELETE',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId + '/ignores/bulk'),
            data: JSON.stringify({
                IgnoreIds: selectedIgnoreIds,
                AutoRefresh: false
            }),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            SmartLists.showNotification('Removed ignore from ' + result.Removed + ' items.', 'success');
            // Reload tracks for this playlist
            section.setAttribute('data-tracks-loaded', 'false');
            loadInlineTracks(playlistId);
            // Uncheck select all
            var selectAll = section.querySelector('.tracks-select-all');
            if (selectAll) selectAll.checked = false;
        }).catch(function (err) {
            console.error('[SmartLists] Error bulk removing ignores:', err);
            SmartLists.showNotification('Failed to remove ignores: ' + err.message, 'error');
        });
    }

    // Launch wizard to add media to an existing playlist
    function launchAddMediaWizard(playlistId, playlistName) {
        // Navigate to wizard with edit mode parameters
        var params = new URLSearchParams();
        params.set('name', playlistName);
        params.set('editId', playlistId);
        params.set('startStep', '2');

        window.location.href = 'configurationpage?name=user-wizard.html#?' + params.toString();
    }

    // Remove selected tracks from playlist
    function removeSelectedTracks(section, playlistId) {
        var selectedItemIds = getInlineSelectedItemIds(section);
        if (selectedItemIds.length === 0) {
            SmartLists.showNotification('No media selected', 'warning');
            return;
        }

        // Confirm removal
        if (!confirm('Remove ' + selectedItemIds.length + ' item(s) from this playlist?')) {
            return;
        }

        SmartLists.showNotification('Removing ' + selectedItemIds.length + ' items...', 'info');

        var apiClient = SmartLists.getApiClient();
        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId + '/remove-items'),
            data: JSON.stringify({
                ItemIds: selectedItemIds
            }),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            SmartLists.showNotification('Removed ' + result.Removed + ' items from playlist.', 'success');
            // Reload tracks for this playlist
            section.setAttribute('data-tracks-loaded', 'false');
            loadInlineTracks(playlistId);
            // Uncheck select all
            var selectAll = section.querySelector('.tracks-select-all');
            if (selectAll) selectAll.checked = false;
            // Reload the playlist list to update item counts
            var page = document.querySelector('.UserSmartListsConfigurationPage');
            if (page) {
                loadUserPlaylistList(page);
            }
        }).catch(function (err) {
            console.error('[SmartLists] Error removing items:', err);
            SmartLists.showNotification('Failed to remove items: ' + err.message, 'error');
        });
    }

    // Set up event handlers for inline tracks controls
    function setupInlineTracksHandlers(container) {
        // Prevent duplicate handlers when playlist list is re-rendered
        if (container._inlineHandlersSet) return;
        container._inlineHandlersSet = true;

        // Use event delegation for all inline tracks controls
        container.addEventListener('change', function (e) {
            var target = e.target;

            // Select all checkbox
            if (target.classList.contains('tracks-select-all')) {
                var section = target.closest('.playlist-tracks-section');
                var isChecked = target.checked;
                var checkboxes = section.querySelectorAll('.inline-item-checkbox');
                checkboxes.forEach(function (cb) {
                    cb.checked = isChecked;
                });
                updateInlineSelectionCount(section);
            }

            // Individual item checkbox
            if (target.classList.contains('inline-item-checkbox')) {
                var section = target.closest('.playlist-tracks-section');
                updateInlineSelectionCount(section);
                // Update select all state
                var allCheckboxes = section.querySelectorAll('.inline-item-checkbox');
                var checkedCount = section.querySelectorAll('.inline-item-checkbox:checked').length;
                var selectAllCheckbox = section.querySelector('.tracks-select-all');
                if (selectAllCheckbox) {
                    selectAllCheckbox.checked = allCheckboxes.length > 0 && checkedCount === allCheckboxes.length;
                }
            }

            // Inline ignore checkbox
            if (target.classList.contains('inline-ignore-checkbox')) {
                handleInlineIgnoreCheckboxChange(target);
            }

            // Page size dropdown
            if (target.classList.contains('tracks-page-size')) {
                var section = target.closest('.playlist-tracks-section');
                if (section && section._paginationState) {
                    section._paginationState.pageSize = parseInt(target.value, 10) || 20;
                    section._paginationState.currentPage = 1; // Reset to first page
                    var playlistId = section.getAttribute('data-playlist-id');
                    renderInlineTracksWithPagination(section, playlistId);
                }
            }
        });

        // Click handlers for buttons
        container.addEventListener('click', function (e) {
            var target = e.target;

            // Ignore button
            if (target.classList.contains('tracks-ignore-btn')) {
                var section = target.closest('.playlist-tracks-section');
                if (section) {
                    bulkInlineIgnore(section);
                }
            }

            // Unignore button
            if (target.classList.contains('tracks-unignore-btn')) {
                var section = target.closest('.playlist-tracks-section');
                if (section) {
                    bulkInlineUnignore(section);
                }
            }

            // Add Media button - launch wizard at step 2
            if (target.classList.contains('tracks-add-media-btn')) {
                var playlistId = target.getAttribute('data-playlist-id');
                var playlistName = target.getAttribute('data-playlist-name');
                if (playlistId && playlistName) {
                    launchAddMediaWizard(playlistId, playlistName);
                }
            }

            // Remove button - remove selected tracks from playlist
            if (target.classList.contains('tracks-remove-btn')) {
                var section = target.closest('.playlist-tracks-section');
                var playlistId = target.getAttribute('data-playlist-id');
                if (section && playlistId) {
                    removeSelectedTracks(section, playlistId);
                }
            }

            // Apply button - refresh the playlist
            if (target.classList.contains('tracks-apply-btn')) {
                var playlistId = target.getAttribute('data-playlist-id');
                var playlistName = target.getAttribute('data-playlist-name');
                if (playlistId) {
                    applyInlineChanges(playlistId, playlistName);
                }
            }

            // Sortable header click
            var header = target.closest('.sortable-header');
            if (header) {
                var section = header.closest('.playlist-tracks-section');
                var sortKey = header.getAttribute('data-sort-key');
                if (section && sortKey && section._paginationState) {
                    var state = section._paginationState;
                    if (state.sortKey === sortKey) {
                        // Toggle direction
                        state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
                    } else {
                        // New column, default to ascending
                        state.sortKey = sortKey;
                        state.sortDirection = 'asc';
                    }
                    state.currentPage = 1; // Reset to first page on sort
                    var playlistId = section.getAttribute('data-playlist-id');
                    renderInlineTracksWithPagination(section, playlistId);
                }
            }

            // Previous page button
            if (target.classList.contains('tracks-prev-btn')) {
                var section = target.closest('.playlist-tracks-section');
                if (section && section._paginationState && section._paginationState.currentPage > 1) {
                    section._paginationState.currentPage--;
                    var playlistId = section.getAttribute('data-playlist-id');
                    renderInlineTracksWithPagination(section, playlistId);
                }
            }

            // Next page button
            if (target.classList.contains('tracks-next-btn')) {
                var section = target.closest('.playlist-tracks-section');
                if (section && section._paginationState) {
                    var state = section._paginationState;
                    var totalItems = section._filteredCount || (section._tracksData ? section._tracksData.length : 0);
                    var totalPages = Math.ceil(totalItems / state.pageSize) || 1;
                    if (state.currentPage < totalPages) {
                        state.currentPage++;
                        var playlistId = section.getAttribute('data-playlist-id');
                        renderInlineTracksWithPagination(section, playlistId);
                    }
                }
            }
        });

        // Search input with debounce
        container.addEventListener('input', function (e) {
            var target = e.target;
            if (target.classList.contains('tracks-search')) {
                var section = target.closest('.playlist-tracks-section');
                if (section) {
                    clearTimeout(section._searchTimeout);
                    section._searchTimeout = setTimeout(function () {
                        filterInlineTracks(section, target.value);
                    }, 300);
                }
            }
        });
    }

    function togglePlaylistCard(card) {
        var details = card.querySelector('.playlist-details');
        var icon = card.querySelector('.expand-icon');
        if (details) {
            var isHidden = details.style.display === 'none';
            details.style.display = isHidden ? 'block' : 'none';
            if (icon) {
                // ▾ (down) when expanded, ▸ (right) when collapsed
                icon.innerHTML = isHidden ? '&#9662;' : '&#9656;';
            }
            // Load tracks when expanding
            if (isHidden) {
                var section = details.querySelector('.playlist-tracks-section');
                if (section) {
                    var playlistId = section.getAttribute('data-playlist-id');
                    if (playlistId) {
                        loadInlineTracks(playlistId);
                    }
                }
            }
        }
    }

    function toggleAllPlaylists(page) {
        var container = page.querySelector('#playlist-list-container');
        if (!container) return;

        var cards = container.querySelectorAll('.playlist-card');
        var toggleBtn = page.querySelector('#toggleAllPlaylistsBtn');
        if (!cards.length) return;

        // Check current state - if any is expanded, collapse all; otherwise expand all
        var anyExpanded = false;
        cards.forEach(function (card) {
            var details = card.querySelector('.playlist-details');
            if (details && details.style.display !== 'none') {
                anyExpanded = true;
            }
        });

        // Toggle all to opposite state
        var shouldExpand = !anyExpanded;
        cards.forEach(function (card) {
            var details = card.querySelector('.playlist-details');
            var icon = card.querySelector('.expand-icon');
            if (details) {
                details.style.display = shouldExpand ? 'block' : 'none';
            }
            if (icon) {
                // ▾ (down) when expanded, ▸ (right) when collapsed
                icon.innerHTML = shouldExpand ? '&#9662;' : '&#9656;';
            }
            // Load tracks when expanding
            if (shouldExpand) {
                var section = card.querySelector('.playlist-tracks-section');
                if (section) {
                    var playlistId = section.getAttribute('data-playlist-id');
                    if (playlistId) {
                        loadInlineTracks(playlistId);
                    }
                }
            }
        });

        // Update button text
        if (toggleBtn) {
            toggleBtn.textContent = shouldExpand ? 'Collapse All' : 'Show All';
        }
    }

    function applyUserSearchFilter(page) {
        if (page._allPlaylists) {
            renderUserPlaylistList(page, page._allPlaylists);
        }
    }

    // ===== PLAYLIST CRUD =====
    function createOrUpdateUserPlaylist(page) {
        var editState = SmartLists.getPageEditState(page);
        var apiClient = SmartLists.getApiClient();

        // Gather form data
        var name = page.querySelector('#playlistName').value.trim();
        if (!name) {
            SmartLists.showNotification('Please enter a playlist name.', 'error');
            return;
        }

        var mediaTypes = SmartLists.getSelectedMediaTypes(page);
        if (!mediaTypes || mediaTypes.length === 0) {
            SmartLists.showNotification('Please select at least one media type.', 'error');
            return;
        }

        // Gather expression sets from rules using shared function
        var expressionSets = SmartLists.collectRulesFromForm ? SmartLists.collectRulesFromForm(page) : null;

        // Gather sort options using shared function
        var orderDto = null;
        if (SmartLists.collectSortsFromForm) {
            var sorts = SmartLists.collectSortsFromForm(page);
            if (sorts && sorts.length > 0) {
                orderDto = {
                    Primary: sorts[0] || null,
                    Secondary: sorts[1] || null,
                    Tertiary: sorts[2] || null
                };
            }
        }

        // Get public checkbox value (from edit form)
        var publicCheckbox = page.querySelector('#editPlaylistIsPublic');
        var isPublic = publicCheckbox ? publicCheckbox.checked : false;

        var playlistData = {
            Name: name,
            MediaTypes: mediaTypes,
            SourcePlaylistId: null, // Not used in edit form
            ExpressionSets: expressionSets,
            Order: orderDto,
            MaxItems: parseInt(page.querySelector('#playlistMaxItems').value, 10) || null,
            MaxPlayTimeMinutes: parseInt(page.querySelector('#playlistMaxPlayTimeMinutes').value, 10) || null,
            Public: isPublic,
            Enabled: page.querySelector('#playlistIsEnabled').checked,
            DefaultIgnoreDurationDays: parseInt(page.querySelector('#defaultIgnoreDurationDays').value, 10) || 30
        };

        // If MaxItems or MaxPlayTimeMinutes is 0, set to null (no limit)
        if (playlistData.MaxItems === 0) playlistData.MaxItems = null;
        if (playlistData.MaxPlayTimeMinutes === 0) playlistData.MaxPlayTimeMinutes = null;

        var url, method;
        if (editState.editMode && editState.editingPlaylistId) {
            url = apiClient.getUrl(USER_ENDPOINTS.base + '/' + editState.editingPlaylistId);
            method = 'PUT';
        } else {
            url = apiClient.getUrl(USER_ENDPOINTS.base);
            method = 'POST';
        }

        apiClient.ajax({
            type: method,
            url: url,
            contentType: 'application/json',
            data: JSON.stringify(playlistData)
        }).then(parseApiResponse).then(function (savedPlaylist) {
            var message = editState.editMode ? 'Playlist updated successfully!' : 'Playlist created successfully!';
            SmartLists.showNotification(message, 'success');

            // Clear edit mode and form
            SmartLists.setPageEditState(page, false, null);
            clearUserForm(page);

            // Switch to manage tab
            switchUserTab(page, 'manage');
        }).catch(function (err) {
            console.error('Error saving playlist:', err);
            SmartLists.showNotification('Failed to save playlist: ' + err.message, 'error');
        });
    }

    function editUserPlaylist(page, playlistId) {
        var apiClient = SmartLists.getApiClient();

        apiClient.ajax({
            type: 'GET',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (playlist) {
            populateFormForEdit(page, playlist);
            SmartLists.setPageEditState(page, true, playlistId);

            var submitBtn = page.querySelector('#submitBtn');
            if (submitBtn) {
                submitBtn.textContent = 'Update Playlist';
            }

            // Switch to edit tab (not create tab which is now landing page)
            switchUserTab(page, 'edit');
        }).catch(function (err) {
            console.error('Error loading playlist for edit:', err);
            SmartLists.showNotification('Failed to load playlist: ' + err.message, 'error');
        });
    }

    function populateFormForEdit(page, playlist) {
        // Clear form first
        clearUserForm(page, true);

        // Name
        page.querySelector('#playlistName').value = playlist.Name || '';

        // Source playlist
        var sourceSelect = page.querySelector('#sourcePlaylist');
        if (sourceSelect && playlist.SourcePlaylistId) {
            sourceSelect.value = playlist.SourcePlaylistId;
        }

        // Media types
        if (playlist.MediaTypes && playlist.MediaTypes.length > 0) {
            SmartLists.setSelectedMediaTypesForUser(page, playlist.MediaTypes);
        }

        // Max items
        page.querySelector('#playlistMaxItems').value = playlist.MaxItems || 0;
        page.querySelector('#playlistMaxPlayTimeMinutes').value = playlist.MaxPlayTimeMinutes || 0;

        // Checkboxes (use edit form IDs)
        var publicCheckbox = page.querySelector('#editPlaylistIsPublic');
        if (publicCheckbox) {
            publicCheckbox.checked = playlist.Public || false;
        }
        page.querySelector('#playlistIsEnabled').checked = playlist.Enabled !== false;

        // Ignore duration
        page.querySelector('#defaultIgnoreDurationDays').value = playlist.DefaultIgnoreDurationDays || 30;

        // Expression sets (rules) - use same pattern as admin config
        var rulesContainer = page.querySelector('#rules-container');
        if (rulesContainer) {
            rulesContainer.innerHTML = '';
        }

        if (playlist.ExpressionSets && playlist.ExpressionSets.length > 0 &&
            playlist.ExpressionSets.some(function (es) { return es.Expressions && es.Expressions.length > 0; })) {
            playlist.ExpressionSets.forEach(function (expressionSet, groupIndex) {
                var logicGroup;

                if (groupIndex === 0) {
                    logicGroup = SmartLists.createInitialLogicGroup(page);
                    var rulesToRemove = logicGroup.querySelectorAll('.rule-row, .rule-within-group-separator');
                    rulesToRemove.forEach(function (rule) { rule.remove(); });
                } else {
                    logicGroup = SmartLists.addNewLogicGroup(page);
                    var rulesToRemove = logicGroup.querySelectorAll('.rule-row, .rule-within-group-separator');
                    rulesToRemove.forEach(function (rule) { rule.remove(); });
                }

                if (expressionSet.Expressions && expressionSet.Expressions.length > 0) {
                    expressionSet.Expressions.forEach(function (expression) {
                        SmartLists.addRuleToGroup(page, logicGroup);
                        var ruleRows = logicGroup.querySelectorAll('.rule-row');
                        var currentRule = ruleRows[ruleRows.length - 1];
                        if (SmartLists.populateRuleRow) {
                            SmartLists.populateRuleRow(currentRule, expression, page);
                        }
                    });
                }
            });

            // Update field and option visibility
            if (SmartLists.updateAllFieldSelects) SmartLists.updateAllFieldSelects(page);
            if (SmartLists.updateRuleButtonVisibility) SmartLists.updateRuleButtonVisibility(page);
        } else {
            SmartLists.createInitialLogicGroup(page);
        }

        // Sort options
        if (playlist.Order && SmartLists.initializeSortSystem) {
            SmartLists.initializeSortSystem(page);
            var sortsContainer = page.querySelector('#sorts-container');
            if (sortsContainer) {
                sortsContainer.innerHTML = '';
            }

            if (playlist.Order.Primary) {
                SmartLists.addSortBox(page, playlist.Order.Primary);
            }
            if (playlist.Order.Secondary) {
                SmartLists.addSortBox(page, playlist.Order.Secondary);
            }
            if (playlist.Order.Tertiary) {
                SmartLists.addSortBox(page, playlist.Order.Tertiary);
            }
        }
    }

    function clearUserForm(page, preserveEditState) {
        // Clear name
        var nameInput = page.querySelector('#playlistName');
        if (nameInput) {
            nameInput.value = '';
        }

        // Clear media types
        SmartLists.clearMediaTypeCheckboxes(page);

        // Reset values
        var maxItemsInput = page.querySelector('#playlistMaxItems');
        if (maxItemsInput) maxItemsInput.value = 0;

        var maxPlaytimeInput = page.querySelector('#playlistMaxPlayTimeMinutes');
        if (maxPlaytimeInput) maxPlaytimeInput.value = 0;

        var publicCheckbox = page.querySelector('#editPlaylistIsPublic');
        if (publicCheckbox) publicCheckbox.checked = false;

        var enabledCheckbox = page.querySelector('#playlistIsEnabled');
        if (enabledCheckbox) enabledCheckbox.checked = true;

        var ignoreDurationInput = page.querySelector('#defaultIgnoreDurationDays');
        if (ignoreDurationInput) ignoreDurationInput.value = 30;

        // Clear rules
        var rulesContainer = page.querySelector('#rules-container');
        if (rulesContainer) {
            rulesContainer.innerHTML = '';
            SmartLists.createInitialLogicGroup(page);
        }

        // Reset sorts
        if (SmartLists.initializeSortSystem) {
            SmartLists.initializeSortSystem(page);
        }
        var sortsContainer = page.querySelector('#sorts-container');
        if (sortsContainer) {
            sortsContainer.innerHTML = '';
            SmartLists.addSortBox(page, { SortBy: 'Name', SortOrder: 'Ascending' });
        }

        if (!preserveEditState) {
            // Clear edit mode
            SmartLists.setPageEditState(page, false, null);

            var submitBtn = page.querySelector('#submitBtn');
            if (submitBtn) {
                submitBtn.textContent = 'Update Playlist';
            }
        }
    }

    function cancelUserEdit(page) {
        clearUserForm(page);
        switchUserTab(page, 'manage');
    }

    // ===== DELETE =====
    var pendingDeleteId = null;

    function showDeleteConfirm(page, playlistId, playlistName) {
        pendingDeleteId = playlistId;
        var modal = document.querySelector('#delete-confirm-modal');
        var confirmText = document.querySelector('#delete-confirm-text');

        if (confirmText) {
            confirmText.textContent = 'Are you sure you want to delete "' + playlistName + '"?';
        }

        if (modal) {
            modal.classList.remove('hide');
            modal.style.display = '';
            applyModalStyles(modal);
        }
    }

    function hideDeleteModal(page) {
        var modal = document.querySelector('#delete-confirm-modal');
        if (modal) {
            modal.classList.add('hide');
            modal.style.display = 'none';
            // Clear backdrop styles applied by applyModalStyles
            removeModalStyles(modal);
        }
        pendingDeleteId = null;
    }

    function confirmDelete(page) {
        if (!pendingDeleteId) return;

        var apiClient = SmartLists.getApiClient();

        // Delete the smart playlist AND its associated Jellyfin playlist
        // Note: This only deletes the JellyfinPlaylistId we created, NOT the SourcePlaylistId we cloned from
        apiClient.ajax({
            type: 'DELETE',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + pendingDeleteId + '?deleteJellyfinPlaylist=true'),
            contentType: 'application/json'
        }).then(function (response) {
            // Handle fetch Response (check for ok) or direct response (assume success)
            if (response && typeof response.ok !== 'undefined' && !response.ok && response.status !== 204) {
                return response.text().then(function (text) {
                    throw new Error(text || 'Failed to delete playlist');
                });
            }
            SmartLists.showNotification('Playlist deleted successfully!', 'success');
            hideDeleteModal(page);
            loadUserPlaylistList(page);
        }).catch(function (err) {
            console.error('[SmartLists] Error deleting playlist:', err);
            SmartLists.showNotification('Failed to delete playlist: ' + err.message, 'error');
            hideDeleteModal(page);
        });
    }

    // ===== REFRESH =====
    function refreshUserPlaylist(playlistId, playlistName) {
        var apiClient = SmartLists.getApiClient();
        var page = document.querySelector('.UserSmartListsConfigurationPage');

        SmartLists.showNotification('Refreshing "' + playlistName + '"...', 'info');

        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId + '/refresh'),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            if (result.Success) {
                var itemCount = result.ItemCount || 0;
                var runtime = result.TotalRuntimeMinutes ? Math.round(result.TotalRuntimeMinutes) + ' min' : '';
                var message = 'Playlist "' + playlistName + '" refreshed with ' + itemCount + ' items';
                if (runtime) {
                    message += ' (' + runtime + ')';
                }
                SmartLists.showNotification(message + '.', 'success');
                // Reload the playlist list to show updated item count
                if (page) {
                    loadUserPlaylistList(page);
                }
            } else {
                SmartLists.showNotification('Refresh failed: ' + (result.Message || 'Unknown error'), 'error');
            }
        }).catch(function (err) {
            console.error('Error refreshing playlist:', err);
            SmartLists.showNotification('Failed to refresh playlist: ' + err.message, 'error');
        });
    }

    function showRefreshConfirmModal(page) {
        var modal = document.querySelector('#refresh-confirm-modal');
        if (modal) {
            modal.classList.remove('hide');
            modal.style.display = '';
            applyModalStyles(modal);
        }
    }

    function hideRefreshConfirmModal(page) {
        var modal = document.querySelector('#refresh-confirm-modal');
        if (modal) {
            modal.classList.add('hide');
            modal.style.display = 'none';
            // Clear backdrop styles applied by applyModalStyles
            removeModalStyles(modal);
        }
    }

    function refreshAllUserPlaylists(page) {
        var apiClient = SmartLists.getApiClient();

        SmartLists.showNotification('Refreshing all playlists...', 'info');

        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.refresh),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            SmartLists.showNotification('Refreshed ' + result.SuccessCount + ' playlists. ' + (result.FailureCount > 0 ? result.FailureCount + ' failed.' : ''), result.FailureCount > 0 ? 'warning' : 'success');
            loadUserPlaylistList(page);
        }).catch(function (err) {
            console.error('[SmartLists] Error refreshing all playlists:', err);
            SmartLists.showNotification('Failed to refresh playlists: ' + err.message, 'error');
        });
    }

    // Auto-refresh on first page load (no confirmation modal)
    function autoRefreshAllPlaylists(page) {
        var apiClient = SmartLists.getApiClient();
        if (!apiClient) return;

        SmartLists.showNotification('Syncing playlists...', 'info');

        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.refresh),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            if (result.SuccessCount > 0 || result.FailureCount > 0) {
                var message = 'Synced ' + result.SuccessCount + ' playlist' + (result.SuccessCount !== 1 ? 's' : '');
                if (result.FailureCount > 0) {
                    message += ' (' + result.FailureCount + ' failed)';
                }
                SmartLists.showNotification(message + '.', result.FailureCount > 0 ? 'warning' : 'success');
            }
            // Reload the list with updated counts (no auto-refresh this time)
            loadUserPlaylistList(page, false);
        }).catch(function (err) {
            console.error('[SmartLists] Error auto-refreshing playlists:', err);
            // Don't show error for auto-refresh - it's not critical
        });
    }

    // ===== IGNORE LIST =====
    var currentIgnorePlaylistId = null;

    function showIgnoreListModal(page, playlistId, playlistName) {
        currentIgnorePlaylistId = playlistId;
        var modal = document.querySelector('#ignore-list-modal');
        var nameEl = document.querySelector('#ignore-list-playlist-name');
        var container = document.querySelector('#ignore-list-container');

        if (nameEl) {
            nameEl.textContent = 'Playlist: ' + playlistName;
        }

        if (container) {
            container.innerHTML = '<p style="color: #aaa;">Loading ignored tracks...</p>';
        }

        if (modal) {
            modal.classList.remove('hide');
            modal.style.display = '';
            applyModalStyles(modal);
        }

        loadIgnoreList(page, playlistId);
    }

    function hideIgnoreListModal(page) {
        var modal = document.querySelector('#ignore-list-modal');
        if (modal) {
            modal.classList.add('hide');
            modal.style.display = 'none';
            // Clear backdrop styles applied by applyModalStyles
            removeModalStyles(modal);
        }
        currentIgnorePlaylistId = null;
    }

    function loadIgnoreList(page, playlistId) {
        var apiClient = SmartLists.getApiClient();
        var container = page.querySelector('#ignore-list-container');

        apiClient.ajax({
            type: 'GET',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + playlistId + '/ignores'),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (ignores) {
            renderIgnoreList(container, ignores);
        }).catch(function (err) {
            console.error('[SmartLists] Error loading ignore list:', err);
            if (container) {
                container.innerHTML = '<p style="color: #f44336;">Error loading ignored tracks.</p>';
            }
        });
    }

    function renderIgnoreList(container, ignores) {
        if (!container) return;

        if (!ignores || ignores.length === 0) {
            container.innerHTML = '<p style="color: #aaa;">No ignored tracks.</p>';
            return;
        }

        var html = '<div style="max-height: 400px; overflow-y: auto;">';
        ignores.forEach(function (ignore) {
            var expiresText = ignore.ExpiresAt ? 'Expires: ' + new Date(ignore.ExpiresAt).toLocaleDateString() : 'Permanent';
            var trackInfo = ignore.TrackName || ignore.TrackId;
            if (ignore.ArtistName) {
                trackInfo += ' - ' + ignore.ArtistName;
            }

            html += '<div class="ignore-item" style="padding: 0.75em; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center;">';
            html += '<div style="flex: 1;">';
            html += '<div style="font-weight: bold;">' + SmartLists.escapeHtml(trackInfo) + '</div>';
            html += '<div style="font-size: 0.85em; color: #888;">' + expiresText + '</div>';
            if (ignore.Reason) {
                html += '<div style="font-size: 0.85em; color: #666;">Reason: ' + SmartLists.escapeHtml(ignore.Reason) + '</div>';
            }
            html += '</div>';
            html += '<button type="button" class="emby-button raised remove-ignore-btn" data-ignore-id="' + SmartLists.escapeHtmlAttribute(ignore.Id) + '" style="font-size: 0.8em;">Remove</button>';
            html += '</div>';
        });
        html += '</div>';

        container.innerHTML = html;
    }

    function removeIgnore(page, ignoreId) {
        if (!currentIgnorePlaylistId) return;

        var apiClient = SmartLists.getApiClient();

        apiClient.ajax({
            type: 'DELETE',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + currentIgnorePlaylistId + '/ignores/' + ignoreId),
            contentType: 'application/json'
        }).then(function (response) {
            // Handle fetch Response (check for ok) or direct response (assume success)
            if (response && typeof response.ok !== 'undefined' && !response.ok && response.status !== 204) {
                throw new Error('Failed to remove ignore');
            }
            SmartLists.showNotification('Ignore removed.', 'success');
            loadIgnoreList(page, currentIgnorePlaylistId);
        }).catch(function (err) {
            console.error('[SmartLists] Error removing ignore:', err);
            SmartLists.showNotification('Failed to remove ignore: ' + err.message, 'error');
        });
    }

    function clearAllIgnores(page) {
        if (!currentIgnorePlaylistId) return;

        var apiClient = SmartLists.getApiClient();

        apiClient.ajax({
            type: 'DELETE',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + currentIgnorePlaylistId + '/ignores'),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (count) {
            SmartLists.showNotification('Cleared ' + count + ' ignored tracks.', 'success');
            loadIgnoreList(page, currentIgnorePlaylistId);
        }).catch(function (err) {
            console.error('[SmartLists] Error clearing ignores:', err);
            SmartLists.showNotification('Failed to clear ignores: ' + err.message, 'error');
        });
    }

    // ===== UTILITY FUNCTIONS =====
    function formatDuration(ticks) {
        var seconds = Math.floor(ticks / 10000000);
        var minutes = Math.floor(seconds / 60);
        var remainingSeconds = seconds % 60;
        return minutes + ':' + (remainingSeconds < 10 ? '0' : '') + remainingSeconds;
    }

    // ===== EXPORT/IMPORT =====
    function exportUserPlaylists() {
        var apiClient = SmartLists.getApiClient();
        var url = apiClient.getUrl(USER_ENDPOINTS.export);

        fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"',
                'Content-Type': 'application/json'
            }
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('Export failed');
            }

            var contentDisposition = response.headers.get('Content-Disposition');
            var filename = 'smartlists-export.zip';
            if (contentDisposition) {
                var matches = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                if (matches && matches[1]) {
                    filename = matches[1].replace(/['"]/g, '');
                }
            }

            return response.blob().then(function (blob) {
                var blobUrl = window.URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(blobUrl);
                document.body.removeChild(a);
                SmartLists.showNotification('Export completed!', 'success');
            });
        }).catch(function (err) {
            console.error('Export error:', err);
            SmartLists.showNotification('Export failed: ' + err.message, 'error');
        });
    }

    function importUserPlaylists(page) {
        var fileInput = page.querySelector('#importPlaylistsFile');
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            SmartLists.showNotification('Please select a file to import.', 'error');
            return;
        }

        var file = fileInput.files[0];
        var formData = new FormData();
        formData.append('file', file);

        var apiClient = SmartLists.getApiClient();
        var url = apiClient.getUrl(USER_ENDPOINTS.import);

        SmartLists.showNotification('Importing playlists...', 'info');

        fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"'
            },
            body: formData
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('Import failed');
            }
            return response.json();
        }).then(function (result) {
            var message = 'Imported ' + result.Imported + ' playlists.';
            if (result.Errors && result.Errors.length > 0) {
                message += ' ' + result.Errors.length + ' errors.';
            }
            SmartLists.showNotification(message, result.Errors && result.Errors.length > 0 ? 'warning' : 'success');

            // Clear file input
            fileInput.value = '';

            // Reload playlist list and trigger auto-refresh to update item counts and ignore counts
            loadUserPlaylistList(page, true);
        }).catch(function (err) {
            console.error('Import error:', err);
            SmartLists.showNotification('Import failed: ' + err.message, 'error');
        });
    }

    // ===== MODAL STYLING =====
    function applyModalStyles(modal) {
        var container = modal.querySelector('.custom-modal-container');
        if (container) {
            SmartLists.applyStyles(container, SmartLists.STYLES.modal.container);
        }

        // Apply backdrop styling to the modal itself
        SmartLists.applyStyles(modal, SmartLists.STYLES.modal.backdrop);
    }

    function removeModalStyles(modal) {
        // Clear the inline backdrop styles that were applied by applyModalStyles
        // This ensures the modal is fully hidden and doesn't leave a visible overlay
        modal.style.position = '';
        modal.style.top = '';
        modal.style.left = '';
        modal.style.width = '';
        modal.style.height = '';
        modal.style.backgroundColor = '';
        modal.style.zIndex = '';
    }

    // ===== PAGE EVENT HANDLERS =====
    document.addEventListener('pageshow', function (e) {
        var page = e.target;
        if (page.classList.contains('UserSmartListsConfigurationPage')) {
            SmartLists.initUserPage(page);
        }
    });

    document.addEventListener('pagehide', function (e) {
        var page = e.target;
        if (page.classList.contains('UserSmartListsConfigurationPage')) {
            // Clean up
            if (page._pageAbortController) {
                page._pageAbortController.abort();
                page._pageAbortController = null;
            }
            if (page._searchTimeout) {
                clearTimeout(page._searchTimeout);
            }
            page._pageInitialized = false;
        }
    });

    // ===== IMMEDIATE FORM HANDLER SETUP =====
    // Attach form handler immediately when script loads - doesn't need ApiClient
    // This ensures form submission is intercepted even before full page initialization
    (function () {
        var setupFormHandler = function () {
            var page = document.querySelector('.UserSmartListsConfigurationPage');
            var form = page ? page.querySelector('#playlistForm') : document.querySelector('#playlistForm');

            if (form && !form._submitHandlerAttached) {
                form._submitHandlerAttached = true;

                var handleSubmit = function (e) {
                    if (e) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                    // Defer to the full handler if page is initialized
                    if (page && page._pageInitialized) {
                        createOrUpdateUserPlaylist(page);
                    } else {
                        // Try to initialize with either window.ApiClient or standalone client
                        var apiClient = SmartLists.getApiClient ? SmartLists.getApiClient() : null;
                        if (apiClient && page) {
                            SmartLists.initUserPage(page);
                            // Wait a tick for init to complete
                            setTimeout(function() {
                                createOrUpdateUserPlaylist(page);
                            }, 100);
                        } else {
                            alert('Unable to connect to Jellyfin. Please ensure you are logged in and refresh the page.');
                        }
                    }
                    return false;
                };

                form.onsubmit = handleSubmit;
                form.addEventListener('submit', handleSubmit, true);

                // Also attach to button for extra safety
                var submitBtn = form.querySelector('#submitBtn') || document.querySelector('#submitBtn');
                if (submitBtn && !submitBtn._clickHandlerAttached) {
                    submitBtn._clickHandlerAttached = true;
                    submitBtn.addEventListener('click', function (e) {
                        if (!submitBtn.disabled) {
                            e.preventDefault();
                            e.stopPropagation();
                            handleSubmit(e);
                        }
                    }, true);
                }
            }
        };

        // Try immediately, and again after short delays in case DOM isn't ready
        setupFormHandler();
        setTimeout(setupFormHandler, 100);
        setTimeout(setupFormHandler, 500);
    })();

    // ===== FULL PAGE INITIALIZATION =====
    // Initialize full page functionality when ApiClient becomes available
    // Note: If window.ApiClient is not available (page accessed directly, not through SPA navigation),
    // we use a fallback API client that reads credentials from localStorage. This is the proper
    // approach for standalone pages, as it mirrors what Jellyfin's ServerConnections does internally.
    (function () {
        var maxRetries = 20; // 1 second max wait for shared scripts
        var retryCount = 0;

        var tryInit = function () {
            var page = document.querySelector('.UserSmartListsConfigurationPage');
            if (page && !page._pageInitialized) {
                // Check if required shared functions are available
                if (typeof SmartLists.getApiClient !== 'function') {
                    // Shared scripts not loaded yet, wait briefly
                    if (retryCount < maxRetries) {
                        retryCount++;
                        setTimeout(tryInit, 50);
                    } else {
                        console.error('[SmartLists] Shared scripts not loaded after timeout');
                    }
                    return;
                }

                // Try to get a working API client immediately
                // Priority: window.ApiClient (SPA) > standalone (direct access)
                if (window.ApiClient) {
                    if (DEBUG_MODE) {
                        console.log('[SmartLists] Using Jellyfin SPA ApiClient');
                    }
                    SmartLists.initUserPage(page);
                } else {
                    // No window.ApiClient - try standalone immediately
                    var standaloneClient = getFallbackApiClient();
                    if (standaloneClient) {
                        if (DEBUG_MODE) {
                            console.log('[SmartLists] Using standalone API client (direct access)');
                        }
                        SmartLists.initUserPage(page);
                    } else {
                        // No credentials found - user probably not logged in
                        console.error('[SmartLists] Could not create API client - user may not be logged in');
                        var container = page.querySelector('#playlist-list-container');
                        if (container) {
                            container.innerHTML = '<p style="color: #f44336;">Unable to connect to Jellyfin. Please ensure you are logged in and refresh the page.</p>';
                        }
                        var submitBtn = page.querySelector('#submitBtn');
                        if (submitBtn) {
                            submitBtn.disabled = true;
                            submitBtn.textContent = 'Not Connected';
                        }
                    }
                }
            }
        };
        // Start initialization attempt
        setTimeout(tryInit, 10);
    })();

})(window.SmartLists = window.SmartLists || {});
