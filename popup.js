/**
 * popup.js
 * Everything the popup needs — alphabet builders, entropy mixing, the
 * generator, and the UI wiring — lives in this single file so there's no
 * multi-script load-order to get wrong. Nothing here is persisted:
 * the generated value is created, sent to the content script, and the
 * local variable holding it goes out of scope immediately after.
 */

"use strict";

/* ---------------------------------------------------------------------
 * Alphabets
 * ------------------------------------------------------------------- */

const CONTROL_RANGES = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
];
const EXTRA_EXCLUDED = new Set([0x2028, 0x2029, 0xfeff, 0x200b, 0x200c]);

function isControl(cp) {
  if (EXTRA_EXCLUDED.has(cp)) return true;
  return CONTROL_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}
function isSurrogate(cp) {
  return cp >= 0xd800 && cp <= 0xdfff;
}
function isNoncharacter(cp) {
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
  if ((cp & 0xfffe) === 0xfffe) return true;
  return false;
}
function rangeToChars(lo, hi) {
  const out = [];
  for (let cp = lo; cp <= hi; cp++) {
    if (isControl(cp) || isSurrogate(cp) || isNoncharacter(cp)) continue;
    try {
      out.push(String.fromCodePoint(cp));
    } catch (e) {
      /* skip anything the runtime refuses to encode */
    }
  }
  return out;
}

function buildType1() {
  return rangeToChars(0x0021, 0x007e); // ASCII letters/digits/symbols, ~94 chars
}

const TYPE2_BLOCKS = [
  [0x0021, 0x007e],
  [0x00a1, 0x024f],
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x0530, 0x058f], // Armenian
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0900, 0x097f], // Devanagari
  [0x10a0, 0x10ff], // Georgian
  [0x1f00, 0x1fff], // Greek Extended
  [0x2100, 0x214f], // Letterlike Symbols
  [0x2190, 0x21ff], // Arrows
  [0x2200, 0x22ff], // Math Operators
  [0x25a0, 0x25ff], // Geometric Shapes
  [0x2600, 0x26ff], // Misc Symbols
  [0x13000, 0x1342f], // Egyptian Hieroglyphs
];
function buildType2() {
  const seen = new Set();
  const out = [];
  for (const [lo, hi] of TYPE2_BLOCKS) {
    for (const ch of rangeToChars(lo, hi)) {
      if (!seen.has(ch)) {
        seen.add(ch);
        out.push(ch);
      }
    }
  }
  return out;
}

function buildType3() {
  return {
    base: buildType1(), // safe ASCII base — no Cyrillic/Greek/Arabic/Hieroglyphs/Math/homoglyphs
    variationSelectors: rangeToChars(0xfe00, 0xfe0f),
    combiningDiacritics: rangeToChars(0x0300, 0x036f),
    puaChars: rangeToChars(0xe000, 0xf8ff),
    zwj: String.fromCodePoint(0x200d),
  };
}

// Fixed subsets used for the "minimum digits" / "minimum special chars"
// guarantees. These are always plain, undecorated ASCII, and always a
// subset of every tier's alphabet (Type1 is ASCII; Type2/Type3 both
// include the Type1 range as a strict subset).
const DIGIT_CHARS = rangeToChars(0x30, 0x39); // '0'-'9'
const SPECIAL_CHARS = [
  ...rangeToChars(0x21, 0x2f), // ! " # $ % & ' ( ) * + , - . /
  ...rangeToChars(0x3a, 0x40), // : ; < = > ? @
  ...rangeToChars(0x5b, 0x60), // [ \ ] ^ _ `
  ...rangeToChars(0x7b, 0x7e), // { | } ~
];

/* ---------------------------------------------------------------------
 * Entropy: local CSPRNG always, QRNG best-effort supplement
 * ------------------------------------------------------------------- */

const ANU_QRNG_ENDPOINT = "https://qrng.anu.edu.au/API/jsonI.php";
const FETCH_TIMEOUT_MS = 1500;

