# Collecte Slack vers les tâches

Copier [l’exemple](../../scripts/slack-task-rules.example.json) vers `slack-task-rules.json` dans le `stateDir` du serveur (harness : `.t3/harness/userdata`). Renseigner l’identifiant du workspace et les chemins absolus, puis mettre `enabled` à `true`. Le profil Codex choisi doit déjà disposer du connecteur Slack ; `collector.linkId` permet de choisir le compte. La collecte refuse un compte exposant plusieurs workspaces, car la recherche ne permet pas de les distinguer.

Le premier passage fixe le début de collecte à cet instant. Le serveur relève ensuite les nouveaux messages reçus chaque minute, y compris les réponses à d’anciens fils, sans modifier Slack ni lancer d’agent. La recherche dépend de l’indexation Slack ; les cinq dernières minutes sont relues pour rattraper son délai habituel. Une erreur conserve la progression pour une nouvelle tentative.

Chaque message admissible crée une tâche **À qualifier**. Les réponses rejoignent la tâche du même fil tant qu’elle est à qualifier. Les identifiants importés restent mémorisés après suppression d’une tâche pour éviter sa recréation.

Les agents partagent ce fichier : exclusions par nom de conversation, identifiant d’auteur ou texte contenu. Les noms et textes sont comparés sans tenir compte de la casse. Enregistrer les modifications par remplacement atomique ; elles prennent effet au prochain passage. Mettre `enabled` à `false` suspend la collecte, sans effacer son historique.

Les outils MCP `slack_tasks_status` et `slack_tasks_sync` permettent de consulter la configuration/progression et de déclencher un passage. Les messages sources apparaissent dans les détails des tâches sur le web et le bureau ; le client mobile natif n’a pas encore de page Tâches.
