"use strict";

const POKEMON_SECTIONS = [
    { title: 'Base Stats and Identity', fields: ['baseHP', 'baseAttack', 'baseDefense', 'baseSpAttack', 'baseSpDefense', 'baseSpeed', 'types', 'abilities'] },
    { title: 'Training and Yields', fields: ['catchRate', 'expYield', 'evYield_HP', 'evYield_Attack', 'evYield_Defense', 'evYield_SpAttack', 'evYield_SpDefense', 'evYield_Speed', 'itemCommon', 'itemRare', 'safariZoneFleeRate'] },
    { title: 'Breeding', fields: ['genderRatio', 'eggCycles', 'friendship', 'growthRate', 'eggGroups', 'eggId', 'teachingType'] },
    { title: 'Pokedex Data and Size Comparison', fields: ['speciesName', 'categoryName', 'natDexNum', 'height', 'weight', 'description', 'bodyColor', 'cryId', 'dexForceRequired', 'pokemonScale', 'pokemonOffset', 'trainerScale', 'trainerOffset'] },
    { title: 'Battle Properties', fields: ['perfectIVCount', 'forceTeraType', 'isFrontierBanned', 'isSkyBattleBanned', 'isTelekinesisBanned', 'isMegaEvolution', 'isPrimalReversion', 'isUltraBurst', 'isGigantamax', 'isTeraForm', 'isTotem', 'isAlolanForm', 'isGalarianForm', 'isHisuianForm', 'isPaldeanForm', 'isParadox', 'isUltraBeast', 'isSubLegendary', 'isRestrictedLegendary', 'isMythical', 'cannotBeTraded'] },
    { title: 'Evolution and Form References', fields: ['levelUpLearnset', 'teachableLearnset', 'eggMoveLearnset', 'evolutions', 'formSpeciesIdTable', 'formChangeTable'] },
    { title: 'Graphics and Animation', fields: ['frontPic', 'frontPicSize', 'frontPicYOffset', 'frontAnimFrames', 'frontAnimId', 'frontAnimDelay', 'backPic', 'backPicSize', 'backPicYOffset', 'backAnimId', 'palette', 'shinyPalette', 'iconSprite', 'iconPalIndex', 'pokemonJumpType', 'enemyMonElevation', 'noFlip'] },
    { title: 'Alternate Graphics', fields: ['frontPicFemale', 'frontPicSizeFemale', 'backPicFemale', 'backPicSizeFemale', 'paletteFemale', 'shinyPaletteFemale', 'iconSpriteFemale', 'iconPalIndexFemale'] },
];
const POKEMON_FIELDS = POKEMON_SECTIONS.flatMap(section => section.fields);

function findClosingBrace(source, open) {
    let depth = 0, quote = '', lineComment = false, blockComment = false;
    for (let i = open; i < source.length; i++) {
        const ch = source[i], next = source[i + 1];
        if (lineComment) { if (ch === '\n') lineComment = false; continue; }
        if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
        if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return i;
    }
    throw new Error('Unterminated species initializer at offset ' + open);
}

function findExpressionEnd(body, start) {
    let parens = 0, brackets = 0, braces = 0, quote = '', lineComment = false, blockComment = false;
    for (let i = start; i < body.length; i++) {
        const ch = body[i], next = body[i + 1];
        if (lineComment) { if (ch === '\n') lineComment = false; continue; }
        if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
        if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(') parens++; else if (ch === ')') parens--;
        else if (ch === '[') brackets++; else if (ch === ']') brackets--;
        else if (ch === '{') braces++; else if (ch === '}') braces--;
        else if (ch === ',' && parens === 0 && brackets === 0 && braces === 0) return i;
    }
    return body.length;
}

function parseFields(body) {
    const occurrences = {}, re = /^([ \t]*)\.([A-Za-z_]\w*)\s*=\s*/gm, matches = [];
    let match;
    while ((match = re.exec(body)) !== null) matches.push({ match, valueStart: re.lastIndex });
    const topIndent = matches.length ? Math.min(...matches.map(item => item.match[1].replace(/\t/g, '    ').length)) : 0;
    for (const item of matches) {
        match = item.match;
        if (match[1].replace(/\t/g, '    ').length !== topIndent) continue;
        const end = findExpressionEnd(body, item.valueStart);
        let assignmentEnd = end < body.length ? end + 1 : end;
        if (body.slice(assignmentEnd, assignmentEnd + 2) === '\r\n') assignmentEnd += 2;
        else if (body[assignmentEnd] === '\n') assignmentEnd++;
        (occurrences[match[2]] ||= []).push({ assignmentStart: match.index, assignmentEnd, start: item.valueStart, end, value: body.slice(item.valueStart, end).trim() });
    }
    const fields = {};
    for (const name of POKEMON_FIELDS) {
        const values = occurrences[name] || [];
        fields[name] = { value: values[0]?.value || '', present: values.length > 0, conditional: values.length > 1 };
    }
    return { fields, occurrences };
}

