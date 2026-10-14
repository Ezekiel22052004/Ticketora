# Corrections design — Ticketora

- Refonte de `suivi-remboursements.html` avec une interface responsive reprenant la palette Ticketora (bleu nuit, orange, panneaux sombres, statuts vert/jaune/rouge).
- La page du suivi utilise un rôle explicite : `?role=organizer` pour l'organisateur et `?role=admin` pour l'administration. Le lien d'administration n'est pas affiché dans la vue organisateur.
- Les liens du tableau organisateur et de l'administration ouvrent chacun la vue appropriée.
- La recharge du portefeuille est maintenant proposée comme action principale en haut du cadre d'accueil organisateur, dans un bouton orange, comme l'action « Nouvel Événement » du tableau administrateur.
- Le lien « Dépôt portefeuille » a été retiré du menu latéral pour éviter le doublon.
- La page portefeuille reprend également la palette bleu nuit/orange de Ticketora et conserve les appels API existants.

Aucune route de paiement ni règle financière serveur n'a été modifiée dans cette correction visuelle.
