"use strict";

/**
 * Strip C-style block comments from content.
 * @param {string} content
 * @returns {string}
 */
function stripComments(content) {
    return content.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Parse a trainers.party file into an array of trainer objects.
 * @param {string} content
 * @returns {Array}
 */
function parseTrainers(content) {
    const stripped = stripComments(content);
    const trainers = [];
    // Split on === TRAINER_ID === headers
    const sections = stripped.split(/^===\s*(.+?)\s*===/m);
    // sections[0] is preamble, then pairs of [id, body]
    for (let i = 1; i < sections.length - 1; i += 2) {
        const id   = sections[i].trim();
        const body = sections[i + 1];
        const trainer = parseTrainerSection(id, body);
        trainers.push(trainer);
    }
    return trainers;
}

/**
 * @param {string} id
 * @param {string} body
 * @returns {Object}
 */
function parseTrainerSection(id, body) {
    const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const trainer = {
        id,
        name:         '',
        trainerClass: '',
        pic:          '',
        gender:       '',
        music:        '',
        doubleBattle: false,
        battleType:   '',
        mugshotColor: '',
        multiParty:   false,
        aiFlags:      [],
        items:        ['', '', '', ''],
        party:        [],
    };

    let inPokemon = false;
    let currentMon = null;

    for (const line of lines) {
        if (!inPokemon) {
            // Check if this is a trainer field
            const colonIdx = line.indexOf(':');
            if (colonIdx !== -1 && !isPokemonHeaderLine(line)) {
                const key   = line.slice(0, colonIdx).trim();
                const value = line.slice(colonIdx + 1).trim();
                switch (key.toLowerCase()) {
                    case 'name':         trainer.name         = value; break;
                    case 'class':        trainer.trainerClass = value; break;
                    case 'pic':          trainer.pic          = value; break;
                    case 'gender':       trainer.gender       = value; break;
                    case 'music':        trainer.music        = value; break;
                    case 'double battle':trainer.doubleBattle = value.toLowerCase() === 'yes'; break;
                    case 'battle type':  trainer.battleType   = value; break;
                    case 'mugshot':      // fallthrough
                    case 'mugshot color':trainer.mugshotColor = value; break;
                    case 'multi party':  trainer.multiParty   = value; break;
                    case 'ai':
                        trainer.aiFlags = value.split('/').map(f => f.trim()).filter(Boolean);
                        break;
                    case 'items':
                        trainer.items = value.split('/').map(f => f.trim());
                        while (trainer.items.length < 4) trainer.items.push('');
                        break;
                }
            } else if (line.length > 0 && !line.startsWith('-')) {
                // Could be the start of a pokemon entry (species line)
                inPokemon = true;
                currentMon = parsePokemonHeader(line);
            }
        } else if (inPokemon) {
            if (currentMon === null) {
                currentMon = parsePokemonHeader(line);
            } else if (line.startsWith('-')) {
                // Move line
                const move = line.slice(1).trim();
                if (!currentMon.moves) currentMon.moves = [];
                currentMon.moves.push(move);
            } else if (line.toLowerCase().startsWith('shiny:')) {
                currentMon.shiny = line.split(':')[1].trim().toLowerCase() === 'yes';
            } else if (line.toLowerCase().startsWith('gigantamax:')) {
                currentMon.gigantamax = line.split(':')[1].trim().toLowerCase() === 'yes';
            } else if (line.toLowerCase().startsWith('level:')) {
                currentMon.level = parseInt(line.split(':')[1].trim(), 10) || 1;
            } else if (line.toLowerCase().startsWith('nature:')) {
                currentMon.nature = line.split(':')[1].trim();
            } else if (line.toLowerCase().startsWith('ability:')) {
                currentMon.ability = line.split(':')[1].trim();
            } else if (line.toLowerCase().startsWith('ball:')) {
                currentMon.ball = line.split(':')[1].trim();
            } else if (line.toLowerCase().startsWith('friendship:') || line.toLowerCase().startsWith('happiness:')) {
                currentMon.friendship = parseInt(line.split(':')[1].trim(), 10) || 0;
            } else if (line.toLowerCase().startsWith('dynamax level:')) {
                currentMon.dynamaxLevel = parseInt(line.split(':')[1].trim(), 10) || 0;
            } else if (line.toLowerCase().startsWith('tera type:')) {
                currentMon.teraType = line.split(':')[1].trim();
            } else if (line.toLowerCase().startsWith('evs:')) {
                currentMon.evs = parseStatLine(line.split(':')[1].trim());
            } else if (line.toLowerCase().startsWith('ivs:')) {
                currentMon.ivs = parseStatLine(line.split(':')[1].trim());
            } else {
                // New pokemon header — push current, start new
                const colonIdx2 = line.indexOf(':');
                if (!isPokemonHeaderLine(line) && colonIdx2 !== -1) {
                    // This is a trainer field, shouldn't happen after inPokemon — ignore
                } else if (line.length > 0 && !line.startsWith('-')) {
                    if (currentMon) trainer.party.push(finalizeMon(currentMon));
                    currentMon = parsePokemonHeader(line);
                }
            }
        }
    }

    if (currentMon) trainer.party.push(finalizeMon(currentMon));

    return trainer;
}

/**
 * Returns true if the line looks like a Pokemon species line rather than a trainer field.
 * @param {string} line
 */
function isPokemonHeaderLine(line) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return true; // No colon = definitely pokemon header
    // If line has "(" before the colon, it's a pokemon with nickname  e.g. "Nickname (Species)"
    const parenIdx = line.indexOf('(');
    if (parenIdx !== -1 && parenIdx < colonIdx) return true;
    // Known trainer field keys
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const trainerKeys = ['name','class','pic','gender','music','battle type','double battle','mugshot','mugshot color','multi party','ai','items','level','nature','ability','ball','friendship','happiness','dynamax level','tera type','evs','ivs','shiny','gigantamax'];
    return !trainerKeys.includes(key);
}

