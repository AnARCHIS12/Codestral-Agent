# Codestral Agent

<p align="center">
  <img src="codestral-vscode-extension/icons/codestral-icon.png" alt="Codestral Agent logo" width="128">
</p>

<p align="center">
  <strong>Assistant et agent de code pour VSCodium/VS Code, alimente par Mistral Codestral.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=anar.codestral-ai"><img src="https://img.shields.io/badge/Marketplace-Codestral%20Agent-007ACC?logo=visualstudiocode&logoColor=white" alt="Marketplace"></a>
  <a href="https://github.com/AnARCHIS12/Codestral-Agent"><img src="https://img.shields.io/badge/GitHub-Source-181717?logo=github&logoColor=white" alt="GitHub source"></a>
  <img src="https://img.shields.io/badge/version-0.1.5-0f172a" alt="Version 0.1.5">
  <img src="https://img.shields.io/badge/license-MIT-16a34a" alt="MIT license">
  <img src="https://img.shields.io/badge/VSCodium%20%2F%20VS%20Code-1.75%2B-2563eb" alt="VSCodium and VS Code 1.75+">
  <img src="https://img.shields.io/badge/models-Mistral%20%2F%20Codestral-f97316" alt="Mistral and Codestral">
</p>

## Presentation

Codestral Agent est un projet d'assistant de code base sur Mistral/Codestral. Il contient une interface web de demonstration et surtout une extension VSCodium/VS Code avec chat, historique, selection de modeles, compteur de tokens et mode agent multi-fichiers.

Le but est de proposer une alternative ouverte a un agent de code moderne: lire un projet, comprendre une demande, creer ou modifier des fichiers, afficher les diffs, appliquer les changements, lancer les validations et corriger apres erreur.

Source GitHub :

```text
https://github.com/AnARCHIS12/Codestral-Agent
```

## Contenu Du Projet

| Chemin | Role |
|--------|------|
| `web/` | Petite interface HTML/CSS de demonstration |
| `codestral-vscode-extension/` | Extension VSCodium/VS Code principale |
| `codestral-vscode-extension/README.md` | Fiche Marketplace de l'extension |
| `codestral-vscode-extension/codestral-ai-0.1.5.vsix` | Package installable localement |

## Extension Codestral Agent

Fonctions principales :

- Panneau Codestral dans la barre d'activite.
- Chat local avec historique des conversations.
- Mode agent capable de creer, modifier et supprimer plusieurs fichiers.
- Plan visible, diffs, application controlee et revert.
- Tests, diagnostic et correction en boucle.
- Detection du fichier actif et lecture du workspace.
- Index local et memoire projet dans `.codestral/`.
- Selecteur de modeles Mistral/Codestral.
- Compteur de tokens.
- Parametres de langue pour l'interface et les reponses.
- Demande d'elevation ponctuelle via terminal en cas d'erreur de permissions.

## Installation Rapide De L'Extension

Depuis ce dossier :

```bash
cd /home/anar/Libre_Ai_agents/codestral-vscode-extension
npm install
npm run package:vsix
```

Puis installez le fichier `.vsix` dans VSCodium/VS Code :

```text
codestral-vscode-extension/codestral-ai-0.1.5.vsix
```

Dans VSCodium :

1. Ouvrez la vue Extensions.
2. Cliquez sur le menu `...`.
3. Choisissez `Install from VSIX...`.
4. Selectionnez `codestral-ai-0.1.5.vsix`.
5. Rechargez la fenetre avec `Developer: Reload Window`.

## Configuration API

Dans l'extension :

1. Ouvrez l'icone Codestral dans la barre de gauche.
2. Cliquez sur `API`.
3. Choisissez `Ouvrir la console Mistral` ou `Entrer la cle API`.
4. Cliquez sur `Mod` pour selectionner un modele disponible.

Console Mistral :

```text
https://console.mistral.ai/codestral
```

## Publication Marketplace

La fiche Marketplace est dans :

```text
codestral-vscode-extension/README.md
```

Pour publier :

```bash
cd /home/anar/Libre_Ai_agents/codestral-vscode-extension
npx @vscode/vsce login anar
npx @vscode/vsce publish
```

Il faut un compte publisher Visual Studio Marketplace et un token Azure DevOps avec le droit `Marketplace: Manage`.

## Securite

Ne mettez jamais une vraie cle API dans Git. Utilisez le stockage securise de l'extension pour VSCodium/VS Code.

La cle API est utilisee uniquement pour appeler l'API Mistral/Codestral.
