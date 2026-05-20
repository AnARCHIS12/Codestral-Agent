# Codestral Agent

<p align="center">
  <img src="https://raw.githubusercontent.com/AnARCHIS12/Codestral-Agent/main/codestral-vscode-extension/icons/codestral-icon.png" alt="Codestral Agent logo" width="128">
</p>

<p align="center">
  <strong>A coding assistant and multi-file agent for VSCodium and Visual Studio Code, powered by Mistral Codestral.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=CodestralAgent.codestral-ai"><img src="https://img.shields.io/badge/Marketplace-Codestral%20Agent-007ACC?logo=visualstudiocode&logoColor=white" alt="Marketplace"></a>
  <a href="https://github.com/AnARCHIS12/Codestral-Agent"><img src="https://img.shields.io/badge/GitHub-Source-181717?logo=github&logoColor=white" alt="GitHub source"></a>
  <img src="https://img.shields.io/badge/version-0.1.7-0f172a" alt="Version 0.1.7">
  <img src="https://img.shields.io/badge/license-MIT-16a34a" alt="MIT license">
  <img src="https://img.shields.io/badge/models-Mistral%20%2F%20Codestral-f97316" alt="Mistral and Codestral">
</p>

## Overview

Codestral Agent adds an AI coding assistant directly to the VS Code activity bar. It can chat with your project, inspect the active file, read workspace context, prepare multi-file patches, show diffs, apply changes, run validations, inspect errors, and iterate on fixes.

It is designed as an open, bring-your-own-key alternative for developers who want a practical coding agent inside VSCodium or Visual Studio Code.

## Marketplace

Extension ID:

```text
CodestralAgent.codestral-ai
```

Marketplace page:

```text
https://marketplace.visualstudio.com/items?itemName=CodestralAgent.codestral-ai
```

Source code:

```text
https://github.com/AnARCHIS12/Codestral-Agent
```

Issues and support:

```text
https://github.com/AnARCHIS12/Codestral-Agent/issues
```

## Features

- Activity bar panel for Codestral Agent.
- Local chat with conversation history.
- Multi-file agent mode for creating, editing, and deleting workspace files.
- Visible execution plan in the sidebar.
- Diff preview before applying changes.
- Controlled apply flow and revert for the last agent patch.
- Project validation with test, build, typecheck, lint, and static web checks when available.
- Agent correction loop after validation failures.
- Active editor detection and workspace context reading.
- Local project index and memory stored in `.codestral/`.
- Mistral/Codestral model selector based on the models available for your API key.
- Token usage counter for chat, router, and agent requests.
- Interface and response language settings.
- Optional one-time privilege elevation request through the terminal when a command fails because of permissions.

## Current Version

`0.1.7`

Main changes in this version:

- Improved validation for static HTML/CSS/JavaScript projects.
- The agent no longer tries to repair `package.json` when the test script only prints an `echo` message or asks the user to open a browser.
- Simple web projects use a static HTML/CSS/JS smoke check and JavaScript syntax validation when useful.
- API key persistence was improved with a local fallback for environments where SecretStorage is not restored correctly.
- The API field can pre-fill the saved key.
- Token usage is updated after chat, router, and agent calls.
- The active model is displayed in compact form with a full-name tooltip.
- The Agent button can launch an agent task directly from the sidebar input.

## Installation

Install from the Visual Studio Marketplace when available:

```text
https://marketplace.visualstudio.com/items?itemName=CodestralAgent.codestral-ai
```

Or install the local VSIX package:

1. Open the Extensions view in VSCodium or VS Code.
2. Open the `...` menu.
3. Select `Install from VSIX...`.
4. Choose `codestral-ai-0.1.7.vsix`.
5. Reload the window with `Developer: Reload Window`.

## API Key Setup

1. Open the Codestral icon in the left activity bar.
2. Click `API`.
3. Choose `Open Mistral Console` or `Enter API Key`.
4. Click `Mod` to select an available model.

Mistral Codestral console:

```text
https://console.mistral.ai/codestral
```

## Commands

| Command | Description |
|---------|-------------|
| `Codestral: Set API Key` | Store or update your API key |
| `Codestral: Show Available Models` | Fetch models available for your key |
| `Codestral: Select Model` | Switch the active Mistral/Codestral model |
| `Codestral: Settings` | Open the Codestral settings menu |
| `Codestral: Complete Code` | Generate code at the cursor position |
| `Codestral: Chat` | Start a chat request with project context |
| `Codestral: Explain Selection` | Explain the selected code or active file |
| `Codestral: Fix Selection` | Suggest a fix for the selected code |
| `Codestral: Generate Tests` | Generate tests for the selection or active file |
| `Codestral: Review File` | Review the active file and list risks |
| `Codestral: Agent Task` | Run the multi-file agent workflow |
| `Codestral: Revert Last Agent Patch` | Restore files from the last agent backup |
| `Codestral: Rebuild Workspace Index` | Rebuild the local project index |
| `Codestral: Start Dev Server` | Start a detected development server command |
| `Codestral: Stop Dev Server` | Stop the current development server |
| `Codestral: Restart Dev Server` | Restart the development server |
| `Codestral: Run Tests and Diagnose` | Run validation and ask Codestral for diagnostics |

## Local Data

Codestral Agent stores data locally in your editor environment:

- API key through VS Code SecretStorage, with a local fallback for some VSCodium/Flatpak setups.
- Conversation history.
- Selected model.
- Interface and response language preferences.
- Last token usage.
- Agent run history and project memory under `.codestral/` inside the workspace.

The API key is sent only to the Mistral/Codestral API when you use the extension.

## Security

Codestral Agent works inside the opened workspace. It does not run `sudo` automatically. If a command fails because of permissions, the extension can ask for confirmation and open a terminal where you remain in control.

Never commit a real API key to Git.

## Development

From the extension folder:

```bash
npm install
npm run compile
npm run package:vsix
```

The generated package is:

```text
codestral-ai-0.1.7.vsix
```

## License

MIT License. Copyright (c) 2026 CodestralAgent.
