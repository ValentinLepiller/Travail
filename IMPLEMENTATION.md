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

Barre latérale : projets visibles par défaut, raccourci de création de chat par projet et menu œil à cases multiples. Le choix est conservé sur cet appareil ; l’ancien filtre à projet unique est abandonné. Tests ciblés : 178 réussis. Conversations et brouillons regroupés sous leur projet ; pagination par projet. Correctif installé le 28 octobre sans redémarrage ; HTML et fichiers référencés vérifiés en HTTP 200, sauvegarde locale conservée.

Ouverture dans un éditeur : VS Code prioritaire sans préférence disponible ; choix explicites conservés. Résolution commune bouton/fichiers, 13 tests ciblés réussis, lint et format vérifiés. Non installé dans le runtime quotidien.

Codex : la fin du processus invalide maintenant la session morte pour permettre une reprise au prochain message. 248 tests ciblés réussis, dont sorties 0/9 ; régression reproduite sans le correctif. Installé le 28 octobre 2026 après sauvegarde et redémarrage autorisé malgré un plan orphelin ; santé serveur et connexion Codex authentifiée vérifiées.

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

Icône Travail : image fournie avec coins arrondis transparents appliquée au lanceur Linux, aux fenêtres (Alt‑Tab), à la zone de notification, à l’icône native par défaut et aux favicons/écran de démarrage web. Trois tests DesktopAssets passent ; contrôle visuel Alt‑Tab restant après réouverture de l’application. Relecture `$simplify` effectuée.

Fond Travail : dégradé violet/noir étoilé statique dans l’en-tête gauche, fondu existant conservé (web et Electron, tiroir web mobile). SVG et formatage validés ; 16 tests SidebarStageBackdrop réussis ; relecture `$simplify` effectuée. Client Travail recompilé et installé le 28 octobre 2026 ; présence du SVG et de sa référence vérifiée dans le bundle installé. Serveur conservé actif ; contrôle visuel restant après rechargement du client.

## Liste de tâches — première version locale

Vue `/tasks` (navigation verticale à gauche avec libellés sur grand écran, menu mobile et palette) : création, notes, projet, échéance, statuts manuels, filtres, édition, suppression et réouverture. Attribution à une conversation existante avec lien direct vers l’agent ; aucun lancement automatique. SQLite côté hôte, mises à jour diffusées aux clients, conflits d’édition détectés. Surface web/desktop et navigateur mobile ; interface native mobile et création depuis le chat restent à raccorder.

Preuves : 37 tests ciblés (service, autorisations serveur/client), typage web/serveur et lint ciblé. Serveur et client desktop installés avec Requêtes le 29 octobre 2026 ; migration, abonnement RPC authentifié et route HTTP vérifiés. Pas de vérification par navigateur automatisé.

Connecteurs : comptes détectés depuis les schémas Codex, sélection explicite en cas de comptes multiples ; sonde Gmail/Slack en lecture réussie, 19 tests ciblés. Installés avec la release commune le 29 octobre 2026 ; délégation validée avec Codex 0.165.0.

Collecte Slack installée et activée le 29 octobre 2026 à 19 h 19 : nouveaux messages depuis l’activation, chaque minute, règles JSON partagées rechargeables, exclusions `le-fond`/`general`, tâches **À qualifier**, réponses regroupées et déduplication persistante. Aucun historique, marquage lu ni lancement d’agent. Redémarrage explicitement autorisé, sauvegarde complète et dernières modifications du client préservées. Preuves : 85 tests ciblés initiaux, 42 tests de reprise, builds serveur/web et typage web, sept validations de maintenance, revue `$simplify` ; santé, migration, intégrité SQLite, RPC tâches et première collecte réussis (aucun nouveau message admissible au premier passage). Promotion `committed`, suivi : `.t3/harness-operations/manual-slack-tasks-update/status.json`. Sonde vocale réelle facultative, tests de régression conservés. Pas de test navigateur. [Règles](docs/operations/slack-tasks.md).

## Requêtes — version locale

