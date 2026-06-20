"use strict";

function findClosing(source, open, openChar, closeChar) {
    let depth = 0, quote = '', lineComment = false, blockComment = false;
    for (let i = open; i < source.length; i++) {
        const ch = source[i], next = source[i + 1];
        if (lineComment) { if (ch === '\n') lineComment = false; continue; }
        if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
        if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === openChar) depth++;
        else if (ch === closeChar && --depth === 0) return i;
    }
    throw new Error('Unterminated block at offset ' + open);
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findNamedArray(content, symbol) {
    if (!symbol || !/^[A-Za-z_]\w*$/.test(symbol)) return null;
    const re = new RegExp('\\b' + escapeRegExp(symbol) + '\\s*\\[\\s*\\]\\s*=\\s*\\{', 'm');
    const match = re.exec(content);
    if (!match) return null;
    const open = content.indexOf('{', match.index), close = findClosing(content, open, '{', '}');
    return { symbol, open, close, body: content.slice(open + 1, close) };
}

function parseNamedArrays(content) {
    const arrays = {}, re = /\b([A-Za-z_]\w*)\s*\[\s*\]\s*=\s*\{/g;
    let match;
    while ((match = re.exec(content)) !== null) {
        const open = content.indexOf('{', match.index), close = findClosing(content, open, '{', '}');
        arrays[match[1]] = { symbol: match[1], open, close, body: content.slice(open + 1, close) };
        re.lastIndex = close + 1;
    }
    return arrays;
}

function applyNamedArrayEdits(content, edits) {
    const replacements = [];
    for (const [symbol, rawBody] of Object.entries(edits)) {
        const array = findNamedArray(content, symbol);
        if (!array) throw new Error('Could not find array ' + symbol);
        replacements.push({ start: array.open + 1, end: array.close, value: String(rawBody) });
    }
    replacements.sort((a, b) => b.start - a.start);
    for (const item of replacements) content = content.slice(0, item.start) + item.value + content.slice(item.end);
    return content;
}

function findDesignatedInitializer(content, id) {
    if (!id || !/^[A-Za-z_]\w*$/.test(id)) return null;
    const re = new RegExp('\\[' + escapeRegExp(id) + '\\]\\s*=\\s*\\{');
    const match = re.exec(content);
    if (!match) return null;
    const open = content.indexOf('{', match.index), close = findClosing(content, open, '{', '}');
    return { id, open, close, body: content.slice(open + 1, close) };
}

function applyDesignatedInitializerEdits(content, edits) {
    const replacements = [];
    for (const [id, rawBody] of Object.entries(edits)) {
        const initializer = findDesignatedInitializer(content, id);
        if (!initializer) throw new Error('Could not find initializer ' + id);
        replacements.push({ start: initializer.open + 1, end: initializer.close, value: String(rawBody) });
    }
    replacements.sort((a, b) => b.start - a.start);
    for (const item of replacements) content = content.slice(0, item.start) + item.value + content.slice(item.end);
    return content;
}

function findJsonArray(content, key) {
    const re = new RegExp('"' + escapeRegExp(key) + '"\\s*:\\s*\\[');
    const match = re.exec(content);
    if (!match) return null;
    const open = content.indexOf('[', match.index), close = findClosing(content, open, '[', ']');
    return { open, close, values: JSON.parse(content.slice(open, close + 1)) };
}

function applyJsonArrayEdits(content, edits) {
    const replacements = [];
    for (const [key, values] of Object.entries(edits)) {
        const array = findJsonArray(content, key);
        if (!array) throw new Error('Could not find JSON move list for ' + key);
        if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error('Invalid move list for ' + key);
        const indent = '    ';
        const value = values.length ? '[\n' + values.map(move => indent + JSON.stringify(move)).join(',\n') + '\n  ]' : '[]';
        replacements.push({ start: array.open, end: array.close + 1, value });
    }
    replacements.sort((a, b) => b.start - a.start);
    for (const item of replacements) content = content.slice(0, item.start) + item.value + content.slice(item.end);
    JSON.parse(content);
    return content;
}

function expressionSymbol(value, suffix) {
    const match = String(value || '').match(new RegExp('\\b([A-Za-z_]\\w*' + (suffix || '') + ')\\b'));
    return match ? match[1] : '';
}

function splitCList(value) {
    const result = [];
    let start = 0, parens = 0, braces = 0, brackets = 0, quote = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(') parens++; else if (ch === ')') parens--;
        else if (ch === '{') braces++; else if (ch === '}') braces--;
        else if (ch === '[') brackets++; else if (ch === ']') brackets--;
        else if (ch === ',' && parens === 0 && braces === 0 && brackets === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
    }
    if (value.slice(start).trim()) result.push(value.slice(start).trim());
    return result;
}

function parseEvolutionExpression(expression) {
    const match = String(expression || '').match(/^EVOLUTION\(([\s\S]*)\)$/);
    if (!match) return null;
    const inner = match[1], entries = [];
    let depth = 0, start = -1, quote = '';
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '{') { if (depth === 0) start = i; depth++; }
        else if (ch === '}' && --depth === 0 && start >= 0) {
            const parts = splitCList(inner.slice(start + 1, i));
            entries.push({ start, end: i + 1, method: parts[0] || '', parameter: parts[1] || '', target: parts[2] || '', extra: parts.slice(3).join(', ') });
            start = -1;
        }
    }
    return { inner, hasDirectives: /^\s*#/m.test(inner), entries };
}

function parseSpeciesMacros(rawBody) {
    const shadow = String(rawBody || '').match(/\bSHADOW\(\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/);
    return {
        shadow: shadow
            ? { x: shadow[1].trim(), y: shadow[2].trim(), size: shadow[3].trim(), suppressed: false }
            : { x: '0', y: '0', size: 'SHADOW_SIZE_S', suppressed: /\bNO_SHADOW\b/.test(String(rawBody || '')) },
    };
}

module.exports = { findNamedArray, parseNamedArrays, applyNamedArrayEdits, findDesignatedInitializer, applyDesignatedInitializerEdits, findJsonArray, applyJsonArrayEdits, expressionSymbol, parseEvolutionExpression, parseSpeciesMacros };
