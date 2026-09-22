/* DS2 cheat-sheet local store.
 * Wraps localStorage with jStorage fallback so existing users keep progress.
 * Exposes window.DS2Store { getProfiles(), setProfiles() }.
 */
(function (global) {
    'use strict';

    function readRaw(key) {
        try {
            // Prefer jStorage if present (legacy data lives there).
            if (global.jQuery && global.jQuery.jStorage) {
                var v = global.jQuery.jStorage.get(key);
                if (v !== null && typeof v !== 'undefined') return v;
            }
        } catch (e) { /* ignore */ }
        try {
            var raw = global.localStorage.getItem(key);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    function writeRaw(key, value) {
        try {
            global.localStorage.setItem(key, JSON.stringify(value));
        } catch (e) { /* quota / private mode */ }
        try {
            if (global.jQuery && global.jQuery.jStorage) {
                global.jQuery.jStorage.set(key, value);
            }
        } catch (e) { /* ignore */ }
    }

    function defaultProfiles(key) {
        var d = { current: 'Default Profile' };
        d[key] = { 'Default Profile': { checklistData: {} } };
        return d;
    }

    global.DS2Store = {
        getProfiles: function (key) {
            var v = readRaw(key);
            if (!v) {
                v = defaultProfiles(key);
                writeRaw(key, v);
            }
            // Self-heal old shapes.
            if (!v.current || !v[key]) {
                var healed = defaultProfiles(key);
                if (v && v.current) healed.current = v.current;
                if (v && v[key]) healed[key] = v[key];
                v = healed;
            }
            return v;
        },
        setProfiles: function (key, value) {
            value._updatedAt = new Date().toISOString();
            writeRaw(key, value);
        }
    };
})(window);
