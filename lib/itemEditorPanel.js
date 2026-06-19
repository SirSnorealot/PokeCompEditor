"use strict";

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ITEM_FIELDS, parseItems, applyItemEdits } = require('./itemParser');

/** @type {Map<string, ItemEditorPanel>} */
const openPanels = new Map();

class ItemEditorPanel {
    static createOrShow(context, projectRoot) {
        const key = projectRoot.fsPath;
        if (openPanels.has(key)) { openPanels.get(key)._panel.reveal(); return; }
        openPanels.set(key, new ItemEditorPanel(context, projectRoot, key));
    }

    constructor(context, projectRoot, key) {
        this._context = context;
        this._projectRoot = projectRoot;
        this._key = key;
        this._itemFile = path.join(projectRoot.fsPath, 'src', 'data', 'items.h');
        const iconsRoot = vscode.Uri.joinPath(projectRoot, 'graphics', 'items', 'icons');
        this._panel = vscode.window.createWebviewPanel('itemEditor', 'Item Editor', vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [iconsRoot],
            retainContextWhenHidden: true,
        });
        this._panel.onDidDispose(() => openPanels.delete(this._key));
        this._panel.webview.onDidReceiveMessage(message => {
            if (message.type === 'save') this._save(message.edits || {}, message.selectedItemId);
            if (message.type === 'reload') this._load();
        });
        this._panel.webview.html = this._loadingHtml();
        setTimeout(() => this._load(), 100);
    }

    _load(selectedItemId) {
        try {
            const content = fs.readFileSync(this._itemFile, 'utf8');
            const items = parseItems(content);
            this._panel.webview.html = this._html();
            setTimeout(() => this._panel.webview.postMessage({
                type: 'init', items, fields: ITEM_FIELDS, icons: this._iconMap(items), selectedItemId,
            }), 100);
        } catch (error) {
            this._panel.webview.html = this._errorHtml(String(error));
        }
    }

    _iconMap(items) {
        const result = {};
        const directory = path.join(this._projectRoot.fsPath, 'graphics', 'items', 'icons');
        if (!fs.existsSync(directory)) return result;

        // Item ids do not reliably match icon filenames. Resolve the icon symbols
        // through the same graphics declarations used by the game.
        const graphicsFile = path.join(this._projectRoot.fsPath, 'src', 'data', 'graphics', 'items.h');
        const picturePaths = {};
        const palettePaths = {};
        if (fs.existsSync(graphicsFile)) {
            const graphicsSource = fs.readFileSync(graphicsFile, 'utf8');
            const pictureDeclaration = /const\s+u32\s+(gItemIcon_[A-Za-z0-9_]+)\[\]\s*=\s*INCGFX_U32\("([^"]+\.png)"/g;
            let match;
            while ((match = pictureDeclaration.exec(graphicsSource)) !== null) {
                picturePaths[match[1]] = path.join(this._projectRoot.fsPath, ...match[2].split('/'));
            }
            const paletteDeclaration = /const\s+u16\s+(gItemIconPalette_[A-Za-z0-9_]+)\[\]\s*=\s*INCGFX_U16\("([^"]+\.pal)"/g;
            while ((match = paletteDeclaration.exec(graphicsSource)) !== null) {
                palettePaths[match[1]] = path.join(this._projectRoot.fsPath, ...match[2].split('/'));
            }
        }

        const renderedIcons = {};
        for (const item of items) {
            let iconPath = null;
            let palettePath = null;
            if (item.fields.pocket.value === 'POCKET_TM_HM') {
                iconPath = picturePaths[item.id.startsWith('ITEM_HM_') ? 'gItemIcon_HM' : 'gItemIcon_TM'];
            } else {
                iconPath = picturePaths[item.fields.iconPic.value];
                palettePath = palettePaths[item.fields.iconPalette.value];
            }
            if (iconPath && fs.existsSync(iconPath)) {
                const cacheKey = iconPath + '|' + (palettePath || '');
                if (!renderedIcons[cacheKey]) {
                    const palette = palettePath && fs.existsSync(palettePath) ? readJascPalette(palettePath) : null;
                    const png = applyIndexedPalette(fs.readFileSync(iconPath), palette);
                    renderedIcons[cacheKey] = 'data:image/png;base64,' + png.toString('base64');
                }
                result[item.id] = renderedIcons[cacheKey];
            }
        }
        return result;
    }

    _save(edits, selectedItemId) {
        try {
            const original = fs.readFileSync(this._itemFile, 'utf8');
            const updated = applyItemEdits(original, edits);
            fs.writeFileSync(this._itemFile, updated, 'utf8');
            vscode.window.showInformationMessage('Saved items.h successfully.');
            this._panel.webview.postMessage({ type: 'saveSuccess' });
            this._load(selectedItemId);
        } catch (error) {
            vscode.window.showErrorMessage('Failed to save items.h: ' + error);
            this._panel.webview.postMessage({ type: 'saveError', message: String(error) });
        }
    }

    _loadingHtml() {
        return '<!DOCTYPE html><html><body style="color:var(--vscode-foreground);padding:20px">Loading items...</body></html>';
    }

    _errorHtml(message) {
        return '<!DOCTYPE html><html><body style="color:var(--vscode-errorForeground);padding:20px"><h2>Item Editor</h2><pre>' +
            escapeHtml(message) + '</pre></body></html>';
    }

    _html() {
        const nonce = crypto.randomBytes(16).toString('hex');
        const csp = this._panel.webview.cspSource;
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Item Editor</title>
<style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;overflow:hidden;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
#side{width:260px;min-width:190px;display:flex;flex-direction:column;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
#side h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:10px 10px 6px}.search{padding:0 8px 8px}input,textarea,select{width:100%;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:5px 7px;font:inherit}input:focus,textarea:focus{outline:1px solid var(--vscode-focusBorder)}
#list{list-style:none;margin:0;padding:0;overflow:auto;flex:1}.item{display:flex;align-items:center;gap:8px;padding:5px 9px;cursor:pointer}.item:hover{background:var(--vscode-list-hoverBackground)}.item.active{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground)}.item img,.icon-placeholder{width:32px;height:32px;object-fit:contain;image-rendering:pixelated;flex:none}.item-text{min-width:0}.item-name,.item-id{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.item-id{font-size:10px;opacity:.7}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden}#empty{margin:auto;color:var(--vscode-descriptionForeground)}#editor{display:none;flex-direction:column;height:100%}.toolbar{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--vscode-panel-border)}.toolbar h1{font-size:18px;margin:0 auto 0 0}.toolbar img{width:40px;height:40px;object-fit:contain;image-rendering:pixelated}button{border:1px solid transparent;padding:6px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground)}
#form{padding:14px;overflow:auto}.notice{color:var(--vscode-descriptionForeground);margin:0 0 14px;line-height:1.4}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.field label{display:flex;justify-content:space-between;margin-bottom:4px;font-weight:600}.field small{font-weight:400;color:var(--vscode-descriptionForeground)}.field textarea{min-height:66px;resize:vertical;font-family:var(--vscode-editor-font-family)}.field input{font-family:var(--vscode-editor-font-family)}.field input:disabled,.field textarea:disabled{opacity:.65}.wide{grid-column:1/-1}details{margin-top:16px;border-top:1px solid var(--vscode-panel-border);padding-top:10px}pre{white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:12px}.status{min-width:80px;color:var(--vscode-descriptionForeground)}
</style></head><body>
<aside id="side"><h2>Items <span id="count"></span></h2><div class="search"><input id="search" type="search" placeholder="Search items..."></div><ul id="list"></ul></aside>
<main id="main"><div id="empty">Select an item to edit.</div><section id="editor"><header class="toolbar"><img id="large-icon" alt=""><div><h1 id="title"></h1><div id="item-id"></div></div><span class="status" id="status"></span><button class="secondary" id="reload">Reload File</button><button id="save">Save</button></header><div id="form"><p class="notice">Values are C expressions. Blank fields are omitted defaults and will be added when filled in. Preprocessor-controlled fields are read-only to preserve project behavior.</p><div class="grid" id="fields"></div><details><summary>Initializer source</summary><pre id="raw"></pre></details></div></section></main>
<script nonce="${nonce}">
(function(){
'use strict';var vscode=acquireVsCodeApi(),items=[],fieldNames=[],icons={},selected=-1,edits={};
var labels={pluralName:'Plural Name',sortType:'Sort Type',fieldUseFunc:'Field Use Function',battleUsage:'Battle Usage',holdEffect:'Hold Effect',holdEffectParam:'Hold Effect Parameter',secondaryId:'Secondary ID',flingPower:'Fling Power',notConsumed:'Not Consumed',iconPic:'Icon Picture',iconPalette:'Icon Palette',shopCriteriaFunc:'Shop Criteria Function'};
function el(id){return document.getElementById(id)}function icon(item){return icons[item.id]||''}
function renderList(){var q=el('search').value.trim().toLowerCase(),list=el('list');list.textContent='';var shown=0;items.forEach(function(item,index){if(q&&item.id.toLowerCase().indexOf(q)<0&&item.displayName.toLowerCase().indexOf(q)<0)return;shown++;var li=document.createElement('li');li.className='item'+(index===selected?' active':'');var src=icon(item);if(src){var img=document.createElement('img');img.src=src;img.alt='';li.appendChild(img)}else{var blank=document.createElement('span');blank.className='icon-placeholder';li.appendChild(blank)}var text=document.createElement('div');text.className='item-text';var name=document.createElement('div');name.className='item-name';name.textContent=item.displayName;var id=document.createElement('div');id.className='item-id';id.textContent=item.id;text.appendChild(name);text.appendChild(id);li.appendChild(text);li.onclick=function(){select(index)};list.appendChild(li)});el('count').textContent='('+shown+')'}
function commit(){if(selected<0)return;var item=items[selected],changed={};fieldNames.forEach(function(name){var input=document.querySelector('[data-field="'+name+'"]');if(input&&!input.disabled&&input.value.trim()!==item.fields[name].value)changed[name]=input.value.trim()});if(Object.keys(changed).length)edits[item.id]=changed;else delete edits[item.id];status()}
function select(index){commit();selected=index;var item=items[index];el('empty').style.display='none';el('editor').style.display='flex';el('title').textContent=item.displayName;el('item-id').textContent=item.id;var src=icon(item);el('large-icon').src=src;el('large-icon').style.visibility=src?'visible':'hidden';var container=el('fields');container.textContent='';fieldNames.forEach(function(name){var data=item.fields[name],wrap=document.createElement('div');wrap.className='field'+(name==='description'?' wide':'');var label=document.createElement('label');label.textContent=labels[name]||name.charAt(0).toUpperCase()+name.slice(1);var reason=document.createElement('small');if(!data.present)reason.textContent='not set';else if(data.conditional)reason.textContent='conditional';label.appendChild(reason);var input=name==='description'?document.createElement('textarea'):document.createElement('input');input.dataset.field=name;input.value=(edits[item.id]&&edits[item.id][name]!==undefined)?edits[item.id][name]:data.value;input.disabled=data.conditional;input.oninput=function(){commit()};wrap.appendChild(label);wrap.appendChild(input);container.appendChild(wrap)});el('raw').textContent=item.rawBody;renderList();var active=document.querySelector('.item.active');if(active)active.scrollIntoView({block:'nearest'});status()}
function status(message){el('status').textContent=message||((Object.keys(edits).length?Object.keys(edits).length+' item(s) modified':''))}
el('search').oninput=renderList;el('save').onclick=function(){commit();vscode.postMessage({type:'save',edits:edits,selectedItemId:selected>=0?items[selected].id:null})};el('reload').onclick=function(){if(!Object.keys(edits).length||confirm('Discard unsaved item changes?'))vscode.postMessage({type:'reload'})};
window.addEventListener('message',function(event){var message=event.data;if(message.type==='init'){items=message.items;fieldNames=message.fields;icons=message.icons;selected=-1;edits={};el('editor').style.display='none';el('empty').style.display='block';renderList();if(message.selectedItemId){var restoredIndex=items.findIndex(function(item){return item.id===message.selectedItemId});if(restoredIndex>=0)select(restoredIndex)}status()}if(message.type==='saveSuccess'){edits={};status('Saved')}if(message.type==='saveError')status('Save failed')});
}());
</script></body></html>`;
    }
}

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function readJascPalette(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    if (lines[0].trim() !== 'JASC-PAL') return null;
    const count = parseInt(lines[2], 10);
    const colors = [];
    for (let i = 0; i < count; i++) {
        const parts = (lines[i + 3] || '').trim().split(/\s+/).map(Number);
        if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
        colors.push(parts);
    }
    return colors;
}

function applyIndexedPalette(png, palette) {
    if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') return png;
    const chunks = [];
    let offset = 8;
    let foundPalette = false;
    let foundTransparency = false;
    while (offset < png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('ascii', offset + 4, offset + 8);
        let data = Buffer.from(png.subarray(offset + 8, offset + 8 + length));
        if (type === 'PLTE') {
            foundPalette = true;
            if (palette) {
                for (let i = 0; i < palette.length && i * 3 + 2 < data.length; i++) {
                    data[i * 3] = palette[i][0];
                    data[i * 3 + 1] = palette[i][1];
                    data[i * 3 + 2] = palette[i][2];
                }
            }
            chunks.push(makePngChunk(type, data));
            if (!hasPngChunk(png, 'tRNS')) {
                chunks.push(makePngChunk('tRNS', Buffer.from([0])));
                foundTransparency = true;
            }
        } else if (type === 'tRNS') {
            foundTransparency = true;
            data = Buffer.from(data.length ? data : [0]);
            data[0] = 0;
            chunks.push(makePngChunk(type, data));
        } else {
            chunks.push(png.subarray(offset, offset + length + 12));
        }
        offset += length + 12;
    }
    if (!foundPalette || !foundTransparency) return png;
    return Buffer.concat([png.subarray(0, 8), ...chunks]);
}

function hasPngChunk(png, wantedType) {
    let offset = 8;
    while (offset < png.length) {
        const length = png.readUInt32BE(offset);
        if (png.toString('ascii', offset + 4, offset + 8) === wantedType) return true;
        offset += length + 12;
    }
    return false;
}

function makePngChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length, 0);
    typeBuffer.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
    return chunk;
}

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

module.exports = { ItemEditorPanel };
