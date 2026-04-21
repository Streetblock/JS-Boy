const emulatorHooks = {
    updateDebugInfo: () => {},
    setSaveStatus: () => {},
};
let DebugOpcodes = [];
let currentRomChecksum = null;
let saveRamDebounceTimer = null;
function emitSaveStatus(message, timeout = 2000) {
    emulatorHooks.setSaveStatus(message, timeout);
}

function loadRtcState() {
    if (!currentRomChecksum) {
        return null;
    }

    const rawRtcState = localStorage.getItem(`jsboy_rtc_${currentRomChecksum}`);
    if (!rawRtcState) {
        return null;
    }

    try {
        return JSON.parse(rawRtcState);
    } catch (error) {
        console.error("Fehler beim Laden des RTC-Zustands:", error);
        return null;
    }
}

function persistRtcState(state) {
    if (!currentRomChecksum) {
        return;
    }

    localStorage.setItem(`jsboy_rtc_${currentRomChecksum}`, JSON.stringify(state));
}
export function configureEmulatorHooks(hooks = {}) {
    if (typeof hooks.updateDebugInfo === 'function') {
        emulatorHooks.updateDebugInfo = hooks.updateDebugInfo;
    }
    if (typeof hooks.setSaveStatus === 'function') {
        emulatorHooks.setSaveStatus = hooks.setSaveStatus;
    }
}
export function resetDebugOpcodes() {
    DebugOpcodes = [];
}
export function getCurrentRomChecksum() {
    return currentRomChecksum;
}

