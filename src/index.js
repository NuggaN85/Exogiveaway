import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { Client, Collection, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType, SlashCommandBuilder, ActivityType } from 'discord.js';

// Définir __dirname pour les modules ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration des variables d'environnement
dotenv.config();

// Initialisation de la base de données SQLite
const db = new Database(path.join(__dirname, 'giveaways.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS giveaways (
    messageId TEXT PRIMARY KEY,
    channelId TEXT,
    guildId TEXT,
    prix TEXT,
    gagnants INTEGER,
    endTime INTEGER,
    participants TEXT,
    rôleRequis TEXT,
    commentaire TEXT,
    image TEXT,
    organizer TEXT
  )
`);

// Créer une nouvelle instance de client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

// Collection pour stocker les commandes
client.commands = new Collection();

// Rate limiter
const rateLimiter = new Map();
const limit = (userId, cooldown = 1000) => {
  const now = Date.now();
  if (rateLimiter.has(userId)) {
    const lastRequest = rateLimiter.get(userId);
    if (now - lastRequest < cooldown) return false;
  }
  rateLimiter.set(userId, now);
  return true;
};

// Gestion des giveaways
const loadGiveaways = () => {
  const rows = db.prepare('SELECT * FROM giveaways').all();
  const giveaways = {};
  for (const row of rows) {
    row.participants = JSON.parse(row.participants || '[]');
    giveaways[row.messageId] = row;
  }
  return giveaways;
};

const saveGiveaway = (giveaway) => {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO giveaways (
      messageId, channelId, guildId, prix, gagnants, endTime, participants, rôleRequis, commentaire, image, organizer
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    giveaway.messageId,
    giveaway.channelId,
    giveaway.guildId,
    giveaway.prix,
    giveaway.gagnants,
    giveaway.endTime,
    JSON.stringify(giveaway.participants),
    giveaway.rôleRequis,
    giveaway.commentaire,
    giveaway.image,
    giveaway.organizer
  );
};

const deleteGiveaway = (messageId) => {
  db.prepare('DELETE FROM giveaways WHERE messageId = ?').run(messageId);
};

// Création d'embed
const createEmbed = (title, description, organizer, commentaire, color = 0x1F8B4C) => {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color);
  if (organizer) {
    embed.addFields({ name: 'Organisateur', value: `<@${organizer}>`, inline: true });
  }
  if (commentaire) {
    embed.addFields({ name: 'Détails', value: `\`${commentaire}\`` });
  }
  return embed;
};

// Formater le temps
function formatTime(ms) {
  if (ms < 60 * 1000) return `${Math.floor(ms / 1000)} secondes`;
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / (60 * 1000))} minutes`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.floor(ms / (60 * 60 * 1000))} heures`;
  return `${Math.floor(ms / (24 * 60 * 60 * 1000))} jours`;
}

function updateActivity() {
  client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });
}

client.on("guildCreate", async guild => {
  updateActivity();
});

client.on("guildDelete", async guild => {
  updateActivity();
});

