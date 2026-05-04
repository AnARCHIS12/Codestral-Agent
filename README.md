# Codestral Agent

<p align="center">
  <img src="codestral-vscode-extension/icons/codestral-icon.png" alt="Codestral Agent logo" width="128">
</p>

<p align="center">
  <strong>Coding assistant and agent for VSCodium/VS Code, powered by Mistral Codestral.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=CodestralAgent.codestral-ai"><img src="https://img.shields.io/badge/Marketplace-Codestral%20Agent-007ACC?logo=visualstudiocode&logoColor=white" alt="Marketplace"></a>
  <a href="https://github.com/AnARCHIS12/Codestral-Agent"><img src="https://img.shields.io/badge/GitHub-Source-181717?logo=github&logoColor=white" alt="GitHub source"></a>
  <img src="https://img.shields.io/badge/version-0.1.5-0f172a" alt="Version 0.1.5">
  <img src="https://img.shields.io/badge/license-MIT-16a34a" alt="MIT license">
  <img src="https://img.shields.io/badge/VSCodium%20%2F%20VS%20Code-1.75%2B-2563eb" alt="VSCodium and VS Code 1.75+">
  <img src="https://img.shields.io/badge/models-Mistral%20%2F%20Codestral-f97316" alt="Mistral and Codestral">
</p>

## Overview

Codestral Agent is a coding assistant project powered by Mistral/Codestral. It includes a static demo website and, most importantly, a VSCodium/VS Code extension with chat, conversation history, model selection, token usage, and a multi-file agent mode.

The goal is to provide an open alternative to a modern coding agent: read a project, understand a task, create or edit files, show diffs, apply changes, run validations, and fix errors after a failed run.

GitHub source:

```text
https://github.com/AnARCHIS12/Codestral-Agent
```

## Project Contents

| Path | Purpose |
|------|---------|
| `web/` | Static HTML/CSS demo website |
| `docs/` | GitHub Pages version of the website |
| `codestral-vscode-extension/` | Main VSCodium/VS Code extension |
| `codestral-vscode-extension/README.md` | Marketplace listing page for the extension |
| `codestral-vscode-extension/codestral-ai-0.1.5.vsix` | Locally installable extension package |

## Codestral Agent Extension

Main features:

- Codestral panel in the activity bar.
- Local chat with conversation history.
- Agent mode that can create, edit, and delete multiple files.
- Visible plan, diffs, controlled apply flow, and revert.
- Tests, diagnostics, and correction loop.
- Active file detection and workspace reading.
- Local project index and memory in `.codestral/`.
- Mistral/Codestral model selector.
- Token usage counter.
- Interface and response language settings.
- One-time privilege elevation request through the terminal when a command fails because of permissions.

## Quick Extension Installation

### Microsoft Marketplace

For official Visual Studio Code, install from the Microsoft Marketplace:

```bash
code --install-extension CodestralAgent.codestral-ai
```

Marketplace page:

```text
https://marketplace.visualstudio.com/items?itemName=CodestralAgent.codestral-ai
```

### Open VSX / VSCodium

For VSCodium and editors using Open VSX:

```bash
codium --install-extension CodestralAgent.codestral-ai
```

If you use the Flatpak version of VSCodium:

```bash
flatpak run com.vscodium.codium --install-extension CodestralAgent.codestral-ai
```

If you run this from inside the VSCodium Flatpak terminal:

```bash
flatpak-spawn --host flatpak run com.vscodium.codium --install-extension CodestralAgent.codestral-ai
```

Open VSX page:

```text
https://open-vsx.org/extension/CodestralAgent/codestral-ai
```

### Local VSIX

From this folder:

```bash
cd /home/anar/Libre_Ai_agents/codestral-vscode-extension
npm install
npm run package:vsix
```

Then install the `.vsix` file in VSCodium/VS Code:

```bash
code --install-extension /home/anar/Libre_Ai_agents/codestral-vscode-extension/codestral-ai-0.1.5.vsix
```

For VSCodium Flatpak:

```bash
flatpak run com.vscodium.codium --install-extension /home/anar/Libre_Ai_agents/codestral-vscode-extension/codestral-ai-0.1.5.vsix
```

In VSCodium:

1. Open the Extensions view.
2. Click the `...` menu.
3. Choose `Install from VSIX...`.
4. Select `codestral-ai-0.1.5.vsix`.
5. Reload the window with `Developer: Reload Window`.

## API Configuration

Inside the extension:

1. Open the Codestral icon in the left activity bar.
2. Click `API`.
3. Choose `Open Mistral Console` or `Enter API Key`.
4. Click `Mod` to select an available model.

Mistral Console:

```text
https://console.mistral.ai/codestral
```

## Marketplace Publishing

The Marketplace listing page is located at:

```text
codestral-vscode-extension/README.md
```

To publish:

```bash
cd /home/anar/Libre_Ai_agents/codestral-vscode-extension
npx @vscode/vsce login CodestralAgent
npx @vscode/vsce publish
```

You need a Visual Studio Marketplace publisher account and an Azure DevOps token with the `Marketplace: Manage` permission.

## GitHub Pages

The static site prepared for GitHub Pages is located in:

```text
docs/
```

It contains:

- `docs/index.html`
- `docs/styles.css`
- `docs/assets/codestral-icon.png`
- `docs/downloads/codestral-ai-0.1.5.vsix`
- `docs/.nojekyll`

To enable it on GitHub:

1. Go to `https://github.com/AnARCHIS12/Codestral-Agent`.
2. Open `Settings`.
3. Open `Pages`.
4. Under `Build and deployment`, choose `Deploy from a branch`.
5. Select the `main` branch.
6. Select the `/docs` folder.
7. Click `Save`.

The public URL should be:

```text
https://anarchis12.github.io/Codestral-Agent/
```

After pushing changes, GitHub can take a few minutes before the site appears.

## Security

Never commit a real API key to Git. Use the extension secure storage in VSCodium/VS Code.

The API key is only used to call the Mistral/Codestral API.
