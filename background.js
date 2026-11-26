/**
 * background.js
 * Registers the "Fill password (TrueGen)" right-click context menu entry;
 * generates passwords on request from content.js's quick-fill panel; and
 * is the single source of truth for settings persistence + the Type 6
 * category list, both of which live in lib/core.js.
 *
 * Uses lib/core.js, loaded first via manifest.json's background.scripts
 * array, so generatePassword()/migrateSettings()/DEFAULT_SETTINGS/
 * SETTINGS_KEY/TYPE6_CATEGORIES are already defined as plain identifiers
 * by the time this file runs (classic <script>-style loading puts every
 * background.scripts entry in one shared global scope — unlike a content
 * script's isolated world, there is no cross-file access problem here).
 *
 * content.js (the quick-fill panel, which DOES run in an isolated world
 * and can't reach core.js's globals) asks for settings and categories via
 * the truegen-get-settings / truegen-save-settings / truegen-get-categories
 * messages below, instead of keeping its own duplicate copy of any of
 * this. popup.js, by contrast, loads lib/core.js directly (same trick as
 * this file) and doesn't need the message round trip.
 */

"use strict";

browser.contextMenus.create({
  id: "truegen-fill",
  title: browser.i18n.getMessage("contextMenuTitle") || "Fill password (TrueGen)",
  contexts: ["editable"],
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "truegen-fill" || !tab || tab.id == null) return;
  const opts = typeof info.frameId === "number" ? { frameId: info.frameId } : undefined;
  browser.tabs.sendMessage(tab.id, { type: "truegen-open-panel" }, opts).catch(() => {
    // Content script may not be present on this page (e.g. about: or
    // add-on store pages, where extensions can't run) — nothing to do.
  });
});

// --- Secret menu hotkey (distributed-password reconstruction) ----------
// See manifest.json's "commands" entry — user-rebindable via
// about:addons' "Manage Extension Shortcuts". Just relays to the active
// tab's content script, same pattern as the context-menu entry above.
browser.commands.onCommand.addListener((command) => {
  if (command !== "truegen-secret-menu") return;
  browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab || tab.id == null) return;
    browser.tabs.sendMessage(tab.id, { type: "truegen-open-secret-menu" }, { frameId: 0 }).catch(() => {
      // No content script on this page (e.g. about:, addons store) —
      // nothing to do; there's no field to fill here anyway.
    });
  });
});

// --- Settings persistence (shared with popup.js's identical logic; see
// the file comment above for why this is the copy content.js calls into
// rather than duplicating). Settings are UI preferences only — length,
// complexity, toggles, Type 6 categories/text — never a generated
// password. ---
async function loadSettings() {
  try {
    const stored = await browser.storage.local.get([SETTINGS_KEY, LEGACY_SETTINGS_KEY]);
    const raw = stored[SETTINGS_KEY] || stored[LEGACY_SETTINGS_KEY] || null;
    const migrated = migrateSettings(raw);
    if (!stored[SETTINGS_KEY] && stored[LEGACY_SETTINGS_KEY]) {
      await saveSettings(migrated);
      browser.storage.local.remove(LEGACY_SETTINGS_KEY).catch(() => {});
    }
    return migrated;
  } catch (err) {
    return { ...DEFAULT_SETTINGS };
  }
}

// --- Appearance (toolbar title/icon) reapplication -----------------------
// browserAction.setTitle/setIcon only affect the current browser session —
// on a full restart Firefox reverts to the manifest's defaults unless
// something re-applies the stored custom values. Duplicated (small,
// self-contained) from popup.js's version rather than shared, since this
// needs to run unconditionally on startup regardless of whether the user
// ever opens the popup in that session.
const DEFAULT_ICON_PATHS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png" };

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load stored icon"));
    img.src = dataUrl;
  });
}