/**
 * Parse a stat line like "252 HP / 4 Atk / 252 Spe"
 * @param {string} str
 * @returns {Object}
 */
function parseStatLine(str) {
    const stats = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    const parts = str.split('/');
    for (const part of parts) {
        const m = part.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const val  = parseInt(m[1], 10);
        const stat = m[2].trim().toLowerCase();
        if (stat === 'hp')                          stats.hp  = val;
        else if (stat === 'atk' || stat === 'attack')    stats.atk = val;
        else if (stat === 'def' || stat === 'defense')   stats.def = val;
        else if (stat === 'spa' || stat === 'sp. atk')   stats.spa = val;
        else if (stat === 'spd' || stat === 'sp. def')   stats.spd = val;
        else if (stat === 'spe' || stat === 'speed')     stats.spe = val;
    }
    return stats;
}

/**
 * Parse a Showdown-format pokemon header line.
 * Format: [Nickname (]Species[)] [(M|F)] [@ Item]
 * @param {string} line
 * @returns {Object}
 */
function parsePokemonHeader(line) {
    const mon = {
        species: '', nickname: '', gender: '', heldItem: '',
        level: 50, nature: '', ability: '', ball: 'Poke', friendship: 0,
        shiny: false, gigantamax: false, dynamaxLevel: 0, teraType: '',
        evs: { hp:0, atk:0, def:0, spa:0, spd:0, spe:0 },
        ivs: { hp:31,atk:31,def:31,spa:31,spd:31,spe:31 },
        moves: [],
    };

    let rest = line;

    // Extract @ held item
    const atIdx = rest.indexOf(' @ ');
    if (atIdx !== -1) {
        mon.heldItem = rest.slice(atIdx + 3).trim();
        rest = rest.slice(0, atIdx).trim();
    }

    // Extract gender (M) or (F) at end
    const genderM = rest.match(/\(([MF])\)\s*$/);
    if (genderM) {
        mon.gender = genderM[1];
        rest = rest.slice(0, rest.lastIndexOf(`(${genderM[1]})`)).trim();
    }

    // Extract species from parens (nickname format)
    const speciesMatch = rest.match(/^(.+?)\s*\(([^MF][^)]*)\)\s*$/);
    if (speciesMatch) {
        mon.nickname = speciesMatch[1].trim();
        mon.species  = speciesMatch[2].trim();
    } else {
        mon.species = rest.trim();
    }

    return mon;
}

/**
 * @param {Object} mon
 * @returns {Object}
 */
function finalizeMon(mon) {
    if (!mon.moves) mon.moves = [];
    while (mon.moves.length < 4) mon.moves.push('');
    return mon;
}

