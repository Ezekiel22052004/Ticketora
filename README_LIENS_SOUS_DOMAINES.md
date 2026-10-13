# Liens personnalisés Ticketora sans modification DNS

Les liens de partage utilisent le domaine principal déjà configuré : `https://ticketora.site/?event=123&slug=concert-des-jeunes`. Le paramètre `event` permet à Ticketora d’ouvrir l’événement précis ; le paramètre `slug` affiche son nom lisible dans l’adresse.

Cette solution ne nécessite aucun sous-domaine, aucun enregistrement DNS wildcard et aucun certificat TLS wildcard. Elle suppose que `https://ticketora.site/` fonctionne déjà et pointe vers le frontend Ticketora. Le frontend existant lit `event` dans l’URL et ouvre les détails de l’événement correspondant.

Le reste du projet est conservé. Aucun changement de design ni de modèle de billet n’est prévu par cette correction.
