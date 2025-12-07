(function () {
    'use strict';

    var USER_ENDPOINTS = {
        base: 'Plugins/SmartLists/User',
        export: 'Plugins/SmartLists/User/Export',
        import: 'Plugins/SmartLists/User/Import'
    };

    var STORAGE_KEY = 'smartlists_user_settings';

    function getSettings() {
        try {
            var stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (e) {
            console.error('[SmartLists Settings] Error reading settings:', e);
        }
        return { defaultIgnoreDays: 30 };
    }

    function saveSettings(settings) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
            return true;
        } catch (e) {
            console.error('[SmartLists Settings] Error saving settings:', e);
            return false;
        }
    }

    function loadSettings(page) {
        var settings = getSettings();
        var savedValue = String(settings.defaultIgnoreDays || 30);

        var setSelectValue = function() {
            var select = page.querySelector('#defaultIgnorePeriod');
            if (select) {
                select.value = savedValue;
                // Also update the selectedIndex for Jellyfin's custom select
                for (var i = 0; i < select.options.length; i++) {
                    if (select.options[i].value === savedValue) {
                        select.selectedIndex = i;
                        break;
                    }
                }
            }
        };

        // Set immediately and after a short delay (for Jellyfin's custom component)
        setSelectValue();
        setTimeout(setSelectValue, 100);
    }

    function saveSettingsFromForm(page) {
        var select = page.querySelector('#defaultIgnorePeriod');
        var days = select ? parseInt(select.value, 10) : 30;

        var settings = getSettings();
        settings.defaultIgnoreDays = days;

        if (saveSettings(settings)) {
            SmartLists.showNotification('Settings saved!', 'success');
        } else {
            SmartLists.showNotification('Failed to save settings.', 'error');
        }
    }

    function exportUserPlaylists() {
        var apiClient = SmartLists.getApiClient();
        var url = apiClient.getUrl(USER_ENDPOINTS.export);

        SmartLists.showNotification('Preparing export...', 'info');

        fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': 'MediaBrowser Token="' + apiClient.accessToken() + '"'
            }
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('Export failed');
            }
            return response.blob();
        }).then(function (blob) {
            var downloadUrl = window.URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = downloadUrl;
            a.download = 'smartlists-export-' + new Date().toISOString().split('T')[0] + '.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(downloadUrl);
            SmartLists.showNotification('Export complete!', 'success');
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

            // Notify that playlists may need refresh
            SmartLists.showNotification('Go to My NrN Playlists to see imported playlists.', 'info');
        }).catch(function (err) {
            console.error('Import error:', err);
            SmartLists.showNotification('Import failed: ' + err.message, 'error');
        });
    }

    function initPage(page) {
        loadSettings(page);

        // Save settings button
        var saveBtn = page.querySelector('#saveSettingsBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                saveSettingsFromForm(page);
            });
        }

        // Export button
        var exportBtn = page.querySelector('#exportPlaylistsBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', function () {
                exportUserPlaylists();
            });
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

    // Page lifecycle
    document.addEventListener('viewshow', function (e) {
        var page = e.target;
        if (page && page.classList && page.classList.contains('UserSmartListsSettingsPage')) {
            initPage(page);
        }
    });

    // Fallback initialization for direct page access (not through SPA navigation)
    (function () {
        var tryInit = function () {
            var page = document.querySelector('.UserSmartListsSettingsPage');
            if (page && !page._settingsInitialized) {
                page._settingsInitialized = true;
                initPage(page);
            }
        };

        // Try immediately and after short delays
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', tryInit);
        } else {
            tryInit();
        }
        setTimeout(tryInit, 100);
        setTimeout(tryInit, 500);
    })();

    // Expose getSettings globally for context menu to use
    window.SmartListsUserSettings = {
        getSettings: getSettings,
        saveSettings: saveSettings
    };
})();