Vue `/requests` : file à gauche, carte courante, passage automatique à la suivante et archives ; approbation, refus commenté, réponse écrite et modification sur la même fiche. Markdown, images et Mermaid réutilisent le rendu du chat. Actions par commande figée (limite 120 s) ou retour à l’agent avec compte rendu ; reprise/steering existants, droits contrôlés, résultats persistés et absence de rejeu automatique après interruption. Outils MCP et instructions communes aux fournisseurs ajoutés. Consignes renforcées : approbation par défaut pour les propositions et confirmations ; texte réservé aux informations libres indispensables (modification source, non installée). Web/Electron et navigateur mobile ; pas de vue React Native dédiée.

Preuves : 80 tests ciblés, builds serveur/web et typage ciblé ; relecture `$simplify` effectuée. Installation commune Tâches + Requêtes confirmée le 29 octobre 2026 : promotion `committed`, serveur actif, sauvegarde complète conservée, migrations `agent_requests` et `work_tasks`, abonnements RPC authentifiés et routes `/requests` et `/tasks` vérifiés. Client desktop identique à la release validée ; contrôle visuel restant après rechargement. Sept contrôles fonctionnels réussis avec Codex 0.165.0 ; garde contre les rétrogradations (38 tests de maintenance) et exclusion des anciens plans terminés (20 tests ciblés). Redémarrage exceptionnel autorisé effectué après contrôle des travaux réels, sans nettoyage de l’historique. Suivi : `.t3/harness-operations/manual-requests-update/status.json`.

Sélection du serveur corrigée dans Requêtes et Tâches pour le client Travail sans backend principal : connexion enregistrée détectée automatiquement, choix manuel conservé. Correctif client installé le 29 octobre sans redémarrage ; 8 tests ciblés, typage web, lint, build et fichiers servis vérifiés, relecture `$simplify` effectuée. Preuve : `.t3/harness-operations/manual-requests-connection-fix/status.json`.

Fusion locale Tâches : `c579c919f` sur `main`. L’installateur séparé a été remplacé par la release commune `requests-tasks-20261028`.

Navigation web mobile : Discussions, Requêtes et Tâches déplacés en haut du tiroir, accessibles aussi depuis les pages utilitaires ; fermeture du tiroir à la sélection. Destinations partagées avec le rail desktop, anciens raccourcis de pied supprimés. Relecture simplification locale ; validation visuelle et installation restantes.

Requêtes : pastille du nombre à traiter sur le rail desktop/web et le menu du navigateur mobile, actualisée par l’abonnement existant et masquée à zéro. Typage web et lint ciblé validés ; relecture `$simplify` locale effectuée. Client web/desktop installé le 29 octobre sans redémarrage du serveur ; fichiers servis vérifiés, sauvegarde conservée. Contrôle visuel non effectué. Preuve : `.t3/harness-operations/manual-requests-badge/status.json`.

Cartes des discussions : projet (logo et nom) et dernière ligne de métadonnées retirés ; hauteur réduite. Web/Electron et navigateur mobile. Relecture `$simplify` locale, typage web et 195 tests Sidebar réussis ; lint sans erreur (avertissements existants). Client web/desktop installé le 29 octobre sans redémarrage du serveur ; fichiers servis vérifiés, sauvegarde conservée. Contrôle visuel non effectué. Preuve : `.t3/harness-operations/manual-task-cards/status.json`.

Cartes des discussions sur une ligne : titre à gauche, statut et durée à droite ; Done et Working masqués visuellement, icônes/couleurs et libellés accessibles conservés. Relecture `$simplify` locale : conteneurs superflus supprimés, logique de statut et minuterie réutilisées. Typage web, 195 tests Sidebar et lint sans erreur validés. Client web/desktop installé le 29 octobre sans redémarrage ; fichiers servis vérifiés et sauvegarde conservée. Contrôle visuel non effectué. Preuve : `.t3/harness-operations/manual-task-single-line/status.json`.

Groupes de projets : séparateur et fond discret à la couleur de l’icône (couleur automatique en repli), web/Electron et navigateur mobile. Relecture `$simplify` locale, typage web, lint sans erreur et 205 tests ciblés validés. Client installé sans redémarrage ; fichiers servis vérifiés, sauvegarde conservée. Contrôle visuel non effectué. Preuve : `.t3/harness-operations/manual-project-tints/status.json`.