function getLocalBytes(length) {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

async function fetchQrngBytes(length) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${ANU_QRNG_ENDPOINT}?length=${length}&type=uint8`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.success || !Array.isArray(json.data)) return null;
    return Uint8Array.from(json.data);
  } catch (e) {
    return null; // timeout / offline / rate-limited — fine, local CSPRNG covers us
  } finally {
    clearTimeout(timer);
  }
}

function concatBytes(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
function toArrayBuffer(bytes) {
  return bytes.slice().buffer;
}

async function mixEntropy(sources, outputLength) {
  const ikm = concatBytes(sources.filter(Boolean));

  const salt = getLocalBytes(32);
  const hmacKey = await crypto.subtle.importKey(
    "raw", toArrayBuffer(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, toArrayBuffer(ikm)));

  const prkKey = await crypto.subtle.importKey(
    "raw", toArrayBuffer(prk), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );

  const out = new Uint8Array(outputLength);
  let offset = 0, counter = 1, prevBlock = new Uint8Array(0);
  while (offset < outputLength) {
    const input = concatBytes([prevBlock, new Uint8Array([counter])]);
    const block = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, toArrayBuffer(input)));
    const take = Math.min(block.length, outputLength - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
    prevBlock = block;
    counter++;
  }
  return out;
}

async function getMixedEntropy(outputLength) {
  const wantQrng = Math.min(1024, Math.max(32, outputLength));
  const qrngBytes = await fetchQrngBytes(wantQrng);
  const localBytes = getLocalBytes(Math.max(32, outputLength));
  return mixEntropy([localBytes, qrngBytes], outputLength);
}

/* ---------------------------------------------------------------------
 * Generator: rejection sampling, exactly uniform over each alphabet
 * ------------------------------------------------------------------- */

class RejectionSampler {
  constructor(pool) {
    this.pool = pool;
    this.pos = 0;
  }
  nextByte() {
    if (this.pos >= this.pool.length) throw new Error("Entropy pool exhausted");
    return this.pool[this.pos++];
  }
  nextIndex(max) {
    if (max <= 0) throw new Error("max must be > 0");
    const bytesNeeded = Math.ceil(Math.log2(max) / 8) || 1;
    const range = 256 ** bytesNeeded;
    const limit = range - (range % max);
    for (;;) {
      let value = 0;
      for (let i = 0; i < bytesNeeded; i++) value = value * 256 + this.nextByte();
      if (value < limit) return value % max;
    }
  }
}

function overFetchBytes(length, alphabetSize) {
  const bytesPerSymbol = Math.ceil(Math.log2(Math.max(2, alphabetSize)) / 8) || 1;
  // *3 (not *2) since guaranteed-char draws + the Fisher-Yates shuffle
  // both consume extra bytes from the same pool.
  return length * bytesPerSymbol * 3 + 128;
}

/** Unbiased in-place Fisher-Yates shuffle using the same entropy pool. */
function shuffleInPlace(arr, sampler) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = sampler.nextIndex(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function assertMinimums(length, minDigits, minSpecial) {
  if (minDigits < 0 || minSpecial < 0) throw new Error("minimums cannot be negative");
  if (minDigits + minSpecial > length) {
    throw new Error(
      `minimum digits (${minDigits}) + minimum special chars (${minSpecial}) exceeds password length (${length})`
    );
  }
}

async function generateType1Or2(type, length, minDigits, minSpecial) {
  assertMinimums(length, minDigits, minSpecial);
  const alphabet = type === 1 ? buildType1() : buildType2();
  const pool = await getMixedEntropy(overFetchBytes(length, alphabet.length));
  const sampler = new RejectionSampler(pool);

  const chars = [];
  for (let i = 0; i < minDigits; i++) chars.push(DIGIT_CHARS[sampler.nextIndex(DIGIT_CHARS.length)]);
  for (let i = 0; i < minSpecial; i++) chars.push(SPECIAL_CHARS[sampler.nextIndex(SPECIAL_CHARS.length)]);
  const fillerCount = length - minDigits - minSpecial;
  for (let i = 0; i < fillerCount; i++) chars.push(alphabet[sampler.nextIndex(alphabet.length)]);

  shuffleInPlace(chars, sampler);

  // Lower-bound entropy estimate: content-selection entropy only. The
  // shuffle adds some additional uncertainty on top of this, so the true
  // entropy is >= this figure, not exactly equal to it.
  const entropyBits =
    minDigits * Math.log2(DIGIT_CHARS.length) +
    minSpecial * Math.log2(SPECIAL_CHARS.length) +
    fillerCount * Math.log2(alphabet.length);

  return { value: chars.join(""), entropyBits };
}

async function generateType3(length, minDigits, minSpecial) {
  assertMinimums(length, minDigits, minSpecial);
  const t3 = buildType3();
  const decorationsPerBase = 1 + t3.variationSelectors.length + t3.combiningDiacritics.length;
  const decoratedCount = t3.base.length * decorationsPerBase;
  const totalSymbols = decoratedCount + t3.puaChars.length;

  const pool = await getMixedEntropy(overFetchBytes(length, totalSymbols));
  const sampler = new RejectionSampler(pool);

  function drawDecoratedSymbol() {
    const idx = sampler.nextIndex(totalSymbols);
    if (idx < decoratedCount) {
      const baseIdx = Math.floor(idx / decorationsPerBase);
      const decoIdx = idx % decorationsPerBase;
      let s = t3.base[baseIdx];
      if (decoIdx > 0 && decoIdx <= t3.variationSelectors.length) {
        s += t3.variationSelectors[decoIdx - 1];
      } else if (decoIdx > t3.variationSelectors.length) {
        s += t3.combiningDiacritics[decoIdx - 1 - t3.variationSelectors.length];
      }
      return s;
    }
    return t3.puaChars[idx - decoratedCount];
  }

  // Digit/special guarantees are always inserted as plain undecorated
  // ASCII — that's what site-side "contains a digit" checks actually
  // look for, and it keeps the guarantee robust regardless of how a
  // particular validator handles combining sequences.
  const units = [];
  for (let i = 0; i < minDigits; i++) units.push(DIGIT_CHARS[sampler.nextIndex(DIGIT_CHARS.length)]);
  for (let i = 0; i < minSpecial; i++) units.push(SPECIAL_CHARS[sampler.nextIndex(SPECIAL_CHARS.length)]);
  const fillerCount = length - minDigits - minSpecial;
  for (let i = 0; i < fillerCount; i++) units.push(drawDecoratedSymbol());

  shuffleInPlace(units, sampler);

  const entropyBits =
    minDigits * Math.log2(DIGIT_CHARS.length) +
    minSpecial * Math.log2(SPECIAL_CHARS.length) +
    fillerCount * Math.log2(totalSymbols);

  return { value: units.join(""), entropyBits };
}

async function generatePassword(type, length, minDigits, minSpecial) {
  minDigits = minDigits || 0;
  minSpecial = minSpecial || 0;
  if (!Number.isInteger(length) || length < 4 || length > 128) {
    throw new Error("length must be between 4 and 128");
  }
  if (type === 1 || type === 2) return generateType1Or2(type, length, minDigits, minSpecial);
  if (type === 3) return generateType3(length, minDigits, minSpecial);
  throw new Error("unknown type: " + type);
}

/* ---------------------------------------------------------------------
 * UI wiring
 * ------------------------------------------------------------------- */

const lengthSelect = document.getElementById("length");
const complexitySelect = document.getElementById("complexity");
const minDigitsSelect = document.getElementById("min-digits");
const minSpecialSelect = document.getElementById("min-special");
const fillBtn = document.getElementById("fill-btn");
const statusEl = document.getElementById("status");
const type3Note = document.getElementById("type3-note");

complexitySelect.addEventListener("change", () => {
  type3Note.hidden = complexitySelect.value !== "3";
});

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

fillBtn.addEventListener("click", async () => {
  fillBtn.disabled = true;
  setStatus("Generating…");

  try {
    const length = parseInt(lengthSelect.value, 10);
    const type = parseInt(complexitySelect.value, 10);
    const minDigits = parseInt(minDigitsSelect.value, 10);
    const minSpecial = parseInt(minSpecialSelect.value, 10);

    const { value, entropyBits } = await generatePassword(type, length, minDigits, minSpecial);

    const tab = await getActiveTab();
    if (!tab) throw new Error("No active tab found.");

    const response = await browser.tabs.sendMessage(tab.id, {
      type: "truegen-fill",
      value,
    });

    if (response && response.ok) {
      setStatus(`Inserted a ${length}-character password (~${entropyBits.toFixed(0)} bits).`, "ok");
    } else {
      setStatus((response && response.error) || "Could not insert password into the page.", "err");
    }
  } catch (err) {
    setStatus("Error: " + err.message, "err");
  } finally {
    fillBtn.disabled = false;
  }
});