// Événement ready
client.once('ready', async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}!`);
  updateActivity();

  const giveaways = loadGiveaways();
  for (const messageId in giveaways) {
    const giveaway = giveaways[messageId];
    const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
    if (!channel) {
      deleteGiveaway(messageId);
      continue;
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      deleteGiveaway(messageId);
      continue;
    }

    const participants = new Set(giveaway.participants);
    const remainingTime = giveaway.endTime - Date.now();
    if (remainingTime <= 0) {
      deleteGiveaway(messageId);
      continue;
    }

    const roleRequired = giveaway.rôleRequis ? channel.guild.roles.cache.get(giveaway.rôleRequis) : null;
    const embed = createEmbed(
      '🎉 Nouveau Giveaway en Cours 🎉',
      `
        **🎁 Prix** : ${giveaway.prix}
        **🏆 Gagnants** : ${giveaway.gagnants}
        **⏳ Temps restant** : ${formatTime(remainingTime)}
        **👥 Participants** : ${participants.size}
      `,
      giveaway.organizer,
      giveaway.commentaire
    )
      .setThumbnail(channel.guild.iconURL({ dynamic: true }))
      .setFooter({ text: 'Cliquez pour participer !', iconURL: channel.guild.iconURL() })
      .setTimestamp()
      .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('enter').setLabel('Participer').setStyle(ButtonStyle.Secondary).setEmoji('🎉'),
        new ButtonBuilder().setCustomId('cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
        new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥')
      );

    await message.edit({ embeds: [embed], components: [row] });

    const collector = message.createMessageComponentCollector({ time: remainingTime });

    collector.on('collect', async i => {
      if (i.customId === 'cancel') {
        if (!i.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          return i.reply({ content: '❌ Pas les permissions nécessaires.', ephemeral: true });
        }
        collector.stop('cancelled');
        deleteGiveaway(messageId);
        await i.reply({ content: '⚠️ Giveaway annulé.', ephemeral: true });
        return;
      }

      if (i.customId === 'show_participants') {
        if (!i.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          return i.reply({ content: '❌ Pas les permissions nécessaires.', ephemeral: true });
        }
        const participantsList = Array.from(participants).map(id => `<@${id}>`).join(', ') || '👥 Aucun participant.';
        const participantsEmbed = createEmbed('📋 Liste des Participants', participantsList, null, null)
          .setThumbnail(i.guild.iconURL())
          .setFooter({ text: 'Participants actuels', iconURL: i.guild.iconURL() })
          .setTimestamp();
        return i.reply({ embeds: [participantsEmbed], ephemeral: true });
      }

      if (giveaway.rôleRequis && !i.member.roles.cache.has(giveaway.rôleRequis)) {
        return i.reply({ content: `❌ Vous devez avoir le rôle ${roleRequired} pour participer.`, ephemeral: true });
      }

      if (participants.has(i.user.id)) {
        return i.reply({ content: '❌ Vous participez déjà au giveaway.', ephemeral: true });
      }

      participants.add(i.user.id);
      giveaway.participants = Array.from(participants);
      saveGiveaway(giveaway);

      await i.reply({ content: '👍 Vous participez ! Bonne chance !', ephemeral: true });

      const updatedEmbed = createEmbed(
        '🎉 Nouveau Giveaway en Cours 🎉',
        `
          **🎁 Prix** : ${giveaway.prix}
          **🏆 Gagnants** : ${giveaway.gagnants}
          **⏳ Temps restant** : ${formatTime(giveaway.endTime - Date.now())}
          **👥 Participants** : ${participants.size}
          ${roleRequired ? `**🔒 Rôle requis** : ${roleRequired}` : ''}
        `,
        giveaway.organizer,
        giveaway.commentaire
      )
        .setThumbnail(i.guild.iconURL({ dynamic: true }))
        .setFooter({ text: 'Cliquez pour participer !', iconURL: i.guild.iconURL() })
        .setTimestamp()
        .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

      await message.edit({ embeds: [updatedEmbed] });
    });

    const interval = setInterval(async () => {
      const remainingTime = giveaways[messageId]?.endTime - Date.now();
      if (remainingTime <= 0) {
        clearInterval(interval);
        return;
      }

      const updatedEmbed = createEmbed(
        '🎉 Nouveau Giveaway en Cours 🎉',
        `
          **🎁 Prix** : ${giveaway.prix}
          **🏆 Gagnants** : ${giveaway.gagnants}
          **⏳ Temps restant** : ${formatTime(remainingTime)}
          **👥 Participants** : ${participants.size}
          ${roleRequired ? `**🔒 Rôle requis** : ${roleRequired}` : ''}
        `,
        giveaway.organizer,
        giveaway.commentaire
      )
        .setThumbnail(channel.guild.iconURL({ dynamic: true }))
        .setFooter({ text: 'Cliquez pour participer !', iconURL: channel.guild.iconURL() })
        .setTimestamp()
        .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

      await message.edit({ embeds: [updatedEmbed] });
    }, 60000);

    collector.on('end', async (collected, reason) => {
      clearInterval(interval);

      if (reason === 'cancelled') {
        const cancelledEmbed = createEmbed('❌ Giveaway Annulé ❌', 'Le giveaway a été annulé. Merci à tous les participants !', giveaway.organizer, null, 0xE74C3C)
          .setThumbnail(channel.guild.iconURL({ dynamic: true }))
          .setFooter({ text: 'Merci à tous !', iconURL: channel.guild.iconURL() })
          .setTimestamp();
        await message.edit({ embeds: [cancelledEmbed], components: [] });
        deleteGiveaway(messageId);
        return;
      }

      const winners = Array.from(participants).slice(0, giveaway.gagnants).map(id => channel.guild.members.cache.get(id)).filter(Boolean);
      const winnerEmbed = createEmbed(
        '🎊 Giveaway Conclu avec Succès ! 🎊',
        winners.length
          ? `**Félicitations aux gagnants !**\n${winners.map(w => `• ${w.user.tag} (<@${w.id}>)`).join('\n')}\n\nMerci à tous pour votre participation ! De nouveaux giveaways arrivent bientôt, restez à l'affût !`
          : 'Aucun participant pour ce giveaway. Tentez votre chance la prochaine fois !',
        giveaway.organizer,
        giveaway.commentaire,
        0x2ECC71
      )
        .addFields(
          { name: '🎁 Prix', value: giveaway.prix, inline: true },
          { name: '🏆 Nombre de gagnants', value: `${giveaway.gagnants}`, inline: true }
        )
        .setThumbnail(channel.guild.iconURL({ dynamic: true }))
        .setFooter({ text: 'Merci d\'avoir participé !', iconURL: channel.guild.iconURL() })
        .setTimestamp()
        .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

      await message.edit({ embeds: [winnerEmbed], components: [] });

      if (winners.length) {
        const thread = await message.startThread({
          name: `Gagnants - ${giveaway.prix}`,
          type: ChannelType.PrivateThread,
          autoArchiveDuration: 1440,
          reason: 'Thread privé pour les gagnants',
        });
        for (const winner of winners) {
          await thread.members.add(winner.id).catch(() => {});
        }

        const threadEmbed = createEmbed(
          '🎉 Félicitations ! 🎉',
          `
            Vous avez gagné **${giveaway.prix}** !
            Contactez un modérateur pour réclamer votre prix.
          `,
          giveaway.organizer,
          giveaway.commentaire
        )
          .setThumbnail(channel.guild.iconURL({ dynamic: true }))
          .setFooter({ text: 'Félicitations !', iconURL: channel.guild.iconURL() })
          .setTimestamp();

        await thread.send({ content: winners.map(w => `<@${w.id}>`).join(', '), embeds: [threadEmbed] });
      }

      deleteGiveaway(messageId);
    });
  }
});

