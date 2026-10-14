# Harness personnalisé basé sur MT Code

## Objectif

Créer notre propre version de MT Code pour remplacer progressivement Codex Desktop / ChatGPT Community dans les usages quotidiens de Valentin. Conserver les capacités utiles, avec une interface personnalisable et des équivalents lorsque les intégrations de ChatGPT ne sont pas transférables.

Le projet sera maintenu dans un dépôt Git. Ce document décrit les attentes ; il ne confirme pas que les fonctions ont déjà été implémentées ou testées.

## Capacités attendues

### Agents et moteur Codex

- Utiliser Codex avec l’abonnement ChatGPT de Valentin.
- Préserver les boucles de travail, les sous-agents, la reprise des tâches et les possibilités de délégation du moteur Codex.
- Rebrancher les instructions, skills et outils existants lorsqu’ils sont compatibles.
- Conserver les fonctions de développement de MT Code : projets, conversations, terminaux, différences de code et worktrees.
- Disposer d’un agent coordinateur capable de retrouver les tâches, consulter leur état, transmettre des consignes, lancer ou interrompre du travail et restituer les résultats, y compris entre projets autorisés.
- Distinguer une demande transmise d’un travail réellement terminé.

### Conversation vocale

- Parler naturellement à l’agent et recevoir ses réponses à voix haute, comme dans l’expérience actuelle.
- Pouvoir demander oralement au coordinateur de consulter ou piloter d’autres agents sans devoir changer manuellement de conversation.
- Privilégier GPT-Live via l’abonnement existant si la connexion le permet. Une solution par API reste possible, avec son coût distinct explicite.
- Permettre l’interruption d’une réponse vocale et la transmission de nouvelles consignes pendant le travail.
- Conserver les résultats dans les conversations, même si l’appel se termine.

### Accès distant

- Depuis un téléphone ou un autre PC, retrouver les tâches exécutées sur la machine hôte et les piloter : créer, consulter, envoyer des consignes, interrompre et répondre aux demandes d’approbation.
- Combiner cet accès avec la conversation vocale : micro et son sur l’appareil distant, agents et fichiers sur la machine hôte.
- Garder les agents au travail lorsque le client se déconnecte, tant que l’hôte reste disponible.
- Prévoir un accès authentifié, révocable et chiffré.
- Choix retenu : Quick Tunnel Cloudflare gratuit, démarré avec l’hôte, authentification MT ; aucun domaine, URL changeante acceptée pour démarrer.
- Le navigateur mobile est acceptable pour une première version ; une application mobile dédiée n’est pas imposée.

### Computer Use sans gêner Valentin

- Fournir une session graphique indépendante à chaque agent qui en a besoin, créée à la demande.
- Permettre à plusieurs agents de manipuler leurs applications simultanément sans déplacer le pointeur de Valentin ni détourner son clavier.
- Isoler les sessions et les profils applicatifs pour éviter les interférences entre agents.
- Permettre à Valentin de voir le bureau d’un agent et de reprendre la main, avec un transfert de contrôle explicite.
- Gérer la création, la reprise et la fermeture des sessions, ainsi que leur consommation de ressources.
- Les applications manipulées s’exécutent dans ces sessions séparées. Le pilotage des fenêtres déjà ouvertes dans le bureau personnel de Valentin n’est pas couvert par cette solution.

### Connecteurs, historique et documents

- **Priorité : Gmail et Slack.** Retrouver les usages de recherche, lecture et contexte ; permettre les brouillons et les actions d’écriture selon les autorisations explicites de Valentin.
- **Extensions souhaitées : Teams et WhatsApp**, selon les possibilités d’accès aux comptes concernés. Ne pas assimiler WhatsApp personnel à l’API Business.
- Permettre l’ajout d’autres connecteurs via MCP, API ou outils adaptés.
- Pouvoir consulter l’ancien historique et les mémoires Codex depuis leurs données locales, éventuellement avec un skill. Une migration intégrale de l’interface et de son état n’est pas exigée.
- Pour les documents, des outils équivalents sont acceptables : reproduire exactement Pages, Spaces ou les éditeurs ChatGPT n’est pas une condition de migration.

### Tâches récurrentes

- Programmer des tâches à une heure donnée ou selon une récurrence, avec un fuseau horaire explicite.
- Pouvoir consulter leur historique, leur résultat et leurs erreurs, les modifier et les désactiver.
- Exécuter les tâches sans nécessiter un client ouvert, avec un service hôte disponible.
- Éviter les exécutions en double et définir le comportement lorsqu’une échéance a été manquée.

### Maintenance automatique

- Prévoir une tâche quotidienne de vérification des évolutions de MT Code, T3 Code et Codex ; horaire à définir.
- Préparer les mises à jour sur une branche et dans un environnement séparé de la version utilisée.
- Faire adapter nos modifications et corriger les régressions par un agent lorsque c’est possible.
- Tester les usages importants : agents, délégation, connecteurs, voix, accès distant, sessions graphiques et planification. Les vérifications ne doivent pas envoyer de messages réels non autorisés.
- Installer automatiquement une version validée à un moment qui n’interrompt pas les tâches actives.
- Conserver la version précédente, contrôler le fonctionnement après installation et permettre un retour arrière.
- Signaler les échecs et les arbitrages nécessaires. Confier l’installation et la récupération à un mécanisme capable de fonctionner même si MT Code ne démarre plus.

## Ordre de réalisation

1. Créer la base Git dérivée de MT Code ; connecter Codex, les instructions et les skills.
2. Valider un parcours complet : depuis le téléphone, parler au coordinateur, lui faire piloter une autre tâche et entendre le résultat.
3. Raccorder Gmail et Slack, puis valider deux agents travaillant dans deux sessions graphiques sans perturber Valentin.
4. Ajouter les tâches récurrentes et la maintenance automatique.
5. Étendre les connecteurs et personnaliser l’interface selon les usages constatés.

## Points à valider avant de remplacer l’usage quotidien

- Compatibilité réelle de l’abonnement et de la version Codex avec la voix et le fonctionnement multi-agent retenus.
- Portée effective des outils de coordination entre projets et, si nécessaire, entre machines.
- Fiabilité de la voix sur téléphone : latence, interruptions, reconnexion, changement de réseau, passage en arrière-plan et verrouillage de l’écran. Ces derniers cas ne sont pas acquis.
- Accès et permissions disponibles pour chaque connecteur ; couverture des usages réels de Valentin.
- Compatibilité des applications avec les sessions graphiques isolées et consommation de ressources.
- Tests représentatifs et restauration vérifiée avant d’activer les mises à jour automatiques.

Conserver Codex Desktop comme solution de repli pendant cette validation.
