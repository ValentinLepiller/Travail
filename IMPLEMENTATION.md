# Travail — harness MT personnalisé

Base [MT Code](https://github.com/munimtechnologies/mtcode) `63c035c5e5a0cfdcdd4dbabe798cc9efe06f9b93`, serveur/desktop `0.0.56`. Historique et licences conservés ; remote MT pour fetch, push désactivé. Conventions Effect/SQLite/React existantes conservées.

## Fonctionnement vérifié

- **Agents** : Codex natif avec abonnement ChatGPT, sous-agent, instructions/skills et projet racine. Authentification et installation Codex globales préservées ; le runtime possède aussi sa baseline dédiée.
- **Coordinateur** : scénario réel entre deux projets ; lancement, résultat terminal, nouvelle consigne pendant travail, réessai idempotent et interruption effective.
- **Voix** : WebRTC natif avec audio synthétique ; retour exact immédiat et tardif, nouvelle consigne prioritaire. Accusé natif et conversation pendant le travail vérifiés sur un même flux RTC synthétique (seconde question sans relance, puis résultat exact). Résultat conservé dans la conversation ; depuis un nouveau chat, le clic vocal crée la conversation sans message artificiel et conserve le brouillon. Dans ce mode, la voix API est désactivée avec une erreur explicite ; aucun repli payant. Valentin a confirmé sur téléphone le parcours nouveau chat→voix sans texte→délégation→réponse audio.
- **Bureaux** : sessions Linux isolées, deux agents simultanés, captures et saisies réelles ; dialogue humain, transfert/restitution et fermeture sélective vérifiés. Bureau personnel non piloté. Browser MT réel également vérifié.
- **Connecteurs/contexte** : Gmail et Slack natifs indépendants du pont Desktop, lectures réelles ; accès borné à l’ancien historique et aux mémoires. Aucun envoi pour les tests. Outils documents/PDF existants réutilisés ; Teams/WhatsApp nécessitent leur accès propre.
- **Récurrences** : scheduler MT persistant, fuseau Paris, preuves de rattrapage et récupération sur serveur isolé sans client.
- **HTTPS** : Quick Tunnel Cloudflare gratuit, URL variable acceptée ; auth/appairage/révocation MT, HTTP/WS TLS vérifiés sur environnement isolé.

## Application Electron

Installée le 27 octobre : **Travail** dans le menu Linux, ou `travail` dans un terminal. Recompiler/réinstaller : `node --run harness:desktop:install`. Client Electron MT complet, profil séparé, connexion automatique au serveur existant ; fermer la fenêtre laisse le service actif. Le dossier du dépôt et ses dépendances sont nécessaires à cette installation locale. Nom web également changé ; crédits/licences MT/T3 conservés.

Vérifiés : fenêtre dans un affichage isolé, conversations existantes, connexion ChatGPT rétablie, lanceur visible, service conservé après arrêt du client ; tests ciblés et typecheck desktop sans erreur de type (suggestions amont). Preuves : `.logs/harness/desktop-travail/`. La voix n’a pas été retestée sur téléphone.

Barre latérale : projets visibles par défaut, raccourci de création de chat par projet et menu œil à cases multiples. Le choix est conservé sur cet appareil ; l’ancien filtre à projet unique est abandonné. Tests ciblés : 178 réussis.

## Maintenance et lancement

Gate commun pour nouvelles mutations RPC/HTTP/MCP, dispatch, scheduler, voix et bureaux ; lectures et annulations disponibles. Refus si travail, appel, bureau, PTY ouvert, continuation pending ou activité native en arrière-plan. Le transfert source→file ne perd pas une offre pendant fermeture. Le service hôte est activé et sain, avec home Codex privé. Sur le bundle final, sept contrôles du gate passent : refus anonymes et droits insuffisants, quiescence idle, nouveaux lancements bloqués, lecture maintenue, idempotence et libération. Tunnel HTTPS partagé actif et health vérifié.

Contrôleur autonome de préparation/promotion/récupération, sauvegarde complète, readiness authentifiée et rollback préparés et testés en isolation. Timer de vérification activé à 04:00 Europe/Paris avec jitter ; préparation, adaptation et promotion automatiques activées dans la config privée, avec admission sur runtime réellement inactif et sans upgrade immédiat. Linger configuré ; reboot/logout réel non testé.

```sh
corepack pnpm install --frozen-lockfile
node_modules/.bin/vp run --filter t3 build
node --run harness:start
```

État : `.t3/harness`, service utilisateur `mt-harness.service` actif sur `http://127.0.0.1:3773`. Codex utilise `.t3/harness/codex`, inclus dans les sauvegardes, sans importer les anciennes DB natives. Un seul serveur par home ; les réglages existants sont préservés. Procédures durables : `ops/harness/`. Aucun push.

## Validation restante

Build final et gate compilé validés ; HTTPS partagé et passage UI intégrés validés (nouvelle tâche, deux bureaux, transfert/restitution et fermeture). Sur téléphone, le parcours vocal de base est confirmé par Valentin ; la fluidité après le correctif reste à confirmer. Une sonde par version a observé l’accusé à 0,976 s après handoff, contre 13,015 s avant activation de l’accusé natif ; ce n’est pas une statistique de performance ni une mesure téléphone. Restent non testés : latence téléphone, interruption audio, reconnexion, changement de réseau, arrière-plan et écran verrouillé. Conserver Codex Desktop comme repli.

Typechecks sans erreur de type ; code non nul du checker reproduit sur des warnings de directives préexistants dans trois fichiers amont inchangés.

Tests ciblés, lint, captures et traces : `.logs/harness/`. Ne pas diffuser les logs bruts contenant des codes d’appairage. `$simplify` appliqué aux changements ; aucune vérification repo-wide.
