"use strict";

// ---------------------------------------------------------------------------
// include/constants/songs.h  —  #define MUS_x / SE_x / PH_x <value>
// ---------------------------------------------------------------------------

const SONG_CONSTANT_RE = /^#define[ \t]+((?:MUS|SE|PH)_[A-Za-z0-9_]+)[ \t]+(0[xX][0-9A-Fa-f]+|\d+)\b[ \t]*(\/\/[^\r\n]*)?$/gm;

/** Parse every numeric MUS_/SE_/PH_ constant from songs.h, in file order. */
function parseSongConstants(content) {
    const results = [];
    SONG_CONSTANT_RE.lastIndex = 0;
    let match;
    while ((match = SONG_CONSTANT_RE.exec(content)) !== null) {
        const value = match[2].toLowerCase().startsWith('0x') ? parseInt(match[2], 16) : parseInt(match[2], 10);
        results.push({
            name: match[1],
            value,
            comment: (match[3] || '').replace(/^\/\/[ \t]*/, '').trim(),
            lineStart: match.index,
            lineEnd: match.index + match[0].length,
        });
    }
    return results;
}

/** Insert a new `#define NAME value` line into songs.h, just before the MUS_ROUTE118 sentinel. */
function insertSongConstant(content, name, value) {
    const marker = /^#define[ \t]+MUS_ROUTE118\b/m.exec(content);
    if (!marker) throw new Error('Could not find MUS_ROUTE118 insertion marker in songs.h');
    const lineStart = content.lastIndexOf('\n', marker.index - 1) + 1;
    const padding = ' '.repeat(Math.max(1, 29 - ('#define ' + name).length));
    return content.slice(0, lineStart) + '#define ' + name + padding + value + '\n' + content.slice(lineStart);
}

// ---------------------------------------------------------------------------
// sound/song_table.inc  —  gSongTable::  (flat array indexed by MUS_/SE_/PH_ id)
// ---------------------------------------------------------------------------

const SONG_TABLE_ENTRY_RE = /^[ \t]*song[ \t]+([A-Za-z0-9_]+)[ \t]*,[ \t]*(MUSIC_PLAYER_[A-Za-z0-9_]+)[ \t]*,[ \t]*([^\r\n]+?)[ \t]*$/gm;

/** Parse gSongTable entries in order. `index` in the returned array IS the song's numeric id. */
function parseSongTable(content) {
    const entries = [];
    SONG_TABLE_ENTRY_RE.lastIndex = 0;
    let match;
    while ((match = SONG_TABLE_ENTRY_RE.exec(content)) !== null) {
        entries.push({
            index: entries.length,
            label: match[1],
            musicPlayer: match[2],
            unknown: match[3].trim(),
            lineStart: match.index,
            lineEnd: match.index + match[0].length,
        });
    }
    return entries;
}

/** Index of the first unused `dummy_song_header` slot, or -1 if the table has no free slots. */
function findFreeDummySlot(entries) {
    return entries.findIndex(entry => entry.label === 'dummy_song_header');
}

/** Rewrite an existing gSongTable entry in place (used for edits and for claiming a dummy slot). */
function setSongTableEntry(content, index, label, musicPlayer, unknown) {
    const entries = parseSongTable(content);
    const entry = entries[index];
    if (!entry) throw new Error('song_table.inc has no entry at index ' + index);
    const newLine = '\tsong ' + label + ', ' + musicPlayer + ', ' + unknown;
    return content.slice(0, entry.lineStart) + newLine + content.slice(entry.lineEnd);
}

/** Append a brand-new entry at the end of gSongTable (its index becomes the new song's id). */
function appendSongTableEntry(content, label, musicPlayer, unknown) {
    const trimmed = content.replace(/[ \t\r\n]+$/, '');
    return trimmed + '\n\tsong ' + label + ', ' + musicPlayer + ', ' + unknown + '\n';
}

// ---------------------------------------------------------------------------
// sound/songs/midi/midi.cfg  —  mid2agb per-song compiler flags
// ---------------------------------------------------------------------------