Thread ouvert : fond accentué, contour et repère vertical à gauche, sans atténuation de la ligne active. Web/Electron et navigateur mobile. Relecture `$simplify` locale, typage web, lint sans erreur et 195 tests ciblés validés. Client installé sans redémarrage ; fichiers servis vérifiés, sauvegarde conservée. Contrôle visuel non effectué. Preuve : `.t3/harness-operations/manual-active-thread/status.json`.

Thread ouvert : fond, contour et repère vertical reprennent la couleur du projet via une variable CSS héritée du groupe. Relecture `$simplify` locale, typage web, lint sans erreur et 195 tests ciblés validés ; styles compilés contrôlés. Client web/desktop installé sans redémarrage ; fichiers servis vérifiés, sauvegarde conservée. Contrôle visuel non effectué. Preuve : `.t3/harness-operations/manual-thread-project-color/status.json`.

Brouillons : une ligne à la hauteur des threads, projet masqué, icône jaune à droite remplacée par la croix de suppression au survol/focus clavier ; espace inférieur retiré. Relecture `$simplify` locale, typage web, lint sans erreur et 195 tests ciblés validés. Client web/desktop installé sans redémarrage ; fichiers servis vérifiés, sauvegarde conservée. Contrôle visuel non effectué. Preuve : `.t3/harness-operations/manual-single-line-drafts/status.json`.

Couleur des projets à icône emoji : palette dans les réglages du projet et le sélecteur d’icône, conservation de l’emoji et mise à jour de tous les checkouts. Couleur optionnelle rétrocompatible dans le contrat partagé, reprise par les fonds de groupe/thread. Relecture `$simplify` locale (palette partagée), typage web, lint et 48 tests ciblés validés. Builds client/serveur préparés et conservés dans `.t3/harness-operations/manual-emoji-project-color`. Installation autorisée dans Requêtes ; fond de toute la conversation ajouté. Typage web, lint et build complémentaire validés. Installateur indépendant `travail-emoji-color-install.service` lancé ; état `waiting-for-idle`, sauvegarde et artefact préparés. Il attend une fenêtre sans travaux actifs (maximum 24 h), puis redémarre et vérifie santé/fichiers servis. Aucune interruption forcée. Statut : `.t3/harness-operations/manual-emoji-project-color/status.json`.

Tâches : sélecteurs de projet personnalisés (édition et filtre), limités aux projets visibles de la machine choisie, avec logo et pastille de couleur. Composants et préférences existants réutilisés ; relecture `$simplify` locale, typage web et lint ciblé validés. Sans contrôle visuel ni installation.

Requêtes : nom et icône du projet dans la file et la requête ouverte, fond de la fiche teinté selon sa couleur. Résolution par la discussion et l’environnement existants, repli si projet indisponible. Web/Electron et navigateur mobile ; relecture `$simplify`, typage web, lint et 12 tests ciblés validés. Build client réussi, intégré à la même installation différée ; artefact `client-requests-project` dans `.t3/harness-operations/manual-emoji-project-color`.

Sélecteurs de projets des tâches installés dans les clients web/desktop, sans redémarrage serveur ; fichiers servis vérifiés, sauvegarde conservée. Preuve : `.t3/harness-operations/manual-task-project-select/status.json`.

Installation différée couleurs/Requêtes : base recalée sur le client du sélecteur de projet Tâches installé entre-temps ; route Tâches comparée et identique après normalisation des imports hashés. Sauvegarde actualisée ; installateur relancé, état `waiting-for-idle`. Aucun remplacement ni redémarrage forcé.

Couleurs emoji et fond de conversation : client/serveur installés avec redémarrage immédiat explicitement demandé, santé et fichiers servis vérifiés. Sauvegardes : `.t3/harness-operations/manual-emoji-project-color`.