function drawContained(img, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const iw = img.naturalWidth || img.width || size;
  const ih = img.naturalHeight || img.height || size;
  const scale = Math.min(size / iw, size / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return canvas;
}

let appearanceInFlight = null;
function reapplyStoredAppearance() {
  if (appearanceInFlight) return appearanceInFlight;
  appearanceInFlight = (async () => {
    try {
      const settings = await loadSettings();
      await browser.browserAction.setTitle({ title: settings.customTitle || null }).catch(() => {});
      if (settings.customIconDataUrl) {
        const img = await loadImageFromDataUrl(settings.customIconDataUrl);
        const imageData = {};
        for (const size of [16, 32]) {
          imageData[size] = drawContained(img, size).getContext("2d").getImageData(0, 0, size, size);
        }
        await browser.browserAction.setIcon({ imageData });
      } else {
        await browser.browserAction.setIcon({ path: DEFAULT_ICON_PATHS });
      }
    } catch (err) {
      // Cosmetic feature only — never block startup on this failing.
    } finally {
      appearanceInFlight = null;
    }
  })();
  return appearanceInFlight;
}

browser.runtime.onStartup.addListener(() => reapplyStoredAppearance());
browser.runtime.onInstalled.addListener(() => reapplyStoredAppearance());


let settingsWriteQueue = Promise.resolve();
function saveSettings(partialSettings) {
  settingsWriteQueue = settingsWriteQueue
    .catch(() => {})
    .then(async () => {
      try {
        const current = await loadSettings();
        const merged = migrateSettings({ ...current, ...(partialSettings || {}) });
        await browser.storage.local.set({ [SETTINGS_KEY]: merged });
      } catch (err) {
        // Non-fatal — generation still works even if persisting prefs fails.
      }
    });
  return settingsWriteQueue;
}

/* ===========================================================================
 * Distributed storage ("split password") — persistence + reconstruction.
 *
 * Storage layout:
 *   storage.local[SPLITS_KEY]           = { [id]: record }
 *     record = { id, label, origin, createdAt, n, k, verifyTag,
 *                local: {x,salt,iv,ciphertext} | null,
 *                manual: {x} | null,
 *                cloud: {x} | null }
 *     — no plaintext secret ever appears here, only the AES-GCM-encrypted
 *       local share (if any) and public metadata (see lib/secret-sharing.js
 *       file header for why verifyTag is safe to store).
 *   storage.sync[SPLITS_CLOUD_KEY]      = { [id]: {x, y (base64)} }
 *     — deliberately separate storage AREA (not just a separate key) from
 *       the local share: this is what makes "cloud" a materially different
 *       role from "local", not just a second copy in the same place.
 *   storage.local[SPLITS_RATELIMIT_KEY] = { [id]: {failCount, lockedUntil} }
 *     — see computeLockoutSeconds() in lib/split-vault.js. Only tracks
 *       failed passphrase attempts (the online-guessable vector); a wrong
 *       manual-share code doesn't count against this, since transcription
 *       typos aren't guessing attempts and are already checksum-caught
 *       before ever reaching here.
 *
 * popup.js creates records directly (same storage keys, written straight
 * from the privileged popup page — see its own comment on this) since it
 * doesn't need the isolated-world relay content.js does. This file is
 * what content.js's secret-menu overlay talks to for everything else:
 * listing, reconstructing, deleting.
 * ========================================================================= */

const SPLITS_KEY = "truegen-splits";
const SPLITS_CLOUD_KEY = "truegen-splits-cloud"; // legacy bundled sync key (read fallback)
const SPLITS_CLOUD_PREFIX = "truegen-split-cloud:"; // per-split sync key (avoids 8 KB per-item quota)
const SPLITS_RATELIMIT_KEY = "truegen-splits-ratelimit";

function cloudKeyFor(id) {
  return `${SPLITS_CLOUD_PREFIX}${id}`;
}

async function getCloudShareEntry(id) {
  const key = cloudKeyFor(id);
  const stored = await browser.storage.sync.get([key, SPLITS_CLOUD_KEY]).catch(() => ({}));
  if (stored[key]) return stored[key];
  const legacyAll = stored[SPLITS_CLOUD_KEY] || {};
  return legacyAll[id] || null;
}

async function getAllSplitRecords() {
  const stored = await browser.storage.local.get(SPLITS_KEY);
  return stored[SPLITS_KEY] || {};
}

async function listSplitsFor(origin, includeAllSites) {
  try {
    const all = await getAllSplitRecords();
    const validOrigin = origin && origin !== "null" ? origin : null;
    const records = Object.values(all).filter((r) => includeAllSites || (validOrigin && r.origin === validOrigin));

    // Fetch per-split cloud keys + legacy bundled map in one sync.get call.
    const cloudKeys = records.filter((r) => r.cloud).map((r) => cloudKeyFor(r.id));
    const syncLookup = cloudKeys.length > 0 ? [...cloudKeys, SPLITS_CLOUD_KEY] : [];
    const cloudStored = syncLookup.length > 0 ? await browser.storage.sync.get(syncLookup).catch(() => ({})) : {};
    const legacyCloudAll = cloudStored[SPLITS_CLOUD_KEY] || {};

    const summaries = records.map((r) => ({
      id: r.id,
      label: r.label,
      origin: r.origin,
      createdAt: r.createdAt,
      n: r.n,
      k: r.k,
      pureIT: r.pureIT === true,
      hasLocal: !!r.local,
      manualLabels: Array.isArray(r.manual) ? r.manual.map((m) => m.label) : [],
      hasCloud: !!r.cloud,
      cloudAvailable: !!r.cloud && !!(cloudStored[cloudKeyFor(r.id)] || legacyCloudAll[r.id]),
    }));
    return { ok: true, splits: summaries };
  } catch (err) {
    return { ok: true, splits: [] }; // fail soft — an empty list, not a broken menu
  }
}

let rateLimitWriteQueue = Promise.resolve();

async function getRateLimitState(id) {
  const stored = await browser.storage.local.get(SPLITS_RATELIMIT_KEY);
  const all = stored[SPLITS_RATELIMIT_KEY] || {};
  return all[id] || { failCount: 0, lockedUntil: 0 };
}

function setRateLimitState(id, state) {
  rateLimitWriteQueue = rateLimitWriteQueue
    .catch(() => {})
    .then(async () => {
      const stored = await browser.storage.local.get(SPLITS_RATELIMIT_KEY);
      const all = stored[SPLITS_RATELIMIT_KEY] || {};
      if (state === null) {
        delete all[id];
      } else {
        all[id] = state;
      }
      await browser.storage.local.set({ [SPLITS_RATELIMIT_KEY]: all });
    });
  return rateLimitWriteQueue;
}

const reconstructQueues = new Map();

function reconstructSplitById(id, inputs) {
  const prior = reconstructQueues.get(id) || Promise.resolve();
  const runResult = prior.then(
    () => reconstructSplitByIdUnsafe(id, inputs),
    () => reconstructSplitByIdUnsafe(id, inputs)
  );
  const tail = runResult.catch(() => {});
  reconstructQueues.set(id, tail);
  tail.finally(() => {
    if (reconstructQueues.get(id) === tail) {
      reconstructQueues.delete(id);
    }
  });
  return runResult;
}

async function reconstructSplitByIdUnsafe(id, inputs) {
  try {
    const all = await getAllSplitRecords();
    const record = all[id];
    if (!record) {
      return { ok: false, error: "not-found", message: "That saved split no longer exists." };
    }

    // Rate limiting only applies when a passphrase is actually being
    // tried against a local share — manual-only or cloud-only attempts
    // (no passphrase involved) skip this entirely.
    if (record.local && inputs.passphrase) {
      const state = await getRateLimitState(id);
      const now = Date.now();
      if (state.lockedUntil > now) {
        const waitSeconds = Math.ceil((state.lockedUntil - now) / 1000);
        return {
          ok: false,
          error: "rate-limited",
          message: `Too many wrong attempts — try again in ${waitSeconds}s.`,
          waitSeconds,
        };
      }
    }

    let cloudShareY;
    if (record.cloud) {
      const entry = await getCloudShareEntry(id);
      if (entry) cloudShareY = entry.y;
      // If missing (not signed into Sync, or not yet propagated to this
      // device), reconstructFromRecord below will just report it as an
      // unmet requirement rather than failing hard here.
    }

    const result = await reconstructFromRecord(record, {
      passphrase: inputs.passphrase,
      manualShareTexts: inputs.manualShareTexts,
      cloudShareY,
    });

    if (record.local && inputs.passphrase) {
      if (result.ok) {
        await setRateLimitState(id, { failCount: 0, lockedUntil: 0 });
      } else if (result.error === "wrong-passphrase") {
        const state = await getRateLimitState(id);
        const failCount = state.failCount + 1;
        const delaySeconds = computeLockoutSeconds(failCount);
        await setRateLimitState(id, { failCount, lockedUntil: Date.now() + delaySeconds * 1000 });
      }
    }

    if (!result.ok) {
      return { ok: false, error: result.error, message: result.message };
    }
    // secretBytes (a Uint8Array) survives structured-clone messaging fine
    // in Firefox — decoded to a string here rather than left as raw bytes,
    // so content.js doesn't need TextDecoder logic duplicated for this one
    // path, and so the byte buffer above can be dropped as soon as
    // possible instead of also living on in the message queue.
    const passwordText = new TextDecoder().decode(result.secretBytes);
    // Per reconstructFromRecord's contract (see its comment in
    // split-vault.js): the caller zeroes secretBytes once done with it.
    // We're done with it right above — the string is the only thing
    // handed onward from here.
    result.secretBytes.fill(0);
    return { ok: true, value: passwordText };
  } catch (err) {
    return { ok: false, error: "unexpected", message: err.message };
  }
}

async function renameSplit(id, newLabel) {
  const trimmed = typeof newLabel === "string" ? newLabel.trim() : "";
  if (!trimmed) {
    return { ok: false, message: "Label can't be empty." };
  }
  if (trimmed.length > 120) {
    return { ok: false, message: "Label is too long." };
  }
  try {
    const all = await getAllSplitRecords();
    if (!all[id]) {
      return { ok: false, message: "That saved split no longer exists." };
    }
    all[id] = { ...all[id], label: trimmed };
    await browser.storage.local.set({ [SPLITS_KEY]: all });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function deleteSplit(id) {
  try {
    const all = await getAllSplitRecords();
    delete all[id];
    await browser.storage.local.set({ [SPLITS_KEY]: all });
  } catch (err) {
    return { ok: false, error: err.message || "Could not delete split." };
  }
  try {
    await browser.storage.sync.remove(cloudKeyFor(id));
    const stored = await browser.storage.sync.get(SPLITS_CLOUD_KEY);
    const cloudAll = stored[SPLITS_CLOUD_KEY];
    if (cloudAll && Object.prototype.hasOwnProperty.call(cloudAll, id)) {
      delete cloudAll[id];
      await browser.storage.sync.set({ [SPLITS_CLOUD_KEY]: cloudAll });
    }
  } catch (err) {
    /* non-fatal — sync storage may be unavailable if not signed in */
  }
  try {
    await setRateLimitState(id, null);
  } catch (err) {
    /* non-fatal */
  }
  return { ok: true };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!sender || sender.id !== browser.runtime.id) {
    return; // reject messages from outside this extension
  }
  if (!message || typeof message.type !== "string" || !message.type.startsWith("truegen-")) {
    return; // not ours, ignore
  }

  if (message.type === "truegen-get-settings") {
    return loadSettings().then((settings) => ({ ok: true, settings }));
  }

  if (message.type === "truegen-save-settings") {
    return saveSettings(message.settings || {}).then(() => ({ ok: true }));
  }

  if (message.type === "truegen-get-categories") {
    // Only id+label cross the message boundary — content.js just needs
    // enough to render checkboxes and echo the selected ids back; the
    // actual [lo,hi] ranges stay in core.js, used only when background.js
    // itself calls generatePassword.
    const categories = TYPE6_CATEGORIES.map((c) => ({ id: c.id, label: c.label }));
    return Promise.resolve({ ok: true, categories });
  }

  if (message.type === "truegen-generate") {
    return (async () => {
      try {
        const {
          pwType,
          length,
          minDigits,
          minSpecial,
          reshakeChunkChars,
          avoidPatterns,
          useNetworkEntropy,
          customAlphabetText,
          customCategories,
        } = message;
        const result = await generatePassword(pwType, length, {
          minDigits: minDigits || 0,
          minSpecial: minSpecial || 0,
          reshakeChunkChars: reshakeChunkChars || 0,
          avoidPatterns: avoidPatterns !== false,
          useNetworkEntropy: useNetworkEntropy !== false,
          customAlphabetText: customAlphabetText || "",
          customCategories: customCategories || [],
        });
        return {
          ok: true,
          value: result.value,
          entropyBits: result.entropyBits,
          patternWarning: result.patternWarning,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }

  if (message.type === "truegen-splits-list-for-origin") {
    let trustedOrigin = null;
    if (sender.url && !sender.url.startsWith("moz-extension://")) {
      try {
        const parsed = new URL(sender.url).origin;
        if (parsed && parsed !== "null") trustedOrigin = parsed;
      } catch (err) {
        trustedOrigin = null;
      }
    } else if (typeof message.origin === "string" && message.origin !== "null") {
      trustedOrigin = message.origin;
    }
    return listSplitsFor(trustedOrigin, message.includeAllSites === true);
  }

  if (message.type === "truegen-splits-reconstruct") {
    return reconstructSplitById(message.id, {
      passphrase: message.passphrase,
      manualShareTexts: message.manualShareTexts,
    });
  }

  if (message.type === "truegen-splits-delete") {
    return deleteSplit(message.id);
  }

  if (message.type === "truegen-splits-rename") {
    return renameSplit(message.id, message.label);
  }

  if (message.type === "truegen-copy-clipboard") {
    return (async () => {
      const text = typeof message.value === "string" ? message.value : "";
      if (!text) return { ok: false, error: "Nothing to copy." };
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          return { ok: true };
        }
      } catch (err) {
        // Fall through to execCommand("copy"), which works in MV2 background
        // pages with clipboardWrite permission even without user activation.
      }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const copied = document.execCommand("copy");
        ta.remove();
        return copied ? { ok: true } : { ok: false, error: "Clipboard copy was rejected by the browser." };
      } catch (err) {
        return { ok: false, error: err.message || "Clipboard copy failed." };
      }
    })();
  }

  // Unrecognized truegen-* message — ignore rather than throw, in case a
  // newer content.js/popup.js talks to an older background.js mid-update.
  return undefined;
});

/* ===========================================================================
 * Toolbar badge: shows a small count on the extension icon when the
 * current tab's origin has one or more saved splits, so you know one
 * exists without opening the secret menu to check. Purely informational
 * — no new permission needed (setBadgeText/setBadgeBackgroundColor are
 * part of browserAction, already declared; reading tab.url is already
 * covered by the <all_urls> host permission, same as everywhere else
 * this file reads it).
 * ========================================================================= */

async function updateBadgeForTab(tab) {
  try {
    if (!tab || tab.id == null) return;
    let origin = null;
    if (tab.url) {
      try {
        const parsed = new URL(tab.url).origin;
        if (parsed && parsed !== "null") origin = parsed;
      } catch (err) {
        origin = null;
      }
    }
    if (!origin) {
      await browser.browserAction.setBadgeText({ tabId: tab.id, text: "" });
      return;
    }
    const all = await getAllSplitRecords();
    const count = Object.values(all).filter((r) => r.origin === origin).length;
    if (count > 0) {
      await browser.browserAction.setBadgeText({ tabId: tab.id, text: count > 9 ? "9+" : String(count) });
      await browser.browserAction.setBadgeBackgroundColor({ tabId: tab.id, color: "#0060df" });
    } else {
      await browser.browserAction.setBadgeText({ tabId: tab.id, text: "" });
    }
  } catch (err) {
    // Cosmetic feature only — never worth surfacing an error for.
  }
}

async function updateBadgeForAllActiveTabs() {
  try {
    const tabs = await browser.tabs.query({ active: true });
    await Promise.all(tabs.map((t) => updateBadgeForTab(t)));
  } catch (err) {
    // Cosmetic feature only.
  }
}

browser.tabs.onActivated.addListener((activeInfo) => {
  browser.tabs.get(activeInfo.tabId).then(updateBadgeForTab).catch(() => {});
});
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((changeInfo.status === "complete" || changeInfo.url) && tab && tab.active) {
    updateBadgeForTab(tab);
  }
});
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SPLITS_KEY]) reapplyStoredAppearance();
updateBadgeForAllActiveTabs();
});
updateBadgeForAllActiveTabs();