/**
 * Serialize trainers array back to .party file format.
 * @param {Array} trainers
 * @param {string} originalContent - used to preserve the file header comment
 * @returns {string}
 */
function serializeTrainers(trainers, originalContent) {
    // Preserve the file header (everything before the first === block)
    let header = '';
    const firstSep = originalContent.search(/^===\s*.+?\s*===/m);
    if (firstSep !== -1) {
        header = originalContent.slice(0, firstSep);
    }

    const blocks = trainers.map(t => serializeTrainer(t));
    return header + blocks.join('\n');
}

/**
 * @param {Object} t
 * @returns {string}
 */
function serializeTrainer(t) {
    const lines = [];
    lines.push(`=== ${t.id} ===`);
    if (t.name !== undefined) lines.push(t.name ? `Name: ${t.name}` : 'Name:');
    if (t.trainerClass) lines.push(`Class: ${t.trainerClass}`);
    if (t.pic)          lines.push(`Pic: ${t.pic}`);
    if (t.gender)       lines.push(`Gender: ${t.gender}`);
    if (t.music)        lines.push(`Music: ${t.music}`);
    const items = (t.items || []).filter(Boolean);
    if (items.length > 0) lines.push(`Items: ${items.join(' / ')}`);
    lines.push(`Double Battle: ${t.doubleBattle ? 'Yes' : 'No'}`);
    if (t.aiFlags && t.aiFlags.length > 0) {
        lines.push(`AI: ${t.aiFlags.join(' / ')}`);
    }
    if (t.multiParty)   lines.push(`Multi Party: ${t.multiParty}`);
    if (t.mugshotColor) lines.push(`Mugshot: ${t.mugshotColor}`);

    if (t.party && t.party.length > 0) {
        lines.push('');
        for (const mon of t.party) {
            lines.push(...serializeMon(mon));
            lines.push('');
        }
    } else {
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * @param {Object} mon
 * @returns {string[]}
 */
function serializeMon(mon) {
    const lines = [];

    // Header line
    let header = '';
    if (mon.nickname) {
        header = `${mon.nickname} (${mon.species})`;
    } else {
        header = mon.species;
    }
    if (mon.gender === 'M' || mon.gender === 'F') {
        header += ` (${mon.gender})`;
    }
    if (mon.heldItem) {
        header += ` @ ${mon.heldItem}`;
    }
    lines.push(header);

    lines.push(`Level: ${mon.level || 50}`);
    if (mon.nature)                     lines.push(`Nature: ${mon.nature}`);
    if (mon.ability)                    lines.push(`Ability: ${mon.ability}`);
    if (mon.ball && mon.ball !== 'Poke')lines.push(`Ball: ${mon.ball}`);
    if (mon.friendship)                 lines.push(`Friendship: ${mon.friendship}`);
    if (mon.shiny)                      lines.push('Shiny: Yes');
    if (mon.gigantamax)                 lines.push('Gigantamax: Yes');
    if (mon.dynamaxLevel)               lines.push(`Dynamax Level: ${mon.dynamaxLevel}`);
    if (mon.teraType)                   lines.push(`Tera Type: ${mon.teraType}`);

    // EVs
    if (mon.evs) {
        const evParts = [];
        if (mon.evs.hp)  evParts.push(`${mon.evs.hp} HP`);
        if (mon.evs.atk) evParts.push(`${mon.evs.atk} Atk`);
        if (mon.evs.def) evParts.push(`${mon.evs.def} Def`);
        if (mon.evs.spa) evParts.push(`${mon.evs.spa} SpA`);
        if (mon.evs.spd) evParts.push(`${mon.evs.spd} SpD`);
        if (mon.evs.spe) evParts.push(`${mon.evs.spe} Spe`);
        if (evParts.length > 0) lines.push(`EVs: ${evParts.join(' / ')}`);
    }

    // IVs — always write all 6
    if (mon.ivs) {
        const iv = mon.ivs;
        lines.push(`IVs: ${iv.hp} HP / ${iv.atk} Atk / ${iv.def} Def / ${iv.spa} SpA / ${iv.spd} SpD / ${iv.spe} Spe`);
    }

    // Moves
    for (const move of (mon.moves || [])) {
        if (move) lines.push(`- ${move}`);
    }

    return lines;
}

module.exports = { parseTrainers, serializeTrainers };
