/* DS2 free + secure automatic cloud sync via secret GitHub Gist.
 *
 * No server to host. You create a fine-grained PAT with "gist" scope,
 * paste it once in Settings; progress auto-pushes (debounced) and pulls on load.
 * Token stays in your browser localStorage and is only sent to api.github.com over HTTPS.
 *
 * Optional passphrase enables AES-GCM encryption before upload so even the
 * gist content is opaque. Requires modern browser with WebCrypto for encryption;
 * without it, sync still works unencrypted.
 *
 * Exposes window.DS2Sync { schedule(), syncNow(), pull(), push(), exportFile(), status() }
 * Main app must set window.DS2SyncHost = { getProfiles(), applyProfiles(profiles) }.
 */
(function (global) {
    'use strict';

    var CONFIG_KEY = 'ds2_sync_config';
    var PASS_SESSION_KEY = 'ds2_sync_passphrase';
    var FILE_NAME = 'ds2-cheat-sheet-sync.json';
    var DEBOUNCE_MS = 4000;

    var timer = null;
    var syncing = false;
    var lastError = '';

    function $(sel) { return document.querySelector(sel); }

    function loadConfig() {
        try {
            return JSON.parse(global.localStorage.getItem(CONFIG_KEY) || '{}');
        } catch (e) { return {}; }
    }
    function saveConfig(cfg) {
        try { global.localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) {}
    }
    function getPassphrase() {
        try {
            return global.sessionStorage.getItem(PASS_SESSION_KEY) ||
                global.localStorage.getItem(PASS_SESSION_KEY + ':remember') || '';
        } catch (e) { return ''; }
    }
    function setPassphrase(pw, remember) {
        try {
            global.sessionStorage.setItem(PASS_SESSION_KEY, pw || '');
            if (remember) {
                global.localStorage.setItem(PASS_SESSION_KEY + ':remember', pw || '');
            } else {
                global.localStorage.removeItem(PASS_SESSION_KEY + ':remember');
            }
        } catch (e) {}
    }

    function setStatus(text, cls) {
        var el = $('#syncStatus');
        if (!el) return;
        el.textContent = text;
        el.className = 'sync-status ' + (cls || 'sync-offline');
        if (lastError && cls === 'sync-error') el.title = lastError;
        else el.removeAttribute('title');
    }

    function host() { return global.DS2SyncHost || null; }
    function profilesKey() { return global.profilesKey || 'ds2_profiles'; }

    // ---------- optional encryption (AES-GCM + PBKDF2) ----------
    function b64encode(bytes) {
        var s = '';
        bytes.forEach(function (b) { s += String.fromCharCode(b); });
        return btoa(s);
    }
    function b64decode(b64) {
        var s = atob(b64);
        var out = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }
    function hasCrypto() {
        return !!(global.crypto && global.crypto.subtle && global.TextEncoder);
    }
    function deriveKey(passphrase, salt) {
        var enc = new TextEncoder();
        return global.crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
            .then(function (base) {
                return global.crypto.subtle.deriveKey(
                    { name: 'PBKDF2', salt: salt, iterations: 120000, hash: 'SHA-256' },
                    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            });
    }
    function encryptPayload(plainText, passphrase) {
        var enc = new TextEncoder();
        var salt = global.crypto.getRandomValues(new Uint8Array(16));
        var iv = global.crypto.getRandomValues(new Uint8Array(12));
        return deriveKey(passphrase, salt).then(function (key) {
            return global.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plainText));
        }).then(function (ct) {
            return JSON.stringify({
                v: 1, enc: 'aes-gcm-pbkdf2', salt: b64encode(salt), iv: b64encode(iv),
                data: b64encode(new Uint8Array(ct))
            });
        });
    }
    function decryptPayload(wrapperText, passphrase) {
        var w;
        try { w = JSON.parse(wrapperText); } catch (e) { throw new Error('Cloud data is not valid JSON.'); }
        if (!w || w.v !== 1 || !w.data) throw new Error('Unknown encrypted format.');
        var salt = b64decode(w.salt), iv = b64decode(w.iv), data = b64decode(w.data);
        return deriveKey(passphrase, salt).then(function (key) {
            return global.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
        }).then(function (pt) {
            return new TextDecoder().decode(pt);
        }).catch(function () { throw new Error('Wrong password.'); });
    }

    function encodeForCloud(profilesObj, passphrase) {
        var plain = JSON.stringify({ app: 'ds2-cheat-sheet', version: 1, savedAt: new Date().toISOString(), profiles: profilesObj });
        if (passphrase && hasCrypto()) return encryptPayload(plain, passphrase);
        if (passphrase && !hasCrypto()) return Promise.reject(new Error('Password needs a modern browser. Leave it empty or update your browser.'));
        return Promise.resolve(plain);
    }
    function decodeFromCloud(fileText, passphrase) {
        var trimmed = (fileText || '').trim();
        if (trimmed.charAt(0) === '{' && trimmed.indexOf('"enc":"aes-gcm-pbkdf2"') !== -1) {
            if (!passphrase) throw new Error('This backup has a password. Enter it in Setup Sync under Advanced options.');
            return decryptPayload(trimmed, passphrase).then(function (plain) {
                return JSON.parse(plain).profiles;
            });
        }
        var parsed = JSON.parse(trimmed);
        return Promise.resolve(parsed.profiles || parsed);
    }

    // ---------- gist api ----------
    function cleanToken(raw) {
        var t = (raw || '').trim().replace(/^bearer\s+/i, '').replace(/^token\s+/i, '').trim();
        return t;
    }
    function extractGistId(raw) {
        var s = (raw || '').trim();
        if (!s) return '';
        // Accept a full gist URL too, e.g. https://gist.github.com/user/abc123...
        var m = s.match(/gist\.github\.com\/(?:[^/]+\/)?([0-9a-f]{20,})/i);
        if (m) return m[1];
        // Bare ID (hex, sometimes with dashes/spaces from copy-paste)
        m = s.match(/([0-9a-f]{20,})/i);
        if (m && s.length < 80) return m[1];
        return s;
    }
    function friendlyApiError(status, message) {
        if (status === 401) {
            return 'That code was rejected (wrong or expired). Create a fresh one and paste it again.';
        }
        if (status === 403 && /resource not accessible/i.test(message || '')) {
            return 'That code cannot touch gists. It needs the "gist" permission. Easiest fix: make a Classic token at GitHub > Settings > Developer settings > Personal access tokens > Tokens (classic), tick ONLY "gist", Generate, and paste the new code (starts with ghp_).';
        }
        if (status === 403) {
            return 'GitHub refused (403). Usually rate limit or token without gist access. ' + (message || '');
        }
        if (status === 404) {
            return 'Backup not found (404). The Backup ID is wrong, the gist was deleted, or this code belongs to a different GitHub account. Clear the Backup ID field and press Save & Sync to create a fresh one.';
        }
        return 'GitHub API ' + status + (message ? ': ' + message : '');
    }
    function api(path, token, opts) {
        opts = opts || {};
        opts.headers = opts.headers || {};
        opts.headers.Accept = 'application/vnd.github+json';
        opts.headers.Authorization = 'Bearer ' + token;
        opts.headers['X-GitHub-Api-Version'] = '2022-11-28';
        if (opts.body) opts.headers['Content-Type'] = 'application/json';
        return fetch('https://api.github.com' + path, opts).then(function (r) {
            if (!r.ok) {
                return r.text().then(function (t) {
                    var msg = '';
                    try { msg = JSON.parse(t).message || ''; }
                    catch (e) { msg = (t || '').slice(0, 200); }
                    var err = new Error(friendlyApiError(r.status, msg));
                    err.status = r.status;
                    err.raw = msg;
                    throw err;
                });
            }
            // 204 No Content has no JSON body
            if (r.status === 204) return {};
            return r.json();
        });
    }
    function validateToken(token) {
        return api('/user', token, {}).then(function (u) { return u; });
    }

    function mergeProfiles(localP, cloudP, key) {
        // Union merge: checked=true wins; profiles union; current = most recent.
        var out = { current: localP.current || cloudP.current };
        out[key] = {};
        var names = {};
        Object.keys(localP[key] || {}).forEach(function (n) { names[n] = 1; });
        Object.keys(cloudP[key] || {}).forEach(function (n) { names[n] = 1; });
        Object.keys(names).forEach(function (name) {
            var a = ((localP[key] || {})[name] || {}).checklistData || {};
            var b = ((cloudP[key] || {})[name] || {}).checklistData || {};
            var merged = {};
            Object.keys(a).forEach(function (k) { merged[k] = a[k]; });
            Object.keys(b).forEach(function (k) { merged[k] = merged[k] || b[k]; });
            out[key][name] = { checklistData: merged };
        });
        var lt = Date.parse(localP._updatedAt || 0) || 0;
        var ct = Date.parse(cloudP._updatedAt || 0) || 0;
        out.current = ct > lt ? (cloudP.current || out.current) : (localP.current || out.current);
        out._updatedAt = new Date(Math.max(lt, ct, Date.now())).toISOString();
        out._mergedAt = new Date().toISOString();
        return out;
    }

    function pushInternal(cfg, token, passphrase) {
        var h = host();
        if (!h) throw new Error('App not ready.');
        var key = profilesKey();
        var localP = h.getProfiles();
        return encodeForCloud(localP, passphrase).then(function (content) {
            var body = {
                description: 'DS2 cheat-sheet progress sync (secret)',
                public: false,
                files: {}
            };
            body.files[FILE_NAME] = { content: content };
            if (cfg.gistId) {
                return api('/gists/' + cfg.gistId, token, { method: 'PATCH', body: JSON.stringify({ files: body.files }) });
            }
            return api('/gists', token, { method: 'POST', body: JSON.stringify(body) }).then(function (g) {
                cfg.gistId = g.id;
                saveConfig(cfg);
                return g;
            });
        });
    }

    function pullInternal(cfg, token, passphrase) {
        if (!cfg.gistId) throw new Error('No online backup yet. Press Sync once to create it.');
        return api('/gists/' + cfg.gistId, token, {}).then(function (g) {
            var files = g.files || {};
            var f = files[FILE_NAME] || files[Object.keys(files)[0]];
            if (!f) throw new Error('Sync file not found in gist.');
            var text = f.content || '';
            if (f.truncated && f.raw_url) {
                return fetch(f.raw_url, { headers: { Authorization: 'Bearer ' + token } }).then(function (r) { return r.text(); });
            }
            return text;
        }).then(function (text) {
            return decodeFromCloud(text, passphrase);
        }).then(function (cloudProfiles) {
            var h = host();
            var key = profilesKey();
            var merged = mergeProfiles(h.getProfiles(), cloudProfiles, key);
            h.applyProfiles(merged);
            return merged;
        });
    }

    function syncNow(direction) {
        if (syncing) return Promise.resolve();
        var cfg = loadConfig();
        var token = cleanToken(cfg.token);
        if (!token) {
            openSettings('First paste your GitHub code above, then press Save & Sync.');
            return Promise.reject(new Error('No sync code saved yet.'));
        }
        cfg.token = token;
        saveConfig(cfg);
        var passphrase = getPassphrase();
        syncing = true;
        setStatus('Saving…', 'sync-working');
        var op = direction === 'push' ? pushInternal(cfg, token, passphrase)
            : direction === 'pull' ? pullInternal(cfg, token, passphrase)
            : (cfg.gistId
                ? pullInternal(cfg, token, passphrase).then(function () { return pushInternal(loadConfig(), token, getPassphrase()); })
                : pushInternal(cfg, token, passphrase));
        return op.then(function () {
            lastError = '';
            setStatus('Synced', 'sync-ok');
        }).catch(function (e) {
            lastError = (e && e.message) || String(e);
            setStatus('Sync failed — click Setup Sync for details', 'sync-error');
            throw e;
        }).finally(function () { syncing = false; });
    }

    function schedule() {
        var cfg = loadConfig();
        if (!cfg.token || cfg.auto === false) return;
        setStatus('Saving…', 'sync-pending');
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
            syncNow('both').catch(function () { /* status already set */ });
        }, DEBOUNCE_MS);
    }

    // ---------- export / import ----------
    function exportFile() {
        var h = host();
        if (!h) return;
        var blob = new Blob([JSON.stringify(h.getProfiles(), null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ds2-cheat-sheet-backup.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    function importFile(file) {
        var h = host();
        if (!h || !file) return Promise.reject(new Error('No file chosen.'));
        return file.text().then(function (text) {
            var parsed;
            try { parsed = JSON.parse(text); } catch (e) { throw new Error('That file is not a valid backup.'); }
            var key = profilesKey();
            var incoming = parsed.profiles || parsed;
            if (!incoming || !incoming[key]) throw new Error('That file does not look like DS2 checkmarks.');
            var merged = mergeProfiles(h.getProfiles(), incoming, key);
            h.applyProfiles(merged);
            schedule();
            return merged;
        });
    }

    // ---------- settings modal ----------
    function openSettings(notice) {
        var cfg = loadConfig();
        var tokenEl = $('#syncToken');
        var gistEl = $('#syncGistId');
        var autoEl = $('#syncAuto');
        var passEl = $('#syncPassphrase');
        var rememberEl = $('#syncRememberPass');
        var noteEl = $('#syncNotice');
        if (!tokenEl) return;
        tokenEl.value = cfg.token || '';
        if (gistEl) gistEl.value = cfg.gistId || '';
        if (autoEl) autoEl.checked = cfg.auto !== false;
        if (passEl) passEl.value = getPassphrase();
        if (rememberEl) rememberEl.checked = !!global.localStorage.getItem(PASS_SESSION_KEY + ':remember');
        if (noteEl) noteEl.textContent = notice || '';
        if (global.jQuery) global.jQuery('#syncModal').modal('show');
    }

    function wireModal() {
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.id) return;
            if (t.id === 'syncSettings') openSettings('');
            else if (t.id === 'syncNow') syncNow('both').catch(function (e) { alert('Could not sync: ' + e.message); });
            else if (t.id === 'syncPush') syncNow('push').catch(function (e) { alert('Could not save online: ' + e.message); });
            else if (t.id === 'syncPull') {
                if (!confirm('Load your online checkmarks onto this device? Your checkmarks on both sides will be combined.')) return;
                syncNow('pull').catch(function (e) { alert('Could not load: ' + e.message); });
            }
            else if (t.id === 'syncExport') exportFile();
            else if (t.id === 'syncSave') {
                var tokenInput = ($('#syncToken').value || '');
                var gistInput = ($('#syncGistId').value || '');
                var token = cleanToken(tokenInput);
                var gistId = extractGistId(gistInput);
                var noteEl = $('#syncNotice');
                if (!token) {
                    if (noteEl) noteEl.textContent = 'Paste your GitHub code first (it starts with ghp_ for classic tokens).';
                    return;
                }
                if (noteEl) noteEl.textContent = 'Checking code…';
                var cfg = loadConfig();
                // Validate before closing so a 403 shows the real fix inside the box.
                validateToken(token).then(function () {
                    cfg.token = token;
                    cfg.gistId = gistId;
                    cfg.auto = $('#syncAuto').checked;
                    saveConfig(cfg);
                    setPassphrase($('#syncPassphrase').value || '', $('#syncRememberPass').checked);
                    if (global.jQuery) global.jQuery('#syncModal').modal('hide');
                    setStatus('Sync on', 'sync-ok');
                    syncNow('both').catch(function (e) { alert('Could not sync: ' + e.message); });
                }).catch(function (e) {
                    if (noteEl) noteEl.textContent = 'Could not sync: ' + e.message;
                });
            }
            else if (t.id === 'syncForget') {
                try {
                    global.localStorage.removeItem(CONFIG_KEY);
                    global.localStorage.removeItem(PASS_SESSION_KEY + ':remember');
                    global.sessionStorage.removeItem(PASS_SESSION_KEY);
                } catch (e) {}
                if (global.jQuery) global.jQuery('#syncModal').modal('hide');
                setStatus('Sync off', 'sync-offline');
            }
        });
        document.addEventListener('change', function (ev) {
            var t = ev.target;
            if (t && t.id === 'syncImportFile' && t.files && t.files[0]) {
                importFile(t.files[0]).then(function () { alert('Backup loaded.'); })
                    .catch(function (e) { alert('Could not load file: ' + e.message); })
                    .finally(function () { t.value = ''; });
            }
        });
    }

    global.DS2Sync = {
        schedule: schedule,
        syncNow: syncNow,
        exportFile: exportFile,
        importFile: importFile,
        openSettings: openSettings,
        status: function () { return { syncing: syncing, lastError: lastError }; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            wireModal();
            var cfg = loadConfig();
            setStatus(cfg.token ? 'Sync on' : 'Sync off', cfg.token ? 'sync-ok' : 'sync-offline');
            // Auto-pull on load so a second device picks up progress.
            if (cfg.token && cfg.gistId && cfg.auto !== false) {
                setTimeout(function () { syncNow('pull').catch(function () {}); }, 800);
            }
        });
    } else {
        wireModal();
    }
})(window);
