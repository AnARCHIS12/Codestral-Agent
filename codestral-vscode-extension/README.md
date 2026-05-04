# Codestral Agent

Agent de code pour VSCodium et VS Code, alimenté par Mistral/Codestral.

Cette page sert de fiche Marketplace et de page "A propos" de l'extension.

## Apercu Marketplace

Codestral Agent ajoute un assistant de code dans la barre laterale. Il peut discuter avec le projet, lire le workspace, proposer des patchs multi-fichiers, lancer les tests, corriger apres erreur, garder l'historique des conversations et afficher l'utilisation des tokens.

### Version actuelle 0.1.5

- Correction de la validation agent pour les projets HTML/CSS/JS statiques.
- L'agent n'essaie plus de réparer `package.json` quand le script test est seulement un message `echo` ou une instruction d'ouverture navigateur.
- Les projets web simples utilisent un smoke check HTML/CSS/JS et une vérification syntaxe JS quand c'est utile.
- Correction de la persistance de la clé API avec fallback local si SecretStorage n'est pas relu correctement.
- Le champ API préremplit maintenant la clé déjà enregistrée.
- Le compteur de tokens est mis à jour après les appels chat, routeur et agent.
- Le dernier usage tokens est restauré après rechargement du panneau.
- Correction de la mise en page du panneau Codestral.
- Le modèle actif est affiché en version compacte avec le nom complet en infobulle.
- Les boutons `Hist`, `New`, `Agent` et `Send` restent visibles dans la barre de saisie.
- Le bouton `Agent` lance directement `Codestral: Agent Task` avec le texte saisi, sans passer par le chat ni le routeur.
- Les demandes comme "améliore le site", "plus moderne", "html/css/styles" passent directement en mode agent.
- Les confirmations comme "ok lance toi", "ok mode agent", "vas-y", "applique" déclenchent l'agent avec l'historique récent.

### Base 0.1.0

- Ajout du panneau Codestral dans la barre d'activité.
- Chat local avec historique de conversations.
- Agent multi-fichiers avec plan, diffs, application, tests et correction en boucle.
- Sélecteur de modèles Mistral/Codestral.
- Compteur de tokens.
- Paramètres de langue pour l'interface et les réponses.
- Demande d'élévation ponctuelle via terminal en cas d'erreur de permissions.
- Packaging VSIX.

### Points forts

- Chat integre dans la barre d'activite
- Agent multi-fichiers pour creer, modifier et supprimer des fichiers du workspace
- Diffs avant application et validation globale avant ecriture
- Lecture intelligente du projet avec index local
- Tests, diagnostic et correction en boucle
- Historique local des conversations
- Selection des modeles disponibles avec votre cle API
- Compteur de tokens discret
- Interface multilingue
- Demande d'elevation ponctuelle via terminal si une commande echoue par permissions

### Installation Rapide

1. Installez le fichier `.vsix`.
2. Ouvrez l'icone Codestral dans la barre de gauche.
3. Cliquez sur `API`.
4. Choisissez `Ouvrir la console Mistral` pour recuperer une cle, ou `Entrer la cle API`.
5. Cliquez sur `Mod` pour choisir un modele disponible.
6. Decrivez ce que vous voulez coder.

Console Mistral :

```text
https://console.mistral.ai/codestral
```

### Donnees Locales

L'extension sauvegarde localement la cle API, les conversations, l'index du workspace, le dernier patch agent, le modele actif et les preferences de langue.

La cle API est envoyee uniquement a l'API Mistral lorsque vous utilisez l'extension.

### Securite

Codestral Agent travaille dans le workspace ouvert. Il ne lance pas `sudo` automatiquement. Si une commande echoue a cause des permissions, il demande confirmation puis ouvre un terminal ou vous saisissez vous-meme votre mot de passe.

---

# Documentation Complete

Alternative open-source à GitHub Codex utilisant **Codestral de Mistral AI**.

Cette extension offre un assistant de code dans la barre latérale : vous décrivez la tâche en langage naturel, Codestral lit le contexte du fichier actif et répond comme un agent de développement.

