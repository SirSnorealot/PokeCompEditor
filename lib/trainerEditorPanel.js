"use strict";

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const { parseTrainers, serializeTrainers } = require('./trainerParser');
const { loadGameData } = require('./gameDataLoader');

/** @type {Map<string, TrainerEditorPanel>} */
const openPanels = new Map();

class TrainerEditorPanel {
    static createOrShow(context, projectRoot, partyFile) {
        const key = projectRoot.fsPath + '|' + partyFile;
        if (openPanels.has(key)) { openPanels.get(key)._panel.reveal(); return; }
        openPanels.set(key, new TrainerEditorPanel(context, projectRoot, partyFile, key));
    }

    constructor(context, projectRoot, partyFile, key) {
        this._context     = context;
        this._projectRoot = projectRoot;
        this._partyFile   = partyFile;
        this._key         = key;

        const trainerPicsRoot = vscode.Uri.joinPath(projectRoot, 'graphics', 'trainers');
        const pokemonGfxRoot  = vscode.Uri.joinPath(projectRoot, 'graphics', 'pokemon');
        const itemIconsRoot   = vscode.Uri.joinPath(projectRoot, 'graphics', 'items', 'icons');

        this._panel = vscode.window.createWebviewPanel(
            'trainerEditor', 'Trainer Editor', vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [trainerPicsRoot, pokemonGfxRoot, itemIconsRoot],
                retainContextWhenHidden: true,
            }
        );

