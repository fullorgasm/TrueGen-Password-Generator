/**
 * content.js
 * Tracks the last-focused text/password field on the page so the popup
 * (which steals focus when opened) can still fill the right field. Nothing
 * here persists the generated value anywhere — it's set directly on the
 * DOM element and the reference is dropped after use.
 */

(function () {
  "use strict";

  let lastFocusedField = null;

  function isFillableField(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "password", "email", "search", "tel", "url"].includes(type);
  }

  document.addEventListener(
    "focusin",
    (e) => {
      if (isFillableField(e.target)) lastFocusedField = e.target;
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

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== "truegen-fill") return;

    const target =
      lastFocusedField && document.contains(lastFocusedField)
        ? lastFocusedField
        : document.activeElement;

    if (!isFillableField(target)) {
      return Promise.resolve({
        ok: false,
        error: "No text/password field is focused on this page. Click into a field first, then press Fill.",
      });
    }

    setNativeValue(target, message.value);
    target.focus();
    return Promise.resolve({ ok: true });
  });
})();