Agents autonomes : vue `/agents`, canvas déplaçable, règles, pause/reprise du même thread, mémoire durable et historique séparé des discussions avec continuation possible. File persistante : décisions humaines, échanges entre agents, puis travail ordinaire ; le qualifieur propose un arbitrage en cas de refus incertain et reprend le thread d’origine pour apprendre. Snooze sans échéance pour les attentes humaines ou interagents, liste « En attente », réveil du thread d’origine selon les priorités et archives réservées aux tâches terminées. Personnalité définie à la création dans MEMORY.md, conservée lors des mises à jour. Statut Refusée ajouté aux tâches. Relecture `$simplify` locale : schémas compilés réutilisés, notifications limitées aux changements, reprise idempotente et contexte borné. 139 tests ciblés réussis, typage web, lint sans erreur et builds validés ; aucune erreur TS serveur affichée (suggestions Effect, sortie 2 du vérificateur). Migration et HTTP vérifiés sur état isolé, sans test navigateur. Les agents sont créés sur demande par les outils des agents, démarrent en pause et restent configurables dans la vue.

Installation agents autonomes : installée, santé et fichiers servis vérifiés. Artefacts, sauvegarde et statut : `.t3/harness-operations/manual-autonomous-agents-20261030`.

Tâches : types et prompts configurables, lancement et accès aux discussions en bas de fiche ; une seule discussion par tâche et plusieurs tâches par discussion, attribution et retrait par l’agent appelant via MCP, contexte Slack et prompt du type consultables. Statut manuel ; attribution refusée si une autre discussion possède déjà la tâche. Relecture `$simplify`, 20 tests services/MCP (dont les agents autonomes) et 11 tests de permissions, typages sans erreur TypeScript, lint et builds réussis ; démarrage HTTP isolé et migration des types vérifiés. Pas de test navigateur.

Tâches : la vue par défaut « Tout » masque les tâches à qualifier et terminées, toujours accessibles dans leurs onglets. Relecture `$simplify` locale, typage web et lint ciblé validés. Sans test navigateur ni installation quotidienne.

Installation types et associations des tâches : installée dans le lot global qualifier, contrôle HTTP/MCP et fichiers servis validés. Version corrigée : une discussion par tâche, plusieurs tâches par discussion ; sauvegardes et preuve dans `.t3/harness-operations/manual-task-agents-20261030`.

Filtre des tâches installé dans les clients web/desktop sans redémarrage : « Tout » masque les tâches à qualifier et terminées, leurs onglets restent accessibles. Contrôle de six statuts, syntaxe et fichiers HTTP servis validés. Préparation simplifiée pour limiter son coût ; sauvegarde des points d’entrée conservée. Preuve : `.t3/harness-operations/manual-task-default-filter/status.json`.

Qualifieur global : portée « Tous les projets — sans projet » par défaut, sans projet obligatoire. Exécution via Scratch natif ; dossier neutre hors Git pour les données hébergées dans un checkout. Reprises liées au projet réel du thread, filtrage conservé pour les agents limités à un projet. Relecture `$simplify` locale ; 25 tests ciblés réussis, typage web et lint validés, aucune erreur TS serveur (suggestions Effect seulement). Correctif qualifieur global : installé, santé et fichiers servis vérifiés. Preuve : `.t3/harness-operations/manual-global-qualifier-20261030`.

Création des agents confiée aux agents sur demande : bouton, formulaire d’ajout et mission préremplie retirés du client ; règles et mémoire restent modifiables. Qualifieur global configuré via l’outil natif, personnalité et périmètres dans sa mémoire, initialement en pause. Relecture `$simplify` locale. Installation du retrait de création : installée sans redémarrage ; typage, lint, build et fichiers servis validés. Preuve : `.t3/harness-operations/manual-agent-creation-ui-20261030`.

Fonds des conversations et des requêtes : base commune suivant le thème actif, légèrement éclaircie en mode sombre, teinte du projet conservée. Relecture `$simplify` locale : suppression de la variable intermédiaire propre au chat. Typage web et lint ciblé validés ; sans contrôle navigateur ni installation quotidienne.

Fonds adaptés au thème installés dans les clients web/desktop sans redémarrage serveur : seuls les styles et modules concernés du client existant ont été modifiés. Relecture `$simplify` locale, syntaxe des modules et 193 fichiers servis vérifiés ; sauvegarde des points d’entrée conservée. Sans contrôle visuel. Preuve : `.t3/harness-operations/manual-theme-project-surfaces-20261030/status.json`.