        this._panel.onDidDispose(() => { openPanels.delete(this._key); });
        this._panel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'save')   this._saveTrainers(msg.trainers);
            if (msg.type === 'reload') this._loadAndSendData();
        });

        this._panel.webview.html = this._getLoadingHtml();
        setTimeout(() => this._loadAndSendData(), 200);
    }

    _loadAndSendData() {
        const filePath = this._partyFile;
        if (!fs.existsSync(filePath)) {
            this._panel.webview.html = this._getErrorHtml('File not found: ' + filePath);
            return;
        }
        let content;
        try { content = fs.readFileSync(filePath, 'utf8'); }
        catch (err) { this._panel.webview.html = this._getErrorHtml('Could not read: ' + err); return; }

        let trainers;
        try { trainers = parseTrainers(content); }
        catch (err) { this._panel.webview.html = this._getErrorHtml('Parse error: ' + err); return; }

        const gameData         = loadGameData(this._projectRoot.fsPath, filePath);
        const trainerPicUriMap = this._buildTrainerPicUriMap();
        const pokemonIconMap   = this._buildPokemonIconMap();
        const itemIconMap      = this._buildItemIconMap();

        this._panel.webview.html = this._getHtmlForWebview();
        setTimeout(() => {
            this._panel.webview.postMessage({
                type: 'init',
                trainers,
                trainerPicUriMap,
                pokemonIconMap,
                itemIconMap,
                aiFlags:        gameData.aiFlags,
                natures:        gameData.natures,
                balls:          gameData.balls,
                musicTypes:     gameData.musicTypes,
                trainerClasses: gameData.trainerClasses,
                types:          gameData.types,
                species:        gameData.species,
                moves:          gameData.moves,
                abilities:      gameData.abilities,
                items:          gameData.items,
            });
        }, 250);
    }

    _buildTrainerPicUriMap() {
        const map     = {};
        const picsDir = vscode.Uri.joinPath(this._projectRoot, 'graphics', 'trainers', 'front_pics');
        if (!fs.existsSync(picsDir.fsPath)) return map;
        for (const entry of fs.readdirSync(picsDir.fsPath)) {
            if (!entry.toLowerCase().endsWith('.png')) continue;
            const key = entry.slice(0, -4).toLowerCase();
            map[key]  = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(picsDir, entry)).toString();
        }
        return map;
    }

    _buildPokemonIconMap() {
        const map      = {};
        const iconRoot = vscode.Uri.joinPath(this._projectRoot, 'graphics', 'pokemon');
        if (!fs.existsSync(iconRoot.fsPath)) return map;
        for (const dir of fs.readdirSync(iconRoot.fsPath)) {
            const iconUri = vscode.Uri.joinPath(iconRoot, dir, 'icon.png');
            if (!fs.existsSync(iconUri.fsPath)) continue;
            // strip all non-alphanumeric so "nidoran_f" -> "nidoranf" matches display name "Nidoran-F" -> "nidoranf"
            const key = dir.toLowerCase().replace(/[^a-z0-9]/g, '');
            map[key] = this._panel.webview.asWebviewUri(iconUri).toString();
        }
        return map;
    }

    _buildItemIconMap() {
        const map      = {};
        const iconsDir = vscode.Uri.joinPath(this._projectRoot, 'graphics', 'items', 'icons');
        if (!fs.existsSync(iconsDir.fsPath)) return map;
        for (const entry of fs.readdirSync(iconsDir.fsPath)) {
            if (!entry.toLowerCase().endsWith('.png')) continue;
            // normalize: strip all non-alphanumeric so "poke_ball" -> "pokeball" matches "Poke Ball" -> "pokeball"
            const key = entry.slice(0, -4).toLowerCase().replace(/[^a-z0-9]/g, '');
            map[key] = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(iconsDir, entry)).toString();
        }
        return map;
    }

    _saveTrainers(trainers) {
        try {
            const original = fs.readFileSync(this._partyFile, 'utf8');
            fs.writeFileSync(this._partyFile, serializeTrainers(trainers, original), 'utf8');
            vscode.window.showInformationMessage('Saved ' + path.basename(this._partyFile) + ' successfully.');
            this._panel.webview.postMessage({ type: 'saveSuccess' });
        } catch (err) {
            vscode.window.showErrorMessage('Failed to save: ' + err);
        }
    }

    _getLoadingHtml() {
        return '<!DOCTYPE html><html><body style="color:var(--vscode-foreground);padding:20px">Loading...</body></html>';
    }
    _getErrorHtml(msg) {
        return '<!DOCTYPE html><html><body style="color:red;padding:20px"><h2>Error</h2><p>' + msg + '</p></body></html>';
    }

    _getHtmlForWebview() {
        const nonce  = getNonce();
        const cspSrc = this._panel.webview.cspSource;

        // ── CSS ──────────────────────────────────────────────────────────────────
        const CSS = [
            '* { box-sizing: border-box; margin: 0; padding: 0; }',
            'body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);',
            '       color: var(--vscode-foreground); background: var(--vscode-editor-background);',
            '       display: flex; height: 100vh; overflow: hidden; }',

            // Sidebar
            '#sidebar { width: 220px; min-width: 160px; border-right: 1px solid var(--vscode-panel-border);',
            '           display: flex; flex-direction: column; background: var(--vscode-sideBar-background); }',
            '#sidebar-header { padding: 8px 8px 0;',
            '                  font-weight: bold; font-size: 11px; text-transform: uppercase;',
            '                  letter-spacing: .05em; color: var(--vscode-sideBarTitle-foreground); }',
            '#sidebar-search { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }',
            '#search { width: 100%; padding: 4px 6px; background: var(--vscode-input-background);',
            '          color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);',
            '          border-radius: 2px; font-size: var(--vscode-font-size); }',
            '#trainer-list { flex: 1; overflow-y: auto; list-style: none; }',
            '.trainer-item { display: flex; align-items: center; gap: 6px; padding: 3px 8px;',
            '                cursor: pointer; font-size: 12px; user-select: none; }',
            '.trainer-item:hover { background: var(--vscode-list-hoverBackground); }',
            '.trainer-item.active { background: var(--vscode-list-activeSelectionBackground);',
            '                       color: var(--vscode-list-activeSelectionForeground); }',
            '.trainer-thumb { width: 32px; height: 32px; object-fit: contain; image-rendering: pixelated;',
            '                 flex-shrink: 0; background: transparent; }',
            '.no-thumb { width: 32px; height: 32px; flex-shrink: 0; }',
            '.item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }',

            // Main area
            '#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }',
            '#no-selection { display: flex; align-items: center; justify-content: center;',
            '                flex: 1; color: var(--vscode-descriptionForeground); font-size: 14px; }',

            // Top bar
            '#trainer-header { display: flex; align-items: center; gap: 10px; padding: 8px 14px;',
            '                  border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }',
            '#trainer-sprite { width: 64px; height: 64px; object-fit: contain; image-rendering: pixelated;',
            '                  background: transparent; }',
            '#trainer-sprite-ph { width: 64px; height: 64px; flex-shrink: 0; }',
            '#trainer-title { flex: 1; }',
            '#trainer-title h2 { font-size: 14px; font-weight: 600; }',
            '#trainer-title .sub { font-size: 11px; color: var(--vscode-descriptionForeground); }',
            '#unsaved-dot { width: 8px; height: 8px; background: orange; border-radius: 50%;',
            '               flex-shrink: 0; display: none; }',
            'button.btn-primary { padding: 4px 12px; background: var(--vscode-button-background);',
            '                     color: var(--vscode-button-foreground); border: none; border-radius: 2px;',
            '                     cursor: pointer; font-size: var(--vscode-font-size); }',
            'button.btn-primary:hover { background: var(--vscode-button-hoverBackground); }',
            'button.btn-secondary { padding: 4px 12px; background: var(--vscode-button-secondaryBackground);',
            '                       color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px;',
            '                       cursor: pointer; font-size: var(--vscode-font-size); }',
            'button.btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }',

            // Editor scroll body
            '#editor-body { flex: 1; overflow-y: auto; padding: 12px; }',
            '.section { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 12px; }',
            '.section-title { padding: 5px 12px; font-size: 11px; font-weight: 700; text-transform: uppercase;',
            '                 letter-spacing: .06em; border-bottom: 1px solid var(--vscode-panel-border);',
            '                 background: var(--vscode-sideBar-background); border-radius: 4px 4px 0 0; }',
            '.section-body { padding: 10px 12px; }',

            // Field layouts
            '.field-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px 14px; }',
            '.field-group { display: flex; flex-direction: column; gap: 3px; }',
            '.field-group label { font-size: 11px; color: var(--vscode-descriptionForeground); }',
            '.field-group input[type=text], .field-group input[type=number], .field-group select {',
            '  background: var(--vscode-input-background); color: var(--vscode-input-foreground);',
            '  border: 1px solid var(--vscode-input-border); border-radius: 2px;',
            '  padding: 3px 6px; font-size: var(--vscode-font-size); font-family: var(--vscode-font-family); width: 100%; }',
            '.check-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; }',

            // Autocomplete
            '.ac-wrap { position: relative; }',
            '.ac-input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);',
            '            border: 1px solid var(--vscode-input-border); border-radius: 2px;',
            '            padding: 3px 6px; font-size: var(--vscode-font-size); font-family: var(--vscode-font-family); }',
            '.ac-drop { position: fixed; z-index: 99999; background: var(--vscode-dropdown-background);',
            '           border: 1px solid var(--vscode-focusBorder); border-radius: 0 0 3px 3px;',
            '           max-height: 200px; overflow-y: auto; display: none; }',
            '.ac-drop.open { display: block; }',
            '.ac-opt { display: flex; align-items: center; gap: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px; }',
            '.ac-opt:hover, .ac-opt.hi { background: var(--vscode-list-hoverBackground); }',
            '.ac-opt img { width: 32px; height: 32px; image-rendering: pixelated; flex-shrink: 0; background: transparent; }',
            '.ac-opt .ac-ph { width: 32px; flex-shrink: 0; }',

            // AI flags
            '.flags-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 3px 10px; }',
            '.flag-row { display: flex; align-items: flex-start; gap: 6px; padding: 2px 0; }',
            '.flag-row input { margin-top: 2px; flex-shrink: 0; }',
            '.flag-name { font-size: 12px; }',
            '.flag-desc { font-size: 10px; color: var(--vscode-descriptionForeground); }',

            '.items-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }',

            // Pokemon cards
            '.poke-card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 8px; }',
            '.card-hdr { display: flex; align-items: center; gap: 8px; padding: 5px 10px;',
            '            background: var(--vscode-sideBar-background); cursor: pointer; user-select: none;',
            '            border-radius: 4px; }',
            '.card-hdr.open { border-radius: 4px 4px 0 0; }',
            '.slot-num { font-size: 11px; font-weight: 700; color: var(--vscode-descriptionForeground); min-width: 18px; }',
            '.mon-icon { width: 32px; height: 32px; image-rendering: pixelated; flex-shrink: 0; background: transparent; }',
            '.no-icon { width: 32px; height: 32px; flex-shrink: 0; }',
            '.card-title { flex: 1; font-size: 13px; }',
            '.btn-remove { background: none; border: none; color: var(--vscode-errorForeground);',
            '              cursor: pointer; font-size: 18px; line-height: 1; padding: 0 4px; }',
            '.caret { font-size: 10px; color: var(--vscode-descriptionForeground); }',
            '.card-body { padding: 10px 12px; display: none; }',
            '.card-body.open { display: block; }',

            '.stat-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }',
            '.stat-grp { display: flex; flex-direction: column; align-items: center; gap: 2px; }',
            '.stat-grp label { font-size: 10px; color: var(--vscode-descriptionForeground); }',
            '.stat-grp input { width: 100%; text-align: center; padding: 2px 0; font-size: 12px;',
            '  background: var(--vscode-input-background); color: var(--vscode-input-foreground);',
            '  border: 1px solid var(--vscode-input-border); border-radius: 2px; }',
            '.moves-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }',
            '.sub-lbl { font-size: 11px; font-weight: 700; color: var(--vscode-descriptionForeground);',
            '           margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .05em; }',
            '#btn-add-mon { margin-top: 6px; }',
        ].join('\n');

        // ── HTML ─────────────────────────────────────────────────────────────────
        const HTML = [
            '<div id="sidebar">',
            '  <div id="sidebar-header">Trainers</div>',
            '  <div id="sidebar-search"><input type="text" id="search" placeholder="Search\u2026"></div>',
            '  <ul id="trainer-list"></ul>',
            '</div>',
            '<div id="main">',
            '  <div id="no-selection">Select a trainer from the list</div>',
            '  <div id="trainer-header" style="display:none">',
            '    <img id="trainer-sprite" style="display:none" alt="">',
            '    <div id="trainer-sprite-ph"></div>',
            '    <div id="trainer-title">',
            '      <h2 id="hdr-name">\u2014</h2>',
            '      <div class="sub" id="hdr-id"></div>',
            '    </div>',
            '    <div id="unsaved-dot" title="Unsaved changes"></div>',
            '    <button class="btn-secondary" id="btn-reload">Reload</button>',
            '    <button class="btn-primary"   id="btn-save">Save</button>',
            '  </div>',
            '  <div id="editor-body" style="display:none">',

            '    <div class="section">',
            '      <div class="section-title">Trainer Info</div>',
            '      <div class="section-body">',
            '        <div class="field-grid">',
            '          <div class="field-group"><label>Name</label><input type="text" id="f-name"></div>',
            '          <div class="field-group"><label>Class</label><input type="text" id="f-class" list="dl-classes"><datalist id="dl-classes"></datalist></div>',
            '          <div class="field-group"><label>Trainer Pic</label><select id="f-pic"></select></div>',
            '          <div class="field-group"><label>Gender</label>',
            '            <select id="f-gender"><option value="">\u2014</option><option>Male</option><option>Female</option></select>',
            '          </div>',
            '          <div class="field-group"><label>Music</label><input type="text" id="f-music" list="dl-music"><datalist id="dl-music"></datalist></div>',
            '          <div class="field-group"><label>Mugshot</label>',
            '            <select id="f-mugshot"><option value="">None</option><option>Purple</option><option>Green</option><option>Pink</option><option>Blue</option><option>Yellow</option></select>',
            '          </div>',
            '        </div>',
            '        <div style="display:flex;gap:20px;margin-top:8px">',
            '          <label class="check-row"><input type="checkbox" id="f-doublebattle"> Double Battle</label>',
            '          <label class="check-row" style="gap:6px">Multi Party <select id="f-multiparty" style="background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:1px 4px"><option value="">No</option><option value="Yes">Yes</option><option value="Half">Half</option></select></label>',
            '        </div>',
            '      </div>',
            '    </div>',

            '    <div class="section">',
            '      <div class="section-title">AI Flags</div>',
            '      <div class="section-body"><div class="flags-grid" id="ai-flags-grid"></div></div>',
            '    </div>',

            '    <div class="section">',
            '      <div class="section-title">Battle Items</div>',
            '      <div class="section-body">',
            '        <div class="items-row">',
            '          <div class="field-group"><label>Item 1</label><div class="ac-wrap" id="item-wrap-0"></div></div>',
            '          <div class="field-group"><label>Item 2</label><div class="ac-wrap" id="item-wrap-1"></div></div>',
            '          <div class="field-group"><label>Item 3</label><div class="ac-wrap" id="item-wrap-2"></div></div>',
            '          <div class="field-group"><label>Item 4</label><div class="ac-wrap" id="item-wrap-3"></div></div>',
            '        </div>',
            '      </div>',
            '    </div>',

            '    <div class="section">',
            '      <div class="section-title">Party</div>',
            '      <div class="section-body">',
            '        <div id="party-cards"></div>',
            '        <button class="btn-primary" id="btn-add-mon">+ Add Pok\u00e9mon</button>',
            '      </div>',
            '    </div>',

            '  </div>',
            '</div>',
        ].join('\n');

        // ── JS ───────────────────────────────────────────────────────────────────
        // IMPORTANT: no backtick template literals — the entire JS block is embedded
        // inside a JS string in Node.js. Use single-quoted strings and concatenation.
        const JS = [
            '(function() {',
            '"use strict";',
            'var vscode = acquireVsCodeApi();',
            'var trainers=[], picMap={}, iconMap={}, itemIconMap={};',
            'var aiFlags=[], natures=[], balls=[], musicTypes=[], trainerClasses=[], types=[];',
            'var species=[], moves=[], abilities=[], items=[];',
            'var currentIdx = -1, unsaved = false;',
            'var processCache={}, pendingCbs={};',
            '',
            '// ── canvas icon processing ───────────────────────────────────────────',
            '// Loads rawSrc via Image, crops to frameH rows (or full height if 0),',
            '// then removes the background color by treating the top-left pixel as',
            '// a color-key — but only when the image has no existing transparency.',
            '// Result is cached as a data: URL and delivered to all pending callbacks.',
            'function processIcon(rawSrc, frameH, cb) {',
            '  if (processCache[rawSrc]) { cb(processCache[rawSrc]); return; }',
            '  if (pendingCbs[rawSrc]) { pendingCbs[rawSrc].push(cb); return; }',
            '  pendingCbs[rawSrc] = [cb];',
            '  var img = new Image();',
            '  img.onload = function() {',
            '    var w = img.naturalWidth;',
            '    var h = (frameH > 0 && frameH < img.naturalHeight) ? frameH : img.naturalHeight;',
            '    var canvas = document.createElement("canvas");',
            '    canvas.width = w; canvas.height = h;',
            '    var ctx = canvas.getContext("2d");',
            '    ctx.drawImage(img, 0, 0);',
            '    var d = ctx.getImageData(0, 0, w, h);',
            '    // check if image already has any transparent pixels',
            '    var hasAlpha = false;',
            '    for (var ai=3; ai<d.data.length; ai+=4) {',
            '      if (d.data[ai] < 255) { hasAlpha = true; break; }',
            '    }',
            '    if (!hasAlpha) {',
            '      // apply color-key: replace every pixel that exactly matches (0,0) with transparent',
            '      var r0=d.data[0], g0=d.data[1], b0=d.data[2];',
            '      for (var pi=0; pi<d.data.length; pi+=4) {',
            '        if (d.data[pi]===r0 && d.data[pi+1]===g0 && d.data[pi+2]===b0) {',
            '          d.data[pi+3] = 0;',
            '        }',
            '      }',
            '      ctx.putImageData(d, 0, 0);',
            '    }',
            '    var url = canvas.toDataURL();',
            '    processCache[rawSrc] = url;',
            '    var cbs = pendingCbs[rawSrc]||[]; delete pendingCbs[rawSrc];',
            '    cbs.forEach(function(f){ f(url); });',
            '  };',
            '  img.onerror = function() {',
            '    processCache[rawSrc] = rawSrc;',
            '    var cbs = pendingCbs[rawSrc]||[]; delete pendingCbs[rawSrc];',
            '    cbs.forEach(function(f){ f(rawSrc); });',
            '  };',
            '  img.src = rawSrc;',
            '}',
            '',
            'function setIconSrc(imgEl, rawSrc, frameH) {',
            '  if (!rawSrc || !imgEl) return;',
            '  processIcon(rawSrc, frameH, function(url) { imgEl.src = url; });',
            '}',
            '',
            '',
            '// ── message from extension ──────────────────────────────────────────',
            'window.addEventListener("message", function(e) {',
            '  var msg = e.data;',
            '  if (msg.type === "init") {',
            '    trainers=msg.trainers; picMap=msg.trainerPicUriMap; iconMap=msg.pokemonIconMap;',
            '    itemIconMap=msg.itemIconMap||{};',
            '    aiFlags=msg.aiFlags; natures=msg.natures; balls=msg.balls;',
            '    musicTypes=msg.musicTypes; trainerClasses=msg.trainerClasses; types=msg.types;',
            '    species=msg.species; moves=msg.moves; abilities=msg.abilities; items=msg.items;',
            '    buildStaticUI();',
            '    renderSidebar("");',
            '    for (var i=0; i<4; i++) makeAC(byId("item-wrap-"+i), items, getItemIcon, "item-ac-"+i, 24);',
            '  }',

            '  if (msg.type === "saveSuccess") {',
            '    unsaved = false; byId("unsaved-dot").style.display = "none";',
            '  }',
            '});',
            '',
            '// ── helpers ─────────────────────────────────────────────────────────',
            'function byId(id) { return document.getElementById(id); }',
            'function esc(s) {',
            '  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");',
            '}',
            'function titleCase(k) {',
            '  return (k||"").replace(/_/g," ").replace(/\\b\\w/g, function(c){ return c.toUpperCase(); });',
            '}',
            'function iconKey(name) {',
            '  return (name||"" ).toLowerCase().replace(/[^a-z0-9]/g,"");',
            '}',
            'function getIcon(name)     { return iconMap[iconKey(name)]     || null; }',
            'function getItemIcon(name) { return itemIconMap[iconKey(name)] || null; }',

            '',
            '// ── autocomplete ────────────────────────────────────────────────────',
            '// wrapEl   : a DOM element (NOT an ID string).',
            '// iconFn   : function(name) -> rawSrc string, or null for no icons.',
            '// frameH   : crop height in px (32 for pokemon 32x64 sheets, 24 for items, 0 = no crop).',
            '// Returns { getValue, setValue, getEl }.',
            'function makeAC(wrapEl, list, iconFn, inputId, frameH) {',
            '  frameH = frameH || 0;',
            '  if (!wrapEl) return { getValue: function(){ return ""; }, setValue: function(){}, getEl: function(){ return null; } };',
            '  wrapEl.innerHTML = "";',
            '  var inp = document.createElement("input");',
            '  inp.type = "text"; inp.className = "ac-input"; inp.autocomplete = "off";',
            '  if (inputId) inp.id = inputId;',
            '  var drop = document.createElement("div");',
            '  drop.className = "ac-drop";',
            '  document.body.appendChild(drop); // attach to body so it escapes card overflow',
            '  wrapEl.appendChild(inp);',
            '  var hi = -1;',
            '',
            '  function reposition() {',
            '    var r = inp.getBoundingClientRect();',
            '    drop.style.left  = r.left + "px";',
            '    drop.style.top   = (r.bottom) + "px";',
            '    drop.style.width = r.width + "px";',
            '  }',
            '',
            '  function fill(q) {',
            '    var filtered = q.length === 0',
            '      ? list.slice(0, 60)',
            '      : list.filter(function(n){ return n.toLowerCase().indexOf(q.toLowerCase()) !== -1; }).slice(0, 60);',
            '    drop.innerHTML = "";',
            '    hi = -1;',
            '    filtered.forEach(function(name) {',
            '      var row = document.createElement("div");',
            '      row.className = "ac-opt"; row.dataset.val = name;',
            '      if (iconFn) {',
            '        var rawSrc = iconFn(name);',
            '        if (rawSrc) {',
            '          var icSize = frameH > 0 ? frameH : 24;',
            '          var img = document.createElement("img");',
            '          img.width = icSize; img.height = icSize;',
            '          setIconSrc(img, rawSrc, frameH);',
            '          row.appendChild(img);',
            '        } else {',
            '          var ph = document.createElement("div"); ph.className = "ac-ph";',
            '          row.appendChild(ph);',
            '        }',
            '      }',

            '      var lbl = document.createElement("span"); lbl.textContent = name;',
            '      row.appendChild(lbl);',
            '      row.addEventListener("mousedown", function(ev) {',
            '        ev.preventDefault();',
            '        inp.value = name;',
            '        drop.classList.remove("open");',
            '        inp.dispatchEvent(new Event("change", { bubbles: true }));',
            '      });',
            '      drop.appendChild(row);',
            '    });',
            '  }',
            '',
            '  inp.addEventListener("focus", function() { reposition(); fill(inp.value); drop.classList.add("open"); });',
            '  inp.addEventListener("input", function() { reposition(); fill(inp.value); drop.classList.add("open"); });',
            '  inp.addEventListener("blur",  function() { setTimeout(function(){ drop.classList.remove("open"); }, 160); });',
            '  window.addEventListener("scroll", function() { if (drop.classList.contains("open")) reposition(); }, true);',
            '',
            '  inp.addEventListener("keydown", function(e) {',
            '    var opts = drop.querySelectorAll(".ac-opt");',
            '    if (!opts.length) return;',
            '    if (e.key === "ArrowDown") {',
            '      e.preventDefault();',
            '      hi = Math.min(hi+1, opts.length-1);',
            '      opts.forEach(function(o,i){ o.classList.toggle("hi", i===hi); });',
            '    } else if (e.key === "ArrowUp") {',
            '      e.preventDefault();',
            '      hi = Math.max(hi-1, 0);',
            '      opts.forEach(function(o,i){ o.classList.toggle("hi", i===hi); });',
            '    } else if (e.key === "Enter" && hi >= 0) {',
            '      e.preventDefault();',
            '      inp.value = opts[hi].dataset.val;',
            '      drop.classList.remove("open");',
            '      inp.dispatchEvent(new Event("change", { bubbles: true }));',
            '    } else if (e.key === "Escape") {',
            '      drop.classList.remove("open");',
            '    }',
            '  });',
            '',
            '  return {',
            '    getValue: function() { return inp.value.trim(); },',
            '    setValue: function(v) { inp.value = v || ""; },',
            '    getEl:    function() { return inp; },',
            '  };',
            '}',
            '',
            '// ── static UI (called once after init) ──────────────────────────────',
            'function buildStaticUI() {',
            '  byId("dl-classes").innerHTML = trainerClasses.map(function(c){',
            '    return "<option value=\\""+esc(c)+"\\">"; }).join("");',
            '  byId("dl-music").innerHTML = musicTypes.map(function(m){',
            '    return "<option value=\\""+esc(m)+"\\">"; }).join("");',
            '  byId("f-pic").innerHTML =',
            '    "<option value=\\"\\">\\u2014 none \\u2014</option>" +',
            '    Object.keys(picMap).map(function(k){',
            '      return "<option value=\\""+esc(k)+"\\">"+esc(titleCase(k))+"</option>";',
            '    }).join("");',
            '  byId("ai-flags-grid").innerHTML = aiFlags.map(function(f,i){',
            '    return "<div class=\\"flag-row\\">" +',
            '      "<input type=\\"checkbox\\" id=\\"ai-"+i+"\\" data-flag=\\""+esc(f.flag)+"\\">" +',
            '      "<div><div class=\\"flag-name\\">"+esc(f.label)+"</div>" +',
            '      "<div class=\\"flag-desc\\">"+esc(f.description)+"</div></div></div>";',
            '  }).join("");',
            '}',
            '',
            '// ── sidebar ─────────────────────────────────────────────────────────',
            'function renderSidebar(q) {',
            '  var ul = byId("trainer-list"); ul.innerHTML = "";',
            '  q = q.trim().toLowerCase();',
            '  trainers.forEach(function(t, i) {',
            '    if (q && t.id.toLowerCase().indexOf(q)===-1 && (t.name||"").toLowerCase().indexOf(q)===-1) return;',
            '    var li = document.createElement("li");',
            '    li.className = "trainer-item" + (i===currentIdx ? " active" : "");',
            '    var picKey = (t.pic||"").toLowerCase().replace(/ /g,"_");',
            '    var src = picMap[picKey];',
            '    var thumbEl;',
            '    if (src) {',
            '      thumbEl = document.createElement("img");',
            '      thumbEl.className = "trainer-thumb"; thumbEl.alt = "";',
            '      setIconSrc(thumbEl, src, 0);',
            '    } else {',
            '      thumbEl = document.createElement("div"); thumbEl.className = "no-thumb";',
            '    }',
            '    var lbl = document.createElement("span"); lbl.className = "item-label";',
            '    lbl.textContent = t.name||t.id;',
            '    li.appendChild(thumbEl); li.appendChild(lbl);',
            '    li.addEventListener("click", (function(idx){ return function(){ selectTrainer(idx); }; })(i));',
            '    ul.appendChild(li);',
            '  });',
            '}',
            'byId("search").addEventListener("input", function(e){ renderSidebar(e.target.value); });',
            '',
            '// ── select trainer ───────────────────────────────────────────────────',
            'function selectTrainer(idx) {',
            '  if (currentIdx !== -1) commitEdits();',
            '  currentIdx = idx;',
            '  var t = trainers[idx];',
            '  byId("no-selection").style.display = "none";',
            '  byId("trainer-header").style.display = "flex";',
            '  byId("editor-body").style.display = "block";',
            '  byId("hdr-name").textContent = t.name || t.id;',
            '  byId("hdr-id").textContent = t.id;',
            '  var picKey = (t.pic||"").toLowerCase().replace(/ /g,"_");',
            '  var sprSrc = picMap[picKey];',
            '  var sprEl = byId("trainer-sprite"); var phEl = byId("trainer-sprite-ph");',
            '  if (sprSrc) { sprEl.style.display="block"; phEl.style.display="none"; setIconSrc(sprEl, sprSrc, 0); }',
            '  else        { sprEl.style.display="none"; phEl.style.display="block"; }',
            '  loadForm(t);',
            '  renderSidebar(byId("search").value);',
            '  unsaved = false; byId("unsaved-dot").style.display = "none";',
            '}',
            '',
            '// ── load trainer into form ───────────────────────────────────────────',
            'function loadForm(t) {',
            '  byId("f-name").value        = t.name||"";',
            '  byId("f-class").value       = t.trainerClass||"";',
            '  byId("f-pic").value         = (t.pic||"").toLowerCase().replace(/ /g,"_");',
            '  byId("f-gender").value      = t.gender||"";',
            '  byId("f-music").value       = t.music||"";',
            '  byId("f-mugshot").value     = t.mugshotColor||"";',
            '  byId("f-doublebattle").checked = !!t.doubleBattle;',
            '  byId("f-multiparty").value   = t.multiParty||""  ;',
            '  aiFlags.forEach(function(f,i){',
            '    byId("ai-"+i).checked = (t.aiFlags||[]).indexOf(f.flag) !== -1;',
            '  });',
            '  for (var i=0; i<4; i++) {',
            '    var el = byId("item-ac-"+i);',
            '    if (el) el.value = (t.items||[])[i]||"";',
            '  }',
            '  renderParty(t.party||[]);',
            '  byId("editor-body").querySelectorAll("input,select").forEach(function(el){',
            '    el.addEventListener("change", dirty);',
            '  });',
            '  // update header sprite instantly when pic dropdown changes',
            '  byId("f-pic").addEventListener("change", function() {',
            '    var key = byId("f-pic").value;',
            '    var src = picMap[key];',
            '    var sprEl = byId("trainer-sprite"); var phEl = byId("trainer-sprite-ph");',
            '    if (src) { sprEl.style.display="block"; phEl.style.display="none"; setIconSrc(sprEl, src, 0); }',
            '    else     { sprEl.style.display="none"; phEl.style.display="block"; }',
            '  });',
            '}',
            '',
            'function dirty() {',
            '  if (!unsaved) { unsaved=true; byId("unsaved-dot").style.display="block"; }',
            '}',
            '',
            '// ── party ────────────────────────────────────────────────────────────',
            'function renderParty(party) {',
            '  var c = byId("party-cards"); c.innerHTML = "";',
            '  party.forEach(function(mon, slot){ c.appendChild(buildCard(mon, slot)); });',
            '}',
            '',
            'function buildCard(mon, slot) {',
            '  var card = document.createElement("div"); card.className = "poke-card";',
            '',
            '  // ── header ──',
            '  var hdr = document.createElement("div"); hdr.className = "card-hdr open";',
            '  var rawIconSrc = getIcon(mon.species);',
            '  var iconEl;',
            '  if (rawIconSrc) {',
            '    iconEl = document.createElement("img");',
            '    iconEl.className = "mon-icon"; iconEl.alt = "";',
            '    setIconSrc(iconEl, rawIconSrc, 32);',
            '  } else {',
            '    iconEl = document.createElement("div"); iconEl.className = "no-icon";',
            '  }',

            '  var slotSpan  = document.createElement("span"); slotSpan.className = "slot-num"; slotSpan.textContent = "#"+(slot+1);',
            '  var titleSpan = document.createElement("span"); titleSpan.className = "card-title";',
            '  titleSpan.textContent = mon.species || "\\u2014";',
            '  if (mon.nickname) titleSpan.textContent += " ("+mon.nickname+")";',
            '  var removeBtn = document.createElement("button"); removeBtn.className = "btn-remove";',
            '  removeBtn.title = "Remove"; removeBtn.textContent = "\\u00d7";',
            '  removeBtn.addEventListener("click", function(e){ e.stopPropagation(); removeMon(slot); });',
            '  var caret = document.createElement("span"); caret.className = "caret"; caret.textContent = "\\u25bc";',
            '  hdr.appendChild(slotSpan); hdr.appendChild(iconEl); hdr.appendChild(titleSpan);',
            '  hdr.appendChild(removeBtn); hdr.appendChild(caret);',
            '',
            '  // ── body ──',
            '  var body = document.createElement("div"); body.className = "card-body open";',
            '  var refs = buildMonForm(body, mon, slot);',
            '  body._refs = refs;',
            '',
            '  // update header icon/title when species selected',
            '  refs.species.getEl().addEventListener("change", function() {',
            '    var v = refs.species.getValue();',
            '    titleSpan.textContent = v || "\\u2014";',
            '    var newRaw = getIcon(v);',
            '    if (newRaw) {',
            '      if (iconEl.tagName !== "IMG") {',
            '        var img = document.createElement("img"); img.className = "mon-icon"; img.alt = "";',
            '        hdr.replaceChild(img, iconEl); iconEl = img;',
            '      }',
            '      setIconSrc(iconEl, newRaw, 32);',
            '    }',
            '    dirty();',
            '  });',

            '',
            '  // collapse toggle',
            '  hdr.addEventListener("click", function() {',
            '    body.classList.toggle("open");',
            '    hdr.classList.toggle("open", body.classList.contains("open"));',
            '    caret.textContent = body.classList.contains("open") ? "\\u25bc" : "\\u25b6";',
            '  });',
            '',
            '  card.appendChild(hdr); card.appendChild(body);',
            '  return card;',
            '}',
            '',
            '// ── build pokemon form fields ─────────────────────────────────────',
            'function buildMonForm(body, mon, slot) {',
            '  function fg(labelTxt, el) {',
            '    var d = document.createElement("div"); d.className = "field-group";',
            '    var l = document.createElement("label"); l.textContent = labelTxt;',
            '    d.appendChild(l); d.appendChild(el); return d;',
            '  }',
            '  function mkInp(type, attrs, val) {',
            '    var el = document.createElement("input"); el.type = type;',
            '    if (attrs) Object.keys(attrs).forEach(function(k){ el.setAttribute(k, attrs[k]); });',
            '    if (val !== undefined) el.value = val;',
            '    el.addEventListener("change", dirty); return el;',
            '  }',
            '  function mkSel(opts, val) {',
            '    var el = document.createElement("select");',
            '    opts.forEach(function(o){',
            '      var op = document.createElement("option");',
            '      op.value = o.v !== undefined ? o.v : o;',
            '      op.textContent = o.t || o;',
            '      if (op.value === val || op.textContent === val) op.selected = true;',
            '      el.appendChild(op);',
            '    });',
            '    el.addEventListener("change", dirty); return el;',
            '  }',
            '  function mkAcWrap(id) {',
            '    var d = document.createElement("div"); d.className = "ac-wrap"; d.id = id; return d;',
            '  }',
            '',
            '  // top field grid',
            '  var grid = document.createElement("div"); grid.className = "field-grid";',
            '',
            '  var speciesWrap = mkAcWrap("ac-sp-"+slot);',
            '  grid.appendChild(fg("Species", speciesWrap));',
            '',
            '  var nickInp = mkInp("text", {}, mon.nickname||"");',
            '  grid.appendChild(fg("Nickname", nickInp));',
            '',
            '  var genderSel = mkSel([{v:"",t:"\\u2014"},{v:"M",t:"M"},{v:"F",t:"F"}], mon.gender||"");',
            '  grid.appendChild(fg("Gender", genderSel));',
            '',
            '  var heldWrap = mkAcWrap("ac-held-"+slot);',
            '  grid.appendChild(fg("Held Item", heldWrap));',

            '',
            '  var levelInp = mkInp("number", {min:"1",max:"100"}, mon.level||50);',
            '  grid.appendChild(fg("Level", levelInp));',
            '',
            '  var natOpts = [{v:"",t:"\\u2014"}].concat(natures.map(function(n){ return {v:n,t:n}; }));',
            '  var natSel = mkSel(natOpts, mon.nature||"");',
            '  grid.appendChild(fg("Nature", natSel));',
            '',
            '  var abilityWrap = mkAcWrap("ac-ab-"+slot);',
            '  grid.appendChild(fg("Ability", abilityWrap));',
            '',
            '  var ballSel = mkSel(balls, mon.ball||"Poke");',
            '  grid.appendChild(fg("Ball", ballSel));',
            '',
            '  var friendInp = mkInp("number", {min:"0",max:"255"}, mon.friendship||0);',
            '  grid.appendChild(fg("Friendship", friendInp));',
            '',
            '  var dmaxInp = mkInp("number", {min:"0",max:"10"}, mon.dynamaxLevel||0);',
            '  grid.appendChild(fg("Dynamax Lvl", dmaxInp));',
            '',
            '  var teraOpts = [{v:"",t:"\\u2014"}].concat(types.map(function(ty){ return {v:ty,t:ty}; }));',
            '  var teraSel = mkSel(teraOpts, mon.teraType||"");',
            '  grid.appendChild(fg("Tera Type", teraSel));',
            '',
            '  body.appendChild(grid);',
            '',
            '  // checkboxes',
            '  var cbRow = document.createElement("div"); cbRow.style.cssText = "display:flex;gap:16px;margin-top:6px";',
            '  var shinyCb = mkInp("checkbox"); shinyCb.checked = !!mon.shiny;',
            '  var gmaxCb  = mkInp("checkbox"); gmaxCb.checked  = !!mon.gigantamax;',
            '  var shinyLbl = document.createElement("label"); shinyLbl.className = "check-row";',
            '  shinyLbl.appendChild(shinyCb); shinyLbl.appendChild(document.createTextNode(" Shiny"));',
            '  var gmaxLbl = document.createElement("label"); gmaxLbl.className = "check-row";',
            '  gmaxLbl.appendChild(gmaxCb); gmaxLbl.appendChild(document.createTextNode(" Gigantamax"));',
            '  cbRow.appendChild(shinyLbl); cbRow.appendChild(gmaxLbl);',
            '  body.appendChild(cbRow);',
            '',
            '  // EVs',
            '  var evLbl = document.createElement("div"); evLbl.className = "sub-lbl"; evLbl.textContent = "EVs";',
            '  body.appendChild(evLbl);',
            '  var evGrid = document.createElement("div"); evGrid.className = "stat-grid";',
            '  var evInps = {}; var stats = ["hp","atk","def","spa","spd","spe"];',
            '  var ev = mon.evs || {hp:0,atk:0,def:0,spa:0,spd:0,spe:0};',
            '  stats.forEach(function(s) {',
            '    var g = document.createElement("div"); g.className = "stat-grp";',
            '    var l = document.createElement("label"); l.textContent = s.toUpperCase();',
            '    var i = mkInp("number",{min:"0",max:"252"}, ev[s]||0);',
            '    evInps[s]=i; g.appendChild(l); g.appendChild(i); evGrid.appendChild(g);',
            '  });',
            '  body.appendChild(evGrid);',
            '',
            '  // IVs',
            '  var ivLbl = document.createElement("div"); ivLbl.className = "sub-lbl"; ivLbl.textContent = "IVs";',
            '  body.appendChild(ivLbl);',
            '  var ivGrid = document.createElement("div"); ivGrid.className = "stat-grid";',
            '  var ivInps = {};',
            '  var iv = mon.ivs || {hp:31,atk:31,def:31,spa:31,spd:31,spe:31};',
            '  stats.forEach(function(s) {',
            '    var g = document.createElement("div"); g.className = "stat-grp";',
            '    var l = document.createElement("label"); l.textContent = s.toUpperCase();',
            '    var i = mkInp("number",{min:"0",max:"31"}, iv[s]===undefined?31:iv[s]);',
            '    ivInps[s]=i; g.appendChild(l); g.appendChild(i); ivGrid.appendChild(g);',
            '  });',
            '  body.appendChild(ivGrid);',
            '',
            '  // Moves',
            '  var moveLbl = document.createElement("div"); moveLbl.className = "sub-lbl"; moveLbl.textContent = "Moves";',
            '  body.appendChild(moveLbl);',
            '  var moveGrid = document.createElement("div"); moveGrid.className = "moves-grid";',
            '  var monMoves = (mon.moves||[]).concat(["","",""]).slice(0,4);',
            '  var moveWraps = [];',
            '  for (var mi=0; mi<4; mi++) {',
            '    var mWrap = mkAcWrap("ac-mv-"+slot+"-"+mi);',
            '    var mFg = document.createElement("div"); mFg.className = "field-group";',
            '    var mLbl = document.createElement("label"); mLbl.textContent = "Move "+(mi+1);',
            '    mFg.appendChild(mLbl); mFg.appendChild(mWrap);',
            '    moveGrid.appendChild(mFg);',
            '    moveWraps.push({ el: mWrap, val: monMoves[mi] });',
            '  }',
            '  body.appendChild(moveGrid);',
            '',
            '  // ── build ACs (elements are now in body, but body not yet in DOM)',
            '  // makeAC appends drop to document.body so fixed positioning works ──',
            '  var speciesAC = makeAC(speciesWrap, species, getIcon, null, 32);',
            '  speciesAC.setValue(mon.species||"");',
            '',
            '  var heldAC = makeAC(heldWrap, items, getItemIcon, null, 24);',
            '  heldAC.setValue(mon.heldItem||"");',

            '',
            '  var abilityAC = makeAC(abilityWrap, abilities, null, null);',
            '  abilityAC.setValue(mon.ability||"");',
            '',
            '  var moveACs = moveWraps.map(function(m) {',
            '    var ac = makeAC(m.el, moves, null, null);',
            '    ac.setValue(m.val); return ac;',
            '  });',
            '',
            '  return {',
            '    species: speciesAC, heldItem: heldAC, ability: abilityAC, moves: moveACs,',
            '    nickname: nickInp, gender: genderSel, level: levelInp, nature: natSel,',
            '    ball: ballSel, friendship: friendInp, dynamaxLevel: dmaxInp, teraType: teraSel,',
            '    shiny: shinyCb, gigantamax: gmaxCb, evs: evInps, ivs: ivInps,',
            '  };',
            '}',
            '',
            '// ── commit edits to trainers array ──────────────────────────────────',
            'function commitEdits() {',
            '  if (currentIdx === -1) return;',
            '  var t = trainers[currentIdx];',
            '  t.name         = byId("f-name").value.trim();',
            '  t.trainerClass = byId("f-class").value.trim();',
            '  t.pic          = titleCase(byId("f-pic").value);',
            '  t.gender       = byId("f-gender").value;',
            '  t.music        = byId("f-music").value.trim();',
            '  t.mugshotColor = byId("f-mugshot").value;',
            '  t.doubleBattle = byId("f-doublebattle").checked;',
            '  t.multiParty   = byId("f-multiparty").value;',
            '  var knownFlagSet = {};',
            '  aiFlags.forEach(function(f){ knownFlagSet[f.flag] = true; });',
            '  var unknownFlags = (t.aiFlags||[]).filter(function(f){ return !knownFlagSet[f]; });',
            '  t.aiFlags = [];',
            '  aiFlags.forEach(function(f,i){',
            '    if (byId("ai-"+i).checked) t.aiFlags.push(f.flag);',
            '  });',
            '  unknownFlags.forEach(function(f){ t.aiFlags.push(f); });',
            '  t.items = [0,1,2,3].map(function(i){',
            '    var el = byId("item-ac-"+i); return el ? el.value.trim() : "";',
            '  });',
            '  t.party = readParty();',
            '}',
            '',
            'function readParty() {',
            '  var party = [];',
            '  document.querySelectorAll(".poke-card").forEach(function(card) {',
            '    var body = card.querySelector(".card-body");',
            '    var r = body ? body._refs : null; if (!r) return;',
            '    var stats = ["hp","atk","def","spa","spd","spe"];',
            '    var ev = {}; stats.forEach(function(s){ ev[s] = parseInt(r.evs[s].value,10)||0; });',
            '    var iv = {}; stats.forEach(function(s){ var v=parseInt(r.ivs[s].value,10); iv[s]=isNaN(v)?31:v; });',
            '    party.push({',
            '      species:      r.species.getValue(),',
            '      nickname:     r.nickname.value.trim(),',
            '      gender:       r.gender.value,',
            '      heldItem:     r.heldItem.getValue(),',
            '      level:        parseInt(r.level.value,10)||50,',
            '      nature:       r.nature.value,',
            '      ability:      r.ability.getValue(),',
            '      ball:         r.ball.value||"Poke",',
            '      friendship:   parseInt(r.friendship.value,10)||0,',
            '      shiny:        r.shiny.checked,',
            '      gigantamax:   r.gigantamax.checked,',
            '      dynamaxLevel: parseInt(r.dynamaxLevel.value,10)||0,',
            '      teraType:     r.teraType.value,',
            '      evs: ev, ivs: iv,',
            '      moves: r.moves.map(function(m){ return m.getValue(); }).filter(Boolean),',
            '    });',
            '  });',
            '  return party;',
            '}',
            '',
            'function addMon() {',
            '  commitEdits();',
            '  var t = trainers[currentIdx]; if (!t) return;',
            '  t.party = t.party||[];',
            '  if (t.party.length >= 6) return;',
            '  t.party.push({',
            '    species:"",nickname:"",gender:"",heldItem:"",level:50,nature:"",',
            '    ability:"",ball:"Poke",friendship:0,shiny:false,gigantamax:false,',
            '    dynamaxLevel:0,teraType:"",',
            '    evs:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0},',
            '    ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},moves:[],',
            '  });',
            '  renderParty(t.party); dirty();',
            '}',
            '',
            'function removeMon(slot) {',
            '  commitEdits();',
            '  trainers[currentIdx].party.splice(slot,1);',
            '  renderParty(trainers[currentIdx].party); dirty();',
            '}',
            '',
            'byId("btn-add-mon").addEventListener("click", addMon);',
            'byId("btn-save").addEventListener("click", function(){',
            '  commitEdits();',
            '  vscode.postMessage({ type:"save", trainers:trainers });',
            '});',
            'byId("btn-reload").addEventListener("click", function(){',
            '  vscode.postMessage({ type:"reload" });',
            '});',
            '',
            '})();',
        ].join('\n');

        return '<!DOCTYPE html>\n' +
            '<html lang="en">\n<head>\n' +
            '<meta charset="UTF-8">\n' +
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src ' + cspSrc + ' data:; script-src \'nonce-' + nonce + '\'; style-src \'unsafe-inline\';">\n' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
            '<title>Trainer Editor</title>\n' +
            '<style>\n' + CSS + '\n</style>\n' +
            '</head>\n<body>\n' + HTML + '\n' +
            '<script nonce="' + nonce + '">\n' + JS + '\n</script>\n' +
            '</body>\n</html>';
    }
}

function getNonce() {
    return require('crypto').randomBytes(16).toString('hex');
}

module.exports = { TrainerEditorPanel };
