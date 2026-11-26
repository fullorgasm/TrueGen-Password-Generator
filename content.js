/**
 * content.js
 * - Tracks the last-focused AND last-right-clicked text/password field on
 *   the page, so both the toolbar popup (which steals focus) and the
 *   context-menu quick-fill panel (opened by right-click) can target the
 *   right element.
 * - Inserts generated passwords directly into that DOM element — nothing
 *   here persists the value anywhere.
 * - Renders a small self-contained (Shadow DOM) quick-fill panel when the
 *   "Fill password (TrueGen)" context menu item is used, so length and
 *   complexity can be picked without opening the toolbar popup.
 */

(function () {
  "use strict";

  let lastFocusedField = null;
  let lastContextField = null;

  function isFillableField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "password", "email", "search", "tel", "url"].includes(type);
  }

  function eventTargetElement(e) {
    return (typeof e.composedPath === "function" && e.composedPath()[0]) || e.target;
  }

  document.addEventListener(
    "focusin",
    (e) => {
      const target = eventTargetElement(e);
      if (isFillableField(target)) lastFocusedField = target;
    },
    true
  );

  // Firefox's "editable" context menu context already restricts the menu
  // item to editable elements, but we still need our own reference to
  // *which* element was right-clicked, since contextMenus.onClicked in
  // the background script doesn't hand us the DOM node directly.
  document.addEventListener(
    "contextmenu",
    (e) => {
      const target = eventTargetElement(e);
      if (isFillableField(target)) lastContextField = target;
    },
    true
  );

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function resolveTarget(preferred) {
    if (preferred && document.contains(preferred)) return preferred;
    if (lastFocusedField && document.contains(lastFocusedField)) return lastFocusedField;
    return isFillableField(document.activeElement) ? document.activeElement : null;
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "truegen-fill") {
      const target = resolveTarget(null);
      if (!isFillableField(target)) {
        // Return undefined so another frame (e.g. a login iframe) that owns
        // the focused field can respond instead of being shadowed.
        return undefined;
      }
      setNativeValue(target, message.value);
      target.focus();
      return Promise.resolve({ ok: true });
    }

    if (message?.type === "truegen-read") {
      const target = resolveTarget(null);
      if (!isFillableField(target)) {
        return undefined;
      }
      // Read-only — nothing here is transmitted, stored, or logged; the
      // value only ever goes back to the popup for a local entropy
      // estimate and is discarded once that response is handled.
      return Promise.resolve({ ok: true, value: target.value });
    }

    if (message?.type === "truegen-field-info") {
      const target = resolveTarget(null);
      if (!isFillableField(target)) {
        return undefined;
      }
      const maxLengthAttr = target.getAttribute("maxlength");
      const maxLength = maxLengthAttr != null ? parseInt(maxLengthAttr, 10) : null;
      return Promise.resolve({
        ok: true,
        hasField: true,
        maxLength: Number.isFinite(maxLength) ? maxLength : null,
        pattern: target.getAttribute("pattern") || null,
      });
    }

    if (message?.type === "truegen-open-panel") {
      openQuickFillPanel();
      return Promise.resolve({ ok: true });
    }

    if (message?.type === "truegen-open-secret-menu") {
      openSecretMenu();
      return Promise.resolve({ ok: true });
    }
  });

  /* ---------------------------------------------------------------------
   * Settings (length/complexity/toggles/categories) are NOT duplicated
   * here — see loadSettings()/saveSettings()/getType6Categories() further
   * down, which fetch them from background.js (the single source of
   * truth, since it has lib/core.js loaded). This content script only
   * keeps a same-tab-session field reference; it never stores a password.
   * ------------------------------------------------------------------- */

  /* ---------------------------------------------------------------------
   * Shared settings (persisted via browser.storage.local) — sourced from
   * background.js so there is exactly ONE implementation of the settings
   * shape/migration logic and the Type 6 category list (both live in
   * lib/core.js, which background.js loads). This content script runs in
   * an isolated world and can't reach core.js's globals directly, so it
   * asks background.js for them over sendMessage instead of keeping its
   * own duplicate copy — the previous approach (a hand-maintained
   * duplicate here) was a real sync-drift risk and is why this exists.
   * ------------------------------------------------------------------- */

  // Only used if the extension's background page is somehow unreachable
  // (e.g. mid-reload) — loadSettings()/saveSettings() below fail soft to
  // this rather than throwing, so the panel still opens with sane values.
  const EMERGENCY_FALLBACK_SETTINGS = {
    length: 12,
    customLength: "",
    complexity: "1",
    minDigits: "0",
    minSpecial: "0",
    avoidPatterns: true,
    deepMix: false,
    useNetworkEntropy: true,
    customAlphabetText: "",
    customCategories: [],
    clipboardMode: false,
    presetId: "",
  };

  async function loadSettings() {
    try {
      const res = await browser.runtime.sendMessage({ type: "truegen-get-settings" });
      if (res && res.ok) return res.settings;
    } catch (err) {
      /* background unreachable — fall through to the emergency default */
    }
    return { ...EMERGENCY_FALLBACK_SETTINGS };
  }

  async function saveSettings(settings) {
    try {
      await browser.runtime.sendMessage({ type: "truegen-save-settings", settings });
    } catch (err) {
      /* non-fatal — the panel still works for this session either way */
    }
  }

  async function getType6Categories() {
    try {
      const res = await browser.runtime.sendMessage({ type: "truegen-get-categories" });
      if (res && res.ok && Array.isArray(res.categories)) return res.categories;
    } catch (err) {
      /* background unreachable */
    }
    return []; // renders an empty checkbox grid rather than throwing — the free-text field still works
  }

  /* ---------------------------------------------------------------------
   * Quick-fill panel (opened from the right-click context menu)
   * ------------------------------------------------------------------- */

  let panelHost = null;
  let panelOpenSeq = 0;
  let panelOutsideTimer = null;
  let panelAutoCloseTimer = null;

  function closeQuickFillPanel() {
    panelOpenSeq++;
    if (panelOutsideTimer !== null) {
      clearTimeout(panelOutsideTimer);
      panelOutsideTimer = null;
    }
    if (panelAutoCloseTimer !== null) {
      clearTimeout(panelAutoCloseTimer);
      panelAutoCloseTimer = null;
    }
    if (panelHost) {
      panelHost.remove();
      panelHost = null;
    }
    document.removeEventListener("keydown", onPanelKeydown, true);
    document.removeEventListener("mousedown", onOutsideClick, true);
  }

  function onPanelKeydown(e) {
    if (e.key === "Escape") closeQuickFillPanel();
  }
  function onOutsideClick(e) {
    if (panelHost && !panelHost.contains(e.target)) closeQuickFillPanel();
  }

  async function openQuickFillPanel() {
    const target = resolveTarget(lastContextField);
    if (!isFillableField(target)) return; // nothing sensible to fill

    closeQuickFillPanel();
    const seq = panelOpenSeq;
    const [settings, categories] = await Promise.all([loadSettings(), getType6Categories()]);
    if (seq !== panelOpenSeq) return; // closed or superseded while awaiting

    panelHost = document.createElement("div");
    panelHost.style.all = "initial";
    panelHost.style.position = "fixed";
    panelHost.style.zIndex = "2147483647";
    document.documentElement.appendChild(panelHost);

    // mode: "closed" for the same reason as the secret menu's overlay
    // below (see its comment) — this panel doesn't collect a PIN, but
    // there's no reason to leave it readable by page scripts either.
    const shadow = panelHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          all: initial;
          display: block;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 13px;
          width: 280px;
          background: #fff;
          color: #1b1b1b;
          border: 1px solid #ccc;
          border-radius: 8px;
          box-shadow: 0 6px 20px rgba(0,0,0,0.25);
          padding: 12px;
          box-sizing: border-box;
          max-height: 80vh;
          overflow-y: auto;
        }
        .title { font-weight: 600; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
        .close-btn { cursor: pointer; border: none; background: none; font-size: 16px; line-height: 1; color: #666; }
        label { display: block; margin-top: 8px; margin-bottom: 3px; font-weight: 600; font-size: 12px; }
        .length-row { display: flex; align-items: center; gap: 6px; }
        input[type="range"] { flex: 1; }
        .length-value { min-width: 30px; text-align: right; font-weight: 600; }
        input[type="number"], select, textarea {
          width: 100%; padding: 5px; font-size: 12px; box-sizing: border-box;
          font-family: inherit;
        }
        textarea { resize: vertical; min-height: 44px; }
        .hint { font-size: 10.5px; color: #666; margin-top: 3px; }
        .warn { font-size: 10.5px; color: #b00020; margin-top: 3px; }
        .checkbox-row {
          display: flex; align-items: center; gap: 6px; margin-top: 10px;
          font-weight: normal; font-size: 12px; cursor: pointer;
        }
        .checkbox-row input { width: auto; margin: 0; }
        .cat-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px;
          margin-top: 4px;
        }
        .cat-row {
          display: flex; align-items: center; gap: 5px; margin: 1px 0;
          font-weight: normal; font-size: 11.5px; cursor: pointer;
        }
        .cat-row input { width: auto; margin: 0; }
        button.fill-btn {
          width: 100%; margin-top: 10px; padding: 7px; font-size: 13px;
          font-weight: 600; color: #fff; background: #0060df; border: none;
          border-radius: 5px; cursor: pointer;
        }
        button.fill-btn:disabled { background: #9aa0a6; cursor: default; }
        .status { min-height: 14px; font-size: 11px; margin-top: 6px; }
        .status.err { color: #b00020; }
        .status.ok { color: #157f37; }
      </style>
      <div class="panel">
        <div class="title">
          <span data-i18n="panelTitle">TrueGen — Fill password</span>
          <button class="close-btn" type="button" data-i18n-aria-label="panelCloseAria" aria-label="Close">×</button>
        </div>

        <label data-i18n="lengthLabel">Length</label>
        <div class="length-row">
          <input type="range" min="4" max="256" step="1" value="12" class="length-slider" />
          <span class="length-value">12</span>
        </div>
        <input type="number" min="4" max="100000" data-i18n-placeholder="panelLengthCustomPlaceholder" placeholder="or type exact length" class="length-custom" />
        <p class="hint">⚠️ Custom field <strong>overrides the slider</strong> (4–100,000 chars).</p>
        <p class="warn" hidden></p>

        <label data-i18n="complexityLabel">Complexity</label>
        <select class="complexity-select">
          <option value="1" selected data-i18n="panelType1">Type 1 — Standard</option>
          <option value="2" data-i18n="panelType2">Type 2 — Global</option>
          <option value="3" data-i18n="panelType3">Type 3 — Safe-Extended</option>
          <option value="4" data-i18n="panelType4">Type 4 — Practical Max</option>
          <option value="5" data-i18n="panelType5">Type 5 — Absolute Max</option>
          <option value="6" data-i18n="panelType6Multi">Type 6 — Hyper-Extended (Multi-Mod)</option>
          <option value="7" data-i18n="panelType7">Type 7 — Custom</option>
        </select>
        <p class="hint type45-hint" hidden>Types 4/5/6 are extreme — almost certainly rejected by real login forms. Vault/offline key use only.</p>

        <div class="type6-block" hidden>
          <label data-i18n="type6CategoriesLabel">Character categories</label>
          <div class="type6-categories cat-grid"></div>
          <label data-i18n="type6InputLabel">Additional characters/ranges (optional)</label>
          <textarea class="type6-input" data-i18n-placeholder="panelType6Placeholder" placeholder="Extra characters (e.g. AbC!@#) or ranges like U+0400-U+04FF"></textarea>
          <p class="hint">Checked categories + typed text are merged. Tokens can mix freely: <code>U+0400-U+04FF</code> = range, anything else = literal characters. No digit/special guarantees in Custom mode.</p>
        </div>

        <label class="checkbox-row">
          <input type="checkbox" class="network-entropy-checkbox" checked />
          <span data-i18n="networkEntropyLabel">Query quantum RNG (sends a network request, mixed with local entropy)</span>
        </label>

        <label class="checkbox-row">
          <input type="checkbox" class="avoid-patterns-checkbox" checked />
          <span data-i18n="panelAvoidPatterns">Avoid obvious runs (repeats/sequences)</span>
        </label>

        <label class="checkbox-row">
          <input type="checkbox" class="deep-mix-checkbox" />
          <span data-i18n="panelDeepMix">Deep-mix (reshake per character)</span>
        </label>

        <label class="checkbox-row">
          <input type="checkbox" class="clipboard-mode-checkbox" />
          <span data-i18n="panelClipboardMode">Generate to clipboard (skip page field)</span>
        </label>

        <button class="fill-btn" type="button" data-i18n="fillBtnDefault">Fill focused field</button>
        <p class="status" role="status" aria-live="polite"></p>
      </div>
    `;

    // Content scripts do have access to browser.i18n even though they
    // lack most other extension APIs — apply the same data-i18n(-*)
    // convention used in popup.js, scoped to this shadow root only.
    shadow.querySelectorAll("[data-i18n]").forEach((el) => {
      const msg = browser.i18n.getMessage(el.getAttribute("data-i18n"));
      if (msg) el.textContent = msg;
    });
    shadow.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const msg = browser.i18n.getMessage(el.getAttribute("data-i18n-placeholder"));
      if (msg) el.placeholder = msg;
    });
    shadow.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      const msg = browser.i18n.getMessage(el.getAttribute("data-i18n-aria-label"));
      if (msg) el.setAttribute("aria-label", msg);
    });

    positionPanel(target);

    const $ = (sel) => shadow.querySelector(sel);
    const slider = $(".length-slider");
    const sliderValue = $(".length-value");
    const custom = $(".length-custom");
    const warn = $(".warn");
    const complexity = $(".complexity-select");
    const type45Hint = $(".type45-hint");
    const type6Block = $(".type6-block");
    const type6CategoriesEl = $(".type6-categories");
    const type6Input = $(".type6-input");
    const avoidPatterns = $(".avoid-patterns-checkbox");
    const deepMix = $(".deep-mix-checkbox");
    const networkEntropy = $(".network-entropy-checkbox");
    const clipboardMode = $(".clipboard-mode-checkbox");
    const fillBtn = $(".fill-btn");
    const statusEl = $(".status");
    const MIN_LEN = 4, MAX_LEN = 256;

    function renderType6Categories(selectedIds, categories) {
      type6CategoriesEl.innerHTML = "";
      for (const cat of categories) {
        const label = document.createElement("label");
        label.className = "cat-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = cat.id;
        cb.checked = selectedIds.includes(cat.id);
        label.appendChild(cb);
        const span = document.createElement("span");
        span.textContent = cat.label;
        label.appendChild(span);
        type6CategoriesEl.appendChild(label);
      }
    }
    function getSelectedCategories() {
      return Array.from(type6CategoriesEl.querySelectorAll('input[type="checkbox"]:checked')).map(
        (cb) => cb.value
      );
    }

    // Restore last-used settings (shared with the toolbar popup).
    slider.value = String(settings.length);
    sliderValue.textContent = slider.value;
    custom.value = settings.customLength;
    complexity.value = settings.complexity;
    avoidPatterns.checked = settings.avoidPatterns;
    deepMix.checked = settings.deepMix;
    networkEntropy.checked = settings.useNetworkEntropy;
    clipboardMode.checked = settings.clipboardMode;
    type6Input.value = settings.customAlphabetText;
    // Fetched from background.js (see getType6Categories) rather than a
    // local duplicate list — one network-free message round trip per
    // panel open, cached in `categories` for the rest of this session.
    renderType6Categories(settings.customCategories || [], categories);
    updateFillBtnLabel();

    function updateComplexityUi() {
      type45Hint.hidden = complexity.value !== "4" && complexity.value !== "5" && complexity.value !== "6";
      type6Block.hidden = complexity.value !== "7";
    }
    updateComplexityUi();

    function updateFillBtnLabel() {
      fillBtn.textContent = clipboardMode.checked
        ? browser.i18n.getMessage("fillBtnClipboard") || "Generate to clipboard"
        : browser.i18n.getMessage("fillBtnDefault") || "Fill focused field";
    }

    function persist() {
      saveSettings({
        length: parseInt(slider.value, 10),
        customLength: custom.value,
        complexity: complexity.value,
        minDigits: settings.minDigits, // panel doesn't expose these; keep whatever the popup last set
        minSpecial: settings.minSpecial,
        avoidPatterns: avoidPatterns.checked,
        deepMix: deepMix.checked,
        useNetworkEntropy: networkEntropy.checked,
        customAlphabetText: type6Input.value,
        customCategories: getSelectedCategories(),
        clipboardMode: clipboardMode.checked,
      });
    }

    complexity.addEventListener("change", () => {
      updateComplexityUi();
      persist();
    });
    type6Input.addEventListener("input", persist);
    type6CategoriesEl.addEventListener("change", persist);
    avoidPatterns.addEventListener("change", persist);
    networkEntropy.addEventListener("change", persist);
    deepMix.addEventListener("change", persist);
    clipboardMode.addEventListener("change", () => {
      updateFillBtnLabel();
      persist();
    });

    slider.addEventListener("input", () => {
      sliderValue.textContent = slider.value;
      persist();
    });
    custom.addEventListener("input", () => {
      const raw = custom.value.trim();
      if (raw === "") {
        warn.hidden = true;
      } else {
        const n = parseInt(raw, 10);
        if (!Number.isInteger(n) || n < MIN_LEN || n > MAX_LEN) {
          warn.hidden = false;
          warn.textContent = `Must be ${MIN_LEN}-${MAX_LEN}. Max allowed length is ${MAX_LEN}.`;
        } else {
          warn.hidden = true;
        }
      }
      persist();
    });

    function getEffectiveLength() {
      const raw = custom.value.trim();
      if (raw !== "") {
        const n = parseInt(raw, 10);
        if (Number.isInteger(n)) return Math.min(MAX_LEN, Math.max(MIN_LEN, n));
      }
      return parseInt(slider.value, 10);
    }

    fillBtn.addEventListener("click", async () => {
      fillBtn.disabled = true;
      statusEl.textContent = "Generating…";
      statusEl.className = "status";
      try {
        const length = getEffectiveLength();
        const pwType = parseInt(complexity.value, 10);
        const reshakeChunkChars = deepMix.checked ? 1 : 0;
        const response = await browser.runtime.sendMessage({
          type: "truegen-generate",
          pwType,
          length,
          minDigits: parseInt(settings.minDigits, 10) || 0,
          minSpecial: parseInt(settings.minSpecial, 10) || 0,
          reshakeChunkChars,
          avoidPatterns: avoidPatterns.checked,
          useNetworkEntropy: networkEntropy.checked,
          customAlphabetText: type6Input.value,
          customCategories: getSelectedCategories(),
        });
        if (!response || !response.ok) {
          throw new Error((response && response.error) || "Generation failed.");
        }

        const warnMsg = response.patternWarning ? " (pattern not fully avoidable)" : "";

        if (clipboardMode.checked) {
          // This is the ONE call site in the whole extension that the
          // manifest's `clipboardWrite` permission exists for — it's a
          // content-script context, unlike the popup's own clipboard
          // calls (privileged extension page, doesn't need the
          // permission). Only reached when the user has explicitly
          // checked "Generate to clipboard" above; never automatic. See
          // README's Permissions section for the full writeup.
          let copied = false;
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
              await navigator.clipboard.writeText(response.value);
              copied = true;
            }
          } catch (clipErr) {
            // Fall back to background page (works on HTTP pages and after
            // user-activation expiry during slow network entropy fetches).
          }
          if (!copied) {
            const bgCopy = await browser.runtime
              .sendMessage({ type: "truegen-copy-clipboard", value: response.value })
              .catch((err) => ({ ok: false, error: err.message }));
            if (!bgCopy || !bgCopy.ok) {
              throw new Error(
                "Generated, but couldn't write to clipboard: " + ((bgCopy && bgCopy.error) || "clipboard blocked")
              );
            }
          }
          statusEl.textContent = `Copied (${length} chars, ~${response.entropyBits.toFixed(0)} bits).${warnMsg}`;
          statusEl.className = "status ok";
          panelAutoCloseTimer = setTimeout(closeQuickFillPanel, 900);
          return;
        }

        const finalTarget = resolveTarget(target);
        if (!isFillableField(finalTarget)) {
          throw new Error("The target field is no longer available.");
        }
        setNativeValue(finalTarget, response.value);
        finalTarget.focus();
        statusEl.textContent = `Filled (${length} chars, ~${response.entropyBits.toFixed(0)} bits).${warnMsg}`;
        statusEl.className = "status ok";
        panelAutoCloseTimer = setTimeout(closeQuickFillPanel, 900);
      } catch (err) {
        statusEl.textContent = "Error: " + err.message;
        statusEl.className = "status err";
      } finally {
        fillBtn.disabled = false;
      }
    });

    $(".close-btn").addEventListener("click", closeQuickFillPanel);
    document.addEventListener("keydown", onPanelKeydown, true);
    // Delay attaching the outside-click closer by a tick so the very
    // contextmenu-triggered click that opened the panel doesn't also
    // immediately close it.
    panelOutsideTimer = setTimeout(() => {
      panelOutsideTimer = null;
      if (seq === panelOpenSeq && panelHost) {
        document.addEventListener("mousedown", onOutsideClick, true);
      }
    }, 0);
  }

  function positionPanel(target) {
    const rect = target.getBoundingClientRect();
    const panelWidth = panelHost.offsetWidth || 280;
    const panelHeight = panelHost.offsetHeight || 280;
    const margin = 6;
    let left = rect.left;
    let top = rect.bottom + margin;

    if (left + panelWidth > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - panelWidth - margin);
    }
    if (top + panelHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - panelHeight - margin);
    }

    panelHost.style.left = `${left}px`;
    panelHost.style.top = `${top}px`;
  }

  /* ---------------------------------------------------------------------
   * Secret menu (distributed-password reconstruction) — opened via the
   * "truegen-secret-menu" keyboard command (see manifest.json's
   * "commands", rebindable in about:addons). Unlike the quick-fill panel,
   * this isn't anchored to a specific field: it's centered on screen, and
   * the target field is resolved fresh at the moment "Reconstruct & fill"
   * is pressed (resolveTarget(null) — same fallback chain the
   * "truegen-fill" message handler uses), so you can open the menu, click
   * into the field you want, and reconstruct — in either order.
   *
   * All actual crypto/storage happens in background.js (see its
   * truegen-splits-* message handlers) — this file only renders the UI
   * and passes through whatever the user typed/pasted.
   * ------------------------------------------------------------------- */

  let secretMenuHost = null;
  let secretMenuAutoCloseTimer = null;
  let secretMenuCleanup = null;

  function closeSecretMenu() {
    if (secretMenuAutoCloseTimer !== null) {
      clearTimeout(secretMenuAutoCloseTimer);
      secretMenuAutoCloseTimer = null;
    }
    if (secretMenuCleanup) {
      secretMenuCleanup();
      secretMenuCleanup = null;
    }
    if (secretMenuHost) {
      secretMenuHost.remove();
      secretMenuHost = null;
    }
    document.removeEventListener("keydown", onSecretMenuKeydown, true);
  }
  function onSecretMenuKeydown(e) {
    if (e.key === "Escape") closeSecretMenu();
  }

  async function openSecretMenu() {
    closeSecretMenu();
    closeQuickFillPanel();

    secretMenuHost = document.createElement("div");
    secretMenuHost.style.all = "initial";
    secretMenuHost.style.position = "fixed";
    secretMenuHost.style.zIndex = "2147483647";
    secretMenuHost.style.top = "0";
    secretMenuHost.style.left = "0";
    secretMenuHost.style.width = "100vw";
    secretMenuHost.style.height = "100vh";
    secretMenuHost.style.display = "flex";
    secretMenuHost.style.alignItems = "center";
    secretMenuHost.style.justifyContent = "center";
    document.documentElement.appendChild(secretMenuHost);

    // mode: "closed" is deliberate and load-bearing here, not
    // incidental — this overlay collects a PIN/passphrase. "open" would
    // let a malicious or compromised page read it via
    // `secretMenuHost.shadowRoot` and poll the passphrase input's value
    // as the user types it. "closed" makes `.shadowRoot` return null to
    // ANY code outside this closure, including page scripts — this file
    // keeps working because it uses the `shadow` reference returned
    // here directly, never re-derives it via `.shadowRoot`. Do not
    // "simplify" this back to "open".
    const shadow = secretMenuHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .backdrop {
          all: initial; position: fixed; inset: 0;
          background: rgba(0,0,0,0.35);
        }
        .menu {
          all: initial; position: relative; display: block;
          font-family: system-ui, -apple-system, sans-serif; font-size: 13px;
          width: 320px; max-height: 80vh; overflow-y: auto;
          background: #fff; color: #1b1b1b;
          border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.35);
          padding: 14px; box-sizing: border-box;
        }
        .title { font-weight: 700; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
        .close-btn { cursor: pointer; border: none; background: none; font-size: 18px; line-height: 1; color: #666; }
        .split-list { list-style: none; margin: 0; padding: 0; }
        .split-item {
          padding: 8px; border: 1px solid #ddd; border-radius: 6px;
          margin-bottom: 6px; cursor: pointer;
        }
        .split-item:hover { background: #f5f7ff; border-color: #0060df; }
        .split-item .label { font-weight: 600; }
        .split-item .meta { font-size: 11px; color: #666; margin-top: 2px; }
        .empty { color: #666; font-size: 12px; margin: 8px 0; }
        .link-btn {
          all: initial; display: inline-block; cursor: pointer;
          color: #0060df; font-size: 12px; text-decoration: underline;
          font-family: inherit; margin-top: 4px;
        }
        label { display: block; margin-top: 10px; margin-bottom: 3px; font-weight: 600; font-size: 12px; }
        input[type="password"], input[type="text"] {
          width: 100%; padding: 6px; font-size: 12px; box-sizing: border-box; font-family: inherit;
        }
        .status-line { font-size: 11.5px; color: #555; margin-top: 4px; }
        .status-line.warn { color: #c0392b; }
        .status { margin-top: 10px; font-size: 12px; min-height: 16px; }
        .status.ok { color: #0a7d2c; }
        .status.err { color: #c0392b; }
        button.primary {
          all: initial; box-sizing: border-box; display: block; width: 100%;
          margin-top: 12px; padding: 8px; text-align: center; cursor: pointer;
          background: #0060df; color: #fff; border-radius: 6px; font-weight: 600; font-size: 13px;
          font-family: inherit;
        }
        button.primary:disabled { background: #9db6e8; cursor: default; }
        button.danger {
          all: initial; box-sizing: border-box; display: block; width: 100%;
          margin-top: 8px; padding: 6px; text-align: center; cursor: pointer;
          background: #fff; color: #c0392b; border: 1px solid #c0392b; border-radius: 6px;
          font-size: 12px; font-family: inherit;
        }
        .back-btn {
          all: initial; cursor: pointer; color: #0060df; font-size: 12px;
          text-decoration: underline; font-family: inherit; margin-bottom: 8px; display: inline-block;
        }
        .rename-save-btn {
          width: auto; margin-top: 0; padding: 6px 10px;
          background: #eee; color: #1a1a1a; border: 1px solid #ccc; border-radius: 5px;
          font-size: 12px; font-weight: 600; cursor: pointer;
        }
        .rename-save-btn:hover { background: #e2e2e2; }
        .rename-save-btn:disabled { opacity: 0.6; cursor: default; }
      </style>
      <div class="backdrop"></div>
      <div class="menu" role="dialog" aria-modal="true" aria-label="${escapeHtml(
        browser.i18n.getMessage("splitMenuTitle") || "TrueGen secret menu"
      )}">
        <div class="title">
          <span>${escapeHtml(browser.i18n.getMessage("splitMenuTitle") || "🔐 TrueGen secret menu")}</span>
          <button class="close-btn" type="button" aria-label="${escapeHtml(
            browser.i18n.getMessage("splitMenuCloseAria") || "Close"
          )}">×</button>
        </div>
        <div class="list-view">
          <ul class="split-list"></ul>
          <p class="empty" hidden></p>
          <button class="link-btn toggle-all-sites" type="button"></button>
        </div>
        <div class="detail-view" hidden>
          <button type="button" class="back-btn">${escapeHtml(
            browser.i18n.getMessage("splitMenuBackBtn") || "← back"
          )}</button>
          <div class="rename-row" style="display:flex; gap:4px; margin-bottom:6px;">
            <input type="text" class="rename-input" style="flex:1;" maxlength="120" />
            <button type="button" class="rename-save-btn"></button>
          </div>
          <div class="detail-fields"></div>
          <p class="status-line cloud-status" hidden></p>
          <button class="primary reconstruct-btn" type="button" disabled></button>
          <button class="danger delete-btn" type="button"></button>
          <p class="status" role="status" aria-live="polite"></p>
        </div>
      </div>
    `;

    const $ = (sel) => shadow.querySelector(sel);
    const listView = $(".list-view");
    const detailView = $(".detail-view");
    const splitListEl = $(".split-list");
    const emptyEl = $(".empty");
    const toggleAllSitesBtn = $(".toggle-all-sites");
    const backBtn = $(".back-btn");
    const renameInput = $(".rename-input");
    const renameSaveBtn = $(".rename-save-btn");
    const detailFields = $(".detail-fields");
    const cloudStatusEl = $(".cloud-status");
    const reconstructBtn = $(".reconstruct-btn");
    const deleteBtn = $(".delete-btn");
    const statusEl = $(".status");
    const closeBtn = $(".close-btn");

    reconstructBtn.textContent = browser.i18n.getMessage("splitMenuReconstructBtn") || "Reconstruct & fill";
    deleteBtn.textContent = browser.i18n.getMessage("splitMenuDeleteBtn") || "Delete this split";
    renameSaveBtn.textContent = browser.i18n.getMessage("splitMenuRenameSaveBtn") || "Rename";

    closeBtn.addEventListener("click", closeSecretMenu);
    $(".backdrop").addEventListener("click", closeSecretMenu);

    let showingAllSites = false;
    let currentSplits = [];
    let selected = null;

    function setToggleLabel() {
      toggleAllSitesBtn.textContent = showingAllSites
        ? browser.i18n.getMessage("splitMenuShowThisSiteOnly") || "Show only this site"
        : browser.i18n.getMessage("splitMenuShowAllSites") || "Show splits for all sites";
    }
    setToggleLabel();

    let refreshSeq = 0;
    async function refreshList() {
      const seq = ++refreshSeq;
      const res = await browser.runtime
        .sendMessage({
          type: "truegen-splits-list-for-origin",
          origin: location.origin,
          includeAllSites: showingAllSites,
        })
        .catch(() => null);
      if (seq !== refreshSeq) return; // stale response
      currentSplits = (res && res.splits) || [];

      splitListEl.innerHTML = "";
      emptyEl.hidden = currentSplits.length > 0;
      if (currentSplits.length === 0) {
        emptyEl.textContent = browser.i18n.getMessage("splitMenuNoSplitsForSite") || "No saved splits for this site.";
      }
      for (const split of currentSplits) {
        const li = document.createElement("li");
        li.className = "split-item";
        const label = document.createElement("div");
        label.className = "label";
        label.textContent = split.label;
        const meta = document.createElement("div");
        meta.className = "meta";
        const roles = [];
        if (split.hasLocal) roles.push(browser.i18n.getMessage("splitMenuChipLocal") || "Local");
        if (split.manualLabels && split.manualLabels.length > 0) {
          const manualChip = browser.i18n.getMessage("splitMenuChipManual") || "Manual";
          roles.push(`${manualChip} x${split.manualLabels.length}`);
        }
        if (split.hasCloud) roles.push(browser.i18n.getMessage("splitMenuChipCloud") || "Cloud");
        const requiredSuffix = browser.i18n.getMessage("splitMenuRequiredSuffix") || "required";
        meta.textContent = `${split.k}/${split.n} ${requiredSuffix} — ${roles.join(" + ")}`;
        li.appendChild(label);
        li.appendChild(meta);
        li.addEventListener("click", () => openDetail(split));
        splitListEl.appendChild(li);
      }
    }

    toggleAllSitesBtn.addEventListener("click", () => {
      showingAllSites = !showingAllSites;
      setToggleLabel();
      refreshList();
    });

    function openDetail(split) {
      selected = split;
      listView.hidden = true;
      detailView.hidden = false;
      statusEl.textContent = "";
      statusEl.className = "status";
      renameInput.value = split.label;
      detailFields.innerHTML = "";
      cloudStatusEl.hidden = !split.hasCloud;
      cloudStatusEl.className = "status-line cloud-status" + (split.hasCloud && !split.cloudAvailable ? " warn" : "");
      if (split.hasCloud) {
        cloudStatusEl.textContent = split.cloudAvailable
          ? browser.i18n.getMessage("splitMenuCloudAuto") || "Cloud: automatic (from Firefox Sync)"
          : browser.i18n.getMessage("splitMenuCloudUnavailable") ||
            "Cloud: not available (sign in to Firefox Sync, or not yet synced to this device)";
      }

      if (split.hasLocal) {
        const label = document.createElement("label");
        label.textContent = browser.i18n.getMessage("splitPassphraseLabel") || "PIN/passphrase for the local piece";
        const input = document.createElement("input");
        input.type = "password";
        input.className = "passphrase-input";
        input.autocomplete = "off";
        input.placeholder = browser.i18n.getMessage("splitMenuPassphrasePlaceholder") || "PIN/passphrase";
        detailFields.appendChild(label);
        detailFields.appendChild(input);
      }
      if (split.manualLabels && split.manualLabels.length > 0) {
        for (const holderLabel of split.manualLabels) {
          const label = document.createElement("label");
          label.textContent = holderLabel;
          const input = document.createElement("input");
          input.type = "text";
          input.className = "manual-input";
          input.autocomplete = "off";
          input.spellcheck = false;
          input.placeholder =
            browser.i18n.getMessage("splitMenuManualPlaceholder") || "Paste this person's code";
          detailFields.appendChild(label);
          detailFields.appendChild(input);
        }
      }

      reconstructBtn.disabled = false;
    }

    backBtn.addEventListener("click", () => {
      selected = null;
      detailView.hidden = true;
      listView.hidden = false;
    });

    renameSaveBtn.addEventListener("click", async () => {
      if (!selected) return;
      const newLabel = renameInput.value.trim();
      if (!newLabel) {
        statusEl.textContent = "Label can't be empty.";
        statusEl.className = "status err";
        return;
      }
      if (newLabel === selected.label) return; // nothing to do
      renameSaveBtn.disabled = true;
      let response;
      try {
        response = await browser.runtime
          .sendMessage({ type: "truegen-splits-rename", id: selected.id, label: newLabel })
          .catch((err) => ({ ok: false, message: err.message }));
      } finally {
        renameSaveBtn.disabled = false;
      }
      if (!response || !response.ok) {
        statusEl.textContent = (response && response.message) || "Rename failed.";
        statusEl.className = "status err";
        return;
      }
      selected.label = newLabel; // keep the open detail view's own state in sync
      // Also refresh the underlying list (without leaving the detail
      // view) so going "back" shows the new name immediately, instead
      // of the stale one from the last refreshList() call.
      await refreshList();
      statusEl.textContent = "Renamed.";
      statusEl.className = "status ok";
    });

    // --- Hold-to-confirm on the Reconstruct button ------------------
    // A deliberately modest speed bump, not a security boundary: it
    // requires a real held pointerdown-to-pointerup duration (randomized
    // per attempt) before the actual reconstruct message is sent. This
    // raises the bar against a browser-automation tool (Selenium/
    // Playwright/etc.) driving instant synthetic clicks WITHOUT
    // extension-debugging access — it does nothing against someone who
    // already has about:debugging → Inspect on this extension's
    // background page, since they can call the underlying message
    // handlers directly, bypassing this button (and this whole overlay)
    // entirely. The real defense against THAT is the serialized,
    // storage-backed rate limiter in background.js's
    // reconstructSplitById — this is a narrower, honestly-scoped
    // addition on top of it, not a replacement for it.
    let holdStartedAt = null;
    let holdTimer = null;
    let holdTargetMs = 0;
    const reconstructBtnBaseLabel = browser.i18n.getMessage("splitMenuReconstructBtn") || "Reconstruct & fill";

    function resetHold() {
      holdStartedAt = null;
      if (holdTimer) {
        clearInterval(holdTimer);
        holdTimer = null;
      }
      reconstructBtn.textContent = reconstructBtnBaseLabel;
    }

    reconstructBtn.addEventListener("pointerdown", (e) => {
      if (!selected || reconstructBtn.disabled) return;
      e.preventDefault();
      holdStartedAt = Date.now();
      holdTargetMs = 1000 + Math.floor(Math.random() * 800); // 1.0-1.8s, randomized per attempt
      holdTimer = setInterval(() => {
        const elapsed = Date.now() - holdStartedAt;
        const pct = Math.min(100, Math.round((elapsed / holdTargetMs) * 100));
        reconstructBtn.textContent = `${reconstructBtnBaseLabel} (${pct}%)`;
      }, 50);
    });

    reconstructBtn.addEventListener("pointerup", async () => {
      if (holdStartedAt == null) return;
      const elapsed = Date.now() - holdStartedAt;
      resetHold();
      if (elapsed < holdTargetMs) {
        statusEl.textContent = "Hold the button a little longer to confirm.";
        statusEl.className = "status";
        return;
      }
      await doReconstruct();
    });

    reconstructBtn.addEventListener("pointerleave", () => {
      if (holdStartedAt != null) resetHold();
    });
    reconstructBtn.addEventListener("pointercancel", () => {
      if (holdStartedAt != null) resetHold();
    });
    // Keyboard accessibility: hold Enter/Space to confirm, matching pointer hold.
    reconstructBtn.addEventListener("keydown", (e) => {
      if ((e.key !== "Enter" && e.key !== " ") || e.repeat || !selected || reconstructBtn.disabled) return;
      e.preventDefault();
      holdStartedAt = Date.now();
      holdTargetMs = 1000 + Math.floor(Math.random() * 800);
      holdTimer = setInterval(() => {
        const elapsed = Date.now() - holdStartedAt;
        const pct = Math.min(100, Math.round((elapsed / holdTargetMs) * 100));
        reconstructBtn.textContent = `${reconstructBtnBaseLabel} (${pct}%)`;
      }, 50);
    });
    reconstructBtn.addEventListener("keyup", async (e) => {
      if ((e.key !== "Enter" && e.key !== " ") || holdStartedAt == null) return;
      e.preventDefault();
      const elapsed = Date.now() - holdStartedAt;
      resetHold();
      if (elapsed < holdTargetMs) {
        statusEl.textContent =
          browser.i18n.getMessage("splitMenuHoldLonger") || "Hold the button a little longer to confirm.";
        statusEl.className = "status";
        return;
      }
      await doReconstruct();
    });
    secretMenuCleanup = () => {
      resetHold();
      resetDeleteConfirm();
    };

    function localizeSplitError(response) {
      if (!response) return browser.i18n.getMessage("splitErrorGeneric") || "Reconstruction failed.";
      switch (response.error) {
        case "wrong-passphrase":
          return browser.i18n.getMessage("splitErrorWrongPassphrase") || response.message;
        case "manual-share-mismatch":
          return browser.i18n.getMessage("splitErrorManualMismatch") || response.message;
        case "verification-failed":
          return browser.i18n.getMessage("splitErrorVerificationFailed") || response.message;
        case "not-found":
          return browser.i18n.getMessage("splitErrorNotFound") || response.message;
        case "rate-limited": {
          if (typeof response.waitSeconds === "number") {
            const msg = browser.i18n.getMessage("splitErrorRateLimited", [String(response.waitSeconds)]);
            if (msg) return msg;
            const prefix = browser.i18n.getMessage("splitErrorRateLimitedPrefix");
            if (prefix) return `${prefix} ${response.waitSeconds}s.`;
          }
          return response.message;
        }
        default:
          return response.message || browser.i18n.getMessage("splitErrorGeneric") || "Reconstruction failed.";
      }
    }

    async function doReconstruct() {
      if (!selected) return;
      const target = resolveTarget(null);
      if (!isFillableField(target)) {
        statusEl.textContent =
          browser.i18n.getMessage("splitMenuNoFieldFocused") ||
          "No text/password field is focused to fill. Click into a field first, then try again.";
        statusEl.className = "status err";
        return;
      }
      reconstructBtn.disabled = true;
      statusEl.textContent = browser.i18n.getMessage("statusReconstructing") || "Reconstructing…";
      statusEl.className = "status";
      const passphraseInput = shadow.querySelector(".passphrase-input");
      const manualInputs = Array.from(shadow.querySelectorAll(".manual-input"));
      try {
        const passphrase = passphraseInput ? passphraseInput.value : undefined;
        const manualShareTexts = manualInputs.map((el) => el.value).filter((v) => v && v.trim());

        const response = await browser.runtime.sendMessage({
          type: "truegen-splits-reconstruct",
          id: selected.id,
          passphrase,
          manualShareTexts,
        });

        if (!response || !response.ok) {
          statusEl.textContent = localizeSplitError(response);
          statusEl.className = "status err";
          return;
        }

        setNativeValue(target, response.value);
        target.focus();
        statusEl.textContent = browser.i18n.getMessage("statusFilledShort") || "Filled.";
        statusEl.className = "status ok";
        secretMenuAutoCloseTimer = setTimeout(closeSecretMenu, 700);
      } catch (err) {
        statusEl.textContent = "Error: " + err.message;
        statusEl.className = "status err";
      } finally {
        // Always clear sensitive inputs regardless of success or error.
        if (passphraseInput) passphraseInput.value = "";
        for (const el of manualInputs) el.value = "";
        reconstructBtn.disabled = false;
      }
    }

    // Two-step inline confirmation instead of window.confirm() (which is
    // blocked in sandboxed iframes and interceptable by page scripts).
    let deleteConfirmArmed = false;
    let deleteConfirmTimer = null;
    const deleteBtnBaseLabel = browser.i18n.getMessage("splitMenuDeleteBtn") || "Delete saved split";
    function resetDeleteConfirm() {
      deleteConfirmArmed = false;
      if (deleteConfirmTimer !== null) {
        clearTimeout(deleteConfirmTimer);
        deleteConfirmTimer = null;
      }
      deleteBtn.textContent = deleteBtnBaseLabel;
    }

    deleteBtn.addEventListener("click", async () => {
      if (!selected || deleteBtn.disabled) return;
      if (!deleteConfirmArmed) {
        deleteConfirmArmed = true;
        deleteBtn.textContent =
          browser.i18n.getMessage("splitMenuDeleteConfirmInline") || "Click again to confirm permanent delete";
        deleteConfirmTimer = setTimeout(resetDeleteConfirm, 4000);
        return;
      }
      resetDeleteConfirm();
      deleteBtn.disabled = true;
      try {
        const res = await browser.runtime
          .sendMessage({ type: "truegen-splits-delete", id: selected.id })
          .catch((err) => ({ ok: false, error: err.message }));
        if (!res || !res.ok) {
          statusEl.textContent = (res && res.error) || "Delete failed.";
          statusEl.className = "status err";
          return;
        }
        selected = null;
        detailView.hidden = true;
        listView.hidden = false;
        await refreshList();
      } finally {
        deleteBtn.disabled = false;
      }
    });

    document.addEventListener("keydown", onSecretMenuKeydown, true);

    await refreshList();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
