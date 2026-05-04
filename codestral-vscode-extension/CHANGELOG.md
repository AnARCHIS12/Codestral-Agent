# Changelog

## 0.1.5

- Correction de la validation agent pour les projets HTML/CSS/JS statiques.
- L'agent n'essaie plus de réparer `package.json` quand le script test est seulement un message `echo` ou une instruction d'ouverture navigateur.
- Les projets web simples utilisent un smoke check HTML/CSS/JS et une vérification syntaxe JS quand c'est utile.

## 0.1.4

- Correction de la persistance de la clé API avec fallback local si SecretStorage n'est pas relu correctement.
- Le champ API préremplit maintenant la clé déjà enregistrée.
- Le compteur de tokens est mis à jour après les appels chat, routeur et agent.
- Le dernier usage tokens est restauré après rechargement du panneau.

## 0.1.3

- Correction de la mise en page du panneau Codestral.
- Le modèle actif est affiché en version compacte avec le nom complet en infobulle.
- Les boutons `Hist`, `New`, `Agent` et `Send` restent visibles dans la barre de saisie.

## 0.1.2

- Ajout d'un bouton Agent dans le panneau Codestral.
- Le bouton Agent lance directement `Codestral: Agent Task` avec le texte saisi, sans passer par le chat ni le routeur.

## 0.1.1

- Correction du routage local Agent avant le chat.
- Les demandes comme "améliore le site", "plus moderne", "html/css/styles" passent directement en mode agent.
- Les confirmations comme "ok lance toi", "ok mode agent", "vas-y", "applique" déclenchent l'agent avec l'historique récent.
- La dernière proposition Codestral est mémorisée pour être reprise par le mode agent.

## 0.1.0

- Ajout du panneau Codestral dans la barre d'activité.
- Chat local avec historique de conversations.
- Agent multi-fichiers avec plan, diffs, application, tests et correction en boucle.
- Sélecteur de modèles Mistral/Codestral.
- Compteur de tokens.
- Paramètres de langue pour l'interface et les réponses.
- Demande d'élévation ponctuelle via terminal en cas d'erreur de permissions.
- Packaging VSIX.
