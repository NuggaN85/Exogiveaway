**`Mise à jour : version 1.1.4`**

# Exogiveaway Discord Bot

Le bot de giveaway Discord est conçu pour offrir une expérience interactive permettant aux utilisateurs de lancer et participer à des giveaways professionnels avec des options personnalisables.

## Description

Ce bot permet aux administrateurs de créer des giveaways avec des prix, un nombre de gagnants, une durée, et des conditions comme un rôle requis. Les utilisateurs participent via des boutons, et le bot gère automatiquement les inscriptions, les tirages, et les notifications des gagnants.

## Fonctionnalités

- **Création de Giveaways** : Définir prix, gagnants, durée, rôle requis, et commentaire.
- **Participation Facile** : Bouton pour rejoindre le giveaway.
- **Gestion des Participants** : Suivi des participants avec affichage en temps réel.
- **Rôle Requis** : Restreindre la participation à un rôle spécifique (optionnel).
- **Annonce de Gagnants** : Tirage automatique et création d'un thread privé pour les gagnants.
- **Annulation** : Option pour annuler un giveaway en cours.
- **Commandes Slash** : Interaction via commandes slash modernes.

## Prérequis

- Node.js (version 16 ou supérieure)
- Un bot Discord (créé via le [Portail Développeur Discord](https://discord.com/developers/applications))
- Permissions nécessaires pour ajouter le bot à vos serveurs

## Installation

1. Clonez ce dépôt sur votre machine locale.
2. Installez les dépendances avec `npm install`.
3. Créez un fichier `.env` à la racine du projet avec :

```plaintext
TOKEN=VOTRE_TOKEN_DE_BOT
```

4. Lancez le bot avec `node index.js`.

## Commandes

Le bot utilise des commandes slash :

- `/giveaway` : Lancer un giveaway avec options (prix, gagnants, durée, rôle requis, rôle à mentionner, commentaire).

## Utilisation

1. Invitez le bot sur votre serveur via le lien OAuth2 généré dans le [Portail Développeur](https://discord.com/developers/applications).
2. Utilisez `/giveaway` pour configurer un giveaway.
3. Les utilisateurs participent en cliquant sur le bouton "Participer".
4. À la fin, le bot annonce les gagnants et crée un thread privé pour eux.

## Contribution

Contributions bienvenues ! Suivez ces étapes :

1. Forkez le dépôt.
2. Créez une branche (`git checkout -b feature/AmazingFeature`).
3. Commitez vos changements (`git commit -m 'Add some AmazingFeature'`).
4. Poussez la branche (`git push origin feature/AmazingFeature`).
5. Ouvrez une Pull Request.

## Licence

Sous licence MIT. Voir le fichier [LICENSE](LICENSE).

## Contact

Pour questions ou suggestions, ouvrez une issue ou contactez-moi directement.

---

[![Donate](https://img.shields.io/badge/paypal-donate-yellow.svg?style=flat)](https://www.paypal.me/nuggan85) [![v1.1.4](http://img.shields.io/badge/zip-v1.1.4-blue.svg)](https://github.com/NuggaN85/Exogiveaway/archive/master.zip) [![GitHub license](https://img.shields.io/github/license/NuggaN85/Exogiveaway)](https://github.com/NuggaN85/Exogiveaway)

© 2025 Ludovic Rose. Tous droits réservés.
