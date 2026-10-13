# Liens personnalisés Ticketora par sous-domaine

Le partage d’un événement utilise désormais une URL de la forme `https://concert-des-jeunes.ticketora.site/`, à partir du champ `public_slug` enregistré en base. Lorsqu’un visiteur ouvre un sous-domaine, le frontend lit le slug de l’hôte, récupère l’événement via `/api/events/slug/:slug` et ouvre sa fiche. Le serveur autorise les origines HTTPS de la forme `*.ticketora.site`.

## Configuration obligatoire avant mise en production

Le code seul ne crée pas les sous-domaines DNS ni leur certificat HTTPS. Dans le fournisseur DNS, il faut configurer un enregistrement wildcard `*` pointant vers l’hébergement du frontend (ou mettre en place un proxy wildcard adapté). L’hébergeur du frontend doit accepter `*.ticketora.site` et fournir un certificat TLS valable pour les sous-domaines. Si l’hébergeur ne prend pas en charge les domaines wildcard, configurez un proxy/CDN qui le prend en charge. Vérifiez également que `https://concert-des-jeunes.ticketora.site/` sert le même `index.html`, `app.js`, les styles et les ressources statiques que `https://ticketora.site/`.

Les événements doivent être publiés et disposer d’un `public_slug` unique. Le backend existant initialise cette colonne et attribue un slug unique. Aucun changement de design ou de gabarit de billet n’est prévu par cette correction.
