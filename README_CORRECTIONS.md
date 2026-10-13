# Ticketora — corrections ciblées

Cette version utilise les fichiers fournis et conserve le HTML/CSS existant. Aucun code de génération graphique du ticket n'a été modifié.

## Changements ciblés

- Retrait des liens publics « Administration » dans la page d'accueil et dans « Choisissez votre espace » ; l'interface `admin.html` et les protections serveur sont conservées.
- Conservation de « Glisser pour payer » ; ajout d'une garde contre un double déclenchement de l'action de glissement.
- Ajout d'un suivi visuel à cinq étapes dans les retours de paiement des tickets, LIVE et cagnottes. Les étapes finales ne sont affichées comme terminées qu'après confirmation retournée par l'API.
- Réservation temporaire des stocks de billets pour dix minutes, avec comptage transactionnel des réservations actives pendant la création d'une commande.
- Libération des réservations lorsqu'un statut réel Tchin indique un paiement échoué/annulé/expiré. Les réservations expirées ne sont plus comptées dans le stock disponible ; une confirmation tardive est revérifiée avant toute attribution pour éviter une double vente.
- Enregistrement de l'utilisateur connecté sur les commandes et paiements LIVE, et vérification de l'accès LIVE durable en base pour le compte associé au paiement.
- « Mes billets » reste accessible sans compte via la vérification des informations d’achat, avec téléchargement des billets.
- Les confirmations de paiement restent gérées côté serveur ; aucun centre de notifications participant n’est proposé.
- Correction du montant minimum affiché pour les cagnottes : 200 FCFA, aligné sur l'API existante.
- Les inscriptions gratuites n'affichent plus le libellé « Paiement confirmé ».

## Fichiers modifiés

- `server.js`
- `app.js`
- `index.html`
- `schema.sql`

Les autres fichiers transmis sont conservés sans modification.

## Vérifications effectuées

- `node --check server.js` : réussi.
- `node --check app.js` : réussi.
- `node --check admin.js` : réussi.
- Comparaison du code `buildTicketImage` avant/après : le code de rendu des tickets est inchangé.

## À savoir avant déploiement

- Les tests d'intégration nécessitent la base PostgreSQL, les variables d'environnement et un compte Tchin de test ; ils n'ont pas pu être exécutés ici.
- Aucun endpoint de remboursement Tchin documenté ni aucune clé de remboursement n'étaient présents dans les fichiers fournis. En cas de paiement confirmé après épuisement du stock, le code empêche une double attribution et signale qu'une intervention est nécessaire ; le remboursement devra être réalisé via une API de remboursement officiellement prise en charge par Tchin.
- Les images et ressources qui n'étaient pas jointes à la conversation (notamment `logo.png`, `ticket-template.png`, `ticket-template-vip.png`, `ticket-template-vvip.png`, les icônes et `manifest.json`) ne sont pas recréées ni modifiées. Recopiez les originaux dans le même dossier que `server.js` et `index.html` avant le lancement.
- Gardez votre fichier `.env` réel hors du ZIP. Configurez les variables secrètes sur votre environnement de déploiement.

## Lancement local

Depuis ce dossier, avec Node.js 20+ et une base PostgreSQL configurée :

```bash
npm install
npm start
```

Le serveur charge `.env` depuis le même dossier que `server.js`. Les migrations idempotentes des tables de réservations et d’accès LIVE sont également lancées au démarrage. La table historique participant_users et ses colonnes de liaison sont conservées pour compatibilité de la base, mais aucun parcours public de compte participant n’est exposé.


## Formulaire de création d’événement (organisateur et administrateur)
- Les deux interfaces demandent les mêmes informations générales : titre, catégorie, type, date, lieu, ville, adresse, description et affiche, avec coordonnées GPS facultatives.
- Pour un événement payant, au moins une catégorie avec prix et stock est requise.
- Pour un événement gratuit, les champs prix et stock sont masqués et ne sont pas demandés ; le serveur enregistre automatiquement une catégorie gratuite à prix zéro et une capacité technique élevée pour ne pas bloquer la création.
- Le design du reste du site, les paiements et les modèles de billets n’ont pas été intentionnellement modifiés.

## Événements gratuits — interface publique
- Les cartes d'événements gratuits ne proposent plus le bouton « Participer » : seuls « Détails » et « Partager » restent disponibles (ainsi que les contrôles visuels déjà présents comme le favori).
- La fiche détaillée d'un événement gratuit n'affiche plus de bouton d'inscription/participation ni les prix et stocks techniques ; elle affiche simplement l'indication « Entrée gratuite » avec les informations de l'événement et le partage.
- Pour les événements payants, le bouton d'achat et les informations tarifaires restent disponibles.
- Le cache du service worker a été versionné afin de forcer le chargement de la nouvelle interface.
