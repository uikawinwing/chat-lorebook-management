import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { METADATA_KEY } from '../../../world-info.js';

const EXTENSION_NAME = 'Multi Chat Lore Proxy';
const PROXY_METADATA_KEY = 'multi_chat_lore_proxy';
const MANAGED_ENTRY_KEY = '_multiChatLoreProxy';
const UI_SETTINGS_STORAGE_KEY = 'mclp_ui_settings';
const MENU_ICON_CLASS = 'fa-book-open';
const SYNC_DELAY_MS = 100;
const WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const EMPTY_WORLD_INFO = { entries: {} };
const DEFAULT_UI_SETTINGS = {
  sortMode: 'name_asc',
  hideAdded: false,
  hideInternal: true,
  blacklistKeywords: ['__mclp__'],
};

const state = {
  syncTimer: null,
  syncPromise: null,
  syncQueued: false,
  internalSaves: new Set(),
  internalMetadataWrites: 0,
  suppressBindingGuardUntil: 0,
  patched: false,
  started: false,
  menuButton: null,
  popupOpen: false,
  menuRetryTimer: null,
  helperPatchTimer: null,
  bindingGuardTimer: null,
  lastMenuMissLoggedAt: 0,
  worldbookScanCache: new Map(),
};

function log(...args) {
  console.log(`[${EXTENSION_NAME}]`, ...args);
}

function warn(...args) {
  console.warn(`[${EXTENSION_NAME}]`, ...args);
}

function error(...args) {
  console.error(`[${EXTENSION_NAME}]`, ...args);
}

function formatError(value) {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function infoToast(message) {
  globalThis.toastr?.info?.(message, EXTENSION_NAME);
}

function successToast(message) {
  globalThis.toastr?.success?.(message, EXTENSION_NAME);
}

function errorToast(message) {
  globalThis.toastr?.error?.(message, EXTENSION_NAME);
}

function currentContext() {
  return getContext();
}

function getChatId() {
  const context = currentContext();
  return context.chatId ?? context.getCurrentChatId?.() ?? null;
}

function hasActiveChat() {
  return Boolean(getChatId());
}

function sanitizeBookName(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildAnchorName(chatId) {
  const base = sanitizeBookName(chatId) || 'chat';
  return `__mclp__${base}__${hashString(String(chatId))}`;
}

function buildDefaultScriptSourceName(chatId) {
  const base = sanitizeBookName(chatId) || 'chat';
  return `Chat Book ${base}`.slice(0, 64);
}

function normalizeSourceName(name) {
  const text = String(name ?? '').trim();
  return text || null;
}

function clone(value) {
  return structuredClone(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeKeywordList(value) {
  const items = Array.isArray(value) ? value : [];
  return Array.from(new Set(items
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 50)));
}

function loadUiSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? '{}');
    return {
      sortMode: ['name_asc', 'name_desc', 'entries_desc', 'unused_first'].includes(raw.sortMode)
        ? raw.sortMode
        : DEFAULT_UI_SETTINGS.sortMode,
      hideAdded: Boolean(raw.hideAdded),
      hideInternal: raw.hideInternal !== false,
      blacklistKeywords: normalizeKeywordList(raw.blacklistKeywords?.length ? raw.blacklistKeywords : DEFAULT_UI_SETTINGS.blacklistKeywords),
    };
  } catch (settingsError) {
    warn(`读取 UI 设置失败，已回退默认值\n${formatError(settingsError)}`);
    return clone(DEFAULT_UI_SETTINGS);
  }
}

function saveUiSettings(settings) {
  const payload = {
    sortMode: settings.sortMode,
    hideAdded: Boolean(settings.hideAdded),
    hideInternal: Boolean(settings.hideInternal),
    blacklistKeywords: normalizeKeywordList(settings.blacklistKeywords),
  };
  localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
}

function getWorldbookEntrySearchText(entry) {
  const parts = [];
  const pushValue = (value) => {
    if (Array.isArray(value)) {
      value.forEach(pushValue);
      return;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) {
        parts.push(text);
      }
    }
  };

  pushValue(entry?.comment);
  pushValue(entry?.key);
  pushValue(entry?.keysecondary);
  pushValue(entry?.name);
  return parts.join(' ').toLowerCase();
}

async function getWorldbookScan(name) {
  if (state.worldbookScanCache.has(name)) {
    return state.worldbookScanCache.get(name);
  }

  let scan = {
    entryCount: 0,
    entrySearchText: '',
  };

  try {
    const data = await readWorldbook(name);
    const entries = Object.values(data?.entries ?? {});
    scan = {
      entryCount: entries.length,
      entrySearchText: entries.map((entry) => getWorldbookEntrySearchText(entry)).filter(Boolean).join(' '),
    };
  } catch (scanError) {
    warn(`扫描聊天世界书失败: ${name}\n${formatError(scanError)}`);
  }

  state.worldbookScanCache.set(name, scan);
  return scan;
}

function getMatchedBlacklistKeyword(name, entrySearchText, blacklistKeywords) {
  const lowerName = String(name ?? '').toLowerCase();
  for (const keyword of normalizeKeywordList(blacklistKeywords)) {
    const lowerKeyword = keyword.toLowerCase();
    if (!lowerKeyword) {
      continue;
    }

    if (lowerName.includes(lowerKeyword) || entrySearchText.includes(lowerKeyword)) {
      return keyword;
    }
  }

  return null;
}

function sortCandidateRecords(records, sortMode) {
  const next = [...records];
  switch (sortMode) {
    case 'name_desc':
      next.sort((left, right) => right.name.localeCompare(left.name, 'zh-Hans-CN'));
      break;
    case 'entries_desc':
      next.sort((left, right) => {
        if (right.entryCount !== left.entryCount) {
          return right.entryCount - left.entryCount;
        }
        return left.name.localeCompare(right.name, 'zh-Hans-CN');
      });
      break;
    case 'unused_first':
      next.sort((left, right) => {
        if (left.isUsed !== right.isUsed) {
          return Number(left.isUsed) - Number(right.isUsed);
        }
        return left.name.localeCompare(right.name, 'zh-Hans-CN');
      });
      break;
    case 'name_asc':
    default:
      next.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
      break;
  }
  return next;
}

