"use strict";

const ITEM_FIELDS = [
    'name', 'pluralName', 'price', 'description', 'pocket', 'sortType', 'type',
    'fieldUseFunc', 'battleUsage', 'effect', 'holdEffect', 'holdEffectParam',
    'secondaryId', 'flingPower', 'importance', 'notConsumed', 'iconPic',
    'iconPalette', 'shopCriteriaFunc',
];

/** Find a closing brace while ignoring braces in strings and comments. */
function findClosingBrace(source, open) {
    let depth = 0;
    let quote = '';
    let lineComment = false;
    let blockComment = false;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        const next = source[i + 1];
        if (lineComment) { if (ch === '\n') lineComment = false; continue; }
        if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}' && --depth === 0) return i;
    }
    throw new Error('Unterminated item initializer at offset ' + open);
}

function findExpressionEnd(body, start) {
    let parens = 0;
    let brackets = 0;
    let quote = '';
    let lineComment = false;
    let blockComment = false;
    for (let i = start; i < body.length; i++) {
        const ch = body[i];
        const next = body[i + 1];
        if (lineComment) { if (ch === '\n') lineComment = false; continue; }
        if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(') parens++;
        else if (ch === ')') parens--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
        else if (ch === ',' && parens === 0 && brackets === 0) return i;
    }
    return body.length;
}

function parseFields(body) {
    const occurrences = {};
    const re = /^\s*\.([A-Za-z_]\w*)\s*=\s*/gm;
    let match;
    while ((match = re.exec(body)) !== null) {
        const valueStart = re.lastIndex;
        const valueEnd = findExpressionEnd(body, valueStart);
        if (!occurrences[match[1]]) occurrences[match[1]] = [];
        occurrences[match[1]].push({
            start: valueStart,
            end: valueEnd,
            value: body.slice(valueStart, valueEnd).trim(),
        });
        re.lastIndex = Math.max(valueEnd + 1, re.lastIndex);
    }
    const fields = {};
    for (const name of ITEM_FIELDS) {
        const values = occurrences[name] || [];
        fields[name] = {
            value: values.length ? values[0].value : '',
            present: values.length > 0,
            conditional: values.length > 1 || (values.length === 1 && /^\s*#(?:if|else|elif|endif)\b/m.test(values[0].value)),
        };
    }
    return { fields, occurrences };
}

function displayName(id, expression) {
    const match = expression && expression.match(/^ITEM_NAME\(\s*"((?:\\.|[^"\\])*)"\s*\)$/s);
    if (match) return match[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
    return id.replace(/^ITEM_/, '').replace(/_/g, ' ').toLowerCase()
        .replace(/\b\w/g, char => char.toUpperCase());
}

/** Parse the designated initializers in gItemsInfo. */
function parseItems(content) {
    const table = content.indexOf('gItemsInfo[]');
    if (table === -1) throw new Error('Could not find gItemsInfo[]');
    const items = [];
    const header = /^\s*\[(ITEM_[A-Za-z0-9_]+)\]\s*=\s*\{/gm;
    header.lastIndex = table;
    let match;
    while ((match = header.exec(content)) !== null) {
        const open = content.indexOf('{', match.index);
        const close = findClosingBrace(content, open);
        const body = content.slice(open + 1, close);
        const parsed = parseFields(body);
        items.push({
            id: match[1],
            displayName: displayName(match[1], parsed.fields.name.value),
            fields: parsed.fields,
            rawBody: body.trim(),
        });
        header.lastIndex = close + 1;
    }
    return items;
}

/** Apply { ITEM_ID: { field: expression } } edits without reformatting other source. */
function applyItemEdits(content, edits) {
    const table = content.indexOf('gItemsInfo[]');
    if (table === -1) throw new Error('Could not find gItemsInfo[]');
    const replacements = [];
    const header = /^\s*\[(ITEM_[A-Za-z0-9_]+)\]\s*=\s*\{/gm;
    header.lastIndex = table;
    let match;
    while ((match = header.exec(content)) !== null) {
        const open = content.indexOf('{', match.index);
        const close = findClosingBrace(content, open);
        const itemEdits = edits[match[1]];
        if (itemEdits) {
            const body = content.slice(open + 1, close);
            const parsed = parseFields(body);
            const additions = [];
            for (const [field, value] of Object.entries(itemEdits)) {
                const occurrences = parsed.occurrences[field] || [];
                if (!ITEM_FIELDS.includes(field)) throw new Error('Unknown item field: ' + field);
                if (occurrences.length > 1 || (occurrences.length === 1 && /^\s*#(?:if|else|elif|endif)\b/m.test(occurrences[0].value))) {
                    throw new Error(field + ' on ' + match[1] + ' is conditional');
                }
                const expression = String(value).trim();
                if (!expression) throw new Error(field + ' on ' + match[1] + ' cannot be empty');
                if (occurrences.length === 0) {
                    additions.push('        .' + field + ' = ' + expression + ',');
                } else {
                    replacements.push({
                        start: open + 1 + occurrences[0].start,
                        end: open + 1 + occurrences[0].end,
                        value: expression,
                    });
                }
            }
            if (additions.length) {
                const trailingWhitespace = body.match(/\s*$/)[0].length;
                const insertionPoint = close - trailingWhitespace;
                replacements.push({
                    start: insertionPoint,
                    end: insertionPoint,
                    value: (body.slice(0, body.length - trailingWhitespace).endsWith('\n') ? '' : '\n') + additions.join('\n') + '\n',
                });
            }
        }
        header.lastIndex = close + 1;
    }
    replacements.sort((a, b) => b.start - a.start);
    for (const replacement of replacements) {
        content = content.slice(0, replacement.start) + replacement.value + content.slice(replacement.end);
    }
    return content;
}

module.exports = { ITEM_FIELDS, parseItems, applyItemEdits };
