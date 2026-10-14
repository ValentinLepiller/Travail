# MT Harness — 14 octobre 2026

Base [MT Code](https://github.com/munimtechnologies/mtcode) `63c035c5e5a0cfdcdd4dbabe798cc9efe06f9b93`, serveur/desktop `0.0.56`. Historique et licences conservés ; remote MT pour fetch, push désactivé. Conventions Effect/SQLite/React existantes conservées.

## Fonctionnement vérifié

- **Agents** : Codex natif avec abonnement ChatGPT, sous-agent, instructions/skills et projet racine. Authentification et installation Codex globales préservées ; le runtime possède aussi sa baseline dédiée.
- **Coordinateur** : scénario réel entre deux projets ; lancement, résultat terminal, nouvelle consigne pendant travail, réessai idempotent et interruption effective.
- **Voix** : WebRTC natif avec audio synthétique ; retour exact immédiat et tardif, nouvelle consigne prioritaire. Résultat conservé dans la conversation ; depuis un nouveau chat, le clic vocal crée la conversation sans message artificiel et conserve le brouillon. Dans ce mode, la voix API est désactivée avec une erreur explicite ; aucun repli payant.
- **Bureaux** : sessions Linux isolées, deux agents simultanés, captures et saisies réelles ; dialogue humain, transfert/restitution et fermeture sélective vérifiés. Bureau personnel non piloté. Browser MT réel également vérifié.
- **Connecteurs/contexte** : Gmail et Slack natifs indépendants du pont Desktop, lectures réelles ; accès borné à l’ancien historique et aux mémoires. Aucun envoi pour les tests. Outils documents/PDF existants réutilisés ; Teams/WhatsApp nécessitent leur accès propre.
- **Récurrences** : scheduler MT persistant, fuseau Paris, preuves de rattrapage et récupération sur serveur isolé sans client.
- **HTTPS** : Quick Tunnel Cloudflare gratuit, URL variable acceptée ; auth/appairage/révocation MT, HTTP/WS TLS vérifiés sur environnement isolé.

## Maintenance et lancement

Gate commun pour nouvelles mutations RPC/HTTP/MCP, dispatch, scheduler, voix et bureaux ; lectures et annulations disponibles. Refus si travail, appel, bureau, PTY ouvert, continuation pending ou activité native en arrière-plan. Le transfert source→file ne perd pas une offre pendant fermeture. Le service hôte est activé et sain, avec home Codex privé. Sur le bundle final, sept contrôles du gate passent : refus anonymes et droits insuffisants, quiescence idle, nouveaux lancements bloqués, lecture maintenue, idempotence et libération. Tunnel HTTPS partagé actif et health vérifié.

Contrôleur autonome de préparation/promotion/récupération, sauvegarde complète, readiness authentifiée et rollback préparés et testés en isolation. Timer de vérification activé à 04:00 Europe/Paris avec jitter ; préparation, adaptation et promotion automatiques configurables, avec admission sur runtime réellement inactif. Linger configuré ; reboot/logout réel non testé.

```sh
corepack pnpm install --frozen-lockfile
node_modules/.bin/vp run --filter t3 build
node --run harness:start
```

État : `.t3/harness`, service utilisateur `mt-harness.service` actif sur `http://127.0.0.1:3773`. Codex utilise `.t3/harness/codex`, inclus dans les sauvegardes, sans importer les anciennes DB natives. Un seul serveur par home ; les réglages existants sont préservés. Procédures durables : `ops/harness/`. Aucun push.

## Validation restante

Build final et gate compilé validés ; HTTPS partagé et passage UI intégrés validés (nouvelle tâche, deux bureaux, transfert/restitution et fermeture). Le téléphone réel reste à vérifier : micro/son, latence, interruption audio, reconnexion, changement de réseau, arrière-plan et écran verrouillé. Ces preuves ne sont pas remplacées par un viewport mobile ou une sonde synthétique. Conserver Codex Desktop comme repli.

Typechecks sans erreur de type ; code non nul du checker reproduit sur des warnings de directives préexistants dans trois fichiers amont inchangés.

Tests ciblés, lint, captures et traces : `.logs/harness/`. Ne pas diffuser les logs bruts contenant des codes d’appairage. `$simplify` appliqué aux changements ; aucune vérification repo-wide.
