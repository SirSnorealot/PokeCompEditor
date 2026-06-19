# PokeCompEditor

A VS Code extension that provides visual editors for [pokeemerald-expansion](https://github.com/rh-hideout/pokeemerald-expansion) projects. It was built by AI with human guidance, review, and testing.

Working knowledge of the game and its data formats is still expected — always verify your changes are correct before committing. Since this tool is AI-generated, never assume the output is always accurate. I will be fixing issues as I discover them through my own personal use. If something isn't being edited correctly, please [open an issue](https://github.com/SirSnorealot/PokeCompEditor/issues).

---

## Features

| Editor | Description |
|--------|-------------|
| **Trainer Editor** | Edit trainers and their party Pokémon via a GUI. Writes to `src/data/trainers.party`. |
| **Trainer Editor (FRLG)** | Same as above for the FRLG variant. Writes to `src/data/trainers_frlg.party`. |
| **Item Editor** | Edit items via a GUI. Writes to `src/data/items.h`. |
| **Attack Editor** | Edit attacks and their battle properties via a GUI. Writes to `src/data/moves_info.h`. |

---

## Installation

1. Download `pokecompeditor.vsix` from the [Releases](https://github.com/SirSnorealot/PokeCompEditor/releases) page, or use the one included in this repository.
2. In VS Code press `Ctrl+Shift+P` → **Extensions: Install from VSIX…** and select the downloaded file.
3. Reload VS Code when prompted.

---

## Usage

1. Open your pokeemerald-expansion project folder in VS Code.
2. Click the **Pokéball icon** in the Activity Bar on the left.
3. Select an editor from the sidebar.
4. Make your changes and click **Save** to write them back to the project files.
5. Click **Reload File** to discard unsaved changes and re-read from disk.

> **Note:** After saving, run `make` as usual to rebuild the ROM.

---

## Planned Editors

- Species/Pokémon Editor
- Let me know of any ideas and they will be considered.
