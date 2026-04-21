# JS-Boy

Lies mich auf Deutsch: [README_de.md](./README_de.md)

JS-Boy is a browser-based Game Boy emulator UI with a custom JavaScript emulator core.

The `main` branch is the stable branch and is intended to back the GitHub Pages deployment of the project.

An experimental Game Boy Color branch is available at `feat/cgb-core`. That branch contains ongoing CGB work and may be more unstable than `main`.

The project started as a single HTML file and was later split into a cleaner GitHub-friendly structure:

- `index.html` for markup
- `style.css` for the Game Boy UI styling
- `app.js` for UI wiring, i18n, ROM loading, and save import/export
- `lib/emulator.js` for the emulator core

## Features

- Game Boy-style browser UI
- ROM loading from the browser
- Save RAM import/export (`.sav`)
- Local save persistence via `localStorage`
- Basic multi-language UI support
  - German
  - English
- Custom emulator core with:
  - CPU
  - MMU
  - Timer
  - PPU
  - APU
  - Joypad
  - MBC1 / MBC3 / MBC5 support

## Project Structure

```text
.
|-- index.html
|-- style.css
|-- app.js
`-- lib/
    `-- emulator.js
```

## Running Locally

Because the app uses ES modules, you should serve it through a local web server instead of opening `index.html` directly as a file.

Example with Python:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Controls

- D-pad: Arrow keys or `WASD`
- `A`: `Z`, `Y`, or `J`
- `B`: `X` or `K`
- `START`: `Enter`
- `SELECT`: Right Shift

## Current Emulator Status

This is still a work-in-progress emulator, but several important gaps have already been closed.

Recent improvements include:

- `ADD SP, r8` (`0xE8`) implemented
- delayed `EI` / IME enable behavior
- HALT bug handling for pending interrupts
- Serial interrupt vector support
- basic serial transfer registers (`FF01` / `FF02`)
- basic MBC3 RTC register support
- MBC3 RTC persistence across reloads
- timer register synchronization
- deferred `TIMA` reload after overflow
- `LY` reset behavior on `FF44` writes
- OAM blocking during DMA
- VRAM / OAM access restrictions based on PPU mode

## Known Limitations

JS-Boy is not a cycle-accurate emulator yet.

Known gaps and risks include:

- compatibility is still incomplete across commercial ROMs
- PPU and DMA timing are improved, but still simplified
- MBC3 RTC support is basic, not fully hardware-accurate
- Color Game Boy support is still missing
- some cartridge types are still unsupported
- audio emulation is functional but not hardware-accurate

## UI Language Support

The UI can be switched between German and English from the language selector in the right-side panel.

Currently translated:

- splash text
- storage / controls panel labels
- ROM loading label
- CPU status heading
- save / load status messages

## Saving

JS-Boy stores save RAM in `localStorage` per ROM checksum.

For MBC3 cartridges, RTC state is also stored separately in `localStorage`.

## Development Notes

The emulator core currently lives in:

- [lib/emulator.js](./lib/emulator.js)

The UI entry points are:

- [index.html](./index.html)
- [style.css](./style.css)
- [app.js](./app.js)

## License

No license has been added yet.
