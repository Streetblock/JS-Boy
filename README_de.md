# JS-Boy

Read me in English: [README.md](./README.md)

JS-Boy ist eine browserbasierte Game-Boy-Oberflaeche mit einem eigenen Emulator-Kern in JavaScript.

Das Projekt begann als einzelne HTML-Datei und wurde spaeter in eine sauberere, GitHub-taugliche Struktur aufgeteilt:

- `index.html` fuer das Markup
- `style.css` fuer das Game-Boy-UI-Styling
- `app.js` fuer UI-Logik, i18n, ROM-Loading und Save-Import/Export
- `lib/emulator.js` fuer den Emulator-Kern

## Features

- Game-Boy-UI im Browser
- ROM-Loading im Browser
- Save-RAM-Import/Export (`.sav`)
- lokale Save-Persistenz ueber `localStorage`
- einfacher Multi-Language-Support fuer die UI
  - Deutsch
  - Englisch
- eigener Emulator-Kern mit:
  - CPU
  - MMU
  - Timer
  - PPU
  - APU
  - Joypad
  - MBC1 / MBC3 / MBC5 Support

## Projektstruktur

```text
.
|-- index.html
|-- style.css
|-- app.js
`-- lib/
    `-- emulator.js
```

## Lokal starten

Da die App ES-Module verwendet, solltest du sie ueber einen lokalen Webserver starten statt `index.html` direkt als Datei zu oeffnen.

Beispiel mit Python:

```bash
python -m http.server 8000
```

Dann im Browser oeffnen:

```text
http://localhost:8000
```

## Steuerung

- Steuerkreuz: Pfeiltasten oder `WASD`
- `A`: `Z`, `Y` oder `J`
- `B`: `X` oder `K`
- `START`: `Enter`
- `SELECT`: rechte Umschalttaste

## Aktueller Emulator-Stand

Der Emulator ist weiterhin Work in Progress, aber mehrere wichtige Luecken wurden bereits geschlossen.

Juengere Verbesserungen:

- `ADD SP, r8` (`0xE8`) implementiert
- verzoegertes `EI` / IME-Enable-Verhalten
- HALT-Bug-Behandlung bei pending Interrupts
- Support fuer den Serial-Interrupt-Vektor
- grundlegende Serial-Transfer-Register (`FF01` / `FF02`)
- grundlegender MBC3-RTC-Register-Support
- MBC3-RTC-Persistenz ueber Reloads hinweg
- Synchronisierung von Timer-Register-Schreibzugriffen
- verzoegertes `TIMA`-Reload nach Overflow
- korrektes `LY`-Reset-Verhalten bei `FF44`-Writes
- OAM-Blockierung waehrend DMA
- VRAM-/OAM-Zugriffsbeschraenkungen je nach PPU-Mode

## Bekannte Einschraenkungen

JS-Boy ist noch kein cycle-accurate Emulator.

Bekannte Luecken und Risiken:

- Kompatibilitaet ist fuer kommerzielle ROMs noch unvollstaendig
- PPU- und DMA-Timing wurden verbessert, sind aber weiter vereinfacht
- MBC3-RTC-Support ist grundlegend, aber nicht voll hardwaregenau
- Color-Game-Boy-Support fehlt noch
- einige Cartridge-Typen sind weiterhin nicht unterstuetzt
- Audio-Emulation funktioniert, ist aber nicht hardwaregenau

## UI-Sprachsupport

Die UI kann ueber den Sprachwaehler im rechten Panel zwischen Deutsch und Englisch umgeschaltet werden.

Aktuell uebersetzt:

- Splash-Text
- Ueberschriften und Labels in Storage/Controls
- ROM-Load-Label
- CPU-Status-Ueberschrift
- Save-/Load-Statusmeldungen

## Speichern

JS-Boy speichert Save-RAM pro ROM-Checksumme in `localStorage`.

Fuer MBC3-Cartridges wird zusaetzlich der RTC-Zustand separat in `localStorage` gespeichert.

## Entwicklungshinweise

Der Emulator-Kern liegt aktuell in:

- [lib/emulator.js](./lib/emulator.js)

Die UI-Einstiegspunkte sind:

- [index.html](./index.html)
- [style.css](./style.css)
- [app.js](./app.js)

## Lizenz

Aktuell wurde noch keine Lizenz hinzugefuegt.
