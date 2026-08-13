# TrueGen — Local Password Generator for Firefox

TrueGen is a small, dependency-free Firefox extension that generates
strong passwords entirely inside your browser and inserts them directly
into whatever field you have focused. It doesn't store, sync, transmit,
or log anything it generates.

---
## Why

Most password generators either live in a paid manager or run on a
website you have to trust with the output. TrueGen is neither: it's a
single-purpose local tool. You open the popup, pick a complexity level
and length, click **Fill**, and the password lands in the field — nothing
is copied to the clipboard, shown in a text box, or written to disk.

## Features

- **Three complexity tiers**
  - **Type 1 — Standard:** ASCII letters, digits, and basic symbols (~94
    characters). Works everywhere.
  - **Type 2 — Global:** Type 1 plus real-world scripts and symbol blocks
    (Greek, Cyrillic, Armenian, Hebrew, Arabic, Georgian, Devanagari,
    math operators, arrows, Egyptian hieroglyphs, etc — ~3,700+
    characters).
  - **Type 3 — Safe-Extended:** Type 1's ASCII base only (deliberately
    *excludes* Cyrillic/Greek/Arabic/Hieroglyphs/Math symbols, since
    mixed-script strings are a common trigger for WAF/fraud filters and
    can cause collation issues in some databases), decorated with
    invisible/combining modifiers — Unicode variation selectors
    (U+FE00–FE0F), combining diacritics (U+0300–U+036F), and Private Use
    Area characters (U+E000–F8FF) — for extra entropy without adding
    multi-script bytes.
- **Minimum-character guarantees.** Optionally require a minimum number
  of digits and/or classic ASCII special characters, for sites with
  "password must contain a digit" rules. Guaranteed characters are drawn
  from their own subset and then cryptographically shuffled into random
  positions — never appended in a predictable pattern. Defaults to 0 for
  both (no guarantee, maximum entropy); the UI warns that raising either
  value trades away some entropy.
- **Hybrid entropy.** Every password mixes:
  - Your OS's CSPRNG (`crypto.getRandomValues`) — always available, and
    cryptographically sufficient on its own.
  - A best-effort draw from the [ANU Quantum Random Number
    Generator](https://qrng.anu.edu.au/) public API, blended in via an
    HMAC-SHA256 extract-and-expand step (HKDF-style). If the QRNG call
    times out, is rate-limited, or you're offline, generation falls back
    silently to local-only entropy — nothing blocks or fails because of
    the network.
- **Unbiased character selection.** Uses rejection sampling, not modulo
  reduction, so every symbol is exactly uniform over its alphabet — no
  bias toward low byte values.
- **Zero storage.** No `browser.storage` calls, no vault, no sync. The
  generated string exists only in local variables for the duration of
  one click, then goes out of scope.

## How it works

```
Popup click
  → gather local CSPRNG bytes + (best-effort) QRNG bytes
  → HMAC-SHA256 mix (HKDF-style) into a uniform byte pool
  → rejection-sample characters from the selected alphabet
  → (optional) draw guaranteed digit/special chars, Fisher–Yates shuffle
  → send the final string to the content script for this tab
  → content script writes it into the last-focused input/textarea
    via the native property setter + input/change events
```

Nothing round-trips through the clipboard or a visible text field by
default — the password is written straight into the page's DOM element.

## Installation (temporary add-on)

TrueGen isn't signed or published, so it has to be loaded manually and
will need reloading each time Firefox restarts:

1. Download and unzip the release, or clone this repo.
2. In Firefox, go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**
4. Select `manifest.json` from the project folder.

## Usage

1. Click into the password (or any text) field on a page.
2. Open the TrueGen toolbar icon.
3. Pick a **length** (8–32) and **complexity type** (1/2/3).
4. Optionally set a **minimum digits** / **minimum special characters**
   requirement if the site demands it.
5. Click **Fill focused field**.
6. Complete the form as normal. If you want the password saved,
   Firefox's own "Save Login?" prompt will appear on submit — check the
   reminder box in the popup as a personal note, but see the caveat
   below.

## Limitations & honest caveats

- **Type 3 may not work everywhere.** Invisible/combining Unicode
  characters are accepted by most modern login forms but can be
  stripped, rejected, or mis-normalized by some backends. If a site
  rejects a Type 3 password, regenerate with Type 1 or 2.
- **No save-state verification.** There is no WebExtension API that lets
  an add-on read or confirm Firefox's native password-save prompt. The
  "I saved this password" checkbox in the popup is a personal reminder
  only — it cannot verify anything, and the popup says so.
- **QRNG is a supplement, not a dependency.** The public ANU QRNG API is
  rate-limited and sometimes slow or unreachable; TrueGen is designed to
  degrade gracefully to local-only entropy in that case, silently and
  without delay to you.
- **Unsigned / temporary-only.** This hasn't gone through AMO review, so
  Firefox will drop it on restart. Re-load it via `about:debugging` as
  needed, or package and sign it yourself if you want persistence.
- **Reported entropy is an estimate.** The bits shown after each
  generation are a lower-bound approximation (character-selection
  entropy), especially once minimum-digit/special guarantees are in
  play — treat it as directional, not a precise cryptographic claim.

## Project structure

```
truegen-extension/
├── manifest.json    # Manifest V2, Firefox
├── popup.html       # Popup UI markup
├── popup.css         # Popup styling
├── popup.js          # Alphabets, entropy mixing, generator, UI logic (single file, no build step)
└── content.js         # Tracks the last-focused field per page, writes the password into it
```

No build step, no bundler, no external runtime dependencies — every file
is loaded as-is by the browser.

## Contributing

Issues and pull requests are welcome. If you're proposing a change to the
entropy mixing or character-selection logic, please include a rationale
for why it preserves (or improves) uniformity — this is a
security-sensitive path.

## License

MIT

## Disclaimer

TrueGen is provided as-is, without warranty of any kind. It is an
independent project and is not affiliated with, endorsed by, or
associated with the Mozilla Foundation. "Firefox" is a trademark of the
Mozilla Foundation, referenced here only to describe browser
compatibility.