Threads des agents : rendu compact des discussions, Markdown et copie partagés ; consignes longues repliées avec le composant extrait de la timeline, réponses sans encadré. Relecture `$simplify` locale : suppression du wrapper Markdown redondant et réutilisation du repli existant. 92 tests de rendu des discussions réussis. Installation du fil compact : installée sans redémarrage ; fichiers servis et client desktop vérifiés. Preuve : `.t3/harness-operations/manual-agent-thread-visual-20261030`.

Cartes des agents actifs : icône des discussions en rotation, texte « En cours » retiré et bordure dans le même bleu `info`. Animation partagée limitée aux éléments visibles, avec respect de la réduction des animations. Relecture `$simplify` locale : statut dérivé, icône, couleur et observateur existants réutilisés. Installation du témoin actif : installée sans redémarrage ; typage, lint, build et fichiers servis validés. Preuve : `.t3/harness-operations/manual-agent-working-indicator-20261030`.

Vue agents : libellé « Un thread à la fois · Mémoire durable » retiré. Relecture `$simplify` locale. Installation du retrait du libellé : installée sans redémarrage ; lint, build et fichiers servis validés. Preuve : `.t3/harness-operations/manual-agent-header-cleanup-20261030`.

Requêtes des agents autonomes : badge nominatif dans la file et la carte, y compris pour les anciens threads. Qualifieur : résumé avec ✅ conserver / ❌ refuser pour les nouvelles propositions structurées, source Slack retrouvée automatiquement ou source explicite (Gmail inclus), détails repliés. Consignes de qualification adaptées. Relecture `$simplify` locale : rendu des détails partagé, récupération des auteurs et sources groupée, commandes exécutables conservées visibles. 16 tests ciblés réussis, typage web et lint ciblé validés ; aucun contrôle navigateur ni installation quotidienne.

Installation du style des requêtes : installée, santé et fichiers servis vérifiés. Preuve : .t3/harness-operations/manual-agent-request-style-20261030/status.json.

Automatisations : navigation « Auto », bloc Messages Slack ouvrant à droite le script et le service de collecte en lecture seule, chargés à la demande. Code de la version web, sans état d’exécution distant. Relecture `$simplify` locale, typage web, lint ciblé et compilation web validés. Installée sans redémarrage : page, fichiers Slack servis, client desktop et santé vérifiés ; sans test navigateur. Preuve : `.t3/harness-operations/manual-automations-slack-20261030/status.json`.

Cartes des agents : ouverture au clic sur toute la carte, commande pause/lecture par icône en haut à droite. Déplacement en mode édition conservé. Relecture `$simplify` locale, typage web et lint ciblé validés ; sans test navigateur ni installation quotidienne.

Installation des cartes cliquables : installée dans les clients web/desktop sans redémarrage serveur ; build, fichiers HTTP servis et client desktop vérifiés. Relecture `$simplify` locale. Preuve : `.t3/harness-operations/manual-agent-card-click-20261030/status.json`.

Carte Messages Slack : déplacement en mode « Modifier l’affichage », position conservée localement par machine cible. Relecture `$simplify` locale, typage web et lint ciblé validés ; sans test navigateur ni installation quotidienne.

Qualifieur : reprise du thread courant débloquée lorsque des décisions humaines attendent sur d’autres threads. Filtre limité au thread repris, décisions anciennes conservées. 10 tests ciblés, lint et build serveur validés ; relecture `$simplify` locale. Installation quotidienne effectuée sur accord explicite « Installe le sans attendre » ; sauvegarde du bundle, redémarrage et HTTP 200 vérifiés. Preuve : `.t3/harness-operations/manual-qualifier-resume-fix-20261030`.

Installation du déplacement Slack : clients web/desktop mis à jour, fichiers HTTP servis vérifiés, serveur inchangé ; sans test navigateur. Preuve : `.t3/harness-operations/manual-slack-card-move-20261030/status.json`.

Requêtes : bouton « Ignorer » pour archiver sans réponse, notification ni exécution, y compris si un brouillon est saisi. Statut durable « Ignorée ». Relecture `$simplify` locale : réutilisation de la commande, des permissions et du classement existants. 13 tests ciblés réussis, typage web et lint ciblé validés ; typage serveur limité par les diagnostics Effect existants. Sans test navigateur ni installation quotidienne.

