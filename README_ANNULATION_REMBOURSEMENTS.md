# Ticketora — annulation et remboursements

## Ajouts dans cette archive
- Pages légales : politique de confidentialité, CGU, conditions de vente, mentions légales et politique de remboursement.
- Page `annuler-billet.html` : un client peut soumettre une demande liée au code QR/code du billet, à son e-mail et au numéro du paiement initial.
- Registre de demandes d'annulation individuelles consultable par l'organisateur et l'administrateur via l'API.
- Registre unique de remboursements par commande, statut individuel et opérateur d'origine séparé du mode test/production Tchin.
- Route organisateur pour annuler un événement, vérifier la règle des 24 h et la disponibilité calculée des recettes organisateur, invalider les billets et préparer les remboursements.
- Autorisation exceptionnelle de 30 minutes par l'administrateur avec motif et trace d'audit.
- Traitement automatique des remboursements quand l'opérateur d'origine est réellement présent dans les données confirmées de Tchin et correspond à un opérateur pris en charge. Le statut est ensuite interrogé via Tchin. Un résultat incertain ne provoque pas de nouvel envoi.
- Les frais de service de 5 % sont exclus du montant préparé pour remboursement.

## Limites à ne pas masquer
- L'opérateur est enregistré uniquement si la réponse authentifiée de Tchin expose un champ opérateur exploitable (`operator`, `payment_operator` ou `payment_method`). Le code ne devine pas l'opérateur depuis le numéro. Si ce champ manque, le remboursement est bloqué et visible dans le suivi.
- La règle de fonds disponibles utilise les recettes organisateur connues et les retraits existants. Ce ZIP n'invente pas un dépôt wallet confirmé : l'intégration complète des dépôts de portefeuille et leur comptabilisation dans le solde de remboursement doit être raccordée à la capacité réelle de dépôt Tchin disponible sur le compte.
- Les tableaux de bord HTML existants ne sont pas refaits; les nouveaux suivis sont exposés par les routes API dédiées. Une intégration visuelle dans les tableaux de bord existants doit être vérifiée avec l'interface en exécution.
- Les pages légales contiennent des éléments génériques qui doivent être validés avec l'identité juridique, l'hébergement, les durées de conservation et les coordonnées exactes de Ticketora avant publication.

## Vérifications réalisées
- `node --check server.js`
- `node --check app.js`
- `node --check admin.js`

Une vérification syntaxique ne remplace pas un test d'intégration avec une base PostgreSQL et des clés Tchin de test puis de production. Ne pas déclarer les remboursements opérationnels avant ces essais.