// Événement interactionCreate
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  if (!limit(interaction.user.id)) {
    return interaction.reply({ content: '❌ Veuillez attendre avant de réessayer.', ephemeral: true });
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error('Erreur lors de l\'exécution de la commande:', error);
    await interaction.reply({ content: '⚠️ Il y a eu une erreur lors de l\'exécution de cette commande!', ephemeral: true });
  }
});

// Commande giveaway
client.commands.set('giveaway', {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Lancer un giveaway professionnel !')
    .addStringOption(option =>
      option.setName('prix')
        .setDescription('Le prix du giveaway')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('gagnants')
        .setDescription('Nombre de gagnants')
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption(option =>
      option.setName('durée')
        .setDescription('Durée du giveaway')
        .setRequired(true)
        .addChoices(
          { name: '5 minutes', value: '5m' },
          { name: '10 minutes', value: '10m' },
          { name: '30 minutes', value: '30m' },
          { name: '1 heure', value: '1h' },
          { name: '3 heures', value: '3h' },
          { name: '5 heures', value: '5h' },
          { name: '1 jour', value: '1d' },
          { name: '3 jours', value: '3d' },
          { name: '5 jours', value: '5d' },
          { name: '1 semaine', value: '1w' }
        )
    )
    .addRoleOption(option =>
      option.setName('rôle_requis')
        .setDescription('Rôle requis pour participer (optionnel)')
        .setRequired(false)
    )
    .addRoleOption(option =>
      option.setName('rôle_mention')
        .setDescription('Rôle à mentionner pour annoncer le giveaway (optionnel)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('commentaire')
        .setDescription('Commentaire ou informations supplémentaires (optionnel)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('image')
        .setDescription('URL de l\'image pour le giveaway (optionnel)')
        .setRequired(false)
    ),
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return interaction.reply({ content: '❌ Permissions insuffisantes pour lancer un giveaway.', ephemeral: true });
    }

    const prix = interaction.options.getString('prix');
    const gagnants = interaction.options.getInteger('gagnants');
    const duréeInput = interaction.options.getString('durée');
    const rôleRequis = interaction.options.getRole('rôle_requis');
    const rôleMention = interaction.options.getRole('rôle_mention');
    const commentaire = interaction.options.getString('commentaire');
    const image = interaction.options.getString('image');
    const organizer = interaction.user.id;

    const duréeMap = {
      '5m': 5 * 60 * 1000,
      '10m': 10 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '3h': 3 * 60 * 60 * 1000,
      '5h': 5 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
      '3d': 3 * 24 * 60 * 60 * 1000,
      '5d': 5 * 24 * 60 * 60 * 1000,
      '1w': 7 * 24 * 60 * 60 * 1000,
    };
    const duréeMs = duréeMap[duréeInput];
    const duréeText = {
      '5m': '5 minutes', '10m': '10 minutes', '30m': '30 minutes',
      '1h': '1 heure', '3h': '3 heures', '5h': '5 heures',
      '1d': '1 jour', '3d': '3 jours', '5d': '5 jours', '1w': '1 semaine'
    }[duréeInput];

    const embed = createEmbed(
      '🎉 Nouveau Giveaway en Cours 🎉',
      `
        **🎁 Prix** : ${prix}
        **🏆 Gagnants** : ${gagnants}
        **⏳ Durée** : ${duréeText}
        ${rôleRequis ? `**🔒 Rôle requis** : ${rôleRequis}` : ''}
      `,
      organizer,
      commentaire
    )
      .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
      .setFooter({ text: 'Cliquez pour participer !', iconURL: interaction.guild.iconURL() })
      .setTimestamp()
      .setImage(image || 'https://i.imgur.com/w5JVwaR.png');

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('enter').setLabel('Participer').setStyle(ButtonStyle.Secondary).setEmoji('🎉'),
        new ButtonBuilder().setCustomId('cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
        new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥')
      );

    const content = rôleMention ? `<@&${rôleMention.id}> Un nouveau giveaway vient de commencer !` : null;

    const message = await interaction.reply({
      content,
      embeds: [embed],
      components: [row],
      fetchReply: true
    });

    const giveaways = loadGiveaways();
    const participants = new Set();
    const giveaway = {
      messageId: message.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      prix,
      gagnants,
      endTime: Date.now() + duréeMs,
      participants: Array.from(participants),
      rôleRequis: rôleRequis ? rôleRequis.id : null,
      commentaire: commentaire || null,
      image: image || null,
      organizer
    };
    giveaways[message.id] = giveaway;
    saveGiveaway(giveaway);

    const collector = message.createMessageComponentCollector({ time: duréeMs });

    collector.on('collect', async i => {
      if (rôleRequis && !i.member.roles.cache.has(rôleRequis.id)) {
        return i.reply({ content: `❌ Vous devez avoir le rôle ${rôleRequis} pour participer.`, ephemeral: true });
      }

      if (i.customId === 'cancel') {
        if (!i.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          return i.reply({ content: '❌ Permissions insuffisantes pour annuler.', ephemeral: true });
        }
        collector.stop('cancelled');
        deleteGiveaway(message.id);
        await i.reply({ content: '⚠️ Giveaway annulé.', ephemeral: true });
        return;
      }

      if (i.customId === 'show_participants') {
        if (!i.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          return i.reply({ content: '❌ Permissions insuffisantes pour voir les participants.', ephemeral: true });
        }
        const participantsList = Array.from(participants).map(id => `<@${id}>`).join(', ') || 'Aucun participant.';
        const participantsEmbed = createEmbed('📋 Liste des Participants', participantsList, null, null)
          .setThumbnail(i.guild.iconURL({ dynamic: true }))
          .setFooter({ text: 'Participants actuels', iconURL: i.guild.iconURL() })
          .setTimestamp();
        return i.reply({ embeds: [participantsEmbed], ephemeral: true });
      }

      if (participants.has(i.user.id)) {
        return i.reply({ content: '❌ Vous participez déjà au giveaway.', ephemeral: true });
      }

      participants.add(i.user.id);
      giveaways[message.id].participants = Array.from(participants);
      saveGiveaway(giveaways[message.id]);

      await i.reply({ content: '✅ Vous avez rejoint le giveaway ! Bonne chance !', ephemeral: true });

      const updatedEmbed = createEmbed(
        '🎉 Nouveau Giveaway en Cours 🎉',
        `
          **🎁 Prix** : ${prix}
          **🏆 Gagnants** : ${gagnants}
          **⏳ Temps restant** : ${formatTime(giveaways[message.id].endTime - Date.now())}
          **👥 Participants** : ${participants.size}
          ${rôleRequis ? `**🔒 Rôle requis** : ${rôleRequis}` : ''}
        `,
        organizer,
        commentaire
      )
        .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
        .setFooter({ text: 'Cliquez pour participer !', iconURL: interaction.guild.iconURL() })
        .setTimestamp()
        .setImage(image || 'https://i.imgur.com/w5JVwaR.png');

      await message.edit({ embeds: [updatedEmbed] });
    });

    const interval = setInterval(async () => {
      const remainingTime = giveaways[message.id]?.endTime - Date.now();
      if (remainingTime <= 0) {
        clearInterval(interval);
        return;
      }

      const updatedEmbed = createEmbed(
        '🎉 Nouveau Giveaway en Cours 🎉',
        `
          **🎁 Prix** : ${prix}
          **🏆 Gagnants** : ${gagnants}
          **⏳ Temps restant** : ${formatTime(remainingTime)}
          **👥 Participants** : ${participants.size}
          ${rôleRequis ? `**🔒 Rôle requis** : ${rôleRequis}` : ''}
        `,
        organizer,
        commentaire
      )
        .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
        .setFooter({ text: 'Cliquez pour participer !', iconURL: interaction.guild.iconURL() })
        .setTimestamp()
        .setImage(image || 'https://i.imgur.com/w5JVwaR.png');

      await message.edit({ embeds: [updatedEmbed] });
    }, 60000);

    collector.on('end', async (collected, reason) => {
      clearInterval(interval);
      if (!giveaways[message.id]) return;

      if (reason === 'cancelled') {
        const cancelledEmbed = createEmbed('❌ Giveaway Annulé ❌', 'Le giveaway a été annulé. Merci à tous les participants !', organizer, null, 0xE74C3C)
          .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
          .setFooter({ text: 'Merci à tous !', iconURL: interaction.guild.iconURL() })
          .setTimestamp();
        await message.edit({ embeds: [cancelledEmbed], components: [] });
        deleteGiveaway(message.id);
        return;
      }

      const winners = Array.from(participants).slice(0, gagnants).map(id => interaction.guild.members.cache.get(id)).filter(Boolean);
      const winnerEmbed = createEmbed(
        '🎊 Giveaway Conclu avec Succès ! 🎊',
        winners.length
          ? `**Félicitations aux gagnants !**\n${winners.map(w => `• ${w.user.tag} (<@${w.id}>)`).join('\n')}\n\nMerci à tous pour votre participation ! De nouveaux giveaways arrivent bientôt, restez à l'affût !`
          : 'Aucun participant pour ce giveaway. Tentez votre chance la prochaine fois !',
        organizer,
        commentaire,
        0x2ECC71
      )
        .addFields(
          { name: '🎁 Prix', value: prix, inline: true },
          { name: '🏆 Nombre de gagnants', value: `${gagnants}`, inline: true }
        )
        .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
        .setFooter({ text: 'Merci d\'avoir participé !', iconURL: interaction.guild.iconURL() })
        .setTimestamp()
        .setImage(image || 'https://i.imgur.com/w5JVwaR.png');

      await message.edit({ embeds: [winnerEmbed], components: [] });

      if (winners.length) {
        const thread = await message.startThread({
          name: `Gagnants - ${prix}`,
          type: ChannelType.PrivateThread,
          autoArchiveDuration: 1440,
          reason: 'Thread privé pour les gagnants',
        });
        for (const winner of winners) {
          await thread.members.add(winner.id).catch(() => {});
        }

        const threadEmbed = createEmbed(
          '🎉 Félicitations ! 🎉',
          `
            Vous avez gagné **${prix}** !
            Contactez un modérateur pour réclamer votre prix.
          `,
          organizer,
          commentaire
        )
          .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
          .setFooter({ text: 'Félicitations !', iconURL: interaction.guild.iconURL() })
          .setTimestamp();

        await thread.send({ content: winners.map(w => `<@${w.id}>`).join(', '), embeds: [threadEmbed] });
      }

      deleteGiveaway(message.id);
    });
  }
});

// Connecter le bot à Discord
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('✅ Connecté à Discord avec succès.'))
  .catch(error => console.error('⚠️ Erreur lors de la connexion à Discord:', error));
