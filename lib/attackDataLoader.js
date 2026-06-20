"use strict";

const fs = require('fs');
const path = require('path');

const BOOLEAN_FIELDS = [
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

function read(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function constants(source, prefix) {
    const regex = new RegExp('\\b' + prefix + '[A-Za-z0-9_]+\\b', 'g');
    return [...new Set(source.match(regex) || [])];
}

function label(value, prefix) {
    return value.slice(prefix.length).replace(/_/g, ' ').toLowerCase()
        .replace(/\b\w/g, character => character.toUpperCase());
}

function choices(values, prefix) {
    return values.map(value => ({ value, label: label(value, prefix) }));
}

/** Load finite attack field values from the target project's headers. */
function loadAttackOptions(projectRoot) {
    const include = (...parts) => path.join(projectRoot, 'include', 'constants', ...parts);
    const pokemon = read(include('pokemon.h'));
    const battle = read(include('battle.h'));
    const effects = read(include('battle_move_effects.h'));
    const contest = read(include('contest.h'));
    const global = read(include('global.h'));
    const attackSource = read(path.join(projectRoot, 'src', 'data', 'moves_info.h'));
    const result = {
        effect: choices(constants(effects, 'EFFECT_'), 'EFFECT_'),
        type: choices(constants(pokemon, 'TYPE_'), 'TYPE_'),
        target: choices(constants(battle, 'TARGET_'), 'TARGET_'),
        category: choices(constants(pokemon, 'DAMAGE_CATEGORY_'), 'DAMAGE_CATEGORY_'),
        contestEffect: choices(constants(contest, 'CONTEST_EFFECT_'), 'CONTEST_EFFECT_'),
        contestCategory: choices(constants(global, 'CONTEST_CATEGORY_'), 'CONTEST_CATEGORY_'),
        battleAnimScript: choices(constants(attackSource, 'gBattleAnimMove_'), 'gBattleAnimMove_'),
    };
    const booleans = [{ value: 'FALSE', label: 'False' }, { value: 'TRUE', label: 'True' }];
    for (const field of BOOLEAN_FIELDS) result[field] = booleans;
    return result;
}

module.exports = { BOOLEAN_FIELDS, loadAttackOptions };
