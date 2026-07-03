"use strict";

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mp = require('./musicParser');

/** @type {Map<string, MusicEditorPanel>} */
const openPanels = new Map();

const MUSIC_PLAYER_OPTIONS = ['MUSIC_PLAYER_BGM', 'MUSIC_PLAYER_SE1', 'MUSIC_PLAYER_SE2', 'MUSIC_PLAYER_SE3'];
const DEFAULT_UNKNOWN_FOR_PLAYER = { MUSIC_PLAYER_BGM: '0', MUSIC_PLAYER_SE1: '1', MUSIC_PLAYER_SE2: '2', MUSIC_PLAYER_SE3: '3' };

class MusicEditorPanel {
    static createOrShow(context, projectRoot) {
        const key = projectRoot.fsPath;
        if (openPanels.has(key)) { openPanels.get(key)._panel.reveal(); return; }
        openPanels.set(key, new MusicEditorPanel(context, projectRoot, key));
    }

    constructor(context, projectRoot, key) {
        this._context = context;
        this._projectRoot = projectRoot;
        this._key = key;
        this._songsHeaderPath = path.join(projectRoot.fsPath, 'include', 'constants', 'songs.h');
        this._songTablePath = path.join(projectRoot.fsPath, 'sound', 'song_table.inc');
        this._midiCfgPath = path.join(projectRoot.fsPath, 'sound', 'songs', 'midi', 'midi.cfg');
        this._voiceGroupsIncludePath = path.join(projectRoot.fsPath, 'sound', 'voice_groups.inc');
        this._keysplitTablesPath = path.join(projectRoot.fsPath, 'sound', 'keysplit_tables.inc');
        this._directSoundDataPath = path.join(projectRoot.fsPath, 'sound', 'direct_sound_data.inc');
        this._programmableWaveDataPath = path.join(projectRoot.fsPath, 'sound', 'programmable_wave_data.inc');
        this._midiDir = path.join(projectRoot.fsPath, 'sound', 'songs', 'midi');
        this._directSoundSamplesDir = path.join(projectRoot.fsPath, 'sound', 'direct_sound_samples');
        this._programmableWaveSamplesDir = path.join(projectRoot.fsPath, 'sound', 'programmable_wave_samples');
        this._voicegroupsRoot = path.join(projectRoot.fsPath, 'sound', 'voicegroups');

        this._panel = vscode.window.createWebviewPanel('musicEditor', 'Music Editor', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(this._midiDir),
                vscode.Uri.file(this._directSoundSamplesDir),
                vscode.Uri.file(this._programmableWaveSamplesDir),
            ],
        });
        this._panel.onDidDispose(() => openPanels.delete(key));
        this._panel.webview.onDidReceiveMessage(message => {
            if (message.type === 'save') this._save(message.edits || {}, message.selectedSongId);
            if (message.type === 'reload') this._loadAndSend(message.selectedSongId);
            if (message.type === 'ready' && this._pendingInit) {
                this._panel.webview.postMessage(this._pendingInit);
                this._pendingInit = null;
            }
            if (message.type === 'importMidi') this._importMidi(message.label, message.selectedSongId);
            if (message.type === 'addSong') this._addSong(message.request || {});
            if (message.type === 'createVoiceGroup') this._createVoiceGroup(message.request || {}, message.selectedSongId);
        });
        this._panel.webview.html = this._loadingHtml();
        setTimeout(() => this._loadAndSend(), 100);
    }

    _read(filePath) { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }

    _webviewUri(absolutePath) {
        return fs.existsSync(absolutePath) ? this._panel.webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString() : '';
    }

    /** The real, checked-in .wav source that a `DirectSoundWaveData_*` incbin path (a built .bin) corresponds to. */
    _wavPathFor(incbinRelativePath) {
        const withoutExt = incbinRelativePath.replace(/\.bin$/i, '');
        return path.join(this._projectRoot.fsPath, ...(withoutExt + '.wav').split('/'));
    }

    _buildVoiceGroupIndex() {
        const includeContent = this._read(this._voiceGroupsIncludePath);
        const relativePaths = mp.parseVoiceGroupsInclude(includeContent);
        const files = relativePaths.map(relativePath => ({
            path: relativePath,
            content: this._read(path.join(this._projectRoot.fsPath, ...relativePath.split('/'))),
        }));
        return { relativePaths, groupIndex: mp.indexVoiceGroups(files) };
    }

    _serializeEntryForWebview(entry, directSoundMap, waveMap) {
        const plain = {};
        for (const key of Object.keys(entry)) {
            if (key === 'lineStart' || key === 'lineEnd') continue;
            plain[key] = entry[key];
        }
        if (entry.kind === 'directsound' && entry.sample) {
            const relativePath = directSoundMap.get(entry.sample);
            if (relativePath) plain.sampleUri = this._webviewUri(this._wavPathFor(relativePath));
        }
        if (entry.kind === 'wave' && entry.wave) {
            const relativePath = waveMap.get(entry.wave);
            if (relativePath) plain.waveUri = this._webviewUri(path.join(this._projectRoot.fsPath, ...relativePath.split('/')));
        }
        return plain;
    }

    _loadAndSend(selectedSongId) {
        try {
            const songsHeader = this._read(this._songsHeaderPath);
            const tableContent = this._read(this._songTablePath);
            const cfgContent = this._read(this._midiCfgPath);
            const constants = mp.parseSongConstants(songsHeader);
            const table = mp.parseSongTable(tableContent);
            const cfgMap = mp.parseMidiCfg(cfgContent);

            const songs = [];
            for (const constant of constants) {
                if (!constant.name.startsWith('MUS_') || constant.name === 'MUS_ROUTE118' || constant.value === 0xFFFF) continue;
                const entry = table[constant.value];
                if (!entry || entry.label === 'dummy_song_header') continue;
                const cfg = cfgMap.get(entry.label);
                const cfgArgs = cfg ? cfg.args : '';
                const cfgFlags = mp.parseCfgFlags(cfgArgs);
                songs.push({
                    id: constant.value,
                    name: constant.name,
                    comment: constant.comment,
                    label: entry.label,
                    musicPlayer: entry.musicPlayer,
                    unknown: entry.unknown,
                    cfgArgs,
                    cfgFlags,
                    voiceGroup: cfgFlags.G.replace(/^_/, ''),
                    midiUri: this._webviewUri(path.join(this._midiDir, entry.label + '.mid')),
                    midiRelativePath: 'sound/songs/midi/' + entry.label + '.mid',
                    hasMidi: fs.existsSync(path.join(this._midiDir, entry.label + '.mid')),
                });
            }
            songs.sort((a, b) => a.name.localeCompare(b.name));

            const { groupIndex } = this._buildVoiceGroupIndex();
            const keysplitTables = mp.parseKeysplitTables(this._read(this._keysplitTablesPath));
            const directSoundMap = mp.parseIncbinMap(this._read(this._directSoundDataPath));
            const waveMap = mp.parseIncbinMap(this._read(this._programmableWaveDataPath));

            const voiceGroups = {};
            for (const [name, group] of groupIndex) {
                voiceGroups[name] = {
                    startNote: group.startNote,
                    sourceFile: group.sourceFile,
                    entries: group.entries.map(entry => this._serializeEntryForWebview(entry, directSoundMap, waveMap)),
                };
            }
            const keysplitTablesPlain = {};
            for (const [name, table2] of keysplitTables) keysplitTablesPlain[name] = table2;

            const directSoundSamples = [...directSoundMap.entries()]
                .map(([symbol, relativePath]) => ({ symbol, uri: this._webviewUri(this._wavPathFor(relativePath)) }))
                .filter(sample => sample.uri);
            const programmableWaveSamples = [...waveMap.entries()]
                .map(([symbol, relativePath]) => ({ symbol, uri: this._webviewUri(path.join(this._projectRoot.fsPath, ...relativePath.split('/'))) }))
                .filter(sample => sample.uri);

            this._pendingInit = {
                type: 'init',
                songs,
                voiceGroups,
                voiceGroupNames: Object.keys(voiceGroups).sort(),
                keysplitTables: keysplitTablesPlain,
                directSoundSamples,
                programmableWaveSamples,
                musicPlayerOptions: MUSIC_PLAYER_OPTIONS,
                selectedSongId,
            };
            this._panel.webview.html = this._html();
        } catch (error) {
            this._panel.webview.html = this._errorHtml(String((error && error.stack) || error));
        }
    }

    _save(edits, selectedSongId) {
        try {
            const songTableEdits = edits.songTable || {};
            if (Object.keys(songTableEdits).length) {
                let songTableContent = this._read(this._songTablePath);
                for (const [label, change] of Object.entries(songTableEdits)) {
                    const entry = mp.parseSongTable(songTableContent).find(candidate => candidate.label === label);
                    if (!entry) throw new Error('Could not find song table entry for ' + label);
                    songTableContent = mp.setSongTableEntry(songTableContent, entry.index, label, change.musicPlayer, change.unknown);
                }
                fs.writeFileSync(this._songTablePath, songTableContent, 'utf8');
            }

            const cfgEdits = edits.cfg || {};
            if (Object.keys(cfgEdits).length) {
                let cfgContent = this._read(this._midiCfgPath);
                for (const [label, argsString] of Object.entries(cfgEdits)) {
                    cfgContent = mp.setMidiCfgArgs(cfgContent, label, argsString);
                }
                fs.writeFileSync(this._midiCfgPath, cfgContent, 'utf8');
            }

            const voiceGroupBodyEdits = edits.voiceGroupBodies || {};
            for (const [groupName, entries] of Object.entries(voiceGroupBodyEdits)) {
                const { groupIndex } = this._buildVoiceGroupIndex();
                const group = groupIndex.get(groupName);
                if (!group) throw new Error('Voice group not found: ' + groupName);
                const filePath = path.join(this._projectRoot.fsPath, ...group.sourceFile.split('/'));
                const updated = mp.setVoiceGroupBody(this._read(filePath), groupName, entries);
                fs.writeFileSync(filePath, updated, 'utf8');
            }

            vscode.window.showInformationMessage('Saved music data successfully.');
            this._loadAndSend(selectedSongId);
        } catch (error) {
            vscode.window.showErrorMessage('Failed to save music data: ' + error);
            this._panel.webview.postMessage({ type: 'saveError', message: String(error) });
        }
    }

    async _importMidi(label, selectedSongId) {
        try {
            const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import MIDI', filters: { 'MIDI files': ['mid', 'midi'] } });
            if (!picked || !picked.length) return;
            const answer = await vscode.window.showWarningMessage('Replace ' + label + '.mid with the selected file?', { modal: true }, 'Replace');
            if (answer !== 'Replace') return;
            fs.copyFileSync(picked[0].fsPath, path.join(this._midiDir, label + '.mid'));
            vscode.window.showInformationMessage('Imported MIDI for ' + label + '.');
            this._loadAndSend(selectedSongId);
        } catch (error) {
            vscode.window.showErrorMessage('Could not import MIDI file: ' + error);
        }
    }

    async _addSong(request) {
        try {
            let name = String(request.name || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
            if (!name) throw new Error('Please enter a song name.');
            const constantName = name.startsWith('MUS_') ? name : 'MUS_' + name;
            const label = constantName.slice('MUS_'.length).toLowerCase();
            if (!label) throw new Error('Invalid song name.');

            const songsHeaderExisting = this._read(this._songsHeaderPath);
            if (mp.parseSongConstants(songsHeaderExisting).some(constant => constant.name === constantName)) {
                throw new Error(constantName + ' already exists.');
            }

            const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import MIDI', filters: { 'MIDI files': ['mid', 'midi'] } });
            if (!picked || !picked.length) return;

            let tableContent = this._read(this._songTablePath);
            const entries = mp.parseSongTable(tableContent);
            const musicPlayer = MUSIC_PLAYER_OPTIONS.includes(request.musicPlayer) ? request.musicPlayer : 'MUSIC_PLAYER_BGM';
            const unknown = String(request.unknown !== undefined && request.unknown !== '' ? request.unknown : DEFAULT_UNKNOWN_FOR_PLAYER[musicPlayer]);
            let id = mp.findFreeDummySlot(entries);
            if (id >= 0) {
                tableContent = mp.setSongTableEntry(tableContent, id, label, musicPlayer, unknown);
            } else {
                id = entries.length;
                tableContent = mp.appendSongTableEntry(tableContent, label, musicPlayer, unknown);
            }

            const songsHeader = mp.insertSongConstant(songsHeaderExisting, constantName, id);

            const flags = {
                E: true, X: false, N: false,
                R: request.reverb === '' || request.reverb === undefined ? 50 : Number(request.reverb),
                G: request.voiceGroup ? '_' + request.voiceGroup : '',
                P: request.priority === '' || request.priority === undefined ? null : Number(request.priority),
                V: request.volume === '' || request.volume === undefined ? 127 : Number(request.volume),
                L: '', extra: [],
            };
            const cfgContent = mp.setMidiCfgArgs(this._read(this._midiCfgPath), label, mp.serializeCfgFlags(flags));

            fs.writeFileSync(this._songsHeaderPath, songsHeader, 'utf8');
            fs.writeFileSync(this._songTablePath, tableContent, 'utf8');
            fs.writeFileSync(this._midiCfgPath, cfgContent, 'utf8');
            fs.copyFileSync(picked[0].fsPath, path.join(this._midiDir, label + '.mid'));

            vscode.window.showInformationMessage('Added ' + constantName + ' (id ' + id + ').');
            this._loadAndSend(id);
        } catch (error) {
            vscode.window.showErrorMessage('Could not add song: ' + error);
            this._panel.webview.postMessage({ type: 'saveError', message: String(error) });
        }
    }

    _createVoiceGroup(request, selectedSongId) {
        try {
            const name = String(request.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
            if (!name) throw new Error('Please enter a voice group name.');
            const { groupIndex } = this._buildVoiceGroupIndex();
            if (groupIndex.has(name)) throw new Error('Voice group "' + name + '" already exists.');
            const cloneFrom = request.cloneFrom ? groupIndex.get(request.cloneFrom) : null;
            const entries = cloneFrom
                ? cloneFrom.entries.map(entry => ({ macro: entry.macro, params: mp.VOICE_ENTRY_TYPES[entry.macro].params.map(param => entry[param]) }))
                : [];
            const relativePath = 'sound/voicegroups/' + name + '.inc';
            const filePath = path.join(this._projectRoot.fsPath, ...relativePath.split('/'));
            fs.writeFileSync(filePath, mp.createVoiceGroupFileContent(name, entries), 'utf8');
            fs.writeFileSync(this._voiceGroupsIncludePath, mp.appendVoiceGroupInclude(this._read(this._voiceGroupsIncludePath), relativePath), 'utf8');
            vscode.window.showInformationMessage('Created voice group "' + name + '".');
            this._loadAndSend(selectedSongId);
        } catch (error) {
            vscode.window.showErrorMessage('Could not create voice group: ' + error);
            this._panel.webview.postMessage({ type: 'saveError', message: String(error) });
        }
    }

    _loadingHtml() {
        return '<!DOCTYPE html><html><body style="color:var(--vscode-foreground);padding:20px">Loading music data...</body></html>';
    }

    _errorHtml(message) {
        return '<!DOCTYPE html><html><body style="color:var(--vscode-errorForeground);padding:20px"><h2>Music Editor</h2><pre>' +
            escapeHtml(message) + '</pre></body></html>';
    }

    _html() {
        const nonce = crypto.randomBytes(16).toString('hex');
        const csp = this._panel.webview.cspSource;
        return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src ' + csp + '; connect-src ' + csp + '; script-src \'nonce-' + nonce + '\'; style-src \'unsafe-inline\';">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Music Editor</title>' +
            '<style>' + STYLE_SHEET + '</style></head><body>' + BODY_MARKUP +
            '<script nonce="' + nonce + '">' + CLIENT_SCRIPT + '</script></body></html>';
    }
}

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

const STYLE_SHEET = `
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;overflow:hidden;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size) var(--vscode-font-family)}
#side{width:290px;min-width:210px;display:flex;flex-direction:column;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
.side-header{display:flex;align-items:center;justify-content:space-between;padding:10px 10px 0}
.side-header h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:0}
.search{padding:8px 8px}
input,select,textarea{width:100%;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:5px 7px;font:inherit}
input:focus,select:focus,textarea:focus{outline:1px solid var(--vscode-focusBorder)}
#list{list-style:none;margin:0;padding:0;overflow:auto;flex:1}
.song-row{display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer}
.song-row:hover{background:var(--vscode-list-hoverBackground)}
.song-row.active{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground)}
.song-text{min-width:0;flex:1}
.song-name,.song-id{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.song-id{font-size:10px;opacity:.7}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#empty{margin:auto;color:var(--vscode-descriptionForeground)}
#editor{display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0}
.bar{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.heading{margin-right:auto;min-width:0}
.heading h1{font-size:17px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.heading .song-id{font-size:11px}
.transport{display:flex;align-items:center;gap:8px;min-width:220px}
.transport .time{font-size:11px;color:var(--vscode-descriptionForeground);min-width:80px;text-align:right}
progress{flex:1;height:6px}
button{border:1px solid transparent;padding:6px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
button.small{padding:3px 8px;font-size:11px}
.status{min-width:70px;color:var(--vscode-descriptionForeground)}
#tabs{display:flex;overflow-x:auto;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-shrink:0}
.tab{padding:8px 14px;background:transparent;color:var(--vscode-foreground);border:0;border-bottom:2px solid transparent;white-space:nowrap}
.tab.active-tab{border-bottom-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground)}
#body{padding:14px;overflow:auto;flex:1;min-height:0}
.section{border:1px solid var(--vscode-panel-border);margin-bottom:12px}
.section h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:0;padding:7px 11px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border)}
.grid{padding:11px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.field label{display:block;margin-bottom:4px;font-size:11px;color:var(--vscode-descriptionForeground)}
.check-row{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px}
.check-row input{width:auto}
.notice{color:var(--vscode-descriptionForeground);margin:0 0 12px;line-height:1.4;font-size:12px}
.vg-toolbar{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
.vg-toolbar .ac-wrap{flex:1;min-width:200px}
.vg-hint{font-size:11px;color:var(--vscode-descriptionForeground);padding:0 11px 9px}
.vg-table{padding:9px 11px}
.vg-row{display:grid;grid-template-columns:40px 190px 1fr auto;gap:8px;align-items:start;padding:6px 0;border-bottom:1px solid var(--vscode-panel-border)}
.vg-idx{font-size:11px;color:var(--vscode-descriptionForeground);padding-top:6px}
.vg-params{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:6px}
.vg-param label{display:block;font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:2px}
.vg-sample-row{display:flex;gap:4px}
.ac-wrap{position:relative}
.ac-input{width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;padding:5px 7px;font-size:var(--vscode-font-size);font-family:var(--vscode-font-family)}
.ac-drop{position:fixed;z-index:99999;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-focusBorder);max-height:220px;overflow-y:auto;display:none}
.ac-drop.open{display:block}
.ac-opt{padding:4px 8px;cursor:pointer;font-size:12px}
.ac-opt:hover,.ac-opt.hi{background:var(--vscode-list-hoverBackground)}
.add-form{padding:14px;max-width:520px}
.add-form .field{margin-bottom:10px}
.overlay-actions{display:flex;gap:8px;margin-top:14px}
`;

const BODY_MARKUP = `
<aside id="side">
  <div class="side-header"><h2>Songs <span id="count"></span></h2><button class="small" id="add-song-btn">+ Add Song</button></div>
  <div class="search"><input id="search" type="search" placeholder="Search songs..."></div>
  <ul id="list"></ul>
</aside>
<main id="main">
  <div id="empty">Select a song to edit, or click "+ Add Song".</div>
  <section id="editor">
    <header class="bar">
      <div class="heading"><h1 id="title"></h1><div class="song-id" id="song-id"></div></div>
      <div class="transport">
        <button id="play-btn" class="small">&#9654; Play</button>
        <button id="stop-btn" class="small secondary">&#9632; Stop</button>
        <progress id="progress" value="0" max="1"></progress>
        <span class="time" id="time">0:00 / 0:00</span>
      </div>
      <span class="status" id="status"></span>
      <button class="secondary" id="reload">Reload</button>
      <button id="save">Save</button>
    </header>
    <nav id="tabs"></nav>
    <div id="body"></div>
  </section>
  <section id="add-song-overlay" style="display:none">
    <div class="add-form">
      <h2>Add Song</h2>
      <p class="notice">Creates a new MUS_ constant, claims a slot in gSongTable (reusing a free "dummy_song_header" slot when one is available, otherwise appending a new one), adds a midi.cfg entry, and imports a .mid file you choose into sound/songs/midi/.</p>
      <div class="field"><label>Name (MUS_ prefix optional)</label><input id="new-song-name" placeholder="e.g. ROUTE999 or MUS_ROUTE999"></div>
      <div class="field"><label>Music Player</label><select id="new-song-player"></select></div>
      <div class="field"><label>Voice Group</label><div class="ac-wrap" id="new-song-voicegroup-wrap"></div></div>
      <div class="field"><label>Reverb</label><input id="new-song-reverb" type="number" value="50"></div>
      <div class="field"><label>Master Volume (0-127)</label><input id="new-song-volume" type="number" value="127"></div>
      <div class="field"><label>Priority</label><input id="new-song-priority" type="number" value="0"></div>
      <div class="overlay-actions">
        <button id="new-song-create">Create &amp; Choose MIDI File...</button>
        <button class="secondary" id="new-song-cancel">Cancel</button>
      </div>
    </div>
  </section>
</main>
`;

const CLIENT_SCRIPT = `
(function () {
'use strict';
var vscode = acquireVsCodeApi();

var songs = [], voiceGroups = {}, voiceGroupNames = [], keysplitTables = {}, directSoundSamples = [], programmableWaveSamples = [], musicPlayerOptions = [];
var selectedIndex = -1, activeTab = 'song', edits = {}, dirtyVoiceGroups = {};
var tabs = [['song', 'Song'], ['voicegroup', 'Voice Group']];

function byId(id) { return document.getElementById(id); }
function clampNum(value, min, max) { return Math.max(min, Math.min(max, value)); }

// ---------------------------------------------------------------------------
// Autocomplete helper (mirrors the pattern used by the Pokemon editor)
// ---------------------------------------------------------------------------

function makeAC(wrapEl, list, inputId) {
    if (!wrapEl) return { getValue: function () { return ''; }, setValue: function () {}, getEl: function () { return null; } };
    wrapEl.innerHTML = '';
    var input = document.createElement('input');
    input.type = 'text'; input.className = 'ac-input'; input.autocomplete = 'off';
    if (inputId) input.id = inputId;
    var dropdown = document.createElement('div');
    dropdown.className = 'ac-drop';
    document.body.appendChild(dropdown);
    wrapEl.appendChild(input);
    var highlighted = -1;

    function reposition() {
        var rect = input.getBoundingClientRect();
        dropdown.style.left = rect.left + 'px';
        dropdown.style.top = rect.bottom + 'px';
        dropdown.style.width = rect.width + 'px';
    }

    function fill(query) {
        var filtered = query.length === 0 ? list.slice(0, 80) : list.filter(function (name) { return name.toLowerCase().indexOf(query.toLowerCase()) !== -1; }).slice(0, 80);
        dropdown.innerHTML = '';
        highlighted = -1;
        filtered.forEach(function (name) {
            var row = document.createElement('div');
            row.className = 'ac-opt'; row.textContent = name; row.dataset.val = name;
            row.addEventListener('mousedown', function (event) {
                event.preventDefault();
                input.value = name;
                dropdown.classList.remove('open');
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            dropdown.appendChild(row);
        });
    }

    input.addEventListener('focus', function () { reposition(); fill(input.value); dropdown.classList.add('open'); });
    input.addEventListener('input', function () { reposition(); fill(input.value); dropdown.classList.add('open'); });
    input.addEventListener('blur', function () { setTimeout(function () { dropdown.classList.remove('open'); }, 160); });
    window.addEventListener('scroll', function () { if (dropdown.classList.contains('open')) reposition(); }, true);
    input.addEventListener('keydown', function (event) {
        var options = dropdown.querySelectorAll('.ac-opt');
        if (!options.length) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); highlighted = Math.min(highlighted + 1, options.length - 1); options.forEach(function (option, index) { option.classList.toggle('hi', index === highlighted); }); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); highlighted = Math.max(highlighted - 1, 0); options.forEach(function (option, index) { option.classList.toggle('hi', index === highlighted); }); }
        else if (event.key === 'Enter' && highlighted >= 0) { event.preventDefault(); input.value = options[highlighted].dataset.val; dropdown.classList.remove('open'); input.dispatchEvent(new Event('change', { bubbles: true })); }
        else if (event.key === 'Escape') dropdown.classList.remove('open');
    });
    return { getValue: function () { return input.value.trim(); }, setValue: function (value) { input.value = value || ''; }, getEl: function () { return input; } };
}

// ---------------------------------------------------------------------------
// MIDI (Standard MIDI File) parser
// ---------------------------------------------------------------------------

function parseMidiFile(buffer) {
    var bytes = new Uint8Array(buffer);
    var pos = 0;
    function readUint32() { var v = (bytes[pos] * 0x1000000) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3]; pos += 4; return v; }
    function readUint16() { var v = (bytes[pos] << 8) + bytes[pos + 1]; pos += 2; return v; }
    function readString(n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(bytes[pos + i]); pos += n; return s; }
    function readVarLen() { var value = 0, byte; do { byte = bytes[pos++]; value = (value << 7) | (byte & 0x7f); } while (byte & 0x80); return value >>> 0; }

    readString(4); // 'MThd'
    readUint32(); // header length
    var format = readUint16();
    var numTracks = readUint16();
    var division = readUint16();
    var tracks = [];
    for (var t = 0; t < numTracks; t++) {
        readString(4); // 'MTrk'
        var trackLen = readUint32();
        var trackEnd = pos + trackLen;
        var events = [];
        var tick = 0;
        var runningStatus = 0;
        while (pos < trackEnd) {
            var delta = readVarLen();
            tick += delta;
            var statusByte = bytes[pos];
            if (statusByte & 0x80) { pos++; runningStatus = statusByte; } else { statusByte = runningStatus; }
            if (statusByte === 0xFF) {
                var metaType = bytes[pos++];
                var metaLen = readVarLen();
                pos += metaLen;
                if (metaType === 0x51) {
                    var mpqOffset = pos - metaLen;
                    events.push({ tick: tick, type: 'tempo', microsecondsPerBeat: (bytes[mpqOffset] << 16) + (bytes[mpqOffset + 1] << 8) + bytes[mpqOffset + 2] });
                }
            } else if (statusByte === 0xF0 || statusByte === 0xF7) {
                var sysexLen = readVarLen();
                pos += sysexLen;
            } else {
                var kind = statusByte & 0xF0;
                if (kind === 0xC0 || kind === 0xD0) {
                    var data1Only = bytes[pos++];
                    events.push({ tick: tick, type: 'channel', status: kind, data1: data1Only, data2: 0 });
                } else {
                    var data1 = bytes[pos++];
                    var data2 = bytes[pos++];
                    events.push({ tick: tick, type: 'channel', status: kind, data1: data1, data2: data2 });
                }
            }
        }
        tracks.push(events);
        pos = trackEnd;
    }
    return { format: format, division: division || 24, tracks: tracks };
}

function buildTempoMap(midi) {
    var tempoEvents = [];
    midi.tracks.forEach(function (track) { track.forEach(function (ev) { if (ev.type === 'tempo') tempoEvents.push({ tick: ev.tick, microsecondsPerBeat: ev.microsecondsPerBeat }); }); });
    tempoEvents.sort(function (a, b) { return a.tick - b.tick; });
    if (!tempoEvents.length || tempoEvents[0].tick > 0) tempoEvents.unshift({ tick: 0, microsecondsPerBeat: 500000 });
    return tempoEvents;
}

function tickToSeconds(tick, tempoMap, division) {
    var seconds = 0, lastTick = 0, lastTempo = tempoMap[0].microsecondsPerBeat;
    for (var i = 0; i < tempoMap.length; i++) {
        var entry = tempoMap[i];
        if (entry.tick >= tick) break;
        seconds += (entry.tick - lastTick) * lastTempo / division / 1e6;
        lastTick = entry.tick; lastTempo = entry.microsecondsPerBeat;
    }
    seconds += (tick - lastTick) * lastTempo / division / 1e6;
    return seconds;
}

// ---------------------------------------------------------------------------
// Voice resolution (mirrors lib/musicParser.js resolveVoice, client-side)
// ---------------------------------------------------------------------------

function lookupKeysplitClient(table, note) {
    if (!table.ranges.length) return 0;
    if (note < table.ranges[0].startNote) return table.ranges[0].index;
    for (var i = 0; i < table.ranges.length; i++) if (note < table.ranges[i].endNote) return table.ranges[i].index;
    return table.ranges[table.ranges.length - 1].index;
}

function resolveVoiceClient(groupName, programIndex, midiNote, depth) {
    depth = depth || 0;
    if (depth > 4) return null;
    var group = voiceGroups[groupName];
    if (!group || !group.entries.length) return null;
    var index = clampNum(programIndex, 0, group.entries.length - 1);
    var entry = group.entries[index];
    if (!entry) return null;
    if (entry.kind === 'keysplit_all') {
        var subName = (entry.group || '').replace(/^voicegroup_/, '');
        var sub = voiceGroups[subName];
        if (!sub || !sub.entries.length) return null;
        var subIndex = clampNum(midiNote - sub.startNote, 0, sub.entries.length - 1);
        if (sub.entries[subIndex].leaf) return sub.entries[subIndex];
        return resolveVoiceClient(subName, subIndex, midiNote, depth + 1);
    }
    if (entry.kind === 'keysplit') {
        var subName2 = (entry.group || '').replace(/^voicegroup_/, '');
        var sub2 = voiceGroups[subName2];
        var table = keysplitTables[(entry.table || '').replace(/^keysplit_/, '')];
        if (!sub2 || !sub2.entries.length || !table) return null;
        var subIndex2 = clampNum(lookupKeysplitClient(table, midiNote), 0, sub2.entries.length - 1);
        if (sub2.entries[subIndex2].leaf) return sub2.entries[subIndex2];
        return resolveVoiceClient(subName2, subIndex2, midiNote, depth + 1);
    }
    return entry;
}

// ---------------------------------------------------------------------------
// Audio synthesis
// ---------------------------------------------------------------------------

var audioCtx = null, masterGain = null;
function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.6;
        masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function noteToFrequency(note) { return 440 * Math.pow(2, (note - 69) / 12); }

var pulseWaveCache = {};
function buildPulseWave(ctx, duty) {
    var dutyFraction = [0.125, 0.25, 0.5, 0.75][duty] || 0.5;
    var harmonics = 24;
    var real = new Float32Array(harmonics + 1);
    var imag = new Float32Array(harmonics + 1);
    for (var n = 1; n <= harmonics; n++) imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * dutyFraction);
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}
function getPulseWave(ctx, duty) {
    var key = String(duty);
    if (!pulseWaveCache[key]) pulseWaveCache[key] = buildPulseWave(ctx, duty);
    return pulseWaveCache[key];
}

var noiseBufferCache = {};
function generateGbNoiseBuffer(ctx, narrow) {
    var lfsr = 0x7FFF;
    var length = 32768;
    var buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < length; i++) {
        data[i] = (lfsr & 1) ? -1 : 1;
        var xorBit = (lfsr & 1) ^ ((lfsr >> 1) & 1);
        lfsr >>= 1;
        lfsr |= (xorBit << 14);
        if (narrow) { lfsr &= ~(1 << 6); lfsr |= (xorBit << 6); }
    }
    return buffer;
}
function getNoiseBuffer(ctx, narrow) {
    var key = narrow ? 'n' : 'w';
    if (!noiseBufferCache[key]) noiseBufferCache[key] = generateGbNoiseBuffer(ctx, narrow);
    return noiseBufferCache[key];
}

function decodeWaveTable(bytes) {
    var samples = [];
    for (var i = 0; i < bytes.length; i++) {
        samples.push(((bytes[i] >> 4) & 0xF) / 7.5 - 1);
        samples.push((bytes[i] & 0xF) / 7.5 - 1);
    }
    return samples;
}
function buildPeriodicWaveFromSamples(ctx, samples) {
    var n = samples.length;
    var harmonics = Math.min(24, Math.floor(n / 2));
    var real = new Float32Array(harmonics + 1);
    var imag = new Float32Array(harmonics + 1);
    for (var h = 1; h <= harmonics; h++) {
        var re = 0, im = 0;
        for (var i = 0; i < n; i++) { var angle = 2 * Math.PI * h * i / n; re += samples[i] * Math.cos(angle); im += samples[i] * Math.sin(angle); }
        real[h] = re / n; imag[h] = -im / n;
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}
var programmableWaveCache = {};
function preloadProgrammableWave(ctx, uri) {
    if (!uri || programmableWaveCache[uri] !== undefined) return Promise.resolve();
    return fetch(uri).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        programmableWaveCache[uri] = buildPeriodicWaveFromSamples(ctx, decodeWaveTable(new Uint8Array(buf)));
    }).catch(function () { programmableWaveCache[uri] = null; });
}
function getProgrammableWave(uri) { return programmableWaveCache[uri] || null; }

var sampleBufferCache = {}, sampleBufferPromises = {};
function getSampleBuffer(ctx, uri) {
    if (!uri) return Promise.resolve(null);
    if (sampleBufferCache[uri] !== undefined) return Promise.resolve(sampleBufferCache[uri]);
    if (sampleBufferPromises[uri]) return sampleBufferPromises[uri];
    var promise = fetch(uri).then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { return ctx.decodeAudioData(buf); })
        .then(function (decoded) { sampleBufferCache[uri] = decoded; return decoded; })
        .catch(function () { sampleBufferCache[uri] = null; return null; });
    sampleBufferPromises[uri] = promise;
    return promise;
}

function applyCgbEnvelope(gainNode, entry, peakGain, startTime, noteDuration) {
    var unit = 1 / 64;
    var attack = parseInt(entry.attack, 10) || 0, decay = parseInt(entry.decay, 10) || 0;
    var sustain = parseInt(entry.sustain, 10); if (isNaN(sustain)) sustain = 15;
    var release = parseInt(entry.release, 10) || 0;
    var attackTime = attack <= 0 ? 0.008 : attack * unit * 15;
    var decayTime = decay <= 0 ? 0.008 : decay * unit * 15;
    var sustainLevel = Math.max(0.0001, peakGain * (sustain / 15));
    var releaseTime = release <= 0 ? 0.02 : release * unit * 15;
    var g = gainNode.gain;
    g.cancelScheduledValues(startTime);
    g.setValueAtTime(0.0001, startTime);
    g.linearRampToValueAtTime(Math.max(peakGain, 0.0001), startTime + attackTime);
    var sustainStart = startTime + attackTime + decayTime;
    g.linearRampToValueAtTime(sustainLevel, sustainStart);
    var noteOffTime = startTime + noteDuration;
    if (noteOffTime > sustainStart) g.setValueAtTime(sustainLevel, noteOffTime);
    g.linearRampToValueAtTime(0.0001, Math.max(noteOffTime, sustainStart) + releaseTime);
}

function applyDirectSoundEnvelope(gainNode, entry, peakGain, startTime, noteDuration) {
    var attack = parseInt(entry.attack, 10); if (isNaN(attack)) attack = 255;
    var decay = parseInt(entry.decay, 10); if (isNaN(decay)) decay = 200;
    var sustain = parseInt(entry.sustain, 10); if (isNaN(sustain)) sustain = 200;
    var release = parseInt(entry.release, 10); if (isNaN(release)) release = 200;
    var attackTime = attack <= 0 ? 1.2 : Math.max(0.005, 1.2 * (255 - attack) / 255);
    var decayTime = decay <= 0 ? 0.01 : Math.max(0.01, 1.5 * decay / 255);
    var sustainLevel = Math.max(0.0001, peakGain * (sustain / 255));
    var releaseTime = release <= 0 ? 0.01 : Math.max(0.01, 1.5 * release / 255);
    var g = gainNode.gain;
    g.cancelScheduledValues(startTime);
    g.setValueAtTime(0.0001, startTime);
    g.linearRampToValueAtTime(Math.max(peakGain, 0.0001), startTime + attackTime);
    var sustainStart = startTime + attackTime + decayTime;
    g.exponentialRampToValueAtTime(sustainLevel, sustainStart);
    var noteOffTime = startTime + noteDuration;
    if (noteOffTime > sustainStart) g.setValueAtTime(sustainLevel, noteOffTime);
    g.exponentialRampToValueAtTime(0.0001, Math.max(noteOffTime, sustainStart) + releaseTime);
}

function applySweep(sweepParam, oscillator, baseFreq, startTime, noteDuration) {
    var sweepByte = parseInt(sweepParam, 10) || 0;
    if (!sweepByte) return;
    var shift = sweepByte & 0x7;
    var negate = (sweepByte >> 3) & 0x1;
    var stepTime = ((sweepByte >> 4) & 0x7) * (1 / 128);
    if (!stepTime || !shift) return;
    var freq = baseFreq, t = startTime;
    var steps = Math.min(60, Math.ceil(noteDuration / stepTime) + 1);
    for (var i = 0; i < steps && freq > 20 && freq < 20000; i++) {
        t += stepTime;
        var delta = freq / Math.pow(2, shift);
        freq = negate ? freq - delta : freq + delta;
        if (freq <= 0) break;
        oscillator.frequency.setValueAtTime(freq, t);
    }
}

var activeNodes = [], currentStopToken = 0, playbackTimer = null, playbackEndTimer = null;
var playbackState = { playing: false, startAt: 0, duration: 0 };

function transposedFrequency(note, baseKey, pitchBendRatio) {
    var key = parseInt(baseKey, 10); if (isNaN(key)) key = 60;
    return noteToFrequency(note - (key - 60)) * pitchBendRatio;
}

function scheduleNote(ctx, job, stopToken) {
    var duration = Math.max(0.03, job.endTime - job.startTime);
    var panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    var panParam = job.entry.pan && job.entry.pan !== '0' ? parseInt(job.entry.pan, 10) : job.pan;
    var panValue = clampNum(((panParam || 64) - 64) / 64, -1, 1);
    var destination = masterGain;
    if (panner) { panner.pan.setValueAtTime(panValue, job.startTime); panner.connect(masterGain); destination = panner; }
    var gainNode = ctx.createGain();
    gainNode.connect(destination);
    var velocityGain = (job.velocity / 127) * (job.volume / 127) * Math.max(0.15, job.expression / 127);

    if (job.kind === 'square1' || job.kind === 'square2') {
        var osc = ctx.createOscillator();
        osc.setPeriodicWave(getPulseWave(ctx, parseInt(job.entry.dutyCycle, 10) || 0));
        var freq = transposedFrequency(job.note, job.entry.baseKey, job.pitchBendRatio);
        osc.frequency.setValueAtTime(freq, job.startTime);
        if (job.kind === 'square1') applySweep(job.entry.sweep, osc, freq, job.startTime, duration);
        osc.connect(gainNode);
        applyCgbEnvelope(gainNode, job.entry, velocityGain, job.startTime, duration);
        try { osc.start(job.startTime); osc.stop(job.startTime + duration + 0.6); } catch (e) {}
        activeNodes.push(osc);
    } else if (job.kind === 'noise') {
        var source = ctx.createBufferSource();
        source.buffer = getNoiseBuffer(ctx, (parseInt(job.entry.period, 10) || 0) === 1);
        source.loop = true;
        var noiseFreq = transposedFrequency(job.note, job.entry.baseKey, job.pitchBendRatio);
        source.playbackRate.setValueAtTime(clampNum(noiseFreq / 220, 0.05, 20), job.startTime);
        source.connect(gainNode);
        applyCgbEnvelope(gainNode, job.entry, velocityGain, job.startTime, duration);
        try { source.start(job.startTime); source.stop(job.startTime + duration + 0.6); } catch (e) {}
        activeNodes.push(source);
    } else if (job.kind === 'wave') {
        var oscWave = ctx.createOscillator();
        var wave = getProgrammableWave(job.entry.waveUri);
        if (wave) oscWave.setPeriodicWave(wave); else oscWave.type = 'triangle';
        var waveFreq = transposedFrequency(job.note, job.entry.baseKey, job.pitchBendRatio);
        oscWave.frequency.setValueAtTime(waveFreq, job.startTime);
        oscWave.connect(gainNode);
        applyCgbEnvelope(gainNode, job.entry, velocityGain, job.startTime, duration);
        try { oscWave.start(job.startTime); oscWave.stop(job.startTime + duration + 0.6); } catch (e) {}
        activeNodes.push(oscWave);
    } else if (job.kind === 'directsound') {
        getSampleBuffer(ctx, job.entry.sampleUri).then(function (buffer) {
            if (!buffer || currentStopToken !== stopToken) return;
            var source2 = ctx.createBufferSource();
            source2.buffer = buffer;
            var noResample = /no_resample/.test(job.entry.macro || '');
            var rate = noResample ? 1 : Math.pow(2, (job.note - (parseInt(job.entry.baseKey, 10) || 60)) / 12) * job.pitchBendRatio;
            source2.playbackRate.setValueAtTime(clampNum(rate, 0.1, 8), job.startTime);
            source2.connect(gainNode);
            applyDirectSoundEnvelope(gainNode, job.entry, velocityGain, job.startTime, duration);
            var startAt = Math.max(job.startTime, ctx.currentTime);
            try { source2.start(startAt); source2.stop(startAt + duration + 1.5); } catch (e) {}
            activeNodes.push(source2);
        });
    }
}

function buildJobs(midi, song) {
    var tempoMap = buildTempoMap(midi);
    var jobs = [];
    midi.tracks.forEach(function (track) {
        var state = { program: 0, pan: 64, volume: 100, expression: 127, pitchBend: 0, sustain: false };
        var active = {};
        var pendingRelease = [];
        var lastTick = 0;

        function finishJob(noteState, endTick) {
            var resolvedEntry = resolveVoiceClient(song.voiceGroup, noteState.program, noteState.note);
            if (!resolvedEntry) return null;
            var startSeconds = tickToSeconds(noteState.startTick, tempoMap, midi.division);
            var endSeconds = Math.max(startSeconds + 0.03, tickToSeconds(endTick, tempoMap, midi.division));
            return {
                note: noteState.note, velocity: noteState.velocity, volume: noteState.volume, expression: noteState.expression,
                pan: noteState.pan, pitchBendRatio: Math.pow(2, (noteState.pitchBend / 8192) * 2 / 12),
                startSeconds: startSeconds, endSeconds: endSeconds, kind: resolvedEntry.kind, entry: resolvedEntry,
            };
        }

        track.forEach(function (ev) {
            if (ev.tick > lastTick) lastTick = ev.tick;
            if (ev.type !== 'channel') return;
            var status = ev.status;
            if (status === 0xC0) { state.program = ev.data1; return; }
            if (status === 0xB0) {
                if (ev.data1 === 7) state.volume = ev.data2;
                else if (ev.data1 === 11) state.expression = ev.data2;
                else if (ev.data1 === 10) state.pan = ev.data2;
                else if (ev.data1 === 64) {
                    var wasSustained = state.sustain;
                    state.sustain = ev.data2 >= 64;
                    if (wasSustained && !state.sustain) {
                        pendingRelease.forEach(function (noteState) { var job = finishJob(noteState, ev.tick); if (job) jobs.push(job); });
                        pendingRelease = [];
                    }
                }
                return;
            }
            if (status === 0xE0) { state.pitchBend = ((ev.data2 << 7) | ev.data1) - 8192; return; }
            if (status === 0x90 && ev.data2 > 0) {
                active[ev.data1] = { note: ev.data1, startTick: ev.tick, velocity: ev.data2, program: state.program, pan: state.pan, volume: state.volume, expression: state.expression, pitchBend: state.pitchBend };
                return;
            }
            if (status === 0x80 || (status === 0x90 && ev.data2 === 0)) {
                var noteState = active[ev.data1];
                if (!noteState) return;
                delete active[ev.data1];
                if (state.sustain) pendingRelease.push(noteState);
                else { var job = finishJob(noteState, ev.tick); if (job) jobs.push(job); }
            }
        });
        Object.keys(active).forEach(function (key) { var job = finishJob(active[key], lastTick); if (job) jobs.push(job); });
        pendingRelease.forEach(function (noteState) { var job = finishJob(noteState, lastTick); if (job) jobs.push(job); });
    });
    return jobs;
}

function preloadJobAssets(ctx, jobs) {
    var seenSample = {}, seenWave = {}, tasks = [];
    jobs.forEach(function (job) {
        if (job.kind === 'directsound' && job.entry.sampleUri && !seenSample[job.entry.sampleUri]) { seenSample[job.entry.sampleUri] = 1; tasks.push(getSampleBuffer(ctx, job.entry.sampleUri)); }
        if (job.kind === 'wave' && job.entry.waveUri && !seenWave[job.entry.waveUri]) { seenWave[job.entry.waveUri] = 1; tasks.push(preloadProgrammableWave(ctx, job.entry.waveUri)); }
    });
    return Promise.all(tasks);
}

function setPlaybackStatus(message) { byId('status').textContent = message || ''; }

function updateTransportUI() {
    byId('play-btn').disabled = playbackState.playing;
    byId('stop-btn').disabled = !playbackState.playing;
}

function formatTime(seconds) {
    seconds = Math.max(0, seconds || 0);
    var minutes = Math.floor(seconds / 60);
    var whole = Math.floor(seconds % 60);
    return minutes + ':' + (whole < 10 ? '0' : '') + whole;
}

function updatePlaybackProgress() {
    if (!playbackState.playing) return;
    var elapsed = audioCtx ? audioCtx.currentTime - playbackState.startAt : 0;
    var progress = byId('progress');
    progress.max = Math.max(0.001, playbackState.duration);
    progress.value = clampNum(elapsed, 0, playbackState.duration);
    byId('time').textContent = formatTime(elapsed) + ' / ' + formatTime(playbackState.duration);
    if (elapsed >= playbackState.duration + 1) stopPlayback();
}

function stopPlayback() {
    currentStopToken++;
    activeNodes.forEach(function (node) { try { node.stop(0); } catch (e) {} try { node.disconnect(); } catch (e) {} });
    activeNodes = [];
    if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
    if (playbackEndTimer) { clearTimeout(playbackEndTimer); playbackEndTimer = null; }
    playbackState = { playing: false, startAt: 0, duration: playbackState.duration };
    updateTransportUI();
    setPlaybackStatus('');
}

function playSong() {
    stopPlayback();
    var song = songs[selectedIndex];
    if (!song) return;
    if (!song.hasMidi) { setPlaybackStatus('No MIDI file found'); return; }
    if (!song.voiceGroup || !voiceGroups[song.voiceGroup]) { setPlaybackStatus('No voice group assigned'); return; }
    var ctx = getAudioContext();
    setPlaybackStatus('Loading...');
    fetch(song.midiUri).then(function (r) { return r.arrayBuffer(); }).then(function (buffer) {
        var midi = parseMidiFile(buffer);
        var jobs = buildJobs(midi, song);
        return preloadJobAssets(ctx, jobs).then(function () { return jobs; });
    }).then(function (jobs) {
        var startAt = ctx.currentTime + 0.2;
        var stopToken = ++currentStopToken;
        activeNodes = [];
        var totalDuration = 0.1;
        jobs.forEach(function (job) {
            job.startTime = startAt + job.startSeconds;
            job.endTime = startAt + job.endSeconds;
            if (job.endSeconds > totalDuration) totalDuration = job.endSeconds;
            scheduleNote(ctx, job, stopToken);
        });
        playbackState = { playing: true, startAt: startAt, duration: totalDuration, stopToken: stopToken };
        updateTransportUI();
        setPlaybackStatus('Playing');
        if (playbackTimer) clearInterval(playbackTimer);
        playbackTimer = setInterval(updatePlaybackProgress, 100);
        playbackEndTimer = setTimeout(function () { if (currentStopToken === stopToken) stopPlayback(); }, (totalDuration + 1.5) * 1000);
    }).catch(function (error) {
        setPlaybackStatus('Playback failed');
        console.error(error);
    });
}

function previewSample(uri) {
    var ctx = getAudioContext();
    getSampleBuffer(ctx, uri).then(function (buffer) {
        if (!buffer) return;
        var source = ctx.createBufferSource();
        source.buffer = buffer;
        var gainNode = ctx.createGain();
        gainNode.gain.value = 0.7;
        source.connect(gainNode); gainNode.connect(masterGain);
        source.start(ctx.currentTime);
    });
}
function previewWave(uri) {
    var ctx = getAudioContext();
    preloadProgrammableWave(ctx, uri).then(function () {
        var wave = getProgrammableWave(uri);
        var osc = ctx.createOscillator();
        if (wave) osc.setPeriodicWave(wave); else osc.type = 'triangle';
        osc.frequency.value = noteToFrequency(60);
        var gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0.5, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1);
        osc.connect(gainNode); gainNode.connect(masterGain);
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 1);
    });
}

// ---------------------------------------------------------------------------
// UI — song list
// ---------------------------------------------------------------------------

function renderList() {
    var query = byId('search').value.trim().toLowerCase();
    var list = byId('list');
    list.textContent = '';
    var shown = 0;
    songs.forEach(function (song, index) {
        if (query && (song.name + ' ' + song.label).toLowerCase().indexOf(query) === -1) return;
        shown++;
        var row = document.createElement('li');
        row.className = 'song-row' + (index === selectedIndex ? ' active' : '');
        var text = document.createElement('div'); text.className = 'song-text';
        var name = document.createElement('div'); name.className = 'song-name'; name.textContent = song.name;
        var idLine = document.createElement('div'); idLine.className = 'song-id'; idLine.textContent = 'id ' + song.id + (song.hasMidi ? '' : ' - missing .mid');
        text.appendChild(name); text.appendChild(idLine); row.appendChild(text);
        row.onclick = function () { select(index); };
        list.appendChild(row);
    });
    byId('count').textContent = '(' + shown + ')';
}

function staged(song) { return edits[song.name] || (edits[song.name] = { label: song.label, songTable: {}, cfg: null }); }

function commit() {
    if (selectedIndex < 0) return;
    var song = songs[selectedIndex];
    var edit = staged(song);
    var playerInput = byId('field-music-player'), unknownInput = byId('field-unknown');
    if (playerInput && unknownInput) {
        if (playerInput.value !== song.musicPlayer || unknownInput.value.trim() !== song.unknown) edit.songTable = { musicPlayer: playerInput.value, unknown: unknownInput.value.trim() };
        else edit.songTable = {};
    }
    // The compiler-flag fields only exist in the DOM while the Song tab is active; rebuilding cfg
    // flags here while another tab is showing would otherwise silently wipe them (every byId lookup
    // below would fail and fall back to blank defaults). Only touch edit.cfg when that tab owns it.
    if (byId('field-reverb')) {
        var flags = { E: false, X: false, N: false, R: null, G: currentEditedFlags(song).G, P: null, V: null, L: '', extra: (song.cfgFlags.extra || []).slice() };
        if (byId('field-exact-gate')) flags.E = byId('field-exact-gate').checked;
        if (byId('field-48clocks')) flags.X = byId('field-48clocks').checked;
        if (byId('field-no-compression')) flags.N = byId('field-no-compression').checked;
        var reverbValue = byId('field-reverb').value.trim(); flags.R = reverbValue === '' ? null : parseInt(reverbValue, 10);
        if (byId('field-volume')) { var volumeValue = byId('field-volume').value.trim(); flags.V = volumeValue === '' ? null : parseInt(volumeValue, 10); }
        if (byId('field-priority')) { var priorityValue = byId('field-priority').value.trim(); flags.P = priorityValue === '' ? null : parseInt(priorityValue, 10); }
        var voiceGroupInput = byId('field-voicegroup-input');
        if (voiceGroupInput) flags.G = flagGFromGroupName(voiceGroupInput.value.trim());
        var extraInput = byId('field-extra-flags');
        if (extraInput) flags.extra = extraInput.value.trim().length ? extraInput.value.trim().split(/\\s+/) : [];
        stageCfg(song, flags);
    }
    if (!Object.keys(edit.songTable).length && edit.cfg === null) delete edits[song.name];
    setStatus();
}

function stageCfg(song, flags) {
    var edit = staged(song);
    var newArgs = serializeCfgFlagsClient(flags);
    // Compare against the ORIGINAL flags re-serialized through the same canonical function (not the raw
    // on-disk text), so differences in flag order/padding alone never register as a false "pending change".
    var originalCanonical = serializeCfgFlagsClient(song.cfgFlags);
    edit.cfg = newArgs !== originalCanonical ? newArgs : null;
    if (!Object.keys(edit.songTable).length && edit.cfg === null) delete edits[song.name];
}

// A song's assigned voice group is stored internally as the raw "-G" flag value (which keeps its
// leading underscore, e.g. "_route101"), but displayed/compared as a plain group name ("route101",
// matching the keys of voiceGroups and voiceGroupNames). Keep the conversion in one place.
function groupNameFromFlagG(flagG) { return flagG ? String(flagG).replace(/^_/, '') : ''; }
function flagGFromGroupName(name) { return name ? '_' + name : ''; }

function serializeCfgFlagsClient(flags) {
    var parts = [];
    if (flags.E) parts.push('-E');
    if (flags.R !== null && flags.R !== undefined && !isNaN(flags.R)) parts.push('-R' + flags.R);
    if (flags.G) parts.push('-G' + flags.G);
    if (flags.V !== null && flags.V !== undefined && !isNaN(flags.V)) parts.push('-V' + ('00' + flags.V).slice(-3));
    if (flags.P !== null && flags.P !== undefined && !isNaN(flags.P)) parts.push('-P' + flags.P);
    if (flags.X) parts.push('-X');
    if (flags.N) parts.push('-N');
    if (flags.L) parts.push('-L' + flags.L);
    (flags.extra || []).forEach(function (extra) { parts.push(extra); });
    return parts.join(' ');
}

function setStatus(message) {
    var count = Object.keys(edits).length + Object.keys(dirtyVoiceGroups).length;
    byId('status').textContent = message || (count ? count + ' change(s) pending' : '');
}

function select(index) {
    commit();
    stopPlayback();
    selectedIndex = index;
    var song = songs[index];
    byId('empty').style.display = 'none';
    byId('add-song-overlay').style.display = 'none';
    byId('editor').style.display = 'flex';
    byId('title').textContent = song.name;
    byId('song-id').textContent = 'id ' + song.id + ' (' + song.label + '.mid)';
    byId('progress').value = 0;
    byId('time').textContent = '0:00 / 0:00';
    renderTabs();
    renderBody();
    renderList();
    setStatus();
}

function renderTabs() {
    var nav = byId('tabs'); nav.textContent = '';
    tabs.forEach(function (tab) {
        var button = document.createElement('button');
        button.className = 'tab' + (tab[0] === activeTab ? ' active-tab' : '');
        button.textContent = tab[1];
        button.onclick = function () { commit(); activeTab = tab[0]; renderTabs(); renderBody(); };
        nav.appendChild(button);
    });
}

function currentEditedFlags(song) {
    var edit = edits[song.name];
    if (edit && edit.cfg !== null && edit.cfg !== undefined) return parseCfgFlagsClient(edit.cfg);
    return song.cfgFlags;
}
function parseCfgFlagsClient(argsString) {
    var flags = { E: false, X: false, N: false, R: null, G: '', P: null, V: null, L: '', extra: [] };
    String(argsString || '').split(/\\s+/).filter(Boolean).forEach(function (token) {
        if (token[0] !== '-' || token.length < 2) { flags.extra.push(token); return; }
        var letter = token[1].toUpperCase(); var rest = token.slice(2);
        if (letter === 'E') flags.E = true; else if (letter === 'X') flags.X = true; else if (letter === 'N') flags.N = true;
        else if (letter === 'R') flags.R = rest === '' ? null : parseInt(rest, 10);
        else if (letter === 'G') flags.G = rest;
        else if (letter === 'P') flags.P = rest === '' ? null : parseInt(rest, 10);
        else if (letter === 'V') flags.V = rest === '' ? null : parseInt(rest, 10);
        else if (letter === 'L') flags.L = rest;
        else flags.extra.push(token);
    });
    return flags;
}

function fieldBlock(labelText, inputEl) {
    var wrap = document.createElement('div'); wrap.className = 'field';
    var label = document.createElement('label'); label.textContent = labelText;
    wrap.appendChild(label); wrap.appendChild(inputEl);
    return wrap;
}

function renderSongTab(song) {
    var root = byId('body'); root.textContent = '';
    var flags = currentEditedFlags(song);

    var identitySection = document.createElement('section'); identitySection.className = 'section';
    var identityHeading = document.createElement('h3'); identityHeading.textContent = 'Identity';
    var identityGrid = document.createElement('div'); identityGrid.className = 'grid';
    var nameInput = document.createElement('input'); nameInput.value = song.name; nameInput.disabled = true;
    identityGrid.appendChild(fieldBlock('Constant Name', nameInput));
    var idInput = document.createElement('input'); idInput.value = String(song.id); idInput.disabled = true;
    identityGrid.appendChild(fieldBlock('Numeric ID', idInput));
    var midiWrap = document.createElement('div'); midiWrap.className = 'field wide';
    var midiLabel = document.createElement('label'); midiLabel.textContent = 'MIDI File';
    var midiRow = document.createElement('div'); midiRow.style.display = 'flex'; midiRow.style.gap = '6px';
    var midiPathInput = document.createElement('input'); midiPathInput.value = song.midiRelativePath; midiPathInput.disabled = true;
    var importBtn = document.createElement('button'); importBtn.className = 'secondary small'; importBtn.textContent = song.hasMidi ? 'Replace...' : 'Import...';
    importBtn.onclick = function () { vscode.postMessage({ type: 'importMidi', label: song.label, selectedSongId: song.id }); };
    midiRow.appendChild(midiPathInput); midiRow.appendChild(importBtn);
    midiWrap.appendChild(midiLabel); midiWrap.appendChild(midiRow);
    identityGrid.appendChild(midiWrap);
    identitySection.appendChild(identityHeading); identitySection.appendChild(identityGrid);
    root.appendChild(identitySection);

    var tableSection = document.createElement('section'); tableSection.className = 'section';
    var tableHeading = document.createElement('h3'); tableHeading.textContent = 'Song Table Entry (gSongTable)';
    var tableGrid = document.createElement('div'); tableGrid.className = 'grid';
    var playerSelect = document.createElement('select'); playerSelect.id = 'field-music-player';
    musicPlayerOptions.forEach(function (option) { var opt = document.createElement('option'); opt.value = option; opt.textContent = option.replace('MUSIC_PLAYER_', ''); playerSelect.appendChild(opt); });
    playerSelect.value = song.musicPlayer; playerSelect.onchange = commit;
    tableGrid.appendChild(fieldBlock('Music Player', playerSelect));
    var unknownInput = document.createElement('input'); unknownInput.id = 'field-unknown'; unknownInput.value = song.unknown; unknownInput.oninput = commit;
    tableGrid.appendChild(fieldBlock('Unknown Field', unknownInput));
    tableSection.appendChild(tableHeading); tableSection.appendChild(tableGrid);
    root.appendChild(tableSection);

    var compilerSection = document.createElement('section'); compilerSection.className = 'section';
    var compilerHeading = document.createElement('h3'); compilerHeading.textContent = 'Compiler Settings (midi.cfg)';
    var compilerGrid = document.createElement('div'); compilerGrid.className = 'grid';
    var reverbInput = document.createElement('input'); reverbInput.id = 'field-reverb'; reverbInput.type = 'number'; reverbInput.value = flags.R === null ? '' : flags.R; reverbInput.oninput = commit;
    compilerGrid.appendChild(fieldBlock('Reverb (-R)', reverbInput));
    var volumeInput = document.createElement('input'); volumeInput.id = 'field-volume'; volumeInput.type = 'number'; volumeInput.min = 0; volumeInput.max = 127; volumeInput.value = flags.V === null ? '' : flags.V; volumeInput.oninput = commit;
    compilerGrid.appendChild(fieldBlock('Master Volume 0-127 (-V)', volumeInput));
    var priorityInput = document.createElement('input'); priorityInput.id = 'field-priority'; priorityInput.type = 'number'; priorityInput.value = flags.P === null ? '' : flags.P; priorityInput.oninput = commit;
    compilerGrid.appendChild(fieldBlock('Priority (-P)', priorityInput));
    var voiceGroupWrap = document.createElement('div'); voiceGroupWrap.className = 'field wide';
    var voiceGroupLabel = document.createElement('label'); voiceGroupLabel.textContent = 'Voice Group (-G)';
    var voiceGroupAcWrap = document.createElement('div'); voiceGroupAcWrap.className = 'ac-wrap';
    voiceGroupWrap.appendChild(voiceGroupLabel); voiceGroupWrap.appendChild(voiceGroupAcWrap);
    compilerGrid.appendChild(voiceGroupWrap);
    var voiceGroupAc = makeAC(voiceGroupAcWrap, voiceGroupNames, 'field-voicegroup-input');
    voiceGroupAc.setValue(groupNameFromFlagG(flags.G));
    voiceGroupAc.getEl().onchange = commit;
    compilerSection.appendChild(compilerHeading); compilerSection.appendChild(compilerGrid);

    var checksWrap = document.createElement('div'); checksWrap.style.padding = '0 11px 11px';
    [['field-exact-gate', 'Exact Gate Time (-E)', flags.E], ['field-48clocks', '48 Clocks per Beat (-X)', flags.X], ['field-no-compression', 'Disable Compression (-N)', flags.N]].forEach(function (item) {
        var row = document.createElement('label'); row.className = 'check-row';
        var checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = item[0]; checkbox.checked = item[2]; checkbox.onchange = commit;
        row.appendChild(checkbox); row.appendChild(document.createTextNode(item[1]));
        checksWrap.appendChild(row);
    });
    compilerSection.appendChild(checksWrap);
    var extraWrap = document.createElement('div'); extraWrap.style.padding = '0 11px 11px';
    var extraInput = document.createElement('input'); extraInput.id = 'field-extra-flags'; extraInput.value = (flags.extra || []).join(' '); extraInput.oninput = commit; extraInput.placeholder = 'Other raw mid2agb flags';
    extraWrap.appendChild(fieldBlock('Extra / Uncommon Flags', extraInput));
    compilerSection.appendChild(extraWrap);
    root.appendChild(compilerSection);
}

// ---------------------------------------------------------------------------
// UI — voice group editor
// ---------------------------------------------------------------------------

var VOICE_MACRO_SPECS = {
    voice_directsound: { params: ['baseKey', 'pan', 'sample', 'attack', 'decay', 'sustain', 'release'], label: 'Direct Sound (sample)' },
    voice_directsound_no_resample: { params: ['baseKey', 'pan', 'sample', 'attack', 'decay', 'sustain', 'release'], label: 'Direct Sound (fixed pitch)' },
    voice_directsound_alt: { params: ['baseKey', 'pan', 'sample', 'attack', 'decay', 'sustain', 'release'], label: 'Direct Sound (alt)' },
    voice_square_1: { params: ['baseKey', 'pan', 'sweep', 'dutyCycle', 'attack', 'decay', 'sustain', 'release'], label: 'Square Wave 1' },
    voice_square_1_alt: { params: ['baseKey', 'pan', 'sweep', 'dutyCycle', 'attack', 'decay', 'sustain', 'release'], label: 'Square Wave 1 (alt)' },
    voice_square_2: { params: ['baseKey', 'pan', 'dutyCycle', 'attack', 'decay', 'sustain', 'release'], label: 'Square Wave 2' },
    voice_square_2_alt: { params: ['baseKey', 'pan', 'dutyCycle', 'attack', 'decay', 'sustain', 'release'], label: 'Square Wave 2 (alt)' },
    voice_programmable_wave: { params: ['baseKey', 'pan', 'wave', 'attack', 'decay', 'sustain', 'release'], label: 'Programmable Wave' },
    voice_programmable_wave_alt: { params: ['baseKey', 'pan', 'wave', 'attack', 'decay', 'sustain', 'release'], label: 'Programmable Wave (alt)' },
    voice_noise: { params: ['baseKey', 'pan', 'period', 'attack', 'decay', 'sustain', 'release'], label: 'Noise' },
    voice_noise_alt: { params: ['baseKey', 'pan', 'period', 'attack', 'decay', 'sustain', 'release'], label: 'Noise (alt)' },
    voice_keysplit: { params: ['group', 'table'], label: 'Key Split (by table)' },
    voice_keysplit_all: { params: ['group'], label: 'Key Split (drumset, by note)' },
};
var PARAM_LABELS = { baseKey: 'Base Key', pan: 'Pan', sweep: 'Sweep', dutyCycle: 'Duty (0-3)', attack: 'Attack', decay: 'Decay', sustain: 'Sustain', release: 'Release', sample: 'Sample', wave: 'Wave', period: 'Period', group: 'Sub Group', table: 'Keysplit Table' };

function workingEntries(groupName) {
    if (!dirtyVoiceGroups[groupName]) dirtyVoiceGroups[groupName] = (voiceGroups[groupName].entries || []).map(function (entry) { return Object.assign({}, entry); });
    return dirtyVoiceGroups[groupName];
}

function renderVoiceGroupTab(song) {
    var root = byId('body'); root.textContent = '';
    var flags = currentEditedFlags(song);
    var groupName = groupNameFromFlagG(flags.G);

    var toolbar = document.createElement('div'); toolbar.className = 'vg-toolbar';
    var switchWrap = document.createElement('div'); switchWrap.className = 'ac-wrap';
    toolbar.appendChild(document.createTextNode('Voice Group: '));
    toolbar.appendChild(switchWrap);
    var switchAc = makeAC(switchWrap, voiceGroupNames);
    switchAc.setValue(groupName);
    switchAc.getEl().onchange = function () {
        var newGroupName = switchAc.getValue();
        var voiceGroupInput = byId('field-voicegroup-input');
        if (voiceGroupInput) voiceGroupInput.value = newGroupName;
        var newFlags = currentEditedFlags(song);
        newFlags.G = flagGFromGroupName(newGroupName);
        stageCfg(song, newFlags);
        setStatus();
        renderVoiceGroupTab(songs[selectedIndex]);
    };
    var newGroupBtn = document.createElement('button'); newGroupBtn.className = 'secondary small'; newGroupBtn.textContent = 'New Voice Group...';
    newGroupBtn.onclick = function () { promptCreateVoiceGroup(groupName); };
    toolbar.appendChild(newGroupBtn);
    root.appendChild(toolbar);

    if (!groupName || !voiceGroups[groupName]) {
        var missing = document.createElement('p'); missing.className = 'notice';
        missing.style.padding = '11px';
        missing.textContent = groupName ? 'Voice group "' + groupName + '" was not found.' : 'This song has no voice group assigned yet. Pick one above, or create a new one.';
        root.appendChild(missing);
        return;
    }

    var usedBy = songs.filter(function (candidate) { return groupNameFromFlagG(currentEditedFlags(candidate).G) === groupName; }).map(function (candidate) { return candidate.name; });
    var hint = document.createElement('div'); hint.className = 'vg-hint';
    hint.textContent = voiceGroups[groupName].sourceFile + ' - shared by: ' + usedBy.join(', ');
    root.appendChild(hint);

    var entries = workingEntries(groupName);
    var table = document.createElement('div'); table.className = 'vg-table';
    entries.forEach(function (entry, index) { table.appendChild(voiceEntryRow(groupName, entries, index)); });
    root.appendChild(table);

    var addRowBtn = document.createElement('button'); addRowBtn.className = 'small'; addRowBtn.textContent = '+ Add Instrument Slot';
    addRowBtn.style.margin = '0 11px 11px';
    addRowBtn.onclick = function () {
        entries.push({ macro: 'voice_square_1', kind: 'square1', leaf: true, baseKey: '60', pan: '0', sweep: '0', dutyCycle: '2', attack: '0', decay: '0', sustain: '15', release: '0' });
        markVoiceGroupDirty(groupName);
        renderVoiceGroupTab(songs[selectedIndex]);
    };
    root.appendChild(addRowBtn);
}

function markVoiceGroupDirty(groupName) { dirtyVoiceGroups[groupName] = dirtyVoiceGroups[groupName] || []; setStatus(); }

function numberParamInput(entry, groupName, paramName) {
    var input = document.createElement('input'); input.type = 'number'; input.value = entry[paramName] !== undefined ? entry[paramName] : '';
    input.oninput = function () { entry[paramName] = input.value.trim(); markVoiceGroupDirty(groupName); };
    return input;
}
function textParamInput(entry, groupName, paramName) {
    var input = document.createElement('input'); input.value = entry[paramName] !== undefined ? entry[paramName] : '';
    input.oninput = function () { entry[paramName] = input.value.trim(); markVoiceGroupDirty(groupName); };
    return input;
}
function dutyCycleSelect(entry, groupName) {
    var select = document.createElement('select');
    ['0 (12.5%)', '1 (25%)', '2 (50%)', '3 (75%)'].forEach(function (label, value) { var opt = document.createElement('option'); opt.value = String(value); opt.textContent = label; select.appendChild(opt); });
    select.value = entry.dutyCycle !== undefined ? entry.dutyCycle : '2';
    select.onchange = function () { entry.dutyCycle = select.value; markVoiceGroupDirty(groupName); };
    return select;
}
function sampleParamRow(entry, groupName, paramName, list, uriField, previewFn) {
    var wrap = document.createElement('div'); wrap.className = 'vg-sample-row';
    var acWrap = document.createElement('div'); acWrap.className = 'ac-wrap'; acWrap.style.flex = '1';
    var ac = makeAC(acWrap, list.map(function (item) { return item.symbol; }));
    ac.setValue(entry[paramName] || '');
    ac.getEl().onchange = function () {
        entry[paramName] = ac.getValue();
        var match = list.find(function (item) { return item.symbol === entry[paramName]; });
        entry[uriField] = match ? match.uri : '';
        markVoiceGroupDirty(groupName);
    };
    var playBtn = document.createElement('button'); playBtn.type = 'button'; playBtn.className = 'small secondary'; playBtn.textContent = '\u25B6';
    playBtn.onclick = function () { if (entry[uriField]) previewFn(entry[uriField]); };
    wrap.appendChild(acWrap); wrap.appendChild(playBtn);
    return wrap;
}

function voiceEntryRow(groupName, entries, index) {
    var entry = entries[index];
    var row = document.createElement('div'); row.className = 'vg-row';
    var idxLabel = document.createElement('div'); idxLabel.className = 'vg-idx'; idxLabel.textContent = '#' + index;
    row.appendChild(idxLabel);

    var typeSelect = document.createElement('select');
    Object.keys(VOICE_MACRO_SPECS).forEach(function (macro) { var opt = document.createElement('option'); opt.value = macro; opt.textContent = VOICE_MACRO_SPECS[macro].label; typeSelect.appendChild(opt); });
    typeSelect.value = entry.macro;
    row.appendChild(typeSelect);

    var paramsWrap = document.createElement('div'); paramsWrap.className = 'vg-params';
    row.appendChild(paramsWrap);

    function renderParams() {
        paramsWrap.textContent = '';
        var spec = VOICE_MACRO_SPECS[entry.macro];
        spec.params.forEach(function (paramName) {
            var block = document.createElement('div'); block.className = 'vg-param';
            var label = document.createElement('label'); label.textContent = PARAM_LABELS[paramName] || paramName;
            block.appendChild(label);
            var control;
            if (paramName === 'dutyCycle') control = dutyCycleSelect(entry, groupName);
            else if (paramName === 'sample') control = sampleParamRow(entry, groupName, 'sample', directSoundSamples, 'sampleUri', previewSample);
            else if (paramName === 'wave') control = sampleParamRow(entry, groupName, 'wave', programmableWaveSamples, 'waveUri', previewWave);
            else if (paramName === 'group' || paramName === 'table') control = textParamInput(entry, groupName, paramName);
            else control = numberParamInput(entry, groupName, paramName);
            block.appendChild(control);
            paramsWrap.appendChild(block);
        });
    }
    typeSelect.onchange = function () {
        var spec = VOICE_MACRO_SPECS[typeSelect.value];
        var fresh = { macro: typeSelect.value, kind: '', leaf: spec.params[0] !== 'group' };
        spec.params.forEach(function (paramName) { fresh[paramName] = entry[paramName] !== undefined ? entry[paramName] : defaultForParam(paramName); });
        entries[index] = fresh;
        entry = fresh;
        markVoiceGroupDirty(groupName);
        renderParams();
    };
    renderParams();

    var removeBtn = document.createElement('button'); removeBtn.className = 'small secondary'; removeBtn.textContent = 'Remove';
    removeBtn.onclick = function () { entries.splice(index, 1); markVoiceGroupDirty(groupName); renderVoiceGroupTab(songs[selectedIndex]); };
    row.appendChild(removeBtn);
    return row;
}

function defaultForParam(paramName) {
    var defaults = { baseKey: '60', pan: '0', sweep: '0', dutyCycle: '2', attack: '0', decay: '0', sustain: '15', release: '0', sample: '', wave: '', period: '0', group: '', table: '' };
    return defaults[paramName] || '';
}

function promptCreateVoiceGroup(cloneFrom) {
    var name = prompt('New voice group name (lowercase, letters/numbers/underscore):', '');
    if (!name) return;
    vscode.postMessage({ type: 'createVoiceGroup', request: { name: name, cloneFrom: cloneFrom || '' }, selectedSongId: selectedIndex >= 0 ? songs[selectedIndex].id : null });
}

function renderBody() {
    if (selectedIndex < 0) return;
    var song = songs[selectedIndex];
    if (activeTab === 'song') renderSongTab(song);
    else renderVoiceGroupTab(song);
}

// ---------------------------------------------------------------------------
// Add Song overlay
// ---------------------------------------------------------------------------

function showAddSongOverlay() {
    commit();
    byId('empty').style.display = 'none';
    byId('editor').style.display = 'none';
    byId('add-song-overlay').style.display = 'block';
    byId('new-song-name').value = '';
    byId('new-song-player').innerHTML = '';
    musicPlayerOptions.forEach(function (option) { var opt = document.createElement('option'); opt.value = option; opt.textContent = option.replace('MUSIC_PLAYER_', ''); byId('new-song-player').appendChild(opt); });
    var ac = makeAC(byId('new-song-voicegroup-wrap'), voiceGroupNames, 'new-song-voicegroup-input');
    byId('new-song-create').onclick = function () {
        vscode.postMessage({
            type: 'addSong',
            request: {
                name: byId('new-song-name').value,
                musicPlayer: byId('new-song-player').value,
                voiceGroup: ac.getValue(),
                reverb: byId('new-song-reverb').value,
                volume: byId('new-song-volume').value,
                priority: byId('new-song-priority').value,
            },
        });
    };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

byId('search').oninput = renderList;
byId('add-song-btn').onclick = showAddSongOverlay;
byId('new-song-cancel').onclick = function () { byId('add-song-overlay').style.display = 'none'; byId('empty').style.display = selectedIndex < 0 ? 'block' : 'none'; byId('editor').style.display = selectedIndex < 0 ? 'none' : 'flex'; };
byId('play-btn').onclick = playSong;
byId('stop-btn').onclick = stopPlayback;
byId('save').onclick = function () {
    commit();
    var payload = { songTable: {}, cfg: {}, voiceGroupBodies: {} };
    Object.keys(edits).forEach(function (name) {
        var edit = edits[name];
        if (edit.songTable && Object.keys(edit.songTable).length) payload.songTable[edit.label] = edit.songTable;
        if (edit.cfg !== null && edit.cfg !== undefined) payload.cfg[edit.label] = edit.cfg;
    });
    Object.keys(dirtyVoiceGroups).forEach(function (groupName) {
        payload.voiceGroupBodies[groupName] = dirtyVoiceGroups[groupName].map(function (entry) {
            var spec = VOICE_MACRO_SPECS[entry.macro];
            return { macro: entry.macro, params: spec.params.map(function (paramName) { return entry[paramName] !== undefined ? entry[paramName] : defaultForParam(paramName); }) };
        });
    });
    vscode.postMessage({ type: 'save', edits: payload, selectedSongId: selectedIndex >= 0 ? songs[selectedIndex].id : null });
};
byId('reload').onclick = function () {
    var hasChanges = Object.keys(edits).length || Object.keys(dirtyVoiceGroups).length;
    if (!hasChanges || confirm('Discard unsaved music changes?')) {
        vscode.postMessage({ type: 'reload', selectedSongId: selectedIndex >= 0 ? songs[selectedIndex].id : null });
    }
};

window.addEventListener('message', function (event) {
    var message = event.data;
    if (message.type === 'init') {
        songs = message.songs; voiceGroups = message.voiceGroups; voiceGroupNames = message.voiceGroupNames;
        keysplitTables = message.keysplitTables; directSoundSamples = message.directSoundSamples;
        programmableWaveSamples = message.programmableWaveSamples; musicPlayerOptions = message.musicPlayerOptions;
        selectedIndex = -1; edits = {}; dirtyVoiceGroups = {};
        byId('add-song-overlay').style.display = 'none';
        byId('editor').style.display = 'none'; byId('empty').style.display = 'block';
        renderList();
        if (message.selectedSongId !== undefined && message.selectedSongId !== null) {
            var index = songs.findIndex(function (song) { return song.id === message.selectedSongId; });
            if (index >= 0) select(index);
        }
        setStatus();
    }
    if (message.type === 'saveError') setStatus('Failed: ' + (message.message || ''));
});

vscode.postMessage({ type: 'ready' });
}());
`;

module.exports = { MusicEditorPanel };