## Fonctionnalités

- **Complétion de code** - Génération de code basée sur votre contexte
- **Chat latéral intégré** - Assistant dans la barre gauche avec contexte du fichier actif
- **Mode agent complet** - Plan dans la sidebar, patchs multi-fichiers, diffs partiels, apply/reject par fichier, tests, stop/rerun, correction en boucle et revert persistant
- **Index local du projet** - Résumé persistant des fichiers pour mieux travailler sur les gros projets
- **Multi-langages** - Supporte Python, JavaScript, TypeScript, Java, C++, Go, Rust, etc.
- **Configuration facile** - Clé API stockée en toute sécurité
- **Autocomplétion inline** - Suggestions automatiques pendant la saisie

## Installation

### Méthode 1 : Depuis le marketplace VS Code (bientôt disponible)

1. Ouvrez VS Code
2. Allez dans Extensions (Ctrl+Shift+X)
3. Recherchez "Codestral AI"
4. Cliquez sur Installer

### Méthode 2 : Installation manuelle

```bash
# Cloner le dépôt
cd Libre_Ai_agents/codestral-vscode-extension

# Installer les dépendances
npm install

# Compiler le code TypeScript
npm run compile

# Ouvrir dans VS Code et lancer le debug (F5)
code .
```

### Méthode 3 : Installer depuis un fichier .vsix

```bash
# Compiler et package l'extension
npm install
npm run compile
vsce package

# Installer le .vsix généré dans VS Code
# (Extensions -> ... -> Install from VSIX...)
```

## Configuration

### 1. Définir votre clé API

**Via la commande :**
1. Ouvrez la palette de commandes (Ctrl+Shift+P)
2. Tapez "Codestral: Set API Key"
3. Entrez votre clé API (ex: `2CY5...`)

**Via les paramètres :**
1. Ouvrez les paramètres (Ctrl+,)
2. Recherchez "codestral-ai.apiKey"
3. Entrez votre clé API

### 2. Paramètres disponibles

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| `codestral-ai.apiKey` | Votre clé API Codestral | "" |
| `codestral-ai.model` | Modèle utilisé par le chat, l'agent et la complétion | "codestral-latest" |
| `codestral-ai.responseLanguage` | Langue des réponses du chat et de l'agent | "français" |
| `codestral-ai.interfaceLanguage` | Langue de l'interface du panneau Codestral | "français" |
| `codestral-ai.experimentalModels` | Modèles proposés par le sélecteur de modèle | codestral-latest, codestral-2508, mistral-large-latest |
| `codestral-ai.maxTokens` | Nombre max de tokens générés | 200 |
| `codestral-ai.agentMaxTokens` | Nombre max de tokens pour le chat agent | 4000 |
| `codestral-ai.temperature` | Créativité (0.0-1.0) | 0.7 |
| `codestral-ai.testCommand` | Commande utilisée par le diagnostic de tests | "npm test" |
| `codestral-ai.agentMaxIterations` | Cycles max appliquer/tester/corriger du mode agent | 2 |
| `codestral-ai.reviewPatchByFile` | Sélection fichier par fichier avant application | false |
| `codestral-ai.askForPrivilegeElevation` | Demander une relance avec sudo si permission refusée | true |

## Utilisation

### Commandes disponibles

