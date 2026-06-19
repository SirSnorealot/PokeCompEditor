"use strict";

const vscode = require('vscode');
const path   = require('path');
const { TrainerEditorPanel } = require('./lib/trainerEditorPanel');
const { ItemEditorPanel } = require('./lib/itemEditorPanel');

/**
 * Find the pokeemerald-expansion project root by locating trainers.party.
 * @returns {Promise<vscode.Uri|null>}
 */
async function findProjectRoot() {
    let files = await vscode.workspace.findFiles('**/src/data/trainers.party', null, 1);
    if (files.length === 0) {
        files = await vscode.workspace.findFiles('**/src/data/items.h', null, 1);
    }
    if (files.length === 0) return null;
    // trainers.party is at <root>/src/data/trainers.party — go up 3 levels
    return vscode.Uri.file(
        path.resolve(files[0].fsPath, '..', '..', '..')
    );
}

class EditorTreeItem extends vscode.TreeItem {
    /**
     * @param {string} label
     * @param {string} commandId
     * @param {string} description
     */
    constructor(label, commandId, description) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.command = {
            command:   commandId,
            title:     label,
            arguments: [],
        };
        this.iconPath = new vscode.ThemeIcon('edit');
    }
}

class PokeCompEditorViewProvider {
    getTreeItem(element) { return element; }
    getChildren() {
        return [
            new EditorTreeItem('Trainer Editor',       'pokeCompEditor.openTrainerEditor',     'trainers.party'),
            new EditorTreeItem('Trainer Editor (FRLG)', 'pokeCompEditor.openTrainerEditorFRLG', 'trainers_frlg.party'),
            new EditorTreeItem('Item Editor',           'pokeCompEditor.openItemEditor',        'items.h'),
        ];
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    // Sidebar view
    vscode.window.registerTreeDataProvider(
        'pokeCompEditorView',
        new PokeCompEditorViewProvider()
    );

    // Command: open standard trainer editor
    context.subscriptions.push(
        vscode.commands.registerCommand('pokeCompEditor.openTrainerEditor', async () => {
            const root = await findProjectRoot();
            if (!root) {
                vscode.window.showErrorMessage(
                    'PokeCompEditor: Could not find trainers.party. ' +
                    'Make sure you have a pokeemerald-expansion project open.'
                );
                return;
            }
            const partyFile = path.join(root.fsPath, 'src', 'data', 'trainers.party');
            TrainerEditorPanel.createOrShow(context, root, partyFile);
        })
    );

    // Command: open FRLG trainer editor
    context.subscriptions.push(
        vscode.commands.registerCommand('pokeCompEditor.openTrainerEditorFRLG', async () => {
            const root = await findProjectRoot();
            if (!root) {
                vscode.window.showErrorMessage(
                    'PokeCompEditor: Could not find trainers_frlg.party. ' +
                    'Make sure you have a pokeemerald-expansion project open.'
                );
                return;
            }
            const partyFile = path.join(root.fsPath, 'src', 'data', 'trainers_frlg.party');
            TrainerEditorPanel.createOrShow(context, root, partyFile);
        })
    );

    // Command: open item editor
    context.subscriptions.push(
        vscode.commands.registerCommand('pokeCompEditor.openItemEditor', async () => {
            const root = await findProjectRoot();
            if (!root) {
                vscode.window.showErrorMessage(
                    'PokeCompEditor: Could not find items.h. ' +
                    'Make sure you have a pokeemerald-expansion project open.'
                );
                return;
            }
            ItemEditorPanel.createOrShow(context, root);
        })
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
