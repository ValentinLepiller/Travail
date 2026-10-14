# MT Harness — tranche initiale, 14 octobre 2026

## Base et lancement

- [MT Code](https://github.com/munimtechnologies/mtcode), commit `63c035c5e5a0cfdcdd4dbabe798cc9efe06f9b93` du 13 octobre ; packages serveur/desktop `0.0.56`. Historique complet importé, licences Apache-2.0/MIT et NOTICE conservées. SPECS.md préservé.
- Remote `mt` pour les fetchs ; push désactivé. Suivre MT comme amont direct. Préparer ses prochains merges sur une branche et un environnement séparés ; T3 reste une référence, pas une base de remplacement.
- Node `24.18.0`, pnpm `11.10.0`. Conventions MT conservées : Effect, SQLite, React/Vite et TanStack Router. Aucun changement d’architecture imposé.

```sh
corepack pnpm install --frozen-lockfile
node_modules/.bin/vp run --filter t3 build
node --run harness:start
```

Le serveur compilé est laissé en fonctionnement sur `http://127.0.0.1:3773`, avec l’onglet intégré ouvert sur la tâche du projet racine. Il s’agit du processus de validation ; aucun service de démarrage automatique n’est installé. Utiliser le lien d’appairage privé affiché au démarrage. `node --run harness:dev` lance le développement ; `node --run harness:prepare` initialise seulement les réglages. L’état MT est dans `.t3/harness`, indépendant des installations quotidiennes. Les relances préservent les réglages existants. Ne pas lancer deux serveurs simultanément sur ce même état.

## Livré et vérifié

- Codex **existant**, connecté à ChatGPT Pro : `codex-cli 0.159.3`, home `~/.codex`, modèle GPT-6.1 Sol / High. Aucun login, logout ou update global effectué. Le mode MT « managed » désactive les sous-agents : il n’est pas utilisé.
- 92 skills détectés par le moteur natif, sans erreur. Instructions globales/projet accessibles par le chemin natif ; aucune migration de l’ancien historique ni des mémoires.
- Requête réelle dans MT : `MT_NATIVE_OK`. Délégation native réelle : un sous-agent répond `MT_CHILD_OK`, puis le parent termine avec `MT_DELEGATION_OK`. Les événements et la filiation sont visibles dans MT.
- Projet `harness` ajouté à `/home/valentin/Documents/ChatGPT/harness`, preuves du projet de test `apps/server` conservées. Une tâche à la racine a exécuté `pwd` et répondu `MT_ROOT_OK /home/valentin/Documents/ChatGPT/harness`. Le regroupement UI affiche aussi l’identité amont `munimtechnologies/mtcode`.
- Contrôle du bureau actif désactivé : réglage `desktopControl.enabled=false`, flags natifs `computer_use`, `browser_use`, `in_app_browser` désactivés ; `multi_agent` activé. Le MCP MT reste disponible : appel réel `preview_status` réussi, avec `available:false` dans ce client web. Un navigateur preview MT utilisable reste à vérifier avec son client dédié ; les bureaux isolés par agent restent à développer.

Principaux changements : scripts `harness.ts` et `lib/harness-home.ts`, trois commandes package, dépendance interne contracts pour la validation et section locale AGENTS.md. Le bootstrap crée exclusivement un nouveau fichier de réglages ; il n’écrase pas un fichier existant.

## Vérifications et preuves

- Installation avec lockfile figé réussie avant et après les changements. Build web + serveur réussi ; avertissements amont de taille de chunks.
- 30 tests ciblés passent : bootstrap, arguments Codex, commande voix, session voix et instructions navigateur. Après simplification, les 3 tests bootstrap, le typecheck du package scripts, le lint ciblé et `git diff --check` passent.
- Le dev serveur a démarré et migré son état isolé ; le navigateur de dev a rencontré un chargement de module dynamique après arrêt. Le parcours visuel et les requêtes réelles ont été validés sur la **version compilée**.
- `$simplify` appliqué localement : vérification réutilisation/qualité/efficacité, décodeurs de test compilés une fois, imports conformes et export inutile supprimé.
- Preuves locales, gitignorées : `.logs/harness/evidence/` (captures `native-codex.png`, `native-delegation.png`, `mt-preview-status.png`, `root-project.png`, instantanés UI et sondes Codex JSON). Les logs install/build/tests/lint/types y sont conservés. Ne pas diffuser les logs bruts de démarrage : ils contiennent des codes d’appairage.

## Suite face à SPECS.md

| Besoin              | État et suite                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinateur        | Sous-agents natifs vérifiés. MT possède aussi ses outils MCP projets/tâches ; le parcours du coordinateur entre projets autorisés reste à configurer et tester. Une acceptation de consigne n’est pas une fin de travail.                                                                                                                                                                                                                                         |
| Voix                | Transport Codex account/GPT-Live et délégation au modèle sélectionné présents dans MT ; tests de session/commande inclus dans les tests ciblés. Le flag natif realtime est actif, sans preuve d’éligibilité GPT-Live du compte ni d’appel audio. Aucun repli API payant activé.                                                                                                                                                                                   |
| Accès distant       | Auth/appairage et transports distants existent dans MT. Cette tranche est **locale uniquement**. Il reste une route HTTPS authentifiée (tailnet/tunnel), l’appairage du téléphone et les essais audio/reconnexion/arrière-plan. La commande Tailscale n’est pas disponible dans le PATH de cet hôte.                                                                                                                                                              |
| Gmail/Slack         | Outils découverts via le MCP `codex_apps` existant, authentifié par bearer token. Appels réels exécutés dans MT : Gmail `get_profile` et Slack `slack_list_workspaces`, un appel chacun, accès confirmés. Aucun message lu, brouillon créé ou envoi effectué. Recherche/lecture de contenu et brouillons restent à tester selon les autorisations. Ce raccord dépend actuellement du pont MCP local existant ; son autonomie hors Codex Desktop reste à vérifier. |
| Sessions graphiques | Xvfb installé ; aucune session graphique créée et aucun bureau personnel piloté. Lifecycle, profils indépendants, contrôle et restitution restent à raccorder aux agents.                                                                                                                                                                                                                                                                                         |
| Récurrences         | Scheduler et tâches persistantes existants dans MT, avec gestion des échéances manquées. Aucun service permanent ni tâche ajouté ; fuseaux, absence de doublons et historique restent à tester.                                                                                                                                                                                                                                                                   |
| Maintenance         | Aucun update de l’installation quotidienne activé. Restent la veille quotidienne (horaire à définir), préparation isolée, validation, installation hors tâches actives et rollback indépendant de MT.                                                                                                                                                                                                                                                             |

Prochaine tranche : configurer le coordinateur avec les outils MT existants, lui faire consulter puis piloter une tâche dans un autre projet autorisé, et vérifier qu’il restitue le résultat terminé. Ce travail et la préparation du service hôte peuvent avancer sans téléphone.

Pour finir le parcours vocal distant, les dépendances réelles sont une route HTTPS privée/authentifiée et un essai micro/son sur le téléphone ; l’accès GPT-Live du compte reste à confirmer lors de cet essai. Aucun besoin de nouveau login Codex n’a été constaté. L’autonomie du pont Gmail/Slack hors Desktop reste une vérification à mener, pas une panne constatée. Conserver Codex Desktop comme repli.

Référence pour le chemin natif : [OpenAI — Codex App Server](https://learn.chatgpt.com/docs/app-server). Les capacités détectées ne garantissent pas l’accès effectif à une offre vocale ou à un compte externe.