const MIDI_CFG_LINE_RE = /^([^\r\n:]+):[ \t]*([^\r\n]*)$/gm;

/** Parse midi.cfg into a Map keyed by song label (".mid" suffix stripped, case-preserved). */
function parseMidiCfg(content) {
    const entries = new Map();
    MIDI_CFG_LINE_RE.lastIndex = 0;
    let match;
    while ((match = MIDI_CFG_LINE_RE.exec(content)) !== null) {
        const rawKey = match[1].trim();
        const key = rawKey.replace(/\.mid$/i, '');
        entries.set(key, { rawKey, args: match[2].trim(), lineStart: match.index, lineEnd: match.index + match[0].length });
    }
    return entries;
}

/** Parse a midi.cfg argument string (e.g. `-E -R50 -G_route101 -V080`) into a structured flag set. */
function parseCfgFlags(argsString) {
    const flags = { E: false, X: false, N: false, R: null, G: '', P: null, V: null, L: '', extra: [] };
    for (const token of String(argsString || '').split(/\s+/).filter(Boolean)) {
        if (token[0] !== '-' || token.length < 2) { flags.extra.push(token); continue; }
        const letter = token[1].toUpperCase();
        const rest = token.slice(2);
        switch (letter) {
            case 'E': flags.E = true; break;
            case 'X': flags.X = true; break;
            case 'N': flags.N = true; break;
            case 'R': flags.R = rest === '' ? null : parseInt(rest, 10); break;
            case 'G': flags.G = rest; break;
            case 'P': flags.P = rest === '' ? null : parseInt(rest, 10); break;
            case 'V': flags.V = rest === '' ? null : parseInt(rest, 10); break;
            case 'L': flags.L = rest; break;
            default: flags.extra.push(token);
        }
    }
    return flags;
}

/** Serialize a structured flag set back into mid2agb argument syntax, matching the project's style. */
function serializeCfgFlags(flags) {
    const parts = [];
    if (flags.E) parts.push('-E');
    if (flags.R !== null && flags.R !== undefined && flags.R !== '') parts.push('-R' + flags.R);
    if (flags.G) parts.push('-G' + flags.G);
    if (flags.V !== null && flags.V !== undefined && flags.V !== '') parts.push('-V' + String(flags.V).padStart(3, '0'));
    if (flags.P !== null && flags.P !== undefined && flags.P !== '') parts.push('-P' + flags.P);
    if (flags.X) parts.push('-X');
    if (flags.N) parts.push('-N');
    if (flags.L) parts.push('-L' + flags.L);
    for (const extra of flags.extra) parts.push(extra);
    return parts.join(' ');
}

/** Replace (or append, if missing) a song's midi.cfg line with new argument text. */
function setMidiCfgArgs(content, key, argsString) {
    const entries = parseMidiCfg(content);
    const entry = entries.get(key);
    if (entry) {
        const newLine = entry.rawKey + ':' + ' '.repeat(Math.max(1, 24 - entry.rawKey.length - 1)) + argsString;
        return content.slice(0, entry.lineStart) + newLine + content.slice(entry.lineEnd);
    }
    const trimmed = content.replace(/[ \t\r\n]+$/, '');
    const rawKey = key + '.mid';
    const newLine = rawKey + ':' + ' '.repeat(Math.max(1, 24 - rawKey.length - 1)) + argsString;
    return trimmed + '\n' + newLine + '\n';
}

// ---------------------------------------------------------------------------
// sound/voicegroups/**/*.inc  —  voice_group blocks (instrument banks)
// ---------------------------------------------------------------------------