function displayName(id, expression) {
    const match = expression && expression.match(/^_\(\s*"((?:\\.|[^"\\])*)"\s*\)$/s);
    if (match) return match[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
    return id.replace(/^SPECIES_/, '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

function maskComments(content) {
    return content.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\r\n]/g, ' '))
        .replace(/\/\/[^\r\n]*/g, comment => ' '.repeat(comment.length));
}

function parsePokemon(content, sourceFile) {
    const pokemon = [], header = /^\s*\[(SPECIES_[A-Za-z0-9_]+)\]\s*=\s*\{/gm;
    const searchable = maskComments(content);
    let match;
    while ((match = header.exec(searchable)) !== null) {
        const open = content.indexOf('{', match.index), close = findClosingBrace(content, open);
        const body = content.slice(open + 1, close), parsed = parseFields(body);
        pokemon.push({ id: match[1], displayName: displayName(match[1], parsed.fields.speciesName.value), sourceFile, fields: parsed.fields, rawBody: body });
        header.lastIndex = close + 1;
    }
    return pokemon;
}

function applyPokemonEdits(content, edits) {
    const replacements = [], header = /^\s*\[(SPECIES_[A-Za-z0-9_]+)\]\s*=\s*\{/gm;
    const searchable = maskComments(content);
    let match;
    while ((match = header.exec(searchable)) !== null) {
        const open = content.indexOf('{', match.index), close = findClosingBrace(content, open), pokemonEdits = edits[match[1]];
        if (pokemonEdits) {
            const rawBody = pokemonEdits.$rawBody === undefined ? content.slice(open + 1, close) : String(pokemonEdits.$rawBody);
            const wrapped = '{' + rawBody + '}';
            if (findClosingBrace(wrapped, 0) !== wrapped.length - 1) throw new Error('Invalid initializer source for ' + match[1]);
            const body = rawBody, parsed = parseFields(body), additions = [], bodyReplacements = [];
            for (const [field, rawValue] of Object.entries(pokemonEdits)) {
                if (field === '$rawBody') continue;
                if (!POKEMON_FIELDS.includes(field)) throw new Error('Unknown Pokemon field: ' + field);
                const occurrences = parsed.occurrences[field] || [];
                if (occurrences.length > 1) throw new Error(field + ' on ' + match[1] + ' is conditional');
                if (rawValue === null) {
                    if (occurrences.length) bodyReplacements.push({ start: occurrences[0].assignmentStart, end: occurrences[0].assignmentEnd, value: '' });
                    continue;
                }
                const value = String(rawValue).trim();
                if (!value) throw new Error(field + ' on ' + match[1] + ' cannot be empty');
                if (occurrences.length) bodyReplacements.push({ start: occurrences[0].start, end: occurrences[0].end, value });
                else additions.push('        .' + field + ' = ' + value + ',');
            }
            let updatedBody = body;
            bodyReplacements.sort((a, b) => b.start - a.start);
            for (const item of bodyReplacements) updatedBody = updatedBody.slice(0, item.start) + item.value + updatedBody.slice(item.end);
            if (additions.length) {
                const trailing = updatedBody.match(/(\r?\n)([ \t]*)$/);
                const newline = trailing ? trailing[1] : '\n', indent = trailing ? trailing[2] : '';
                const base = trailing ? updatedBody.slice(0, -trailing[0].length) : updatedBody;
                updatedBody = base + newline + additions.join(newline) + newline + indent;
            }
            replacements.push({ start: open + 1, end: close, value: updatedBody });
        }
        header.lastIndex = close + 1;
    }
    replacements.sort((a, b) => b.start - a.start);
    for (const item of replacements) content = content.slice(0, item.start) + item.value + content.slice(item.end);
    return content;
}

module.exports = { POKEMON_FIELDS, POKEMON_SECTIONS, parsePokemon, applyPokemonEdits };
