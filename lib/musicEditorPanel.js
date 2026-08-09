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
        this._musicPlayerTablePath = path.join(projectRoot.fsPath, 'sound', 'music_player_table.inc');
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
            const seenIds = new Set();
            for (const constant of constants) {
                // MUS_ROUTE118 (0x7FFF) and MUS_NONE (0xFFFF) are sentinels, not table indices.
                if (constant.name === 'MUS_ROUTE118' || constant.value === 0x7FFF || constant.value === 0xFFFF) continue;
                if (seenIds.has(constant.value)) continue;
                const entry = table[constant.value];
                if (!entry || entry.label === 'dummy_song_header') continue;
                seenIds.add(constant.value);
                const cfg = cfgMap.get(entry.label);
                const cfgArgs = cfg ? cfg.args : '';
                const cfgFlags = mp.parseCfgFlags(cfgArgs);
                songs.push({
                    id: constant.value,
                    name: constant.name,
                    category: constant.name.startsWith('MUS_') ? 'MUS' : (constant.name.startsWith('SE_') ? 'SE' : 'PH'),
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
            const categoryOrder = { MUS: 0, SE: 1, PH: 2 };
            songs.sort((a, b) => (categoryOrder[a.category] - categoryOrder[b.category]) || a.name.localeCompare(b.name));

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

            const trackBudgets = mp.parseTrackBudgets(this._read(this._musicPlayerTablePath));

            this._pendingInit = {
                type: 'init',
                songs,
                voiceGroups,
                voiceGroupNames: Object.keys(voiceGroups).sort(),
                keysplitTables: keysplitTablesPlain,
                directSoundSamples,
                programmableWaveSamples,
                musicPlayerOptions: MUSIC_PLAYER_OPTIONS,
                trackBudgets,
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

            // Edited songs come back as complete re-serialized SMF bytes (base64) — the .mid file
            const midiFileEdits = edits.midiFiles || {};
            for (const [label, base64] of Object.entries(midiFileEdits)) {
                if (!/^[A-Za-z0-9_]+$/.test(label)) throw new Error('Invalid song label: ' + label);
                fs.writeFileSync(path.join(this._midiDir, label + '.mid'), Buffer.from(base64, 'base64'));
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
.song-group{position:sticky;top:0;z-index:1;padding:5px 10px 3px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border)}
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
button.toggled{outline:1px solid var(--vscode-focusBorder)}
progress{cursor:pointer}
.poly{font-size:10px;color:var(--vscode-descriptionForeground);min-width:60px;white-space:nowrap}
.poly.warn{color:var(--vscode-errorForeground)}
#body.roll-mode{padding:0;overflow:hidden;display:flex}
.roll-root{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.roll-toolbar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;flex-wrap:wrap}
.roll-toolbar select{width:auto}
.roll-inspector{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}
.roll-insp-label{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}
.roll-insp-input{width:58px}
.roll-hint{font-size:10px;color:var(--vscode-descriptionForeground)}
.roll-main{display:flex;flex:1;min-height:0;min-width:0}
.roll-tracklist{width:190px;min-width:150px;overflow-y:auto;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-shrink:0}
.roll-track{display:flex;align-items:center;gap:6px;padding:5px 6px;cursor:pointer;border-bottom:1px solid var(--vscode-panel-border)}
.roll-track:hover{background:var(--vscode-list-hoverBackground)}
.roll-track.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.roll-swatch{width:8px;height:26px;border-radius:2px;flex-shrink:0}
.roll-track-info{flex:1;min-width:0}
.roll-track-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roll-track-detail{font-size:9px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roll-budget-warn{color:var(--vscode-errorForeground)}
.roll-ms{padding:1px 5px;font-size:9px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);flex-shrink:0}
.roll-ms.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);outline:1px solid var(--vscode-focusBorder)}
.roll-canvas-wrap{flex:1;min-width:0;position:relative;overflow:hidden}
.roll-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair}
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
        <button id="loop-btn" class="small secondary toggled" title="Loop between [ and ] markers">&#8635; Loop</button>
        <progress id="progress" value="0" max="1" title="Click to seek"></progress>
        <span class="time" id="time">0:00 / 0:00</span>
        <span class="poly" id="poly-meter" title="DirectSound channels in use vs the engine's maxChans; stolen notes exceeded the limit"></span>
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

var songs = [], voiceGroups = {}, voiceGroupNames = [], keysplitTables = {}, directSoundSamples = [], programmableWaveSamples = [], musicPlayerOptions = [], trackBudgets = {};
var selectedIndex = -1, activeTab = 'tracks', edits = {}, dirtyVoiceGroups = {};
var tabs = [['tracks', 'Tracks'], ['song', 'Song'], ['voicegroup', 'Voice Group']];

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
// Standard MIDI File — full-fidelity parser + writer.
// The .mid file is the canonical song document: every event is
// kept (metas, sysex, unknown CCs) so an edit session can round-trip a file
// authored elsewhere without losing anything playback doesn't model.
// ---------------------------------------------------------------------------

function parseSmf(buffer) {
    var bytes = new Uint8Array(buffer);
    var pos = 0;
    function readUint32() { var v = (bytes[pos] * 0x1000000) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3]; pos += 4; return v; }
    function readUint16() { var v = (bytes[pos] << 8) + bytes[pos + 1]; pos += 2; return v; }
    function readString(n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(bytes[pos + i]); pos += n; return s; }
    function readVarLen() { var value = 0, byte; do { byte = bytes[pos++]; value = (value << 7) | (byte & 0x7f); } while (byte & 0x80); return value >>> 0; }

    if (readString(4) !== 'MThd') throw new Error('Not a MIDI file');
    var headerLen = readUint32();
    var format = readUint16();
    var numTracks = readUint16();
    var division = readUint16();
    pos += Math.max(0, headerLen - 6);
    var tracks = [];
    for (var t = 0; t < numTracks && pos < bytes.length; t++) {
        var chunkId = readString(4);
        var trackLen = readUint32();
        if (chunkId !== 'MTrk') { pos += trackLen; t--; continue; }
        var trackEnd = pos + trackLen;
        var events = [];
        var tick = 0;
        var runningStatus = 0;
        while (pos < trackEnd) {
            tick += readVarLen();
            var statusByte = bytes[pos];
            if (statusByte & 0x80) { pos++; runningStatus = statusByte; } else { statusByte = runningStatus; }
            if (statusByte === 0xFF) {
                var metaType = bytes[pos++];
                var metaLen = readVarLen();
                var metaData = [];
                for (var m = 0; m < metaLen; m++) metaData.push(bytes[pos + m]);
                pos += metaLen;
                events.push({ tick: tick, kind: 'meta', metaType: metaType, data: metaData });
            } else if (statusByte === 0xF0 || statusByte === 0xF7) {
                var sysexLen = readVarLen();
                var sysexData = [];
                for (var x = 0; x < sysexLen; x++) sysexData.push(bytes[pos + x]);
                pos += sysexLen;
                events.push({ tick: tick, kind: 'sysex', status: statusByte, data: sysexData });
            } else {
                var statusKind = statusByte & 0xF0;
                var channel = statusByte & 0x0F;
                if (statusKind === 0xC0 || statusKind === 0xD0) {
                    events.push({ tick: tick, kind: 'ch', status: statusKind, ch: channel, d1: bytes[pos++], d2: 0 });
                } else {
                    var d1 = bytes[pos++], d2 = bytes[pos++];
                    events.push({ tick: tick, kind: 'ch', status: statusKind, ch: channel, d1: d1, d2: d2 });
                }
            }
        }
        tracks.push({ events: events });
        pos = trackEnd;
    }
    return { format: format, division: (division & 0x8000) ? 24 : (division || 24), tracks: tracks };
}

function varLenBytes(value) {
    value = value >>> 0;
    var stack = [value & 0x7f];
    value >>>= 7;
    while (value) { stack.push((value & 0x7f) | 0x80); value >>>= 7; }
    stack.reverse();
    return stack;
}

function writeSmf(smf) {
    var out = [];
    function pushStr(s) { for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); }
    function pushU32(v) { out.push((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF); }
    function pushU16(v) { out.push((v >>> 8) & 0xFF, v & 0xFF); }
    pushStr('MThd'); pushU32(6); pushU16(smf.format); pushU16(smf.tracks.length); pushU16(smf.division);
    smf.tracks.forEach(function (track) {
        var body = [];
        var lastTick = 0;
        track.events.forEach(function (ev) {
            var delta = Math.max(0, ev.tick - lastTick);
            lastTick = Math.max(lastTick, ev.tick);
            varLenBytes(delta).forEach(function (b) { body.push(b); });
            if (ev.kind === 'meta') {
                body.push(0xFF, ev.metaType & 0xFF);
                varLenBytes(ev.data.length).forEach(function (b) { body.push(b); });
                ev.data.forEach(function (b) { body.push(b & 0xFF); });
            } else if (ev.kind === 'sysex') {
                body.push(ev.status);
                varLenBytes(ev.data.length).forEach(function (b) { body.push(b); });
                ev.data.forEach(function (b) { body.push(b & 0xFF); });
            } else {
                body.push((ev.status | ev.ch) & 0xFF, ev.d1 & 0x7F);
                if (ev.status !== 0xC0 && ev.status !== 0xD0) body.push(ev.d2 & 0x7F);
            }
        });
        pushStr('MTrk'); pushU32(body.length);
        body.forEach(function (b) { out.push(b); });
    });
    return new Uint8Array(out);
}

function bytesToBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function metaText(data) {
    var s = '';
    for (var i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
    return s;
}

// ---------------------------------------------------------------------------
// Song document: the SMF projected into editable tracks + timing structures.
// Engine track mapping follows mid2agb: each MTrk with channel events becomes
// an agb track in file order; a format-0 file yields one track per channel in
// ascending channel order.
// ---------------------------------------------------------------------------

function buildDoc(smf) {
    var doc = {
        smf: smf, division: smf.division, tracks: [],
        tempoEvents: [], timeSigs: [], loopStartTick: null, loopEndTick: null,
        lengthTicks: 0, nextNoteId: 1,
    };
    smf.tracks.forEach(function (smfTrack, smfIndex) {
        var name = '';
        var channelsSeen = [];
        smfTrack.events.forEach(function (ev) {
            if (ev.tick > doc.lengthTicks) doc.lengthTicks = ev.tick;
            if (ev.kind === 'meta') {
                if (ev.metaType === 0x51 && ev.data.length >= 3) {
                    doc.tempoEvents.push({ tick: ev.tick, mpqn: (ev.data[0] << 16) + (ev.data[1] << 8) + ev.data[2] });
                } else if (ev.metaType === 0x58 && ev.data.length >= 2) {
                    doc.timeSigs.push({ tick: ev.tick, numerator: ev.data[0], denomPow2: ev.data[1] });
                } else if (ev.metaType === 0x03 && !name) {
                    name = metaText(ev.data);
                } else if (ev.metaType === 0x06 || ev.metaType === 0x01) {
                    var text = metaText(ev.data).trim();
                    if (text === '[') doc.loopStartTick = ev.tick;
                    else if (text === ']') doc.loopEndTick = ev.tick;
                }
            } else if (ev.kind === 'ch') {
                if (channelsSeen.indexOf(ev.ch) === -1) channelsSeen.push(ev.ch);
            }
        });
        channelsSeen.sort(function (a, b) { return a - b; });
        channelsSeen.forEach(function (channel) {
            var docTrack = { smfIndex: smfIndex, channel: channel, name: name, notes: [], firstProgram: -1, otherCount: 0 };
            var open = {};
            smfTrack.events.forEach(function (ev) {
                if (ev.kind !== 'ch' || ev.ch !== channel) return;
                if (ev.status === 0xC0 && docTrack.firstProgram === -1) docTrack.firstProgram = ev.d1;
                if (ev.status === 0x90 && ev.d2 > 0) {
                    if (!open[ev.d1]) open[ev.d1] = [];
                    open[ev.d1].push({ tick: ev.tick, vel: ev.d2 });
                } else if (ev.status === 0x80 || (ev.status === 0x90 && ev.d2 === 0)) {
                    var queue = open[ev.d1];
                    if (queue && queue.length) {
                        var start = queue.shift();
                        docTrack.notes.push({ id: doc.nextNoteId++, tick: start.tick, dur: Math.max(1, ev.tick - start.tick), key: ev.d1, vel: start.vel });
                    }
                } else if (ev.status !== 0x90 && ev.status !== 0x80) {
                    docTrack.otherCount++;
                }
            });
            Object.keys(open).forEach(function (key) {
                open[key].forEach(function (start) {
                    docTrack.notes.push({ id: doc.nextNoteId++, tick: start.tick, dur: doc.division, key: parseInt(key, 10), vel: start.vel });
                });
            });
            docTrack.notes.sort(function (a, b) { return a.tick - b.tick || a.key - b.key; });
            doc.tracks.push(docTrack);
        });
    });
    doc.tempoEvents.sort(function (a, b) { return a.tick - b.tick; });
    doc.timeSigs.sort(function (a, b) { return a.tick - b.tick; });
    doc.tracks.forEach(function (docTrack) {
        docTrack.notes.forEach(function (note) {
            if (note.tick + note.dur > doc.lengthTicks) doc.lengthTicks = note.tick + note.dur;
        });
    });
    return doc;
}

// Rebuild one SMF track's event list from an edited note list: everything that
// is not a note on/off of this doc-track's channel is preserved in original
// order; within a tick the canonical class order is setup events, then note
// ends, then note starts (the intra-tick order mid2agb's pairing depends on).
function rebuildSmfTrack(doc, docTrack) {
    var smfTrack = doc.smf.tracks[docTrack.smfIndex];
    var merged = [];
    var seq = 0;
    smfTrack.events.forEach(function (ev) {
        if (ev.kind === 'ch' && ev.ch === docTrack.channel && (ev.status === 0x90 || ev.status === 0x80)) return;
        if (ev.kind === 'meta' && ev.metaType === 0x2F) return;
        merged.push({ tick: ev.tick, cls: 0, seq: seq++, ev: ev });
    });
    docTrack.notes.forEach(function (note) {
        merged.push({ tick: note.tick, cls: 2, seq: seq++, ev: { tick: note.tick, kind: 'ch', status: 0x90, ch: docTrack.channel, d1: note.key, d2: note.vel } });
        merged.push({ tick: note.tick + note.dur, cls: 1, seq: seq++, ev: { tick: note.tick + note.dur, kind: 'ch', status: 0x80, ch: docTrack.channel, d1: note.key, d2: 0 } });
    });
    merged.sort(function (a, b) { return a.tick - b.tick || a.cls - b.cls || a.seq - b.seq; });
    var events = merged.map(function (item) { item.ev.tick = item.tick; return item.ev; });
    var endTick = events.length ? events[events.length - 1].tick : 0;
    events.push({ tick: endTick, kind: 'meta', metaType: 0x2F, data: [] });
    smfTrack.events = events;
}

// ---------------------------------------------------------------------------
// mid2agb simulation (WYHIWYG): what the build pipeline does to note data
// before the m4a engine ever sees it. Tables from tools/mid2agb/tables.cpp.
// ---------------------------------------------------------------------------

var DURATION_LUT = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 24, 24, 24, 28, 28, 30, 30, 32, 32, 32, 32, 36, 36, 36, 36,
    40, 40, 42, 42, 44, 44, 44, 44, 48, 48, 48, 48, 52, 52, 54, 54, 56, 56, 56, 56,
    60, 60, 60, 60, 64, 64, 66, 66, 68, 68, 68, 68, 72, 72, 72, 72, 76, 76, 78, 78,
    80, 80, 80, 80, 84, 84, 84, 84, 88, 88, 90, 90, 92, 92, 92, 92, 96];

function effectiveVelocity(velocity) {
    if (velocity <= 0) return 0;
    var v = Math.ceil(velocity / 4) * 4;
    return v > 127 ? 127 : v;
}

function effectiveDurationClocks(durTicks, division, clocksPerBeat, exactGate) {
    var duration = division ? Math.floor((clocksPerBeat * durTicks) / division) : durTicks;
    if (duration <= 0) duration = 1;
    if (!exactGate && duration < 96) duration = DURATION_LUT[duration];
    return duration;
}

// The engine's TEMPO command stores bpm/2 and doubles it back: effective BPM is
// always even. A song with no tempo meta plays at the m4a default of 150 BPM
// (MPlayStart tempoD), not MIDI's 120.
function effectiveMpqn(mpqn) {
    var bpm = Math.round(60000000 / mpqn);
    var effBpm = 2 * Math.floor(bpm / 2);
    if (effBpm <= 0) effBpm = 2;
    return 60000000 / effBpm;
}

function buildDocTempoMap(doc) {
    var map = doc.tempoEvents.map(function (ev) { return { tick: ev.tick, mpqn: effectiveMpqn(ev.mpqn) }; });
    if (!map.length || map[0].tick > 0) map.unshift({ tick: 0, mpqn: 60000000 / 150 });
    return map;
}