/** macro name -> { params, leaf, kind } describing each supported voice entry macro. */
const VOICE_ENTRY_TYPES = {
    voice_directsound: { params: ['baseKey', 'pan', 'sample', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'directsound' },
    voice_directsound_no_resample: { params: ['baseKey', 'pan', 'sample', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'directsound' },
    voice_directsound_alt: { params: ['baseKey', 'pan', 'sample', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'directsound' },
    voice_square_1: { params: ['baseKey', 'pan', 'sweep', 'dutyCycle', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'square1' },
    voice_square_1_alt: { params: ['baseKey', 'pan', 'sweep', 'dutyCycle', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'square1' },
    voice_square_2: { params: ['baseKey', 'pan', 'dutyCycle', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'square2' },
    voice_square_2_alt: { params: ['baseKey', 'pan', 'dutyCycle', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'square2' },
    voice_programmable_wave: { params: ['baseKey', 'pan', 'wave', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'wave' },
    voice_programmable_wave_alt: { params: ['baseKey', 'pan', 'wave', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'wave' },
    voice_noise: { params: ['baseKey', 'pan', 'period', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'noise' },
    voice_noise_alt: { params: ['baseKey', 'pan', 'period', 'attack', 'decay', 'sustain', 'release'], leaf: true, kind: 'noise' },
    voice_keysplit: { params: ['group', 'table'], leaf: false, kind: 'keysplit' },
    voice_keysplit_all: { params: ['group'], leaf: false, kind: 'keysplit_all' },
};

function splitArgs(text) {
    return String(text || '').split(',').map(part => part.trim()).filter(part => part.length);
}

/** Parse `.include "sound/voicegroups/....inc"` lines from sound/voice_groups.inc, in load order. */
function parseVoiceGroupsInclude(content) {
    const files = [];
    const re = /\.include[ \t]+"([^"]+)"/g;
    let match;
    while ((match = re.exec(content)) !== null) files.push(match[1]);
    return files;
}

/** Append a new `.include` line for a freshly created voice group file. */
function appendVoiceGroupInclude(content, relativePath) {
    const trimmed = content.replace(/[ \t\r\n]+$/, '');
    return trimmed + '\n.include "' + relativePath + '"\n';
}

/** Parse every `voice_group name(, startNote)?` block in a single .inc file's contents. */
function parseVoiceGroupFile(content) {
    const headers = [];
    const headerRe = /^voice_group[ \t]+([A-Za-z0-9_]+)(?:[ \t]*,[ \t]*(\d+))?[ \t]*(?:@.*)?$/gm;
    let match;
    while ((match = headerRe.exec(content)) !== null) {
        headers.push({ name: match[1], startNote: match[2] !== undefined ? parseInt(match[2], 10) : 0, index: match.index, headerEnd: match.index + match[0].length });
    }
    const groups = [];
    for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        const blockEnd = i + 1 < headers.length ? headers[i + 1].index : content.length;
        const block = content.slice(header.headerEnd, blockEnd);
        const entries = [];
        const entryRe = /^[ \t]*(voice_[a-z0-9_]+)[ \t]+([^\r\n]+?)[ \t]*$/gm;
        let entryMatch;
        while ((entryMatch = entryRe.exec(block)) !== null) {
            const spec = VOICE_ENTRY_TYPES[entryMatch[1]];
            if (!spec) continue;
            const args = splitArgs(entryMatch[2]);
            const entry = {
                macro: entryMatch[1],
                kind: spec.kind,
                leaf: spec.leaf,
                lineStart: header.headerEnd + entryMatch.index,
                lineEnd: header.headerEnd + entryMatch.index + entryMatch[0].length,
            };
            spec.params.forEach((paramName, paramIndex) => { entry[paramName] = args[paramIndex] !== undefined ? args[paramIndex] : ''; });
            entries.push(entry);
        }
        groups.push({ name: header.name, symbol: 'voicegroup_' + header.name, startNote: header.startNote, entries, blockStart: header.headerEnd, blockEnd });
    }
    return groups;
}

/** Build a Map(groupName -> group) across every parsed voicegroup file, tagging each with its source path. */
function indexVoiceGroups(files) {
    const map = new Map();
    for (const file of files) {
        for (const group of parseVoiceGroupFile(file.content)) {
            group.sourceFile = file.path;
            map.set(group.name, group);
        }
    }
    return map;
}

function serializeVoiceEntryLine(macro, paramsArray) {
    return '\t' + macro + ' ' + paramsArray.join(', ');
}

/** Replace an existing voice group entry's macro/params in place. */
function setVoiceGroupEntry(content, groupName, entryIndex, macro, paramsArray) {
    const group = parseVoiceGroupFile(content).find(candidate => candidate.name === groupName);
    if (!group) throw new Error('Voice group not found: ' + groupName);
    const entry = group.entries[entryIndex];
    if (!entry) throw new Error('Voice group ' + groupName + ' has no entry at index ' + entryIndex);
    return content.slice(0, entry.lineStart) + serializeVoiceEntryLine(macro, paramsArray) + content.slice(entry.lineEnd);
}

/** Insert a new voice group entry at the given index (or at the end when atIndex >= entry count). */
function insertVoiceGroupEntry(content, groupName, atIndex, macro, paramsArray) {
    const group = parseVoiceGroupFile(content).find(candidate => candidate.name === groupName);
    if (!group) throw new Error('Voice group not found: ' + groupName);
    const newLine = serializeVoiceEntryLine(macro, paramsArray) + '\n';
    const insertPos = atIndex >= group.entries.length ? group.blockEnd : group.entries[atIndex].lineStart;
    return content.slice(0, insertPos) + newLine + content.slice(insertPos);
}

/** Remove a voice group entry, shifting every later entry's program index down by one. */
function removeVoiceGroupEntry(content, groupName, entryIndex) {
    const group = parseVoiceGroupFile(content).find(candidate => candidate.name === groupName);
    if (!group) throw new Error('Voice group not found: ' + groupName);
    const entry = group.entries[entryIndex];
    if (!entry) throw new Error('Voice group ' + groupName + ' has no entry at index ' + entryIndex);
    let end = entry.lineEnd;
    if (content.slice(end, end + 2) === '\r\n') end += 2;
    else if (content[end] === '\n') end += 1;
    return content.slice(0, entry.lineStart) + content.slice(end);
}

/** Build the text content for a brand-new voice group .inc file. */
function createVoiceGroupFileContent(name, entries) {
    const lines = ['voice_group ' + name];
    for (const entry of entries) lines.push('\t' + entry.macro + ' ' + entry.params.join(', '));
    return lines.join('\n') + '\n';
}

/** Replace an entire voice group's entry list in one shot (simplest, safest way to apply UI edits). */
function setVoiceGroupBody(content, groupName, entries) {
    const group = parseVoiceGroupFile(content).find(candidate => candidate.name === groupName);
    if (!group) throw new Error('Voice group not found: ' + groupName);
    const body = entries.map(entry => serializeVoiceEntryLine(entry.macro, entry.params)).join('\n') + (entries.length ? '\n' : '');
    return content.slice(0, group.blockStart) + '\n' + body + content.slice(group.blockEnd);
}

// ---------------------------------------------------------------------------
// sound/keysplit_tables.inc  —  per-note voice index lookup tables
// ---------------------------------------------------------------------------

function parseKeysplitTables(content) {
    const headers = [];
    const headerRe = /^keysplit[ \t]+([A-Za-z0-9_]+)[ \t]*,[ \t]*(\d+)[ \t]*$/gm;
    let match;
    while ((match = headerRe.exec(content)) !== null) headers.push({ name: match[1], startNote: parseInt(match[2], 10), index: match.index, headerEnd: match.index + match[0].length });
    const tables = new Map();
    for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        const blockEnd = i + 1 < headers.length ? headers[i + 1].index : content.length;
        const block = content.slice(header.headerEnd, blockEnd);
        const splitRe = /^[ \t]*split[ \t]+(\d+)[ \t]*,[ \t]*(\d+)[ \t]*$/gm;
        const ranges = [];
        let lastNote = header.startNote;
        let splitMatch;
        while ((splitMatch = splitRe.exec(block)) !== null) {
            const endNote = parseInt(splitMatch[2], 10);
            ranges.push({ index: parseInt(splitMatch[1], 10), startNote: lastNote, endNote });
            lastNote = endNote;
        }
        tables.set(header.name, { symbol: 'keysplit_' + header.name, startNote: header.startNote, ranges });
    }
    return tables;
}

/** Resolve a raw MIDI note to a voice index using a parsed keysplit table (clamping out-of-range notes). */
function lookupKeysplit(table, note) {
    if (!table.ranges.length) return 0;
    if (note < table.ranges[0].startNote) return table.ranges[0].index;
    for (const range of table.ranges) if (note < range.endNote) return range.index;
    return table.ranges[table.ranges.length - 1].index;
}

// ---------------------------------------------------------------------------
// sound/direct_sound_data.inc & sound/programmable_wave_data.inc
// ---------------------------------------------------------------------------

/** Parse `SYMBOL:: \n .incbin "path"` pairs (used for both DirectSoundWaveData_* and ProgrammableWaveData_*). */
function parseIncbinMap(content) {
    const map = new Map();
    const re = /^([A-Za-z_][A-Za-z0-9_]*)::?[ \t]*\r?\n[ \t]*\.incbin[ \t]+"([^"]+)"/gm;
    let match;
    while ((match = re.exec(content)) !== null) map.set(match[1], match[2]);
    return map;
}

// ---------------------------------------------------------------------------
// Instrument resolution — walks keysplit/keysplit_all chains down to a leaf voice.
// ---------------------------------------------------------------------------

function symbolToGroupName(symbol) { return String(symbol || '').replace(/^voicegroup_/, ''); }
function symbolToKeysplitName(symbol) { return String(symbol || '').replace(/^keysplit_/, ''); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

/**
 * Resolve the leaf instrument voice that plays for (programIndex, midiNote) within a voice group,
 * following voice_keysplit / voice_keysplit_all chains through nested groups.
 * @returns {{entry:object, groupName:string, entryIndex:number}|null}
 */
function resolveVoice(groupName, programIndex, midiNote, groupIndex, keysplitTables, depth) {
    depth = depth || 0;
    if (depth > 4) return null;
    const group = groupIndex.get(groupName);
    if (!group || !group.entries.length) return null;
    const entryIndex = clamp(programIndex, 0, group.entries.length - 1);
    const entry = group.entries[entryIndex];
    if (!entry) return null;
    if (entry.kind === 'keysplit_all') {
        const subName = symbolToGroupName(entry.group);
        const sub = groupIndex.get(subName);
        if (!sub || !sub.entries.length) return null;
        const subIndex = clamp(midiNote - sub.startNote, 0, sub.entries.length - 1);
        if (sub.entries[subIndex].leaf) return { entry: sub.entries[subIndex], groupName: subName, entryIndex: subIndex };
        return resolveVoice(subName, subIndex, midiNote, groupIndex, keysplitTables, depth + 1);
    }
    if (entry.kind === 'keysplit') {
        const subName = symbolToGroupName(entry.group);
        const sub = groupIndex.get(subName);
        const table = keysplitTables.get(symbolToKeysplitName(entry.table));
        if (!sub || !sub.entries.length || !table) return null;
        const subIndex = clamp(lookupKeysplit(table, midiNote), 0, sub.entries.length - 1);
        if (sub.entries[subIndex].leaf) return { entry: sub.entries[subIndex], groupName: subName, entryIndex: subIndex };
        return resolveVoice(subName, subIndex, midiNote, groupIndex, keysplitTables, depth + 1);
    }
    return { entry, groupName, entryIndex };
}

module.exports = {
    parseSongConstants,
    insertSongConstant,
    parseSongTable,
    findFreeDummySlot,
    setSongTableEntry,
    appendSongTableEntry,
    parseMidiCfg,
    parseCfgFlags,
    serializeCfgFlags,
    setMidiCfgArgs,
    VOICE_ENTRY_TYPES,
    parseVoiceGroupsInclude,
    appendVoiceGroupInclude,
    parseVoiceGroupFile,
    indexVoiceGroups,
    setVoiceGroupEntry,
    insertVoiceGroupEntry,
    removeVoiceGroupEntry,
    createVoiceGroupFileContent,
    setVoiceGroupBody,
    parseKeysplitTables,
    lookupKeysplit,
    parseIncbinMap,
    resolveVoice,
    symbolToGroupName,
    symbolToKeysplitName,
};