Installation du bouton Ignorer : installée, santé et fichiers servis vérifiés. Preuve : .t3/harness-operations/manual-request-ignore-20261030/status.json.

Requêtes du Qualifieur : contexte visible avant « Voir les détails » ; consigne de résumer le message source en une phrase dans context. Relecture `$simplify` locale : réutilisation du champ existant, sans état ni contrat ajouté. Lint ciblé et typage web validés ; sans test navigateur ni installation quotidienne.

Installation du résumé des Requêtes : installée, santé et fichiers servis vérifiés. Preuve : .t3/harness-operations/manual-request-summary-20261030/status.json.

Tâches : statuts refusés masqués dans « Tout », accessibles via « Refusées ». Relecture `$simplify` locale : filtre existant réutilisé, sans état supplémentaire. Lint ciblé, formatage et typage web validés ; sans test navigateur ni installation quotidienne.

Installation du masquage des tâches refusées : clients web/desktop mis à jour sans redémarrage serveur ; compilation, fichiers HTTP servis et client desktop vérifiés. Relecture `$simplify` locale ; sans test navigateur. Preuve : .t3/harness-operations/manual-hide-rejected-20261030/status.json.

Qualifieur : passage à « À faire » bloqué côté serveur sans proposition Conserver acceptée dans Requêtes pour la tâche du thread appelant. Consignes et outil adaptés ; changements manuels conservés. Relecture `$simplify` locale : réutilisation des Requêtes et runs existants, contrôle transactionnel sans migration ni nouvel état. 28 tests ciblés réussis, lint ciblé validé ; typage serveur sans erreur TS, diagnostics Effect seulement (sortie 2). Sans installation quotidienne ni reclassement des tâches existantes.

Installation validation du qualifieur : correctif installé sur accord « installe le », sauvegarde des deux bundles, redémarrage et identité/HTTP/authentification vérifiés. Preuve : .t3/harness-operations/manual-qualifier-approval-20261030/status.json.

Tâches : « Lancer un agent » résout désormais le modèle via les réglages T3 Code du projet et du serveur, puis le choix automatique du fournisseur disponible. Ancien champ projet réutilisé seulement selon les règles de compatibilité existantes. Relecture `$simplify` locale : helpers et hooks existants, aucun nouveau réglage ni état. 61 tests de résolution réussis, typage web et lint ciblé validés ; sans test navigateur ni installation quotidienne.

Tâches : icône du projet ajoutée à côté de son nom dans chaque ligne, via `ProjectFavicon`. Relecture `$simplify` locale, lint ciblé et typage web validés ; sans vérification navigateur ni installation quotidienne.

Installation du modèle des tâches : clients web/desktop mis à jour, compilation et fichiers servis vérifiés, serveur inchangé. Relecture `$simplify` locale ; sans test navigateur. Preuve : `.t3/harness-operations/manual-task-model-defaults-20261030/status.json`.

Tâches : action « Lancer un agent » / « Voir la discussion » en bas à droite des cartes. Relecture `$simplify` locale : grille et pied de carte commun, classe flex devenue inutile retirée. Typage web, lint ciblé et formatage validés ; sans test navigateur ni installation quotidienne.

Installation de l’icône des projets dans les tâches : clients web/desktop mis à jour, compilation et fichiers HTTP servis vérifiés, serveur inchangé. Relecture `$simplify` locale ; sans test navigateur. Preuve : `.t3/harness-operations/manual-task-project-icon-20261030/status.json`.

Installation du positionnement des actions : clients web/desktop mis à jour, compilation et fichiers servis vérifiés, serveur inchangé. Relecture `$simplify` locale ; sans test navigateur. Preuve : `.t3/harness-operations/manual-task-action-position-20261030/status.json`.

Tâches : « Lancer un agent » démarre systématiquement en Full Access côté service. Relecture `$simplify` locale : mode existant réutilisé, sans option ni état ajouté. Test ciblé de lancement et de réutilisation réussi, lint et formatage validés ; sans installation quotidienne.

Installation Full Access des tâches : correctif installé, bundle sauvegardé, redémarrage et identité/HTTP/authentification vérifiés. Relecture `$simplify` locale et test ciblé validés. Preuve : .t3/harness-operations/manual-task-full-access-20261030/status.json.

