'use strict';

const IS_NATIVE = window.Capacitor?.isNativePlatform?.() === true;
const APP_ORIGIN = IS_NATIVE ? 'https://app.myglpshot.com' : location.origin;
const API_BASE_KEY = 'mgs_api_base';

function normalizeApiBase(value) {
  const input = (value || '').trim();
  if (/\s/.test(input) || !/^https:\/\//i.test(input) || /[?#\\]/.test(input)) return null;
  try {
    const url = new URL(input);
    if (!url.hostname || url.username || url.password) return null;
    return url.href.replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
}

function apiBase() {
  if (!IS_NATIVE) return 'api';
  try {
    const saved = normalizeApiBase(localStorage.getItem(API_BASE_KEY));
    if (saved) return saved;
  } catch (_) {}
  return APP_ORIGIN + '/api';
}

function setApiBase(url) {
  if (!url.trim()) {
    localStorage.removeItem(API_BASE_KEY);
    return;
  }
  const base = normalizeApiBase(url);
  if (!base) throw new Error('Enter an HTTPS server address without credentials, a query, or a fragment.');
  localStorage.setItem(API_BASE_KEY, base);
}

function apiUrl(path, rootRelative = false) {
  return (rootRelative && !IS_NATIVE ? '/' : '') + apiBase() + '/' + path;
}