| Commande | Description |
|----------|-------------|
| `Codestral: Set API Key` | Configurer votre clé API |
| `Codestral: Show Available Models` | Récupérer les modèles disponibles avec la clé API |
| `Codestral: Settings` | Ouvrir le menu de paramètres Codestral |
| `Codestral: Select Model` | Changer de modèle, y compris expérimental si votre clé le permet |
| `Codestral: Complete Code` | Compléter le code à l'endroit du curseur |
| `Codestral: Chat` | Ouvrir une conversation avec Codestral |
| `Codestral: Explain Selection` | Expliquer la sélection ou le fichier actif |
| `Codestral: Fix Selection` | Corriger la sélection et proposer un remplacement |
| `Codestral: Generate Tests` | Générer des tests pour la sélection ou le fichier actif |
| `Codestral: Review File` | Relire le fichier actif et lister les risques |
| `Codestral: Agent Task` | Générer un patch multi-fichiers, afficher les diffs, appliquer, tester et corriger |
| `Codestral: Revert Last Agent Patch` | Restaurer les fichiers sauvegardés avant le dernier patch agent |
| `Codestral: Rebuild Workspace Index` | Reconstruire l'index local persistant du projet |
| `Codestral: Stop Agent Command` | Arrêter la commande agent en cours |
| `Codestral: Rerun Agent Command` | Relancer la dernière commande agent |
| `Codestral: Plan Task` | Construire un plan d'implémentation à partir du workspace |
| `Codestral: Review Workspace` | Relire un aperçu du workspace complet |
| `Codestral: Run Tests and Diagnose` | Lancer une commande de test et demander un diagnostic à Codestral |

### Raccourcis clavier (optionnels)

Ajoutez ces raccourcis à votre `keybindings.json` :

```json
{
    "key": "ctrl+alt+c",
    "command": "codestral-ai.completeCode",
    "when": "editorTextFocus"
},
{
    "key": "ctrl+alt+shift+c",
    "command": "codestral-ai.chat"
}
```

## Exemples

### Complétion de code

1. Placez votre curseur dans votre code
2. Appuyez sur `Ctrl+Alt+C` ou exécutez "Codestral: Complete Code"
3. Le code généré sera inséré automatiquement

**Exemple :**
```python
# Avant
 Def calculate_factorial(n):
     if n <= 1:
         return 1

# Après exécution de la commande
 Def calculate_factorial(n):
     if n <= 1:
         return 1
     else:
         return n * calculate_factorial(n - 1)
```

### Chat

1. Appuyez sur `Ctrl+Alt+Shift+C` ou exécutez "Codestral: Chat"
2. Posez votre question (ex: "Comment optimiser cette fonction ?")
3. La réponse s'affichera dans un nouvel onglet

## API Endpoints

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/v1/fim/completions` | Complétion de code (Fill-in-the-middle) |
| POST | `/v1/chat/completions` | Chat et questions/réponses |

**Base URL:** `https://codestral.mistral.ai/v1`

## Développement

### Prérequis

- Node.js 18+
- npm 9+
- VS Code
- Yeoman et VS Code Extension Generator (optionnel)

### Structure du projet

```
codestral-vscode-extension/
├── src/
│   └── extension.ts      # Code principal de l'extension
├── package.json          # Configuration de l'extension
├── tsconfig.json         # Configuration TypeScript
├── .vscodeignore         # Fichiers à ignorer pour le packaging
├── .gitignore
└── README.md
```

### Compiler et tester

```bash
# Installer les dépendances
npm install

# Compiler
npm run compile

# Générer un .vsix installable
npm run package:vsix

# Lancer en mode debug (F5 dans VS Code)
# ou
npm run watch
```

## 🔒 Sécurité

- ⚠️ **Ne partagez jamais votre clé API**
- La clé est stockée dans les paramètres VS Code ou dans le globalState
- Elle n'est jamais envoyée à des tiers

## 📄 Licence

MIT License - Libre d'utiliser, modifier et distribuer.

## 🤝 Contribuer

1. Fork le projet
2. Créez une branche (`git checkout -b feature/ma-fonctionnalité`)
3. Commitez vos changements (`git commit -m 'Ajout de ma fonctionnalité'`)
4. Poussez (`git push origin feature/ma-fonctionnalité`)
5. Ouvrez une Pull Request

## 📚 Ressources

- [Documentation Codestral](https://docs.mistral.ai/api/codestral)
- [Mistral AI](https://mistral.ai)
- [VS Code Extension API](https://code.visualstudio.com/api)

---

**Alternative open-source à GitHub Codex, alimentée par Mistral AI Codestral.**
