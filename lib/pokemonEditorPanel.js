"use strict";

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { POKEMON_SECTIONS, parsePokemon, applyPokemonEdits } = require('./pokemonParser');
const { parseNamedArrays, applyNamedArrayEdits, findDesignatedInitializer, applyDesignatedInitializerEdits, applyJsonArrayEdits, expressionSymbol, parseEvolutionExpression, parseSpeciesMacros } = require('./pokemonDataParser');
const { toDisplayName } = require('./gameDataLoader');

const openPanels = new Map();

class PokemonEditorPanel {
    static createOrShow(context, projectRoot) {
        const key = projectRoot.fsPath;
        if (openPanels.has(key)) { openPanels.get(key)._panel.reveal(); return; }
        openPanels.set(key, new PokemonEditorPanel(context, projectRoot, key));
    }

    constructor(context, projectRoot, key) {
        this._context = context;
        this._projectRoot = projectRoot;
        this._key = key;
        this._speciesDir = path.join(projectRoot.fsPath, 'src', 'data', 'pokemon', 'species_info');
        this._pokemonDataDir = path.join(projectRoot.fsPath, 'src', 'data', 'pokemon');
        this._graphicsRoot = path.join(projectRoot.fsPath, 'graphics', 'pokemon');
        this._battleEnvironmentRoot = path.join(projectRoot.fsPath, 'graphics', 'battle_environment');
        this._battleInterfaceRoot = path.join(projectRoot.fsPath, 'graphics', 'battle_interface');
        this._pokedexGraphicsRoot = path.join(projectRoot.fsPath, 'graphics', 'pokedex');
        this._criesRoot = path.join(projectRoot.fsPath, 'sound', 'direct_sound_samples', 'cries');
        this._trainerPicsRoot = path.join(projectRoot.fsPath, 'graphics', 'trainers', 'front_pics');
        this._itemIconsRoot = path.join(projectRoot.fsPath, 'graphics', 'items', 'icons');
        this._panel = vscode.window.createWebviewPanel('pokemonEditor', 'Pokemon Editor', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(this._graphicsRoot), vscode.Uri.file(this._battleEnvironmentRoot), vscode.Uri.file(this._battleInterfaceRoot), vscode.Uri.file(this._pokedexGraphicsRoot), vscode.Uri.file(this._criesRoot), vscode.Uri.file(this._trainerPicsRoot), vscode.Uri.file(this._itemIconsRoot)],
        });
        this._panel.onDidDispose(() => openPanels.delete(key));
        this._panel.webview.onDidReceiveMessage(message => {
            if (message.type === 'save') this._savePokemon(message.edits || {}, message.selectedPokemonId);
            if (message.type === 'reload') this._loadAndSendData(message.selectedPokemonId);
            if (message.type === 'ready' && this._pendingInit) {
                this._panel.webview.postMessage(this._pendingInit);
                this._pendingInit = null;
            }
            if (message.type === 'openAsset') this._openAsset(message.relativePath);
            if (message.type === 'replaceAsset') this._replaceAsset(message.relativePath, message.selectedPokemonId);
        });
        this._panel.webview.html = this._getLoadingHtml();
        setTimeout(() => this._loadAndSendData(), 100);
    }

    _speciesFiles() {
        if (!fs.existsSync(this._speciesDir)) throw new Error('Could not find src/data/pokemon/species_info');
        return ['species_info.h'].concat(fs.readdirSync(this._speciesDir).filter(name => /^gen_\d+_families\.h$/.test(name))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    }

    _read(filePath) { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }

    _loadAndSendData(selectedPokemonId) {
        try {
            const pokemon = this._speciesFiles().flatMap(file => {
                const filePath = file === 'species_info.h' ? path.join(this._pokemonDataDir, file) : path.join(this._speciesDir, file);
                return parsePokemon(this._read(filePath), file);
            });
            const graphicsIndex = this._buildGraphicsIndex();
            const eggSource = this._read(path.join(this._pokemonDataDir, 'egg_moves.h'));
            const formsSource = this._read(path.join(this._pokemonDataDir, 'form_species_tables.h'));
            const changesSource = this._read(path.join(this._pokemonDataDir, 'form_change_tables.h'));
            const learnablesSource = this._read(path.join(this._pokemonDataDir, 'all_learnables.json'));
            const learnables = JSON.parse(learnablesSource);
            const battleEnvironments = this._battleEnvironments();
            const gameOptions = this._gameOptions();
            const pokemonConfig = this._read(path.join(this._projectRoot.fsPath, 'include', 'config', 'pokemon.h'));
            const gbaStyleMatch = pokemonConfig.match(/^\s*#define\s+P_GBA_STYLE_SPECIES_GFX\s+(TRUE|FALSE|[01])\b/m);
            const previewConfig = { gbaStyleSpeciesGfx: gbaStyleMatch ? /^(?:TRUE|1)$/.test(gbaStyleMatch[1]) : false };
            const shadowPath = path.join(this._battleInterfaceRoot, 'enemy_mon_shadows_sized.png');
            const trainerPath = path.join(this._trainerPicsRoot, 'brendan.png');
            const battleShadowUri = fs.existsSync(shadowPath) ? this._panel.webview.asWebviewUri(vscode.Uri.file(shadowPath)).toString() : '';
            const trainerPreviewUri = fs.existsSync(trainerPath) ? this._panel.webview.asWebviewUri(vscode.Uri.file(trainerPath)).toString() : '';
            const webviewAsset = filePath => fs.existsSync(filePath) ? this._panel.webview.asWebviewUri(vscode.Uri.file(filePath)).toString() : '';
            const battleTextbox = {
                tilesUri: webviewAsset(path.join(this._battleInterfaceRoot, 'textbox.png')),
                mapUri: webviewAsset(path.join(this._battleInterfaceRoot, 'textbox_map.bin')),
            };
            const pokedexSizeScreen = {
                tilesUri: webviewAsset(path.join(this._pokedexGraphicsRoot, 'menu.png')),
                mapUri: webviewAsset(path.join(this._pokedexGraphicsRoot, 'size_screen.bin')),
            };
            const itemIconMap = this._itemIconMap();
            const indexes = {
                levels: {},
                egg: parseNamedArrays(eggSource),
                formSpecies: parseNamedArrays(formsSource),
                formChanges: parseNamedArrays(changesSource),
                learnables,
                eggData: this._read(path.join(this._pokemonDataDir, 'egg_data.h')),
            };
            for (let generation = 1; generation <= 9; generation++) {
                const file = path.join('level_up_learnsets', 'gen_' + generation + '.h');
                indexes.levels[generation] = parseNamedArrays(this._read(path.join(this._pokemonDataDir, file)));
            }
            for (const item of pokemon) {
                item.related = this._relatedData(item, indexes);
                item.assets = this._assetsFor(item, graphicsIndex);
                item.cry = this._cryFor(item);
                item.evolutionData = parseEvolutionExpression(item.fields.evolutions.value);
                item.macros = parseSpeciesMacros(item.rawBody);
            }
            this._pendingInit = { type: 'init', pokemon, sections: POKEMON_SECTIONS, battleEnvironments, battleShadowUri, battleTextbox, pokedexSizeScreen, trainerPreviewUri, itemIconMap, gameOptions, previewConfig, selectedPokemonId };
            this._panel.webview.html = this._getHtmlForWebview();
        } catch (error) { this._panel.webview.html = this._getErrorHtml(String(error)); }
    }

    _relatedData(item, indexes) {
        const generation = (item.sourceFile.match(/gen_(\d+)/) || [])[1];
        const levelFile = generation ? path.join('level_up_learnsets', 'gen_' + generation + '.h') : '';
        const levelSymbol = expressionSymbol(item.fields.levelUpLearnset.value, 'LevelUpLearnset');
        const eggSymbol = expressionSymbol(item.fields.eggMoveLearnset.value, 'EggMoveLearnset');
        const formSpeciesSymbol = expressionSymbol(item.fields.formSpeciesIdTable.value, 'FormSpeciesIdTable');
        const formChangeSymbol = expressionSymbol(item.fields.formChangeTable.value, 'FormChangeTable');
        const eggId = expressionSymbol(item.fields.eggId.value, '');
        const teachableSymbol = expressionSymbol(item.fields.teachableLearnset.value, 'TeachableLearnset');
        const teachableStem = teachableSymbol.replace(/^s/, '').replace(/TeachableLearnset$/, '').toLowerCase();
        const learnablesKey = Object.keys(indexes.learnables).find(key => key.replace(/_/g, '').toLowerCase() === teachableStem)
            || item.id.replace(/^SPECIES_/, '');
        const level = indexes.levels[generation]?.[levelSymbol];
        const egg = indexes.egg[eggSymbol];
        const formSpecies = indexes.formSpecies[formSpeciesSymbol];
        const formChanges = indexes.formChanges[formChangeSymbol];
        const teachable = indexes.learnables[learnablesKey];
        return {
            level: level ? { file: levelFile, symbol: levelSymbol, body: level.body } : null,
            egg: egg ? { file: 'egg_moves.h', symbol: eggSymbol, body: egg.body } : null,
            formSpecies: formSpecies ? { file: 'form_species_tables.h', symbol: formSpeciesSymbol, body: formSpecies.body } : null,
            formChanges: formChanges ? { file: 'form_change_tables.h', symbol: formChangeSymbol, body: formChanges.body } : null,
            teachable: teachable ? { file: 'all_learnables.json', key: learnablesKey, values: teachable } : null,
            eggData: findDesignatedInitializer(indexes.eggData, eggId)
                ? { file: 'egg_data.h', id: eggId, body: findDesignatedInitializer(indexes.eggData, eggId).body, mode: 'initializer' }
                : null,
        };
    }

    _buildGraphicsIndex() {
        const source = this._read(path.join(this._projectRoot.fsPath, 'src', 'data', 'graphics', 'pokemon.h'));
        const index = {}, re = /\b(g[A-Za-z0-9_]+)\s*\[\]\s*=.*?"(graphics\/pokemon\/[^"\r\n]+\.(?:png|pal))"/g;
        let match;
        while ((match = re.exec(source)) !== null) (index[match[1]] ||= []).push(match[2]);
        const followers = this._read(path.join(this._projectRoot.fsPath, 'src', 'data', 'object_events', 'object_event_pic_tables_followers.h'));
        const aliases = {}, aliasRe = /\bstatic\s+const\s+struct\s+SpriteFrameImage\s+(sPicTable_[A-Za-z0-9_]+)\s*\[\]\s*=\s*\{([\s\S]*?)\};/g;
        while ((match = aliasRe.exec(followers)) !== null) {
            const symbols = [...match[2].matchAll(/\b(gObjectEventPic_[A-Za-z0-9_]+)\b/g)].map(item => item[1]);
            if (symbols.length) aliases[match[1]] = [...new Set(symbols)];
        }
        index.__aliases = aliases;
        return index;
    }

    _battleEnvironments() {
        if (!fs.existsSync(this._battleEnvironmentRoot)) return [];
        const labels = { tall_grass: 'Grass', long_grass: 'Long Grass', sand: 'Sand', underwater: 'Underwater', water: 'Water', pond_water: 'Pond', rock: 'Mountain / Rock', cave: 'Cave', building: 'Building', stadium: 'Stadium', sky: 'Sky' };
        const environments = [];
        for (const directory of fs.readdirSync(this._battleEnvironmentRoot)) {
            const tiles = path.join(this._battleEnvironmentRoot, directory, 'tiles.png');
            const map = path.join(this._battleEnvironmentRoot, directory, 'map.bin');
            if (!fs.existsSync(tiles) || !fs.existsSync(map)) continue;
            environments.push({
                id: directory,
                label: labels[directory] || directory.replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase()),
                tilesUri: this._panel.webview.asWebviewUri(vscode.Uri.file(tiles)).toString(),
                mapUri: this._panel.webview.asWebviewUri(vscode.Uri.file(map)).toString(),
            });
        }
        return environments;
    }

    _gameOptions() {
        const constants = file => this._read(path.join(this._projectRoot.fsPath, 'include', 'constants', file));
        const unique = (source, pattern) => [...new Set([...source.matchAll(pattern)].map(match => match[0]))];
        const pokemon = constants('pokemon.h');
        const result = {
            abilities: unique(constants('abilities.h'), /\bABILITY_[A-Z0-9_]+\b/g).filter(value => !/^ABILITY_(?:NUM|COUNT)/.test(value)),
            types: unique(pokemon, /\bTYPE_[A-Z0-9_]+\b/g).filter(value => !/TYPE_(?:NONE|NUMBER_OF_MON_TYPES)/.test(value)),
            eggGroups: unique(pokemon, /\bEGG_GROUP_[A-Z0-9_]+\b/g),
            growthRates: unique(pokemon, /\bGROWTH_[A-Z0-9_]+\b/g),
            bodyColors: unique(pokemon, /\bBODY_COLOR_[A-Z0-9_]+\b/g),
            evolutionMethods: unique(pokemon, /\bEVO_[A-Z0-9_]+\b/g),
            formChangeMethods: unique(constants('form_change_types.h'), /\bFORM_CHANGE_[A-Z0-9_]+\b/g),
            species: unique(constants('species.h'), /\bSPECIES_[A-Z0-9_]+\b/g),
            items: unique(constants('items.h'), /\bITEM_[A-Z0-9_]+\b/g),
            moves: unique(constants('moves.h'), /\bMOVE_[A-Z0-9_]+\b/g),
        };
        result.labels = {};
        for (const [key, prefix] of Object.entries({ abilities: 'ABILITY_', species: 'SPECIES_', items: 'ITEM_', moves: 'MOVE_' })) {
            result.labels[key] = Object.fromEntries(result[key].map(value => [value, toDisplayName(value.replace(prefix, ''))]));
        }
        return result;
    }

    _itemIconMap() {
        const map = {};
        if (!fs.existsSync(this._itemIconsRoot)) return map;
        for (const entry of fs.readdirSync(this._itemIconsRoot)) {
            if (!entry.toLowerCase().endsWith('.png')) continue;
            const key = entry.slice(0, -4).toLowerCase().replace(/[^a-z0-9]/g, '');
            map[key] = this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(this._itemIconsRoot, entry))).toString();
        }
        return map;
    }

    _cryFor(item) {
        const match = String(item.fields.cryId.value || '').match(/\bCRY_([A-Za-z0-9_]+)/);
        if (!match || match[1] === 'NONE') return null;
        const filePath = path.join(this._criesRoot, match[1].toLowerCase() + '.wav');
        if (!fs.existsSync(filePath)) return null;
        return { name: path.basename(filePath), uri: this._panel.webview.asWebviewUri(vscode.Uri.file(filePath)).toString() };
    }

    _assetsFor(item, index) {
        const assetPaths = new Set();
        const directories = new Set();
        const symbols = new Set(String(item.rawBody || '').match(/\b(?:g[A-Za-z0-9_]+|sPicTable_[A-Za-z0-9_]+)\b/g) || []);
        for (const match of String(item.rawBody || '').matchAll(/\bFOOTPRINT\(\s*([A-Za-z0-9_]+)\s*\)/g)) symbols.add('gMonFootprint_' + match[1]);
        const addSymbol = (symbol, visited = new Set()) => {
            if (!symbol || visited.has(symbol)) return;
            visited.add(symbol);
            for (const alias of index.__aliases?.[symbol] || []) addSymbol(alias, visited);
            for (const relative of index[symbol] || []) {
                assetPaths.add(relative);
                directories.add(path.posix.dirname(relative));
            }
        };
        for (const symbol of symbols) addSymbol(symbol);
        const assets = [];
        const addAsset = relativePath => {
            const absolutePath = path.join(this._projectRoot.fsPath, ...relativePath.split('/'));
            if (!fs.existsSync(absolutePath)) return;
            const name = path.basename(relativePath);
            const dimensions = name.toLowerCase().endsWith('.png') ? pngDimensions(absolutePath) : null;
            assets.push({ name, relativePath, uri: this._panel.webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString(), image: !!dimensions, dimensions });
        };
        for (const relativePath of assetPaths) addAsset(relativePath);
        if (!assets.length) {
            const stem = item.id.replace(/^SPECIES_/, '').toLowerCase(), direct = 'graphics/pokemon/' + stem;
            if (fs.existsSync(path.join(this._projectRoot.fsPath, ...direct.split('/')))) directories.add(direct);
            const parts = stem.split('_');
            for (let split = 1; !directories.size && split < parts.length; split++) {
                const base = 'graphics/pokemon/' + parts.slice(0, split).join('_');
                if (!fs.existsSync(path.join(this._projectRoot.fsPath, ...base.split('/')))) continue;
                const variant = base + '/' + parts.slice(split).join('_');
                directories.add(fs.existsSync(path.join(this._projectRoot.fsPath, ...variant.split('/'))) ? variant : base);
            }
            for (const relativeDir of directories) {
                const absoluteDir = path.join(this._projectRoot.fsPath, ...relativeDir.split('/'));
                if (!fs.existsSync(absoluteDir)) continue;
                for (const name of fs.readdirSync(absoluteDir)) {
                    if (!/\.(?:png|pal)$/i.test(name)) continue;
                    addAsset(relativeDir + '/' + name);
                }
            }
        }
        return assets.sort((a, b) => assetOrder(a.name) - assetOrder(b.name) || a.relativePath.localeCompare(b.relativePath));
    }

    _resolveAsset(relativePath) {
        if (typeof relativePath !== 'string' || !relativePath.replace(/\\/g, '/').startsWith('graphics/pokemon/')) throw new Error('Invalid Pokemon asset path');
        const absolute = path.resolve(this._projectRoot.fsPath, ...relativePath.replace(/\\/g, '/').split('/'));
        const graphicsRoot = path.resolve(this._graphicsRoot) + path.sep;
        if (!absolute.startsWith(graphicsRoot) || !fs.existsSync(absolute)) throw new Error('Pokemon asset not found');
        return absolute;
    }

    async _openAsset(relativePath) {
        try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(this._resolveAsset(relativePath))); }
        catch (error) { vscode.window.showErrorMessage('Could not open Pokemon asset: ' + error); }
    }

    async _replaceAsset(relativePath, selectedPokemonId) {
        try {
            const target = this._resolveAsset(relativePath), extension = path.extname(target).slice(1);
            const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Replace Asset', filters: { [extension.toUpperCase() + ' files']: [extension] } });
            if (!picked?.length) return;
            const answer = await vscode.window.showWarningMessage('Replace ' + relativePath + '?', { modal: true }, 'Replace');
            if (answer !== 'Replace') return;
            if (extension.toLowerCase() === 'png') {
                const currentSize = pngDimensions(target), replacementSize = pngDimensions(picked[0].fsPath);
                if (!currentSize || !replacementSize || currentSize.width !== replacementSize.width || currentSize.height !== replacementSize.height) {
                    if (!currentSize) throw new Error('Could not read the current PNG dimensions.');
                    throw new Error('Replacement PNG dimensions must be ' + currentSize.width + 'x' + currentSize.height + '.');
                }
            }
            fs.copyFileSync(picked[0].fsPath, target);
            vscode.window.showInformationMessage('Replaced ' + relativePath + '.');
            this._loadAndSendData(selectedPokemonId);
        } catch (error) { vscode.window.showErrorMessage('Could not replace Pokemon asset: ' + error); }
    }

    _savePokemon(edits, selectedPokemonId) {
        try {
            const outputs = new Map();
            const get = filePath => outputs.has(filePath) ? outputs.get(filePath) : this._read(filePath);
            const set = (filePath, content) => outputs.set(filePath, content);
            const speciesByFile = {};
            for (const [id, edit] of Object.entries(edits)) {
                if (!/^(?:gen_\d+_families\.h|species_info\.h)$/.test(edit.sourceFile || '')) throw new Error('Invalid source file for ' + id);
                const fields = { ...(edit.fields || {}) };
                if (edit.rawBody !== undefined) fields.$rawBody = edit.rawBody;
                if (Object.keys(fields).length) (speciesByFile[edit.sourceFile] ||= {})[id] = fields;
                for (const key of ['level', 'egg', 'formSpecies', 'formChanges', 'eggData']) {
                    const related = edit.related?.[key];
                    if (!related) continue;
                    if (!/^(?:level_up_learnsets\/gen_\d+\.h|egg_moves\.h|egg_data\.h|form_species_tables\.h|form_change_tables\.h)$/.test(related.file)) throw new Error('Invalid related data file');
                    const filePath = path.join(this._pokemonDataDir, ...related.file.split('/'));
                    if (related.mode === 'initializer') set(filePath, applyDesignatedInitializerEdits(get(filePath), { [related.id]: related.body }));
                    else set(filePath, applyNamedArrayEdits(get(filePath), { [related.symbol]: related.body }));
                }
                if (edit.related?.teachable) {
                    const filePath = path.join(this._pokemonDataDir, 'all_learnables.json');
                    set(filePath, applyJsonArrayEdits(get(filePath), { [edit.related.teachable.key]: edit.related.teachable.values }));
                }
            }
            for (const [file, fileEdits] of Object.entries(speciesByFile)) {
                const filePath = file === 'species_info.h' ? path.join(this._pokemonDataDir, file) : path.join(this._speciesDir, file);
                set(filePath, applyPokemonEdits(get(filePath), fileEdits));
            }
            for (const [filePath, content] of outputs) fs.writeFileSync(filePath, content, 'utf8');
            vscode.window.showInformationMessage('Saved Pokemon data successfully.');
            this._loadAndSendData(selectedPokemonId);
        } catch (error) {
            vscode.window.showErrorMessage('Failed to save Pokemon data: ' + error);
            this._panel.webview.postMessage({ type: 'saveError' });
        }
    }

    _getLoadingHtml() { return '<!DOCTYPE html><html><body style="color:var(--vscode-foreground);padding:20px">Loading Pokemon...</body></html>'; }
    _getErrorHtml(message) { return '<!DOCTYPE html><html><body style="color:var(--vscode-errorForeground);padding:20px"><h2>Pokemon Editor</h2><pre>' + escapeHtml(message) + '</pre></body></html>'; }

    _getHtmlForWebview() {
        const nonce = crypto.randomBytes(16).toString('hex');
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';img-src ${this._panel.webview.cspSource} data:;media-src ${this._panel.webview.cspSource};connect-src ${this._panel.webview.cspSource};script-src 'nonce-${nonce}';style-src 'unsafe-inline'"><style>
.ac-wrap{position:relative}.ac-input{width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;padding:3px 6px;font-size:var(--vscode-font-size);font-family:var(--vscode-font-family)}.ac-drop{position:fixed;z-index:99999;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-focusBorder);border-radius:0 0 3px 3px;max-height:200px;overflow-y:auto;display:none}.ac-drop.open{display:block}.ac-opt{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;font-size:12px}.ac-opt:hover,.ac-opt.hi{background:var(--vscode-list-hoverBackground)}.ac-opt img{width:32px;height:32px;image-rendering:pixelated;flex-shrink:0;background:transparent}.ac-opt .ac-ph{width:32px;flex-shrink:0}
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;overflow:hidden;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size) var(--vscode-font-family)}#side{width:270px;min-width:190px;display:flex;flex-direction:column;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}.side-title{padding:10px;font-size:11px;font-weight:700;text-transform:uppercase}.search{padding:0 8px 8px}input,textarea,select{width:100%;padding:5px 7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);font:inherit;font-family:var(--vscode-editor-font-family)}#list{list-style:none;margin:0;padding:0;overflow:auto}.pokemon{display:flex;align-items:center;gap:8px;padding:4px 9px;cursor:pointer}.pokemon:hover{background:var(--vscode-list-hoverBackground)}.active{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground)}.icon{width:32px;height:32px;object-fit:contain;image-rendering:pixelated;flex:none}.list-text{min-width:0}.name,.id{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.id{font-size:10px;opacity:.7}#main{flex:1;display:flex;overflow:hidden;min-width:0}#empty{margin:auto;color:var(--vscode-descriptionForeground)}#editor{display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0}.bar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;position:relative;z-index:3;background:var(--vscode-editor-background)}.title-icon{width:48px;height:48px;object-fit:contain;image-rendering:pixelated}.heading{margin-right:auto}.heading h1{font-size:18px;margin:0}.status{color:var(--vscode-descriptionForeground)}button{padding:5px 11px;border:0;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}#tabs{display:flex;overflow-x:auto;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-shrink:0;position:relative;z-index:3}.tab{padding:8px 12px;background:transparent;color:var(--vscode-foreground);border-bottom:2px solid transparent;white-space:nowrap;flex-shrink:0}.tab.active-tab{border-bottom-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground)}#body{padding:14px;overflow:auto;flex:1;min-height:0;position:relative;z-index:1}.section{border:1px solid var(--vscode-panel-border);margin-bottom:12px}.section h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:0;padding:7px 11px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border)}.grid{padding:11px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.field label{display:flex;justify-content:space-between;margin-bottom:4px;font-size:11px;color:var(--vscode-descriptionForeground)}.field small{opacity:.8}.wide{grid-column:1/-1}textarea{min-height:90px;resize:vertical}.source{min-height:260px;white-space:pre;font-size:12px}.notice{color:var(--vscode-descriptionForeground);margin:0 0 12px}.assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-bottom:14px}.asset{border:1px solid var(--vscode-panel-border);padding:8px;display:flex;flex-direction:column;gap:6px}.preview-wrap{height:130px;display:flex;align-items:center;justify-content:center;background:var(--vscode-editor-inactiveSelectionBackground);overflow:auto}.preview{width:100%;height:120px;object-fit:contain;image-rendering:pixelated}.asset-name{font-weight:600;word-break:break-all}.asset-meta{font-size:10px;color:var(--vscode-descriptionForeground);word-break:break-all}.asset-actions{display:flex;gap:6px}.asset-actions button{flex:1}.cry-player{display:flex;align-items:center;gap:10px;padding:10px;margin-bottom:12px;border:1px solid var(--vscode-panel-border)}.cry-player audio{flex:1;min-width:180px}.missing{padding:12px;color:var(--vscode-descriptionForeground)}.row-editor{padding:10px}.edit-row{display:grid;grid-template-columns:100px minmax(180px,1fr) minmax(180px,1fr) 34px;gap:7px;margin-bottom:6px;align-items:center}.edit-row.evolution{grid-template-columns:minmax(150px,1fr) minmax(120px,1fr) minmax(170px,1fr) minmax(140px,1fr) 34px}.edit-row button{padding:5px;color:var(--vscode-errorForeground);background:var(--vscode-button-secondaryBackground)}.add-row{margin-top:5px}.battle-layout{padding:12px;display:grid;grid-template-columns:minmax(360px,1fr) minmax(280px,1fr);gap:16px}.battle-preview-column{min-width:0}.environment-select{margin-bottom:8px}.battlefield{position:relative;width:100%;aspect-ratio:3/2;overflow:hidden;border:1px solid var(--vscode-panel-border);background:#000}.battle-canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated}.battle-sprite{position:absolute;z-index:2;width:26.667%;height:40%;object-fit:contain;image-rendering:pixelated;transform:translate(-50%,-50%)}.front-battle-sprite{left:73.333%}.back-battle-sprite{left:30%}.battle-shadow{position:absolute;z-index:1;width:26.667%;height:5%;object-fit:none;object-position:left top;image-rendering:pixelated;transform:translate(-50%,-50%)}.battle-textbox-canvas{z-index:3;pointer-events:none}.battle-controls{display:grid;grid-template-columns:1fr 1fr;gap:9px}.battle-controls .field{min-width:0}.groupbox{border:1px solid var(--vscode-panel-border);margin-bottom:12px;padding:10px}.groupbox legend{padding:0 7px;font-weight:600}.group-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:9px}.dex-layout{display:grid;grid-template-columns:minmax(360px,1fr) minmax(300px,1fr);gap:14px;padding:12px}.dex-screen{position:relative;width:100%;aspect-ratio:3/2;overflow:hidden;background:#000;border:1px solid var(--vscode-panel-border)}.dex-canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated}.dex-mon,.dex-trainer{position:absolute;z-index:1;width:26.667%;height:40%;object-fit:contain;image-rendering:pixelated;transform:translate(-50%,-50%);filter:brightness(0)}.dex-help{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px}@media(max-width:900px){.battle-layout,.dex-layout{grid-template-columns:1fr}.edit-row,.edit-row.evolution{grid-template-columns:1fr}.edit-row button{width:34px}}
</style></head><body><aside id="side"><div class="side-title">Pokemon <span id="count"></span></div><div class="search"><input id="search" placeholder="Search Pokemon..."></div><ul id="list"></ul></aside><main id="main"><div id="empty">Select a Pokemon to edit.</div><section id="editor"><header class="bar"><img id="title-icon" class="title-icon" alt=""><div class="heading"><h1 id="title"></h1><div class="id" id="pokemon-id"></div></div><span class="status" id="status"></span><button class="secondary" id="reload">Reload</button><button id="save">Save</button></header><nav id="tabs"></nav><div id="body"></div></section></main><script nonce="${nonce}">
(function () {
    'use strict';
    var vscode = acquireVsCodeApi();
    var pokemon = [], sections = [], battleEnvironments = [], gameOptions = {}, previewConfig = {}, itemIconMap = {}, battleShadowUri = '', battleTextbox = {}, pokedexSizeScreen = {}, trainerPreviewUri = '', selected = -1, edits = {}, activeTab = 'stats';
    var processCache = {}, pendingCallbacks = {};
    var tabs = [
        ['stats', 'Stats'], ['pokedex', 'Pokedex'], ['training', 'Training / Breeding'], ['battle', 'Battle'],
        ['moves', 'Moves'], ['forms', 'Evolution / Forms'], ['graphics', 'Graphics'], ['advanced', 'Advanced']
    ];

    function byId(id) { return document.getElementById(id); }

    function numericValue(value, fallback) {
        var expression = String(value || '').trim();
        var styleConditional = expression.match(/^P_GBA_STYLE_SPECIES_GFX\\s*\\?\\s*([^:]+)\\s*:\\s*(.+)$/);
        if (styleConditional) expression = previewConfig.gbaStyleSpeciesGfx ? styleConditional[1] : styleConditional[2];
        var number = Number(expression.trim());
        return Number.isFinite(number) ? number : fallback;
    }

    function pngPalette(buffer) {
        var bytes = new Uint8Array(buffer), view = new DataView(buffer), offset = 8;
        while (offset + 8 <= bytes.length) {
            var length = view.getUint32(offset, false); offset += 4;
            var type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]); offset += 4;
            if (type === 'PLTE') {
                var colors = [];
                for (var index = 0; index + 2 < length; index += 3) colors.push([bytes[offset + index], bytes[offset + index + 1], bytes[offset + index + 2]]);
                return colors;
            }
            offset += length + 4;
        }
        return null;
    }

    function jascPalette(text) {
        var lines = String(text || '').split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean);
        if (lines[0] !== 'JASC-PAL') return null;
        var count = Number(lines[2]), colors = [];
        for (var index = 3; index < lines.length && colors.length < count; index++) {
            var parts = lines[index].split(/\\s+/).map(Number);
            if (parts.length >= 3 && parts.every(Number.isFinite)) colors.push(parts.slice(0, 3));
        }
        return colors.length ? colors : null;
    }

    function applyPalette(rawSource, paletteSource, pixels) {
        if (!paletteSource) return Promise.resolve();
        return Promise.all([fetch(rawSource).then(function (response) { return response.arrayBuffer(); }), fetch(paletteSource).then(function (response) { return response.text(); })])
            .then(function (results) {
                var sourcePalette = pngPalette(results[0]), targetPalette = jascPalette(results[1]);
                if (!sourcePalette || !targetPalette) return;
                var colorToIndex = {};
                sourcePalette.forEach(function (color, index) {
                    var key = color[0] + ',' + color[1] + ',' + color[2];
                    if (colorToIndex[key] === undefined) colorToIndex[key] = index;
                });
                for (var offset = 0; offset < pixels.data.length; offset += 4) {
                    var paletteIndex = colorToIndex[pixels.data[offset] + ',' + pixels.data[offset + 1] + ',' + pixels.data[offset + 2]];
                    var target = targetPalette[paletteIndex];
                    if (!target) continue;
                    pixels.data[offset] = target[0]; pixels.data[offset + 1] = target[1]; pixels.data[offset + 2] = target[2];
                }
            });
    }

    function processIcon(rawSource, frameHeight, callback, forceFirstColorTransparent, paletteSource) {
        var cacheKey = rawSource + '|' + frameHeight + '|' + (forceFirstColorTransparent ? 'keyed' : 'normal') + '|' + (paletteSource || '');
        if (processCache[cacheKey]) { callback(processCache[cacheKey]); return; }
        if (pendingCallbacks[cacheKey]) { pendingCallbacks[cacheKey].push(callback); return; }
        pendingCallbacks[cacheKey] = [callback];
        var image = new Image();
        image.onload = function () {
            var width = image.naturalWidth;
            var height = frameHeight > 0 && frameHeight < image.naturalHeight ? frameHeight : image.naturalHeight;
            var canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            var context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            var pixels = context.getImageData(0, 0, width, height), hasAlpha = false;
            for (var ai = 3; ai < pixels.data.length; ai += 4) {
                if (pixels.data[ai] < 255) { hasAlpha = true; break; }
            }
            applyPalette(rawSource, paletteSource, pixels).catch(function () {}).then(function () {
                if (forceFirstColorTransparent || !hasAlpha) {
                    var red = pixels.data[0], green = pixels.data[1], blue = pixels.data[2];
                    for (var pi = 0; pi < pixels.data.length; pi += 4) {
                        if (pixels.data[pi] === red && pixels.data[pi + 1] === green && pixels.data[pi + 2] === blue) pixels.data[pi + 3] = 0;
                    }
                }
                context.putImageData(pixels, 0, 0);
                var result = canvas.toDataURL(), callbacks = pendingCallbacks[cacheKey] || [];
                processCache[cacheKey] = result;
                delete pendingCallbacks[cacheKey];
                callbacks.forEach(function (fn) { fn(result); });
            });
        };
        image.onerror = function () {
            var callbacks = pendingCallbacks[cacheKey] || [];
            delete pendingCallbacks[cacheKey];
            callbacks.forEach(function (fn) { fn(rawSource); });
        };
        image.src = rawSource;
    }

    function renderTilemap(tilesUri, mapUri, canvas, visibleWidth, visibleHeight) {
        if (!tilesUri || !mapUri) return;
        var image = new Image();
        Promise.all([new Promise(function (resolve, reject) { image.onload = resolve; image.onerror = reject; image.src = tilesUri; }), fetch(mapUri).then(function (response) { return response.arrayBuffer(); })])
            .then(function (results) {
                var map = new DataView(results[1]), context = canvas.getContext('2d');
                context.imageSmoothingEnabled = false; context.clearRect(0, 0, canvas.width, canvas.height);
                for (var tileY = 0; tileY < visibleHeight; tileY++) for (var tileX = 0; tileX < visibleWidth; tileX++) {
                    var offset = (tileY * 32 + tileX) * 2;
                    if (offset + 1 >= map.byteLength) continue;
                    var entry = map.getUint16(offset, true), tile = entry & 0x3FF;
                    var sourceX = (tile % 16) * 8, sourceY = Math.floor(tile / 16) * 8;
                    context.save(); context.translate(tileX * 8 + (entry & 0x400 ? 8 : 0), tileY * 8 + (entry & 0x800 ? 8 : 0)); context.scale(entry & 0x400 ? -1 : 1, entry & 0x800 ? -1 : 1);
                    context.drawImage(image, sourceX, sourceY, 8, 8, 0, 0, 8, 8); context.restore();
                }
            });
    }

    function setIconSource(image, rawSource) {
        if (rawSource) processIcon(rawSource, 32, function (result) { image.src = result; });
    }

    function makeAC(wrapEl, list, iconFn, inputId, frameHeight) {
        frameHeight = frameHeight || 0;
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
            var rectangle = input.getBoundingClientRect();
            dropdown.style.left = rectangle.left + 'px';
            dropdown.style.top = rectangle.bottom + 'px';
            dropdown.style.width = rectangle.width + 'px';
        }

        function fill(query) {
            var filtered = query.length === 0
                ? list.slice(0, 60)
                : list.filter(function (name) { return name.toLowerCase().indexOf(query.toLowerCase()) !== -1; }).slice(0, 60);
            dropdown.innerHTML = '';
            highlighted = -1;
            filtered.forEach(function (name) {
                var row = document.createElement('div');
                row.className = 'ac-opt'; row.dataset.val = name;
                if (iconFn) {
                    var rawSource = iconFn(name);
                    if (rawSource) {
                        var iconSize = frameHeight > 0 ? frameHeight : 24;
                        var image = document.createElement('img');
                        image.width = iconSize; image.height = iconSize;
                        processIcon(rawSource, frameHeight, function (result) { image.src = result; });
                        row.appendChild(image);
                    } else {
                        var placeholder = document.createElement('div'); placeholder.className = 'ac-ph';
                        row.appendChild(placeholder);
                    }
                }
                var label = document.createElement('span'); label.textContent = name;
                row.appendChild(label);
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
            if (event.key === 'ArrowDown') {
                event.preventDefault(); highlighted = Math.min(highlighted + 1, options.length - 1);
                options.forEach(function (option, index) { option.classList.toggle('hi', index === highlighted); });
            } else if (event.key === 'ArrowUp') {
                event.preventDefault(); highlighted = Math.max(highlighted - 1, 0);
                options.forEach(function (option, index) { option.classList.toggle('hi', index === highlighted); });
            } else if (event.key === 'Enter' && highlighted >= 0) {
                event.preventDefault(); input.value = options[highlighted].dataset.val;
                dropdown.classList.remove('open'); input.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (event.key === 'Escape') dropdown.classList.remove('open');
        });
        return {
            getValue: function () { return input.value.trim(); },
            setValue: function (value) { input.value = value || ''; },
            getEl: function () { return input; },
        };
    }

    function iconAsset(item) {
        return item.assets.find(function (asset) { return /^icon(?:_gba)?\\.png$/i.test(asset.name); })
            || item.assets.find(function (asset) { return /icon.*\\.png$/i.test(asset.name); });
    }

    function iconKey(name) { return (name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
    function optionLabel(kind, value) { return gameOptions.labels && gameOptions.labels[kind] && gameOptions.labels[kind][value] || value; }
    function optionValue(kind, label) { return (gameOptions[kind] || []).find(function (value) { return optionLabel(kind, value) === label; }) || label; }
    function optionLabels(kind) { return (gameOptions[kind] || []).map(function (value) { return optionLabel(kind, value); }); }
    function getSpeciesIcon(speciesName) { var speciesId = optionValue('species', speciesName), species = pokemon.find(function (item) { return item.id === speciesId; }), asset = species && iconAsset(species); return asset ? asset.uri : null; }
    function getItemIcon(itemName) { var itemId = optionValue('items', itemName); return itemIconMap[iconKey(String(itemId || '').replace(/^ITEM_/, ''))] || null; }

    function renderList() {
        var query = byId('search').value.toLowerCase(), list = byId('list'), shown = 0;
        list.textContent = '';
        pokemon.forEach(function (item, index) {
            if (query && !(item.id + ' ' + item.displayName).toLowerCase().includes(query)) return;
            shown++;
            var row = document.createElement('li'), image = document.createElement('img');
            var text = document.createElement('div'), name = document.createElement('div'), id = document.createElement('div');
            var asset = iconAsset(item);
            row.className = 'pokemon' + (index === selected ? ' active' : '');
            image.className = 'icon'; image.alt = '';
            if (asset) setIconSource(image, asset.uri); else image.style.visibility = 'hidden';
            text.className = 'list-text'; name.className = 'name'; id.className = 'id';
            name.textContent = item.displayName; id.textContent = item.id;
            text.append(name, id); row.append(image, text);
            row.onclick = function () { select(index); };
            list.appendChild(row);
        });
        byId('count').textContent = '(' + shown + ')';
    }

    function staged(item) {
        return edits[item.id] || (edits[item.id] = { sourceFile: item.sourceFile, fields: {}, related: {} });
    }

    function commit() {
        if (selected < 0) return;
        var item = pokemon[selected], edit = staged(item);
        document.querySelectorAll('[data-field]').forEach(function (input) {
            var name = input.dataset.field, value = input.value.trim();
            if (!input.disabled && input.dataset.deleteField === 'true') edit.fields[name] = null;
            else if (!input.disabled && value !== item.fields[name].value) edit.fields[name] = value;
            else delete edit.fields[name];
        });
        var raw = byId('raw-source');
        if (raw) {
            if (raw.value !== item.rawBody) edit.rawBody = raw.value;
            else delete edit.rawBody;
        }
        document.querySelectorAll('[data-related]').forEach(function (input) {
            var key = input.dataset.related, original = item.related[key];
            if (!original) return;
            var next = Object.assign({}, original);
            if (key === 'teachable') next.values = input.value.split(/\\r?\\n/).map(function (value) { return value.trim(); }).filter(Boolean);
            else next.body = input.value;
            if (JSON.stringify(next) !== JSON.stringify(original)) edit.related[key] = next;
            else delete edit.related[key];
        });
        if (!Object.keys(edit.fields).length && !Object.keys(edit.related).length && edit.rawBody === undefined) delete edits[item.id];
        setStatus();
    }

    function select(index) {
        commit();
        selected = index;
        var item = pokemon[index], asset = iconAsset(item), titleIcon = byId('title-icon');
        byId('empty').style.display = 'none'; byId('editor').style.display = 'flex';
        byId('title').textContent = item.displayName;
        byId('pokemon-id').textContent = item.id + ' - ' + item.sourceFile;
        titleIcon.src = '';
        if (asset) setIconSource(titleIcon, asset.uri);
        titleIcon.style.visibility = asset ? 'visible' : 'hidden';
        renderTabs(); renderBody(); renderList(); setStatus();
    }

    function renderTabs() {
        var navigation = byId('tabs'); navigation.textContent = '';
        tabs.forEach(function (tab) {
            var button = document.createElement('button');
            button.className = 'tab' + (tab[0] === activeTab ? ' active-tab' : '');
            button.textContent = tab[1];
            button.onclick = function () { commit(); activeTab = tab[0]; renderTabs(); renderBody(); };
            navigation.appendChild(button);
        });
    }

    function fieldLabel(name) {
        var labels = { baseHP: 'Base HP', baseSpAttack: 'Base Sp. Attack', baseSpDefense: 'Base Sp. Defense', evYield_HP: 'HP EV Yield', evYield_Attack: 'Attack EV Yield', evYield_Defense: 'Defense EV Yield', evYield_SpAttack: 'Sp. Attack EV Yield', evYield_SpDefense: 'Sp. Defense EV Yield', evYield_Speed: 'Speed EV Yield', natDexNum: 'National Dex Number' };
        return labels[name] || name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, function (character) { return character.toUpperCase(); });
    }

    function valueFor(item, name) {
        var edit = edits[item.id];
        return edit && edit.fields[name] !== undefined ? edit.fields[name] : item.fields[name].value;
    }

    function makeSection(item, sectionIndex, excludedFields) {
        var data = sections[sectionIndex], box = document.createElement('section');
        var heading = document.createElement('h2'), grid = document.createElement('div');
        box.className = 'section'; grid.className = 'grid'; heading.textContent = data.title;
        data.fields.forEach(function (name) {
            if ((excludedFields || []).includes(name)) return;
            var field = item.fields[name], wrap = document.createElement('div');
            var label = document.createElement('label'), note = document.createElement('small');
            var multiline = ['description', 'frontAnimFrames', 'evolutions'].includes(name);
            if (name === 'itemCommon' || name === 'itemRare') {
                var hidden = document.createElement('input'), acWrap = document.createElement('div'); wrap.className = 'field'; label.textContent = fieldLabel(name); note.textContent = field.conditional ? 'conditional' : (!field.present ? 'not set' : ''); label.appendChild(note); hidden.type = 'hidden'; hidden.dataset.field = name; hidden.value = valueFor(item, name); acWrap.className = 'ac-wrap'; wrap.append(label, hidden, acWrap);
                var autocomplete = makeAC(acWrap, optionLabels('items'), getItemIcon, null, 24); autocomplete.setValue(optionLabel('items', valueFor(item, name))); autocomplete.getEl().disabled = field.conditional; autocomplete.getEl().onchange = function () { hidden.value = optionValue('items', autocomplete.getValue()); commit(); }; grid.appendChild(wrap); return;
            }
            var knownOptions = { bodyColor: gameOptions.bodyColors, growthRate: gameOptions.growthRates, forceTeraType: gameOptions.types };
            var input = multiline ? document.createElement('textarea') : (knownOptions[name] ? optionSelect(knownOptions[name], valueFor(item, name)) : document.createElement('input'));
            wrap.className = 'field' + (['description', 'frontAnimFrames', 'evolutions', 'abilities', 'types', 'eggGroups'].includes(name) ? ' wide' : '');
            label.textContent = fieldLabel(name); note.textContent = field.conditional ? 'conditional' : (!field.present ? 'not set' : '');
            label.appendChild(note); input.dataset.field = name; input.value = valueFor(item, name);
            input.disabled = field.conditional; input.oninput = commit; input.onchange = commit;
            wrap.append(label, input); grid.appendChild(wrap);
        });
        box.append(heading, grid); return box;
    }

    function optionSelect(values, current) {
        var select = document.createElement('select'), options = (values || []).slice();
        if (current && !options.includes(current)) options.unshift(current);
        options.forEach(function (value) { var option = document.createElement('option'); option.value = value; option.textContent = value; select.appendChild(option); });
        select.value = current || options[0] || ''; return select;
    }

    function makeIdentityGroups(item) {
        var fieldset = document.createElement('fieldset'), legend = document.createElement('legend'), grid = document.createElement('div');
        fieldset.className = 'groupbox'; legend.textContent = 'Types and Abilities'; grid.className = 'group-grid'; fieldset.append(legend, grid);
        var typesMatch = valueFor(item, 'types').match(/^MON_TYPES\\(([^,()]+)(?:,\\s*([^()]+))?\\)$/);
        var abilitiesMatch = valueFor(item, 'abilities').match(/^\\{\\s*([^,]+),\\s*([^,]+),\\s*([^}]+)\\}$/);
        function compoundGroup(labelText, fieldName, values, selectedValues, serializer) {
            var wrap = document.createElement('div'), label = document.createElement('label'), hidden = document.createElement('input');
            wrap.className = 'field'; label.textContent = labelText; hidden.type = 'hidden'; hidden.dataset.field = fieldName; hidden.value = valueFor(item, fieldName); wrap.append(label, hidden);
            selectedValues.forEach(function (selected, index) {
                if (fieldName === 'abilities') {
                    var acWrap = document.createElement('div'); acWrap.className = 'ac-wrap'; wrap.appendChild(acWrap);
                    var autocomplete = makeAC(acWrap, optionLabels('abilities'), null, null, 0); autocomplete.setValue(optionLabel('abilities', selected.trim())); autocomplete.getEl().disabled = item.fields[fieldName].conditional;
                    autocomplete.getEl().onchange = function () { selectedValues[index] = optionValue('abilities', autocomplete.getValue()); hidden.value = serializer(selectedValues); commit(); };
                } else {
                    var select = optionSelect(values, selected.trim()); select.disabled = item.fields[fieldName].conditional; select.onchange = function () { selectedValues[index] = select.value; hidden.value = serializer(selectedValues); commit(); }; wrap.appendChild(select);
                }
            });
            grid.appendChild(wrap);
        }
        if (typesMatch) compoundGroup('Primary / Secondary Type', 'types', gameOptions.types, [typesMatch[1], typesMatch[2] || typesMatch[1]], function (values) { return values[0] === values[1] ? 'MON_TYPES(' + values[0] + ')' : 'MON_TYPES(' + values.join(', ') + ')'; });
        else grid.appendChild(makeRawCompound(item, 'types'));
        if (abilitiesMatch) compoundGroup('Ability Slots 1 / 2 / Hidden', 'abilities', gameOptions.abilities, [abilitiesMatch[1], abilitiesMatch[2], abilitiesMatch[3]], function (values) { return '{ ' + values.join(', ') + ' }'; });
        else grid.appendChild(makeRawCompound(item, 'abilities'));
        return fieldset;
    }

    function makeBreedingGroups(item) {
        var match = valueFor(item, 'eggGroups').match(/^MON_EGG_GROUPS\\(([^,()]+)(?:,\\s*([^()]+))?\\)$/);
        if (!match) return makeRawCompound(item, 'eggGroups');
        var fieldset = document.createElement('fieldset'), legend = document.createElement('legend'), grid = document.createElement('div'), hidden = document.createElement('input');
        var values = [match[1].trim(), (match[2] || match[1]).trim()]; fieldset.className = 'groupbox'; legend.textContent = 'Egg Groups'; grid.className = 'group-grid'; hidden.type = 'hidden'; hidden.dataset.field = 'eggGroups'; hidden.value = valueFor(item, 'eggGroups');
        values.forEach(function (value, index) { var select = optionSelect(gameOptions.eggGroups, value); select.disabled = item.fields.eggGroups.conditional; select.onchange = function () { values[index] = select.value; hidden.value = values[0] === values[1] ? 'MON_EGG_GROUPS(' + values[0] + ')' : 'MON_EGG_GROUPS(' + values.join(', ') + ')'; commit(); }; grid.appendChild(select); });
        fieldset.append(legend, hidden, grid); return fieldset;
    }

    function makeRawCompound(item, fieldName) {
        var wrap = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input');
        wrap.className = 'field'; label.textContent = fieldLabel(fieldName); input.dataset.field = fieldName; input.value = valueFor(item, fieldName); input.disabled = item.fields[fieldName].conditional; input.oninput = commit; wrap.append(label, input); return wrap;
    }

    function makePokedexSizePreview(item) {
        var box = document.createElement('section'), heading = document.createElement('h2'), layout = document.createElement('div');
        var screen = document.createElement('div'), canvas = document.createElement('canvas'), mon = document.createElement('img'), trainer = document.createElement('img'), controls = document.createElement('div');
        box.className = 'section'; heading.textContent = 'Pokedex Size Comparison Preview'; layout.className = 'dex-layout'; screen.className = 'dex-screen'; mon.className = 'dex-mon'; trainer.className = 'dex-trainer'; controls.className = 'group-grid';
        canvas.className = 'dex-canvas'; canvas.width = 240; canvas.height = 160;
        var asset = frontAsset(item), palette = paletteAsset(item); if (asset) processIcon(asset.uri, 64, function (source) { mon.src = source; }, true, palette && palette.uri);
        if (trainerPreviewUri) processIcon(trainerPreviewUri, 64, function (source) { trainer.src = source; });
        renderTilemap(pokedexSizeScreen.tilesUri, pokedexSizeScreen.mapUri, canvas, 30, 20);
        screen.append(canvas, mon, trainer);
        var explanations = {
            pokemonScale: 'Used by Task_LoadSizeScreen in pokedex.c and pokedex_plus_hgss.c. Passed to SetOamMatrix for the Pokemon silhouette; 256 is normal, higher is smaller.',
            pokemonOffset: 'Used only on the Pokedex size-comparison screen. Assigned to the Pokemon sprite y2 value; positive values move it down.',
            trainerScale: 'Used by Task_LoadSizeScreen in pokedex.c and pokedex_plus_hgss.c. Passed to SetOamMatrix for the player silhouette; 256 is normal, higher is smaller.',
            trainerOffset: 'Used only on the Pokedex size-comparison screen. Assigned to the trainer sprite y2 value; positive values move it down.'
        };
        ['pokemonScale', 'pokemonOffset', 'trainerScale', 'trainerOffset'].forEach(function (name) {
            var wrap = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input'), help = document.createElement('div');
            wrap.className = 'field'; label.textContent = fieldLabel(name); input.dataset.field = name; input.value = valueFor(item, name); input.disabled = item.fields[name].conditional; help.className = 'dex-help'; help.textContent = explanations[name];
            input.oninput = function () { updatePreview(); commit(); }; wrap.append(label, input, help); controls.appendChild(wrap);
        });
        function updatePreview() {
            var pokemonScale = numericValue(controls.querySelector('[data-field="pokemonScale"]').value, 256) || 256;
            var pokemonOffset = numericValue(controls.querySelector('[data-field="pokemonOffset"]').value, 0);
            var trainerScale = numericValue(controls.querySelector('[data-field="trainerScale"]').value, 256) || 256;
            var trainerOffset = numericValue(controls.querySelector('[data-field="trainerOffset"]').value, 0);
            mon.style.left = (88 / 240 * 100) + '%'; mon.style.top = ((56 + pokemonOffset) / 160 * 100) + '%'; mon.style.width = (64 / 240 * 100 * 256 / pokemonScale) + '%'; mon.style.height = (64 / 160 * 100 * 256 / pokemonScale) + '%';
            trainer.style.left = (152 / 240 * 100) + '%'; trainer.style.top = ((56 + trainerOffset) / 160 * 100) + '%'; trainer.style.width = (64 / 240 * 100 * 256 / trainerScale) + '%'; trainer.style.height = (64 / 160 * 100 * 256 / trainerScale) + '%';
        }
        updatePreview(); layout.append(screen, controls); box.append(heading, layout); return box;
    }

    function relatedBox(item, key, title, help) {
        var value = item.related[key], box = document.createElement('section');
        var heading = document.createElement('h2'), body = document.createElement('div');
        box.className = 'section'; heading.textContent = title; body.className = 'grid';
        if (!value) {
            body.innerHTML = '<div class="missing">No backing table is assigned to this species.</div>';
        } else {
            var wrap = document.createElement('div'), label = document.createElement('label'), area = document.createElement('textarea');
            var edit = edits[item.id] && edits[item.id].related[key];
            wrap.className = 'field wide'; label.textContent = help + ' (' + (value.symbol || value.key || value.id) + ')';
            area.dataset.related = key; area.className = 'source';
            area.value = key === 'teachable' ? (edit ? edit.values : value.values).join('\\n') : (edit ? edit.body : value.body);
            area.oninput = commit; wrap.append(label, area); body.appendChild(wrap);
        }
        box.append(heading, body); return box;
    }

    function relatedValue(item, key) {
        var value = item.related[key], edit = edits[item.id] && edits[item.id].related[key];
        if (!value) return null;
        if (key === 'teachable') return edit ? edit.values.slice() : value.values.slice();
        return edit ? edit.body : value.body;
    }

    function hiddenRelated(item, key, value) {
        var input = document.createElement('textarea');
        input.dataset.related = key; input.value = key === 'teachable' ? value.join('\\n') : value;
        input.style.display = 'none'; return input;
    }

    function makeMoveEditor(item, key, title, kind) {
        var related = item.related[key];
        if (!related) return relatedBox(item, key, title, 'C array body');
        var box = document.createElement('section'), heading = document.createElement('h2'), body = document.createElement('div');
        var current = relatedValue(item, key), hidden = hiddenRelated(item, key, current);
        box.className = 'section'; heading.textContent = title; body.className = 'row-editor'; body.appendChild(hidden);

        function redraw() {
            Array.from(body.querySelectorAll('.edit-row,.add-row')).forEach(function (node) { node.remove(); });
            var lines = kind === 'teachable' ? current.slice() : current.split(/\\r?\\n/);
            var rows = [];
            lines.forEach(function (line, lineIndex) {
                var match = kind === 'level' ? line.match(/^(\\s*)LEVEL_UP_MOVE\\(\\s*([^,]+),\\s*([^)]+)\\),(.*)$/)
                    : kind === 'egg' ? line.match(/^(\\s*)(MOVE_[A-Za-z0-9_]+),(.*)$/) : [line, '', line];
                if (!match || (kind === 'egg' && match[2] === 'MOVE_UNAVAILABLE')) return;
                rows.push({ lineIndex: lineIndex, indent: match[1] || '', first: kind === 'level' ? match[2].trim() : '', move: kind === 'level' ? match[3].trim() : (kind === 'egg' ? match[2] : line), tail: kind === 'level' ? match[4] : (kind === 'egg' ? match[3] : '') });
            });
            rows.forEach(function (row) {
                var element = document.createElement('div'), first = document.createElement('input'), moveWrap = document.createElement('div');
                var remove = document.createElement('button'); moveWrap.className = 'ac-wrap'; var move = makeAC(moveWrap, optionLabels('moves'), null, null, 0); move.setValue(optionLabel('moves', row.move));
                element.className = 'edit-row'; first.value = row.first; remove.textContent = 'X'; remove.title = 'Remove move';
                if (kind === 'level') first.placeholder = 'Level'; else { first.style.display = 'none'; element.style.gridTemplateColumns = 'minmax(180px,1fr) 34px'; }
                function update() {
                    if (kind === 'teachable') current[row.lineIndex] = optionValue('moves', move.getValue());
                    else {
                        var moveValue = optionValue('moves', move.getValue()); lines[row.lineIndex] = row.indent + (kind === 'level' ? 'LEVEL_UP_MOVE(' + first.value.trim() + ', ' + moveValue + '),' + row.tail : moveValue + ',' + row.tail);
                        current = lines.join('\\n');
                    }
                    hidden.value = kind === 'teachable' ? current.join('\\n') : current; commit();
                }
                first.oninput = update; move.getEl().onchange = update;
                remove.onclick = function () {
                    if (kind === 'teachable') current.splice(row.lineIndex, 1);
                    else { lines.splice(row.lineIndex, 1); current = lines.join('\\n'); }
                    hidden.value = kind === 'teachable' ? current.join('\\n') : current; commit(); redraw();
                };
                if (kind === 'level') element.append(first, moveWrap, remove); else element.append(moveWrap, remove);
                body.appendChild(element);
            });
            var add = document.createElement('button'); add.className = 'add-row'; add.textContent = 'Add Move';
            add.onclick = function () {
                if (kind === 'teachable') current.push('MOVE_NONE');
                else {
                    var sourceLines = current.split(/\\r?\\n/), terminator = sourceLines.findIndex(function (line) { return kind === 'level' ? line.includes('LEVEL_UP_END') : line.includes('MOVE_UNAVAILABLE'); });
                    var insertAt = terminator >= 0 ? terminator : sourceLines.length;
                    sourceLines.splice(insertAt, 0, kind === 'level' ? '    LEVEL_UP_MOVE(1, MOVE_NONE),' : '    MOVE_NONE,'); current = sourceLines.join('\\n');
                }
                hidden.value = kind === 'teachable' ? current.join('\\n') : current; commit(); redraw();
            };
            body.appendChild(add);
        }
        redraw(); box.append(heading, body); return box;
    }

    function makeFormSpeciesEditor(item) {
        var related = item.related.formSpecies;
        if (!related) return relatedBox(item, 'formSpecies', 'Form Species Table', 'C array body');
        var box = document.createElement('section'), heading = document.createElement('h2'), body = document.createElement('div'), current = relatedValue(item, 'formSpecies');
        var hidden = hiddenRelated(item, 'formSpecies', current); box.className = 'section'; heading.textContent = 'Form Species'; body.className = 'row-editor'; body.appendChild(hidden);
        function redraw() {
            Array.from(body.querySelectorAll('.edit-row,.add-row')).forEach(function (node) { node.remove(); });
            var lines = current.split(/\\r?\\n/), rows = [];
            lines.forEach(function (line, lineIndex) { var match = line.match(/^(\\s*)(SPECIES_[A-Za-z0-9_]+),(.*)$/); if (match && match[2] !== 'FORM_SPECIES_END') rows.push({ lineIndex: lineIndex, indent: match[1], species: match[2], tail: match[3] }); });
            rows.forEach(function (entry) {
                var row = document.createElement('div'), image = document.createElement('img'), acWrap = document.createElement('div'), remove = document.createElement('button');
                row.className = 'edit-row'; row.style.gridTemplateColumns = '34px minmax(220px,1fr) 34px'; image.className = 'icon'; remove.textContent = 'X';
                acWrap.className = 'ac-wrap'; var autocomplete = makeAC(acWrap, optionLabels('species'), getSpeciesIcon, null, 32); autocomplete.setValue(optionLabel('species', entry.species));
                function refreshImage() { var icon = getSpeciesIcon(autocomplete.getValue()); image.src = ''; image.style.visibility = icon ? 'visible' : 'hidden'; if (icon) setIconSource(image, icon); }
                autocomplete.getEl().onchange = function () { lines[entry.lineIndex] = entry.indent + optionValue('species', autocomplete.getValue()) + ',' + entry.tail; current = lines.join('\\n'); hidden.value = current; refreshImage(); commit(); };
                remove.onclick = function () { lines.splice(entry.lineIndex, 1); current = lines.join('\\n'); hidden.value = current; commit(); redraw(); };
                refreshImage(); row.append(image, acWrap, remove); body.appendChild(row);
            });
            var add = document.createElement('button'); add.className = 'add-row'; add.textContent = 'Add Form'; add.onclick = function () { var lines = current.split(/\\r?\\n/), end = lines.findIndex(function (line) { return line.includes('FORM_SPECIES_END'); }); lines.splice(end >= 0 ? end : lines.length, 0, '    SPECIES_NONE,'); current = lines.join('\\n'); hidden.value = current; commit(); redraw(); }; body.appendChild(add);
        }
        redraw(); box.append(heading, body); return box;
    }

    function makeFormChangeEditor(item) {
        var related = item.related.formChanges;
        if (!related) return relatedBox(item, 'formChanges', 'Form Change Table', 'C array body');
        var original = relatedValue(item, 'formChanges'), box = document.createElement('section'), heading = document.createElement('h2'), body = document.createElement('div');
        var hidden = hiddenRelated(item, 'formChanges', original), entries = [], depth = 0, start = -1, quote = '';
        box.className = 'section'; heading.textContent = 'Form Changes'; body.className = 'row-editor'; body.appendChild(hidden);
        for (var index = 0; index < original.length; index++) {
            var character = original[index];
            if (quote) { if (character === '\\\\') index++; else if (character === quote) quote = ''; continue; }
            if (character === '"' || character === "'") { quote = character; continue; }
            if (character === '{') { if (depth === 0) start = index; depth++; }
            else if (character === '}' && --depth === 0 && start >= 0) {
                var parts = splitTopLevel(original.slice(start + 1, index));
                if (parts[0] && parts[0] !== 'FORM_CHANGE_TERMINATOR') entries.push({ start: start, end: index + 1, method: parts[0], target: parts[1] || 'SPECIES_NONE', parameter: parts[2] || '', extra: parts.slice(3).join(', ') });
                start = -1;
            }
        }
        function update() {
            var changed = original;
            entries.slice().reverse().forEach(function (entry) { var replacement = '{' + [entry.method, entry.target].concat(entry.parameter ? [entry.parameter] : []).concat(entry.extra ? [entry.extra] : []).join(', ') + '}'; changed = changed.slice(0, entry.start) + replacement + changed.slice(entry.end); });
            hidden.value = changed; commit();
        }
        entries.forEach(function (entry) {
            var row = document.createElement('div'), image = document.createElement('img'), method = optionSelect(gameOptions.formChangeMethods, entry.method), targetWrap = document.createElement('div'), extra = document.createElement('input');
            row.className = 'edit-row evolution'; row.style.gridTemplateColumns = '34px minmax(180px,1fr) minmax(190px,1fr) minmax(160px,1fr) minmax(160px,1fr)'; image.className = 'icon'; extra.value = entry.extra; extra.placeholder = 'Extra';
            targetWrap.className = 'ac-wrap'; var target = makeAC(targetWrap, optionLabels('species'), getSpeciesIcon, null, 32); target.setValue(optionLabel('species', entry.target));
            var parameterWrap, parameter;
            if (entry.parameter.startsWith('ITEM_')) { parameterWrap = document.createElement('div'); parameterWrap.className = 'ac-wrap'; parameter = makeAC(parameterWrap, optionLabels('items'), getItemIcon, null, 24); parameter.setValue(optionLabel('items', entry.parameter)); }
            else { parameterWrap = document.createElement('input'); parameterWrap.value = entry.parameter; parameterWrap.placeholder = 'Parameter'; parameter = { getValue: function () { return parameterWrap.value.trim(); }, getEl: function () { return parameterWrap; } }; }
            function refreshImage() { var icon = getSpeciesIcon(target.getValue()); image.src = ''; image.style.visibility = icon ? 'visible' : 'hidden'; if (icon) setIconSource(image, icon); }
            method.onchange = function () { entry.method = method.value; update(); }; target.getEl().onchange = function () { entry.target = optionValue('species', target.getValue()); refreshImage(); update(); }; parameter.getEl().oninput = parameter.getEl().onchange = function () { entry.parameter = entry.parameter.startsWith('ITEM_') ? optionValue('items', parameter.getValue()) : parameter.getValue(); update(); }; extra.oninput = function () { entry.extra = extra.value.trim(); update(); };
            refreshImage(); row.append(image, method, targetWrap, parameterWrap, extra); body.appendChild(row);
        });
        var note = document.createElement('p'); note.className = 'notice'; note.textContent = 'Conditional directives and terminators are preserved. Use Advanced for structural changes to this table.'; body.appendChild(note);
        box.append(heading, body); return box;
    }

    function splitTopLevel(value) {
        var result = [], start = 0, parens = 0, braces = 0, brackets = 0, quote = '';
        for (var index = 0; index < value.length; index++) {
            var character = value[index];
            if (quote) { if (character === '\\\\') index++; else if (character === quote) quote = ''; continue; }
            if (character === '"' || character === "'") { quote = character; continue; }
            if (character === '(') parens++; else if (character === ')') parens--;
            else if (character === '{') braces++; else if (character === '}') braces--;
            else if (character === '[') brackets++; else if (character === ']') brackets--;
            else if (character === ',' && parens === 0 && braces === 0 && brackets === 0) { result.push(value.slice(start, index).trim()); start = index + 1; }
        }
        if (value.slice(start).trim()) result.push(value.slice(start).trim());
        return result;
    }

    function makeEvolutionEditor(item) {
        var value = valueFor(item, 'evolutions'), field = item.fields.evolutions;
        var match = value.match(/^EVOLUTION\\(([\\s\\S]*)\\)$/), box = document.createElement('section');
        var heading = document.createElement('h2'), body = document.createElement('div');
        box.className = 'section'; heading.textContent = 'Evolution Editor'; body.className = 'row-editor';
        if ((!match && value.trim()) || field.conditional) {
            var fallback = document.createElement('textarea'); fallback.dataset.field = 'evolutions'; fallback.className = 'source'; fallback.value = value; fallback.disabled = field.conditional; fallback.oninput = commit;
            body.appendChild(fallback); box.append(heading, body); return box;
        }
        var parsedEvolution = value === item.fields.evolutions.value ? item.evolutionData : null;
        var originalInner = parsedEvolution ? parsedEvolution.inner : (match ? match[1] : '');
        var hasDirectives = parsedEvolution ? parsedEvolution.hasDirectives : /^\\s*#/m.test(originalInner);
        var entries = parsedEvolution ? parsedEvolution.entries.map(function (entry) { return Object.assign({}, entry); }) : [];
        var depth = 0, entryStart = -1, quote = '';
        for (var index = 0; !parsedEvolution && index < originalInner.length; index++) {
            var character = originalInner[index];
            if (quote) { if (character === '\\\\') index++; else if (character === quote) quote = ''; continue; }
            if (character === '"' || character === "'") { quote = character; continue; }
            if (character === '{') { if (depth === 0) entryStart = index; depth++; }
            else if (character === '}' && --depth === 0 && entryStart >= 0) {
                var raw = originalInner.slice(entryStart, index + 1), parts = splitTopLevel(raw.slice(1, -1));
                entries.push({ start: entryStart, end: index + 1, method: parts[0] || 'EVO_LEVEL', parameter: parts[1] || '1', target: parts[2] || 'SPECIES_NONE', extra: parts.slice(3).join(', ') });
                entryStart = -1;
            }
        }
        var hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.dataset.field = 'evolutions'; body.appendChild(hidden);
        function update() {
            hidden.dataset.deleteField = entries.length ? 'false' : (field.present ? 'true' : 'false');
            if (hasDirectives) {
                var updated = originalInner;
                entries.slice().reverse().forEach(function (entry) {
                    var replacement = '{' + [entry.method, entry.parameter, entry.target].concat(entry.extra ? [entry.extra] : []).join(', ') + '}';
                    updated = updated.slice(0, entry.start) + replacement + updated.slice(entry.end);
                });
                hidden.value = 'EVOLUTION(' + updated + ')';
            } else {
                hidden.value = entries.length ? 'EVOLUTION(' + entries.map(function (entry) { return '{' + [entry.method, entry.parameter, entry.target].concat(entry.extra ? [entry.extra] : []).join(', ') + '}'; }).join(', ') + ')' : '';
            }
            commit();
        }
        function redraw() {
            Array.from(body.querySelectorAll('.edit-row,.add-row')).forEach(function (node) { node.remove(); });
            entries.forEach(function (entry, entryIndex) {
                var row = document.createElement('div'), targetImage = document.createElement('img'); row.className = 'edit-row evolution'; row.style.gridTemplateColumns = '34px minmax(150px,1fr) minmax(120px,1fr) minmax(170px,1fr) minmax(140px,1fr) 34px'; targetImage.className = 'icon'; targetImage.alt = '';
                function updateTargetImage() { var target = pokemon.find(function (candidate) { return candidate.id === entry.target; }), icon = target && iconAsset(target); targetImage.src = ''; targetImage.style.visibility = icon ? 'visible' : 'hidden'; if (icon) setIconSource(targetImage, icon.uri); }
                row.appendChild(targetImage);
                var method = optionSelect(gameOptions.evolutionMethods, entry.method); method.onchange = function () { entry.method = method.value; update(); redraw(); }; row.appendChild(method);
                if (entry.method.includes('ITEM')) {
                    var parameterWrap = document.createElement('div'); parameterWrap.className = 'ac-wrap'; row.appendChild(parameterWrap); var parameterAC = makeAC(parameterWrap, optionLabels('items'), getItemIcon, null, 24); parameterAC.setValue(optionLabel('items', entry.parameter)); parameterAC.getEl().onchange = function () { entry.parameter = optionValue('items', parameterAC.getValue()); update(); };
                } else {
                    var parameter = document.createElement('input'); parameter.value = entry.parameter; parameter.placeholder = 'Parameter'; parameter.oninput = function () { entry.parameter = parameter.value.trim(); update(); }; row.appendChild(parameter);
                }
                var targetWrap = document.createElement('div'); targetWrap.className = 'ac-wrap'; row.appendChild(targetWrap); var targetAC = makeAC(targetWrap, optionLabels('species'), getSpeciesIcon, null, 32); targetAC.setValue(optionLabel('species', entry.target)); targetAC.getEl().onchange = function () { entry.target = optionValue('species', targetAC.getValue()); updateTargetImage(); update(); };
                var extra = document.createElement('input'); extra.value = entry.extra; extra.placeholder = 'Conditions / Extra'; extra.oninput = function () { entry.extra = extra.value.trim(); update(); }; row.appendChild(extra); updateTargetImage();
                var remove = document.createElement('button'); remove.textContent = 'X'; remove.disabled = hasDirectives; remove.title = hasDirectives ? 'Use Advanced to remove conditional evolutions' : 'Remove evolution'; remove.onclick = function () { entries.splice(entryIndex, 1); update(); redraw(); }; row.appendChild(remove); body.appendChild(row);
            });
            if (hasDirectives) {
                var note = document.createElement('p'); note.className = 'notice add-row'; note.textContent = 'Conditional branches are preserved. Edit their rows here; use Advanced to add or remove #if branches.'; body.appendChild(note);
            } else {
                var add = document.createElement('button'); add.className = 'add-row'; add.textContent = 'Add Evolution'; add.onclick = function () { entries.push({ method: 'EVO_LEVEL', parameter: '1', target: 'SPECIES_NONE', extra: '', start: 0, end: 0 }); update(); redraw(); }; body.appendChild(add);
            }
        }
        hidden.value = value; hidden.dataset.deleteField = 'false'; redraw(); box.append(heading, body); return box;
    }

    function frontAsset(item) {
        return item.assets.find(function (asset) { return /^(?:anim_)?front\\.png$/i.test(asset.name); })
            || item.assets.find(function (asset) { return /front.*\\.png$/i.test(asset.name); });
    }

    function backAsset(item) {
        return item.assets.find(function (asset) { return /^back\\.png$/i.test(asset.name); })
            || item.assets.find(function (asset) { return /back.*\\.png$/i.test(asset.name); });
    }

    function paletteAsset(item) {
        return item.assets.find(function (asset) { return /^normal\\.pal$/i.test(asset.name); });
    }

    function isBattlePicAsset(asset) {
        return /^(?:anim_)?front\\.png$/i.test(asset.name) || /^back\\.png$/i.test(asset.name);
    }

    function makeBattlePreview(item) {
        var box = document.createElement('section'), heading = document.createElement('h2'), layout = document.createElement('div');
        var previewColumn = document.createElement('div'), environmentSelect = document.createElement('select');
        var field = document.createElement('div'), canvas = document.createElement('canvas'), textboxCanvas = document.createElement('canvas'), frontSprite = document.createElement('img'), backSprite = document.createElement('img'), shadow = document.createElement('div'), controls = document.createElement('div');
        box.className = 'section'; heading.textContent = 'Battle Preview and Position'; layout.className = 'battle-layout';
        previewColumn.className = 'battle-preview-column'; environmentSelect.className = 'environment-select';
        field.className = 'battlefield'; canvas.className = 'battle-canvas'; canvas.width = 240; canvas.height = 160; textboxCanvas.className = 'battle-canvas battle-textbox-canvas'; textboxCanvas.width = 240; textboxCanvas.height = 160; frontSprite.className = 'battle-sprite front-battle-sprite'; backSprite.className = 'battle-sprite back-battle-sprite'; shadow.className = 'battle-shadow'; controls.className = 'battle-controls';
        battleEnvironments.forEach(function (environment) { var option = document.createElement('option'); option.value = environment.id; option.textContent = environment.label; environmentSelect.appendChild(option); });
        var asset = frontAsset(item), back = backAsset(item), palette = paletteAsset(item); if (asset) processIcon(asset.uri, 64, function (source) { frontSprite.src = source; }, true, palette && palette.uri); if (back) processIcon(back.uri, 64, function (source) { backSprite.src = source; }, true, palette && palette.uri);
        if (battleShadowUri) processIcon(battleShadowUri, 0, function (source) { shadow.style.backgroundImage = 'url("' + source + '")'; shadow.style.backgroundSize = '100% 400%'; }, true);
        field.append(canvas, shadow, backSprite, frontSprite, textboxCanvas); previewColumn.append(environmentSelect, field);
        if (battleTextbox.tilesUri) processIcon(battleTextbox.tilesUri, 0, function (tilesUri) {
            renderTilemap(tilesUri, battleTextbox.mapUri, textboxCanvas, 30, 20);
        }, true);
        function renderEnvironment(environment) {
            if (!environment) return;
            renderTilemap(environment.tilesUri, environment.mapUri, canvas, 30, 20);
        }
        environmentSelect.onchange = function () { renderEnvironment(battleEnvironments.find(function (environment) { return environment.id === environmentSelect.value; })); };
        if (battleEnvironments.length) { environmentSelect.value = battleEnvironments.some(function (environment) { return environment.id === 'tall_grass'; }) ? 'tall_grass' : battleEnvironments[0].id; environmentSelect.onchange(); }
        ['frontPicYOffset', 'enemyMonElevation', 'frontPicSize', 'backPicYOffset', 'backPicSize'].forEach(function (name) {
            var wrap = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input');
            wrap.className = 'field'; label.textContent = fieldLabel(name); input.dataset.field = name; input.value = valueFor(item, name); input.disabled = item.fields[name].conditional;
            input.oninput = function () { updatePosition(); commit(); }; wrap.append(label, input); controls.appendChild(wrap);
        });
        var shadowSettings = Object.assign({}, item.macros.shadow), shadowX = document.createElement('input'), shadowY = document.createElement('input'), shadowSize = optionSelect(['SHADOW_SIZE_S', 'SHADOW_SIZE_M', 'SHADOW_SIZE_L', 'SHADOW_SIZE_XL_BATTLE_ONLY', 'NO_SHADOW'], shadowSettings.suppressed ? 'NO_SHADOW' : shadowSettings.size);
        [['Shadow X Offset', shadowX, shadowSettings.x], ['Shadow Y Offset', shadowY, shadowSettings.y]].forEach(function (entry) { var wrap = document.createElement('div'), label = document.createElement('label'); wrap.className = 'field'; label.textContent = entry[0]; entry[1].value = entry[2]; wrap.append(label, entry[1]); controls.appendChild(wrap); });
        var sizeWrap = document.createElement('div'), sizeLabel = document.createElement('label'); sizeWrap.className = 'field'; sizeLabel.textContent = 'Shadow Size'; sizeWrap.append(sizeLabel, shadowSize); controls.appendChild(sizeWrap);
        function updateShadowMacro() {
            shadowSettings.x = shadowX.value.trim() || '0'; shadowSettings.y = shadowY.value.trim() || '0'; shadowSettings.size = shadowSize.value; shadowSettings.suppressed = shadowSize.value === 'NO_SHADOW';
            var edit = staged(item), source = edit.rawBody !== undefined ? edit.rawBody : item.rawBody;
            var replacement = shadowSettings.suppressed ? 'NO_SHADOW' : 'SHADOW(' + shadowSettings.x + ', ' + shadowSettings.y + ', ' + shadowSettings.size + ')';
            if (/\\bSHADOW\\([^)]*\\)/.test(source)) source = source.replace(/\\bSHADOW\\([^)]*\\)/, replacement);
            else if (/\\bNO_SHADOW\\b/.test(source)) source = source.replace(/\\bNO_SHADOW\\b/, replacement);
            else source = source.replace(/(\\n[ \\t]*\\.levelUpLearnset)/, '\\n        ' + replacement + '$1');
            if (source === item.rawBody) delete edit.rawBody; else edit.rawBody = source;
            updatePosition(); setStatus();
        }
        shadowX.oninput = updateShadowMacro; shadowY.oninput = updateShadowMacro; shadowSize.onchange = updateShadowMacro;
        function updatePosition() {
            var yInput = controls.querySelector('[data-field="frontPicYOffset"]'), elevationInput = controls.querySelector('[data-field="enemyMonElevation"]');
            var backYInput = controls.querySelector('[data-field="backPicYOffset"]');
            var y = numericValue(yInput.value, 0), elevation = numericValue(elevationInput.value, 0), backY = numericValue(backYInput.value, 0);
            var frontCenterY = 40 + y - elevation;
            frontSprite.style.top = (frontCenterY / 160 * 100) + '%'; backSprite.style.top = ((80 + backY) / 160 * 100) + '%';
            shadow.style.left = ((176 + numericValue(shadowSettings.x, 0)) / 240 * 100) + '%'; shadow.style.top = ((frontCenterY + numericValue(shadowSettings.y, 0) + 16) / 160 * 100) + '%';
            var shadowRows = { SHADOW_SIZE_S: 0, SHADOW_SIZE_M: 1, SHADOW_SIZE_L: 2, SHADOW_SIZE_XL_BATTLE_ONLY: 3 };
            shadow.style.backgroundPosition = '0 ' + ((shadowRows[shadowSettings.size] || 0) * 100 / 3) + '%'; shadow.style.display = shadowSettings.suppressed ? 'none' : 'block';
        }
        updatePosition(); layout.append(previewColumn, controls); box.append(heading, layout); return box;
    }

    function renderGraphics(item, root) {
        var heading = document.createElement('h2'), gallery = document.createElement('div');
        heading.textContent = 'Pokemon Assets'; gallery.className = 'assets';
        item.assets.forEach(function (asset) {
            var card = document.createElement('div'), preview = document.createElement('div');
            var name = document.createElement('div'), metadata = document.createElement('div'), actions = document.createElement('div');
            var open = document.createElement('button'), replace = document.createElement('button');
            card.className = 'asset'; preview.className = 'preview-wrap';
            if (asset.image) {
                var image = document.createElement('img'), palette = paletteAsset(item); image.className = 'preview'; image.alt = asset.name;
                if (isBattlePicAsset(asset)) processIcon(asset.uri, 0, function (source) { image.src = source; }, true, palette && palette.uri);
                else image.src = asset.uri;
                preview.appendChild(image);
            } else preview.textContent = 'Palette file';
            name.className = 'asset-name'; name.textContent = asset.name;
            metadata.className = 'asset-meta'; metadata.textContent = asset.relativePath + (asset.dimensions ? ' - ' + asset.dimensions.width + 'x' + asset.dimensions.height : '');
            actions.className = 'asset-actions'; open.className = 'secondary'; open.textContent = 'Open'; replace.textContent = 'Replace';
            open.onclick = function () { vscode.postMessage({ type: 'openAsset', relativePath: asset.relativePath }); };
            replace.onclick = function () { vscode.postMessage({ type: 'replaceAsset', relativePath: asset.relativePath, selectedPokemonId: item.id }); };
            actions.append(open, replace); card.append(preview, name, metadata, actions); gallery.appendChild(card);
        });
        if (!item.assets.length) gallery.innerHTML = '<div class="missing">No graphics directory could be resolved from this species initializer.</div>';
        root.append(heading, gallery);
        root.append(makeSection(item, 6), makeSection(item, 7));
    }

    function makeCryPlayer(item) {
        var cryBox = document.createElement('div'); cryBox.className = 'cry-player';
        if (!item.cry) { cryBox.textContent = 'No cry sample could be resolved for this Cry ID.'; return cryBox; }
        var cryLabel = document.createElement('strong'), audio = document.createElement('audio');
        cryLabel.textContent = 'Cry: ' + item.cry.name; audio.controls = true; audio.preload = 'none'; audio.src = item.cry.uri;
        cryBox.append(cryLabel, audio); return cryBox;
    }

    function renderBody() {
        if (selected < 0) return;
        var item = pokemon[selected], root = byId('body'); root.textContent = '';
        if (activeTab === 'stats') root.append(makeSection(item, 0, ['types', 'abilities']), makeIdentityGroups(item));
        else if (activeTab === 'pokedex') root.append(makePokedexSizePreview(item), makeCryPlayer(item), makeSection(item, 3, ['pokemonScale', 'pokemonOffset', 'trainerScale', 'trainerOffset']));
        else if (activeTab === 'training') root.append(makeSection(item, 1), makeSection(item, 2, ['eggGroups']), makeBreedingGroups(item), relatedBox(item, 'eggData', 'Special Egg Data', 'C initializer body'));
        else if (activeTab === 'battle') root.append(makeBattlePreview(item), makeSection(item, 4));
        else if (activeTab === 'moves') {
            var notice = document.createElement('p'); notice.className = 'notice';
            notice.textContent = 'Edit the real backing move lists. Keep C terminators such as LEVEL_UP_END and MOVE_UNAVAILABLE in C arrays.';
            root.append(notice, makeMoveEditor(item, 'level', 'Level-up Learnset', 'level'), makeMoveEditor(item, 'egg', 'Egg Moves', 'egg'), makeMoveEditor(item, 'teachable', 'Teachable Moves', 'teachable'));
        } else if (activeTab === 'forms') root.append(makeEvolutionEditor(item), makeSection(item, 5, ['evolutions', 'levelUpLearnset', 'teachableLearnset', 'eggMoveLearnset']), makeFormSpeciesEditor(item), makeFormChangeEditor(item));
        else if (activeTab === 'graphics') renderGraphics(item, root);
        else {
            var advancedNotice = document.createElement('p'), area = document.createElement('textarea'), edit = edits[item.id];
            advancedNotice.className = 'notice';
            advancedNotice.textContent = 'Full initializer body, including conditional blocks and macro-only settings such as SHADOW, FOOTPRINT, and OVERWORLD. Structured field changes are applied to this source when saved.';
            area.id = 'raw-source'; area.className = 'source'; area.value = edit && edit.rawBody !== undefined ? edit.rawBody : item.rawBody; area.oninput = commit;
            root.append(advancedNotice, area);
        }
    }

    function setStatus(value) { byId('status').textContent = value || (Object.keys(edits).length ? Object.keys(edits).length + ' modified' : ''); }

    byId('search').oninput = renderList;
    byId('save').onclick = function () { commit(); vscode.postMessage({ type: 'save', edits: edits, selectedPokemonId: selected < 0 ? null : pokemon[selected].id }); };
    byId('reload').onclick = function () {
        if (!Object.keys(edits).length || confirm('Discard unsaved Pokemon changes?')) {
            byId('reload').disabled = true; setStatus('Reloading...');
            vscode.postMessage({ type: 'reload', selectedPokemonId: selected < 0 ? null : pokemon[selected].id });
        }
    };
    window.addEventListener('message', function (event) {
        var message = event.data;
        if (message.type === 'init') {
            pokemon = message.pokemon; sections = message.sections; battleEnvironments = message.battleEnvironments || []; gameOptions = message.gameOptions || {}; previewConfig = message.previewConfig || {}; itemIconMap = message.itemIconMap || {}; battleShadowUri = message.battleShadowUri || ''; battleTextbox = message.battleTextbox || {}; pokedexSizeScreen = message.pokedexSizeScreen || {}; trainerPreviewUri = message.trainerPreviewUri || ''; selected = -1; edits = {};
            byId('reload').disabled = false;
            byId('editor').style.display = 'none'; byId('empty').style.display = 'block'; renderList();
            if (message.selectedPokemonId) {
                var index = pokemon.findIndex(function (item) { return item.id === message.selectedPokemonId; });
                if (index >= 0) select(index);
            }
            setStatus();
        }
        if (message.type === 'saveError') setStatus('Save failed');
    });
    vscode.postMessage({ type: 'ready' });
}());
</script></body></html>`;
    }
}

function pngDimensions(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        if (buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    } catch { return null; }
}

function assetOrder(name) {
    const order = ['anim_front.png', 'front.png', 'back.png', 'icon.png', 'footprint.png', 'overworld.png', 'anim_front_gba.png', 'back_gba.png', 'icon_gba.png', 'normal.pal', 'shiny.pal'];
    const index = order.indexOf(name.toLowerCase());
    return index === -1 ? order.length : index;
}

function escapeHtml(value) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
module.exports = { PokemonEditorPanel };