function detectHardwareMode(romData) {
    const cgbFlag = romData[0x0143];
    return cgbFlag === 0x80 || cgbFlag === 0xC0 ? 'CGB' : 'DMG';
}

        function calculateRomChecksum(romData) {
            let checksum = 0;
            for (let i = 0; i < romData.length; i++) {
                checksum = (checksum + romData[i] * (i % 257)) & 0xFFFFFFFF;
            }
            return checksum.toString(16).padStart(8, '0');
        }

        // --- Joypad ---
        class Joypad {
            constructor(mmu) {
                 this.mmu = mmu;
                this.keys = {
                    RIGHT: false, LEFT: false, UP: false, DOWN: false,
                    A: false, B: false, SELECT: false, START: false
                };
                this.column = 0x00;
            }

            keyDown(key) {
                this.keys[key] = true;
                let ifReg = this.mmu.readByte(0xFF0F);
                this.mmu.writeByte(0xFF0F, ifReg | 0x10);
            }
            keyUp(key) { this.keys[key] = false; }

            writeByte(value) {
                this.column = value & 0x30;
            }

            readByte() {
                let val = 0xFF;

                if ((this.column & 0x10) === 0) { // P14: Direction keys
                    if (this.keys.RIGHT) val &= ~0x01;
                    if (this.keys.LEFT)  val &= ~0x02;
                    if (this.keys.UP)    val &= ~0x04;
                    if (this.keys.DOWN)  val &= ~0x08;
                }
                if ((this.column & 0x20) === 0) { // P15: Action keys
                    if (this.keys.A)      val &= ~0x01;
                    if (this.keys.B)      val &= ~0x02;
                    if (this.keys.SELECT) val &= ~0x04;
                    if (this.keys.START)  val &= ~0x08;
                }
                return val | this.column | 0xC0;
            }
        }

        // --- Memory Bank Controllers (MBC) ---
        class ROMOnly {
            constructor(romData) {
                this.romData = romData;
            }

            readByte(address) {
                if (address >= 0x0000 && address <= 0x7FFF) {
                    return this.romData[address];
                }
                if (address >= 0xA000 && address <= 0xBFFF) {
                    return 0xFF; // No RAM
                }
            }

            writeByte(address, value) {
                // ROM is read-only, no RAM
            }
        }

        class MBC1 {
            constructor(romData, savedRam = null) {
                this.romData = romData;
                this.ram = new Uint8Array(0x8000); // Max 32KB RAM
                if (savedRam) this.ram.set(savedRam);
                this.romBank = 1;
                this.ramBank = 0;
                this.ramEnabled = false;
                this.mode = 0;
            }

            readByte(address) {
                if (address >= 0x0000 && address <= 0x3FFF) {
                    return this.romData[address];
                }
                if (address >= 0x4000 && address <= 0x7FFF) {
                    const offset = this.romBank * 0x4000;
                    return this.romData[offset + (address - 0x4000)];
                }
                if (address >= 0xA000 && address <= 0xBFFF) {
                    if (!this.ramEnabled) {
                        return 0xFF;
                    }
                    const offset = this.ramBank * 0x2000;
                    return this.ram[offset + (address - 0xA000)];
                }
                return 0xFF;
            }

            writeByte(address, value) {
                if (address >= 0x0000 && address <= 0x1FFF) {
                    this.ramEnabled = (value & 0x0A) === 0x0A;
                } else if (address >= 0x2000 && address <= 0x3FFF) {
                    let bank = value & 0x1F;
                    if (bank === 0) bank = 1;
                    this.romBank = (this.romBank & 0xE0) | bank;
                } else if (address >= 0x4000 && address <= 0x5FFF) {
                    if (this.mode === 0) {
                        this.romBank = (this.romBank & 0x1F) | ((value & 0x03) << 5);
                    } else {
                        this.ramBank = value & 0x03;
                    }
                } else if (address >= 0x6000 && address <= 0x7FFF) {
                    this.mode = value & 0x01;
                } else if (address >= 0xA000 && address <= 0xBFFF) {
                    if (this.ramEnabled) {
                        const offset = this.ramBank * 0x2000;
                        this.ram[offset + (address - 0xA000)] = value;
                        this.requestSave();
                    }
                }
            }
             requestSave() {
                clearTimeout(saveRamDebounceTimer);
                saveRamDebounceTimer = setTimeout(() => {
                    const saveData = btoa(String.fromCharCode.apply(null, this.ram));
                    localStorage.setItem(`jsboy_save_${currentRomChecksum}`, saveData);
                    emitSaveStatus("Spielstand gespeichert.", 2000);
                }, 1500);
            }
        }

        class MBC3 {
            constructor(romData, savedRam = null, savedRtc = null) {
                this.romData = romData;
                this.ram = new Uint8Array(0x8000);
                if (savedRam) this.ram.set(savedRam);
                this.romBank = 1;
                this.ramBank = 0;
                this.ramEnabled = false;
                this.rtcEpochMs = Date.now();
                this.rtcOffsetSeconds = 0;
                this.rtcHalted = false;
                this.rtcHaltSeconds = 0;
                this.rtcDayCarry = 0;
                this.rtcLatchState = 0;
                if (savedRtc) {
                    this.rtcEpochMs = savedRtc.rtcEpochMs ?? this.rtcEpochMs;
                    this.rtcOffsetSeconds = savedRtc.rtcOffsetSeconds ?? this.rtcOffsetSeconds;
                    this.rtcHalted = savedRtc.rtcHalted ?? this.rtcHalted;
                    this.rtcHaltSeconds = savedRtc.rtcHaltSeconds ?? this.rtcHaltSeconds;
                    this.rtcDayCarry = savedRtc.rtcDayCarry ?? this.rtcDayCarry;
                }
                this.latchedRtcRegisters = this._computeRtcRegisters();
            }

            _getRtcTotalSeconds() {
                if (this.rtcHalted) {
                    return this.rtcHaltSeconds;
                }

                const elapsedSeconds = Math.floor((Date.now() - this.rtcEpochMs) / 1000);
                return this.rtcOffsetSeconds + elapsedSeconds;
            }

            _computeRtcRegisters() {
                const totalSeconds = this._getRtcTotalSeconds();
                const seconds = totalSeconds % 60;
                const totalMinutes = Math.floor(totalSeconds / 60);
                const minutes = totalMinutes % 60;
                const totalHours = Math.floor(totalMinutes / 60);
                const hours = totalHours % 24;
                const totalDays = Math.floor(totalHours / 24);
                const days = totalDays & 0x1FF;
                const dayHigh = (days >> 8) & 0x01;
                const carry = this.rtcDayCarry || totalDays > 0x1FF ? 0x80 : 0x00;
                const halt = this.rtcHalted ? 0x40 : 0x00;

                return {
                    0x08: seconds & 0x3F,
                    0x09: minutes & 0x3F,
                    0x0A: hours & 0x1F,
                    0x0B: days & 0xFF,
                    0x0C: dayHigh | halt | carry,
                };
            }

            _applyRtcRegisters(registers) {
                const days = ((registers[0x0C] & 0x01) << 8) | registers[0x0B];
                const totalSeconds = (((days * 24) + registers[0x0A]) * 60 + registers[0x09]) * 60 + registers[0x08];

                this.rtcDayCarry = (registers[0x0C] & 0x80) !== 0 ? 1 : 0;
                this.rtcHalted = (registers[0x0C] & 0x40) !== 0;

                if (this.rtcHalted) {
                    this.rtcHaltSeconds = totalSeconds;
                } else {
                    this.rtcOffsetSeconds = totalSeconds;
                    this.rtcEpochMs = Date.now();
                }
            }

            _writeRtcRegister(register, value) {
                const registers = this._computeRtcRegisters();

                switch (register) {
                    case 0x08:
                        registers[0x08] = value % 60;
                        break;
                    case 0x09:
                        registers[0x09] = value % 60;
                        break;
                    case 0x0A:
                        registers[0x0A] = value % 24;
                        break;
                    case 0x0B:
                        registers[0x0B] = value & 0xFF;
                        break;
                    case 0x0C:
                        registers[0x0C] = value & 0xC1;
                        break;
                    default:
                        return;
                }

                this._applyRtcRegisters(registers);
            }

            _getRtcState() {
                return {
                    rtcEpochMs: this.rtcEpochMs,
                    rtcOffsetSeconds: this.rtcOffsetSeconds,
                    rtcHalted: this.rtcHalted,
                    rtcHaltSeconds: this.rtcHaltSeconds,
                    rtcDayCarry: this.rtcDayCarry,
                };
            }

            readByte(address) {
                if (address >= 0x0000 && address <= 0x3FFF) {
                    return this.romData[address];
                }
                if (address >= 0x4000 && address <= 0x7FFF) {
                    const offset = this.romBank * 0x4000;
                    return this.romData[offset + (address - 0x4000)];
                }
                if (address >= 0xA000 && address <= 0xBFFF) {
                    if (this.ramEnabled) {
                        if (this.ramBank <= 0x03) {
                             const offset = this.ramBank * 0x2000;
                             return this.ram[offset + (address - 0xA000)];
                        }
                        if (this.ramBank >= 0x08 && this.ramBank <= 0x0C) {
                            return this.latchedRtcRegisters[this.ramBank] ?? 0xFF;
                        }
                        return 0xFF;
                    }
                    return 0xFF;
                }
            }

            writeByte(address, value) {
                 if (address >= 0x0000 && address <= 0x1FFF) {
                    this.ramEnabled = (value & 0x0A) === 0x0A;
                } else if (address >= 0x2000 && address <= 0x3FFF) {
                    let bank = value & 0x7F;
                    if (bank === 0) bank = 1;
                    this.romBank = bank;
                } else if (address >= 0x4000 && address <= 0x5FFF) {
                    this.ramBank = value & 0x0F;
                } else if (address >= 0x6000 && address <= 0x7FFF) {
                    const latchValue = value & 0x01;
                    if (this.rtcLatchState === 0 && latchValue === 1) {
                        this.latchedRtcRegisters = this._computeRtcRegisters();
                    }
                    this.rtcLatchState = latchValue;
                } else if (address >= 0xA000 && address <= 0xBFFF) {
                    if (this.ramEnabled) {
                         if (this.ramBank <= 0x03) {
                            const offset = this.ramBank * 0x2000;
                            this.ram[offset + (address - 0xA000)] = value;
                            this.requestSave();
                         } else if (this.ramBank >= 0x08 && this.ramBank <= 0x0C) {
                            this._writeRtcRegister(this.ramBank, value);
                            this.latchedRtcRegisters = this._computeRtcRegisters();
                            this.requestSave();
                         }
                    }
                }
            }
            requestSave() {
                clearTimeout(saveRamDebounceTimer);
                saveRamDebounceTimer = setTimeout(() => {
                    const saveData = btoa(String.fromCharCode.apply(null, this.ram));
                    localStorage.setItem(`jsboy_save_${currentRomChecksum}`, saveData);
                    persistRtcState(this._getRtcState());
                    emitSaveStatus("Spielstand gespeichert.", 2000);
                }, 1500);
            }
        }

        class MBC5 {
            constructor(romData, gameboy = null, savedRam = null) {
                this.romData = romData;
                this.ram = new Uint8Array(0x20000); // 128 KB RAM
                if (savedRam) this.ram.set(savedRam);
                this.romBank = 1;
                this.ramBank = 0;
                this.ramEnabled = false;
                this.gameboy = gameboy;
            }

            readByte(address) {
                if (address >= 0x0000 && address <= 0x3FFF) {
                    return this.romData[address];
                }
                if (address >= 0x4000 && address <= 0x7FFF) {
                    const romOffset = this.romBank * 0x4000;
                    return this.romData[romOffset + (address - 0x4000)];
                }
                if (address >= 0xA000 && address <= 0xBFFF) {
                    if (this.ramEnabled) {
                        const ramOffset = this.ramBank * 0x2000;
                        return this.ram[ramOffset + (address - 0xA000)];
                    }
                    return 0xFF;
                }
                return 0xFF;
            }

            writeByte(address, value) {
                if (address >= 0x0000 && address <= 0x1FFF) {
                    this.ramEnabled = (value & 0x0F) === 0x0A;
                } else if (address >= 0x2000 && address <= 0x2FFF) {
                    const bankLower = value;
                    this.romBank = (this.romBank & 0x100) | bankLower;
                } else if (address >= 0x3000 && address <= 0x3FFF) {
                    const bankUpper = (value & 0x01) << 8;
                    this.romBank = (this.romBank & 0xFF) | bankUpper;
                } else if (address >= 0x4000 && address <= 0x5FFF) {
                    this.ramBank = value & 0x0F;
                    const isRumbleOn = (value & 0x08) !== 0;
                    if (this.gameboy && typeof this.gameboy.setRumble === 'function') {
                        this.gameboy.setRumble(isRumbleOn);
                    }
                } else if (address >= 0xA000 && address <= 0xBFFF) {
                    if (this.ramEnabled) {
                        const ramOffset = this.ramBank * 0x2000;
                        this.ram[ramOffset + (address - 0xA000)] = value;
                        this.requestSave();
                    }
                }
            }
             requestSave() {
                clearTimeout(saveRamDebounceTimer);
                saveRamDebounceTimer = setTimeout(() => {
                    const saveData = btoa(String.fromCharCode.apply(null, this.ram));
                    localStorage.setItem(`jsboy_save_${currentRomChecksum}`, saveData);
                    emitSaveStatus("Spielstand gespeichert.", 2000);
                }, 1500);
            }
        }

        // --- Memory Management Unit (MMU) ---
        class MMU {
            constructor(gameboy) {
                this.memory = new Uint8Array(0x10000);
                this.vramBanks = [
                    new Uint8Array(0x2000),
                    new Uint8Array(0x2000),
                ];
                this.wramBanks = Array.from({ length: 8 }, () => new Uint8Array(0x1000));
                this.bgPaletteData = new Uint8Array(0x40);
                this.vramBank = 0;
                this.wramBank = 1;
                this.bgPaletteIndex = 0;
                this.bgPaletteAutoIncrement = false;
                this.joypad = new Joypad(this);
                this.apu = null;
                this.timer = null;
                this.mbc = null;
                this.gameboy = gameboy;
                this.oamDmaCyclesRemaining = 0;
            }

            readByte(address) {
                if (address <= 0x7FFF || (address >= 0xA000 && address <= 0xBFFF)) {
                    return this.mbc.readByte(address);
                }
                if (address >= 0xFF10 && address <= 0xFF26) {
                    return this.apu.readByte(address);
                }
                if (address >= 0xFF30 && address <= 0xFF3F) {
                    return this.apu.readByte(address);
                }
                if (address === 0xFF00) {
                    return this.joypad.readByte();
                }
                if (address >= 0x8000 && address <= 0x9FFF) {
                    if (this.isPpuMode(3)) {
                        return 0xFF;
                    }
                    return this.readVramByte(address);
                }
                if (address >= 0xC000 && address <= 0xDFFF) {
                    return this.readWramByte(address);
                }
                if (address >= 0xFE00 && address <= 0xFE9F) {
                    if (this.isOamDmaActive() || this.isPpuMode(2) || this.isPpuMode(3)) {
                        return 0xFF;
                    }
                    return this.memory[address];
                }
                if (address === 0xFF4F) {
                    return 0xFE | this.getActiveVramBank();
                }
                if (address === 0xFF68) {
                    return 0x40 | (this.bgPaletteAutoIncrement ? 0x80 : 0x00) | (this.bgPaletteIndex & 0x3F);
                }
                if (address === 0xFF69) {
                    return this.readBgPaletteByte();
                }
                if (address === 0xFF70) {
                    return 0xF8 | this.getActiveWramBank();
                }
                 if (address >= 0xE000 && address <= 0xFDFF) {
                     return this.readWramByte(address - 0x2000);
                }
                return this.memory[address];
            }

            readWord(address) {
                return this.readByte(address) | (this.readByte(address + 1) << 8);
            }

            writeByte(address, value) {
                if (address <= 0x7FFF || (address >= 0xA000 && address <= 0xBFFF)) {
                    this.mbc.writeByte(address, value);
                    return;
                }
                if (address >= 0xFF10 && address <= 0xFF26) {
                    this.apu.writeByte(address, value);
                    return;
                }
                 if (address >= 0xFF30 && address <= 0xFF3F) {
                    this.apu.writeByte(address, value);
                    return;
                }
                if (address === 0xFF00) {
                    this.joypad.writeByte(value);
                    return;
                }
                if (address === 0xFF04) {
                    this.timer.div = 0;
                    this.timer.divClock = 0;
                    this.memory[address] = 0;
                    return;
                }
                if (address >= 0xFF05 && address <= 0xFF07) {
                    this.timer.writeRegister(address, value);
                    return;
                }
                if (address === 0xFF44) {
                    this.memory[address] = 0;
                    if (this.gameboy && this.gameboy.ppu) {
                        this.gameboy.ppu.line = 0;
                    }
                    return;
                }
                if (address === 0xFF46) {
                    this.dmaTransfer(value);
                    return;
                }
                if (address === 0xFF01) {
                    this.memory[address] = value;
                    return;
                }
                if (address === 0xFF02) {
                    this.serialTransfer(value);
                    return;
                }
                if (address === 0xFF4F) {
                    if (this.gameboy && this.gameboy.hardwareMode === 'CGB') {
                        this.vramBank = value & 0x01;
                    }
                    this.memory[address] = 0xFE | this.getActiveVramBank();
                    return;
                }
                if (address === 0xFF68) {
                    if (this.gameboy && this.gameboy.hardwareMode === 'CGB') {
                        this.bgPaletteIndex = value & 0x3F;
                        this.bgPaletteAutoIncrement = (value & 0x80) !== 0;
                    } else {
                        this.bgPaletteIndex = 0;
                        this.bgPaletteAutoIncrement = false;
                    }
                    this.memory[address] = 0x40 | (this.bgPaletteAutoIncrement ? 0x80 : 0x00) | (this.bgPaletteIndex & 0x3F);
                    return;
                }
                if (address === 0xFF69) {
                    this.writeBgPaletteByte(value);
                    return;
                }
                if (address >= 0x8000 && address <= 0x9FFF) {
                    if (this.isPpuMode(3)) {
                        return;
                    }
                    this.writeVramByte(address, value);
                    return;
                }
                if (address >= 0xC000 && address <= 0xDFFF) {
                    this.writeWramByte(address, value);
                    return;
                }
                if (address >= 0xFE00 && address <= 0xFE9F) {
                    if (this.isOamDmaActive() || this.isPpuMode(2) || this.isPpuMode(3)) {
                        return;
                    }
                    this.memory[address] = value;
                    return;
                }
                if (address === 0xFF70) {
                    if (this.gameboy && this.gameboy.hardwareMode === 'CGB') {
                        const requestedBank = value & 0x07;
                        this.wramBank = requestedBank === 0 ? 1 : requestedBank;
                    } else {
                        this.wramBank = 1;
                    }
                    this.memory[address] = 0xF8 | this.getActiveWramBank();
                    return;
                }
                 if (address >= 0xE000 && address <= 0xFDFF) {
                    this.writeWramByte(address - 0x2000, value);
                    return;
                }
                this.memory[address] = value;
            }

            writeWord(address, value) {
                this.writeByte(address, value & 0xFF);
                this.writeByte(address + 1, (value >> 8) & 0xFF);
            }

            isOamDmaActive() {
                return this.oamDmaCyclesRemaining > 0;
            }

            isPpuMode(mode) {
                return this.gameboy && this.gameboy.ppu && this.gameboy.ppu.mode === mode;
            }

            getActiveVramBank() {
                if (!this.gameboy || this.gameboy.hardwareMode !== 'CGB') {
                    return 0;
                }
                return this.vramBank & 0x01;
            }

            readVramByte(address) {
                return this.vramBanks[this.getActiveVramBank()][address - 0x8000];
            }

            writeVramByte(address, value) {
                this.vramBanks[this.getActiveVramBank()][address - 0x8000] = value;
            }

            readBgPaletteByte() {
                if (!this.gameboy || this.gameboy.hardwareMode !== 'CGB') {
                    return 0xFF;
                }
                return this.bgPaletteData[this.bgPaletteIndex & 0x3F];
            }

            writeBgPaletteByte(value) {
                if (!this.gameboy || this.gameboy.hardwareMode !== 'CGB') {
                    return;
                }
                this.bgPaletteData[this.bgPaletteIndex & 0x3F] = value;
                if (this.bgPaletteAutoIncrement) {
                    this.bgPaletteIndex = (this.bgPaletteIndex + 1) & 0x3F;
                    this.memory[0xFF68] = 0x40 | 0x80 | this.bgPaletteIndex;
                }
            }

            getActiveWramBank() {
                if (!this.gameboy || this.gameboy.hardwareMode !== 'CGB') {
                    return 1;
                }
                return this.wramBank & 0x07 || 1;
            }

            readWramByte(address) {
                if (address >= 0xC000 && address <= 0xCFFF) {
                    return this.wramBanks[0][address - 0xC000];
                }
                return this.wramBanks[this.getActiveWramBank()][address - 0xD000];
            }

            writeWramByte(address, value) {
                if (address >= 0xC000 && address <= 0xCFFF) {
                    this.wramBanks[0][address - 0xC000] = value;
                    return;
                }
                this.wramBanks[this.getActiveWramBank()][address - 0xD000] = value;
            }

            step(cycles) {
                if (this.oamDmaCyclesRemaining > 0) {
                    this.oamDmaCyclesRemaining = Math.max(0, this.oamDmaCyclesRemaining - cycles);
                }
            }

            serialTransfer(value) {
                this.memory[0xFF02] = value & 0x83;

                if ((value & 0x80) === 0) {
                    return;
                }

                if ((value & 0x01) !== 0) {
                    const serialByte = this.memory[0xFF01];
                    if (serialByte >= 0x20 && serialByte <= 0x7E) {
                        console.log(`Serial: ${String.fromCharCode(serialByte)}`);
                    }
                }

                this.memory[0xFF02] &= ~0x80;
                const ifReg = this.readByte(0xFF0F);
                this.memory[0xFF0F] = ifReg | 0x08;
            }

            dmaTransfer(value) {
                const startAddress = value << 8;
                this.oamDmaCyclesRemaining = 160;
                for (let i = 0; i < 0xA0; i++) {
                    this.memory[0xFE00 + i] = this.readByte(startAddress + i);
                }
            }

            // Corrected loadRom method in MMU, which accepts savedRam
            loadRom(romData, savedRam, savedRtc = null, hardwareMode = 'DMG') {
                const cartridgeType = romData[0x0147];
                this.gameboy.hardwareMode = hardwareMode;
                this.vramBank = 0;
                this.wramBank = 1;
                this.bgPaletteIndex = 0;
                this.bgPaletteAutoIncrement = false;
                this.memory[0xFF4F] = 0xFE;
                this.memory[0xFF68] = 0x40;
                this.memory[0xFF70] = 0xF9;
                this.vramBanks[0].fill(0);
                this.vramBanks[1].fill(0);
                this.wramBanks.forEach((bank) => bank.fill(0));
                this.bgPaletteData.fill(0);
                console.log(`Cartridge Type: 0x${cartridgeType.toString(16).toUpperCase()}`);
                console.log(`Hardware Mode: ${hardwareMode}`);

                switch (cartridgeType) {
                    case 0x00:
                        console.log("MBC: ROM Only");
                        this.mbc = new ROMOnly(romData);
                        break;
                    case 0x01: case 0x02: case 0x03:
                        console.log("MBC: MBC1");
                        this.mbc = new MBC1(romData, savedRam);
                        break;
                    case 0x0F: case 0x10: case 0x11: case 0x12: case 0x13:
                        console.log("MBC: MBC3");
                        this.mbc = new MBC3(romData, savedRam, savedRtc);
                        break;
                  case 0x19: case 0x1A: case 0x1B: case 0x1C: case 0x1D: case 0x1E:
                        console.log("MBC: MBC5");
                        this.mbc = new MBC5(romData, this.gameboy, savedRam);
                        break;
                    default:
                        alert(`Unsupported Cartridge Type: 0x${cartridgeType.toString(16)}`);
                        throw new Error(`Unsupported Cartridge Type: 0x${cartridgeType.toString(16)}`);
                }
                console.log(`MMU: ROM loaded, size: ${romData.length} Bytes.`);
            }
        }

        // --- Timer ---
        class Timer {
            constructor(mmu) {
                this.mmu = mmu;
                this.div = 0; // Divider Register (0xFF04)
                this.tima = 0; // Timer Counter (0xFF05)
                this.tma = 0; // Timer Modulo (0xFF06)
                this.tac = 0; // Timer Control (0xFF07)
                this.divClock = 0;
                this.timaClock = 0;
                this.timaReloadDelay = 0;
            }

            step(cycles) {
                this.divClock += cycles;
                while (this.divClock >= 256) {
                    this.divClock -= 256;
                    this.div = (this.div + 1) & 0xFF;
                    this.mmu.memory[0xFF04] = this.div;
                }

                this.tac = this.mmu.readByte(0xFF07);
                let remainingCycles = cycles;

                while (remainingCycles > 0) {
                    if (this.timaReloadDelay > 0) {
                        const reloadStep = Math.min(remainingCycles, this.timaReloadDelay);
                        this.timaReloadDelay -= reloadStep;
                        remainingCycles -= reloadStep;

                        if (this.timaReloadDelay === 0) {
                            this.tima = this.tma;
                            this.mmu.memory[0xFF05] = this.tima;
                            let ifReg = this.mmu.readByte(0xFF0F);
                            this.mmu.writeByte(0xFF0F, ifReg | 0x04);
                        }

                        continue;
                    }

                    if ((this.tac & 0x04) === 0) { // Is timer enabled?
                        break;
                    }

                    const freq = this.getFrequency();
                    const cyclesUntilIncrement = freq - this.timaClock;
                    const stepCycles = Math.min(remainingCycles, cyclesUntilIncrement);

                    this.timaClock += stepCycles;
                    remainingCycles -= stepCycles;

                    if (this.timaClock < freq) {
                        continue;
                    }

                    this.timaClock -= freq;
                    if (this.tima === 0xFF) {
                        this.tima = 0x00;
                        this.mmu.memory[0xFF05] = this.tima;
                        this.timaReloadDelay = 4;
                    } else {
                        this.tima = (this.tima + 1) & 0xFF;
                        this.mmu.memory[0xFF05] = this.tima;
                    }
                }
            }

            getFrequency() {
                switch (this.tac & 0x03) {
                    case 0: return 1024;
                    case 1: return 16;
                    case 2: return 64;
                    case 3: return 256;
                }
                return 1024;
            }

            writeRegister(address, value) {
                switch (address) {
                    case 0xFF05:
                        this.tima = value & 0xFF;
                        this.timaReloadDelay = 0;
                        this.mmu.memory[address] = this.tima;
                        break;
                    case 0xFF06:
                        this.tma = value & 0xFF;
                        this.mmu.memory[address] = this.tma;
                        break;
                    case 0xFF07: {
                        const nextTac = value & 0x07;
                        const frequencyChanged = (this.tac & 0x03) !== (nextTac & 0x03);
                        const enabledChanged = (this.tac & 0x04) !== (nextTac & 0x04);
                        this.tac = nextTac;
                        this.mmu.memory[address] = this.tac;
                        if (frequencyChanged || enabledChanged) {
                            this.timaClock = 0;
                        }
                        break;
                    }
                }
            }
        }

        // --- Picture Processing Unit (PPU) ---
        class PPU {
            constructor(mmu, screenCtx) {
                this.mmu = mmu;
                this.ctx = screenCtx;
                this.mode = 2;
                this.modeClock = 0;
                this.line = 0;
                this.SCREEN_WIDTH = 160;
                this.SCREEN_HEIGHT = 144;
                this.screenData = this.ctx.createImageData(this.SCREEN_WIDTH, this.SCREEN_HEIGHT);
                this.bgLineBuffer = new Uint8Array(this.SCREEN_WIDTH);
                this.palette = [[155, 188, 15], [139, 172, 15], [48, 98, 48], [15, 56, 15]];
            }

            step(cycles) {
                const lcdc = this.mmu.readByte(0xFF40);
                if ((lcdc & 0x80) === 0) {
                    this.modeClock = 0;
                    this.line = 0;
                    this.mode = 1;
                    this.mmu.memory[0xFF44] = 0;
                    let stat = this.mmu.readByte(0xFF41) & 0xFC;
                    this.mmu.writeByte(0xFF41, stat | 0x01);
                    return;
                }

                this.modeClock += cycles;

                const stat = this.mmu.readByte(0xFF41);
                const lyc = this.mmu.readByte(0xFF45);

                if (this.line === lyc) {
                    if ((stat & 0x40) && !(stat & 0x04)) {
                        let ifReg = this.mmu.readByte(0xFF0F);
                        this.mmu.writeByte(0xFF0F, ifReg | 0x02);
                    }
                    this.mmu.memory[0xFF41] |= 0x04;
                } else {
                    this.mmu.memory[0xFF41] &= ~0x04;
                }

                let modeChanged = false;

                switch(this.mode) {
                    case 2: // OAM Search
                        if (this.modeClock >= 80) {
                            this.modeClock -= 80;
                            this.mode = 3;
                            modeChanged = true;
                        }
                        break;
                    case 3: // Drawing pixels
                        if (this.modeClock >= 172) {
                            this.modeClock -= 172;
                            this.mode = 0;
                            modeChanged = true;
                            if (stat & 0x08) {
                                let ifReg = this.mmu.readByte(0xFF0F);
                                this.mmu.writeByte(0xFF0F, ifReg | 0x02);
                            }
                            this.renderScanline();
                        }
                        break;
                    case 0: // H-Blank
                        if (this.modeClock >= 204) {
                            this.modeClock -= 204;
                            this.line++;
                            if (this.line === this.SCREEN_HEIGHT) {
                                this.mode = 1; // V-Blank
                                modeChanged = true;
                                if (stat & 0x10) {
                                    let ifReg = this.mmu.readByte(0xFF0F);
                                    this.mmu.writeByte(0xFF0F, ifReg | 0x02);
                                }
                                let ifReg = this.mmu.readByte(0xFF0F);
                                this.mmu.writeByte(0xFF0F, ifReg | 0x01);
                            } else {
                                this.mode = 2;
                                modeChanged = true;
                                if (stat & 0x20) {
                                    let ifReg = this.mmu.readByte(0xFF0F);
                                    this.mmu.writeByte(0xFF0F, ifReg | 0x02);
                                }
                            }
                        }
                        break;
                    case 1: // V-Blank
                        if (this.modeClock >= 456) {
                            this.modeClock -= 456;
                            this.line++;
                            if (this.line > 153) {
                                this.line = 0;
                                this.mode = 2;
                                modeChanged = true;
                                if (stat & 0x20) {
                                    let ifReg = this.mmu.readByte(0xFF0F);
                                    this.mmu.writeByte(0xFF0F, ifReg | 0x02);
                                }
                            }
                        }
                        break;
                }

                if (modeChanged) {
                    let currentStat = this.mmu.readByte(0xFF41);
                    currentStat = (currentStat & 0xFC) | (this.mode & 0x03);
                    this.mmu.writeByte(0xFF41, currentStat);
                }

                this.mmu.memory[0xFF44] = this.line;
            }

            renderScanline() {
                const lcdc = this.mmu.readByte(0xFF40);

                if ((lcdc & 0x01) === 0) {
                     for (let x = 0; x < this.SCREEN_WIDTH; x++) {
                        const bufferIndex = (this.line * this.SCREEN_WIDTH + x) * 4;
                        this.screenData.data[bufferIndex] = this.palette[0][0];
                        this.screenData.data[bufferIndex + 1] = this.palette[0][1];
                        this.screenData.data[bufferIndex + 2] = this.palette[0][2];
                        this.screenData.data[bufferIndex + 3] = 255;
                        this.bgLineBuffer[x] = 0;
                     }
                } else {
                    this.renderBackground(lcdc);
                }

                 if ((lcdc & 0x20) !== 0) {
                    this.renderWindow(lcdc);
                }
                if ((lcdc & 0x02) !== 0) {
                    this.renderSprites(lcdc);
                }
            }

            renderBackground(lcdc) {
                const scy = this.mmu.readByte(0xFF42);
                const scx = this.mmu.readByte(0xFF43);
                const bgp = this.mmu.readByte(0xFF47);

                const tileDataSelect = (lcdc & 0x10) ? 0x8000 : 0x8800;
                const tileMapSelect = (lcdc & 0x08) ? 0x9C00 : 0x9800;

                const y = (this.line + scy) & 0xFF;
                const tileRow = Math.floor(y / 8);
                const tileY = y % 8;

                for (let x = 0; x < this.SCREEN_WIDTH; x++) {
                    const mapX = (x + scx) & 0xFF;
                    const tileCol = Math.floor(mapX / 8);
                    const tileX = mapX % 8;

                    const tileMapIndex = tileRow * 32 + tileCol;
                    let tileId = this.mmu.readByte(tileMapSelect + tileMapIndex);

                    let tileAddress;
                    if (tileDataSelect === 0x8000) {
                        tileAddress = 0x8000 + (tileId * 16) + (tileY * 2);
                    }
                    else {
                        let signedTileId = tileId;
                        if (signedTileId > 127) {
                            signedTileId = signedTileId - 256;
                        }
                        tileAddress = 0x9000 + (signedTileId * 16) + (tileY * 2);
                    }

                    const byte1 = this.mmu.readByte(tileAddress);
                    const byte2 = this.mmu.readByte(tileAddress + 1);

                    const bit1 = (byte1 >> (7 - tileX)) & 1;
                    const bit2 = (byte2 >> (7 - tileX)) & 1;
                    const colorId = (bit2 << 1) | bit1;

                    this.bgLineBuffer[x] = colorId;

                    const colorIndex = (bgp >> (colorId * 2)) & 0x03;
                    const color = this.palette[colorIndex];

                    const bufferIndex = (this.line * this.SCREEN_WIDTH + x) * 4;
                    this.screenData.data[bufferIndex] = color[0];
                    this.screenData.data[bufferIndex + 1] = color[1];
                    this.screenData.data[bufferIndex + 2] = color[2];
                    this.screenData.data[bufferIndex + 3] = 255;
                }
            }

             renderWindow(lcdc) {
                const wy = this.mmu.readByte(0xFF4A);
                const wx = this.mmu.readByte(0xFF4B) - 7;

                if (this.line < wy || wx > this.SCREEN_WIDTH) return;

                const bgp = this.mmu.readByte(0xFF47);
                const tileDataSelect = (lcdc & 0x10) ? 0x8000 : 0x8800;
                const tileMapSelect = (lcdc & 0x40) ? 0x9C00 : 0x9800;

                const y = this.line - wy;
                const tileRow = Math.floor(y / 8);
                const tileY = y % 8;

                for (let x = wx; x < this.SCREEN_WIDTH; x++) {
                    if (x < 0) continue;

                    const mapX = x - wx;
                    const tileCol = Math.floor(mapX / 8);
                    const tileX = mapX % 8;

                    const tileMapIndex = tileRow * 32 + tileCol;
                    let tileId = this.mmu.readByte(tileMapSelect + tileMapIndex);

                    let tileAddress;
                    if (tileDataSelect === 0x8000) {
                        tileAddress = 0x8000 + (tileId * 16) + (tileY * 2);
                    } else {
                        let signedTileId = tileId;
                        if (signedTileId > 127) {
                            signedTileId = signedTileId - 256;
                        }
                        tileAddress = 0x9000 + (signedTileId * 16) + (tileY * 2);
                    }

                    const byte1 = this.mmu.readByte(tileAddress);
                    const byte2 = this.mmu.readByte(tileAddress + 1);

                    const bit1 = (byte1 >> (7 - tileX)) & 1;
                    const bit2 = (byte2 >> (7 - tileX)) & 1;
                    const colorId = (bit2 << 1) | bit1;

                    this.bgLineBuffer[x] = colorId;

                    const colorIndex = (bgp >> (colorId * 2)) & 0x03;
                    const color = this.palette[colorIndex];

                    const bufferIndex = (this.line * this.SCREEN_WIDTH + x) * 4;
                    this.screenData.data[bufferIndex] = color[0];
                    this.screenData.data[bufferIndex + 1] = color[1];
                    this.screenData.data[bufferIndex + 2] = color[2];
                    this.screenData.data[bufferIndex + 3] = 255;
                }
            }

            renderSprites(lcdc) {
                const spriteHeight = (lcdc & 0x04) ? 16 : 8;
                let visibleSprites = [];

                for (let i = 0; i < 40; i++) {
                    const oamAddr = 0xFE00 + (i * 4);
                    const yPos = this.mmu.readByte(oamAddr) - 16;

                    if (this.line >= yPos && this.line < (yPos + spriteHeight)) {
                        const xPos = this.mmu.readByte(oamAddr + 1) - 8;
                        const tileId = this.mmu.readByte(oamAddr + 2);
                        const attributes = this.mmu.readByte(oamAddr + 3);
                        visibleSprites.push({ yPos, xPos, tileId, attributes, oamIndex: i });
                    }
                }

                if (visibleSprites.length > 10) {
                    visibleSprites.sort((a, b) => a.xPos - b.xPos || a.oamIndex - b.oamIndex);
                    visibleSprites = visibleSprites.slice(0, 10);
                }

                for (const sprite of visibleSprites) {
                    let tileId = sprite.tileId;
                    const attributes = sprite.attributes;

                    const bgPriority = (attributes & 0x80);
                    const paletteReg = (attributes & 0x10) ? this.mmu.readByte(0xFF49) : this.mmu.readByte(0xFF48);
                    const yFlip = (attributes & 0x40);
                    const xFlip = (attributes & 0x20);

                    let tileY = this.line - sprite.yPos;
                    if (yFlip) {
                        tileY = spriteHeight - 1 - tileY;
                    }

                    if (spriteHeight === 16) {
                        if (tileY < 8) {
                            tileId = tileId & 0xFE;
                        } else {
                            tileId = (tileId & 0xFE) | 0x01;
                            tileY -= 8;
                        }
                    }

                    const tileAddress = 0x8000 + (tileId * 16) + (tileY * 2);
                    const byte1 = this.mmu.readByte(tileAddress);
                    const byte2 = this.mmu.readByte(tileAddress + 1);

                    for (let x = 0; x < 8; x++) {
                        const screenX = sprite.xPos + x;
                        if (screenX >= 0 && screenX < this.SCREEN_WIDTH) {

                            if (bgPriority && this.bgLineBuffer[screenX] !== 0) {
                                continue;
                            }

                            let tileX = x;
                            if (xFlip) {
                                tileX = 7 - x;
                            }

                            const bit1 = (byte1 >> (7 - tileX)) & 1;
                            const bit2 = (byte2 >> (7 - tileX)) & 1;
                            const colorId = (bit2 << 1) | bit1;

                            if (colorId === 0) continue;

                            const colorIndex = (paletteReg >> (colorId * 2)) & 0x03;
                            const color = this.palette[colorIndex];

                            const bufferIndex = (this.line * this.SCREEN_WIDTH + screenX) * 4;
                            this.screenData.data[bufferIndex] = color[0];
                            this.screenData.data[bufferIndex + 1] = color[1];
                            this.screenData.data[bufferIndex + 2] = color[2];
                            this.screenData.data[bufferIndex + 3] = 255;
                        }
                    }
                }
            }


            renderFrame() {
                this.ctx.putImageData(this.screenData, 0, 0);
            }
        }

        // --- APU Helper classes ---

        class Envelope {
            constructor() {
                this.volume = 0;
                this.initialVolume = 0;
                this.direction = 0; // 1 = increase, 0 = decrease
                this.period = 0;
                this.timer = 0;
            }

            step() {
                if (this.period === 0) return;
                this.timer--;
                if (this.timer <= 0) {
                    this.timer = this.period;
                    if (this.direction === 1 && this.volume < 15) {
                        this.volume++;
                    } else if (this.direction === 0 && this.volume > 0) {
                        this.volume--;
                    }
                }
            }

            trigger() {
                this.volume = this.initialVolume;
                this.timer = this.period;
            }
        }

        class PulseChannel {
             constructor(apu) {
                this.apu = apu;
                this.enabled = false;

                this.duty = 0;
                this.dutyStep = 0;
                this.waveforms = [
                    [0, 1, 1, 1, 1, 1, 1, 1], // 12.5%
                    [0, 0, 1, 1, 1, 1, 1, 1], // 25%
                    [0, 0, 0, 0, 1, 1, 1, 1], // 50%
                    [0, 0, 0, 0, 0, 0, 1, 1]  // 75%
                ];

                this.lengthCounter = 0;
                this.lengthEnabled = false;

                this.freq = 0;
                this.freqTimer = 0;

                this.envelope = new Envelope();
            }

            step(cycles) {
                this.freqTimer -= cycles;
                while (this.freqTimer <= 0) {
                    this.freqTimer += (2048 - this.freq) * 4;
                    this.dutyStep = (this.dutyStep + 1) % 8;
                }
            }

            getSample() {
                if (!this.enabled || this.lengthCounter === 0) return 0;
                const wave = this.waveforms[this.duty][this.dutyStep];
                return (wave * 2 - 1) * (this.envelope.volume / 15.0);
            }

            trigger() {
                this.enabled = true;
                if (this.lengthCounter === 0) {
                    this.lengthCounter = 64;
                }
                this.freqTimer = (2048 - this.freq) * 4;
                this.envelope.trigger();
            }

            clockLength() {
                if (this.lengthEnabled && this.lengthCounter > 0) {
                    this.lengthCounter--;
                    if (this.lengthCounter === 0) {
                        this.enabled = false;
                    }
                }
            }

            clockEnvelope() {
                this.envelope.step();
            }
        }

        class Channel1 extends PulseChannel {
             constructor(apu) {
                super(apu);
                // Sweep
                this.sweepPeriod = 0;
                this.sweepTimer = 0;
                this.sweepShift = 0;
                this.sweepDirection = 0; // 1 = decrease, 0 = increase
                this.sweepEnabled = false;
             }

             trigger() {
                super.trigger();
                this.sweepTimer = this.sweepPeriod;
                this.sweepEnabled = this.sweepPeriod > 0 || this.sweepShift > 0;
             }

             clockSweep() {
                 if (!this.sweepEnabled || this.sweepPeriod === 0) return;
                 this.sweepTimer--;
                 if (this.sweepTimer <= 0) {
                     this.sweepTimer = this.sweepPeriod;
                     const change = this.freq >> this.sweepShift;
                     const newFreq = this.freq + (this.sweepDirection ? -change : change);

                     if (newFreq < 2048) {
                         this.freq = newFreq;
                     } else {
                         this.enabled = false;
                     }
                 }
             }
        }

        class Channel2 extends PulseChannel {
             constructor(apu) {
                super(apu);
             }
        }

        class WaveChannel {
             constructor(apu) {
                this.apu = apu;
                this.enabled = false;
                this.dacEnabled = false;

                this.lengthCounter = 0;
                this.lengthEnabled = false;

                this.level = 0;
                this.freq = 0;
                this.freqTimer = 0;

                this.position = 0;
             }

             step(cycles) {
                this.freqTimer -= cycles;
                while (this.freqTimer <= 0) {
                    this.freqTimer += (2048 - this.freq) * 2;
                    this.position = (this.position + 1) % 32;
                }
             }

             getSample() {
                if (!this.enabled || !this.dacEnabled || this.lengthCounter === 0) return 0;

                const waveByte = this.apu.wavePattern[Math.floor(this.position / 2)];
                let sample = (this.position % 2 === 0) ? (waveByte >> 4) : (waveByte & 0x0F);

                if (this.level > 0) {
                    sample = sample >> (this.level - 1);
                } else {
                    sample = 0;
                }

                return (sample / 7.5) - 1.0;
             }

             trigger() {
                this.enabled = true;
                if (this.lengthCounter === 0) {
                    this.lengthCounter = 256;
                }
                this.freqTimer = (2048 - this.freq) * 2;
                this.position = 0;
             }

             clockLength() {
                if (this.lengthEnabled && this.lengthCounter > 0) {
                    this.lengthCounter--;
                    if (this.lengthCounter === 0) {
                        this.enabled = false;
                    }
                }
             }
        }

        class NoiseChannel {
            constructor(apu) {
                this.apu = apu;
                this.enabled = false;

                this.lengthCounter = 0;
                this.lengthEnabled = false;

                this.envelope = new Envelope();

                this.freqTimer = 0;
                this.lfsr = 0x7FFF;
                this.lfsrWidth = 0; // 0=15bit, 1=7bit
                this.clockShift = 0;
                this.dividingRatio = 0;
            }

            step(cycles) {
                this.freqTimer -= cycles;
                while (this.freqTimer <= 0) {
                    const divisor = [8, 16, 32, 48, 64, 80, 96, 112][this.dividingRatio];
                    this.freqTimer += divisor << this.clockShift;

                    const xorBit = (this.lfsr & 1) ^ ((this.lfsr >> 1) & 1);
                    this.lfsr = this.lfsr >> 1;
                    this.lfsr |= (xorBit << 14);

                    if (this.lfsrWidth) {
                        this.lfsr &= ~(1 << 6);
                        this.lfsr |= (xorBit << 6);
                    }
                }
            }

            getSample() {
                if (!this.enabled || this.lengthCounter === 0) return 0;
                const bit = (~this.lfsr & 1);
                return (bit * 2 - 1) * (this.envelope.volume / 15.0);
            }

            trigger() {
                this.enabled = true;
                if (this.lengthCounter === 0) {
                    this.lengthCounter = 64;
                }
                this.lfsr = 0x7FFF;
                this.envelope.trigger();
            }

            clockLength() {
                if (this.lengthEnabled && this.lengthCounter > 0) {
                    this.lengthCounter--;
                    if (this.lengthCounter === 0) {
                        this.enabled = false;
                    }
                }
            }

            clockEnvelope() {
                this.envelope.step();
            }
        }


        // --- Audio Processing Unit (APU) ---
        class APU {
            constructor(mmu) {
                this.mmu = mmu;
                this.enabled = false;
                this.audioCtx = null;
                this.gainNode = null;
                this.scriptNode = null;
                this.buffer = [];

                this.volume = 0.1;
                this.isMuted = true;

                this.sampleRate = 44100;
                this.bufferSize = 4096; //2048
                this.cyclesPerSample = 4194304 / this.sampleRate;

                this.cycleCounter = 0;
                this.frameSequencerCounter = 8192; // 512 Hz
                this.frameSequencerStep = 0;

                this.wavePattern = new Uint8Array(16);

                this.ch1 = new Channel1(this);
                this.ch2 = new Channel2(this);
                this.ch3 = new WaveChannel(this);
                this.ch4 = new NoiseChannel(this);
            }

            init() {
                if (this.audioCtx) return;
                this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                this.sampleRate = this.audioCtx.sampleRate;
                this.cyclesPerSample = 4194304 / this.sampleRate;

                this.gainNode = this.audioCtx.createGain();
                this.gainNode.gain.value = this.isMuted ? 0 : this.volume;
                this.gainNode.connect(this.audioCtx.destination);

                this.scriptNode = this.audioCtx.createScriptProcessor(this.bufferSize, 0, 1);
                this.scriptNode.onaudioprocess = (e) => this.generateAudio(e);
                this.scriptNode.connect(this.gainNode);
            }

            toggleMute() {
                if (!this.audioCtx) this.init();

                if (this.audioCtx.state === 'suspended') {
                    this.audioCtx.resume();
                }

                this.isMuted = !this.isMuted;
                this.gainNode.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.audioCtx.currentTime);
                return !this.isMuted;
            }

            step(cycles) {
                if (!this.enabled) return;

                this.ch1.step(cycles);
                this.ch2.step(cycles);
                this.ch3.step(cycles);
                this.ch4.step(cycles);

                this.frameSequencerCounter -= cycles;
                while (this.frameSequencerCounter <= 0) {
                    this.frameSequencerCounter += 8192;

                    if (this.frameSequencerStep % 2 === 0) { // 256Hz
                        this.ch1.clockLength();
                        this.ch2.clockLength();
                        this.ch3.clockLength();
                        this.ch4.clockLength();
                    }
                    if (this.frameSequencerStep === 2 || this.frameSequencerStep === 6) { // 128Hz
                        this.ch1.clockSweep();
                    }
                    if (this.frameSequencerStep === 7) { // 64Hz
                         this.ch1.clockEnvelope();
                         this.ch2.clockEnvelope();
                         this.ch4.clockEnvelope();
                    }

                    this.frameSequencerStep = (this.frameSequencerStep + 1) % 8;
                }

                this.cycleCounter += cycles;
                while (this.cycleCounter >= this.cyclesPerSample) {
                    this.cycleCounter -= this.cyclesPerSample;
                    this.generateSample();
                }
            }

            generateSample() {
                let mixedSample = 0;
                mixedSample += this.ch1.getSample();
                mixedSample += this.ch2.getSample();
                mixedSample += this.ch3.getSample();
                mixedSample += this.ch4.getSample();

                if (this.scriptNode && this.scriptNode.bufferSize > this.buffer.length) {
                     this.buffer.push(mixedSample / 4);
                }
            }

            generateAudio(e) {
                const output = e.outputBuffer.getChannelData(0);
                for (let i = 0; i < output.length; i++) {
                    output[i] = this.buffer.shift() || 0;
                }
            }

            readByte(address) {
                switch(address) {
                    case 0xFF10: return 0x80 | (this.ch1.sweepPeriod << 4) | (this.ch1.sweepDirection << 3) | this.ch1.sweepShift;
                    case 0xFF11: return (this.ch1.duty << 6) | 0x3F;
                    case 0xFF12: return (this.ch1.envelope.initialVolume << 4) | (this.ch1.envelope.direction << 3) | this.ch1.envelope.period;
                    case 0xFF13: return 0xFF;
                    case 0xFF14: return (this.ch1.lengthEnabled ? 0x40 : 0) | 0xBF;
                    case 0xFF16: return (this.ch2.duty << 6) | 0x3F;
                    case 0xFF17: return (this.ch2.envelope.initialVolume << 4) | (this.ch2.envelope.direction << 3) | this.ch2.envelope.period;
                    case 0xFF18: return 0xFF;
                    case 0xFF19: return (this.ch2.lengthEnabled ? 0x40 : 0) | 0xBF;
                    case 0xFF1A: return (this.ch3.dacEnabled ? 0x80 : 0) | 0x7F;
                    case 0xFF1B: return 0xFF;
                    case 0xFF1C: return (this.ch3.level << 5) | 0x9F;
                    case 0xFF1D: return 0xFF;
                    case 0xFF1E: return (this.ch3.lengthEnabled ? 0x40 : 0) | 0xBF;
                    case 0xFF20: return 0xFF;
                    case 0xFF21: return (this.ch4.envelope.initialVolume << 4) | (this.ch4.envelope.direction << 3) | this.ch4.envelope.period;
                    case 0xFF22: return (this.ch4.clockShift << 4) | (this.ch4.lfsrWidth << 3) | this.ch4.dividingRatio;
                    case 0xFF23: return (this.ch4.lengthEnabled ? 0x40 : 0) | 0xBF;

                    case 0xFF26:
                        return (this.enabled ? 0x80 : 0) |
                               0x70 |
                               (this.ch4.enabled ? 0x08 : 0) |
                               (this.ch3.enabled ? 0x04 : 0) |
                               (this.ch2.enabled ? 0x02 : 0) |
                               (this.ch1.enabled ? 0x01 : 0);

                    case 0xFF30: case 0xFF31: case 0xFF32: case 0xFF33:
                    case 0xFF34: case 0xFF35: case 0xFF36: case 0xFF37:
                    case 0xFF38: case 0xFF39: case 0xFF3A: case 0xFF3B:
                    case 0xFF3C: case 0xFF3D: case 0xFF3E: case 0xFF3F:
                        return this.wavePattern[address - 0xFF30];
                }
                return 0xFF;
            }

            writeByte(address, value) {
                if (address === 0xFF26) {
                    this.enabled = (value & 0x80) !== 0;
                    return;
                }

                if (!this.enabled) return;

                switch(address) {
                    case 0xFF10: this.ch1.sweepPeriod = (value >> 4) & 0x07; this.ch1.sweepDirection = (value >> 3) & 0x01; this.ch1.sweepShift = value & 0x07; break;
                    case 0xFF11: this.ch1.duty = value >> 6; this.ch1.lengthCounter = 64 - (value & 0x3F); break;
                    case 0xFF12: this.ch1.envelope.initialVolume = value >> 4; this.ch1.envelope.direction = (value >> 3) & 1; this.ch1.envelope.period = value & 0x07; break;
                    case 0xFF13: this.ch1.freq = (this.ch1.freq & 0x0700) | value; break;
                    case 0xFF14: this.ch1.freq = (this.ch1.freq & 0x00FF) | ((value & 0x07) << 8); this.ch1.lengthEnabled = (value & 0x40) !== 0; if ((value & 0x80) !== 0) { this.ch1.trigger(); } break;
                    case 0xFF16: this.ch2.duty = value >> 6; this.ch2.lengthCounter = 64 - (value & 0x3F); break;
                    case 0xFF17: this.ch2.envelope.initialVolume = value >> 4; this.ch2.envelope.direction = (value >> 3) & 1; this.ch2.envelope.period = value & 0x07; break;
                    case 0xFF18: this.ch2.freq = (this.ch2.freq & 0x0700) | value; break;
                    case 0xFF19: this.ch2.freq = (this.ch2.freq & 0x00FF) | ((value & 0x07) << 8); this.ch2.lengthEnabled = (value & 0x40) !== 0; if ((value & 0x80) !== 0) { this.ch2.trigger(); } break;
                    case 0xFF1A: this.ch3.dacEnabled = (value & 0x80) !== 0; break;
                    case 0xFF1B: this.ch3.lengthCounter = 256 - value; break;
                    case 0xFF1C: this.ch3.level = (value >> 5) & 0x03; break;
                    case 0xFF1D: this.ch3.freq = (this.ch3.freq & 0x0700) | value; break;
                    case 0xFF1E: this.ch3.freq = (this.ch3.freq & 0x00FF) | ((value & 0x07) << 8); this.ch3.lengthEnabled = (value & 0x40) !== 0; if ((value & 0x80) !== 0) { this.ch3.trigger(); } break;
                    case 0xFF20: this.ch4.lengthCounter = 64 - (value & 0x3F); break;
                    case 0xFF21: this.ch4.envelope.initialVolume = value >> 4; this.ch4.envelope.direction = (value >> 3) & 1; this.ch4.envelope.period = value & 0x07; break;
                    case 0xFF22: this.ch4.clockShift = value >> 4; this.ch4.lfsrWidth = (value >> 3) & 1; this.ch4.dividingRatio = value & 0x07; break;
                    case 0xFF23: this.ch4.lengthEnabled = (value & 0x40) !== 0; if ((value & 0x80) !== 0) { this.ch4.trigger(); } break;
                    case 0xFF30: case 0xFF31: case 0xFF32: case 0xFF33:
                    case 0xFF34: case 0xFF35: case 0xFF36: case 0xFF37:
                    case 0xFF38: case 0xFF39: case 0xFF3A: case 0xFF3B:
                    case 0xFF3C: case 0xFF3D: case 0xFF3E: case 0xFF3F:
                        this.wavePattern[address - 0xFF30] = value;
                        break;
                }
            }
        }

        // --- Central Processing Unit (CPU) ---
        class CPU {
             constructor(mmu) {
                this.mmu = mmu;
                this.pc = 0x0100;
                this.sp = 0xFFFE;
                this.a = 0x01; this.f = 0xB0;
                this.b = 0x00; this.c = 0x13;
                this.d = 0x00; this.e = 0xD8;
                this.h = 0x01; this.l = 0x4D;

                this.ime = true;
                this.imeEnableDelay = 0;
                this.halted = false;
                this.haltBug = false;

                this.FLAG_Z = 0x80; this.FLAG_N = 0x40; this.FLAG_H = 0x20; this.FLAG_C = 0x10;
            }

            get af() { return (this.a << 8) | this.f; }
            set af(val) { this.a = (val >> 8) & 0xFF; this.f = val & 0xF0; }
            get bc() { return (this.b << 8) | this.c; }
            set bc(val) { this.b = (val >> 8) & 0xFF; this.c = val & 0xFF; }
            get de() { return (this.d << 8) | this.e; }
            set de(val) { this.d = (val >> 8) & 0xFF; this.e = val & 0xFF; }
            get hl() { return (this.h << 8) | this.l; }
            set hl(val) { this.h = (val >> 8) & 0xFF; this.l = val & 0xFF; }

            step() {
                this.handleInterrupts();
                if (this.halted) {
                    return 4;
                }
                const opcode = this.mmu.readByte(this.pc);
                if (this.haltBug) {
                    this.haltBug = false;
                } else {
                    this.pc = (this.pc + 1) & 0xFFFF;
                }
                const cycles = this.executeOpcode(opcode);
                this._updateImeEnableDelay();
                return cycles;
            }

            _hasPendingInterrupts() {
                const IF = this.mmu.readByte(0xFF0F);
                const IE = this.mmu.readByte(0xFFFF);
                return (IF & IE) !== 0;
            }

            handleInterrupts() {
                const IF = this.mmu.readByte(0xFF0F);
                const IE = this.mmu.readByte(0xFFFF);
                const activeInterrupts = IF & IE;

                if (activeInterrupts > 0) {
                    this.halted = false;
                    if (this.ime) {
                        this.ime = false;
                        this.push(this.pc);

                        if ((activeInterrupts & 0x01) !== 0) { // V-Blank
                            this.mmu.writeByte(0xFF0F, IF & ~0x01);
                            this.pc = 0x0040;
                        } else if ((activeInterrupts & 0x02) !== 0) { // LCD STAT
                            this.mmu.writeByte(0xFF0F, IF & ~0x02);
                            this.pc = 0x0048;
                        } else if ((activeInterrupts & 0x04) !== 0) { // Timer
                            this.mmu.writeByte(0xFF0F, IF & ~0x04);
                            this.pc = 0x0050;
                        } else if ((activeInterrupts & 0x08) !== 0) { // Serial
                            this.mmu.writeByte(0xFF0F, IF & ~0x08);
                            this.pc = 0x0058;
                        } else if ((activeInterrupts & 0x10) !== 0) { // Joypad
                            this.mmu.writeByte(0xFF0F, IF & ~0x10);
                            this.pc = 0x0060;
                        }
                    }
                }
            }

            push(value) {
                this.sp = (this.sp - 2) & 0xFFFF;
                this.mmu.writeWord(this.sp, value);
            }

            pop() {
                const value = this.mmu.readWord(this.sp);
                this.sp = (this.sp + 2) & 0xFFFF;
                return value;
            }

            _inc8(value) {
                const result = (value + 1) & 0xFF;
                this.f &= this.FLAG_C;
                if (result === 0) this.f |= this.FLAG_Z;
                if ((value & 0x0F) + 1 > 0x0F) this.f |= this.FLAG_H;
                return result;
            }

            _dec8(value) {
                const result = (value - 1) & 0xFF;
                this.f &= this.FLAG_C;
                this.f |= this.FLAG_N;
                if (result === 0) this.f |= this.FLAG_Z;
                if ((value & 0x0F) === 0) this.f |= this.FLAG_H;
                return result;
            }

            _cp(value) {
                const result = this.a - value;
                this.f = this.FLAG_N;
                if ((result & 0xFF) === 0) this.f |= this.FLAG_Z;
                if (((this.a & 0x0F) - (value & 0x0F)) < 0) this.f |= this.FLAG_H;
                if (this.a < value) this.f |= this.FLAG_C;
            }

            _sub(value, useCarry = false) {
                const carry = useCarry && (this.f & this.FLAG_C) ? 1 : 0;
                const result = this.a - value - carry;
                this.f = this.FLAG_N;
                if (((this.a & 0x0F) - (value & 0x0F) - carry) < 0) this.f |= this.FLAG_H;
                if (result < 0) this.f |= this.FLAG_C;
                this.a = result & 0xFF;
                if (this.a === 0) this.f |= this.FLAG_Z;
            }

            _add(value, useCarry = false) {
                const carry = useCarry && (this.f & this.FLAG_C) ? 1 : 0;
                const result = this.a + value + carry;
                this.f = 0;
                if ((result & 0xFF) === 0) this.f |= this.FLAG_Z;
                if (((this.a & 0x0F) + (value & 0x0F) + carry) > 0x0F) this.f |= this.FLAG_H;
                if (result > 0xFF) this.f |= this.FLAG_C;
                this.a = result & 0xFF;
            }

            _addHL(value) {
                const result = this.hl + value;
                this.f = (this.f & this.FLAG_Z);
                if (((this.hl & 0xFFF) + (value & 0xFFF)) > 0xFFF) this.f |= this.FLAG_H;
                if (result > 0xFFFF) this.f |= this.FLAG_C;
                this.hl = result & 0xFFFF;
            }

            _addSignedOffsetToSP(offset) {
                const signedOffset = offset << 24 >> 24;
                const result = (this.sp + signedOffset) & 0xFFFF;
                this.f = 0;
                if (((this.sp & 0x0F) + (signedOffset & 0x0F)) > 0x0F) this.f |= this.FLAG_H;
                if (((this.sp & 0xFF) + (signedOffset & 0xFF)) > 0xFF) this.f |= this.FLAG_C;
                return result;
            }

            _updateImeEnableDelay() {
                if (this.imeEnableDelay > 0) {
                    this.imeEnableDelay--;
                    if (this.imeEnableDelay === 0) {
                        this.ime = true;
                    }
                }
            }

            executeOpcode(opcode) {
                let cycles = 4;
                switch(opcode) {
                    case 0x08: { const address = this.mmu.readWord(this.pc); this.pc += 2; this.mmu.writeWord(address, this.sp); cycles = 20; break; }
                    case 0x06: this.b = this.mmu.readByte(this.pc); this.pc++; cycles = 8; break;
                    case 0x09: this._addHL(this.bc); cycles = 8; break;
                    case 0x0E: this.c = this.mmu.readByte(this.pc); this.pc++; cycles = 8; break;
                    case 0x10: this.pc++; this.halted = true; break;
                    case 0x16: this.d = this.mmu.readByte(this.pc); this.pc++; cycles = 8; break;
                    case 0x19: this._addHL(this.de); cycles = 8; break;
                    case 0x1E: this.e = this.mmu.readByte(this.pc); this.pc++; cycles = 8; break;
                    case 0x26: this.h = this.mmu.readByte(this.pc); this.pc++; cycles = 8; break;
                    case 0x29: this._addHL(this.hl); cycles = 8; break;
                    case 0x2F: this.a = ~this.a & 0xFF; this.f |= this.FLAG_N | this.FLAG_H; break;
                    case 0x2E: this.l = this.mmu.readByte(this.pc); this.pc++; cycles = 8; break;
                    case 0x30: { const offset = this.mmu.readByte(this.pc); this.pc++; if ((this.f & this.FLAG_C) === 0) { this.pc = (this.pc + (offset << 24 >> 24)) & 0xFFFF; cycles = 12; } else { cycles = 8; } break; }
                    case 0x34: this.mmu.writeByte(this.hl, this._inc8(this.mmu.readByte(this.hl))); cycles = 12; break;
                    case 0x35: this.mmu.writeByte(this.hl, this._dec8(this.mmu.readByte(this.hl))); cycles = 12; break;
                    case 0x36: this.mmu.writeByte(this.hl, this.mmu.readByte(this.pc)); this.pc++; cycles = 12; break;
                    case 0x37: this.f = (this.f & this.FLAG_Z) | this.FLAG_C; break;
                    case 0x38: { const offset = this.mmu.readByte(this.pc); this.pc++; if ((this.f & this.FLAG_C) !== 0) { this.pc = (this.pc + (offset << 24 >> 24)) & 0xFFFF; cycles = 12; } else { cycles = 8; } break; }
                    case 0x39: this._addHL(this.sp); cycles = 8; break;
                    case 0x3E: this.a = this.mmu.readByte(this.pc); this.pc++; cycles = 8; break;
                    case 0x3F: this.f ^= this.FLAG_C; this.f &= ~(this.FLAG_N | this.FLAG_H); break;
                    case 0x7F: this.a = this.a; break; case 0x78: this.a = this.b; break; case 0x79: this.a = this.c; break; case 0x7A: this.a = this.d; break; case 0x7B: this.a = this.e; break; case 0x7C: this.a = this.h; break; case 0x7D: this.a = this.l; break;
                    case 0x76:
                        if (!this.ime && this._hasPendingInterrupts()) {
                            this.haltBug = true;
                        } else {
                            this.halted = true;
                        }
                        break;
                    case 0x40: break; case 0x41: this.b = this.c; break; case 0x42: this.b = this.d; break; case 0x43: this.b = this.e; break; case 0x44: this.b = this.h; break; case 0x45: this.b = this.l; break; case 0x46: this.b = this.mmu.readByte(this.hl); cycles = 8; break; case 0x47: this.b = this.a; break;
                    case 0x48: this.c = this.b; break; case 0x49: break; case 0x4A: this.c = this.d; break; case 0x4B: this.c = this.e; break; case 0x4C: this.c = this.h; break; case 0x4D: this.c = this.l; break; case 0x4E: this.c = this.mmu.readByte(this.hl); cycles = 8; break; case 0x4F: this.c = this.a; break;
                    case 0x50: this.d = this.b; break; case 0x51: this.d = this.c; break; case 0x52: break; case 0x53: this.d = this.e; break; case 0x54: this.d = this.h; break; case 0x55: this.d = this.l; break; case 0x56: this.d = this.mmu.readByte(this.hl); cycles = 8; break; case 0x57: this.d = this.a; break;
                    case 0x58: this.e = this.b; break; case 0x59: this.e = this.c; break; case 0x5A: this.e = this.d; break; case 0x5B: break; case 0x5C: this.e = this.h; break; case 0x5D: this.e = this.l; break; case 0x5E: this.e = this.mmu.readByte(this.hl); cycles = 8; break; case 0x5F: this.e = this.a; break;
                    case 0x60: this.h = this.b; break; case 0x61: this.h = this.c; break; case 0x62: this.h = this.d; break; case 0x63: this.h = this.e; break; case 0x64: break; case 0x65: this.h = this.l; break; case 0x66: this.h = this.mmu.readByte(this.hl); cycles = 8; break; case 0x67: this.h = this.a; break;
                    case 0x68: this.l = this.b; break; case 0x69: this.l = this.c; break; case 0x6A: this.l = this.d; break; case 0x6B: this.l = this.e; break; case 0x6C: this.l = this.h; break; case 0x6D: break; case 0x6E: this.l = this.mmu.readByte(this.hl); cycles = 8; break; case 0x6F: this.l = this.a; break;
                    case 0x0A: this.a = this.mmu.readByte(this.bc); cycles = 8; break; case 0x1A: this.a = this.mmu.readByte(this.de); cycles = 8; break; case 0x7E: this.a = this.mmu.readByte(this.hl); cycles = 8; break;
                    case 0x02: this.mmu.writeByte(this.bc, this.a); cycles = 8; break; case 0x12: this.mmu.writeByte(this.de, this.a); cycles = 8; break;
                    case 0x70: this.mmu.writeByte(this.hl, this.b); cycles = 8; break; case 0x71: this.mmu.writeByte(this.hl, this.c); cycles = 8; break; case 0x72: this.mmu.writeByte(this.hl, this.d); cycles = 8; break; case 0x73: this.mmu.writeByte(this.hl, this.e); cycles = 8; break; case 0x74: this.mmu.writeByte(this.hl, this.h); cycles = 8; break; case 0x75: this.mmu.writeByte(this.hl, this.l); cycles = 8; break; case 0x77: this.mmu.writeByte(this.hl, this.a); cycles = 8; break;
                    case 0x01: this.bc = this.mmu.readWord(this.pc); this.pc += 2; cycles = 12; break; case 0x11: this.de = this.mmu.readWord(this.pc); this.pc += 2; cycles = 12; break; case 0x21: this.hl = this.mmu.readWord(this.pc); this.pc += 2; cycles = 12; break; case 0x31: this.sp = this.mmu.readWord(this.pc); this.pc += 2; cycles = 12; break;
                    case 0x04: this.b = this._inc8(this.b); break; case 0x0C: this.c = this._inc8(this.c); break; case 0x14: this.d = this._inc8(this.d); break; case 0x1C: this.e = this._inc8(this.e); break; case 0x24: this.h = this._inc8(this.h); break; case 0x2C: this.l = this._inc8(this.l); break; case 0x3C: this.a = this._inc8(this.a); break;
                    case 0x05: this.b = this._dec8(this.b); break; case 0x0D: this.c = this._dec8(this.c); break; case 0x15: this.d = this._dec8(this.d); break; case 0x1D: this.e = this._dec8(this.e); break; case 0x25: this.h = this._dec8(this.h); break; case 0x2D: this.l = this._dec8(this.l); break; case 0x3D: this.a = this._dec8(this.a); break;
                    case 0x03: this.bc = (this.bc + 1) & 0xFFFF; cycles = 8; break; case 0x13: this.de = (this.de + 1) & 0xFFFF; cycles = 8; break; case 0x23: this.hl = (this.hl + 1) & 0xFFFF; cycles = 8; break; case 0x33: this.sp = (this.sp + 1) & 0xFFFF; cycles = 8; break;
                    case 0x0B: this.bc = (this.bc - 1) & 0xFFFF; cycles = 8; break; case 0x1B: this.de = (this.de - 1) & 0xFFFF; cycles = 8; break; case 0x2B: this.hl = (this.hl - 1) & 0xFFFF; cycles = 8; break; case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; cycles = 8; break;
                    case 0x18: { const offset = this.mmu.readByte(this.pc); this.pc++; this.pc = (this.pc + (offset << 24 >> 24)) & 0xFFFF; cycles = 12; break; }
                    case 0x20: { const offset = this.mmu.readByte(this.pc); this.pc++; if ((this.f & this.FLAG_Z) === 0) { this.pc = (this.pc + (offset << 24 >> 24)) & 0xFFFF; cycles = 12; } else { cycles = 8; } break; }
                    case 0x28: { const offset = this.mmu.readByte(this.pc); this.pc++; if ((this.f & this.FLAG_Z) !== 0) { this.pc = (this.pc + (offset << 24 >> 24)) & 0xFFFF; cycles = 12; } else { cycles = 8; } break; }
                    case 0xC3: this.pc = this.mmu.readWord(this.pc); cycles = 16; break;
                    case 0xC2: { const address = this.mmu.readWord(this.pc); if ((this.f & this.FLAG_Z) === 0) { this.pc = address; cycles = 16; } else { this.pc += 2; cycles = 12; } break; }
                    case 0xCA: { const address = this.mmu.readWord(this.pc); if ((this.f & this.FLAG_Z) !== 0) { this.pc = address; cycles = 16; } else { this.pc += 2; cycles = 12; } break; }
                    case 0xDA: { const address = this.mmu.readWord(this.pc); if ((this.f & this.FLAG_C) !== 0) { this.pc = address; cycles = 16; } else { this.pc += 2; cycles = 12; } break; }
                    case 0xD2: { const address = this.mmu.readWord(this.pc); if ((this.f & this.FLAG_C) === 0) { this.pc = address; cycles = 16; } else { this.pc += 2; cycles = 12; } break; }
                    case 0xE9: this.pc = this.hl; break;
                    case 0xC9: this.pc = this.pop(); cycles = 16; break;
                    case 0xD9: this.pc = this.pop(); this.ime = true; cycles = 16; break;
                    case 0xC0: if ((this.f & this.FLAG_Z) === 0) { this.pc = this.pop(); cycles = 20; } else { cycles = 8; } break;
                    case 0xC8: if ((this.f & this.FLAG_Z) !== 0) { this.pc = this.pop(); cycles = 20; } else { cycles = 8; } break;
                    case 0xD0: if ((this.f & this.FLAG_C) === 0) { this.pc = this.pop(); cycles = 20; } else { cycles = 8; } break;
                    case 0xD8: if ((this.f & this.FLAG_C) !== 0) { this.pc = this.pop(); cycles = 20; } else { cycles = 8; } break;
                    case 0xC4: { const address = this.mmu.readWord(this.pc); if ((this.f & this.FLAG_Z) === 0) { this.pc += 2; this.push(this.pc); this.pc = address; cycles = 24; } else { this.pc += 2; cycles = 12; } break; }
                    case 0xCC: { const address = this.mmu.readWord(this.pc); if ((this.f & this.FLAG_Z) !== 0) { this.pc += 2; this.push(this.pc); this.pc = address; cycles = 24; } else { this.pc += 2; cycles = 12; } break; }
                    case 0xD4: { const address = this.mmu.readWord(this.pc); if ((this.f & this.FLAG_C) === 0) { this.pc += 2; this.push(this.pc); this.pc = address; cycles = 24; } else { this.pc += 2; cycles = 12; } break; }
                    case 0xDC: { const address = this.mmu.readWord(this.pc); if ((this.f & this.FLAG_C) !== 0) { this.pc += 2; this.push(this.pc); this.pc = address; cycles = 24; } else { this.pc += 2; cycles = 12; } break; }
                    case 0xCD: { const address = this.mmu.readWord(this.pc); this.pc += 2; this.push(this.pc); this.pc = address; cycles = 24; break; }
                    case 0xF5: this.push(this.af); cycles = 16; break; case 0xC5: this.push(this.bc); cycles = 16; break; case 0xD5: this.push(this.de); cycles = 16; break; case 0xE5: this.push(this.hl); cycles = 16; break;
                    case 0xF1: this.af = this.pop(); cycles = 12; break; case 0xC1: this.bc = this.pop(); cycles = 12; break; case 0xD1: this.de = this.pop(); cycles = 12; break; case 0xE1: this.hl = this.pop(); cycles = 12; break;
                    case 0x27: { let a = this.a; let c = 0; if ((this.f & this.FLAG_H) || (!(this.f & this.FLAG_N) && (a & 0x0F) > 9)) c |= 0x06; if ((this.f & this.FLAG_C) || (!(this.f & this.FLAG_N) && a > 0x99)) c |= 0x60; a += (this.f & this.FLAG_N) ? -c : c; this.f &= ~(this.FLAG_Z | this.FLAG_H); if ((c & 0x60) !== 0) this.f |= this.FLAG_C; this.a = a & 0xFF; if (this.a === 0) this.f |= this.FLAG_Z; break; }
                    case 0x87: this._add(this.a); break; case 0x80: this._add(this.b); break; case 0x81: this._add(this.c); break; case 0x82: this._add(this.d); break; case 0x83: this._add(this.e); break; case 0x84: this._add(this.h); break; case 0x85: this._add(this.l); break; case 0x86: this._add(this.mmu.readByte(this.hl)); cycles = 8; break;
                    case 0x8F: this._add(this.a, true); break; case 0x88: this._add(this.b, true); break; case 0x89: this._add(this.c, true); break; case 0x8A: this._add(this.d, true); break; case 0x8B: this._add(this.e, true); break; case 0x8C: this._add(this.h, true); break; case 0x8D: this._add(this.l, true); break; case 0x8E: this._add(this.mmu.readByte(this.hl), true); cycles = 8; break;
                    case 0xC6: this._add(this.mmu.readByte(this.pc)); this.pc++; cycles = 8; break; case 0xCE: this._add(this.mmu.readByte(this.pc), true); this.pc++; cycles = 8; break;
                    case 0x97: this._sub(this.a); break; case 0x90: this._sub(this.b); break; case 0x91: this._sub(this.c); break; case 0x92: this._sub(this.d); break; case 0x93: this._sub(this.e); break; case 0x94: this._sub(this.h); break; case 0x95: this._sub(this.l); break; case 0x96: this._sub(this.mmu.readByte(this.hl)); cycles = 8; break;
                    case 0xD6: this._sub(this.mmu.readByte(this.pc)); this.pc++; cycles = 8; break;
                    case 0x9F: this._sub(this.a, true); break; case 0x98: this._sub(this.b, true); break; case 0x99: this._sub(this.c, true); break; case 0x9A: this._sub(this.d, true); break; case 0x9B: this._sub(this.e, true); break; case 0x9C: this._sub(this.h, true); break; case 0x9D: this._sub(this.l, true); break; case 0x9E: this._sub(this.mmu.readByte(this.hl), true); cycles = 8; break;
                    case 0xDE: this._sub(this.mmu.readByte(this.pc), true); this.pc++; cycles = 8; break;
                    case 0xA7: this.a &= this.a; this.f = (this.a === 0 ? this.FLAG_Z : 0) | this.FLAG_H; break; case 0xA0: this.a &= this.b; this.f = (this.a === 0 ? this.FLAG_Z : 0) | this.FLAG_H; break; case 0xA1: this.a &= this.c; this.f = (this.a === 0 ? this.FLAG_Z : 0) | this.FLAG_H; break; case 0xA2: this.a &= this.d; this.f = (this.a === 0 ? this.FLAG_Z : 0) | this.FLAG_H; break; case 0xA3: this.a &= this.e; this.f = (this.a === 0 ? this.FLAG_Z : 0) | this.FLAG_H; break; case 0xA4: this.a &= this.h; this.f = (this.a === 0 ? this.FLAG_Z : 0) | this.FLAG_H; break; case 0xA5: this.a &= this.l; this.f = (this.a === 0 ? this.FLAG_Z : 0) | this.FLAG_H; break;
                    case 0xA6: this.a &= this.mmu.readByte(this.hl); this.f = (this.a === 0 ? this.FLAG_Z : 0) | this.FLAG_H; cycles = 8; break;
                    case 0xAF: this.a ^= this.a; this.f = this.FLAG_Z; break; case 0xAE: this.a ^= this.mmu.readByte(this.hl); this.f = (this.a === 0 ? this.FLAG_Z : 0); cycles = 8; break;
                    case 0xA8: this.a ^= this.b; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xA9: this.a ^= this.c; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xAA: this.a ^= this.d; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xAB: this.a ^= this.e; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xAC: this.a ^= this.h; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xAD: this.a ^= this.l; this.f = (this.a === 0 ? this.FLAG_Z : 0); break;
                    case 0xB7: this.a |= this.a; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xB0: this.a |= this.b; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xB1: this.a |= this.c; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xB2: this.a |= this.d; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xB3: this.a |= this.e; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xB4: this.a |= this.h; this.f = (this.a === 0 ? this.FLAG_Z : 0); break; case 0xB5: this.a |= this.l; this.f = (this.a === 0 ? this.FLAG_Z : 0); break;
                    case 0xB6: this.a |= this.mmu.readByte(this.hl); this.f = (this.a === 0 ? this.FLAG_Z : 0); cycles = 8; break;
                    case 0xB8: this._cp(this.b); break; case 0xB9: this._cp(this.c); break; case 0xBA: this._cp(this.d); break; case 0xBB: this._cp(this.e); break; case 0xBC: this._cp(this.h); break; case 0xBD: this._cp(this.l); break; case 0xBE: this._cp(this.mmu.readByte(this.hl)); cycles = 8; break; case 0xBF: this._cp(this.a); break;
                    case 0xE6: this.a &= this.mmu.readByte(this.pc); this.pc++; this.f = (this.a === 0 ? this.FLAG_Z : 0) | this.FLAG_H; cycles = 8; break;
                    case 0xE8: { const offset = this.mmu.readByte(this.pc); this.pc++; this.sp = this._addSignedOffsetToSP(offset); cycles = 16; break; }
                    case 0xEE: this.a ^= this.mmu.readByte(this.pc); this.pc++; this.f = (this.a === 0 ? this.FLAG_Z : 0); cycles = 8; break;
                    case 0xF6: this.a |= this.mmu.readByte(this.pc); this.pc++; this.f = (this.a === 0 ? this.FLAG_Z : 0); cycles = 8; break;
                    case 0xF8: { const offset = this.mmu.readByte(this.pc); this.pc++; this.hl = this._addSignedOffsetToSP(offset); cycles = 12; break; }
                    case 0xF9: this.sp = this.hl; cycles = 8; break;
                    case 0xFA: this.a = this.mmu.readByte(this.mmu.readWord(this.pc)); this.pc += 2; cycles = 16; break;
                    case 0xFE: { const n = this.mmu.readByte(this.pc); this.pc++; this._cp(n); cycles = 8; break; }
                    case 0x17: { const c = (this.f & this.FLAG_C) ? 1 : 0; this.f = (this.a & 0x80) ? this.FLAG_C : 0; this.a = ((this.a << 1) | c) & 0xFF; break; }
                    case 0x07: { const c = (this.a & 0x80) ? 1 : 0; this.a = ((this.a << 1) | c) & 0xFF; this.f = c ? this.FLAG_C : 0; break; }
                    case 0x0F: { const c = this.a & 0x01; this.a = (this.a >> 1) | (c << 7); this.f = c ? this.FLAG_C : 0; break; }
                    case 0x1F: { const c = (this.f & this.FLAG_C) ? 1 : 0; const n = this.a & 0x01; this.a = (this.a >> 1) | (c << 7); this.f = n ? this.FLAG_C : 0; break; }
                    case 0x00: break; case 0xF3: this.ime = false; this.imeEnableDelay = 0; break; case 0xFB: this.imeEnableDelay = 2; break;
                    case 0xCB: cycles = this.executeCBOpcode(); break;
                    case 0x22: this.mmu.writeByte(this.hl, this.a); this.hl = (this.hl + 1) & 0xFFFF; cycles = 8; break;
                    case 0x32: this.mmu.writeByte(this.hl, this.a); this.hl = (this.hl - 1) & 0xFFFF; cycles = 8; break;
                    case 0x2A: this.a = this.mmu.readByte(this.hl); this.hl = (this.hl + 1) & 0xFFFF; cycles = 8; break;
                    case 0x3A: this.a = this.mmu.readByte(this.hl); this.hl = (this.hl - 1) & 0xFFFF; cycles = 8; break;
                    case 0xE0: this.mmu.writeByte(0xFF00 + this.mmu.readByte(this.pc), this.a); this.pc++; cycles = 12; break;
                    case 0xF0: this.a = this.mmu.readByte(0xFF00 + this.mmu.readByte(this.pc)); this.pc++; cycles = 12; break;
                    case 0xE2: this.mmu.writeByte(0xFF00 + this.c, this.a); cycles = 8; break;
                    case 0xF2: this.a = this.mmu.readByte(0xFF00 + this.c); cycles = 8; break;
                    case 0xEA: this.mmu.writeByte(this.mmu.readWord(this.pc), this.a); this.pc += 2; cycles = 16; break;
                    case 0xC7: this.push(this.pc); this.pc = 0x00; cycles = 16; break; case 0xCF: this.push(this.pc); this.pc = 0x08; cycles = 16; break; case 0xD7: this.push(this.pc); this.pc = 0x10; cycles = 16; break; case 0xDF: this.push(this.pc); this.pc = 0x18; cycles = 16; break;
                    case 0xE7: this.push(this.pc); this.pc = 0x20; cycles = 16; break; case 0xEF: this.push(this.pc); this.pc = 0x28; cycles = 16; break; case 0xF7: this.push(this.pc); this.pc = 0x30; cycles = 16; break; case 0xFF: this.push(this.pc); this.pc = 0x38; cycles = 16; break;
                    default:
                        const prevPC = (this.pc - 1) & 0xFFFF;
                        if (!DebugOpcodes.includes(opcode)) {
                            DebugOpcodes.push(opcode);
                            console.warn(`Unbekannter Opcode: 0x${(opcode || 0).toString(16).toUpperCase()} bei PC: 0x${prevPC.toString(16).toUpperCase()}`);
                        }
                        cycles = 4;
                        break;
                }
                return cycles;
            }

            executeCBOpcode() {
                const cbOpcode = this.mmu.readByte(this.pc); this.pc = (this.pc + 1) & 0xFFFF; let cycles = 8;
                const getReg = (c) => { switch(c) { case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e; case 4: return this.h; case 5: return this.l; case 6: cycles=16; return this.mmu.readByte(this.hl); case 7: return this.a; } };
                const setReg = (c, v) => { switch(c) { case 0: this.b=v; break; case 1: this.c=v; break; case 2: this.d=v; break; case 3: this.e=v; break; case 4: this.h=v; break; case 5: this.l=v; break; case 6: this.mmu.writeByte(this.hl, v); break; case 7: this.a=v; break; } };
                const regCode = cbOpcode & 0x07; let value = getReg(regCode);
                if (cbOpcode <= 0x07) { const c = (value & 0x80) ? 1 : 0; value = ((value << 1) | c) & 0xFF; this.f = c ? this.FLAG_C : 0; if(value===0) this.f|=this.FLAG_Z; setReg(regCode, value); }
                else if (cbOpcode <= 0x0F) { const c = value & 0x01; value = (value >> 1) | (c << 7); this.f = c ? this.FLAG_C : 0; if(value===0) this.f|=this.FLAG_Z; setReg(regCode, value); }
                else if (cbOpcode <= 0x17) { const c = (this.f & this.FLAG_C) ? 1 : 0; const n = (value & 0x80) ? 1:0; value=((value << 1)|c)&0xFF; this.f = n ? this.FLAG_C:0; if(value===0) this.f|=this.FLAG_Z; setReg(regCode, value); }
                else if (cbOpcode <= 0x1F) { const c = (this.f & this.FLAG_C) ? 1:0; const n = value & 0x01; value=(value>>1)|(c<<7); this.f = n ? this.FLAG_C:0; if(value===0) this.f|=this.FLAG_Z; setReg(regCode, value); }
                else if (cbOpcode <= 0x27) { const c = (value & 0x80) ? 1:0; value=(value<<1)&0xFF; this.f = c ? this.FLAG_C:0; if(value===0) this.f|=this.FLAG_Z; setReg(regCode, value); }
                else if (cbOpcode <= 0x2F) { const c = value & 0x01; value=(value>>1)|(value&0x80); this.f = c ? this.FLAG_C:0; if(value===0) this.f|=this.FLAG_Z; setReg(regCode, value); }
                else if (cbOpcode <= 0x37) { value = ((value&0x0F)<<4)|(value>>4); this.f = value===0 ? this.FLAG_Z:0; setReg(regCode, value); }
                else if (cbOpcode <= 0x3F) { const c = value & 0x01; value = value >> 1; this.f = c ? this.FLAG_C:0; if(value===0) this.f|=this.FLAG_Z; setReg(regCode, value); }
                else if (cbOpcode <= 0x7F) { const bit = (cbOpcode - 0x40) >> 3; this.f &= this.FLAG_C; this.f|=this.FLAG_H; if (!((value>>bit)&1)) this.f|=this.FLAG_Z; }
                else if (cbOpcode <= 0xBF) { const bit = (cbOpcode - 0x80) >> 3; value &= ~(1<<bit); setReg(regCode, value); }
                else if (cbOpcode <= 0xFF) { const bit = (cbOpcode - 0xC0) >> 3; value |= (1<<bit); setReg(regCode, value); }
                return cycles;
            }
        }

        // --- Main Emulator Class ---
        export class GameBoy {
            constructor(screen) {
                this.ctx = screen.getContext('2d');
                this.hardwareMode = 'DMG';
                this.mmu = new MMU(this);
                this.apu = new APU(this.mmu);
                this.mmu.apu = this.apu;
                this.joypad = this.mmu.joypad;
                this.cpu = new CPU(this.mmu);
                this.ppu = new PPU(this.mmu, this.ctx);
                this.timer = new Timer(this.mmu);
                this.mmu.timer = this.timer;
                this.isRunning = false;
                this.isRumbling = false;

                this.setupInput();
            }

            loadRom(romData) {
                // 1. Calculate checksum and load saved data from storage
                currentRomChecksum = calculateRomChecksum(romData);
                this.hardwareMode = detectHardwareMode(romData);
                let savedRam = null;
                const savedRtc = loadRtcState();
                const savedData = localStorage.getItem(`jsboy_save_${currentRomChecksum}`);
                
                if (savedData) {
                    try {
                        const decodedData = atob(savedData);
                        savedRam = new Uint8Array(decodedData.length);
                        for (let i = 0; i < decodedData.length; i++) {
                            savedRam[i] = decodedData.charCodeAt(i);
                        }
                        emitSaveStatus("Spielstand gefunden & geladen.", 2000);
                    } catch (e) {
                        console.error("Fehler beim Laden des Spielstands:", e);
                        emitSaveStatus("Ladefehler!", 2000);
                    }
                } else {
                    emitSaveStatus("", null);
                    console.log("Kein Spielstand fÃ¼r diese ROM gefunden.");
                }

                // 2. Initialize MMU with ROM data and (if available) saved data
                this.mmu.loadRom(romData, savedRam, savedRtc, this.hardwareMode);

                console.log("Emulator initialized and ROM loaded.");
            }

            run() {
                if(this.isRunning) return;
                this.isRunning = true;
                this.frame();
            }

            stop() {
                this.isRunning = false;
                console.log("Emulation angehalten.");
            }

            setRumble(isOn) {
                if (this.isRumbling === isOn) return;
                this.isRumbling = isOn;

                const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
                for (const gp of gamepads) {
                    if (gp && gp.vibrationActuator) {
                        if (isOn) {
                            gp.vibrationActuator.playEffect("dual-rumble", {
                                startDelay: 0,
                                duration: 200,
                                weakMagnitude: 1.0,
                                strongMagnitude: 1.0,
                            });
                        }
                    }
                }
            }


            frame() {
                if (!this.isRunning) return;

                const cyclesPerFrame = 70224;
                let cycles = 0;
                while(cycles < cyclesPerFrame) {
                    if(!this.isRunning) break;
                    const executedCycles = this.cpu.step();
                    this.mmu.step(executedCycles);
                    this.ppu.step(executedCycles);
                    this.timer.step(executedCycles);
                    this.apu.step(executedCycles);
                    cycles += executedCycles;
                }
                this.ppu.renderFrame();
                emulatorHooks.updateDebugInfo(this.cpu);
                requestAnimationFrame(() => this.frame());
            }

            setupInput() {
                const keyMap = {
                    'ArrowUp': 'UP', 'ArrowDown': 'DOWN', 'ArrowLeft': 'LEFT', 'ArrowRight': 'RIGHT',
                    'KeyW': 'UP', 'KeyS': 'DOWN', 'KeyA': 'LEFT', 'KeyD': 'RIGHT',
                    'KeyZ': 'A', 'KeyY': 'A', 'KeyX': 'B', 'KeyJ': 'A', 'KeyK': 'B',
                    'Enter': 'START', 'ShiftRight': 'SELECT'
                };

                window.addEventListener('keydown', (e) => {
                    if (keyMap[e.code]) {
                        e.preventDefault();
                        this.joypad.keyDown(keyMap[e.code]);
                    }
                });

                window.addEventListener('keyup', (e) => {
                     if (keyMap[e.code]) {
                        e.preventDefault();
                        this.joypad.keyUp(keyMap[e.code]);
                    }
                });

                const buttons = document.querySelectorAll('.button, .button-overlay');
                buttons.forEach(button => {
                    const key = button.dataset.key;
                    if(!key) return;

                    const touchStartHandler = (e) => {
                        e.preventDefault();
                        this.joypad.keyDown(key);
                    };

                    const touchEndHandler = (e) => {
                        // Findet alle aktuell gedrÃ¼ckten Tasten
                        const touches = e.changedTouches;
                        let isStillPressingButton = false;
                        for (let i = 0; i < touches.length; i++) {
                            const element = document.elementFromPoint(touches[i].clientX, touches[i].clientY);
                            if (element && element.dataset.key === key) {
                                isStillPressingButton = true;
                                break;
                            }
                        }
                        if (!isStillPressingButton) {
                            this.joypad.keyUp(key);
                        }
                    };

                    // Original-Events beibehalten
                    button.addEventListener('mousedown', () => this.joypad.keyDown(key));
                    button.addEventListener('mouseup', () => this.joypad.keyUp(key));
                    button.addEventListener('mouseleave', () => this.joypad.keyUp(key));

                    // Neue Touch-Events
                    button.addEventListener('touchstart', touchStartHandler);
                    button.addEventListener('touchend', touchEndHandler);
                    button.addEventListener('touchcancel', () => this.joypad.keyUp(key));
                });;
            }
        }

