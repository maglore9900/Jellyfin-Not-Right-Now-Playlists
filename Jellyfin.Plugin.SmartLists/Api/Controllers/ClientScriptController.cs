using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.SmartLists.Api.Controllers
{
    /// <summary>
    /// Controller that serves the client-side JavaScript for injecting NrN Playlists navigation.
    /// </summary>
    [ApiController]
    [Route("Plugins/SmartLists")]
    public class ClientScriptController : ControllerBase
    {
        /// <summary>
        /// Serves the client script that injects the NrN Playlists navigation link.
        /// </summary>
        /// <returns>JavaScript content.</returns>
        [HttpGet("ClientScript")]
        [AllowAnonymous]
        [Produces("application/javascript")]
        public IActionResult GetClientScript()
        {
            const string script = @"
(function() {
    'use strict';

    const PLUGIN_ID = 'smartlists-nav';
    const NAV_TEXT = 'NrN Playlists';
    const NAV_URL = '/web/configurationpage?name=user-config.html';

    // Check if already injected
    if (document.getElementById(PLUGIN_ID)) {
        return;
    }

    function getBaseUrl() {
        // Handle Jellyfin installations with custom base paths
        const scripts = document.querySelectorAll('script[src*=""ClientScript""]');
        for (const script of scripts) {
            const match = script.src.match(/(.*)\/Plugins\/SmartLists\/ClientScript/);
            if (match) {
                return match[1] || '';
            }
        }
        return '';
    }

    function injectNavigation() {
        // Strategy 1: Try to inject into the header/top bar area
        const headerRight = document.querySelector('.headerRight');
        if (headerRight) {
            injectHeaderButton(headerRight);
            return true;
        }

        // Strategy 2: Try the skinHeader
        const skinHeader = document.querySelector('.skinHeader');
        if (skinHeader) {
            const headerButtons = skinHeader.querySelector('.headerRight') ||
                                  skinHeader.querySelector('.headerButtons');
            if (headerButtons) {
                injectHeaderButton(headerButtons);
                return true;
            }
        }

        return false;
    }

    function injectHeaderButton(container) {
        const baseUrl = getBaseUrl();

        // Create a simple text link styled to match Jellyfin's header
        const link = document.createElement('a');
        link.id = PLUGIN_ID;
        link.href = baseUrl + NAV_URL;
        link.className = 'headerButton headerButtonRight';
        link.title = NAV_TEXT;
        link.style.cssText = `
            display: flex;
            align-items: center;
            padding: 0 10px;
            color: inherit;
            text-decoration: none;
            font-size: 0.85em;
            opacity: 0.85;
            transition: opacity 0.2s;
            cursor: pointer;
        `;

        link.innerHTML = `
            <span class=""material-icons"" style=""font-size: 1.4em; margin-right: 4px;"">queue_music</span>
            <span style=""white-space: nowrap;"">${NAV_TEXT}</span>
        `;

        link.addEventListener('mouseenter', function() {
            this.style.opacity = '1';
        });

        link.addEventListener('mouseleave', function() {
            this.style.opacity = '0.85';
        });

        // Insert before the user button if it exists, otherwise append
        const userButton = container.querySelector('.headerUserButton') ||
                          container.querySelector('[data-action=""user""]');
        if (userButton) {
            container.insertBefore(link, userButton);
        } else {
            container.appendChild(link);
        }

        console.log('[SmartLists] Navigation link injected');
    }

    function init() {
        // Try immediately
        if (injectNavigation()) {
            return;
        }

        // If DOM not ready, wait and retry
        let attempts = 0;
        const maxAttempts = 20;
        const interval = setInterval(function() {
            attempts++;
            if (injectNavigation() || attempts >= maxAttempts) {
                clearInterval(interval);
                if (attempts >= maxAttempts) {
                    console.log('[SmartLists] Could not find header element after ' + maxAttempts + ' attempts');
                }
            }
        }, 500);

        // Also listen for page changes (SPA navigation)
        document.addEventListener('viewshow', function() {
            if (!document.getElementById(PLUGIN_ID)) {
                injectNavigation();
            }
        });
    }

    // Start injection
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
";

            return Content(script, "application/javascript");
        }
    }
}
