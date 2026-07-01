"use strict";

const fs   = require('fs');
const path = require('path');

function readIfExists(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function uniqueMatches(source, pattern) {
    return [...new Set([...String(source || '').matchAll(pattern)].map(match => match[0]))];
}

function readConstants(projectRootPath, constantsFile, pattern) {
    return uniqueMatches(readIfExists(path.join(projectRootPath, 'include', 'constants', constantsFile)), pattern);
}

function readPrefixedConstants(source, prefix) {
    return uniqueMatches(source, new RegExp('\\b' + prefix + '[A-Za-z0-9_]+\\b', 'g'));
}

function constantLabel(value, prefix) {
    return toDisplayName(value.replace(prefix, ''));
}

function constantChoices(values, prefix) {
    return values.map(value => ({ value, label: constantLabel(value, prefix) }));
}

const ATTACK_BOOLEAN_FIELDS = [
    'multiHit', 'alwaysCriticalHit', 'makesContact', 'ignoresProtect',
    'magicCoatAffected', 'snatchAffected', 'ignoresKingsRock', 'punchingMove',
    'bitingMove', 'pulseMove', 'soundMove', 'ballisticMove', 'powderMove',
    'danceMove', 'windMove', 'slicingMove', 'healingMove',
    'minimizeDoubleDamage', 'explosion', 'ignoresTargetAbility',
    'ignoresTargetDefenseEvasionStages', 'damagesUnderground',
    'damagesUnderwater', 'damagesAirborne', 'damagesAirborneDoubleDamage',
    'ignoreTypeIfFlyingAndUngrounded', 'thawsUser', 'ignoresSubstitute',
    'forcePressure', 'cantUseTwice', 'alwaysHitsInRain', 'accuracy50InSun',
    'alwaysHitsInHailSnow', 'alwaysHitsOnSameType', 'noAffectOnSameTypeTarget',
    'accIncreaseByTenOnSameType', 'gravityBanned', 'mirrorMoveBanned',
    'meFirstBanned', 'mimicBanned', 'metronomeBanned', 'copycatBanned',
    'assistBanned', 'sleepTalkBanned', 'instructBanned', 'encoreBanned',
    'parentalBondBanned', 'skyBattleBanned', 'sketchBanned', 'dampBanned',
    'validApprenticeMove',
];

/**
 * Convert a SCREAMING_CASE constant name to a readable display name.
 * e.g. "BULBASAUR" → "Bulbasaur", "NIDORAN_F" → "Nidoran-F", "MR_MIME" → "Mr. Mime"
 * @param {string} name  — the part after the prefix (e.g. "BULBASAUR", "NIDORAN_F")
 * @returns {string}
 */
function toDisplayName(name) {
    // Special mappings for punctuation
    const specials = {
        'NIDORAN_F': 'Nidoran-F', 'NIDORAN_M': 'Nidoran-M',
        'MR_MIME': 'Mr. Mime', 'MR_RIME': 'Mr. Rime',
        'MIME_JR': 'Mime Jr.', 'FLABEBE': 'Flabébé',
        'TYPE_NULL': 'Type: Null', 'JANGMO_O': 'Jangmo-o',
        'HAKAMO_O': 'Hakamo-o', 'KOMMO_O': 'Kommo-o',
        'WO_CHIEN': 'Wo-Chien', 'CHIEN_PAO': 'Chien-Pao',
        'TING_LU': 'Ting-Lu', 'CHI_YU': 'Chi-Yu',
        'IRON_BUNDLE':'Iron Bundle','IRON_HANDS':'Iron Hands',
        'IRON_JUGULIS':'Iron Jugulis','IRON_MOTH':'Iron Moth',
        'IRON_THORNS':'Iron Thorns','IRON_TREADS':'Iron Treads',
        'IRON_VALIANT':'Iron Valiant','IRON_LEAVES':'Iron Leaves',
        'IRON_BOULDER':'Iron Boulder','IRON_CROWN':'Iron Crown',
        'GREAT_TUSK':'Great Tusk','SCREAM_TAIL':'Scream Tail',
        'BRUTE_BONNET':'Brute Bonnet','FLUTTER_MANE':'Flutter Mane',
        'SLITHER_WING':'Slither Wing','SANDY_SHOCKS':'Sandy Shocks',
        'ROARING_MOON':'Roaring Moon','WALKING_WAKE':'Walking Wake',
        'GOUGING_FIRE':'Gouging Fire','RAGING_BOLT':'Raging Bolt',
    };
    if (specials[name]) return specials[name];
    // Default: title-case each word, replace _ with space
    return name.replace(/_/g, ' ')
               .toLowerCase()
               .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Parse an enum from a C header file. Returns array of { name, display } objects.
 * Only includes entries with explicit numeric assignments (= N) to avoid aliases.
 * @param {string} filePath
 * @param {string} prefix   e.g. "SPECIES_"
 * @returns {string[]}  display name strings, in enum order (sorted by value)
 */
function parseEnum(filePath, prefix) {
    if (!fs.existsSync(filePath)) return [];
    const txt = fs.readFileSync(filePath, 'utf8');
    const re  = new RegExp(prefix + '(\\w+)\\s*=\\s*(\\d+)', 'g');
    const entries = [];
    let m;
    while ((m = re.exec(txt)) !== null) {
        entries.push({ key: m[1], value: parseInt(m[2], 10) });
    }
    // Sort by value, deduplicate by value (keep first)
    entries.sort((a, b) => a.value - b.value);
    const seen = new Set();
    const result = [];
    for (const e of entries) {
        if (seen.has(e.value)) continue;
        seen.add(e.value);
        result.push(toDisplayName(e.key));
    }
    return result;
}

/**
 * Parse AI flags from battle_ai.h.
 * Returns array of { flag, label, description } — flag is the human-readable name
 * used in the .party file (e.g. "Check Bad Move"), description from the inline comment.
 * Only includes single-bit AI_FLAG(n) definitions, not composite macros.
 * @param {string} filePath
 * @returns {Array<{flag:string, label:string, description:string}>}
 */
function parseAIFlags(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const txt = fs.readFileSync(filePath, 'utf8');
    const result = [];
    // Match: #define AI_FLAG_SOMETHING AI_FLAG(n) // description
    const re = /#define\s+AI_FLAG_(\w+)\s+AI_FLAG\(\d+\)\s*(?:\/\/\s*(.+))?/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
        const key   = m[1]; // e.g. CHECK_BAD_MOVE
        const desc  = (m[2] || '').trim();
        // Convert SCREAMING_CASE to Title Case for the flag name used in .party files
        const label = key.replace(/_/g, ' ')
                         .toLowerCase()
                         .replace(/\b\w/g, c => c.toUpperCase());
        result.push({ flag: label, label, description: desc });
    }
    return result;
}

/**
 * Parse natures from pokemon.h in definition order.
 * @param {string} filePath
 * @returns {string[]}
 */
function parseNatures(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const txt = fs.readFileSync(filePath, 'utf8');
    const re  = /#define\s+NATURE_(\w+)\s+(\d+)/g;
    const entries = [];
    let m;
    while ((m = re.exec(txt)) !== null) {
        const key = m[1];
        if (key === 'RANDOM' || key === 'MAY_SYNCHRONIZE') continue;
        entries.push({ key, value: parseInt(m[2], 10) });
    }
    entries.sort((a, b) => a.value - b.value);
    return entries.map(e =>
        e.key.charAt(0) + e.key.slice(1).toLowerCase()
    );
}

/**
 * Parse Pokéballs from pokeball.h enum, in order, skipping sentinels.
 * @param {string} filePath
 * @returns {string[]}
 */
function parseBalls(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const txt = fs.readFileSync(filePath, 'utf8');
    const re  = /BALL_(\w+)\s*=\s*(\d+)/g;
    const entries = [];
    let m;
    while ((m = re.exec(txt)) !== null) {
        const key = m[1];
        if (key === 'STRANGE' || key === 'RANDOM') continue;
        entries.push({ key, value: parseInt(m[2], 10) });
    }
    entries.sort((a, b) => a.value - b.value);
    // Convert GREAT -> Great, ULTRA -> Ultra, etc.
    return entries.map(e =>
        e.key.charAt(0) + e.key.slice(1).toLowerCase()
    );
}

/**
 * Parse Pokémon types from pokemon.h enum, skipping NONE, MYSTERY, STELLAR, NUMBER_OF_MON_TYPES.
 * @param {string} filePath
 * @returns {string[]}
 */
function parseTypes(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const txt = fs.readFileSync(filePath, 'utf8');
    const re  = /TYPE_(\w+)\s*=\s*(\d+)/g;
    const skip = new Set(['NONE', 'MYSTERY', 'STELLAR', 'NUMBER_OF_MON_TYPES']);
    const entries = [];
    let m;
    while ((m = re.exec(txt)) !== null) {
        if (skip.has(m[1])) continue;
        entries.push({ key: m[1], value: parseInt(m[2], 10) });
    }
    entries.sort((a, b) => a.value - b.value);
    return entries.map(e =>
        e.key.charAt(0) + e.key.slice(1).toLowerCase()
    );
}

/**
 * Extract unique trainer classes and music types from a .party file.
 * @param {string} partyFilePath
 * @returns {{ trainerClasses: string[], musicTypes: string[] }}
 */
function parsePartyFileMetadata(partyFilePath) {
    if (!fs.existsSync(partyFilePath)) return { trainerClasses: [], musicTypes: [] };
    const txt = fs.readFileSync(partyFilePath, 'utf8');
    const classes = [...new Set(
        [...txt.matchAll(/^Class: (.+)$/gm)].map(m => m[1].trim())
    )].sort();
    const music = [...new Set(
        [...txt.matchAll(/^Music: (.+)$/gm)].map(m => m[1].trim())
    )].sort();
    return { trainerClasses: classes, musicTypes: music };
}

/**
 * Load all game data from the project root.
 * @param {string} projectRootPath  — fsPath of project root
 * @param {string} [partyFilePath]  — optional path to trainers.party for class/music scanning
 * @returns {{ species, moves, abilities, items, aiFlags, natures, balls, types, trainerClasses, musicTypes }}
 */
function loadGameData(projectRootPath, partyFilePath) {
    const c = p => path.join(projectRootPath, 'include', 'constants', p);
    const partyMeta = partyFilePath
        ? parsePartyFileMetadata(partyFilePath)
        : { trainerClasses: [], musicTypes: [] };
    return {
        species:        parseEnum(c('species.h'),   'SPECIES_'),
        moves:          parseEnum(c('moves.h'),      'MOVE_'),
        abilities:      parseEnum(c('abilities.h'),  'ABILITY_'),
        items:          parseEnum(c('items.h'),       'ITEM_'),
        aiFlags:        parseAIFlags(c('battle_ai.h')),
        natures:        parseNatures(c('pokemon.h')),
        balls:          parseBalls(c('pokeball.h')),
        types:          parseTypes(c('pokemon.h')),
        trainerClasses: partyMeta.trainerClasses,
        musicTypes:     partyMeta.musicTypes,
    };
}

function loadPokemonGameOptions(projectRootPath) {
    const pokemon = readIfExists(path.join(projectRootPath, 'include', 'constants', 'pokemon.h'));
    const result = {
        abilities: readConstants(projectRootPath, 'abilities.h', /\bABILITY_[A-Z0-9_]+\b/g)
            .filter(value => !/^ABILITY_(?:NUM|COUNT)/.test(value)),
        types: readPrefixedConstants(pokemon, 'TYPE_')
            .filter(value => !/TYPE_(?:NONE|NUMBER_OF_MON_TYPES)/.test(value)),
        eggGroups: readPrefixedConstants(pokemon, 'EGG_GROUP_'),
        growthRates: readPrefixedConstants(pokemon, 'GROWTH_'),
        bodyColors: readPrefixedConstants(pokemon, 'BODY_COLOR_'),
        evolutionMethods: readPrefixedConstants(pokemon, 'EVO_'),
        formChangeMethods: readConstants(projectRootPath, 'form_change_types.h', /\bFORM_CHANGE_[A-Z0-9_]+\b/g),
        species: readConstants(projectRootPath, 'species.h', /\bSPECIES_[A-Z0-9_]+\b/g),
        items: readConstants(projectRootPath, 'items.h', /\bITEM_[A-Z0-9_]+\b/g),
        moves: readConstants(projectRootPath, 'moves.h', /\bMOVE_[A-Z0-9_]+\b/g),
    };
    result.labels = {};
    for (const [key, prefix] of Object.entries({ abilities: 'ABILITY_', species: 'SPECIES_', items: 'ITEM_', moves: 'MOVE_' })) {
        result.labels[key] = Object.fromEntries(result[key].map(value => [value, constantLabel(value, prefix)]));
    }
    return result;
}

function loadAttackOptions(projectRootPath) {
    const include = (...parts) => path.join(projectRootPath, 'include', 'constants', ...parts);
    const pokemon = readIfExists(include('pokemon.h'));
    const battle = readIfExists(include('battle.h'));
    const effects = readIfExists(include('battle_move_effects.h'));
    const contest = readIfExists(include('contest.h'));
    const global = readIfExists(include('global.h'));
    const attackSource = readIfExists(path.join(projectRootPath, 'src', 'data', 'moves_info.h'));
    const result = {
        effect: constantChoices(readPrefixedConstants(effects, 'EFFECT_'), 'EFFECT_'),
        type: constantChoices(readPrefixedConstants(pokemon, 'TYPE_'), 'TYPE_'),
        target: constantChoices(readPrefixedConstants(battle, 'TARGET_'), 'TARGET_'),
        category: constantChoices(readPrefixedConstants(pokemon, 'DAMAGE_CATEGORY_'), 'DAMAGE_CATEGORY_'),
        contestEffect: constantChoices(readPrefixedConstants(contest, 'CONTEST_EFFECT_'), 'CONTEST_EFFECT_'),
        contestCategory: constantChoices(readPrefixedConstants(global, 'CONTEST_CATEGORY_'), 'CONTEST_CATEGORY_'),
        battleAnimScript: constantChoices(readPrefixedConstants(attackSource, 'gBattleAnimMove_'), 'gBattleAnimMove_'),
    };
    const booleans = [{ value: 'FALSE', label: 'False' }, { value: 'TRUE', label: 'True' }];
    for (const field of ATTACK_BOOLEAN_FIELDS) result[field] = booleans;
    return result;
}

/**
 * Build a map of { speciesDisplayName.toLowerCase() → webviewUri } for Pokemon icons.
 * @param {string} graphicsPokemonPath  — fsPath of graphics/pokemon/
 * @param {function} toWebviewUri       — (fsPath: string) => string
 * @returns {Object}
 */
function buildPokemonIconMap(graphicsPokemonPath, toWebviewUri) {
    const map = {};
    if (!fs.existsSync(graphicsPokemonPath)) return map;
    const dirs = fs.readdirSync(graphicsPokemonPath);
    for (const dir of dirs) {
        const iconPath = path.join(graphicsPokemonPath, dir, 'icon.png');
        if (!fs.existsSync(iconPath)) continue;
        map[dir.toLowerCase()] = toWebviewUri(iconPath);
    }
    return map;
}

module.exports = {
    loadGameData,
    loadPokemonGameOptions,
    loadAttackOptions,
    buildPokemonIconMap,
    toDisplayName,
    ATTACK_BOOLEAN_FIELDS,
    readIfExists,
    readConstants,
    readPrefixedConstants,
    constantChoices,
};
