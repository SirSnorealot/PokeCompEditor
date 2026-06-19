"use strict";

const ATTACK_SECTIONS = [
    { title: 'Attack Data', fields: ['name', 'description', 'effect', 'power', 'type', 'accuracy', 'pp', 'target', 'priority', 'category', 'strikeCount', 'multiHit', 'criticalHitStage', 'alwaysCriticalHit'] },
    { title: 'Attack Flags', fields: ['makesContact', 'ignoresProtect', 'magicCoatAffected', 'snatchAffected', 'ignoresKingsRock', 'punchingMove', 'bitingMove', 'pulseMove', 'soundMove', 'ballisticMove', 'powderMove', 'danceMove', 'windMove', 'slicingMove', 'healingMove', 'minimizeDoubleDamage', 'explosion', 'ignoresTargetAbility', 'ignoresTargetDefenseEvasionStages', 'damagesUnderground', 'damagesUnderwater', 'damagesAirborne', 'damagesAirborneDoubleDamage', 'ignoreTypeIfFlyingAndUngrounded', 'thawsUser', 'ignoresSubstitute', 'forcePressure', 'cantUseTwice', 'alwaysHitsInRain', 'accuracy50InSun', 'alwaysHitsInHailSnow', 'alwaysHitsOnSameType', 'noAffectOnSameTypeTarget', 'accIncreaseByTenOnSameType'] },
    { title: 'Usage Restrictions', fields: ['gravityBanned', 'mirrorMoveBanned', 'meFirstBanned', 'mimicBanned', 'metronomeBanned', 'copycatBanned', 'assistBanned', 'sleepTalkBanned', 'instructBanned', 'encoreBanned', 'parentalBondBanned', 'skyBattleBanned', 'sketchBanned', 'dampBanned', 'validApprenticeMove'] },
    { title: 'Effects and Presentation', fields: ['argument', 'zMove', 'additionalEffects', 'contestEffect', 'contestCategory', 'contestComboStarterId', 'contestComboMoves', 'battleAnimScript'] },
];
const ATTACK_FIELDS = ATTACK_SECTIONS.flatMap(section => section.fields);

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
    throw new Error('Unterminated attack initializer at offset ' + open);
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
    const occurrences = {};
    const re = /^([ \t]*)\.([A-Za-z_]\w*)\s*=\s*/gm;
    const matches = [];
    let match;
    while ((match = re.exec(body)) !== null) matches.push({ match, valueStart: re.lastIndex });
    const topIndent = Math.min(...matches.map(item => item.match[1].replace(/\t/g, '    ').length));
    for (const item of matches) {
        match = item.match;
        if (match[1].replace(/\t/g, '    ').length !== topIndent) continue;
        re.lastIndex = item.valueStart;
        const end = findExpressionEnd(body, re.lastIndex);
        (occurrences[match[2]] ||= []).push({ start: re.lastIndex, end, value: body.slice(re.lastIndex, end).trim() });
    }
    const fields = {};
    for (const name of ATTACK_FIELDS) {
        const values = occurrences[name] || [];
        fields[name] = { value: values[0]?.value || '', present: values.length > 0, conditional: values.length > 1 };
    }
    return { fields, occurrences };
}

function displayName(id, expression) {
    const match = expression && expression.match(/^COMPOUND_STRING\(\s*"((?:\\.|[^"\\])*)"\s*\)$/s);
    if (match) return match[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
    return id.replace(/^MOVE_/, '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

function parseAttacks(content) {
    const table = content.indexOf('gMovesInfo[');
    if (table === -1) throw new Error('Could not find gMovesInfo[]');
    const attacks = [], header = /^\s*\[(MOVE_[A-Za-z0-9_]+)\]\s*=\s*\{/gm;
    header.lastIndex = table;
    let match;
    while ((match = header.exec(content)) !== null) {
        const open = content.indexOf('{', match.index), close = findClosingBrace(content, open);
        const body = content.slice(open + 1, close), parsed = parseFields(body);
        attacks.push({ id: match[1], displayName: displayName(match[1], parsed.fields.name.value), fields: parsed.fields, rawBody: body.trim() });
        header.lastIndex = close + 1;
    }
    return attacks;
}

function applyAttackEdits(content, edits) {
    const table = content.indexOf('gMovesInfo[');
    if (table === -1) throw new Error('Could not find gMovesInfo[]');
    const replacements = [], header = /^\s*\[(MOVE_[A-Za-z0-9_]+)\]\s*=\s*\{/gm;
    header.lastIndex = table;
    let match;
    while ((match = header.exec(content)) !== null) {
        const open = content.indexOf('{', match.index), close = findClosingBrace(content, open), attackEdits = edits[match[1]];
        if (attackEdits) {
            const body = content.slice(open + 1, close), parsed = parseFields(body), additions = [];
            for (const [field, rawValue] of Object.entries(attackEdits)) {
                if (!ATTACK_FIELDS.includes(field)) throw new Error('Unknown attack field: ' + field);
                const occurrences = parsed.occurrences[field] || [], value = String(rawValue).trim();
                if (occurrences.length > 1) throw new Error(field + ' on ' + match[1] + ' is conditional');
                if (!value) throw new Error(field + ' on ' + match[1] + ' cannot be empty');
                if (occurrences.length) replacements.push({ start: open + 1 + occurrences[0].start, end: open + 1 + occurrences[0].end, value });
                else additions.push('        .' + field + ' = ' + value + ',');
            }
            if (additions.length) {
                const whitespace = body.match(/\s*$/)[0].length, insertion = close - whitespace;
                replacements.push({ start: insertion, end: insertion, value: (body.slice(0, -whitespace || undefined).endsWith('\n') ? '' : '\n') + additions.join('\n') + '\n' });
            }
        }
        header.lastIndex = close + 1;
    }
    replacements.sort((a, b) => b.start - a.start);
    for (const item of replacements) content = content.slice(0, item.start) + item.value + content.slice(item.end);
    return content;
}

module.exports = { ATTACK_FIELDS, ATTACK_SECTIONS, parseAttacks, applyAttackEdits };