function tickToSeconds(tick, tempoMap, division) {
    var seconds = 0, lastTick = 0, lastMpqn = tempoMap[0].mpqn;
    for (var i = 0; i < tempoMap.length; i++) {
        var entry = tempoMap[i];
        if (entry.tick >= tick) break;
        seconds += (entry.tick - lastTick) * lastMpqn / division / 1e6;
        lastTick = entry.tick; lastMpqn = entry.mpqn;
    }
    seconds += (tick - lastTick) * lastMpqn / division / 1e6;
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
    // A user pause suspends the whole context; auditioning then must not
    // silently resume the paused song underneath.
    if (audioCtx.state === 'suspended' && !(player && player.paused)) audioCtx.resume();
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

// ---------------------------------------------------------------------------
// m4a engine ground truth (src/m4a.c, m4a_1.s, m4a_tables.c) — envelopes run
// at the 60 Hz frame rate, CGB loudness quantizes to 15 steps, the wave
// channel to gCgb3Vol's 5 levels, noise pitch through gNoiseTable, and
// DirectSound polyphony is capped by m4aSoundInit's maxChans.
// ---------------------------------------------------------------------------

var FRAME_SECONDS = 1 / 60;
var GBA_MASTER_VOLUME = 13 / 16; // m4aSoundInit masterVolume 12 -> (12+1)/16
var DS_MAX_CHANNELS = 5;         // m4aSoundInit (5 << SOUND_MODE_MAXCHN_SHIFT)
var CGB_MIX = 0.55;              // PSG-vs-PCM balance approximation
var NOISE_TABLE = [
    0xD7, 0xD6, 0xD5, 0xD4, 0xC7, 0xC6, 0xC5, 0xC4, 0xB7, 0xB6, 0xB5, 0xB4,
    0xA7, 0xA6, 0xA5, 0xA4, 0x97, 0x96, 0x95, 0x94, 0x87, 0x86, 0x85, 0x84,
    0x77, 0x76, 0x75, 0x74, 0x67, 0x66, 0x65, 0x64, 0x57, 0x56, 0x55, 0x54,
    0x47, 0x46, 0x45, 0x44, 0x37, 0x36, 0x35, 0x34, 0x27, 0x26, 0x25, 0x24,
    0x17, 0x16, 0x15, 0x14, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00];
var CGB3_GAIN = [0, 0, 0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.5, 0.75, 0.75, 0.75, 0.75, 1, 1];

function intParam(value, fallback) { var n = parseInt(value, 10); return isNaN(n) ? fallback : n; }

// Voice macro pan byte: 0 = follow track, otherwise c_v+/-n (0x80|value in the
// binary); ply_note turns it into rhythmPan = (value - 64) * 2, range -128..126.
function voiceRhythmPan(panText) {
    var raw = String(panText || '0').trim();
    var value = 0;
    if (raw.indexOf('c_v') === 0) value = 64 + (parseInt(raw.slice(3), 10) || 0);
    else value = parseInt(raw, 10) || 0;
    if (!value) return 0;
    return clampNum(((value & 0x7F) - 64) * 2, -128, 126);
}

function cancelHold(param, time) {
    if (param.cancelAndHoldAtTime) { try { param.cancelAndHoldAtTime(time); return; } catch (e) {} }
    param.cancelScheduledValues(time);
}

// DirectSound (software-mixed) envelope: per frame env += attack (to 255),
// then env = env*decay>>8 down to sustain, hold; on release env = env*release>>8.
// attack==0 legitimately never rises (silent), matching hardware.
function scheduleDsEnvelope(gainNode, entry, peak, startTime, offTime) {
    var attack = clampNum(intParam(entry.attack, 255), 0, 255);
    var decay = clampNum(intParam(entry.decay, 255), 0, 255);
    var sustain = clampNum(intParam(entry.sustain, 255), 0, 255);
    var release = clampNum(intParam(entry.release, 0), 0, 255);
    var g = gainNode.gain;
    g.setValueAtTime(0, startTime);
    var peakTime = startTime;
    if (attack >= 255) {
        g.setValueAtTime(peak, startTime);
    } else if (attack > 0) {
        peakTime = startTime + (255 / attack) * FRAME_SECONDS;
        g.linearRampToValueAtTime(peak, peakTime);
    } else {
        return offTime + 0.02; // attack 0: envelope never leaves zero
    }
    if (sustain < 255) {
        var sustainLevel = peak * (sustain / 256);
        if (decay <= 0) {
            g.setValueAtTime(sustainLevel, peakTime);
        } else {
            var decayTau = 1 / (60 * Math.log(256 / decay));
            g.setTargetAtTime(sustainLevel, peakTime, decayTau);
        }
    }
    cancelHold(g, Math.max(offTime, startTime));
    var stopAt;
    if (release <= 0) {
        g.setValueAtTime(0, offTime);
        stopAt = offTime + 0.01;
    } else {
        var releaseTau = 1 / (60 * Math.log(256 / release));
        g.setTargetAtTime(0, offTime, releaseTau);
        stopAt = offTime + Math.min(6, releaseTau * 7) + 0.05;
    }
    return stopAt;
}

// CGB envelope: one volume step every "rate" frames; goal already includes
// velocity and track volume quantized to 0..15 (CgbModVol). The wave channel's
// DAC only has gCgb3Vol's coarse levels.
function scheduleCgbEnvelope(gainNode, entry, goalSteps, startTime, offTime, isWaveChannel) {
    var attack = clampNum(intParam(entry.attack, 0), 0, 7);
    var decay = clampNum(intParam(entry.decay, 0), 0, 7);
    var sustain = clampNum(intParam(entry.sustain, 15), 0, 15);
    var release = clampNum(intParam(entry.release, 0), 0, 7);
    function level(steps) { return CGB_MIX * (isWaveChannel ? CGB3_GAIN[clampNum(steps, 0, 15)] : clampNum(steps, 0, 15) / 15); }
    var sustainSteps = Math.min(goalSteps, (goalSteps * sustain + 15) >> 4);
    var g = gainNode.gain;
    var t = startTime;
    if (attack === 0) {
        g.setValueAtTime(level(goalSteps), startTime);
    } else {
        g.setValueAtTime(0, startTime);
        t = startTime + attack * goalSteps * FRAME_SECONDS;
        g.linearRampToValueAtTime(level(goalSteps), t);
    }
    if (sustainSteps < goalSteps) {
        if (decay === 0) {
            g.setValueAtTime(level(sustainSteps), t);
        } else {
            t = t + decay * (goalSteps - sustainSteps) * FRAME_SECONDS;
            g.linearRampToValueAtTime(level(sustainSteps), t);
        }
    }
    var off = Math.max(offTime, startTime + 0.002);
    cancelHold(g, off);
    var stopAt;
    if (release === 0) {
        g.setValueAtTime(0, off);
        stopAt = off + 0.01;
    } else {
        var releaseTime = Math.max(0.008, release * Math.max(sustainSteps, 1) * FRAME_SECONDS);
        g.linearRampToValueAtTime(0, off + releaseTime);
        stopAt = off + releaseTime + 0.03;
    }
    return stopAt;
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

function transposedKey(note, baseKey) { return note + (60 - (intParam(baseKey, 60))); }

function noisePlaybackRate(ctx, note, baseKey) {
    var idx = clampNum(transposedKey(note, baseKey) - 21, 0, 59);
    var v = NOISE_TABLE[idx];
    var divisorCode = v & 0x7;
    var shift = (v >> 4) & 0xF;
    var lfsrHz = 524288 / (divisorCode === 0 ? 0.5 : divisorCode) / Math.pow(2, shift + 1);
    return clampNum(lfsrHz / ctx.sampleRate, 0.001, 24);
}

// Creates the source + envelope gain for one resolved voice. Callers route
// gainNode into their own pan/volume graph and may schedule detune/frequency
// automation on the returned source. Returns null when unplayable.
function synthNote(ctx, resolved, key, opts) {
    var gainNode = ctx.createGain();
    var source = null;
    var stopAt = opts.offTime + 0.05;
    var kind = resolved.kind;
    if (kind === 'square1' || kind === 'square2') {
        source = ctx.createOscillator();
        source.setPeriodicWave(getPulseWave(ctx, intParam(resolved.dutyCycle, 2)));
        var sqFreq = noteToFrequency(transposedKey(key, resolved.baseKey));
        source.frequency.setValueAtTime(sqFreq, opts.startTime);
        if (kind === 'square1') applySweep(resolved.sweep, source, sqFreq, opts.startTime, opts.offTime - opts.startTime);
        stopAt = scheduleCgbEnvelope(gainNode, resolved, opts.cgbGoal, opts.startTime, opts.offTime, false);
    } else if (kind === 'wave') {
        source = ctx.createOscillator();
        var wave = getProgrammableWave(resolved.waveUri);
        if (wave) source.setPeriodicWave(wave); else source.type = 'triangle';
        source.frequency.setValueAtTime(noteToFrequency(transposedKey(key, resolved.baseKey)), opts.startTime);
        stopAt = scheduleCgbEnvelope(gainNode, resolved, opts.cgbGoal, opts.startTime, opts.offTime, true);
    } else if (kind === 'noise') {
        source = ctx.createBufferSource();
        source.buffer = getNoiseBuffer(ctx, intParam(resolved.period, 0) === 1);
        source.loop = true;
        source.playbackRate.setValueAtTime(noisePlaybackRate(ctx, key, resolved.baseKey), opts.startTime);
        stopAt = scheduleCgbEnvelope(gainNode, resolved, opts.cgbGoal, opts.startTime, opts.offTime, false);
    } else if (kind === 'directsound') {
        var buffer = sampleBufferCache[resolved.sampleUri];
        if (!buffer) return null;
        source = ctx.createBufferSource();
        source.buffer = buffer;
        var noResample = (resolved.macro || '').indexOf('no_resample') !== -1;
        var rate = noResample ? 1 : Math.pow(2, (key - intParam(resolved.baseKey, 60)) / 12);
        source.playbackRate.setValueAtTime(clampNum(rate, 0.03, 16), opts.startTime);
        source.loop = false;
        stopAt = scheduleDsEnvelope(gainNode, resolved, opts.dsPeak, opts.startTime, opts.offTime);
    } else {
        return null;
    }
    source.connect(gainNode);
    try { source.start(opts.startTime); source.stop(stopAt + 0.05); } catch (e) { return null; }
    return { source: source, gain: gainNode, stopAt: stopAt, kind: kind };
}

// CgbModVol: envelope goal = (leftVolume + rightVolume) / 16 where each side is
// velocity x track volume — i.e. 15-step loudness including velocity.
function cgbGoalSteps(velocity, trackVol) {
    return clampNum(Math.floor(velocity * trackVol / 1024), 0, 15);
}

// m4a pan law (TrkVolPitSet / ChnVolSetAsm): linear, y = 2*pan in -128..127.
function panGainsFor(trackPan, rhythmPan) {
    var y = clampNum(2 * trackPan, -128, 127);
    var left = (127 - y) / 256;
    var right = (y + 128) / 256;
    if (rhythmPan) {
        left = left * (127 - rhythmPan) / 128;
        right = right * (128 + rhythmPan) / 128;
    }
    return { left: Math.max(0, left), right: Math.max(0, right) };
}

// CGB output is pan-independent in level, but hard-gated per side (CgbPan).
function cgbPanGainsFor(trackPan) {
    var y = clampNum(2 * trackPan, -128, 127);
    if (y >= 42) return { left: 0, right: 1 };
    if (y <= -43) return { left: 1, right: 0 };
    return { left: 0.5, right: 0.5 };
}

// ---------------------------------------------------------------------------
// Performance compiler — projects the song document through the mid2agb
// transforms into a flat, time-sorted event list (the "compiled song"), so
// playback hears exactly what the ROM build would produce.
// ---------------------------------------------------------------------------

function compilePerformance(doc, song) {
    var flags = currentEditedFlags(song);
    var clocksPerBeat = flags.X ? 48 : 24;
    var exactGate = !!flags.E;
    var mvl = flags.V === null || flags.V === undefined ? 127 : clampNum(flags.V, 0, 127);
    var reverb = flags.R === null || flags.R === undefined ? 0 : clampNum(flags.R, 0, 127);
    var division = doc.division;
    var tempoMap = buildDocTempoMap(doc);
    var budget = trackBudgets[stagedMusicPlayer(song)] || 16;

    function quantizedTick(tick) { return Math.floor(tick * clocksPerBeat / division) * division / clocksPerBeat; }
    function timeAt(tick) { return tickToSeconds(tick, tempoMap, division); }

    var events = [];
    var duration = 0.1;
    var silentTracks = [];
    doc.tracks.forEach(function (docTrack, trackIndex) {
        if (trackIndex >= budget || trackIndex >= 16) { silentTracks.push(trackIndex); return; }
        var smfTrack = doc.smf.tracks[docTrack.smfIndex];
        smfTrack.events.forEach(function (ev) {
            if (ev.kind !== 'ch' || ev.ch !== docTrack.channel) return;
            var t = timeAt(quantizedTick(ev.tick));
            if (ev.status === 0xC0) events.push({ t: t, cls: 0, track: trackIndex, type: 'prog', value: ev.d1 });
            else if (ev.status === 0xE0) events.push({ t: t, cls: 0, track: trackIndex, type: 'bend', value: ev.d2 - 64 });
            else if (ev.status === 0xB0) {
                if (ev.d1 === 7) events.push({ t: t, cls: 0, track: trackIndex, type: 'vol', value: Math.floor(ev.d2 * mvl / 128) });
                else if (ev.d1 === 10) events.push({ t: t, cls: 0, track: trackIndex, type: 'pan', value: ev.d2 - 64 });
                else if (ev.d1 === 1) events.push({ t: t, cls: 0, track: trackIndex, type: 'mod', value: ev.d2 });
                else if (ev.d1 === 20) events.push({ t: t, cls: 0, track: trackIndex, type: 'bendr', value: ev.d2 });
                else if (ev.d1 === 21) events.push({ t: t, cls: 0, track: trackIndex, type: 'lfos', value: ev.d2 });
            }
        });
        docTrack.notes.forEach(function (note) {
            var vel = effectiveVelocity(note.vel);
            if (vel <= 0) return;
            var startClockTick = quantizedTick(note.tick);
            var durClocks = effectiveDurationClocks(note.dur, division, clocksPerBeat, exactGate);
            var startT = timeAt(startClockTick);
            var endT = timeAt(startClockTick + durClocks * division / clocksPerBeat);
            events.push({ t: startT, cls: 1, track: trackIndex, type: 'note', key: note.key, vel: vel, endT: endT, noteId: note.id });
            if (endT > duration) duration = endT;
        });
    });
    events.sort(function (a, b) { return a.t - b.t || a.cls - b.cls || a.track - b.track; });

    var loopStartT = doc.loopStartTick !== null ? timeAt(doc.loopStartTick) : null;
    var loopEndT = doc.loopEndTick !== null ? timeAt(doc.loopEndTick) : null;
    var hasLoop = loopStartT !== null && loopEndT !== null && loopEndT > loopStartT;
    return {
        events: events, duration: duration, reverb: reverb,
        hasLoop: hasLoop, loopStartT: hasLoop ? loopStartT : null, loopEndT: hasLoop ? loopEndT : null,
        trackCount: doc.tracks.length, silentTracks: silentTracks,
        tempoMap: tempoMap, division: division,
    };
}

function stagedMusicPlayer(song) {
    var edit = edits[song.name];
    if (edit && edit.songTable && edit.songTable.musicPlayer) return edit.songTable.musicPlayer;
    return song.musicPlayer;
}

// Collect every sample/wave URI reachable from a song's voicegroup so playback
// can synchronously pull decoded buffers out of the caches.
function collectSongAssetUris(groupName, depth, seenGroups, out) {
    depth = depth || 0;
    seenGroups = seenGroups || {};
    out = out || { samples: {}, waves: {} };
    if (depth > 4 || !groupName || seenGroups[groupName]) return out;
    seenGroups[groupName] = true;
    var group = voiceGroups[groupName];
    if (!group) return out;
    group.entries.forEach(function (entry) {
        if (entry.kind === 'directsound' && entry.sampleUri) out.samples[entry.sampleUri] = true;
        if (entry.kind === 'wave' && entry.waveUri) out.waves[entry.waveUri] = true;
        if (entry.kind === 'keysplit' || entry.kind === 'keysplit_all') {
            collectSongAssetUris((entry.group || '').replace('voicegroup_', ''), depth + 1, seenGroups, out);
        }
    });
    return out;
}

function preloadSongAssets(ctx, groupName) {
    var uris = collectSongAssetUris(groupName);
    var tasks = [];
    Object.keys(uris.samples).forEach(function (uri) { tasks.push(getSampleBuffer(ctx, uri)); });
    Object.keys(uris.waves).forEach(function (uri) { tasks.push(preloadProgrammableWave(ctx, uri)); });
    return Promise.all(tasks);
}

// ---------------------------------------------------------------------------
// Real-time sequencer. Runs a lookahead scheduler over the compiled event
// list, maintaining per-track m4a state (VOL/PAN/BEND/BENDR/MOD/LFOS/program)
// so controller changes affect already-sounding notes, honoring loop markers
// (GOTO semantics), CGB channel exclusivity, and the DirectSound channel cap.
// ---------------------------------------------------------------------------

var player = null;
var loopEnabled = true;
var followPlayhead = true;
var trackMute = {}, trackSolo = {};

function isTrackAudible(trackIndex) {
    var anySolo = Object.keys(trackSolo).some(function (k) { return trackSolo[k]; });
    if (anySolo) return !!trackSolo[trackIndex];
    return !trackMute[trackIndex];
}

function lowerBoundEvent(events, t) {
    var lo = 0, hi = events.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (events[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo;
}

function createPlayerSession(ctx, perf, song, fromT) {
    var session = {
        ctx: ctx, perf: perf, song: song,
        master: ctx.createGain(), leftBus: ctx.createGain(), rightBus: ctx.createGain(),
        merger: ctx.createChannelMerger(2),
        tracks: [], pointer: 0, offset: 0, timer: null,
        dsActive: [], cgbBusy: {}, stolenCount: 0, dsPeakUsage: 0,
        paused: false, done: false,
    };
    session.master.gain.value = GBA_MASTER_VOLUME;
    session.leftBus.connect(session.merger, 0, 0);
    session.rightBus.connect(session.merger, 0, 1);
    session.merger.connect(session.master);
    session.master.connect(masterGain);
    if (perf.reverb > 0) {
        // m4a reverb feeds the PCM DMA buffer (7 frames ~ 117 ms) back at reverb/128.
        session.reverbIn = ctx.createGain();
        session.reverbIn.gain.value = perf.reverb / 128;
        session.reverbDelay = ctx.createDelay(0.5);
        session.reverbDelay.delayTime.value = 7 / 60;
        session.reverbFeedback = ctx.createGain();
        session.reverbFeedback.gain.value = perf.reverb / 128;
        session.reverbIn.connect(session.reverbDelay);
        session.reverbDelay.connect(session.reverbFeedback);
        session.reverbFeedback.connect(session.reverbDelay);
        session.reverbDelay.connect(session.leftBus);
        session.reverbDelay.connect(session.rightBus);
    }
    for (var i = 0; i < Math.min(perf.trackCount, 16); i++) {
        var dsVol = ctx.createGain(); dsVol.gain.value = 0;
        var dsL = ctx.createGain(), dsR = ctx.createGain();
        var cgbL = ctx.createGain(), cgbR = ctx.createGain();
        dsVol.connect(dsL); dsVol.connect(dsR);
        dsL.connect(session.leftBus); dsR.connect(session.rightBus);
        cgbL.connect(session.leftBus); cgbR.connect(session.rightBus);
        if (session.reverbIn) dsVol.connect(session.reverbIn);
        var lfo = ctx.createOscillator(); lfo.type = 'triangle';
        var lfoGain = ctx.createGain(); lfoGain.gain.value = 0;
        lfo.frequency.value = 22 * 60 / 256;
        lfo.connect(lfoGain);
        try { lfo.start(); } catch (e) {}
        var pans = panGainsFor(0, 0);
        dsL.gain.value = pans.left; dsR.gain.value = pans.right;
        var cgbPans = cgbPanGainsFor(0);
        cgbL.gain.value = cgbPans.left; cgbR.gain.value = cgbPans.right;
        session.tracks.push({
            dsVol: dsVol, dsL: dsL, dsR: dsR, cgbL: cgbL, cgbR: cgbR, lfo: lfo, lfoGain: lfoGain,
            state: { vol: 0, pan: 0, bend: 0, bendRange: 2, mod: 0, lfoSpeed: 22, program: 0, bendCents: 0 },
            active: [],
        });
    }
    // Chase controller state up to the start position so a mid-song start (or
    // seek) hears the same latched values linear playback would have left.
    var chaseEnd = lowerBoundEvent(perf.events, fromT);
    for (var c = 0; c < chaseEnd; c++) {
        var chased = perf.events[c];
        if (chased.type === 'note' || chased.track >= session.tracks.length) continue;
        applyStateOnly(session.tracks[chased.track], chased);
    }
    session.tracks.forEach(function (track) { syncTrackNodes(session, track, ctx.currentTime); });
    session.pointer = chaseEnd;
    session.offset = ctx.currentTime + 0.15 - fromT;
    return session;
}

function applyStateOnly(track, ev) {
    var s = track.state;
    if (ev.type === 'vol') s.vol = ev.value;
    else if (ev.type === 'pan') s.pan = ev.value;
    else if (ev.type === 'bend') { s.bend = ev.value; s.bendCents = s.bend * s.bendRange * 100 / 64; }
    else if (ev.type === 'bendr') { s.bendRange = ev.value; s.bendCents = s.bend * s.bendRange * 100 / 64; }
    else if (ev.type === 'mod') s.mod = ev.value;
    else if (ev.type === 'lfos') s.lfoSpeed = ev.value;
    else if (ev.type === 'prog') s.program = ev.value;
}

function syncTrackNodes(session, track, atTime) {
    var s = track.state;
    track.dsVol.gain.setValueAtTime(s.vol * 2 / 255, atTime);
    var pans = panGainsFor(s.pan, 0);
    track.dsL.gain.setValueAtTime(pans.left, atTime);
    track.dsR.gain.setValueAtTime(pans.right, atTime);
    var cgbPans = cgbPanGainsFor(s.pan);
    track.cgbL.gain.setValueAtTime(cgbPans.left, atTime);
    track.cgbR.gain.setValueAtTime(cgbPans.right, atTime);
    track.lfoGain.gain.setValueAtTime(s.mod * 6.25, atTime);
    track.lfo.frequency.setValueAtTime(Math.max(0.01, s.lfoSpeed * 60 / 256), atTime);
}

function truncateVoice(active, atTime) {
    try {
        cancelHold(active.gain.gain, atTime);
        active.gain.gain.linearRampToValueAtTime(0, atTime + 0.004);
        active.source.stop(atTime + 0.01);
    } catch (e) {}
}

function dispatchPerfEvent(session, ev, ctxT) {
    var track = session.tracks[ev.track];
    if (!track) return;
    var s = track.state;
    if (ev.type !== 'note') {
        applyStateOnly(track, ev);
        if (ev.type === 'vol') track.dsVol.gain.setValueAtTime(s.vol * 2 / 255, ctxT);
        else if (ev.type === 'pan') {
            var pans = panGainsFor(s.pan, 0);
            track.dsL.gain.setValueAtTime(pans.left, ctxT);
            track.dsR.gain.setValueAtTime(pans.right, ctxT);
            var cgbPans = cgbPanGainsFor(s.pan);
            track.cgbL.gain.setValueAtTime(cgbPans.left, ctxT);
            track.cgbR.gain.setValueAtTime(cgbPans.right, ctxT);
        } else if (ev.type === 'bend' || ev.type === 'bendr') {
            track.active.forEach(function (active) {
                if (active.endCtx > ctxT) { try { active.source.detune.setValueAtTime(s.bendCents, ctxT); } catch (e) {} }
            });
        } else if (ev.type === 'mod') track.lfoGain.gain.setValueAtTime(s.mod * 6.25, ctxT);
        else if (ev.type === 'lfos') track.lfo.frequency.setValueAtTime(Math.max(0.01, s.lfoSpeed * 60 / 256), ctxT);
        return;
    }

    if (!isTrackAudible(ev.track)) return;
    var groupName = groupNameFromFlagG(currentEditedFlags(session.song).G);
    var resolved = resolveVoiceClient(groupName, s.program, ev.key);
    if (!resolved) return;
    var endT = ev.endT;
    if (loopEnabled && session.perf.hasLoop && ev.t < session.perf.loopEndT && endT > session.perf.loopEndT) endT = session.perf.loopEndT;
    var endCtx = endT + session.offset;
    if (endCtx <= ctxT) return;

    var isDs = resolved.kind === 'directsound';
    if (!isDs) {
        // One note per CGB hardware channel: a new note steals the old one.
        var busy = session.cgbBusy[resolved.kind];
        if (busy && busy.endCtx > ctxT) truncateVoice(busy, ctxT);
    } else {
        session.dsActive = session.dsActive.filter(function (active) { return active.endCtx > ctxT; });
        if (session.dsActive.length >= DS_MAX_CHANNELS) {
            var oldest = session.dsActive.reduce(function (a, b) { return a.startCtx <= b.startCtx ? a : b; });
            truncateVoice(oldest, ctxT);
            session.dsActive.splice(session.dsActive.indexOf(oldest), 1);
            session.stolenCount++;
        }
    }

    var voice = synthNote(session.ctx, resolved, ev.key, {
        startTime: ctxT, offTime: endCtx,
        dsPeak: ev.vel / 128,
        cgbGoal: cgbGoalSteps(ev.vel, s.vol),
    });
    if (!voice) return;
    try { voice.source.detune.setValueAtTime(s.bendCents, ctxT); } catch (e) {}
    try { track.lfoGain.connect(voice.source.detune); } catch (e) {}
    var entry = { source: voice.source, gain: voice.gain, startCtx: ctxT, endCtx: endCtx, kind: voice.kind };
    if (isDs) {
        var rhythmPan = voiceRhythmPan(resolved.pan);
        if (rhythmPan) {
            // Drum voices carry their own pan; fold it with the track pan at
            // note start (short percussive notes, later pan moves negligible).
            var noteL = session.ctx.createGain(), noteR = session.ctx.createGain();
            var panned = panGainsFor(s.pan, rhythmPan);
            var base = panGainsFor(s.pan, 0);
            noteL.gain.value = base.left > 0 ? panned.left / base.left : 0;
            noteR.gain.value = base.right > 0 ? panned.right / base.right : 0;
            var noteVol = session.ctx.createGain();
            noteVol.gain.value = s.vol * 2 / 255;
            voice.gain.connect(noteVol);
            noteVol.connect(noteL); noteVol.connect(noteR);
            noteL.connect(session.leftBus); noteR.connect(session.rightBus);
            if (session.reverbIn) noteVol.connect(session.reverbIn);
        } else {
            voice.gain.connect(track.dsVol);
        }
        session.dsActive.push(entry);
        if (session.dsActive.length > session.dsPeakUsage) session.dsPeakUsage = session.dsActive.length;
    } else {
        voice.gain.connect(track.cgbL);
        voice.gain.connect(track.cgbR);
        session.cgbBusy[resolved.kind] = entry;
    }
    track.active.push(entry);
    if (track.active.length > 64) track.active = track.active.filter(function (active) { return active.endCtx > ctxT; });
}

function schedulerTick() {
    if (!player || player.paused || player.done) return;
    var ctx = player.ctx;
    var horizon = ctx.currentTime + 0.4;
    var events = player.perf.events;
    var guard = 0;
    while (guard++ < 20000) {
        if (player.pointer >= events.length) {
            if (loopEnabled && player.perf.hasLoop && player.perf.loopEndT + player.offset <= horizon) {
                player.offset += player.perf.loopEndT - player.perf.loopStartT;
                player.pointer = lowerBoundEvent(events, player.perf.loopStartT);
                continue;
            }
            break;
        }
        var ev = events[player.pointer];
        if (loopEnabled && player.perf.hasLoop && ev.t >= player.perf.loopEndT) {
            if (player.perf.loopEndT + player.offset > horizon) break;
            player.offset += player.perf.loopEndT - player.perf.loopStartT;
            player.pointer = lowerBoundEvent(events, player.perf.loopStartT);
            continue;
        }
        var ctxT = ev.t + player.offset;
        if (ctxT > horizon) break;
        dispatchPerfEvent(player, ev, Math.max(ctxT, ctx.currentTime));
        player.pointer++;
    }
    var positionNow = ctx.currentTime - player.offset;
    if (!(loopEnabled && player.perf.hasLoop) && positionNow > player.perf.duration + 1) { stopPlayback(); return; }
    updatePlaybackProgress();
}

function playheadSeconds() {
    if (!player) return 0;
    return Math.max(0, player.ctx.currentTime - player.offset);
}

function stopPlayback() {
    if (player) {
        if (player.timer) clearInterval(player.timer);
        if (player.ctx.state === 'suspended') { try { player.ctx.resume(); } catch (e) {} }
        try { player.master.gain.setValueAtTime(0, player.ctx.currentTime); } catch (e) {}
        player.tracks.forEach(function (track) {
            track.active.forEach(function (active) { try { active.source.stop(0); } catch (e) {} });
            try { track.lfo.stop(); } catch (e) {}
        });
        try { player.master.disconnect(); } catch (e) {}
        player = null;
    }
    playbackState = { playing: false, paused: false, startAt: 0, duration: playbackState.duration };
    updateTransportUI();
    setPlaybackStatus('');
    requestRollRedraw();
}

var playbackState = { playing: false, paused: false, startAt: 0, duration: 0 };

function playSong(fromSeconds) {
    stopPlayback();
    var song = songs[selectedIndex];
    if (!song) return;
    if (!song.hasMidi) { setPlaybackStatus('No MIDI file found'); return; }
    var groupName = groupNameFromFlagG(currentEditedFlags(song).G);
    if (!groupName || !voiceGroups[groupName]) { setPlaybackStatus('No voice group assigned'); return; }
    var ctx = getAudioContext();
    setPlaybackStatus('Loading...');
    loadDoc(song).then(function (doc) {
        return preloadSongAssets(ctx, groupName).then(function () { return doc; });
    }).then(function (doc) {
        var perf = compilePerformance(doc, song);
        var startT = clampNum(fromSeconds || 0, 0, Math.max(0, perf.duration - 0.05));
        player = createPlayerSession(ctx, perf, song, startT);
        player.timer = setInterval(schedulerTick, 60);
        playbackState = { playing: true, paused: false, startAt: startT, duration: perf.duration };
        updateTransportUI();
        setPlaybackStatus(perf.silentTracks.length ? perf.silentTracks.length + ' track(s) over budget (silent)' : 'Playing');
        schedulerTick();
    }).catch(function (error) {
        setPlaybackStatus('Playback failed');
        console.error(error);
    });
}

function togglePause() {
    if (!player) return;
    if (player.paused) {
        player.paused = false;
        player.ctx.resume();
        playbackState.paused = false;
    } else {
        player.paused = true;
        player.ctx.suspend();
        playbackState.paused = true;
    }
    updateTransportUI();
}

function seekToSeconds(seconds) {
    if (!playbackState.playing) return;
    var wasPaused = playbackState.paused;
    playSong(seconds);
    if (wasPaused) togglePause();
}

// ---------------------------------------------------------------------------
// Song document cache — parsed .mid per song label, carrying unsaved edits.
// ---------------------------------------------------------------------------

var docCache = {};
var midiDirty = {};

function loadDoc(song) {
    var cached = docCache[song.label];
    if (cached) return Promise.resolve(cached);
    return fetch(song.midiUri).then(function (r) { return r.arrayBuffer(); }).then(function (buffer) {
        var doc = buildDoc(parseSmf(buffer));
        docCache[song.label] = doc;
        return doc;
    });
}

function markMidiDirty(song) {
    midiDirty[song.label] = true;
    setStatus();
}

// Live audition for the piano roll and instrument browser: one note through
// the song's real voice resolution with default track state.
function auditionNote(song, program, key, velocity) {
    var groupName = groupNameFromFlagG(currentEditedFlags(song).G);
    if (!groupName || !voiceGroups[groupName]) return;
    var ctx = getAudioContext();
    preloadSongAssets(ctx, groupName).then(function () {
        var resolved = resolveVoiceClient(groupName, program, key);
        if (!resolved) return;
        var startTime = ctx.currentTime + 0.02;
        var vel = effectiveVelocity(velocity || 100);
        var voice = synthNote(ctx, resolved, key, {
            startTime: startTime, offTime: startTime + 0.45,
            dsPeak: vel / 128,
            cgbGoal: cgbGoalSteps(vel, 127),
        });
        if (!voice) return;
        var out = ctx.createGain();
        out.gain.value = 0.8;
        voice.gain.connect(out);
        out.connect(masterGain);
    });
}

function setPlaybackStatus(message) { byId('status').textContent = message || ''; }

function updateTransportUI() {
    var playBtn = byId('play-btn');
    if (playbackState.playing && !playbackState.paused) playBtn.innerHTML = '&#10074;&#10074; Pause';
    else playBtn.innerHTML = '&#9654; Play';
    byId('stop-btn').disabled = !playbackState.playing;
    var loopBtn = byId('loop-btn');
    if (loopBtn) loopBtn.classList.toggle('toggled', loopEnabled);
}

function formatTime(seconds) {
    seconds = Math.max(0, seconds || 0);
    var minutes = Math.floor(seconds / 60);
    var whole = Math.floor(seconds % 60);
    return minutes + ':' + (whole < 10 ? '0' : '') + whole;
}

function updatePlaybackProgress() {
    if (!playbackState.playing || !player) return;
    var elapsed = playheadSeconds();
    var progress = byId('progress');
    progress.max = Math.max(0.001, playbackState.duration);
    progress.value = clampNum(elapsed, 0, playbackState.duration);
    byId('time').textContent = formatTime(elapsed) + ' / ' + formatTime(playbackState.duration);
    var meter = byId('poly-meter');
    if (meter) {
        var used = player.dsActive.filter(function (a) { return a.endCtx > player.ctx.currentTime; }).length;
        meter.textContent = 'DS ' + used + '/' + DS_MAX_CHANNELS + (player.stolenCount ? ' \u00b7 stolen ' + player.stolenCount : '');
        meter.classList.toggle('warn', player.stolenCount > 0);
    }
    requestRollRedraw();
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
// Piano roll (Tracks tab) — Shared-timeline roll: track headers
// with mute/solo, selected track editable, other tracks ghosted, loop overlay,
// snapping to the song's mid2agb clock base, live audition, undo/redo, and
// effective (quantized) velocity/length readouts.
// ---------------------------------------------------------------------------

var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
var roll = null; // live piano-roll session for the visible Tracks tab
var undoStack = [], redoStack = [];

function noteName(key) { return NOTE_NAMES[key % 12] + (Math.floor(key / 12) - 1); }

function secondsToTick(seconds, tempoMap, division) {
    var t = 0, lastTick = 0, lastMpqn = tempoMap[0].mpqn;
    for (var i = 0; i < tempoMap.length; i++) {
        var entry = tempoMap[i];
        var segment = (entry.tick - lastTick) * lastMpqn / division / 1e6;
        if (t + segment >= seconds) break;
        t += segment; lastTick = entry.tick; lastMpqn = entry.mpqn;
    }
    return lastTick + (seconds - t) * 1e6 * division / lastMpqn;
}

function trackHue(index) { return (index * 137.5) % 360; }

function snapshotNotes(docTrack) {
    return docTrack.notes.map(function (note) { return { id: note.id, tick: note.tick, dur: note.dur, key: note.key, vel: note.vel }; });
}

function restoreNotes(docTrack, snapshot) {
    docTrack.notes = snapshot.map(function (note) { return { id: note.id, tick: note.tick, dur: note.dur, key: note.key, vel: note.vel }; });
}

function pushUndo(label, trackIndex, before, after) {
    undoStack.push({ label: label, trackIndex: trackIndex, before: before, after: after });
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
}

function applyNoteSnapshot(entry, snapshot) {
    var doc = docCache[entry.label];
    if (!doc) return;
    var docTrack = doc.tracks[entry.trackIndex];
    if (!docTrack) return;
    restoreNotes(docTrack, snapshot);
    rebuildSmfTrack(doc, docTrack);
    var song = songs[selectedIndex];
    if (song && song.label === entry.label) markMidiDirty(song);
    if (roll) { roll.selection = {}; requestRollRedraw(); renderRollInspector(); renderRollTrackList(); }
}

function undoNoteEdit() {
    var entry = undoStack.pop();
    if (!entry) return;
    redoStack.push(entry);
    applyNoteSnapshot(entry, entry.before);
}

function redoNoteEdit() {
    var entry = redoStack.pop();
    if (!entry) return;
    undoStack.push(entry);
    applyNoteSnapshot(entry, entry.after);
}

var rollRedrawQueued = false;
function requestRollRedraw() {
    if (!roll || rollRedrawQueued) return;
    rollRedrawQueued = true;
    requestAnimationFrame(function () {
        rollRedrawQueued = false;
        if (roll) drawRoll();
    });
}

function rollColors() {
    var style = getComputedStyle(document.body);
    function pick(name, fallback) { var v = style.getPropertyValue(name).trim(); return v || fallback; }
    return {
        bg: pick('--vscode-editor-background', '#1e1e1e'),
        fg: pick('--vscode-foreground', '#cccccc'),
        border: pick('--vscode-panel-border', '#444444'),
        accent: pick('--vscode-focusBorder', '#007fd4'),
        desc: pick('--vscode-descriptionForeground', '#999999'),
    };
}

function barTicksOf(doc) {
    var numerator = 4, denomPow2 = 2;
    if (doc.timeSigs.length) { numerator = doc.timeSigs[0].numerator || 4; denomPow2 = doc.timeSigs[0].denomPow2 || 2; }
    return Math.max(1, Math.round(doc.division * numerator * 4 / Math.pow(2, denomPow2)));
}

function initRollSession(song, doc, container) {
    var flags = currentEditedFlags(song);
    var clocksPerBeat = flags.X ? 48 : 24;
    var usedKeys = [];
    doc.tracks.forEach(function (t) { t.notes.forEach(function (n) { usedKeys.push(n.key); }); });
    var centerKey = 64;
    if (usedKeys.length) { var sum = 0; usedKeys.forEach(function (k) { sum += k; }); centerKey = Math.round(sum / usedKeys.length); }
    roll = {
        song: song, doc: doc, container: container,
        canvas: null, ctx2d: null,
        keysW: 46, rulerH: 22, rowH: 10,
        pxPerBeat: 96, scrollX: 0, scrollY: 0,
        selectedTrack: 0, selection: {},
        snapTicks: Math.max(1, Math.round(doc.division / 4)),
        clocksPerBeat: clocksPerBeat,
        ticksPerClock: doc.division / clocksPerBeat,
        cursorTick: 0,
        drag: null, hoverNote: null,
        barTicks: barTicksOf(doc),
    };
    roll.scrollY = Math.max(0, (127 - centerKey) * roll.rowH - 200);
}

function rollPxPerTick() { return roll.pxPerBeat / roll.doc.division; }
function rollTickAtX(x) { return (x - roll.keysW + roll.scrollX) / rollPxPerTick(); }
function rollXAtTick(tick) { return roll.keysW + tick * rollPxPerTick() - roll.scrollX; }
function rollKeyAtY(y) { return 127 - Math.floor((y - roll.rulerH + roll.scrollY) / roll.rowH); }
function rollYAtKey(key) { return roll.rulerH + (127 - key) * roll.rowH - roll.scrollY; }
function rollSnap(tick) { return Math.max(0, Math.round(tick / roll.snapTicks) * roll.snapTicks); }

function rollSelectedDocTrack() { return roll.doc.tracks[roll.selectedTrack] || null; }

function rollHitTest(mx, my) {
    var docTrack = rollSelectedDocTrack();
    if (!docTrack) return null;
    var pxPerTick = rollPxPerTick();
    for (var i = docTrack.notes.length - 1; i >= 0; i--) {
        var note = docTrack.notes[i];
        var x = rollXAtTick(note.tick);
        var w = Math.max(4, note.dur * pxPerTick);
        var y = rollYAtKey(note.key);
        if (mx >= x && mx <= x + w && my >= y && my <= y + roll.rowH) {
            return { note: note, edge: mx > x + w - Math.min(8, w * 0.4) };
        }
    }
    return null;
}

function drawRoll() {
    if (!roll || !roll.canvas) return;
    var canvas = roll.canvas;
    var g = roll.ctx2d;
    var dpr = window.devicePixelRatio || 1;
    var width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var colors = rollColors();
    var doc = roll.doc;
    var pxPerTick = rollPxPerTick();

    g.fillStyle = colors.bg;
    g.fillRect(0, 0, width, height);

    // row shading (black keys) + horizontal lines
    var firstKey = clampNum(rollKeyAtY(height), 0, 127);
    var lastKey = clampNum(rollKeyAtY(roll.rulerH), 0, 127);
    for (var key = firstKey; key <= lastKey; key++) {
        var y = rollYAtKey(key);
        var pitchClass = key % 12;
        var isBlack = pitchClass === 1 || pitchClass === 3 || pitchClass === 6 || pitchClass === 8 || pitchClass === 10;
        if (isBlack) { g.fillStyle = 'rgba(128,128,128,0.07)'; g.fillRect(roll.keysW, y, width - roll.keysW, roll.rowH); }
        if (pitchClass === 0) { g.strokeStyle = 'rgba(128,128,128,0.3)'; g.beginPath(); g.moveTo(roll.keysW, y + roll.rowH + 0.5); g.lineTo(width, y + roll.rowH + 0.5); g.stroke(); }
    }

    // vertical grid: beats + bars
    var firstTick = Math.max(0, rollTickAtX(roll.keysW));
    var lastTick = rollTickAtX(width);
    var beatStep = doc.division;
    if (beatStep * pxPerTick < 14) beatStep = roll.barTicks;
    for (var tick = Math.floor(firstTick / beatStep) * beatStep; tick <= lastTick; tick += beatStep) {
        var x = rollXAtTick(tick);
        var isBar = tick % roll.barTicks === 0;
        g.strokeStyle = isBar ? 'rgba(128,128,128,0.4)' : 'rgba(128,128,128,0.14)';
        g.beginPath(); g.moveTo(x + 0.5, roll.rulerH); g.lineTo(x + 0.5, height); g.stroke();
    }

    // loop region overlay
    if (doc.loopStartTick !== null && doc.loopEndTick !== null && doc.loopEndTick > doc.loopStartTick) {
        var lx = rollXAtTick(doc.loopStartTick), lx2 = rollXAtTick(doc.loopEndTick);
        g.fillStyle = 'rgba(80,160,255,0.07)';
        g.fillRect(lx, roll.rulerH, lx2 - lx, height - roll.rulerH);
        g.strokeStyle = 'rgba(80,160,255,0.5)';
        g.beginPath(); g.moveTo(lx + 0.5, roll.rulerH); g.lineTo(lx + 0.5, height); g.stroke();
        g.beginPath(); g.moveTo(lx2 + 0.5, roll.rulerH); g.lineTo(lx2 + 0.5, height); g.stroke();
    }

    // ghost notes (other tracks), then selected track on top
    doc.tracks.forEach(function (docTrack, trackIndex) {
        if (trackIndex === roll.selectedTrack) return;
        g.fillStyle = 'rgba(128,128,128,0.22)';
        docTrack.notes.forEach(function (note) {
            var x = rollXAtTick(note.tick);
            var w = Math.max(3, note.dur * pxPerTick);
            if (x + w < roll.keysW || x > width) return;
            var y = rollYAtKey(note.key);
            if (y + roll.rowH < roll.rulerH || y > height) return;
            g.fillRect(x, y + 1, w, roll.rowH - 2);
        });
    });
    var selectedDocTrack = rollSelectedDocTrack();
    if (selectedDocTrack) {
        var hue = trackHue(roll.selectedTrack);
        selectedDocTrack.notes.forEach(function (note) {
            var x = rollXAtTick(note.tick);
            var w = Math.max(4, note.dur * pxPerTick);
            if (x + w < roll.keysW || x > width) return;
            var y = rollYAtKey(note.key);
            if (y + roll.rowH < roll.rulerH || y > height) return;
            var lightness = 38 + Math.round(note.vel / 127 * 25);
            g.fillStyle = 'hsl(' + hue + ',65%,' + lightness + '%)';
            g.fillRect(x, y + 1, w, roll.rowH - 2);
            if (roll.selection[note.id]) {
                g.strokeStyle = colors.fg;
                g.lineWidth = 1.5;
                g.strokeRect(x + 0.5, y + 1.5, w - 1, roll.rowH - 3);
                g.lineWidth = 1;
            }
        });
    }

    // playhead + edit cursor
    var playheadTick = null;
    if (playbackState.playing && player) {
        playheadTick = secondsToTick(playheadSeconds(), player.perf.tempoMap, doc.division);
        if (followPlayhead && !playbackState.paused) {
            var px = playheadTick * pxPerTick;
            var viewW = width - roll.keysW;
            if (px < roll.scrollX || px > roll.scrollX + viewW - 60) roll.scrollX = Math.max(0, px - viewW * 0.25);
        }
    }
    if (roll.cursorTick !== null) {
        var cx = rollXAtTick(roll.cursorTick);
        g.strokeStyle = 'rgba(128,200,128,0.7)';
        g.beginPath(); g.moveTo(cx + 0.5, roll.rulerH); g.lineTo(cx + 0.5, height); g.stroke();
    }
    if (playheadTick !== null) {
        var phx = rollXAtTick(playheadTick);
        g.strokeStyle = '#e05050';
        g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(phx, roll.rulerH); g.lineTo(phx, height); g.stroke();
        g.lineWidth = 1;
    }

    // piano keys strip
    g.fillStyle = colors.bg;
    g.fillRect(0, roll.rulerH, roll.keysW, height - roll.rulerH);
    for (var k = firstKey; k <= lastKey; k++) {
        var ky = rollYAtKey(k);
        var pc = k % 12;
        var black = pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
        g.fillStyle = black ? '#2a2a2a' : '#e8e8e8';
        g.fillRect(0, ky + 0.5, roll.keysW - 6, roll.rowH - 1);
        if (pc === 0 && roll.rowH >= 9) {
            g.fillStyle = '#555555';
            g.font = '8px sans-serif';
            g.fillText(noteName(k), 2, ky + roll.rowH - 2);
        }
    }
    g.strokeStyle = colors.border;
    g.beginPath(); g.moveTo(roll.keysW - 0.5, 0); g.lineTo(roll.keysW - 0.5, height); g.stroke();

    // ruler
    g.fillStyle = colors.bg;
    g.fillRect(0, 0, width, roll.rulerH);
    g.strokeStyle = colors.border;
    g.beginPath(); g.moveTo(0, roll.rulerH - 0.5); g.lineTo(width, roll.rulerH - 0.5); g.stroke();
    g.fillStyle = colors.desc;
    g.font = '10px sans-serif';
    for (var barTick = Math.floor(firstTick / roll.barTicks) * roll.barTicks; barTick <= lastTick; barTick += roll.barTicks) {
        var bx = rollXAtTick(barTick);
        if (bx < roll.keysW) continue;
        g.fillText(String(Math.floor(barTick / roll.barTicks) + 1), bx + 3, 14);
        g.strokeStyle = 'rgba(128,128,128,0.4)';
        g.beginPath(); g.moveTo(bx + 0.5, 0); g.lineTo(bx + 0.5, roll.rulerH); g.stroke();
    }
    if (playheadTick !== null) {
        var phx2 = rollXAtTick(playheadTick);
        g.fillStyle = '#e05050';
        g.beginPath(); g.moveTo(phx2 - 5, 0); g.lineTo(phx2 + 5, 0); g.lineTo(phx2, 9); g.closePath(); g.fill();
    }
}

function rollCommitDrag() {
    var drag = roll.drag;
    roll.drag = null;
    if (!drag || !drag.changed) return;
    var docTrack = rollSelectedDocTrack();
    if (!docTrack) return;
    docTrack.notes.sort(function (a, b) { return a.tick - b.tick || a.key - b.key; });
    rebuildSmfTrack(roll.doc, docTrack);
    pushUndo(roll.song.label, roll.selectedTrack, drag.before, snapshotNotes(docTrack));
    markMidiDirty(roll.song);
    renderRollInspector();
    renderRollTrackList();
}

function rollDeleteSelection() {
    var docTrack = rollSelectedDocTrack();
    if (!docTrack) return;
    var ids = Object.keys(roll.selection);
    if (!ids.length) return;
    var before = snapshotNotes(docTrack);
    docTrack.notes = docTrack.notes.filter(function (note) { return !roll.selection[note.id]; });
    roll.selection = {};
    rebuildSmfTrack(roll.doc, docTrack);
    pushUndo(roll.song.label, roll.selectedTrack, before, snapshotNotes(docTrack));
    markMidiDirty(roll.song);
    requestRollRedraw();
    renderRollInspector();
    renderRollTrackList();
}

function rollProgramAtTick(docTrack, tick) {
    var program = docTrack.firstProgram >= 0 ? docTrack.firstProgram : 0;
    var smfTrack = roll.doc.smf.tracks[docTrack.smfIndex];
    for (var i = 0; i < smfTrack.events.length; i++) {
        var ev = smfTrack.events[i];
        if (ev.tick > tick) break;
        if (ev.kind === 'ch' && ev.ch === docTrack.channel && ev.status === 0xC0) program = ev.d1;
    }
    return program;
}

function rollAudition(key, tick) {
    var docTrack = rollSelectedDocTrack();
    if (!docTrack) return;
    auditionNote(roll.song, rollProgramAtTick(docTrack, tick || 0), key, 100);
}

function handleRollMouseDown(event) {
    if (!roll) return;
    var rect = roll.canvas.getBoundingClientRect();
    var mx = event.clientX - rect.left, my = event.clientY - rect.top;
    getAudioContext();

    if (event.button === 1) {
        roll.drag = { kind: 'pan', startX: mx, startY: my, scrollX: roll.scrollX, scrollY: roll.scrollY };
        event.preventDefault();
        return;
    }
    if (mx < roll.keysW && my > roll.rulerH) {
        var pianoKey = clampNum(rollKeyAtY(my), 0, 127);
        rollAudition(pianoKey, roll.cursorTick || 0);
        return;
    }
    if (my < roll.rulerH) {
        var tickAt = Math.max(0, rollTickAtX(mx));
        roll.cursorTick = rollSnap(tickAt);
        if (playbackState.playing && player) {
            seekToSeconds(tickToSeconds(roll.cursorTick, player.perf.tempoMap, roll.doc.division));
        }
        requestRollRedraw();
        return;
    }
    if (event.button === 2) return; // handled in contextmenu

    var docTrack = rollSelectedDocTrack();
    if (!docTrack) return;
    var hit = rollHitTest(mx, my);
    if (hit) {
        if (!event.ctrlKey && !roll.selection[hit.note.id]) roll.selection = {};
        roll.selection[hit.note.id] = true;
        roll.drag = {
            kind: hit.edge ? 'resize' : 'move',
            before: snapshotNotes(docTrack),
            startTick: rollTickAtX(mx), startKey: rollKeyAtY(my),
            noteStartTick: hit.note.tick, noteStartDur: hit.note.dur, noteStartKey: hit.note.key,
            noteId: hit.note.id, changed: false, lastAuditionKey: null,
        };
    } else {
        // pencil: draw a new note at the snapped position
        var newTick = rollSnap(rollTickAtX(mx));
        var newKey = clampNum(rollKeyAtY(my), 0, 127);
        var before = snapshotNotes(docTrack);
        var note = { id: roll.doc.nextNoteId++, tick: newTick, dur: roll.snapTicks, key: newKey, vel: 100 };
        docTrack.notes.push(note);
        roll.selection = {};
        roll.selection[note.id] = true;
        roll.drag = { kind: 'draw', before: before, noteId: note.id, startTick: newTick, changed: true, lastAuditionKey: null };
        rollAudition(newKey, newTick);
    }
    requestRollRedraw();
    renderRollInspector();
    event.preventDefault();
}

function handleRollMouseMove(event) {
    if (!roll || !roll.drag) return;
    var rect = roll.canvas.getBoundingClientRect();
    var mx = event.clientX - rect.left, my = event.clientY - rect.top;
    var drag = roll.drag;
    if (drag.kind === 'pan') {
        roll.scrollX = Math.max(0, drag.scrollX - (mx - drag.startX));
        roll.scrollY = clampNum(drag.scrollY - (my - drag.startY), 0, 128 * roll.rowH - 100);
        requestRollRedraw();
        return;
    }
    var docTrack = rollSelectedDocTrack();
    if (!docTrack) return;
    var note = null;
    for (var i = 0; i < docTrack.notes.length; i++) if (docTrack.notes[i].id === drag.noteId) { note = docTrack.notes[i]; break; }
    if (!note) return;
    if (drag.kind === 'move') {
        var deltaTicks = rollSnap(drag.noteStartTick + rollTickAtX(mx) - drag.startTick) - rollSnap(drag.noteStartTick);
        var deltaKeys = rollKeyAtY(my) - drag.startKey;
        var newTick = Math.max(0, drag.noteStartTick + deltaTicks);
        var newKey = clampNum(drag.noteStartKey + deltaKeys, 0, 127);
        if (newTick !== note.tick || newKey !== note.key) {
            if (newKey !== note.key && drag.lastAuditionKey !== newKey) { drag.lastAuditionKey = newKey; rollAudition(newKey, newTick); }
            note.tick = newTick; note.key = newKey;
            drag.changed = true;
            requestRollRedraw();
            renderRollInspector();
        }
    } else if (drag.kind === 'resize' || drag.kind === 'draw') {
        var endTick = Math.max((drag.kind === 'draw' ? drag.startTick : drag.noteStartTick) + Math.max(1, Math.round(roll.snapTicks / 2)), rollSnap(rollTickAtX(mx)));
        var newDur = Math.max(1, endTick - note.tick);
        if (newDur !== note.dur) {
            note.dur = newDur;
            drag.changed = true;
            requestRollRedraw();
            renderRollInspector();
        }
    }
}

function handleRollMouseUp() {
    if (!roll || !roll.drag) return;
    if (roll.drag.kind === 'pan') { roll.drag = null; return; }
    rollCommitDrag();
    requestRollRedraw();
}

function handleRollContextMenu(event) {
    if (!roll) return;
    event.preventDefault();
    var rect = roll.canvas.getBoundingClientRect();
    var hit = rollHitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (hit) {
        roll.selection = {};
        roll.selection[hit.note.id] = true;
        rollDeleteSelection();
    }
}

function handleRollWheel(event) {
    if (!roll) return;
    event.preventDefault();
    if (event.ctrlKey) {
        var rect = roll.canvas.getBoundingClientRect();
        var mx = event.clientX - rect.left;
        var tickUnderMouse = rollTickAtX(mx);
        roll.pxPerBeat = clampNum(roll.pxPerBeat * (event.deltaY < 0 ? 1.2 : 1 / 1.2), 12, 1200);
        roll.scrollX = Math.max(0, tickUnderMouse * rollPxPerTick() - (mx - roll.keysW));
    } else if (event.shiftKey) {
        roll.scrollX = Math.max(0, roll.scrollX + (event.deltaY || event.deltaX));
    } else {
        roll.scrollY = clampNum(roll.scrollY + event.deltaY, 0, 128 * roll.rowH - 100);
    }
    requestRollRedraw();
}

function handleRollKeyDown(event) {
    if (!roll || activeTab !== 'tracks') return;
    var tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    if (event.key === 'Delete' || event.key === 'Backspace') { rollDeleteSelection(); event.preventDefault(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) { undoNoteEdit(); event.preventDefault(); }
    else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) { redoNoteEdit(); event.preventDefault(); }
    else if (event.key === ' ') { if (playbackState.playing) togglePause(); else playSongFromCursor(); event.preventDefault(); }
}

function playSongFromCursor() {
    var startSeconds = 0;
    if (roll && roll.cursorTick) {
        var doc = roll.doc;
        startSeconds = tickToSeconds(roll.cursorTick, buildDocTempoMap(doc), doc.division);
    }
    playSong(startSeconds);
}

function instrumentLabelFor(song, program) {
    var groupName = groupNameFromFlagG(currentEditedFlags(song).G);
    var group = voiceGroups[groupName];
    if (!group || !group.entries.length) return 'voice ' + program;
    var entry = group.entries[clampNum(program, 0, group.entries.length - 1)];
    if (!entry) return 'voice ' + program;
    if (entry.kind === 'directsound') return (entry.sample || 'sample').replace('DirectSoundWaveData_', '');
    if (entry.kind === 'keysplit' || entry.kind === 'keysplit_all') return 'drums/keysplit';
    if (entry.kind === 'square1' || entry.kind === 'square2') return 'square duty ' + (entry.dutyCycle || '0');
    if (entry.kind === 'wave') return 'wave ' + (entry.wave || '').replace('ProgrammableWaveData_', '');
    if (entry.kind === 'noise') return 'noise';
    return entry.kind;
}

function renderRollTrackList() {
    var listEl = byId('roll-tracks');
    if (!listEl || !roll) return;
    listEl.textContent = '';
    var song = roll.song;
    var budget = trackBudgets[stagedMusicPlayer(song)] || 16;
    roll.doc.tracks.forEach(function (docTrack, trackIndex) {
        var row = document.createElement('div');
        row.className = 'roll-track' + (trackIndex === roll.selectedTrack ? ' active' : '');
        var swatch = document.createElement('span');
        swatch.className = 'roll-swatch';
        swatch.style.background = 'hsl(' + trackHue(trackIndex) + ',65%,50%)';
        row.appendChild(swatch);
        var info = document.createElement('div');
        info.className = 'roll-track-info';
        var nameLine = document.createElement('div');
        nameLine.className = 'roll-track-name';
        nameLine.textContent = (trackIndex + 1) + '. ' + (docTrack.name || 'Track');
        var detail = document.createElement('div');
        detail.className = 'roll-track-detail';
        var program = docTrack.firstProgram >= 0 ? docTrack.firstProgram : 0;
        detail.textContent = instrumentLabelFor(song, program) + ' \u00b7 ' + docTrack.notes.length + ' notes';
        if (trackIndex >= budget) {
            var warn = document.createElement('span');
            warn.className = 'roll-budget-warn';
            warn.textContent = ' silent in-game';
            warn.title = 'This player only starts ' + budget + ' tracks (music_player_table.inc)';
            detail.appendChild(warn);
        }
        info.appendChild(nameLine); info.appendChild(detail);
        row.appendChild(info);
        var muteBtn = document.createElement('button');
        muteBtn.className = 'roll-ms' + (trackMute[trackIndex] ? ' on' : '');
        muteBtn.textContent = 'M';
        muteBtn.title = 'Mute';
        muteBtn.onclick = function (event) { event.stopPropagation(); trackMute[trackIndex] = !trackMute[trackIndex]; renderRollTrackList(); };
        var soloBtn = document.createElement('button');
        soloBtn.className = 'roll-ms' + (trackSolo[trackIndex] ? ' on' : '');
        soloBtn.textContent = 'S';
        soloBtn.title = 'Solo';
        soloBtn.onclick = function (event) { event.stopPropagation(); trackSolo[trackIndex] = !trackSolo[trackIndex]; renderRollTrackList(); };
        row.appendChild(muteBtn); row.appendChild(soloBtn);
        row.onclick = function () {
            roll.selectedTrack = trackIndex;
            roll.selection = {};
            renderRollTrackList();
            renderRollInspector();
            requestRollRedraw();
        };
        listEl.appendChild(row);
    });
}

function renderRollInspector() {
    var el = byId('roll-inspector');
    if (!el || !roll) return;
    el.textContent = '';
    var docTrack = rollSelectedDocTrack();
    var ids = Object.keys(roll.selection);
    if (!docTrack || !ids.length) {
        var hint = document.createElement('span');
        hint.className = 'roll-hint';
        hint.textContent = 'Click empty space to draw \u00b7 drag to move \u00b7 drag right edge to resize \u00b7 right-click to delete \u00b7 Ctrl+wheel zoom \u00b7 Space play/pause';
        el.appendChild(hint);
        return;
    }
    var note = null;
    for (var i = 0; i < docTrack.notes.length; i++) if (roll.selection[docTrack.notes[i].id]) { note = docTrack.notes[i]; break; }
    if (!note) return;
    var flags = currentEditedFlags(roll.song);
    var effDur = effectiveDurationClocks(note.dur, roll.doc.division, roll.clocksPerBeat, !!flags.E);
    var effVel = effectiveVelocity(note.vel);

    function labeled(text) { var span = document.createElement('span'); span.className = 'roll-insp-label'; span.textContent = text; el.appendChild(span); }
    labeled(noteName(note.key) + ' \u00b7 bar ' + (Math.floor(note.tick / roll.barTicks) + 1));

    labeled('Velocity');
    var velInput = document.createElement('input');
    velInput.type = 'number'; velInput.min = 1; velInput.max = 127; velInput.value = note.vel;
    velInput.className = 'roll-insp-input';
    velInput.onchange = function () {
        var before = snapshotNotes(docTrack);
        note.vel = clampNum(parseInt(velInput.value, 10) || 100, 1, 127);
        rebuildSmfTrack(roll.doc, docTrack);
        pushUndo(roll.song.label, roll.selectedTrack, before, snapshotNotes(docTrack));
        markMidiDirty(roll.song);
        renderRollInspector();
        requestRollRedraw();
    };
    el.appendChild(velInput);
    labeled('\u2192 GBA plays ' + effVel);
    labeled('Length ' + note.dur + ' ticks \u2192 ' + effDur + ' clocks (' + (Math.round(effDur / roll.clocksPerBeat * 100) / 100) + ' beats)');

    var delBtn = document.createElement('button');
    delBtn.className = 'small secondary';
    delBtn.textContent = 'Delete';
    delBtn.onclick = rollDeleteSelection;
    el.appendChild(delBtn);
}

function renderTracksTab(song) {
    var root = byId('body');
    root.textContent = '';
    roll = null;
    if (!song.hasMidi) {
        var missing = document.createElement('p');
        missing.className = 'notice';
        missing.style.padding = '11px';
        missing.textContent = 'This song has no .mid file yet. Use the Song tab to import one.';
        root.appendChild(missing);
        return;
    }
    var loading = document.createElement('p');
    loading.className = 'notice';
    loading.style.padding = '11px';
    loading.textContent = 'Loading MIDI...';
    root.appendChild(loading);
    loadDoc(song).then(function (doc) {
        if (selectedIndex < 0 || songs[selectedIndex] !== song || activeTab !== 'tracks') return;
        root.textContent = '';

        var wrap = document.createElement('div');
        wrap.className = 'roll-root';

        var toolbar = document.createElement('div');
        toolbar.className = 'roll-toolbar';
        var snapSelect = document.createElement('select');
        snapSelect.className = 'roll-snap';
        [['Beat', doc.division], ['1/2', doc.division / 2], ['1/4', doc.division / 4], ['1/8', doc.division / 8], ['Clock', doc.division / (currentEditedFlags(song).X ? 48 : 24)]].forEach(function (option) {
            var ticks = Math.max(1, Math.round(option[1]));
            var opt = document.createElement('option');
            opt.value = String(ticks);
            opt.textContent = 'Snap: ' + option[0];
            snapSelect.appendChild(opt);
        });
        var undoBtn = document.createElement('button'); undoBtn.className = 'small secondary'; undoBtn.textContent = 'Undo'; undoBtn.onclick = undoNoteEdit;
        var redoBtn = document.createElement('button'); redoBtn.className = 'small secondary'; redoBtn.textContent = 'Redo'; redoBtn.onclick = redoNoteEdit;
        var zoomOut = document.createElement('button'); zoomOut.className = 'small secondary'; zoomOut.textContent = '\u2212';
        var zoomIn = document.createElement('button'); zoomIn.className = 'small secondary'; zoomIn.textContent = '+';
        var followBtn = document.createElement('button'); followBtn.className = 'small secondary' + (followPlayhead ? ' toggled' : ''); followBtn.textContent = 'Follow';
        followBtn.onclick = function () { followPlayhead = !followPlayhead; followBtn.classList.toggle('toggled', followPlayhead); };
        toolbar.appendChild(snapSelect);
        toolbar.appendChild(undoBtn); toolbar.appendChild(redoBtn);
        toolbar.appendChild(zoomOut); toolbar.appendChild(zoomIn);
        toolbar.appendChild(followBtn);
        var inspector = document.createElement('div');
        inspector.id = 'roll-inspector';
        inspector.className = 'roll-inspector';
        toolbar.appendChild(inspector);
        wrap.appendChild(toolbar);

        var mainRow = document.createElement('div');
        mainRow.className = 'roll-main';
        var trackList = document.createElement('div');
        trackList.id = 'roll-tracks';
        trackList.className = 'roll-tracklist';
        var canvasWrap = document.createElement('div');
        canvasWrap.className = 'roll-canvas-wrap';
        var canvas = document.createElement('canvas');
        canvas.className = 'roll-canvas';
        canvasWrap.appendChild(canvas);
        mainRow.appendChild(trackList);
        mainRow.appendChild(canvasWrap);
        wrap.appendChild(mainRow);
        root.appendChild(wrap);

        initRollSession(song, doc, canvasWrap);
        roll.canvas = canvas;
        roll.ctx2d = canvas.getContext('2d');
        snapSelect.value = String(roll.snapTicks);
        if (snapSelect.value === '') snapSelect.selectedIndex = 2;
        snapSelect.onchange = function () { roll.snapTicks = Math.max(1, parseInt(snapSelect.value, 10) || 6); };
        zoomOut.onclick = function () { roll.pxPerBeat = clampNum(roll.pxPerBeat / 1.3, 12, 1200); requestRollRedraw(); };
        zoomIn.onclick = function () { roll.pxPerBeat = clampNum(roll.pxPerBeat * 1.3, 12, 1200); requestRollRedraw(); };

        canvas.addEventListener('mousedown', handleRollMouseDown);
        canvas.addEventListener('contextmenu', handleRollContextMenu);
        canvas.addEventListener('wheel', handleRollWheel, { passive: false });

        renderRollTrackList();
        renderRollInspector();
        requestRollRedraw();
    }).catch(function (error) {
        loading.textContent = 'Could not load MIDI: ' + error;
    });
}

window.addEventListener('resize', requestRollRedraw);
window.addEventListener('keydown', handleRollKeyDown);
window.addEventListener('mousemove', handleRollMouseMove);
window.addEventListener('mouseup', handleRollMouseUp);

// ---------------------------------------------------------------------------
// UI — song list
// ---------------------------------------------------------------------------

var CATEGORY_LABELS = { MUS: 'Music', SE: 'Sound Effects', PH: 'Phonemes' };

function renderList() {
    var query = byId('search').value.trim().toLowerCase();
    var list = byId('list');
    list.textContent = '';
    var shown = 0;
    var lastCategory = null;
    songs.forEach(function (song, index) {
        if (query && (song.name + ' ' + song.label).toLowerCase().indexOf(query) === -1) return;
        shown++;
        var category = song.category || 'MUS';
        if (category !== lastCategory) {
            lastCategory = category;
            var header = document.createElement('li');
            header.className = 'song-group';
            header.textContent = CATEGORY_LABELS[category] || category;
            list.appendChild(header);
        }
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
    var count = Object.keys(edits).length + Object.keys(dirtyVoiceGroups).length + Object.keys(midiDirty).length;
    byId('status').textContent = message || (count ? count + ' change(s) pending' : '');
}

function select(index) {
    commit();
    stopPlayback();
    selectedIndex = index;
    var song = songs[index];
    roll = null;
    trackMute = {}; trackSolo = {};
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
    var body = byId('body');
    if (activeTab !== 'tracks') roll = null;
    body.classList.toggle('roll-mode', activeTab === 'tracks');
    if (activeTab === 'tracks') renderTracksTab(song);
    else if (activeTab === 'song') renderSongTab(song);
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
byId('play-btn').onclick = function () {
    if (playbackState.playing) togglePause();
    else playSongFromCursor();
};
byId('stop-btn').onclick = stopPlayback;
byId('loop-btn').onclick = function () {
    loopEnabled = !loopEnabled;
    updateTransportUI();
};
byId('progress').onclick = function (event) {
    if (!playbackState.playing || !playbackState.duration) return;
    var rect = byId('progress').getBoundingClientRect();
    var fraction = clampNum((event.clientX - rect.left) / rect.width, 0, 1);
    seekToSeconds(fraction * playbackState.duration);
};
byId('save').onclick = function () {
    commit();
    var payload = { songTable: {}, cfg: {}, voiceGroupBodies: {}, midiFiles: {} };
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
    Object.keys(midiDirty).forEach(function (label) {
        var doc = docCache[label];
        if (doc) payload.midiFiles[label] = bytesToBase64(writeSmf(doc.smf));
    });
    vscode.postMessage({ type: 'save', edits: payload, selectedSongId: selectedIndex >= 0 ? songs[selectedIndex].id : null });
};
byId('reload').onclick = function () {
    var hasChanges = Object.keys(edits).length || Object.keys(dirtyVoiceGroups).length || Object.keys(midiDirty).length;
    if (!hasChanges || confirm('Discard unsaved music changes?')) {
        vscode.postMessage({ type: 'reload', selectedSongId: selectedIndex >= 0 ? songs[selectedIndex].id : null });
    }
};

window.addEventListener('message', function (event) {
    var message = event.data;
    if (message.type === 'init') {
        stopPlayback();
        songs = message.songs; voiceGroups = message.voiceGroups; voiceGroupNames = message.voiceGroupNames;
        keysplitTables = message.keysplitTables; directSoundSamples = message.directSoundSamples;
        programmableWaveSamples = message.programmableWaveSamples; musicPlayerOptions = message.musicPlayerOptions;
        trackBudgets = message.trackBudgets || {};
        selectedIndex = -1; edits = {}; dirtyVoiceGroups = {};
        docCache = {}; midiDirty = {}; undoStack = []; redoStack = []; roll = null;
        trackMute = {}; trackSolo = {};
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