function ensureStyles() {
  if (document.getElementById('mclp_styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'mclp_styles';
  style.textContent = `
    .mclp-panel {
      width: 100%;
      max-width: 980px;
      min-width: 0;
      margin: 0 auto;
      color: var(--SmartThemeBodyColor, #ececf3);
      box-sizing: border-box;
      overflow-x: hidden;
      text-align: left;
    }

    .mclp-panel *,
    .mclp-panel *::before,
    .mclp-panel *::after {
      box-sizing: border-box;
    }

    .mclp-shell {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .mclp-header {
      padding: 16px;
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 12px;
      background: rgba(22, 24, 32, 0.96);
    }

    .mclp-header-main {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    .mclp-title-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
      flex: 1 1 220px;
    }

    .mclp-title {
      font-size: 1.08rem;
      font-weight: 800;
      letter-spacing: 0.01em;
    }

    .mclp-subtitle {
      font-size: 0.84rem;
      line-height: 1.45;
      color: rgba(236, 236, 243, 0.74);
    }

    .mclp-header-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-end;
      flex: 0 0 auto;
    }

    .mclp-mini-badge {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 11px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 0.82rem;
      font-weight: 700;
      white-space: nowrap;
    }

    .mclp-header-note {
      margin-top: 8px;
      font-size: 0.92rem;
      line-height: 1.6;
      opacity: 0.8;
    }

    .mclp-status-line {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 12px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .mclp-status-main {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }

    .mclp-status-action {
      display: inline-flex;
      justify-content: flex-end;
      align-items: center;
      white-space: nowrap;
      flex: 0 0 auto;
    }

    .mclp-status-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 800;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.1);
      flex: 0 0 auto;
    }

    .mclp-status-line--good .mclp-status-icon {
      border-color: rgba(71, 149, 119, 0.38);
      background: rgba(71, 149, 119, 0.18);
      color: #d8fff0;
    }

    .mclp-status-line--warn .mclp-status-icon {
      border-color: rgba(199, 145, 89, 0.4);
      background: rgba(199, 145, 89, 0.18);
      color: #ffe6c6;
    }

    .mclp-status-value {
      font-weight: 750;
      line-height: 1.35;
      word-break: break-word;
    }

    .mclp-status-detail {
      line-height: 1.45;
      color: rgba(236, 236, 243, 0.76);
      font-size: 0.84rem;
    }

    .mclp-code {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      max-width: 100%;
      padding: 2px 8px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 0.88rem;
      word-break: break-all;
    }

    .mclp-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 9px;
      border: 1px solid rgba(121, 140, 255, 0.34);
      background: rgba(121, 140, 255, 0.12);
      color: #dfe4ff;
      cursor: pointer;
      font-weight: 800;
      line-height: 1;
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .mclp-icon-button:hover {
      border-color: rgba(121, 140, 255, 0.56);
      background: rgba(121, 140, 255, 0.2);
    }

    .mclp-icon-button:focus-visible,
    .mclp-tab:focus-visible,
    .mclp-button:focus-visible,
    .mclp-action-button:focus-visible,
    .mclp-toggle:focus-within,
    .mclp-chip-remove:focus-visible {
      outline: 2px solid rgba(145, 160, 255, 0.92);
      outline-offset: 2px;
    }

    .mclp-tabs {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 4px;
      padding: 4px;
      border-radius: 12px;
      background: rgba(10, 12, 18, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }

    .mclp-tab {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      min-height: 52px;
      padding: 9px 11px;
      border: 1px solid transparent;
      border-radius: 9px;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .mclp-tab:hover {
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.06);
    }

    .mclp-tab.is-active {
      border-color: rgba(104, 130, 255, 0.42);
      background: rgba(88, 108, 195, 0.18);
      box-shadow: inset 0 -2px 0 rgba(125, 146, 255, 0.92);
    }

    .mclp-tab-label {
      font-size: 0.92rem;
      font-weight: 700;
      line-height: 1.2;
    }

    .mclp-tab-hint {
      font-size: 0.76rem;
      opacity: 0.66;
      line-height: 1.3;
    }

    .mclp-pane {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .mclp-section {
      padding: 16px;
      border-radius: 12px;
      background: rgba(25, 27, 34, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }

    .mclp-section-title {
      text-align: left;
      font-size: 1.06rem;
      font-weight: 800;
      letter-spacing: 0.01em;
    }

    .mclp-section-desc {
      margin-top: 4px;
      color: rgba(236, 236, 243, 0.76);
      line-height: 1.58;
      font-size: 0.9rem;
      text-align: left;
    }

    .mclp-control-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-top: 12px;
    }

    .mclp-control-grid--quick {
      grid-template-columns: minmax(0, 1fr) 220px;
    }

    .mclp-card {
      padding: 12px;
      border-radius: 10px;
      background: rgba(13, 15, 20, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .mclp-card--primary {
      border-color: rgba(104, 130, 255, 0.26);
      background: rgba(16, 19, 30, 0.62);
    }

    .mclp-card-title {
      font-size: 0.92rem;
      font-weight: 720;
      margin-bottom: 8px;
      text-align: left;
    }

    .mclp-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
    }

    .mclp-quick-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      margin-top: 6px;
      padding-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
    }

    .mclp-quick-actions .mclp-help {
      flex: 1 1 260px;
    }

    .mclp-quick-buttons {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    .mclp-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .mclp-input,
    .mclp-select {
      width: 100%;
      min-width: 0;
      height: 38px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(8, 10, 14, 0.92);
      color: inherit;
      padding: 0 12px;
      outline: none;
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .mclp-input:focus,
    .mclp-select:focus {
      border-color: rgba(121, 140, 255, 0.8);
      background: rgba(10, 12, 18, 0.98);
      box-shadow: 0 0 0 2px rgba(121, 140, 255, 0.16);
    }

    .mclp-button {
      min-height: 38px;
      padding: 0 14px;
      border-radius: 9px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      color: inherit;
      cursor: pointer;
      font-weight: 650;
      transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
    }

    .mclp-action-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      min-width: 34px;
      padding: 0;
      border-radius: 9px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      color: inherit;
      cursor: pointer;
      font-size: 1rem;
      font-weight: 800;
      line-height: 1;
    }

    .mclp-button:hover:not(:disabled) {
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.08);
    }

    .mclp-button:disabled {
      cursor: default;
      opacity: 0.56;
    }

    .mclp-button--primary,
    .mclp-action-button--primary {
      border-color: rgba(111, 132, 255, 0.62);
      background: linear-gradient(135deg, rgba(88, 108, 195, 0.78), rgba(92, 72, 170, 0.68));
      color: #f6f7ff;
      box-shadow: 0 8px 18px rgba(65, 82, 180, 0.22);
    }

    .mclp-button--primary:hover:not(:disabled),
    .mclp-action-button--primary:hover:not(:disabled) {
      border-color: rgba(145, 160, 255, 0.86);
      background: linear-gradient(135deg, rgba(98, 120, 218, 0.86), rgba(105, 82, 190, 0.76));
      transform: translateY(-1px);
    }

    .mclp-button--danger,
    .mclp-action-button--danger {
      border-color: rgba(199, 89, 113, 0.34);
      background: rgba(199, 89, 113, 0.12);
      color: #ffd9df;
    }

    .mclp-button--secondary {
      border-color: rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.06);
      box-shadow: none;
    }

    .mclp-button--ghost {
      background: rgba(255, 255, 255, 0.02);
    }

    .mclp-help {
      color: rgba(236, 236, 243, 0.76);
      line-height: 1.6;
      font-size: 0.88rem;
      text-align: left;
    }

    .mclp-source-list,
    .mclp-candidate-list {
      display: grid;
      gap: 8px;
    }

    .mclp-source-list {
      max-height: min(28vh, 220px);
      overflow: auto;
      padding-right: 3px;
    }

    .mclp-candidate-list {
      max-height: min(34vh, 300px);
      overflow: auto;
      padding-right: 3px;
    }

    .mclp-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(11, 13, 18, 0.42);
      border: 1px solid rgba(255, 255, 255, 0.055);
    }

    .mclp-item-main {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      flex: 1 1 auto;
    }

    .mclp-item-name {
      font-weight: 700;
      line-height: 1.42;
      word-break: break-word;
    }

    .mclp-meta-row,
    .mclp-chip-row,
    .mclp-toggle-row,
    .mclp-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .mclp-tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 0 8px;
      border-radius: 6px;
      font-size: 0.78rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.05);
      color: rgba(236, 236, 243, 0.86);
    }

    .mclp-tag--accent {
      border-color: rgba(97, 118, 236, 0.36);
      background: rgba(88, 108, 195, 0.16);
      color: #dfe4ff;
    }

    .mclp-tag--ok {
      border-color: rgba(71, 149, 119, 0.34);
      background: rgba(71, 149, 119, 0.16);
      color: #d8fff0;
    }

    .mclp-tag--mute {
      opacity: 0.62;
    }

    .mclp-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 32px;
      padding: 0 9px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
      cursor: pointer;
      user-select: none;
    }

    .mclp-toggle input {
      margin: 0;
    }

    .mclp-blacklist-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 30px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid rgba(199, 89, 113, 0.3);
      background: rgba(199, 89, 113, 0.12);
    }

    .mclp-chip-remove {
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.12);
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .mclp-empty {
      padding: 16px;
      border-radius: 8px;
      border: 1px dashed rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.02);
      opacity: 0.82;
      text-align: center;
      line-height: 1.65;
    }

    .mclp-summary {
      padding: 6px 0 0;
      line-height: 1.45;
      color: rgba(236, 236, 243, 0.72);
      font-size: 0.86rem;
    }

    .mclp-section--compact {
      padding: 14px;
    }

    .mclp-section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }

    .mclp-details {
      margin-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      padding-top: 10px;
    }

    .mclp-details summary {
      cursor: pointer;
      color: rgba(236, 236, 243, 0.78);
      font-weight: 700;
    }

    @media (max-width: 900px) {
      .mclp-control-grid,
      .mclp-control-grid--quick {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 680px) {
      .mclp-panel {
        width: 100%;
        max-width: 100%;
      }

      .mclp-shell {
        gap: 10px;
      }

      .mclp-header,
      .mclp-section {
        padding: 14px;
      }

      .mclp-header-main {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: start;
      }

      .mclp-status-line {
        align-items: flex-start;
      }

      .mclp-header-actions {
        justify-content: flex-end;
      }

      .mclp-mini-badge {
        display: none;
      }

      .mclp-tabs {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .mclp-tab {
        min-height: 44px;
        padding: 8px 10px;
      }

      .mclp-tab-hint {
        display: none;
      }

      .mclp-status-line {
        flex-direction: column;
        gap: 10px;
      }

      .mclp-status-action,
      .mclp-status-action .mclp-button {
        width: 100%;
      }

      .mclp-row {
        grid-template-columns: 1fr;
      }

      .mclp-button,
      .mclp-quick-buttons,
      .mclp-quick-buttons .mclp-button {
        width: 100%;
      }

      .mclp-candidate-list {
        max-height: min(48vh, 360px);
      }
    }
  `;
  document.head.appendChild(style);
}

function getProxyState() {
  const context = currentContext();
  const metadata = context.chatMetadata ?? {};
  const raw = metadata[PROXY_METADATA_KEY];
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const anchor = normalizeSourceName(raw.anchor);
  const sources = Array.isArray(raw.sources)
    ? raw.sources.map(normalizeSourceName).filter(Boolean)
    : [];

  if (!anchor) {
    return null;
  }

  const uniqueSources = Array.from(new Set(sources.filter((name) => name !== anchor)));
  const scriptBinding = normalizeSourceName(raw.scriptBinding ?? raw.scriptFacingBinding);
  const validScriptBinding = scriptBinding && uniqueSources.includes(scriptBinding)
    ? scriptBinding
    : (uniqueSources.length ? uniqueSources.at(-1) : null);

  return {
    version: 1,
    anchor,
    sources: uniqueSources,
    scriptBinding: validScriptBinding,
  };
}

async function saveProxyState(proxyState) {
  const context = currentContext();

  if (!proxyState) {
    log('清除当前聊天代理状态');
    context.updateChatMetadata({ [PROXY_METADATA_KEY]: null }, false);
    delete context.chatMetadata?.[PROXY_METADATA_KEY];
    await context.saveMetadata();
    return;
  }

  const sources = Array.from(new Set(proxyState.sources.filter(Boolean).filter((name) => name !== proxyState.anchor)));
  const scriptBinding = normalizeSourceName(proxyState.scriptBinding);
  const validScriptBinding = scriptBinding && sources.includes(scriptBinding)
    ? scriptBinding
    : (sources.length ? sources.at(-1) : null);

  const payload = {
    version: 1,
    anchor: proxyState.anchor,
    sources,
    scriptBinding: validScriptBinding,
  };

  log('保存聊天代理状态', payload);
  context.updateChatMetadata({ [PROXY_METADATA_KEY]: payload }, false);
  context.chatMetadata[PROXY_METADATA_KEY] = payload;
  await context.saveMetadata();
}

async function bindChatMetadataTo(name) {
  const context = currentContext();

  state.internalMetadataWrites += 1;
  try {
    if (!name) {
      log('解除 chat metadata 的聊天世界书绑定');
      delete context.chatMetadata?.[METADATA_KEY];
      context.updateChatMetadata({ [METADATA_KEY]: null }, false);
    } else {
      log(`将 chat metadata 绑定到聊天世界书: ${name}`);
      context.chatMetadata[METADATA_KEY] = name;
      context.updateChatMetadata({ [METADATA_KEY]: name }, false);
    }

    await context.saveMetadata();
  } finally {
    state.internalMetadataWrites -= 1;
  }
}

function deferBindingGuard(durationMs = 1500) {
  state.suppressBindingGuardUntil = Math.max(state.suppressBindingGuardUntil, Date.now() + durationMs);
}

async function runWithTemporaryChatBinding(bookName, operation) {
  const sourceName = normalizeSourceName(bookName);
  if (!sourceName) {
    return await operation();
  }

  const proxyState = getProxyState();
  if (!proxyState?.anchor || proxyState.anchor === sourceName) {
    return await operation();
  }

  const context = currentContext();
  const previousBinding = normalizeSourceName(context.chatMetadata?.[METADATA_KEY]);
  const shouldTemporarilyBind = previousBinding !== sourceName;

  deferBindingGuard();
  if (shouldTemporarilyBind) {
    await bindChatMetadataTo(sourceName);
  }

  try {
    return await operation();
  } finally {
    deferBindingGuard();
    if (shouldTemporarilyBind) {
      await bindChatMetadataTo(proxyState.anchor);
    }
    scheduleSync(`temporary_write:${sourceName}`, 0);
  }
}

async function ensureWorldbookExists(name) {
  if (!name) {
    return null;
  }

  const context = currentContext();
  const data = await context.loadWorldInfo(name);
  if (data) {
    log(`确认聊天世界书已存在: ${name}`);
    return data;
  }

  log(`未找到聊天世界书，正在创建空白书: ${name}`);
  const emptyData = clone(EMPTY_WORLD_INFO);
  state.internalSaves.add(name);
  try {
    await context.saveWorldInfo(name, emptyData, true);
    state.worldbookScanCache.set(name, { entryCount: 0, entrySearchText: '' });
    log(`已创建空白聊天世界书: ${name}`);
  } finally {
    state.internalSaves.delete(name);
  }
  return emptyData;
}

function getEntryManager(entry) {
  return entry?.[MANAGED_ENTRY_KEY] ?? null;
}

function isManagedEntry(entry) {
  const manager = getEntryManager(entry);
  return Boolean(manager?.managed);
}

function nextEntryUid(entries) {
  const taken = Object.keys(entries)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  let uid = taken.length ? Math.max(...taken) + 1 : 0;
  while (Object.prototype.hasOwnProperty.call(entries, uid)) {
    uid += 1;
  }
  return uid;
}

async function readWorldbook(name) {
  const context = currentContext();
  const data = await context.loadWorldInfo(name);
  return data ? clone(data) : null;
}

async function ensureProxyReady() {
  const context = currentContext();
  const chatId = getChatId();
  if (!chatId) {
    warn('ensureProxyReady 跳过：当前没有活动聊天');
    return null;
  }

  const existingBinding = normalizeSourceName(context.chatMetadata?.[METADATA_KEY]);
  let proxyState = getProxyState();

  if (!proxyState) {
    proxyState = {
      version: 1,
      anchor: buildAnchorName(chatId),
      sources: [],
      scriptBinding: null,
    };
    log(`为聊天创建新的代理锚点: chat=${chatId}, anchor=${proxyState.anchor}`);
  }

  if (existingBinding && existingBinding !== proxyState.anchor && !proxyState.sources.includes(existingBinding)) {
    log(`检测到现有聊天世界书绑定，将其纳入来源书: ${existingBinding}`);
    proxyState.sources.push(existingBinding);
    proxyState.scriptBinding = existingBinding;
  }

  await ensureWorldbookExists(proxyState.anchor);

  const validSources = [];
  for (const sourceName of proxyState.sources) {
    if (sourceName === proxyState.anchor) {
      continue;
    }

    const sourceData = await currentContext().loadWorldInfo(sourceName);
    if (sourceData) {
      validSources.push(sourceName);
    } else {
      warn(`来源聊天世界书不存在，已忽略: ${sourceName}`);
    }
  }
  proxyState.sources = validSources;
  if (!proxyState.scriptBinding || !proxyState.sources.includes(proxyState.scriptBinding)) {
    proxyState.scriptBinding = proxyState.sources.at(-1) ?? null;
  }

  const previousState = getProxyState();
  const shouldSaveState = !previousState
    || previousState.anchor !== proxyState.anchor
    || previousState.scriptBinding !== proxyState.scriptBinding
    || JSON.stringify(previousState.sources ?? []) !== JSON.stringify(proxyState.sources);

  if (shouldSaveState) {
    await saveProxyState(proxyState);
  }

  if (context.chatMetadata?.[METADATA_KEY] !== proxyState.anchor) {
    await bindChatMetadataTo(proxyState.anchor);
  }

  return proxyState;
}

async function syncAnchorWorldbook() {
  if (!hasActiveChat()) {
    warn('syncAnchorWorldbook 跳过：当前没有活动聊天');
    return null;
  }

  const proxyState = await ensureProxyReady();
  if (!proxyState) {
    return null;
  }

  log(`开始聚合同步: anchor=${proxyState.anchor}, sources=${proxyState.sources.length}`);
  const anchorData = (await readWorldbook(proxyState.anchor)) ?? clone(EMPTY_WORLD_INFO);
  const preservedEntries = {};

  for (const [uid, entry] of Object.entries(anchorData.entries ?? {})) {
    if (!isManagedEntry(entry)) {
      preservedEntries[uid] = entry;
    }
  }

  const mergedEntries = { ...preservedEntries };
  const validSources = [];

  for (const sourceName of proxyState.sources) {
    const sourceData = await readWorldbook(sourceName);
    if (!sourceData) {
      warn(`同步时跳过不存在的来源聊天世界书: ${sourceName}`);
      continue;
    }

    validSources.push(sourceName);

    for (const entry of Object.values(sourceData.entries ?? {})) {
      const nextUid = nextEntryUid(mergedEntries);
      const clonedEntry = clone(entry);
      delete clonedEntry.uid;
      clonedEntry.uid = nextUid;
      clonedEntry[MANAGED_ENTRY_KEY] = {
        managed: true,
        sourceBook: sourceName,
        sourceUid: entry.uid ?? null,
      };
      mergedEntries[nextUid] = clonedEntry;
    }
  }

  proxyState.sources = validSources;
  await saveProxyState(proxyState);

  const nextAnchorData = {
    ...anchorData,
    entries: mergedEntries,
  };

  state.internalSaves.add(proxyState.anchor);
  try {
    await currentContext().saveWorldInfo(proxyState.anchor, nextAnchorData, true);
    state.worldbookScanCache.delete(proxyState.anchor);
  } finally {
    state.internalSaves.delete(proxyState.anchor);
  }

  log(`聚合同步完成: anchor=${proxyState.anchor}, preserved=${Object.keys(preservedEntries).length}, merged=${Object.keys(mergedEntries).length}, validSources=${validSources.length}`);
  return proxyState;
}

function getScriptFacingBinding() {
  const proxyState = getProxyState();
  if (!proxyState) {
    return normalizeSourceName(currentContext().chatMetadata?.[METADATA_KEY]);
  }

  return normalizeSourceName(proxyState.scriptBinding)
    ?? proxyState.sources.at(-1)
    ?? null;
}

async function repairBindingIfNeeded(reason = 'unknown') {
  if (!hasActiveChat() || state.internalMetadataWrites > 0 || Date.now() < state.suppressBindingGuardUntil) {
    return false;
  }

  const context = currentContext();
  const metadataBinding = normalizeSourceName(context.chatMetadata?.[METADATA_KEY]);
  const proxyState = getProxyState();

  if (!proxyState) {
    if (!metadataBinding) {
      return false;
    }

    log(`绑定守卫检测到未代理的聊天世界书绑定，开始接管: ${metadataBinding} (${reason})`);
    await ensureProxyReady();
    scheduleSync(`binding_guard_initial:${reason}`, 0);
    refreshMenuButton();
    return true;
  }

  if (metadataBinding === proxyState.anchor) {
    return false;
  }

  if (metadataBinding) {
    log(`绑定守卫检测到聊天世界书被外部改写，转为来源书并恢复锚点: ${metadataBinding} (${reason})`);
    await ensureWorldbookExists(metadataBinding);
    if (!proxyState.sources.includes(metadataBinding) && metadataBinding !== proxyState.anchor) {
      proxyState.sources.push(metadataBinding);
    }
    proxyState.scriptBinding = metadataBinding;
    await saveProxyState(proxyState);
  } else {
    warn(`绑定守卫检测到聊天世界书绑定被清空，恢复代理锚点 (${reason})`);
  }

  await bindChatMetadataTo(proxyState.anchor);
  scheduleSync(`binding_guard:${reason}`, 0);
  refreshMenuButton();
  return true;
}

function getStatusSnapshot() {
  const context = currentContext();
  const proxyState = getProxyState();
  return {
    chatId: getChatId(),
    metadataBinding: normalizeSourceName(context.chatMetadata?.[METADATA_KEY]),
    scriptFacingBinding: getScriptFacingBinding(),
    proxyState,
    sourceCount: proxyState?.sources?.length ?? 0,
  };
}

function getBindingStatus(snapshot) {
  if (!snapshot.chatId) {
    return {
      ok: false,
      label: '未进入聊天',
      detail: '当前没有活动聊天，暂时无法建立或检查聊天世界书代理。',
      actionLabel: null,
    };
  }

  const anchor = snapshot.proxyState?.anchor;
  if (!anchor) {
    return {
      ok: false,
      label: '尚未建立代理',
      detail: '当前聊天还没有创建代理锚点，点击右侧按钮即可立即修复。',
      actionLabel: '立即修复绑定',
    };
  }

  if (snapshot.metadataBinding !== anchor) {
    return {
      ok: false,
      label: '绑定异常',
      detail: '当前聊天没有正确绑定到代理锚点，来源书可能不会完整生效。点击右侧按钮可重新绑定。',
      actionLabel: '重新绑定',
    };
  }

  return {
    ok: true,
    label: '绑定正常',
    detail: '当前聊天已经正确绑定到代理锚点，多本来源聊天世界书会聚合生效。',
    actionLabel: null,
  };
}

function renderTutorialHtml(snapshot) {
  const anchor = snapshot.proxyState?.anchor ?? buildAnchorName(snapshot.chatId ?? 'current');
  return `
    <div style="display:flex; flex-direction:column; gap:12px; width:min(720px, 92vw); max-width:92vw; line-height:1.7; text-align:left; align-items:stretch; overflow-wrap:anywhere; word-break:break-word;">
      <div style="font-size:1.06rem; font-weight:800; text-align:left;">多聊天世界书代理 · 说明</div>
      <div style="opacity:0.84;">这个扩展不会让 SillyTavern 原生一次绑定多本聊天世界书，而是为当前聊天创建 1 本代理锚点书，再把多个来源书的条目同步进去。</div>
      <div>
        <strong>锚点名称怎么来的？</strong><br>
        默认格式示例：<code style="white-space:normal; overflow-wrap:anywhere; word-break:break-all;">${escapeHtml(anchor)}</code><br>
        生成规则大致为：<code style="white-space:normal; overflow-wrap:anywhere; word-break:break-all;">__mclp__ + 当前聊天名/ID清洗结果 + 哈希尾缀</code>。
      </div>
      <div>
        <strong>为什么要这样命名？</strong><br>
        这样可以确保每个聊天都有自己稳定且唯一的代理锚点，避免和你手动创建的聊天世界书撞名。
      </div>
      <div>
        <strong>日常怎么用？</strong><br>
        1. 在“快速添加”里直接输入常用聊天世界书并接入。<br>
        2. 想从很多书里挑选时，再去“候选列表”。<br>
        3. 如果顶部显示“绑定异常”，点“重新绑定/立即修复绑定”即可。<br>
        4. “设置”里只放黑名单和偏好，不再把说明堆在主页面。
      </div>
      <div>
        <strong>要不要手动改锚点名称？</strong><br>
        一般不需要。把它当成扩展内部使用的代理书即可；你日常只需要管“来源聊天世界书”有没有接入成功。
      </div>
    </div>
  `;
}

async function showTutorialPopup() {
  const snapshot = getStatusSnapshot();
  try {
    await callGenericPopup(renderTutorialHtml(snapshot), POPUP_TYPE.TEXT, '', {
      okButton: '关闭',
      wide: true,
      allowVerticalScrolling: true,
    });
  } catch (popupError) {
    error(`打开说明面板失败\n${formatError(popupError)}`);
    errorToast('打开说明面板失败，请查看控制台');
  }
}

function getAvailableWorldbookNames() {
  const names = new Set();
  const snapshot = getStatusSnapshot();

  [snapshot.metadataBinding, snapshot.proxyState?.anchor, ...(snapshot.proxyState?.sources ?? [])]
    .filter(Boolean)
    .forEach((name) => names.add(name));

  $('#world_info option, #world_editor_select option').each((_, option) => {
    const text = normalizeSourceName($(option).text());
    if (!text || text.startsWith('---')) {
      return;
    }
    names.add(text);
  });

  return Array.from(names).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

function renderStatusHtml(snapshot) {
  const bindingStatus = getBindingStatus(snapshot);
  const statusIcon = bindingStatus.ok ? '✓' : '!';

  return `
    <section class="mclp-header" aria-label="多聊天世界书代理状态">
      <div class="mclp-header-main">
        <div class="mclp-title-group">
          <div class="mclp-title">多聊天世界书代理</div>
          <div class="mclp-subtitle">把多本来源聊天世界书聚合到当前聊天。</div>
        </div>
        <div class="mclp-header-actions">
          <div class="mclp-mini-badge">已接入 ${snapshot.sourceCount} 本</div>
          <button class="mclp-icon-button" type="button" data-action="open-tutorial" title="查看接入说明与命名规则" aria-label="查看接入说明与命名规则">?</button>
        </div>
      </div>
      <div class="mclp-status-line ${bindingStatus.ok ? 'mclp-status-line--good' : 'mclp-status-line--warn'}">
        <div class="mclp-status-main">
          <span class="mclp-status-icon" aria-hidden="true">${statusIcon}</span>
          <div>
            <div class="mclp-status-value">${bindingStatus.label}</div>
            <div class="mclp-status-detail">${bindingStatus.ok ? '多本来源书会合并生效。' : bindingStatus.detail}</div>
          </div>
        </div>
        ${bindingStatus.actionLabel
      ? `<div class="mclp-status-action"><button class="mclp-button mclp-button--primary" type="button" data-action="repair-binding">${bindingStatus.actionLabel}</button></div>`
      : ''}
      </div>
    </section>
  `;
}

function renderSourceListHtml(snapshot) {
  const sources = snapshot.proxyState?.sources ?? [];
  if (!sources.length) {
    return '<div class="mclp-empty">当前还没有添加任何来源聊天世界书。你可以在上面的输入框中直接输入，也可以在候选列表里点击添加。</div>';
  }

  return `
    <div class="mclp-source-list">
      ${sources.map((name) => `
        <div class="mclp-item">
          <div class="mclp-item-main">
            <div class="mclp-item-name">${escapeHtml(name)}</div>
            <div class="mclp-meta-row">
              <span class="mclp-tag mclp-tag--accent">来源书</span>
            </div>
          </div>
          <button class="mclp-action-button mclp-action-button--danger" type="button" data-action="remove-source" data-name="${escapeHtml(name)}" title="移除" aria-label="移除来源聊天世界书 ${escapeHtml(name)}">×</button>
        </div>
      `).join('')}
    </div>
  `;
}

function renderBlacklistHtml(blacklistKeywords) {
  const list = normalizeKeywordList(blacklistKeywords);
  if (!list.length) {
    return '<div class="mclp-empty">当前没有额外黑名单关键字。黑名单会同时匹配“聊天世界书名称”和“世界书条目名/关键词”。</div>';
  }

  return `
    <div class="mclp-chip-row">
      ${list.map((keyword) => `
        <span class="mclp-blacklist-chip">
          <span>${escapeHtml(keyword)}</span>
          <button class="mclp-chip-remove" type="button" data-action="remove-blacklist" data-keyword="${escapeHtml(keyword)}" aria-label="移除黑名单关键字 ${escapeHtml(keyword)}">×</button>
        </span>
      `).join('')}
    </div>
  `;
}

function renderCandidateListHtml(records) {
  if (!records.length) {
    return '<div class="mclp-empty">没有符合当前搜索、过滤与黑名单条件的聊天世界书。</div>';
  }

  return `
    <div class="mclp-candidate-list">
      ${records.map((record) => `
        <div class="mclp-item">
          <div class="mclp-item-main">
            <div class="mclp-item-name">${escapeHtml(record.name)}</div>
            <div class="mclp-meta-row">
              <span class="mclp-tag">条目 ${record.entryCount}</span>
              ${record.isInternal ? '<span class="mclp-tag mclp-tag--mute">代理内部书</span>' : ''}
              ${record.isUsed ? '<span class="mclp-tag mclp-tag--ok">已添加</span>' : ''}
            </div>
          </div>
          <button class="mclp-action-button ${record.isUsed ? 'mclp-button--ghost' : 'mclp-action-button--primary'}" type="button" ${record.isUsed ? 'disabled' : ''} data-action="quick-add-source" data-name="${escapeHtml(record.name)}" title="${record.isUsed ? '已添加' : '添加'}" aria-label="${record.isUsed ? '已添加' : '添加'}聊天世界书 ${escapeHtml(record.name)}">
            ${record.isUsed ? '✓' : '+'}
          </button>
        </div>
      `).join('')}
    </div>
  `;
}

async function promptAddSourceWorldbook() {
  await showStatusPopup();
  return null;
}

async function removeSourceWorldbook(name) {
  const sourceName = normalizeSourceName(name);
  if (!sourceName) {
    return false;
  }

  const proxyState = await ensureProxyReady();
  if (!proxyState) {
    errorToast('当前没有可操作的聊天代理状态');
    return false;
  }

  if (!proxyState.sources.includes(sourceName)) {
    infoToast(`来源聊天世界书不在当前列表中: ${sourceName}`);
    return false;
  }

  proxyState.sources = proxyState.sources.filter((item) => item !== sourceName);
  if (proxyState.scriptBinding === sourceName) {
    proxyState.scriptBinding = proxyState.sources.at(-1) ?? null;
  }
  await saveProxyState(proxyState);
  log(`已移除来源聊天世界书: ${sourceName}`);
  await runSync(`remove:${sourceName}`);
  refreshMenuButton();
  return true;
}

function createStatusPanel() {
  ensureStyles();

  const root = $('<div class="mclp-panel"></div>');
  const uiSettings = loadUiSettings();
  let searchText = '';
  let blacklistDraft = '';
  let candidateRequestId = 0;

  const syncSettings = () => {
    saveUiSettings(uiSettings);
  };

  const focusInput = (selector) => {
    const input = root.find(selector);
    if (input.length) {
      input.trigger('focus');
    }
  };

  const render = () => {
    const snapshot = getStatusSnapshot();
    root.html(`
      <div class="mclp-shell">
        ${renderStatusHtml(snapshot)}

        <div class="mclp-pane">
          <section class="mclp-section mclp-section--compact">
            <div class="mclp-section-head">
              <div>
                <div class="mclp-section-title">已接入</div>
                <div class="mclp-section-desc">当前 ${snapshot.sourceCount} 本。</div>
              </div>
            </div>
            ${renderSourceListHtml(snapshot)}
          </section>

          <section class="mclp-section mclp-section--compact">
            <div class="mclp-section-head">
              <div>
                <div class="mclp-section-title">查找并添加</div>
                <div class="mclp-section-desc">搜索已有书；输入完整书名后也可直接添加。</div>
              </div>
              <button class="mclp-action-button" type="button" data-action="resync" title="同步" aria-label="同步来源世界书">↻</button>
            </div>
            <div class="mclp-row">
              <input
                id="mclp_candidate_search"
                class="mclp-input"
                type="text"
                placeholder="搜索或输入聊天世界书名称"
                value="${escapeHtml(searchText)}"
              >
              <button class="mclp-button mclp-button--primary" type="button" data-action="add-search-value">添加</button>
            </div>
            <div class="mclp-control-grid" style="margin-top:8px;">
              <select id="mclp_sort_mode" class="mclp-select">
                <option value="name_asc" ${uiSettings.sortMode === 'name_asc' ? 'selected' : ''}>名称 A → Z</option>
                <option value="name_desc" ${uiSettings.sortMode === 'name_desc' ? 'selected' : ''}>名称 Z → A</option>
                <option value="entries_desc" ${uiSettings.sortMode === 'entries_desc' ? 'selected' : ''}>条目数从多到少</option>
                <option value="unused_first" ${uiSettings.sortMode === 'unused_first' ? 'selected' : ''}>未添加优先</option>
              </select>
            </div>
            <div class="mclp-toggle-row" style="margin-top:8px;">
              <label class="mclp-toggle"><input id="mclp_hide_added" type="checkbox" ${uiSettings.hideAdded ? 'checked' : ''}>隐藏已添加</label>
              <label class="mclp-toggle"><input id="mclp_hide_internal" type="checkbox" ${uiSettings.hideInternal ? 'checked' : ''}>隐藏内部书</label>
            </div>
            <div id="mclp_candidate_summary" class="mclp-summary">正在读取聊天世界书列表…</div>
            <div id="mclp_candidate_list_wrapper" style="margin-top:8px;">
              <div class="mclp-empty">正在读取聊天世界书列表…</div>
            </div>
            <details class="mclp-details">
              <summary>黑名单</summary>
              <div class="mclp-row" style="margin-top:8px;">
                <input
                  id="mclp_blacklist_input"
                  class="mclp-input"
                  type="text"
                  placeholder="例如：__mclp__ / 角色设定"
                  value="${escapeHtml(blacklistDraft)}"
                >
                <button class="mclp-button mclp-button--secondary" type="button" data-action="add-blacklist">加入</button>
              </div>
              <div style="margin-top:8px;">${renderBlacklistHtml(uiSettings.blacklistKeywords)}</div>
            </details>
          </section>
        </div>
      </div>
    `);
  };

  const refreshCandidateList = async () => {
    const requestId = ++candidateRequestId;
    const listWrapper = root.find('#mclp_candidate_list_wrapper');
    const summary = root.find('#mclp_candidate_summary');
    if (!listWrapper.length || !summary.length) {
      return;
    }

    listWrapper.html('<div class="mclp-empty">正在扫描聊天世界书与条目名…</div>');
    summary.text('正在扫描聊天世界书与条目名…');

    const snapshot = getStatusSnapshot();
    const currentSources = new Set(snapshot.proxyState?.sources ?? []);
    const allNames = getAvailableWorldbookNames().filter((name) => name !== snapshot.proxyState?.anchor);

    const allRecords = await Promise.all(allNames.map(async (name) => {
      const scan = await getWorldbookScan(name);
      return {
        name,
        isUsed: currentSources.has(name),
        isInternal: name.startsWith('__mclp__'),
        entryCount: scan.entryCount,
        entrySearchText: scan.entrySearchText,
        blockedKeyword: getMatchedBlacklistKeyword(name, scan.entrySearchText, uiSettings.blacklistKeywords),
      };
    }));

    if (requestId !== candidateRequestId) {
      return;
    }

    const lowerSearch = searchText.trim().toLowerCase();
    const counters = {
      total: allRecords.length,
      hiddenByBlacklist: 0,
      hiddenByInternal: 0,
      hiddenByAdded: 0,
      hiddenBySearch: 0,
    };

    const visibleRecords = allRecords.filter((record) => {
      if (record.blockedKeyword) {
        counters.hiddenByBlacklist += 1;
        return false;
      }

      if (uiSettings.hideInternal && record.isInternal) {
        counters.hiddenByInternal += 1;
        return false;
      }

      if (uiSettings.hideAdded && record.isUsed) {
        counters.hiddenByAdded += 1;
        return false;
      }

      if (lowerSearch) {
        const matchesSearch = record.name.toLowerCase().includes(lowerSearch)
          || record.entrySearchText.includes(lowerSearch);
        if (!matchesSearch) {
          counters.hiddenBySearch += 1;
          return false;
        }
      }

      return true;
    });

    const sortedRecords = sortCandidateRecords(visibleRecords, uiSettings.sortMode);
    summary.html(`
      共检测到 <strong>${counters.total}</strong> 本聊天世界书，当前展示 <strong>${sortedRecords.length}</strong> 本。
      已隐藏：黑名单 ${counters.hiddenByBlacklist} / 代理内部书 ${counters.hiddenByInternal} / 已添加 ${counters.hiddenByAdded} / 搜索过滤 ${counters.hiddenBySearch}
    `);
    listWrapper.html(renderCandidateListHtml(sortedRecords));
  };

  const rerenderAndRefresh = async () => {
    render();
    await refreshCandidateList();
  };

  const addFromValue = async (rawValue, reason = 'manual_input') => {
    const sourceName = normalizeSourceName(rawValue);
    if (!sourceName) {
      infoToast('请输入要添加的聊天世界书名称');
      focusInput('#mclp_candidate_search');
      return null;
    }

    log(`状态面板：添加来源聊天世界书 ${sourceName} (${reason})`);
    const added = await addSourceWorldbook(sourceName);
    if (added) {
      searchText = '';
      successToast(`已添加来源聊天世界书：${sourceName}`);
      await rerenderAndRefresh();
      focusInput('#mclp_candidate_search');
    }
    return added;
  };

  const addBlacklistKeyword = async (rawKeyword) => {
    const keyword = normalizeSourceName(rawKeyword);
    if (!keyword) {
      infoToast('请输入黑名单关键字');
      focusInput('#mclp_blacklist_input');
      return;
    }

    if (uiSettings.blacklistKeywords.includes(keyword)) {
      infoToast(`黑名单已存在：${keyword}`);
      return;
    }

    uiSettings.blacklistKeywords = normalizeKeywordList([...uiSettings.blacklistKeywords, keyword]);
    blacklistDraft = '';
    syncSettings();
    successToast(`已加入黑名单：${keyword}`);
    await rerenderAndRefresh();
    focusInput('#mclp_blacklist_input');
  };

  root.on('input', '#mclp_candidate_search', async (event) => {
    searchText = String($(event.currentTarget).val() ?? '');
    await refreshCandidateList();
  });

  root.on('keydown', '#mclp_candidate_search', async (event) => {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    try {
      await addFromValue($(event.currentTarget).val(), 'search_enter_key');
    } catch (panelError) {
      error(`状态面板搜索框添加失败\n${formatError(panelError)}`);
      errorToast('添加聊天世界书失败，请查看控制台');
    }
  });

  root.on('click', '[data-action="add-search-value"]', async () => {
    try {
      await addFromValue(root.find('#mclp_candidate_search').val(), 'search_add_button');
    } catch (panelError) {
      error(`状态面板搜索框按钮添加失败\n${formatError(panelError)}`);
      errorToast('添加聊天世界书失败，请查看控制台');
    }
  });

  root.on('change', '#mclp_sort_mode', async (event) => {
    uiSettings.sortMode = String($(event.currentTarget).val() ?? DEFAULT_UI_SETTINGS.sortMode);
    syncSettings();
    await refreshCandidateList();
  });

  root.on('change', '#mclp_hide_added', async (event) => {
    uiSettings.hideAdded = Boolean($(event.currentTarget).prop('checked'));
    syncSettings();
    await refreshCandidateList();
  });

  root.on('change', '#mclp_hide_internal', async (event) => {
    uiSettings.hideInternal = Boolean($(event.currentTarget).prop('checked'));
    syncSettings();
    await refreshCandidateList();
  });

  root.on('input', '#mclp_blacklist_input', (event) => {
    blacklistDraft = String($(event.currentTarget).val() ?? '');
  });

  root.on('keydown', '#mclp_blacklist_input', async (event) => {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    try {
      await addBlacklistKeyword($(event.currentTarget).val());
    } catch (panelError) {
      error(`状态面板加入黑名单失败\n${formatError(panelError)}`);
      errorToast('加入黑名单失败，请查看控制台');
    }
  });

  root.on('click', '[data-action="add-blacklist"]', async () => {
    try {
      await addBlacklistKeyword(root.find('#mclp_blacklist_input').val());
    } catch (panelError) {
      error(`状态面板点击加入黑名单失败\n${formatError(panelError)}`);
      errorToast('加入黑名单失败，请查看控制台');
    }
  });

  root.on('click', '[data-action="remove-blacklist"]', async (event) => {
    const keyword = normalizeSourceName($(event.currentTarget).attr('data-keyword'));
    if (!keyword) {
      return;
    }

    uiSettings.blacklistKeywords = uiSettings.blacklistKeywords.filter((item) => item !== keyword);
    syncSettings();
    infoToast(`已移除黑名单：${keyword}`);
    await rerenderAndRefresh();
  });

  root.on('click', '[data-action="quick-add-source"]', async (event) => {
    const sourceName = normalizeSourceName($(event.currentTarget).attr('data-name'));
    if (!sourceName) {
      return;
    }

    try {
      await addFromValue(sourceName, 'candidate_list');
    } catch (panelError) {
      error(`状态面板候选列表添加失败\n${formatError(panelError)}`);
      errorToast('点击候选项添加聊天世界书失败，请查看控制台');
    }
  });

  root.on('click', '[data-action="remove-source"]', async (event) => {
    const sourceName = normalizeSourceName($(event.currentTarget).attr('data-name'));
    if (!sourceName) {
      return;
    }

    try {
      log(`状态面板：移除来源聊天世界书 ${sourceName}`);
      const removed = await removeSourceWorldbook(sourceName);
      if (removed) {
        successToast(`已移除来源聊天世界书：${sourceName}`);
        await rerenderAndRefresh();
      }
    } catch (panelError) {
      error(`状态面板移除来源聊天世界书失败\n${formatError(panelError)}`);
      errorToast('移除聊天世界书失败，请查看控制台');
    }
  });

  root.on('click', '[data-action="resync"]', async () => {
    try {
      log('状态面板：手动触发锚点聊天世界书同步');
      await runSync('popup_manual_resync');
      successToast('已完成锚点聊天世界书同步');
      await rerenderAndRefresh();
    } catch (panelError) {
      error(`状态面板手动同步失败\n${formatError(panelError)}`);
      errorToast('手动同步失败，请查看控制台');
    }
  });

  root.on('click', '[data-action="repair-binding"]', async () => {
    try {
      log('状态面板：手动修复聊天绑定');
      const proxyState = await ensureProxyReady();
      if (!proxyState?.anchor) {
        infoToast('当前没有可修复的代理锚点');
        return;
      }
      await bindChatMetadataTo(proxyState.anchor);
      await runSync('popup_repair_binding');
      successToast('已重新绑定代理聊天世界书');
      await rerenderAndRefresh();
    } catch (panelError) {
      error(`状态面板修复绑定失败\n${formatError(panelError)}`);
      errorToast('修复绑定失败，请查看控制台');
    }
  });

  root.on('click', '[data-action="open-tutorial"]', async () => {
    try {
      log('状态面板：打开说明面板');
      await showTutorialPopup();
    } catch (panelError) {
      error(`状态面板打开说明失败\n${formatError(panelError)}`);
      errorToast('打开说明失败，请查看控制台');
    }
  });

  render();
  void refreshCandidateList();
  return { root, render: rerenderAndRefresh };
}

async function showStatusPopup() {
  log('打开状态面板');
  state.popupOpen = true;
  const panel = createStatusPanel();
  try {
    await callGenericPopup(panel.root, POPUP_TYPE.TEXT, '', {
      okButton: '关闭',
      wide: globalThis.matchMedia?.('(min-width: 720px)')?.matches ?? true,
      allowVerticalScrolling: true,
    });
  } catch (popupError) {
    error(`打开状态面板失败\n${formatError(popupError)}`);
    errorToast('打开状态面板失败，请查看控制台');
  } finally {
    state.popupOpen = false;
  }
}

function stopMenuButtonWatcher() {
  if (state.menuRetryTimer) {
    clearInterval(state.menuRetryTimer);
    state.menuRetryTimer = null;
  }
}

function ensureMenuButtonWatcher(reason = 'unknown') {
  if (state.menuButton?.length || state.menuRetryTimer) {
    return;
  }

  log(`扩展菜单尚未就绪，开始轮询挂载按钮 (${reason})`);
  state.menuRetryTimer = setInterval(() => {
    const button = ensureMenuButton(`watch:${reason}`);
    if (button?.length) {
      stopMenuButtonWatcher();
      refreshMenuButton();
    }
  }, 1000);
}

function ensureMenuButton(reason = 'unknown') {
  if (state.menuButton?.length) {
    return state.menuButton;
  }

  const existing = $('#mclp_status_button');
  if (existing.length) {
    state.menuButton = existing;
    return existing;
  }

  const host = $('#extensionsMenu');
  if (!host.length) {
    const now = Date.now();
    if ((now - state.lastMenuMissLoggedAt) > 3000) {
      state.lastMenuMissLoggedAt = now;
      warn(`找不到 #extensionsMenu，暂时无法注入按钮 (${reason})`);
    }
    return null;
  }

  const button = $(`
    <div id="mclp_status_button" class="list-group-item">
      <div style="display:flex; align-items:center; gap:8px; width:100%;">
        <div class="fa-solid ${MENU_ICON_CLASS} extensionsMenuExtensionButton" title="多聊天世界书代理"></div>
        <span style="flex:1 1 auto; min-width:0;">多聊天世界书代理</span>
        <span id="mclp_status_badge" style="display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px; padding:0 7px; border-radius:999px; background:rgba(123,92,255,.18); color:var(--SmartThemeBodyColor,#fff); font-size:12px; font-weight:700; margin-left:auto;">0</span>
      </div>
    </div>
  `);

  button.on('click', async () => {
    await showStatusPopup();
  });

  host.append(button);
  state.menuButton = button;
  log(`已注入扩展菜单按钮 (${reason})`);
  stopMenuButtonWatcher();
  return button;
}

function refreshMenuButton() {
  const button = ensureMenuButton('refresh');
  if (!button?.length) {
    ensureMenuButtonWatcher('refresh');
    return;
  }

  const snapshot = getStatusSnapshot();
  const badge = button.find('#mclp_status_badge');
  const icon = button.find('.extensionsMenuExtensionButton');
  badge.text(String(snapshot.sourceCount));
  badge.css('display', snapshot.sourceCount > 0 ? 'inline-flex' : 'none');

  const active = Boolean(snapshot.proxyState?.anchor);
  icon.removeClass('fa-books').addClass(MENU_ICON_CLASS);
  icon.css('color', active ? 'var(--SmartThemeQuoteColor)' : '');
  button.attr(
    'title',
    active
      ? `锚点聊天世界书：${snapshot.proxyState.anchor} ｜ 来源数量：${snapshot.sourceCount}`
      : '多聊天世界书代理尚未初始化',
  );
}

function exposeDebugApi() {
  globalThis.MultiChatLoreProxy = {
    getStatus: () => getStatusSnapshot(),
    showStatus: () => showStatusPopup(),
    resync: () => runSync('manual'),
    addSource: (name) => addSourceWorldbook(name),
    removeSource: (name) => removeSourceWorldbook(name),
    repairBinding: (reason = 'debug_api') => repairBindingIfNeeded(reason),
    getScriptFacingBinding: () => getScriptFacingBinding(),
    promptAddSource: () => promptAddSourceWorldbook(),
  };
  log('已暴露调试 API: window.MultiChatLoreProxy');
}

async function runSync(reason = 'unknown') {
  if (state.syncPromise) {
    log(`同步进行中，已排队新的同步请求: ${reason}`);
    state.syncQueued = true;
    return state.syncPromise;
  }

  log(`开始同步: ${reason}`);
  state.syncPromise = (async () => {
    try {
      const proxyState = await syncAnchorWorldbook();
      refreshMenuButton();
      log(`同步结束: ${reason}`, proxyState);
      return proxyState;
    } catch (syncError) {
      error(`同步失败: ${reason}\n${formatError(syncError)}`);
      errorToast(`同步失败: ${reason}`);
      throw syncError;
    } finally {
      state.syncPromise = null;
      if (state.syncQueued) {
        state.syncQueued = false;
        scheduleSync(`queued:${reason}`, 0);
      }
    }
  })();

  return state.syncPromise;
}

function scheduleSync(reason = 'unknown', delay = SYNC_DELAY_MS) {
  log(`计划同步: ${reason}, delay=${delay}ms`);
  if (state.syncTimer) {
    clearTimeout(state.syncTimer);
  }
  state.syncTimer = setTimeout(() => {
    state.syncTimer = null;
    void runSync(reason).catch((syncError) => {
      error(`计划同步执行失败\n${formatError(syncError)}`);
    });
  }, delay);
}

async function addSourceWorldbook(name) {
  const sourceName = normalizeSourceName(name);
  if (!sourceName) {
    return null;
  }

  const proxyState = await ensureProxyReady();
  if (!proxyState) {
    errorToast('当前没有可操作的聊天，无法添加来源聊天世界书');
    return null;
  }

  if (sourceName === proxyState.anchor) {
    infoToast('该聊天世界书已经是当前锚点书');
    return sourceName;
  }

  await ensureWorldbookExists(sourceName);

  if (!proxyState.sources.includes(sourceName)) {
    log(`添加来源聊天世界书: ${sourceName}`);
    proxyState.sources.push(sourceName);
  } else {
    log(`来源聊天世界书已存在于列表中: ${sourceName}`);
  }
  proxyState.scriptBinding = sourceName;
  await saveProxyState(proxyState);

  await bindChatMetadataTo(proxyState.anchor);
  await runSync(`add:${sourceName}`);
  refreshMenuButton();
  return sourceName;
}

async function clearProxyForCurrentChat() {
  if (!hasActiveChat()) {
    warn('clearProxyForCurrentChat 跳过：当前没有活动聊天');
    return;
  }

  log('清空当前聊天的代理状态');
  await saveProxyState(null);
  await bindChatMetadataTo(null);
  refreshMenuButton();
}

async function getProxyAnchor() {
  const proxyState = await ensureProxyReady();
  return proxyState?.anchor ?? null;
}

function isBookUsedByCurrentChat(name) {
  const bookName = normalizeSourceName(name);
  if (!bookName) {
    return false;
  }

  const proxyState = getProxyState();
  if (!proxyState) {
    return false;
  }

  return proxyState.anchor === bookName || proxyState.sources.includes(bookName);
}

async function unregisterDeletedSource(name) {
  const bookName = normalizeSourceName(name);
  if (!bookName) {
    return;
  }

  const proxyState = getProxyState();
  if (!proxyState) {
    return;
  }

  if (!proxyState.sources.includes(bookName) && proxyState.anchor !== bookName) {
    return;
  }

  if (proxyState.anchor === bookName) {
    warn(`锚点聊天世界书被删除，等待后续自动修复: ${bookName}`);
    scheduleSync('anchor_deleted');
    return;
  }

  log(`检测到来源聊天世界书已删除，自动移除: ${bookName}`);
  proxyState.sources = proxyState.sources.filter((sourceName) => sourceName !== bookName);
  if (proxyState.scriptBinding === bookName) {
    proxyState.scriptBinding = proxyState.sources.at(-1) ?? null;
  }
  await saveProxyState(proxyState);
  scheduleSync(`delete:${bookName}`, 0);
}

async function appendWorldbookEntriesThroughOriginal(original, worldbookName, entries, options) {
  const sourceName = normalizeSourceName(worldbookName);
  if (sourceName) {
    await ensureScriptSourceWorldbookRegistered(sourceName);
  }

  return await runWithTemporaryChatBinding(worldbookName, async () => {
    const result = await original.call(globalThis.TavernHelper, worldbookName, entries, options);
    await runSync(`create_entries:${worldbookName}`);
    return result;
  });
}

async function replaceWorldbookThroughOriginal(original, worldbookName, worldbook, options) {
  return await runWithTemporaryChatBinding(worldbookName, async () => {
    const result = await original.call(globalThis.TavernHelper, worldbookName, worldbook, options);
    await runSync(`replace:${worldbookName}`);
    return result;
  });
}

async function updateWorldbookThroughOriginal(original, worldbookName, updater, options) {
  return await runWithTemporaryChatBinding(worldbookName, async () => {
    const result = await original.call(globalThis.TavernHelper, worldbookName, updater, options);
    await runSync(`update:${worldbookName}`);
    return result;
  });
}

function patchMethod(target, key, factory) {
  const original = target?.[key];
  if (typeof original !== 'function') {
    return false;
  }

  if (original.__mclp_patched__) {
    return true;
  }

  const patched = factory(original);
  patched.__mclp_patched__ = true;
  patched.__mclp_original__ = original;
  target[key] = patched;
  return true;
}

function patchGlobalAlias(name, handler) {
  if (typeof globalThis[name] === 'function') {
    globalThis[name] = handler;
  }
}

async function ensureScriptSourceWorldbookRegistered(name) {
  const sourceName = normalizeSourceName(name);
  if (!sourceName) {
    return null;
  }

  const helper = globalThis.TavernHelper;
  if (typeof helper?.createWorldbook === 'function') {
    try {
      await helper.createWorldbook(sourceName, []);
    } catch (createError) {
      warn(`通过 TavernHelper 注册源书失败，将回退内部创建: ${sourceName}\n${formatError(createError)}`);
    }
  }

  await ensureWorldbookExists(sourceName);
  return sourceName;
}

async function getOrCreateScriptSourceWorldbook(requestedName = null) {
  const normalized = normalizeSourceName(requestedName);
  if (normalized) {
    await ensureScriptSourceWorldbookRegistered(normalized);
    await addSourceWorldbook(normalized);
    return normalized;
  }

  const existing = getScriptFacingBinding();
  if (existing) {
    await ensureWorldbookExists(existing);
    return existing;
  }

  const chatId = getChatId();
  if (!chatId) {
    return null;
  }

  const sourceName = buildDefaultScriptSourceName(chatId);
  await ensureScriptSourceWorldbookRegistered(sourceName);
  await addSourceWorldbook(sourceName);
  return sourceName;
}

function installTavernHelperPatch() {
  const helper = globalThis.TavernHelper;
  if (!helper || state.patched) {
    return Boolean(helper);
  }

  const patchResults = {
    getChatWorldbookName: patchMethod(helper, 'getChatWorldbookName', (_original) => {
      return function patchedGetChatWorldbookName(chatName = 'current') {
        if (chatName !== 'current' || !hasActiveChat()) {
          return null;
        }

        return getScriptFacingBinding();
      };
    }),
    rebindChatWorldbook: patchMethod(helper, 'rebindChatWorldbook', (_original) => {
      return async function patchedRebindChatWorldbook(chatName = 'current', worldbookName) {
        if (chatName !== 'current' || !hasActiveChat()) {
          return;
        }

        const normalized = normalizeSourceName(worldbookName);
        if (!normalized) {
          await clearProxyForCurrentChat();
          return;
        }

        await addSourceWorldbook(normalized);
      };
    }),
    getOrCreateChatWorldbook: patchMethod(helper, 'getOrCreateChatWorldbook', (_original) => {
      return async function patchedGetOrCreateChatWorldbook(chatName = 'current', worldbookName) {
        if (chatName !== 'current' || !hasActiveChat()) {
          return null;
        }

        return await getOrCreateScriptSourceWorldbook(worldbookName);
      };
    }),
    getChatLorebook: patchMethod(helper, 'getChatLorebook', (_original) => {
      return function patchedGetChatLorebook() {
        return getScriptFacingBinding();
      };
    }),
    setChatLorebook: patchMethod(helper, 'setChatLorebook', (_original) => {
      return async function patchedSetChatLorebook(lorebookName) {
        const normalized = normalizeSourceName(lorebookName);
        if (!normalized) {
          await clearProxyForCurrentChat();
          return;
        }

        await addSourceWorldbook(normalized);
      };
    }),
    getOrCreateChatLorebook: patchMethod(helper, 'getOrCreateChatLorebook', (_original) => {
      return async function patchedGetOrCreateChatLorebook(lorebookName) {
        return await getOrCreateScriptSourceWorldbook(lorebookName);
      };
    }),
    createWorldbookEntries: patchMethod(helper, 'createWorldbookEntries', (original) => {
      return async function patchedCreateWorldbookEntries(worldbookName, entries, options) {
        return await appendWorldbookEntriesThroughOriginal(original, worldbookName, entries, options);
      };
    }),
    replaceWorldbook: patchMethod(helper, 'replaceWorldbook', (original) => {
      return async function patchedReplaceWorldbook(worldbookName, worldbook, options) {
        return await replaceWorldbookThroughOriginal(original, worldbookName, worldbook, options);
      };
    }),
    updateWorldbookWith: patchMethod(helper, 'updateWorldbookWith', (original) => {
      return async function patchedUpdateWorldbookWith(worldbookName, updater, options) {
        return await updateWorldbookThroughOriginal(original, worldbookName, updater, options);
      };
    }),
    deleteWorldbookEntries: patchMethod(helper, 'deleteWorldbookEntries', (original) => {
      return async function patchedDeleteWorldbookEntries(worldbookName, predicate, options) {
        return await runWithTemporaryChatBinding(worldbookName, async () => {
          const result = await original.call(this, worldbookName, predicate, options);
          await runSync(`delete_entries:${worldbookName}`);
          return result;
        });
      };
    }),
    deleteWorldbook: patchMethod(helper, 'deleteWorldbook', (original) => {
      return async function patchedDeleteWorldbook(name) {
        const result = await original.call(this, name);
        if (result !== false) {
          await unregisterDeletedSource(name);
        }
        return result;
      };
    }),
  };

  patchGlobalAlias('getChatWorldbookName', helper.getChatWorldbookName);
  patchGlobalAlias('rebindChatWorldbook', helper.rebindChatWorldbook);
  patchGlobalAlias('getOrCreateChatWorldbook', helper.getOrCreateChatWorldbook);
  patchGlobalAlias('getChatLorebook', helper.getChatLorebook);
  patchGlobalAlias('setChatLorebook', helper.setChatLorebook);
  patchGlobalAlias('getOrCreateChatLorebook', helper.getOrCreateChatLorebook);
  patchGlobalAlias('createWorldbookEntries', helper.createWorldbookEntries);
  patchGlobalAlias('replaceWorldbook', helper.replaceWorldbook);
  patchGlobalAlias('updateWorldbookWith', helper.updateWorldbookWith);
  patchGlobalAlias('deleteWorldbookEntries', helper.deleteWorldbookEntries);

  state.patched = true;
  const patchedCount = Object.values(patchResults).filter(Boolean).length;
  if (patchedCount > 0) {
    log('已挂接 TavernHelper 聊天世界书兼容层', patchResults);
  } else {
    warn('检测到 TavernHelper，但没有找到可挂接的方法', helper);
  }
  refreshMenuButton();
  return true;
}

function startTavernHelperPatchWatcher() {
  if (state.helperPatchTimer) {
    return;
  }

  log('开始持续守护 TavernHelper 兼容层');
  state.helperPatchTimer = setInterval(() => {
    if (!globalThis.TavernHelper) {
      return;
    }

    if (state.patched) {
      const helper = globalThis.TavernHelper;
      const watchedNames = [
        'getChatWorldbookName',
        'rebindChatWorldbook',
        'getOrCreateChatWorldbook',
        'getChatLorebook',
        'setChatLorebook',
        'getOrCreateChatLorebook',
        'createWorldbookEntries',
        'replaceWorldbook',
        'updateWorldbookWith',
        'deleteWorldbookEntries',
        'deleteWorldbook',
      ];
      const overwritten = watchedNames.some((name) => typeof helper[name] === 'function' && !helper[name].__mclp_patched__);
      if (overwritten) {
        warn('检测到 TavernHelper 聊天世界书接口被后加载脚本覆盖，重新挂接兼容层');
        state.patched = false;
      }
    }

    installTavernHelperPatch();
  }, 1000);
}

async function waitForTavernHelper() {
  log('开始等待 TavernHelper 兼容层');
  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
    if (installTavernHelperPatch()) {
      log('TavernHelper 兼容层挂接完成');
      startTavernHelperPatchWatcher();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  warn('等待 TavernHelper 超时，扩展仍会保留聊天聚合同步逻辑，但不会拦截脚本接口');
  infoToast('未检测到 TavernHelper；扩展仍可通过状态面板手动管理多本聊天世界书');
  startTavernHelperPatchWatcher();
  return false;
}

function startBindingGuard() {
  if (state.bindingGuardTimer) {
    return;
  }

  log('启动聊天世界书绑定守卫');
  state.bindingGuardTimer = setInterval(() => {
    void repairBindingIfNeeded('poll').catch((guardError) => {
      error(`绑定守卫修复失败\n${formatError(guardError)}`);
    });
  }, 1200);
}

function bindEvents() {
  log('开始绑定事件监听');

  eventSource.on(event_types.CHAT_CHANGED, async () => {
    log(`收到 CHAT_CHANGED 事件，当前 chat=${getChatId()}`);
    if (!hasActiveChat()) {
      warn('CHAT_CHANGED 后仍未检测到活动聊天');
      return;
    }

    try {
      await ensureProxyReady();
      refreshMenuButton();
      void repairBindingIfNeeded('chat_changed').catch((guardError) => {
        error(`聊天切换后绑定守卫修复失败\n${formatError(guardError)}`);
      });
      scheduleSync('chat_changed', 0);
    } catch (eventError) {
      error(`切换聊天后初始化失败\n${formatError(eventError)}`);
      errorToast('切换聊天后初始化失败，请查看控制台');
    }
  });

  eventSource.on(event_types.WORLDINFO_UPDATED, async (name) => {
    const bookName = normalizeSourceName(name);
    if (!bookName) {
      return;
    }

    log(`收到 WORLDINFO_UPDATED 事件: ${bookName}`);
    state.worldbookScanCache.delete(bookName);
    if (state.internalSaves.has(bookName)) {
      log(`忽略内部保存触发的 WORLDINFO_UPDATED: ${bookName}`);
      return;
    }

    if (isBookUsedByCurrentChat(bookName)) {
      refreshMenuButton();
      scheduleSync(`worldinfo_updated:${bookName}`);
    }
  });
}

async function bootstrap() {
  if (state.started) {
    log('bootstrap 已执行过，跳过重复启动');
    return;
  }
  state.started = true;

  log('bootstrap 开始');
  ensureMenuButton('bootstrap');
  ensureMenuButtonWatcher('bootstrap');
  exposeDebugApi();
  bindEvents();
  startBindingGuard();
  void waitForTavernHelper().catch((helperError) => {
    error(`等待 TavernHelper 时发生异常\n${formatError(helperError)}`);
    errorToast('等待 TavernHelper 时发生异常，请查看控制台');
  });

  if (hasActiveChat()) {
    try {
      log(`启动时检测到活动聊天: ${getChatId()}`);
      await ensureProxyReady();
      refreshMenuButton();
      scheduleSync('bootstrap', 0);
    } catch (bootstrapError) {
      error(`bootstrap 初始化聊天代理失败\n${formatError(bootstrapError)}`);
      errorToast('启动时初始化聊天代理失败，请查看控制台');
    }
  } else {
    warn('启动时未检测到活动聊天');
  }

  successToast('已加载。可在扩展菜单中打开状态面板，并手动管理来源聊天世界书。');
  log('bootstrap 完成');
}

log('模块已加载，准备启动 bootstrap');
void bootstrap().catch((bootstrapError) => {
  error(`bootstrap 崩溃\n${formatError(bootstrapError)}`);
  errorToast('扩展启动失败，请打开控制台查看错误');
});
