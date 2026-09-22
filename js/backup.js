/* DS2 dated backup / restore (file only, no accounts, no network).
 *
 * Save backup  -> downloads ds2-backup-YYYYMMDD-HHmm.json containing
 *                 { app, version, savedAt, profiles }. Works offline.
 * Restore       -> pick a file, see its date BEFORE anything changes,
 *                 then Replace (wipes this device and applies the file).
 * Newest date wins — compare the preview date with this device's date.
 *
 * Needs window.DS2BackupHost = { getProfiles(), applyProfiles(profiles) }
 * (see js/main.js). No dependencies beyond jQuery + Bootstrap modal.
 */
(function (global) {
    'use strict';

    var LAST_KEY = 'ds2_last_backup_at';

    function profilesKey() { return global.profilesKey || 'ds2_profiles'; }
    function host() { return global.DS2BackupHost || null; }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function fileStamp(d) {
        return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
            '-' + pad(d.getHours()) + pad(d.getMinutes());
    }

    function formatDate(iso) {
        if (!iso) return 'unknown date';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return 'unknown date';
        return d.toLocaleString();
    }

    function getLastBackupAt() {
        try { return global.localStorage.getItem(LAST_KEY) || ''; }
        catch (e) { return ''; }
    }

    function setLastBackupAt(iso) {
        try {
            if (iso) global.localStorage.setItem(LAST_KEY, iso);
            else global.localStorage.removeItem(LAST_KEY);
        } catch (e) { /* ignore */ }
    }

    function countChecks(profiles) {
        var key = profilesKey();
        var names = Object.keys(profiles[key] || {});
        var checks = 0;
        names.forEach(function (n) {
            var data = (((profiles[key] || {})[n] || {}).checklistData) || {};
            Object.keys(data).forEach(function (k) { if (data[k]) checks++; });
        });
        return { profiles: names.length, checks: checks };
    }

    function deviceDate() {
        var h = host();
        if (!h) return '';
        try { return h.getProfiles()._updatedAt || ''; }
        catch (e) { return ''; }
    }

    function refreshLastLine() {
        var el = document.querySelector('#backupLastLine');
        if (!el) return;
        var last = getLastBackupAt();
        el.innerHTML = '<small>Last backup: ' +
            (last ? escapeHtml(formatDate(last)) : 'never on this device.') + '</small>';
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function exportBackup() {
        var h = host();
        if (!h) return;
        var now = new Date();
        var payload = {
            app: 'ds2-cheat-sheet',
            version: 1,
            savedAt: now.toISOString(),
            profiles: h.getProfiles()
        };
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ds2-backup-' + fileStamp(now) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        setLastBackupAt(payload.savedAt);
        refreshLastLine();
    }

    var pending = null; // { savedAt, profiles, fileName, fileDate }

    function resetPending(msg) {
        pending = null;
        var preview = document.querySelector('#backupPreview');
        var btn = document.querySelector('#backupRestore');
        if (preview && msg) preview.textContent = msg;
        else if (preview) preview.textContent = '';
        if (btn) btn.disabled = true;
    }

    function describeBackup(savedAt, profiles, fileName) {
        var c = countChecks(profiles);
        return 'File: ' + fileName + ' — backup from ' + formatDate(savedAt) +
            ' — ' + c.profiles + ' profile(s), ' + c.checks + ' check(s).';
    }

    function onFilePicked(file) {
        var preview = document.querySelector('#backupPreview');
        var btn = document.querySelector('#backupRestore');
        if (!file) { resetPending(''); return; }
        var reader = new FileReader();
        reader.onload = function () {
            var parsed;
            try { parsed = JSON.parse(reader.result); }
            catch (e) {
                resetPending('That file is not a valid backup.');
                return;
            }
            var key = profilesKey();
            var profiles = parsed.profiles || null;
            var savedAt = parsed.savedAt || null;
            if (!profiles || !profiles[key]) {
                // Legacy shape: raw profiles object without wrapper.
                if (parsed[key]) {
                    profiles = parsed;
                    savedAt = savedAt || new Date(file.lastModified || Date.now()).toISOString();
                } else {
                    resetPending('That file does not look like a DS2 backup.');
                    return;
                }
            }
            if (!savedAt) savedAt = new Date(file.lastModified || Date.now()).toISOString();
            pending = { savedAt: savedAt, profiles: profiles, fileName: file.name };
            var devDate = deviceDate();
            var note = describeBackup(savedAt, profiles, file.name);
            if (devDate) {
                var f = Date.parse(savedAt) || 0;
                var d = Date.parse(devDate) || 0;
                note += ' This device: ' + formatDate(devDate) + '. ';
                note += (f >= d)
                    ? 'The file is newer — safe to restore.'
                    : 'WARNING: the file is OLDER than this device — restoring will lose newer checkmarks.';
            }
            if (preview) preview.textContent = note;
            if (btn) btn.disabled = false;
        };
        reader.onerror = function () { resetPending('Could not read that file.'); };
        reader.readAsText(file);
    }

    function onRestore() {
        var h = host();
        if (!h || !pending) return;
        var ok = global.confirm(
            'Replace ALL checkmarks on this device with the backup from ' +
            formatDate(pending.savedAt) + '?\nThis cannot be undone.');
        if (!ok) return;
        h.applyProfiles(pending.profiles);
        setLastBackupAt(pending.savedAt);
        refreshLastLine();
        var doneMsg = 'Restored backup from ' + formatDate(pending.savedAt) + '.';
        pending = null;
        var preview = document.querySelector('#backupPreview');
        var btn = document.querySelector('#backupRestore');
        if (preview) preview.textContent = doneMsg;
        if (btn) btn.disabled = true;
    }

    function wire() {
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.id) return;
            if (t.id === 'backupOpen') {
                resetPending('');
                refreshLastLine();
                if (global.jQuery) global.jQuery('#backupModal').modal('show');
            }
            else if (t.id === 'backupExport') exportBackup();
            else if (t.id === 'backupRestore') onRestore();
        });
        document.addEventListener('change', function (ev) {
            var t = ev.target;
            if (t && t.id === 'backupImportFile' && t.files && t.files[0]) {
                onFilePicked(t.files[0]);
                t.value = '';
            }
        });
        refreshLastLine();
    }

    global.DS2Backup = {
        exportBackup: exportBackup,
        lastBackupAt: getLastBackupAt
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }
})(window);
