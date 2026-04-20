import {
    configureEmulatorHooks,
    GameBoy,
    getCurrentRomChecksum,
    resetDebugOpcodes,
} from './lib/emulator.js';
let gameboyInstance = null;
function setSaveStatus(message, timeout = 2000) {
    const saveStatus = document.getElementById('save-status');
    if (!saveStatus) {
        return;
    }
    saveStatus.textContent = message;
    if (timeout !== null) {
        window.setTimeout(() => {
            if (saveStatus.textContent === message) {
                saveStatus.textContent = '';
            }
        }, timeout);
    }
}
function updateDebugInfo(cpu) {
    document.getElementById('reg-pc').textContent = cpu.pc.toString(16).toUpperCase().padStart(4, '0');
    document.getElementById('reg-sp').textContent = cpu.sp.toString(16).toUpperCase().padStart(4, '0');
    document.getElementById('reg-af').textContent = cpu.af.toString(16).toUpperCase().padStart(4, '0');
    document.getElementById('reg-bc').textContent = cpu.bc.toString(16).toUpperCase().padStart(4, '0');
    document.getElementById('reg-de').textContent = cpu.de.toString(16).toUpperCase().padStart(4, '0');
    document.getElementById('reg-hl').textContent = cpu.hl.toString(16).toUpperCase().padStart(4, '0');
    const flags =
        ((cpu.f & cpu.FLAG_Z) ? 'Z' : '-') +
        ((cpu.f & cpu.FLAG_N) ? 'N' : '-') +
        ((cpu.f & cpu.FLAG_H) ? 'H' : '-') +
        ((cpu.f & cpu.FLAG_C) ? 'C' : '-');
    document.getElementById('flags').textContent = flags;
}
function drawSplashScreen(screen) {
    const GB_WIDTH = 160;
    const GB_HEIGHT = 144;
    const ctx = screen.getContext('2d');

    ctx.fillStyle = '#8bac0f';
    ctx.fillRect(0, 0, GB_WIDTH, GB_HEIGHT);
}

function renderInitialSplash(screen) {
    drawSplashScreen(screen);
}
document.addEventListener('DOMContentLoaded', () => {
    const screen = document.getElementById('gameboy-screen');
    const screenSplash = document.getElementById('screen-splash');
    const romInput = document.getElementById('rom-input');
    const romTitle = document.getElementById('rom-title');
    const exportBtn = document.getElementById('export-save-btn');
    const importInput = document.getElementById('import-save-input');
    const muteBtn = document.getElementById('mute-btn');
    const mutedIcon = document.getElementById('speaker-icon-muted');
    const unmutedIcon = document.getElementById('speaker-icon-unmuted');
    const GB_WIDTH = 160;
    const GB_HEIGHT = 144;
    screen.width = GB_WIDTH;
    screen.height = GB_HEIGHT;

    configureEmulatorHooks({ updateDebugInfo, setSaveStatus });
    renderInitialSplash(screen);
    screenSplash?.classList.remove('hidden');
    romInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) {
            return;
        }
        romTitle.textContent = `Geladen: ${file.name}`;
        const reader = new FileReader();
        reader.onload = (loadEvent) => {
            const romData = new Uint8Array(loadEvent.target.result);
            if (gameboyInstance && gameboyInstance.isRunning) {
                gameboyInstance.stop();
            }
            resetDebugOpcodes();
            screenSplash?.classList.add('hidden');
            gameboyInstance = new GameBoy(screen);
            gameboyInstance.loadRom(romData);
            gameboyInstance.run();
        };
        reader.readAsArrayBuffer(file);
    });
    exportBtn.addEventListener('click', () => {
        const currentRomChecksum = getCurrentRomChecksum();
        if (!gameboyInstance || !currentRomChecksum) {
            setSaveStatus('Keine ROM geladen!', 2000);
            return;
        }
        const ramData = gameboyInstance.mmu.mbc.ram;
        const blob = new Blob([ramData], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const romName = romTitle.textContent.replace('Geladen: ', '').split('.')[0];
        a.download = `${romName}_${currentRomChecksum}.sav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setSaveStatus('Save exportiert!', 2000);
    });
    importInput.addEventListener('change', (event) => {
        const currentRomChecksum = getCurrentRomChecksum();
        if (!gameboyInstance || !currentRomChecksum) {
            setSaveStatus('Zuerst ROM laden!', 2000);
            return;
        }
        const file = event.target.files[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = (loadEvent) => {
            const importedRam = new Uint8Array(loadEvent.target.result);
            gameboyInstance.mmu.mbc.ram.set(importedRam);
            gameboyInstance.mmu.mbc.requestSave();
            setSaveStatus('Save importiert & gespeichert!', 2000);
        };
        reader.readAsArrayBuffer(file);
        importInput.value = '';
    });
    muteBtn.addEventListener('click', () => {
        if (!gameboyInstance) {
            return;
        }
        const isUnmuted = gameboyInstance.apu.toggleMute();
        mutedIcon.classList.toggle('hidden', isUnmuted);
        unmutedIcon.classList.toggle('hidden', !isUnmuted);
    });
});
