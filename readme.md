# TrueGen — Local Cryptographic Password Generator for Firefox

**Version 2.0.0** · Zero external runtime dependencies · Manifest V2 · Unminified, auditable JavaScript · 119/119 automated tests passing

TrueGen is a local, dependency-free Firefox extension that generates high-entropy passwords inside your browser and writes them directly into the focused input field. By default it never stores, logs, or transmits passwords. When you opt into advanced modes, it also provides **Shamir Secret Sharing** (including **Pure Information-Theoretic Shamir** with zero external verification tags), **Argon2id** local share encryption, **offline entropy file mixing**, and a standalone **One-Time Pad + unconditional Carter–Wegman MAC** tool.

> **Install on Firefox:** published on [addons.mozilla.org (AMO)](https://www.google.com/search?q=https://addons.mozilla.org/firefox/addon/truegen-password-generator/).
> Use the AMO listing for regular installation; the temporary add-on steps below are only needed for local development.

---

## What's New in v2.0.0

Following a review of emerging cryptographic threats in the AI & quantum era (including Henry Yuen's *"Quantum Cryptography for the AI Age"*), v2.0.0 upgrades TrueGen's architecture from single-primitive reliance to dual-family defense-in-depth and optional information-theoretic primitives:

- **Dual-Family Entropy Combiner (`HKDF-HMAC-SHA256 ⊕ BLAKE2b-512-CTR`)**: Combines two independent hash families (Merkle–Damgård ⊕ ARX) with length-prefixed IKM and strict intermediate buffer zeroing (`lib/core.js`, `lib/argon2id.js`).
- **Offline Entropy File Mixing**: Load any local file (e.g., USB-QRNG dump or dice rolls, up to 2 MiB) into RAM to mix into both password generation and One-Time Pads. Never persisted to storage; zeroed on clear and `pagehide`.
- **Pure IT-Shamir Mode (`pureIT: true`)**: Manual-only $k$-of-$n$ splits with `verifyTag: null` (0 bits leaked below threshold even if $P = NP$) and an internal non-linear 128-bit `TGIT || BLAKE2b-128` trailer inside the Shamir polynomial to defeat Tompa–Woll linear share-tampering attacks. 100% backward-compatible with legacy HMAC-SHA256 splits.
- **One-Time Pad (OTP) + Unconditional Carter–Wegman MAC (`lib/otp-cw.js`)**: Pure-JS Vernam encryption ($C = M \oplus K$) paired with a branchless $\text{GF}(2^{128})$ GHASH Carter–Wegman MAC (NIST SP 800-38D polynomial `0xe1`, verified against NIST Test Cases 2 & 4 and OpenSSL AES-128-GCM). Wire formats: `TGOTP1:<ct>.<tag>` and `TGPAD1:<pad>`.
- **Argon2id (RFC 9106) Local Share Encryption (`lib/argon2id.js`)**: OWASP-profile Argon2id (19 MiB, $t=2$, $p=1$, verified bit-for-bit against RFC 9106 Section 5.3) replaces PBKDF2 for new local shares while keeping legacy PBKDF2 decryption intact.
- **Type 6 — Hyper-Extended Unicode & Extended Lengths (4–100,000 chars)**: Multi-modifier Unicode (~47.6 bits/symbol) added as Type 6; Custom Alphabet moved to Type 7 with automatic `v2 → v3` settings migration.
- **Security Tier Badge & AMO Hardening**: Live indicator in the popup (`Minicrypt` / `Minicrypt · IT-Secure (OTP)` / `IT-Secure`), `Pure IT` badge in the in-page secret menu, **0 `innerHTML`**, and **0 `Math.random()`** across all 8 runtime JS files.

---

## Features

### 1. Seven Complexity Tiers

| Tier | Name | Alphabet & Characteristics | Approx. Entropy / Symbol | Intended Use |
| :--- | :--- | :--- | :--- | :--- |
| **Type 1** | Standard | ASCII letters, digits, punctuation (~94 chars) | ~6.55 bits | Standard logins & Wi-Fi |
| **Type 2** | Global | Type 1 + classical scripts & extended symbols | ~8.7 bits | International / banking logins |
| **Type 3** | Safe-Extended | Safe ASCII base + invisible/combining modifiers (no mixed scripts) | ~12+ bits | Hardened forms that accept UTF-8 |
| **Type 4** | Practical Maximum | ~94,500 base chars (CJK, Hangul, symbols, PUA) + modifiers | ~25.7 bits | Password vaults / offline keys |
| **Type 5** | Absolute Maximum | Nearly the entire valid Unicode codespace (~1.1M codepoints) | ~29.8 bits | Cryptographic seeds / vaults |
| **Type 6** | Hyper-Extended | Full valid Unicode base + up to 3 independent modifiers per symbol | **~47.6 bits** | Offline master keys / disk encryption |
| **Type 7** | Custom | User-selected Unicode categories and/or literal chars & `U+XXXX-U+YYYY` ranges | Depends on set | Site-specific custom policies |

- **Length:** Slider from `4` to `256` characters, plus a custom numeric override supporting **4 to 100,000 characters** (chunked `crypto.getRandomValues` at 64 KiB and HKDF at 4 KiB).
- **Uniform Selection:** Strict rejection sampling (zero modulo bias) with optional minimum digit/special guarantees, obvious-run avoidance (re-shuffling only, without shrinking the alphabet), and Deep-mix per-character reshaking.
- **Local Password Audit:** Inspects the currently focused password field locally to estimate character classes, pattern runs, and rough entropy without sending anything over the network.

### 2. Dual-Family Entropy & Offline Entropy Mixing

1. Fresh local CSPRNG bytes (`crypto.getRandomValues`).
2. Optional parallel HTTPS requests to [ANU Quantum RNG](https://qrng.anu.edu.au/) and the [drand](https://drand.love/) public randomness beacon (can be disabled completely via checkbox — verified by `tests/network-entropy.test.js`).
3. Optional user-provided **offline entropy file** (up to 2 MiB, kept strictly in RAM, zeroed on Clear and `pagehide`).
4. All non-empty sources are length-prefixed (`u32le(len) || bytes`) and mixed through **both**:
   - `HKDF-HMAC-SHA256` (Merkle–Damgård family), and
   - `BLAKE2b-512-CTR` (ARX family) with domain separation (`TrueGen-v2-BLAKE2b-Extract` / `Expand`).
   - Final output = `HKDF_stream ⊕ BLAKE2b_stream`. All intermediate buffers (`ikm`, `salt`, `prk`, `seed`, `b2bStream`, partial chunks) are zeroed in `finally`.

### 3. Distributed Storage (Shamir Secret Sharing & Pure IT-Shamir)

Split a generated password into $n$ shares with threshold $k$ ($2 \le k \le n$) over $\text{GF}(256)$:

- **Local Share:** Stored in `browser.storage.local`, encrypted with AES-256-GCM using a key derived from your PIN/passphrase via **Argon2id** (19 MiB, $t=2$, $p=1$). Includes exponential UI lockout on repeated failed attempts.
- **Manual Holders:** One or more named recipients, each receiving a unique one-time **Crockford Base32** code with a CRC-8 typo checksum. Never stored by the extension.
- **Cloud Share:** Stored per-split in `browser.storage.sync` (Firefox Sync). Protects against losing a single device, *not* against device coercion.
- **Pure IT-Shamir (`pureIT: true`):** Disables Local and Cloud shares and omits the external HMAC-SHA256 verification tag (`verifyTag: null`), embedding a non-linear 20-byte `TGIT || BLAKE2b-128` trailer inside the polynomial instead. Fewer than $k$ shares leak strictly **0 bits** even to a computationally unbounded adversary.
- **Secret Menu (`Ctrl+Shift+Y`):** Opens a closed Shadow DOM overlay on any page to reconstruct and autofill saved splits (with `Pure IT` badges and rename/delete controls).
- **Backup & Restore:** Export/import local split metadata and encrypted local shares as versioned JSON (`exportSplitsBundle` / `parseSplitsBundle` / `mergeImportedSplits`).

### 4. One-Time Pad + Carter–Wegman MAC

Available in the collapsible **One-Time Pad** section of the popup (`lib/otp-cw.js`):

- **Encryption:** $C = M \oplus K_{\text{enc}}$, authenticated with $\text{Tag} = \text{GHASH}(r, \text{AAD}, C) \oplus s$ where $(r, s)$ is a fresh 32-byte one-time MAC key appended to the pad.
- **Security Guarantee:** Provided the pad is uniformly random and **never reused**, confidentiality is information-theoretic (0 bits leaked) and forgery probability is bounded by $(\lceil |C|/16 \rceil + 2) \cdot 2^{-128}$ even against an unbounded adversary.
- **Hygiene:** Plaintext input is cleared immediately after encryption; decrypted output is cleared whenever ciphertext/pad inputs change; all buffers are zeroed in `finally` and on `pagehide`.

---

## Security & Privacy Architecture

- **Zero external runtime dependencies** — no npm runtime packages, no bundlers, no minifiers, no remote scripts.
- **Strict CSP:** `script-src 'self'; object-src 'none'`.
- **Zero `innerHTML` & Zero `Math.random()`** across all 8 runtime JS files (`background.js`, `content.js`, `popup.js`, `lib/*.js`). Both Shadow DOM panels in `content.js` use `mode: "closed"` and pure `document.createElement` / `replaceChildren`.
- **No telemetry or analytics:** `data_collection_permissions.required: ["none"]`.
- **Network requests:** Only made when *"Query quantum RNG"* is checked, strictly to `https://qrng.anu.edu.au/*` and `https://api.drand.sh/*` — never sending passwords, domains, or user data.

### Permissions Explained

| Permission | Why It Is Needed |
| :--- | :--- |
| `contextMenus` | Right-click *"Fill password (TrueGen)"* menu on editable fields. |
| `storage` | Persist user preferences, encrypted local Shamir shares, and optional Firefox Sync cloud shares. |
| `clipboardWrite` | Support *"Generate to clipboard"* mode and Copy buttons (shares, OTP, donation addresses). |
| `<all_urls>` | Inject `content.js` so autofill, password audit, and the `Ctrl+Shift+Y` secret menu work on any site. |
| `https://qrng.anu.edu.au/*`, `https://api.drand.sh/*` | Optional external entropy mixing when *"Query quantum RNG"* is enabled. |

---

## Project Structure

```text
├── manifest.json              # Firefox Manifest V2 (version 2.0.0)
├── background.js              # Context menus, storage/sync routing, split reconstruction & rate limiting
├── content.js                 # Closed Shadow DOM quick picker & secret menu (0 innerHTML, 0 Math.random)
├── popup.html / popup.css / popup.js  # Extension popup & tab-mode UI (Tier Badge, Split, OTP, Offline Entropy)
├── lib/
│   ├── argon2id.js            # Pure-JS BLAKE2b-512 & Argon2id (RFC 9106)
│   ├── core.js                # Dual-family entropy mixer, 7 alphabet tiers, rejection sampler, audit, settings migration
│   ├── secret-sharing.js      # GF(256) Shamir split/combine, Pure IT BLAKE2b-128 trailer, Crockford Base32, Argon2id/AES-GCM
│   ├── split-vault.js         # Split record builder, reconstruction, JSON export/import, lockout math
│   └── otp-cw.js              # One-Time Pad + branchless GF(2^128) GHASH Carter–Wegman MAC
├── _locales/
│   ├── en/messages.json       # English UI strings (132 keys)
│   └── ru/messages.json       # Russian UI strings (132 keys, strict parity)
├── icons/                     # 16, 32, 48, 96, 128 px extension icons
├── scripts/
│   └── build-release.js       # Zero-dependency cross-platform validator & AMO .zip packager
├── tests/                     # 119 Node.js unit, crypto-vector, regression & smoke tests
├── unicode-password-viewer.html  # Standalone offline Unicode character inspector
├── eslint.config.js           # ESLint 9 flat config mirroring classic <script> load order
└── CHANGELOG.md               # Release history
```

---

## Development, Testing & Building

Requires **Node.js 18+** (uses built-in `node:test`, `crypto.webcrypto`, and `zlib` — zero runtime dependencies).

```bash
# Run all 119 automated tests (crypto vectors, Shamir, OTP/GHASH, dual mixer, regressions, smoke tests)
npm test

# Validate manifest/package versions, runtime files, and EN/RU locale key parity
npm run check

# Build clean AMO-ready package -> dist/truegen-v2.0.0-amo.zip (18 runtime files)
npm run build
```

### Local Installation in Firefox (Development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and select `manifest.json` (or `dist/truegen-v2.0.0-amo.zip`).
3. Click the TrueGen toolbar icon, or right-click any password field and select **Fill password (TrueGen)**.

---

## Honest Limitations & Caveats

- **JavaScript string immutability:** TrueGen zeros every `Uint8Array` buffer containing entropy, keys, shares, or pads as soon as it is done with them, but JavaScript strings (such as the final password string or pasted OTP text) are immutable and remain in heap memory until garbage-collected by the browser engine.
- **Clipboard managers:** When using *"Generate to clipboard"* or Copy buttons, OS clipboard history tools may retain copied values — extensions cannot control external clipboard managers.
- **One-Time Pad reuse:** Never reuse a `TGPAD1` pad for two different messages. Reusing a pad breaks both Vernam confidentiality and the Carter–Wegman MAC (allowing key recovery via the Forbidden Attack).
- **Exotic Unicode compatibility:** Types 4, 5, and 6 are intended for offline vaults, disk encryption, and master keys — most standard web login forms will reject or normalize high-plane Unicode and stacked modifiers.

---

## Localization

TrueGen ships with full **English (`en`)** and **Russian (`ru`)** translations (132 keys, automatically checked for parity by `npm run check`). To add a new language, copy `_locales/en/messages.json` to `_locales/<code>/messages.json` and translate the `message` values.

---

## Disclaimer

TrueGen is provided as-is, without warranty of any kind. It is an independent project and is not affiliated with, endorsed by, or associated with the Mozilla Foundation. "Firefox" is a trademark of the Mozilla Foundation, referenced solely to describe browser compatibility.
