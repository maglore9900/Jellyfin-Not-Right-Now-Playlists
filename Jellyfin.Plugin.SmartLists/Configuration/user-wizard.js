/**
 * User Smart Playlists Wizard
 * Step-by-step wizard for creating smart playlists
 */
(function (SmartLists) {
    'use strict';

    var DEBUG_MODE = false;

    // User-specific API endpoints
    var USER_ENDPOINTS = {
        base: 'Plugins/SmartLists/User',
        playlists: 'Plugins/SmartLists/User/playlists',
        fields: 'Plugins/SmartLists/User/fields',
        browse: 'Plugins/SmartLists/User/browse',
        search: 'Plugins/SmartLists/User/search'
    };

    // Media types for user playlists
    var USER_MEDIA_TYPES = [
        { Value: "Audio", Label: "Audio (Music)" },
        { Value: "Movie", Label: "Movie" },
        { Value: "Episode", Label: "Episode (TV Show)" },
        { Value: "MusicVideo", Label: "Music Video" },
        { Value: "Video", Label: "Video (Home Video)" },
        { Value: "AudioBook", Label: "Audiobook" }
    ];

    // Wizard state
    var wizardState = {
        currentStep: 1,
        totalSteps: 3,
        playlistName: '',
        isConvert: false,
        sourcePlaylistId: null,
        isPublic: false,
        selectedMediaTypes: [],
        previewItems: [], // Items to include in playlist
        expressionSets: null, // Rules if any
        editPlaylistId: null, // For editing existing playlist
        isEditMode: false // True when adding media to existing playlist
    };

    // ===== STANDALONE API CLIENT =====
    function getFallbackApiClient() {
        var credentials = null;
        try {
            var credStr = localStorage.getItem('jellyfin_credentials');
            if (credStr) {
                credentials = JSON.parse(credStr);
            }
        } catch (e) {
            console.error('[SmartLists Wizard] Error reading credentials:', e);
            return null;
        }

        var servers = credentials && credentials.Servers ? credentials.Servers : [];
        var currentServer = servers.length > 0 ? servers[0] : null;

        if (!currentServer || !currentServer.AccessToken) {
            return null;
        }

        var serverAddress = currentServer.ManualAddress || currentServer.LocalAddress || window.location.origin;

        return {
            _serverAddress: serverAddress,
            _accessToken: currentServer.AccessToken,
            _userId: currentServer.UserId,

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

                return fetch(options.url, fetchOptions);
            }
        };
    }

    // Override getApiClient for wizard
    var originalGetApiClient = SmartLists.getApiClient;
    SmartLists.getApiClient = function () {
        if (window.ApiClient) {
            return window.ApiClient;
        }
        return getFallbackApiClient();
    };

    // ===== RESPONSE HANDLING =====
    function parseApiResponse(response) {
        if (response && typeof response.ok !== 'undefined') {
            if (!response.ok) {
                throw new Error('API request failed: ' + response.status);
            }
            return response.json();
        }
        return Promise.resolve(response);
    }

    // ===== INITIALIZATION =====
    SmartLists.initWizardPage = function (page) {
        if (DEBUG_MODE) {
            console.log('[SmartLists Wizard] Initializing...');
        }

        if (page._wizardInitialized) {
            return;
        }
        page._wizardInitialized = true;

        // Parse URL parameters
        parseWizardParams();

        // Update title based on mode
        var titleEl = page.querySelector('#wizard-title');
        if (titleEl) {
            if (wizardState.isEditMode) {
                titleEl.textContent = 'Add Media: ' + wizardState.playlistName;
            } else if (wizardState.isConvert) {
                titleEl.textContent = 'Convert Playlist: ' + wizardState.playlistName;
            } else {
                titleEl.textContent = 'Create NrN Playlist: ' + wizardState.playlistName;
            }
        }

        // Load fields for rules
        loadUserFields().then(function () {
            // Initialize media types
            generateMediaTypeCheckboxes(page);

            // Initialize rules container
            var rulesContainer = page.querySelector('#wizard-rules-container');
            if (rulesContainer && rulesContainer.children.length === 0) {
                SmartLists.createInitialLogicGroup(page, '#wizard-rules-container');
            }

            // Initialize sort system
            if (SmartLists.initializeSortSystem) {
                SmartLists.initializeSortSystem(page, '#wizard-sorts-container');
            }
            var sortsContainer = page.querySelector('#wizard-sorts-container');
            if (sortsContainer && sortsContainer.querySelectorAll('.sort-box').length === 0) {
                SmartLists.addSortBox(page, { SortBy: 'Name', SortOrder: 'Ascending' }, '#wizard-sorts-container');
            }

            // If in edit mode, load existing playlist data
            if (wizardState.isEditMode && wizardState.editPlaylistId) {
                console.log('[SmartLists Wizard] Edit mode - loading existing playlist data...');
                loadExistingPlaylistData(page);
            }
            // If converting, load source playlist items
            else if (wizardState.isConvert && wizardState.sourcePlaylistId) {
                console.log('[SmartLists Wizard] Loading source playlist items...');
                loadSourcePlaylistItems(page);
            } else {
                console.log('[SmartLists Wizard] Not in convert mode or no sourcePlaylistId');
            }
        });

        // Setup event listeners
        setupWizardEventListeners(page);

        // Update step display
        updateStepDisplay(page);
    };

    function parseWizardParams() {
        var params = new URLSearchParams();
        var hash = window.location.hash;

        console.log('[SmartLists Wizard] Raw hash:', hash);
        console.log('[SmartLists Wizard] Full URL:', window.location.href);

        // Parse hash params (Jellyfin uses hash-based routing)
        // Hash params take priority over search params
        if (hash && hash.includes('?')) {
            var hashParams = new URLSearchParams(hash.split('?')[1]);
            console.log('[SmartLists Wizard] Hash params string:', hash.split('?')[1]);
            hashParams.forEach(function (value, key) {
                console.log('[SmartLists Wizard] Param:', key, '=', value);
                params.set(key, value);
            });
        }

        wizardState.playlistName = params.get('name') || 'New Playlist';
        wizardState.isConvert = params.get('convert') === 'true';
        wizardState.sourcePlaylistId = params.get('sourceId') || null;
        wizardState.isPublic = params.get('public') === 'true';

        // Edit mode parameters
        wizardState.editPlaylistId = params.get('editId') || null;
        wizardState.isEditMode = !!wizardState.editPlaylistId;
        var startStep = parseInt(params.get('startStep'), 10);
        if (startStep && startStep >= 1 && startStep <= wizardState.totalSteps) {
            wizardState.currentStep = startStep;
        }

        console.log('[SmartLists Wizard] Parsed state - isConvert:', wizardState.isConvert, 'sourcePlaylistId:', wizardState.sourcePlaylistId, 'isEditMode:', wizardState.isEditMode, 'editPlaylistId:', wizardState.editPlaylistId);
    }

    function loadUserFields() {
        var apiClient = SmartLists.getApiClient();
        if (!apiClient) {
            return Promise.reject(new Error('No API client'));
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
            console.error('[SmartLists Wizard] Error loading fields:', err);
            return {};
        });
    }

    // ===== MEDIA TYPE CHECKBOXES =====
    function generateMediaTypeCheckboxes(page) {
        var container = page.querySelector('#wizard-media-types');
        if (!container) return;

        var html = '';
        USER_MEDIA_TYPES.forEach(function (mediaType) {
            html += '<label class="emby-checkbox-label" style="display: flex; align-items: center; padding: 0.5em;">';
            html += '<input type="checkbox" is="emby-checkbox" class="wizard-media-type-checkbox emby-checkbox" ';
            html += 'data-embycheckbox="true" value="' + SmartLists.escapeHtmlAttribute(mediaType.Value) + '">';
            html += '<span class="checkboxLabel" style="margin-left: 0.5em;">' + SmartLists.escapeHtml(mediaType.Label) + '</span>';
            html += '<span class="checkboxOutline">';
            html += '<span class="material-icons checkboxIcon checkboxIcon-checked check" aria-hidden="true"></span>';
            html += '<span class="material-icons checkboxIcon checkboxIcon-unchecked" aria-hidden="true"></span>';
            html += '</span>';
            html += '</label>';
        });
        container.innerHTML = html;
    }

    function getSelectedMediaTypes(page) {
        var checkboxes = page.querySelectorAll('.wizard-media-type-checkbox:checked');
        var selected = [];
        checkboxes.forEach(function (cb) {
            selected.push(cb.value);
        });
        return selected;
    }

    // Override SmartLists.getSelectedMediaTypes for wizard page to use wizard checkboxes
    var originalGetSelectedMediaTypes = SmartLists.getSelectedMediaTypes;
    SmartLists.getSelectedMediaTypes = function (page) {
        // Check if we're on the wizard page
        if (page && page.classList && page.classList.contains('UserSmartListsWizardPage')) {
            return getSelectedMediaTypes(page);
        }
        // Fall back to original implementation
        if (originalGetSelectedMediaTypes) {
            return originalGetSelectedMediaTypes(page);
        }
        return [];
    };

    // ===== STEP NAVIGATION =====
    function updateStepDisplay(page) {
        var stepIndicators = page.querySelectorAll('.wizard-step');
        var panels = page.querySelectorAll('.wizard-panel');

        // Update step indicators
        stepIndicators.forEach(function (indicator) {
            var step = parseInt(indicator.getAttribute('data-step'), 10);
            indicator.classList.remove('active', 'completed');

            if (step < wizardState.currentStep) {
                indicator.classList.add('completed');
            } else if (step === wizardState.currentStep) {
                indicator.classList.add('active');
            }
        });

        // Update panels
        panels.forEach(function (panel, index) {
            var panelStep = index + 1;
            panel.classList.toggle('active', panelStep === wizardState.currentStep);
        });

        // Update buttons
        var prevBtn = page.querySelector('#prevStepBtn');
        var nextBtn = page.querySelector('#nextStepBtn');
        var createBtn = page.querySelector('#createPlaylistBtn');

        if (prevBtn) {
            prevBtn.style.display = wizardState.currentStep > 1 ? '' : 'none';
        }

        if (nextBtn) {
            nextBtn.style.display = wizardState.currentStep < wizardState.totalSteps ? '' : 'none';
        }

        if (createBtn) {
            createBtn.style.display = wizardState.currentStep === wizardState.totalSteps ? '' : 'none';
            // Update button text based on mode
            if (wizardState.isEditMode) {
                createBtn.textContent = 'Add Items';
            } else {
                createBtn.textContent = 'Create Playlist';
            }
        }

        // In edit mode, hide the "Previous" button on step 2 since step 1 was skipped
        if (prevBtn && wizardState.isEditMode && wizardState.currentStep === 2) {
            prevBtn.style.display = 'none';
        }

        // If on step 3, update summary and initialize public checkbox
        if (wizardState.currentStep === 3) {
            var publicCheckbox = page.querySelector('#wizardIsPublic');
            if (publicCheckbox) {
                publicCheckbox.checked = wizardState.isPublic;
            }
            updateConfirmationSummary(page);
        }
    }

    function goToNextStep(page) {
        if (wizardState.currentStep >= wizardState.totalSteps) {
            return;
        }

        // Validate current step
        if (!validateStep(page, wizardState.currentStep)) {
            return;
        }

        wizardState.currentStep++;
        updateStepDisplay(page);
    }

    function goToPrevStep(page) {
        if (wizardState.currentStep <= 1) {
            return;
        }

        wizardState.currentStep--;
        updateStepDisplay(page);
    }

    function validateStep(page, step) {
        if (step === 1) {
            // Validate media types
            var selectedTypes = getSelectedMediaTypes(page);
            if (selectedTypes.length === 0) {
                SmartLists.showNotification('Please select at least one media type.', 'error');
                return false;
            }
            wizardState.selectedMediaTypes = selectedTypes;
        }

        return true;
    }

    // ===== CONFIRMATION SUMMARY =====
    function updateConfirmationSummary(page) {
        var nameEl = page.querySelector('#summary-name');
        var typeEl = page.querySelector('#summary-type');
        var mediaTypesEl = page.querySelector('#summary-media-types');
        var itemsEl = page.querySelector('#summary-items');
        var durationEl = page.querySelector('#summary-duration');
        var visibilityEl = page.querySelector('#summary-visibility');

        if (nameEl) nameEl.textContent = wizardState.playlistName;
        if (typeEl) {
            if (wizardState.isEditMode) {
                typeEl.textContent = 'Adding to existing playlist';
            } else if (wizardState.isConvert) {
                typeEl.textContent = 'Converted from existing playlist';
            } else {
                typeEl.textContent = 'New smart playlist';
            }
        }
        if (mediaTypesEl) mediaTypesEl.textContent = wizardState.selectedMediaTypes.join(', ');

        // Show items count with note about rules if applicable
        var hasRules = wizardState.expressionSets && wizardState.expressionSets.length > 0 &&
            wizardState.expressionSets.some(function(es) { return es.Expressions && es.Expressions.length > 0; });

        if (itemsEl) {
            if (wizardState.previewItems.length > 0) {
                itemsEl.textContent = wizardState.previewItems.length + ' items';
                if (hasRules) {
                    itemsEl.textContent += ' (rules will re-evaluate on refresh)';
                }
            } else if (hasRules) {
                itemsEl.textContent = 'Rules defined - items will be added on first refresh';
                itemsEl.style.fontStyle = 'italic';
            } else {
                itemsEl.textContent = '0 items';
            }
        }

        // Calculate total duration
        var totalTicks = 0;
        wizardState.previewItems.forEach(function (item) {
            if (item.RuntimeTicks) {
                totalTicks += item.RuntimeTicks;
            }
        });
        if (durationEl) {
            durationEl.textContent = formatDurationMinutes(totalTicks);
        }

        if (visibilityEl) {
            var isPublicCheckbox = page.querySelector('#wizardIsPublic');
            var isPublic = isPublicCheckbox ? isPublicCheckbox.checked : wizardState.isPublic;
            visibilityEl.textContent = isPublic ? 'Public' : 'Private';
        }

        // Render final preview
        renderFinalPreview(page);
    }

    function renderFinalPreview(page) {
        var tbody = page.querySelector('#final-preview-tbody');
        if (!tbody) return;

        var hasRules = wizardState.expressionSets && wizardState.expressionSets.length > 0 &&
            wizardState.expressionSets.some(function(es) { return es.Expressions && es.Expressions.length > 0; });

        if (wizardState.previewItems.length === 0) {
            if (hasRules) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #888; padding: 2em;">' +
                    '<div style="font-size: 1.2em; margin-bottom: 0.5em;">📋 Rules Defined</div>' +
                    '<div>Items matching your rules will be added when the playlist is created and refreshed.</div>' +
                    '</td></tr>';
            } else {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #666; padding: 2em;">No items in playlist</td></tr>';
            }
            return;
        }

        var html = '';
        wizardState.previewItems.forEach(function (item) {
            html += '<tr>';
            html += '<td>' + SmartLists.escapeHtml(item.Name || '--') + '</td>';
            html += '<td style="color: #aaa;">' + SmartLists.escapeHtml(item.Artist || '--') + '</td>';
            html += '<td style="color: #aaa;">' + SmartLists.escapeHtml(item.Album || '--') + '</td>';
            html += '<td style="color: #888;">' + (item.RuntimeTicks ? formatDuration(item.RuntimeTicks) : '--:--') + '</td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    }

    // ===== ADD METHOD TABS =====
    function switchAddMethod(page, method) {
        var tabs = page.querySelectorAll('.add-method-tab');
        var contents = page.querySelectorAll('.add-method-content');

        tabs.forEach(function (tab) {
            tab.classList.toggle('active', tab.getAttribute('data-method') === method);
        });

        contents.forEach(function (content) {
            content.classList.toggle('active', content.id === 'method-' + method);
        });
    }

    // ===== PREVIEW TABLE =====
    function addItemsToPreview(items, source) {
        items.forEach(function (item) {
            // Check if already in preview
            var exists = wizardState.previewItems.some(function (p) {
                return p.Id === item.Id;
            });

            if (!exists) {
                item.source = source;
                wizardState.previewItems.push(item);
            }
        });

        var page = document.querySelector('.UserSmartListsWizardPage');
        if (page) {
            renderPreviewTable(page);
        }
    }

    function renderPreviewTable(page) {
        var tbody = page.querySelector('#preview-tbody');
        var countEl = page.querySelector('#preview-count');

        if (countEl) {
            countEl.textContent = '(' + wizardState.previewItems.length + ' items)';
        }

        if (!tbody) return;

        if (wizardState.previewItems.length === 0) {
            tbody.innerHTML = '<tr class="empty-preview-row"><td colspan="6" style="text-align: center; color: #666; padding: 2em;">No items added yet. Use rules, browse, or search to add items.</td></tr>';
            return;
        }

        var html = '';
        wizardState.previewItems.forEach(function (item, index) {
            var badgeClass = 'badge-' + (item.source || 'browse');
            html += '<tr data-preview-index="' + index + '">';
            html += '<td><input type="checkbox" class="preview-item-checkbox" data-index="' + index + '"></td>';
            html += '<td>' + SmartLists.escapeHtml(item.Name || '--') + '</td>';
            html += '<td style="color: #aaa;">' + SmartLists.escapeHtml(item.Artist || '--') + '</td>';
            html += '<td style="color: #aaa;">' + SmartLists.escapeHtml(item.Album || '--') + '</td>';
            html += '<td style="color: #888;">' + (item.RuntimeTicks ? formatDuration(item.RuntimeTicks) : '--:--') + '</td>';
            html += '<td><span class="item-source-badge ' + badgeClass + '">' + SmartLists.escapeHtml(item.source || 'browse') + '</span></td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    }

    function removeSelectedFromPreview(page) {
        var checkboxes = page.querySelectorAll('.preview-item-checkbox:checked');
        var indicesToRemove = [];

        checkboxes.forEach(function (cb) {
            indicesToRemove.push(parseInt(cb.getAttribute('data-index'), 10));
        });

        // Remove in reverse order to maintain indices
        indicesToRemove.sort(function (a, b) { return b - a; });
        indicesToRemove.forEach(function (index) {
            wizardState.previewItems.splice(index, 1);
        });

        renderPreviewTable(page);
    }

    function clearPreview(page) {
        wizardState.previewItems = [];
        renderPreviewTable(page);
    }

    // ===== LOAD SOURCE PLAYLIST (for Convert) =====
    function loadSourcePlaylistItems(page) {
        console.log('[SmartLists Wizard] loadSourcePlaylistItems called');
        var apiClient = SmartLists.getApiClient();
        if (!apiClient) {
            console.error('[SmartLists Wizard] No API client available');
            return;
        }

        SmartLists.showNotification('Loading playlist items...', 'info');

        // Use Jellyfin's playlist items endpoint
        var url = apiClient.getUrl('Playlists/' + wizardState.sourcePlaylistId + '/Items');
        url += '?UserId=' + apiClient.getCurrentUserId();
        url += '&Fields=MediaSources,Overview';

        console.log('[SmartLists Wizard] Fetching from URL:', url);

        apiClient.ajax({
            type: 'GET',
            url: url,
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            console.log('[SmartLists Wizard] API response:', result);

            // Detect media types from items
            var detectedMediaTypes = new Set();
            (result.Items || []).forEach(function (item) {
                if (item.Type) {
                    detectedMediaTypes.add(item.Type);
                }
            });

            // Pre-select detected media types
            if (detectedMediaTypes.size > 0) {
                console.log('[SmartLists Wizard] Detected media types:', Array.from(detectedMediaTypes));
                var checkboxes = page.querySelectorAll('.wizard-media-type-checkbox');
                checkboxes.forEach(function (cb) {
                    if (detectedMediaTypes.has(cb.value)) {
                        cb.checked = true;
                    }
                });
                wizardState.selectedMediaTypes = Array.from(detectedMediaTypes);
            }

            var items = (result.Items || []).map(function (item) {
                return {
                    Id: item.Id,
                    Name: item.Name,
                    Artist: item.AlbumArtist || (item.ArtistItems && item.ArtistItems.length > 0 ? item.ArtistItems[0].Name : null),
                    Album: item.Album,
                    RuntimeTicks: item.RunTimeTicks,
                    source: 'clone'
                };
            });

            console.log('[SmartLists Wizard] Mapped items:', items.length);
            wizardState.previewItems = items;
            renderPreviewTable(page);
            SmartLists.showNotification('Loaded ' + items.length + ' items from source playlist.', 'success');
        }).catch(function (err) {
            console.error('[SmartLists Wizard] Error loading source playlist:', err);
            SmartLists.showNotification('Failed to load source playlist: ' + err.message, 'error');
        });
    }

    // ===== LOAD EXISTING PLAYLIST (for Edit/Add Media mode) =====
    function loadExistingPlaylistData(page) {
        console.log('[SmartLists Wizard] loadExistingPlaylistData called');
        var apiClient = SmartLists.getApiClient();
        if (!apiClient) {
            console.error('[SmartLists Wizard] No API client available');
            return;
        }

        // Fetch the existing playlist data
        var url = apiClient.getUrl(USER_ENDPOINTS.base + '/' + wizardState.editPlaylistId);

        apiClient.ajax({
            type: 'GET',
            url: url,
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (playlist) {
            console.log('[SmartLists Wizard] Loaded existing playlist:', playlist);

            // Pre-select the playlist's media types
            if (playlist.MediaTypes && playlist.MediaTypes.length > 0) {
                var checkboxes = page.querySelectorAll('.wizard-media-type-checkbox');
                checkboxes.forEach(function (cb) {
                    if (playlist.MediaTypes.indexOf(cb.value) !== -1) {
                        cb.checked = true;
                    }
                });
                wizardState.selectedMediaTypes = playlist.MediaTypes.slice();
            }

            // Store playlist public setting
            wizardState.isPublic = playlist.Public || false;

            // Now load existing items from the playlist
            return apiClient.ajax({
                type: 'GET',
                url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + wizardState.editPlaylistId + '/items'),
                contentType: 'application/json'
            }).then(parseApiResponse);
        }).then(function (result) {
            console.log('[SmartLists Wizard] Loaded existing playlist items:', result);

            // Map items to preview format
            var items = (result.Items || []).map(function (item) {
                return {
                    Id: item.Id,
                    Name: item.Name,
                    Artist: item.Artist || null,
                    Album: item.Album || null,
                    RuntimeTicks: item.RuntimeTicks,
                    source: 'existing'
                };
            });

            console.log('[SmartLists Wizard] Mapped existing items:', items.length);
            wizardState.previewItems = items;
            renderPreviewTable(page);

            SmartLists.showNotification('Loaded ' + items.length + ' existing items. Add more media below.', 'info');
        }).catch(function (err) {
            console.error('[SmartLists Wizard] Error loading existing playlist:', err);
            SmartLists.showNotification('Failed to load playlist: ' + err.message, 'error');
        });
    }

    // ===== RULES =====
    function applyRulesToPreview(page) {
        // Collect rules from form
        var expressionSets = SmartLists.collectRulesFromForm ? SmartLists.collectRulesFromForm(page, '#wizard-rules-container') : null;

        if (!expressionSets || expressionSets.length === 0 || !expressionSets.some(function (es) { return es.Expressions && es.Expressions.length > 0; })) {
            SmartLists.showNotification('Please add at least one rule.', 'warning');
            return;
        }

        // Save rules to wizard state
        wizardState.expressionSets = expressionSets;

        // Call API to preview matching items
        var apiClient = SmartLists.getApiClient();
        if (!apiClient) {
            SmartLists.showNotification('Rules saved. Preview unavailable - will be applied on creation.', 'info');
            return;
        }

        var applyBtn = page.querySelector('#applyRulesBtn');
        if (applyBtn) {
            applyBtn.disabled = true;
            applyBtn.textContent = 'Loading...';
        }

        SmartLists.showNotification('Previewing rule matches...', 'info');

        var requestData = {
            MediaTypes: wizardState.selectedMediaTypes,
            ExpressionSets: expressionSets,
            Limit: 500 // Preview up to 500 items
        };

        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/preview-rules'),
            contentType: 'application/json',
            data: JSON.stringify(requestData)
        }).then(parseApiResponse).then(function (result) {
            if (applyBtn) {
                applyBtn.disabled = false;
                applyBtn.textContent = 'Preview Rules';
            }

            if (result.Items && result.Items.length > 0) {
                // Add matched items to preview
                var matchedItems = result.Items.map(function (item) {
                    return {
                        Id: item.Id,
                        Name: item.Name,
                        Artist: item.Artist || null,
                        Album: item.Album || null,
                        RuntimeTicks: item.RuntimeTicks,
                        source: 'rule'
                    };
                });

                addItemsToPreview(matchedItems, 'rule');

                var message = 'Found ' + result.TotalMatching + ' matching items.';
                if (result.LimitApplied) {
                    message += ' Showing first ' + result.Items.length + ' in preview.';
                }
                SmartLists.showNotification(message, 'success');
            } else {
                SmartLists.showNotification('No items match your rules. Try adjusting the criteria.', 'warning');
            }
        }).catch(function (err) {
            console.error('[SmartLists Wizard] Error previewing rules:', err);
            if (applyBtn) {
                applyBtn.disabled = false;
                applyBtn.textContent = 'Preview Rules';
            }
            SmartLists.showNotification('Rules saved but preview failed. They will be applied on creation.', 'info');
        });
    }

    // ===== BROWSE =====
    // Browse pagination state
    var browseState = {
        currentPage: 0,
        pageSize: 200,
        totalItems: 0,
        allItems: [], // Store all fetched items for "Load All" mode
        isLoadAll: false
    };

    function loadBrowseFilters(page) {
        var apiClient = SmartLists.getApiClient();
        if (!apiClient) return;

        // Load genres
        apiClient.ajax({
            type: 'GET',
            url: apiClient.getUrl('Genres') + '?UserId=' + apiClient.getCurrentUserId(),
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            var genreSelect = page.querySelector('#browseGenre');
            if (genreSelect && result.Items) {
                result.Items.forEach(function (genre) {
                    var opt = document.createElement('option');
                    opt.value = genre.Name;
                    opt.textContent = genre.Name;
                    genreSelect.appendChild(opt);
                });
            }
        });

        // Load artists
        apiClient.ajax({
            type: 'GET',
            url: apiClient.getUrl('Artists') + '?UserId=' + apiClient.getCurrentUserId() + '&Limit=500',
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            var artistSelect = page.querySelector('#browseArtist');
            if (artistSelect && result.Items) {
                result.Items.forEach(function (artist) {
                    var opt = document.createElement('option');
                    opt.value = artist.Id;
                    opt.textContent = artist.Name;
                    artistSelect.appendChild(opt);
                });
            }
        });
    }

    function fetchBrowseItems(page, loadAll) {
        var apiClient = SmartLists.getApiClient();
        if (!apiClient) return;

        var genre = page.querySelector('#browseGenre').value;
        var artistId = page.querySelector('#browseArtist').value;
        var album = page.querySelector('#browseAlbum').value;
        var year = page.querySelector('#browseYear').value;

        var resultsContainer = page.querySelector('#browse-results');
        resultsContainer.innerHTML = '<div class="loading-indicator">Loading items...</div>';

        // Reset pagination state
        browseState.currentPage = 0;
        browseState.isLoadAll = loadAll === true;
        browseState.allItems = [];

        // Build query params
        var params = new URLSearchParams();
        params.set('UserId', apiClient.getCurrentUserId());
        params.set('IncludeItemTypes', wizardState.selectedMediaTypes.join(','));
        params.set('Recursive', 'true');
        params.set('Fields', 'MediaSources');

        if (loadAll) {
            // No limit for Load All - but we'll paginate the display
            params.set('Limit', '10000'); // High limit to get all
        } else {
            params.set('Limit', browseState.pageSize.toString());
            params.set('StartIndex', '0');
        }

        if (genre) params.set('Genres', genre);
        if (artistId) params.set('ArtistIds', artistId);
        if (year) params.set('Years', year);

        var url = apiClient.getUrl('Items') + '?' + params.toString();

        if (loadAll) {
            SmartLists.showNotification('Loading all items... This may take a moment.', 'info');
        }

        apiClient.ajax({
            type: 'GET',
            url: url,
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            browseState.allItems = result.Items || [];
            browseState.totalItems = result.TotalRecordCount || browseState.allItems.length;

            if (loadAll) {
                SmartLists.showNotification('Loaded ' + browseState.allItems.length + ' items.', 'success');
            }

            renderBrowseResultsPage(page, resultsContainer);
            updateBrowsePagination(page);
        }).catch(function (err) {
            console.error('[SmartLists Wizard] Browse error:', err);
            resultsContainer.innerHTML = '<div class="empty-state" style="color: #f44336;">Error loading items</div>';
        });
    }

    function renderBrowseResultsPage(page, container) {
        // Calculate which items to show based on current page
        var startIndex = browseState.currentPage * browseState.pageSize;
        var endIndex = Math.min(startIndex + browseState.pageSize, browseState.allItems.length);
        var pageItems = browseState.allItems.slice(startIndex, endIndex);

        renderBrowseResults(container, pageItems);
    }

    function updateBrowsePagination(page) {
        var paginationDiv = page.querySelector('#browse-pagination');
        var pageInfo = page.querySelector('#browse-page-info');
        var prevBtn = page.querySelector('#browsePrevBtn');
        var nextBtn = page.querySelector('#browseNextBtn');

        if (!paginationDiv) return;

        var totalPages = Math.ceil(browseState.allItems.length / browseState.pageSize);
        var currentPage = browseState.currentPage + 1;
        var startItem = browseState.currentPage * browseState.pageSize + 1;
        var endItem = Math.min((browseState.currentPage + 1) * browseState.pageSize, browseState.allItems.length);

        if (browseState.allItems.length > browseState.pageSize) {
            paginationDiv.style.display = 'flex';
            pageInfo.textContent = 'Showing ' + startItem + '-' + endItem + ' of ' + browseState.allItems.length + ' items (Page ' + currentPage + ' of ' + totalPages + ')';

            prevBtn.disabled = browseState.currentPage === 0;
            nextBtn.disabled = browseState.currentPage >= totalPages - 1;
        } else if (browseState.allItems.length > 0) {
            paginationDiv.style.display = 'flex';
            pageInfo.textContent = 'Showing ' + browseState.allItems.length + ' items';
            prevBtn.disabled = true;
            nextBtn.disabled = true;
        } else {
            paginationDiv.style.display = 'none';
        }
    }

    function browsePrevPage(page) {
        if (browseState.currentPage > 0) {
            browseState.currentPage--;
            var container = page.querySelector('#browse-results');
            renderBrowseResultsPage(page, container);
            updateBrowsePagination(page);
        }
    }

    function browseNextPage(page) {
        var totalPages = Math.ceil(browseState.allItems.length / browseState.pageSize);
        if (browseState.currentPage < totalPages - 1) {
            browseState.currentPage++;
            var container = page.querySelector('#browse-results');
            renderBrowseResultsPage(page, container);
            updateBrowsePagination(page);
        }
    }

    function addAllBrowseItems(page) {
        if (browseState.allItems.length === 0) {
            SmartLists.showNotification('No items loaded. Click "Load Items" or "Load All" first.', 'warning');
            return;
        }

        // Filter out items already in preview
        var previewIds = wizardState.previewItems.map(function (p) { return normalizeGuid(p.Id); });
        var newItems = browseState.allItems.filter(function (item) {
            return previewIds.indexOf(normalizeGuid(item.Id)) === -1;
        });

        if (newItems.length === 0) {
            SmartLists.showNotification('All matching items are already in the playlist.', 'info');
            return;
        }

        var mappedItems = newItems.map(function (item) {
            return {
                Id: item.Id,
                Name: item.Name,
                Artist: item.AlbumArtist || (item.ArtistItems && item.ArtistItems.length > 0 ? item.ArtistItems[0].Name : null),
                Album: item.Album,
                RuntimeTicks: item.RunTimeTicks,
                source: 'browse'
            };
        });

        addItemsToPreview(mappedItems, 'browse');
        SmartLists.showNotification('Added ' + mappedItems.length + ' items to preview.', 'success');
    }

    // Helper to normalize GUID for comparison (remove dashes, lowercase)
    function normalizeGuid(id) {
        return (id || '').replace(/-/g, '').toLowerCase();
    }

    function renderBrowseResults(container, items) {
        // Filter out items already in preview (normalize GUIDs for comparison)
        var previewIds = wizardState.previewItems.map(function (p) { return normalizeGuid(p.Id); });
        var filteredItems = items.filter(function (item) {
            return previewIds.indexOf(normalizeGuid(item.Id)) === -1;
        });

        if (filteredItems.length === 0) {
            var msg = items.length > 0
                ? 'All matching items are already in the playlist'
                : 'No items found with current filters';
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128528;</div><div>' + msg + '</div></div>';
            return;
        }

        var html = '';
        filteredItems.forEach(function (item) {
            var artist = item.AlbumArtist || (item.ArtistItems && item.ArtistItems.length > 0 ? item.ArtistItems[0].Name : '--');
            html += '<div class="browse-item" data-item-id="' + SmartLists.escapeHtmlAttribute(item.Id) + '">';
            html += '<input type="checkbox" class="browse-item-checkbox">';
            html += '<div class="browse-item-info">';
            html += '<div class="browse-item-name">' + SmartLists.escapeHtml(item.Name) + '</div>';
            html += '<div class="browse-item-meta">' + SmartLists.escapeHtml(artist);
            if (item.Album) {
                html += ' - ' + SmartLists.escapeHtml(item.Album);
            }
            html += '</div>';
            html += '</div>';
            html += '</div>';
        });
        container.innerHTML = html;

        // Store filtered items data for later
        container._items = filteredItems;
    }

    function addSelectedBrowseItems(page) {
        var container = page.querySelector('#browse-results');
        var checkboxes = container.querySelectorAll('.browse-item-checkbox:checked');
        var items = container._items || [];

        var selectedItems = [];
        checkboxes.forEach(function (cb) {
            var itemEl = cb.closest('.browse-item');
            var itemId = itemEl.getAttribute('data-item-id');
            var item = items.find(function (i) { return i.Id === itemId; });
            if (item) {
                selectedItems.push({
                    Id: item.Id,
                    Name: item.Name,
                    Artist: item.AlbumArtist || (item.ArtistItems && item.ArtistItems.length > 0 ? item.ArtistItems[0].Name : null),
                    Album: item.Album,
                    RuntimeTicks: item.RunTimeTicks,
                    source: 'browse'
                });
            }
        });

        if (selectedItems.length === 0) {
            SmartLists.showNotification('Please select items first.', 'warning');
            return;
        }

        addItemsToPreview(selectedItems, 'browse');
        SmartLists.showNotification('Added ' + selectedItems.length + ' items to preview.', 'success');

        // Clear selections
        checkboxes.forEach(function (cb) { cb.checked = false; });
    }

    // ===== SEARCH =====
    function performSearch(page) {
        var searchInput = page.querySelector('#searchInput');
        var searchTerm = searchInput ? searchInput.value.trim() : '';

        if (!searchTerm) {
            SmartLists.showNotification('Please enter a search term.', 'warning');
            return;
        }

        var apiClient = SmartLists.getApiClient();
        if (!apiClient) return;

        var resultsContainer = page.querySelector('#search-results');
        resultsContainer.innerHTML = '<div class="loading-indicator">Searching...</div>';

        var params = new URLSearchParams();
        params.set('UserId', apiClient.getCurrentUserId());
        params.set('SearchTerm', searchTerm);
        params.set('IncludeItemTypes', wizardState.selectedMediaTypes.join(','));
        params.set('Recursive', 'true');
        params.set('Fields', 'MediaSources');
        params.set('Limit', '100');

        var url = apiClient.getUrl('Items') + '?' + params.toString();

        apiClient.ajax({
            type: 'GET',
            url: url,
            contentType: 'application/json'
        }).then(parseApiResponse).then(function (result) {
            renderSearchResults(resultsContainer, result.Items || []);
        }).catch(function (err) {
            console.error('[SmartLists Wizard] Search error:', err);
            resultsContainer.innerHTML = '<div class="empty-state" style="color: #f44336;">Error searching</div>';
        });
    }

    function renderSearchResults(container, items) {
        // Filter out items already in preview (normalize GUIDs for comparison)
        var previewIds = wizardState.previewItems.map(function (p) { return normalizeGuid(p.Id); });
        var filteredItems = items.filter(function (item) {
            return previewIds.indexOf(normalizeGuid(item.Id)) === -1;
        });

        if (filteredItems.length === 0) {
            var msg = items.length > 0
                ? 'All matching items are already in the playlist'
                : 'No results found';
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128528;</div><div>' + msg + '</div></div>';
            return;
        }

        var html = '';
        filteredItems.forEach(function (item) {
            var artist = item.AlbumArtist || (item.ArtistItems && item.ArtistItems.length > 0 ? item.ArtistItems[0].Name : '--');
            html += '<div class="browse-item" data-item-id="' + SmartLists.escapeHtmlAttribute(item.Id) + '">';
            html += '<input type="checkbox" class="search-item-checkbox">';
            html += '<div class="browse-item-info">';
            html += '<div class="browse-item-name">' + SmartLists.escapeHtml(item.Name) + '</div>';
            html += '<div class="browse-item-meta">' + SmartLists.escapeHtml(artist);
            if (item.Album) {
                html += ' - ' + SmartLists.escapeHtml(item.Album);
            }
            html += '</div>';
            html += '</div>';
            html += '</div>';
        });
        container.innerHTML = html;

        // Store filtered items data for later
        container._items = filteredItems;
    }

    function addSelectedSearchItems(page) {
        var container = page.querySelector('#search-results');
        var checkboxes = container.querySelectorAll('.search-item-checkbox:checked');
        var items = container._items || [];

        var selectedItems = [];
        checkboxes.forEach(function (cb) {
            var itemEl = cb.closest('.browse-item');
            var itemId = itemEl.getAttribute('data-item-id');
            var item = items.find(function (i) { return i.Id === itemId; });
            if (item) {
                selectedItems.push({
                    Id: item.Id,
                    Name: item.Name,
                    Artist: item.AlbumArtist || (item.ArtistItems && item.ArtistItems.length > 0 ? item.ArtistItems[0].Name : null),
                    Album: item.Album,
                    RuntimeTicks: item.RunTimeTicks,
                    source: 'search'
                });
            }
        });

        if (selectedItems.length === 0) {
            SmartLists.showNotification('Please select items first.', 'warning');
            return;
        }

        addItemsToPreview(selectedItems, 'search');
        SmartLists.showNotification('Added ' + selectedItems.length + ' items to preview.', 'success');

        checkboxes.forEach(function (cb) { cb.checked = false; });
    }

    // ===== CREATE PLAYLIST =====
    function createPlaylist(page) {
        // Allow creation if:
        // 1. There are preview items (manually selected or from rules preview)
        // 2. OR there are rules defined (they will populate on refresh)
        var hasPreviewItems = wizardState.previewItems.length > 0;
        var hasRules = wizardState.expressionSets && wizardState.expressionSets.length > 0 &&
            wizardState.expressionSets.some(function(es) { return es.Expressions && es.Expressions.length > 0; });

        if (!hasPreviewItems && !hasRules) {
            SmartLists.showNotification('Please add items using Browse/Search, or define rules to match items.', 'error');
            return;
        }

        var apiClient = SmartLists.getApiClient();
        if (!apiClient) return;

        // In edit mode, add items to existing playlist
        if (wizardState.isEditMode && wizardState.editPlaylistId) {
            addItemsToExistingPlaylist(page, apiClient);
            return;
        }

        // Gather sort options
        var orderDto = null;
        if (SmartLists.collectSortsFromForm) {
            var sorts = SmartLists.collectSortsFromForm(page, '#wizard-sorts-container');
            if (sorts && sorts.length > 0) {
                orderDto = {
                    Primary: sorts[0] || null,
                    Secondary: sorts[1] || null,
                    Tertiary: sorts[2] || null
                };
            }
        }

        var playlistData = {
            Name: wizardState.playlistName,
            MediaTypes: wizardState.selectedMediaTypes,
            SourcePlaylistId: wizardState.isConvert ? wizardState.sourcePlaylistId : null,
            ExpressionSets: wizardState.expressionSets,
            Order: orderDto,
            MaxItems: parseInt(page.querySelector('#wizardMaxItems').value, 10) || null,
            MaxPlayTimeMinutes: parseInt(page.querySelector('#wizardMaxPlaytime').value, 10) || null,
            Public: page.querySelector('#wizardIsPublic')?.checked || false,
            Enabled: true,
            DefaultIgnoreDurationDays: 30,
            IncludedItemIds: wizardState.previewItems.map(function (item) { return item.Id; })
        };

        // If MaxItems or MaxPlayTimeMinutes is 0, set to null
        if (playlistData.MaxItems === 0) playlistData.MaxItems = null;
        if (playlistData.MaxPlayTimeMinutes === 0) playlistData.MaxPlayTimeMinutes = null;

        SmartLists.showNotification('Creating playlist...', 'info');

        var createBtn = page.querySelector('#createPlaylistBtn');
        if (createBtn) {
            createBtn.disabled = true;
            createBtn.textContent = 'Creating...';
        }

        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.base),
            contentType: 'application/json',
            data: JSON.stringify(playlistData)
        }).then(parseApiResponse).then(function (result) {
            SmartLists.showNotification('Playlist created successfully!', 'success');

            // Navigate back to user config page
            setTimeout(function () {
                window.location.href = 'configurationpage?name=user-config.html#?tab=manage';
            }, 1000);
        }).catch(function (err) {
            console.error('[SmartLists Wizard] Error creating playlist:', err);
            SmartLists.showNotification('Failed to create playlist: ' + err.message, 'error');

            if (createBtn) {
                createBtn.disabled = false;
                createBtn.textContent = 'Create Playlist';
            }
        });
    }

    // Add items to existing playlist (edit mode)
    function addItemsToExistingPlaylist(page, apiClient) {
        var itemIds = wizardState.previewItems.map(function (item) { return item.Id; });

        SmartLists.showNotification('Adding ' + itemIds.length + ' items to playlist...', 'info');

        var createBtn = page.querySelector('#createPlaylistBtn');
        if (createBtn) {
            createBtn.disabled = true;
            createBtn.textContent = 'Adding...';
        }

        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(USER_ENDPOINTS.base + '/' + wizardState.editPlaylistId + '/add-items'),
            contentType: 'application/json',
            data: JSON.stringify({
                ItemIds: itemIds
            })
        }).then(parseApiResponse).then(function (result) {
            SmartLists.showNotification('Added ' + result.Added + ' items to playlist!', 'success');

            // Navigate back to user config page
            setTimeout(function () {
                window.location.href = 'configurationpage?name=user-config.html#?tab=manage';
            }, 1000);
        }).catch(function (err) {
            console.error('[SmartLists Wizard] Error adding items to playlist:', err);
            SmartLists.showNotification('Failed to add items: ' + err.message, 'error');

            if (createBtn) {
                createBtn.disabled = false;
                createBtn.textContent = 'Add Items';
            }
        });
    }

    // ===== HELPERS =====
    function formatDuration(ticks) {
        var seconds = Math.floor(ticks / 10000000);
        var minutes = Math.floor(seconds / 60);
        var remainingSeconds = seconds % 60;
        return minutes + ':' + (remainingSeconds < 10 ? '0' : '') + remainingSeconds;
    }

    function formatDurationMinutes(ticks) {
        var totalMinutes = Math.round(ticks / 10000000 / 60);
        var hours = Math.floor(totalMinutes / 60);
        var minutes = totalMinutes % 60;

        if (hours > 0) {
            return hours + 'h ' + minutes + 'm';
        }
        return minutes + ' minutes';
    }

    // ===== EVENT LISTENERS =====
    function setupWizardEventListeners(page) {
        // Step navigation
        var nextBtn = page.querySelector('#nextStepBtn');
        var prevBtn = page.querySelector('#prevStepBtn');
        var createBtn = page.querySelector('#createPlaylistBtn');

        if (nextBtn) {
            nextBtn.addEventListener('click', function () {
                goToNextStep(page);
            });
        }

        if (prevBtn) {
            prevBtn.addEventListener('click', function () {
                goToPrevStep(page);
            });
        }

        if (createBtn) {
            createBtn.addEventListener('click', function () {
                createPlaylist(page);
            });
        }

        // Public checkbox - update summary when changed
        var publicCheckbox = page.querySelector('#wizardIsPublic');
        if (publicCheckbox) {
            publicCheckbox.addEventListener('change', function () {
                updateConfirmationSummary(page);
            });
        }

        // Add method tabs
        var methodTabs = page.querySelectorAll('.add-method-tab');
        methodTabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                switchAddMethod(page, tab.getAttribute('data-method'));
            });
        });

        // Apply rules button
        var applyRulesBtn = page.querySelector('#applyRulesBtn');
        if (applyRulesBtn) {
            applyRulesBtn.addEventListener('click', function () {
                applyRulesToPreview(page);
            });
        }

        // Browse buttons
        var browseFetchBtn = page.querySelector('#browseFetchBtn');
        if (browseFetchBtn) {
            browseFetchBtn.addEventListener('click', function () {
                fetchBrowseItems(page, false);
            });
        }

        var browseLoadAllBtn = page.querySelector('#browseLoadAllBtn');
        if (browseLoadAllBtn) {
            browseLoadAllBtn.addEventListener('click', function () {
                fetchBrowseItems(page, true);
            });
        }

        var browseSelectAllBtn = page.querySelector('#browseSelectAllBtn');
        if (browseSelectAllBtn) {
            browseSelectAllBtn.addEventListener('click', function () {
                var checkboxes = page.querySelectorAll('.browse-item-checkbox');
                checkboxes.forEach(function (cb) { cb.checked = true; });
            });
        }

        var browseAddAllBtn = page.querySelector('#browseAddAllBtn');
        if (browseAddAllBtn) {
            browseAddAllBtn.addEventListener('click', function () {
                addAllBrowseItems(page);
            });
        }

        var browseAddBtn = page.querySelector('#browseAddSelectedBtn');
        if (browseAddBtn) {
            browseAddBtn.addEventListener('click', function () {
                addSelectedBrowseItems(page);
            });
        }

        // Browse pagination buttons
        var browsePrevBtn = page.querySelector('#browsePrevBtn');
        if (browsePrevBtn) {
            browsePrevBtn.addEventListener('click', function () {
                browsePrevPage(page);
            });
        }

        var browseNextBtn = page.querySelector('#browseNextBtn');
        if (browseNextBtn) {
            browseNextBtn.addEventListener('click', function () {
                browseNextPage(page);
            });
        }

        // Search buttons
        var searchBtn = page.querySelector('#searchBtn');
        if (searchBtn) {
            searchBtn.addEventListener('click', function () {
                performSearch(page);
            });
        }

        var searchInput = page.querySelector('#searchInput');
        if (searchInput) {
            searchInput.addEventListener('keypress', function (e) {
                if (e.key === 'Enter') {
                    performSearch(page);
                }
            });
        }

        var searchSelectAllBtn = page.querySelector('#searchSelectAllBtn');
        if (searchSelectAllBtn) {
            searchSelectAllBtn.addEventListener('click', function () {
                var checkboxes = page.querySelectorAll('.search-item-checkbox');
                checkboxes.forEach(function (cb) { cb.checked = true; });
            });
        }

        var searchAddBtn = page.querySelector('#searchAddSelectedBtn');
        if (searchAddBtn) {
            searchAddBtn.addEventListener('click', function () {
                addSelectedSearchItems(page);
            });
        }

        // Preview buttons
        var removeSelectedBtn = page.querySelector('#removeSelectedPreviewBtn');
        if (removeSelectedBtn) {
            removeSelectedBtn.addEventListener('click', function () {
                removeSelectedFromPreview(page);
            });
        }

        var clearPreviewBtn = page.querySelector('#clearPreviewBtn');
        if (clearPreviewBtn) {
            clearPreviewBtn.addEventListener('click', function () {
                clearPreview(page);
            });
        }

        var previewSelectAll = page.querySelector('#previewSelectAll');
        if (previewSelectAll) {
            previewSelectAll.addEventListener('change', function () {
                var checkboxes = page.querySelectorAll('.preview-item-checkbox');
                checkboxes.forEach(function (cb) {
                    cb.checked = previewSelectAll.checked;
                });
            });
        }

        // Rule action buttons (click delegation)
        page.addEventListener('click', function (e) {
            var target = e.target;

            if (target.classList.contains('and-btn')) {
                var ruleRow = target.closest('.rule-row');
                var logicGroup = ruleRow.closest('.logic-group');
                if (SmartLists.addRuleToGroup) {
                    SmartLists.addRuleToGroup(page, logicGroup);
                }
            }
            if (target.classList.contains('or-btn')) {
                if (SmartLists.addNewLogicGroup) {
                    SmartLists.addNewLogicGroup(page, '#wizard-rules-container');
                }
            }
            if (target.classList.contains('delete-btn')) {
                var ruleRow = target.closest('.rule-row');
                if (ruleRow && SmartLists.removeRule) {
                    SmartLists.removeRule(page, ruleRow);
                }
            }
        });

        // Load browse filters when switching to browse
        var browseTab = page.querySelector('.add-method-tab[data-method="browse"]');
        if (browseTab) {
            browseTab.addEventListener('click', function () {
                var genreSelect = page.querySelector('#browseGenre');
                if (genreSelect && genreSelect.options.length <= 1) {
                    loadBrowseFilters(page);
                }
            });
        }
    }

    // ===== PAGE EVENT HANDLERS =====
    document.addEventListener('pageshow', function (e) {
        var page = e.target;
        if (page.classList.contains('UserSmartListsWizardPage')) {
            SmartLists.initWizardPage(page);
        }
    });

    // ===== IMMEDIATE INITIALIZATION =====
    (function () {
        var maxRetries = 20;
        var retryCount = 0;

        var tryInit = function () {
            var page = document.querySelector('.UserSmartListsWizardPage');
            if (page && !page._wizardInitialized) {
                if (typeof SmartLists.getApiClient !== 'function') {
                    if (retryCount < maxRetries) {
                        retryCount++;
                        setTimeout(tryInit, 50);
                    }
                    return;
                }

                var apiClient = SmartLists.getApiClient();
                if (apiClient || window.ApiClient) {
                    SmartLists.initWizardPage(page);
                } else {
                    console.error('[SmartLists Wizard] Could not create API client');
                }
            }
        };

        setTimeout(tryInit, 10);
    })();

})(window.SmartLists = window.SmartLists || {});