Requêtes : dépliants dans le fil de discussion web/desktop, avec état synchronisé, détails et réponse directe via le formulaire existant. Relecture `$simplify` locale : abonnement et commandes partagés, aucun état métier dupliqué. Typage web et lint ciblé validés (avertissements de mémoïsation dans ChatView) ; sans test navigateur ni installation quotidienne.

Installation des requêtes dépliantes dans les discussions : clients web/desktop mis à jour, compilation, typage web, lint ciblé et fichiers HTTP servis vérifiés. Relecture `$simplify` locale ; rendu fermé/ouvert capturé sur instance isolée. Serveur inchangé. Preuve : `.t3/harness-operations/manual-thread-requests-20261030/status.json`.

Requêtes du thread : regroupées dans un dépliant fermé par défaut, accolé au-dessus du prompt, avec total, compteur à traiter et liste à hauteur limitée. Retirées du fil défilant. Relecture `$simplify` locale, typage web et lint ciblé validés ; sans vérification navigateur ni installation quotidienne.

Installation du dépliant Requêtes au-dessus du prompt : clients web/desktop mis à jour, build et fichiers HTTP vérifiés, serveur inchangé. Relecture `$simplify` locale, typage et lint ciblés validés avant installation. Preuve : `.t3/harness-operations/manual-prompt-requests-20261102/status.json`.

Contour Requêtes/prompt : dépliant intégré dans la surface du composer, bordure séparée supprimée pour un contour continu. Relecture `$simplify`, typage web, lint ciblé (avertissements existants) et build validés. Clients web/desktop installés et fichiers HTTP vérifiés, serveur inchangé ; sans test navigateur. Preuve : `.t3/harness-operations/manual-request-contour-20261102/status.json`.

Tâches : date de première qualification enregistrée au passage de Non qualifiée à À faire (ou création directe À faire), conservée ensuite et affichée au format jour/mois/année heure:minute dans le fuseau du client. Anciennes dates inconnues laissées absentes. Relecture `$simplify` locale : stockage JSON et flux existants réutilisés, sans migration. 12 tests service, typage web et lint ciblé validés ; sans test navigateur ni installation quotidienne.

Installation date de qualification des tâches : serveur et clients web/desktop installés, sauvegardes, redémarrage, identité, authentification et assets HTTP vérifiés. Relecture `$simplify` locale. Preuve : .t3/harness-operations/manual-task-qualified-date-20261102/status.json.

Statut Fusionnée : filtre dédié, conservation des sources, réouverture et protection contre un lancement sur carte close. 15 tests ciblés réussis, lint et builds vérifiés. Installation : serveur et clients web/desktop installés, sauvegardes, redémarrage, identité, authentification et assets HTTP vérifiés. Relecture `$simplify` locale. Preuve : .t3/harness-operations/manual-task-merged-20261102/status.json.

Tâches : tri par avancement (À valider, En cours, À faire), fond pastel par état et badge assorti plus marqué. Relecture `$simplify` locale, typage web, lint ciblé et build validés. Clients web/desktop installés et assets HTTP vérifiés, sans redémarrage serveur ni test navigateur. Preuve : `.t3/harness-operations/manual-task-status-style-20261102/status.json`.

Préparation des tâches : À préparer (ancien À faire), À démarrer, lancement réservé aux tâches prêtes puis passage En cours. Coordinateur : notification après fusion vers la discussion associée, active ou inactive. 25 tests ciblés, lint, builds, installation serveur/web/desktop et contrôles HTTP réussis ; pas de test visuel. État de pause préservé. Relecture `$simplify` locale. Preuve : .t3/harness-operations/manual-task-ready-20261102-retry1/status.json.

Tâches : passer l’agent lié en Settled termine ses tâches ouvertes ; états clos et tâches non liées préservés. 15 tests ciblés, lint et build serveur validés ; relecture `$simplify` locale. Correctif serveur installé avec sauvegarde, redémarrage et contrôles identité/authentification. Preuve : `.t3/harness-operations/manual-task-settled-20261102/status.json`.

Agents autonomes : déclencheur « Une tâche à préparer est disponible » (todo), sélection selon la portée et exclusion des cartes déjà prises. 11 tests ciblés, lint, builds et relecture `$simplify` locale. Installation serveur/web/desktop avec sauvegarde et contrôles HTTP. Preuve : `.t3/harness-operations/manual-agent-todo-20261102/status.json`.

Garde-fou email/Slack : approbation native Codex avec réviseur humain configurée sur sept outils d’envoi/transfert/programmation/modification/publication de fichiers ; rappel du consentement via Requêtes ajouté au AGENTS.md privé. Configuration relue par Codex, 32 tests ciblés et relecture `$simplify` validés. Portée : nouvelles sessions Codex du harness ; sessions existantes non redémarrées, aucun envoi réel testé, aucun lien technique avec Requêtes ni garantie sur les autres voies. Preuve : `.t3/harness-operations/manual-outbound-approval-20261102/status.json`.

Requêtes : « Voir la discussion » ouvre le chat existant dans un panneau redimensionnable, avec envoi de messages, fermeture et accès à la page complète ; affichage superposé sur écran étroit. Relecture `$simplify` locale, typage web, lint ciblé, 3 tests de file et build validés ; sans test navigateur. Clients web/desktop installés avec sauvegardes et vérification des assets HTTP, serveur inchangé. Preuve : `.t3/harness-operations/manual-request-chat-panel-20261102/status.json`.

Gmail : carte Auto et script consultable, collecte des nouveaux emails chaque minute vers À qualifier (un email par tâche), compte vérifié, exclusions envoyés/brouillons/spam/corbeille, déduplication persistante et reprise paginée. Activation sans historique, emails laissés inchangés ; qualification par les agents existants. 19 tests ciblés puis 5 après simplification, lecture réelle Gmail, typages serveur/web, lint ciblé, builds et démarrage isolé validés. Relecture `$simplify` locale : affichage des collecteurs partagé et décodeurs MIME compilés une fois. Installé et activé avec sauvegarde, redémarrage et contrôle HTTP ; dépendances du script installé corrigées, première collecte automatique réussie (progression enregistrée, aucun nouvel email). Sans test navigateur. Preuve : `.t3/harness-operations/manual-gmail-tasks-20261102/status.json`.

Auto / Slack : channels exclus affichés depuis la configuration réelle de la machine, avec chargement, erreur et liste vide. 28 tests ciblés, typage web, aucun échec de types serveur (diagnostics Effect préexistants), builds, démarrage isolé et relecture $simplify ; installé web/desktop avec sauvegarde et contrôle HTTP, sans test navigateur. Preuve : .t3/harness-operations/manual-slack-filters-20261102/status.json.

Exclusions Slack : Analyste dédié dans Auto, discussions et mémoire par passage, premier audit réel terminé (54 messages sur 3 canaux ; données insuffisantes sur 13), règles préservées. Cadence quotidienne 09:00 Europe/Paris, prochaine échéance persistée au 03/11/2026 ; changements proposés dans Requêtes. 17 tests ciblés, typages (suggestions Effect préexistantes), lint, builds et revue `$simplify` locale ; installation web/desktop et santé HTTP vérifiées, sans navigateur. Preuve : `.t3/harness-operations/slack-exclusions-review-20261102/install/status.json`.

Recettes des chantiers : prompt initial de l’orchestrateur et des tâches rattachées demandant une `$guided-review` sans serveur ni onglet à la livraison et une action « Tester la PR ». Aucune règle globale : les discussions ordinaires et tâches hors chantier sont exclues. Tests des deux cas, build isolé, lint et revue `$simplify` locale validés. Installation ciblée avec sauvegarde et état dans `.t3/harness-operations/manual-chantier-review-20261103/status.json`.

Agents autonomes : catalogue embarqué `apps/server/src/autonomousAgents/agents.json` (3 agents, règle chantiers comprise), restauration des agents manquants en pause au démarrage ; réglages et état locaux préservés. 14 tests ciblés, lint, format et build isolé validés ; relecture `$simplify` locale. Typage serveur : diagnostics Effect existants, aucun diagnostic nouveau sur le changement. Pas de réinstallation.
