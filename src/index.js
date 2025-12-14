'use strict';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import NodeCache from 'node-cache';
import { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType, SlashCommandBuilder, ActivityType, REST, Routes, MessageFlags } from 'discord.js';

// Définir __dirname pour les modules ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration des variables d'environnement
dotenv.config();

// Initialisation des caches
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const giveawaysCache = new NodeCache({ stdTTL: 10 * 24 * 60 * 60, checkperiod: 3600 });
const rateLimiterCache = new NodeCache({ stdTTL: 10, checkperiod: 60 });

// Variables globales pour stocker les intervalles
const activeIntervals = new Map();

// Fonction pour valider une URL d'image
const isValidImageUrl = (url) => {
  try {
    new URL(url);
    return /\.(jpg|jpeg|png|gif|bmp|webp|avif)$/i.test(url);
  } catch {
    return false;
  }
};

// Fonction pour convertir en timestamp Unix (secondes)
function getUnixTimestamp(ms) {
  return Math.floor(ms / 1000);
}

// Initialisation de la base de données SQLite
const db = new Database(path.join(__dirname, 'giveaways.db'), {
  verbose: process.env.NODE_ENV === 'development' ? console.log : null,
  fileMustExist: false,
  timeout: 5000
});

// Activer WAL mode pour de meilleures performances
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = 1000');
db.pragma('temp_store = MEMORY');
db.pragma('foreign_keys = ON');
db.pragma('mmap_size = 268435456');


// Migration de la base de données
const migrateDatabase = () => {
  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='giveaways'").get();
   
    if (!tableExists) {
      db.exec(`
        CREATE TABLE giveaways (
          messageId TEXT PRIMARY KEY,
          channelId TEXT,
          guildId TEXT,
          prix TEXT,
          gagnants INTEGER,
          endTime INTEGER,
          participants TEXT,
          roleRequired TEXT,
          commentaire TEXT,
          image TEXT,
          organizer TEXT,
          tournament_phase TEXT DEFAULT 'single',
          parent_tournament_id TEXT,
          phase_number INTEGER DEFAULT 1,
          total_phases INTEGER DEFAULT 1,
          qualified_users TEXT DEFAULT '[]',
          giveawayId TEXT UNIQUE
        )
      `);
      console.log('✅ Table giveaways créée');
    }
    
    // Vérifier et ajouter les colonnes manquantes
    const columns = db.prepare("PRAGMA table_info(giveaways)").all();
    const columnNames = columns.map(col => col.name);
    const requiredColumns = [
      'parent_tournament_id', 'phase_number', 'total_phases', 'qualified_users',
      'tournament_phase', 'giveawayId'
    ];
    
    for (const column of requiredColumns) {
      if (!columnNames.includes(column)) {
        let columnType = 'TEXT';
        if (column === 'phase_number' || column === 'total_phases') {
          columnType = 'INTEGER';
        }
       
        try {
          db.exec(`ALTER TABLE giveaways ADD COLUMN ${column} ${columnType} DEFAULT ${columnType === 'INTEGER' ? '1' : "'[]'"}`);
          console.log(`✅ Colonne ${column} ajoutée`);
        } catch (error) {
          console.log(`⚠️ Colonne ${column} déjà présente:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('❌ Erreur lors de la migration:', error);
  }
};

// Exécuter la migration
migrateDatabase();

// Classe pour le système de tournoi
class TournamentSystem {
  static generateTournamentId() {
    return `TOURNAMENT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  static parseDuration(durationStr) {
    const units = {
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000,
      'w': 7 * 24 * 60 * 60 * 1000
    };
   
    const value = parseInt(durationStr);
    const unit = durationStr.replace(value.toString(), '');
    return value * (units[unit] || 60 * 1000); // Par défaut: minutes
  }

  static getPhaseEmoji(phaseNumber) {
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '🏆'];
    return emojis[phaseNumber - 1] || '🎯';
  }

  static async createTournament(interaction, options) {
    const tournamentId = this.generateTournamentId();
   
    // Créer la première phase
    const firstPhase = await this.createTournamentPhase(interaction, tournamentId, {
      name: 'Phase 1 - Qualifications',
      duration: options.phase1Duration,
      winners: options.phase1Winners,
      phaseNumber: 1,
      totalPhases: 3
    }, options);
    return { tournamentId, currentPhase: firstPhase };
  }

  static async createTournamentPhase(interaction, tournamentId, phase, options) {
    const durationMs = this.parseDuration(phase.duration);
    const endTime = Date.now() + durationMs;
    const phaseId = `TOURNEY-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    
    const embed = new EmbedBuilder()
      .setTitle(`🏆 Tournoi - ${phase.name} ${this.getPhaseEmoji(phase.phaseNumber)}`)
      .setDescription(`
        **🎁 Prix Final** : ${options.prix}
        **🏆 Gagnants Phase** : ${phase.winners}
        **⏳ Fin** : <t:${getUnixTimestamp(endTime)}:R>
        **🔢 Phase** : ${phase.phaseNumber}/${phase.totalPhases}
        **👥 Participants** : 0
        ${options.roleRequired ? `**🔒 Rôle requis** : ${options.roleRequired}` : ''}
       
        *Les ${phase.winners} meilleurs participants se qualifieront pour la phase suivante !*
      `)
      .setColor(0xA8E4A0)
      .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
      .setFooter({ text: `ID: ${phaseId}`, iconURL: interaction.guild.iconURL({ dynamic: true }) })
      .setTimestamp()
      .setImage(options.image || 'https://i.imgur.com/w5JVwaR.png');

    if (options.commentaire) {
      embed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${options.commentaire}` });
    }

    // Créer les boutons selon la phase
    const row = new ActionRowBuilder();
 
    if (phase.phaseNumber === 1) {
      row.addComponents(
        new ButtonBuilder().setCustomId('enter').setLabel('Participer').setStyle(ButtonStyle.Secondary).setEmoji('🎉'),
        new ButtonBuilder().setCustomId('leave').setLabel('Se retirer').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
        new ButtonBuilder().setCustomId('cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
        new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥')
      );
    } else {
      row.addComponents(
        new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
        new ButtonBuilder().setCustomId('tournament_leaderboard').setLabel('Classement').setStyle(ButtonStyle.Secondary).setEmoji('🏆')
      );
    }

    const message = await interaction.channel.send({
      embeds: [embed],
      components: [row]
    });

    const participants = phase.phaseNumber === 1 ? [] : (options.previousQualified || []);
    const giveaway = {
      messageId: message.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      prix: options.prix,
      gagnants: phase.winners,
      endTime: endTime,
      participants: participants,
      roleRequired: options.roleRequired ? options.roleRequired.id : null,
      commentaire: options.commentaire || null,
      image: options.image || null,
      organizer: interaction.user.id,
      tournament_phase: 'tournament',
      parent_tournament_id: tournamentId,
      phase_number: phase.phaseNumber,
      total_phases: phase.totalPhases,
      qualified_users: [],
      giveawayId: phaseId
    };

    saveGiveaway(giveaway);
    this.startPhaseCountdown(message, giveaway, phase, durationMs);
 
    return giveaway;
  }

  static async startPhaseCountdown(message, giveaway, phase, totalDuration) {
    // Arrêter tout intervalle existant pour ce giveaway
    if (activeIntervals.has(giveaway.messageId)) {
      clearInterval(activeIntervals.get(giveaway.messageId));
      activeIntervals.delete(giveaway.messageId);
    }
    
    // Fonction de vérification initiale
    const checkInitial = async () => {
      const currentGiveaway = giveawaysCache.get(giveaway.messageId);
      if (!currentGiveaway) {
        if (activeIntervals.has(giveaway.messageId)) {
          clearInterval(activeIntervals.get(giveaway.messageId));
          activeIntervals.delete(giveaway.messageId);
        }
        return;
      }
      
      const remainingTime = currentGiveaway.endTime - Date.now();
      
      // Vérifier si le temps est écoulé
      if (remainingTime <= 0) {
        if (activeIntervals.has(giveaway.messageId)) {
          clearInterval(activeIntervals.get(giveaway.messageId));
          activeIntervals.delete(giveaway.messageId);
        }
        await this.endTournamentPhase(message, currentGiveaway);
        return;
      }
    };
    
    // Exécuter la vérification initiale immédiatement
    await checkInitial();
    
    // Démarrer l'intervalle
    const interval = setInterval(async () => {
      try {
        const currentGiveaway = giveawaysCache.get(giveaway.messageId);
        if (!currentGiveaway) {
          clearInterval(interval);
          activeIntervals.delete(giveaway.messageId);
          return;
        }
        
        const remainingTime = currentGiveaway.endTime - Date.now();
        
        // Vérifier si le temps est écoulé
        if (remainingTime <= 0) {
          clearInterval(interval);
          activeIntervals.delete(giveaway.messageId);
          await this.endTournamentPhase(message, currentGiveaway);
          return;
        }

        const updatedEmbed = new EmbedBuilder()
          .setTitle(`🏆 Tournoi - ${phase.name} ${this.getPhaseEmoji(phase.phaseNumber)}`)
          .setDescription(`
            **🎁 Prix Final** : ${giveaway.prix}
            **🏆 Gagnants Phase** : ${phase.winners}
            **⏳ Fin** : <t:${getUnixTimestamp(currentGiveaway.endTime)}:R>
            **🔢 Phase** : ${phase.phaseNumber}/${phase.totalPhases}
            **👥 Participants** : ${currentGiveaway.participants.length}
            ${giveaway.roleRequired ? `**🔒 Rôle requis** : <@&${giveaway.roleRequired}>` : ''}
           
            *Les ${phase.winners} meilleurs participants se qualifieront pour la phase suivante !*
          `)
          .setColor(0xA8E4A0)
          .setThumbnail(message.guild.iconURL({ dynamic: true }))
          .setFooter({ text: `ID: ${giveaway.giveawayId} Tournoi - Phase ${phase.phaseNumber}`, iconURL: message.guild.iconURL({ dynamic: true }) })
          .setTimestamp()
          .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

        if (giveaway.commentaire) {
          updatedEmbed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${giveaway.commentaire}` });
        }

        await message.edit({ embeds: [updatedEmbed] }).catch(() => {
          clearInterval(interval);
          activeIntervals.delete(giveaway.messageId);
        });
      } catch (error) {
        console.error('Erreur dans le compte à rebours:', error);
        clearInterval(interval);
        activeIntervals.delete(giveaway.messageId);
      }
    }, 30000); // Mise à jour toutes les 30 secondes
    
    // Stocker l'intervalle pour gestion future
    activeIntervals.set(giveaway.messageId, interval);
  }

  static async startClassicCountdown(message, giveaway, totalDuration) {
    // Arrêter tout intervalle existant pour ce giveaway
    if (activeIntervals.has(giveaway.messageId)) {
      clearInterval(activeIntervals.get(giveaway.messageId));
      activeIntervals.delete(giveaway.messageId);
    }
    
    // Fonction de vérification initiale
    const checkInitial = async () => {
      const currentGiveaway = giveawaysCache.get(giveaway.messageId);
      if (!currentGiveaway) {
        if (activeIntervals.has(giveaway.messageId)) {
          clearInterval(activeIntervals.get(giveaway.messageId));
          activeIntervals.delete(giveaway.messageId);
        }
        return;
      }
      
      const remainingTime = currentGiveaway.endTime - Date.now();
      
      // Vérifier si le temps est écoulé
      if (remainingTime <= 0) {
        if (activeIntervals.has(giveaway.messageId)) {
          clearInterval(activeIntervals.get(giveaway.messageId));
          activeIntervals.delete(giveaway.messageId);
        }
        await endClassicGiveaway(message, currentGiveaway);
        return;
      }
    };
    
    // Exécuter la vérification initiale immédiatement
    await checkInitial();
    
    // Démarrer l'intervalle
    const interval = setInterval(async () => {
      try {
        const currentGiveaway = giveawaysCache.get(giveaway.messageId);
        if (!currentGiveaway) {
          clearInterval(interval);
          activeIntervals.delete(giveaway.messageId);
          return;
        }
        
        const remainingTime = currentGiveaway.endTime - Date.now();
        if (remainingTime <= 0) {
          clearInterval(interval);
          activeIntervals.delete(giveaway.messageId);
          await endClassicGiveaway(message, currentGiveaway);
          return;
        }
        
        const updatedEmbed = new EmbedBuilder()
          .setTitle('🎉 Giveaway en Cours 🎉')
          .setDescription(`
            **🎁 Prix** : ${giveaway.prix}
            **🏆 Gagnants** : ${giveaway.gagnants}
            **⏳ Fin** : <t:${getUnixTimestamp(currentGiveaway.endTime)}:R>
            **👥 Participants** : ${currentGiveaway.participants.length}
            ${giveaway.roleRequired ? `**🔒 Rôle requis** : <@&${giveaway.roleRequired}>` : ''}
          `)
          .setColor(0xA8E4A0)
          .setThumbnail(message.guild.iconURL({ dynamic: true }))
          .setFooter({ text: `ID: ${giveaway.giveawayId}`, iconURL: message.guild.iconURL({ dynamic: true }) })
          .setTimestamp()
          .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

        if (giveaway.commentaire) {
          updatedEmbed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${giveaway.commentaire}` });
        }

        await message.edit({ embeds: [updatedEmbed] }).catch(() => {
          clearInterval(interval);
          activeIntervals.delete(giveaway.messageId);
        });
      } catch (error) {
        console.error('Erreur dans le compte à rebours classique:', error);
        clearInterval(interval);
        activeIntervals.delete(giveaway.messageId);
      }
    }, 30000); // Mise à jour toutes les 30 secondes
    
    // Stocker l'intervalle pour gestion future
    activeIntervals.set(giveaway.messageId, interval);
  }

  static async endTournamentPhase(message, giveaway) {
    const currentGiveaway = giveawaysCache.get(giveaway.messageId);
    if (!currentGiveaway) return;

    // Nettoyer l'intervalle
    if (activeIntervals.has(currentGiveaway.messageId)) {
      clearInterval(activeIntervals.get(currentGiveaway.messageId));
      activeIntervals.delete(currentGiveaway.messageId);
    }

    // Sélectionner les gagnants par tirage au sort
    const qualifiedUsers = [...currentGiveaway.participants]
      .sort(() => Math.random() - 0.5)
      .slice(0, currentGiveaway.gagnants);

    currentGiveaway.qualified_users = qualifiedUsers;
    saveGiveaway(currentGiveaway);

    const qualifiedMembers = qualifiedUsers.map(id => message.guild.members.cache.get(id)).filter(Boolean);
    const organizer = await message.guild.members.fetch(currentGiveaway.organizer).catch(() => null);
    
    const resultEmbed = new EmbedBuilder()
      .setTitle(`🏆 Phase ${currentGiveaway.phase_number} Terminée !`)
      .setDescription(
        qualifiedMembers.length
          ? `**🎉 Qualifiés pour la phase suivante (${qualifiedMembers.length}/${currentGiveaway.gagnants}) :**\n${qualifiedMembers.map(m => `• ${m.user.tag} (<@${m.id}>)`).join('\n')}`
          : '❌ Aucun participant pour cette phase.'
      )
      .setColor(0xFF9999)
      .addFields(
        { name: '🎁 Prix Final', value: currentGiveaway.prix, inline: true },
        { name: '🔢 Phase', value: `${currentGiveaway.phase_number}/${currentGiveaway.total_phases}`, inline: true },
        { name: '👥 Participants totaux', value: `${currentGiveaway.participants.length}`, inline: true },
        { name: '👤 Organisateur', value: organizer ? `<@${organizer.id}>` : 'Inconnu', inline: true }
      )
      .setThumbnail(message.guild.iconURL({ dynamic: true }))
      .setFooter({ text: `ID: ${currentGiveaway.giveawayId} Tournoi - Phase ${currentGiveaway.phase_number} terminée`, iconURL: message.guild.iconURL({ dynamic: true }) })
      .setTimestamp()
      .setImage(currentGiveaway.image || 'https://i.imgur.com/w5JVwaR.png');

    if (currentGiveaway.commentaire) {
      resultEmbed.addFields({
        name: '📝 **Informations supplémentaires :**',
        value: `${currentGiveaway.commentaire}`,
        inline: false
      });
    }

    await message.edit({ embeds: [resultEmbed], components: [] });

    if (currentGiveaway.phase_number < currentGiveaway.total_phases) {
      await this.startNextPhase(message, currentGiveaway);
    } else {
      await this.endTournament(message, currentGiveaway);
    }

    deleteGiveaway(currentGiveaway.messageId);
  }

  static async startNextPhase(originalMessage, previousPhase) {
    const nextPhaseNumber = previousPhase.phase_number + 1;
    const phases = {
      2: {
        name: 'Phase 2 - Demi-finales',
        duration: '2h',
        winners: Math.ceil(previousPhase.gagnants * 0.5),
        phaseNumber: 2,
        totalPhases: 3
      },
      3: {
        name: 'Phase Finale',
        duration: '1h',
        winners: Math.max(1, Math.ceil(previousPhase.gagnants * 0.3)),
        phaseNumber: 3,
        totalPhases: 3
      }
    };

    const nextPhase = phases[nextPhaseNumber];
    if (!nextPhase) return;

    const durationMs = this.parseDuration(nextPhase.duration);
    const endTime = Date.now() + durationMs;
    
    const embed = new EmbedBuilder()
      .setTitle(`🏆 Tournoi - ${nextPhase.name} ${this.getPhaseEmoji(nextPhaseNumber)}`)
      .setDescription(`
        **🎁 Prix Final** : ${previousPhase.prix}
        **🏆 Gagnants Phase** : ${nextPhase.winners}
        **⏳ Fin** : <t:${getUnixTimestamp(endTime)}:R>
        **🔢 Phase** : ${nextPhaseNumber}/${nextPhase.totalPhases}
        **👥 Qualifiés** : ${previousPhase.qualified_users.length}
       
        *Bonne chance aux qualifiés de la phase précédente !*
      `)
      .setColor(0xA8E4A0)
      .setThumbnail(originalMessage.guild.iconURL({ dynamic: true }))
      .setFooter({ text: `ID: ${previousPhase.giveawayId} Tournoi - Phase ${nextPhaseNumber}`, iconURL: originalMessage.guild.iconURL({ dynamic: true }) })
      .setTimestamp()
      .setImage(previousPhase.image || 'https://i.imgur.com/w5JVwaR.png');

    if (previousPhase.commentaire) {
      embed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${previousPhase.commentaire}` });
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
        new ButtonBuilder().setCustomId('tournament_leaderboard').setLabel('Classement').setStyle(ButtonStyle.Secondary).setEmoji('🏆')
      );

    const message = await originalMessage.channel.send({
      content: `🎉 **PHASE SUIVANTE !** Félicitations aux qualifiés : ${previousPhase.qualified_users.map(id => `<@${id}>`).join(', ')}`,
      embeds: [embed],
      components: [row]
    });

    const newGiveaway = {
      messageId: message.id,
      channelId: originalMessage.channelId,
      guildId: originalMessage.guildId,
      prix: previousPhase.prix,
      gagnants: nextPhase.winners,
      endTime: endTime,
      participants: previousPhase.qualified_users,
      roleRequired: previousPhase.roleRequired,
      commentaire: previousPhase.commentaire,
      image: previousPhase.image,
      organizer: previousPhase.organizer,
      tournament_phase: 'tournament',
      parent_tournament_id: previousPhase.parent_tournament_id,
      phase_number: nextPhaseNumber,
      total_phases: nextPhase.totalPhases,
      qualified_users: [],
      giveawayId: `${previousPhase.giveawayId}-PH${nextPhaseNumber}`
    };

    saveGiveaway(newGiveaway);
    this.startPhaseCountdown(message, newGiveaway, nextPhase, durationMs);
  }

  static async endTournament(message, finalPhase) {
    // Nettoyer l'intervalle
    if (activeIntervals.has(finalPhase.messageId)) {
      clearInterval(activeIntervals.get(finalPhase.messageId));
      activeIntervals.delete(finalPhase.messageId);
    }

    const winners = finalPhase.qualified_users;
    const winnerMembers = winners.map(id => message.guild.members.cache.get(id)).filter(Boolean);
    const organizer = await message.guild.members.fetch(finalPhase.organizer).catch(() => null);
    
    const winnerEmbed = new EmbedBuilder()
      .setTitle('🎊 TOURNOI TERMINÉ ! 🎊')
      .setDescription(
        winnerMembers.length
          ? `**🏆 GRANDS GAGNANTS DU TOURNOI !**\n${winnerMembers.map(w => `• ${w.user.tag} (<@${w.id}>)`).join('\n')}\n\nFélicitations à tous les participants !`
          : '❌ Aucun gagnant pour ce tournoi.'
      )
      .setColor(0xFF9999)
      .addFields(
        { name: '🎁 Prix', value: finalPhase.prix, inline: true },
        { name: '🏆 Gagnants', value: `${winnerMembers.length}`, inline: true },
        { name: '🔢 Phases', value: `${finalPhase.total_phases}`, inline: true },
        { name: '👤 Organisateur', value: organizer ? `<@${organizer.id}>` : 'Inconnu', inline: true }
      )
      .setThumbnail(message.guild.iconURL({ dynamic: true }))
      .setFooter({ text: `ID: ${finalPhase.giveawayId} Tournoi terminé - Félicitations !`, iconURL: message.guild.iconURL({ dynamic: true }) })
      .setTimestamp()
      .setImage(finalPhase.image || 'https://i.imgur.com/w5JVwaR.png');

    if (finalPhase.commentaire) {
      winnerEmbed.addFields({
        name: '📝 **Informations supplémentaires :**',
        value: `${finalPhase.commentaire}`,
        inline: false
      });
    }

    await message.channel.send({ embeds: [winnerEmbed] });
    await createPrivateThreadForWinners(message.channel, winners, finalPhase);
    deleteGiveaway(finalPhase.messageId);
  }
}

// Fonction pour créer un fil privé pour les gagnants
async function createPrivateThreadForWinners(channel, winners, giveaway) {
  try {
    if (winners.length === 0) return;
    const winnerMembers = winners.map(id => channel.guild.members.cache.get(id)).filter(Boolean);
   
    if (winnerMembers.length === 0) return;
    
    if (!channel.permissionsFor(channel.guild.members.me).has(PermissionsBitField.Flags.CreatePrivateThreads)) {
      console.log('❌ Pas de permission pour créer un fil privé');
      return;
    }
    
    const threadName = `🎉 Gagnants - ${giveaway.prix.substring(0, 50)}`;
   
    const thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      type: ChannelType.PrivateThread,
      reason: 'Fil privé pour les gagnants du giveaway'
    });
    
    for (const member of winnerMembers) {
      try {
        await thread.members.add(member.id);
      } catch (error) {
        console.log(`❌ Impossible d'ajouter ${member.user.tag} au fil:`, error.message);
      }
    }
    
    try {
      const organizer = await channel.guild.members.fetch(giveaway.organizer);
      await thread.members.add(organizer);
    } catch (error) {
      console.log('❌ Impossible d\'ajouter l\'organisateur au fil:', error.message);
    }
    
    const welcomeEmbed = new EmbedBuilder()
      .setTitle('🎊 Félicitations aux Gagnants ! 🎊')
      .setDescription(`
        **🎁 Prix Gagné :** ${giveaway.prix}
        **🏆 Gagnants :** ${winnerMembers.map(m => `<@${m.id}>`).join(', ')}
       
        *Ce fil privé a été créé pour discuter de la remise de votre prix.*
        **Organisateur :** <@${giveaway.organizer}>
       
        ${giveaway.commentaire ? `📝 **Informations supplémentaires :**\n${giveaway.commentaire}` : ''}
       
        **💬 Discussion :** Utilisez ce fil pour coordonner la réception de votre prix avec l'organisateur.
      `)
      .setColor(0xA8E4A0)
      .setThumbnail(channel.guild.iconURL({ dynamic: true }))
      .setTimestamp();
    
    await thread.send({
      content: `🎉 Félicitations ${winnerMembers.map(m => `<@${m.id}>`).join(' ')} !`,
      embeds: [welcomeEmbed]
    });
    
    const winnerMentions = winnerMembers.map(m => `<@${m.id}>`).join(' ');
    await channel.send(`🎉 Félicitations ${winnerMentions} ! Vous avez gagné ! Consultez le thread privé ${thread} pour plus de détails.`);
  } catch (error) {
    console.error('❌ Erreur lors de la création du fil privé:', error);
  }
}

// Créer une nouvelle instance de client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
  rest: { timeout: 30000, retries: 3 },
  shards: 'auto',
});

// Collections
client.commands = new Map();

// Fonction pour relancer les compteurs des giveaways existants
async function restartAllGiveaways() {
  console.log('🔄 Redémarrage des compteurs de giveaways...');
  
  const rows = db.prepare('SELECT * FROM giveaways').all();
  let restartedCount = 0;
  
  for (const row of rows) {
    try {
      row.participants = JSON.parse(row.participants || '[]');
      row.qualified_users = JSON.parse(row.qualified_users || '[]');
      
      // Vérifier si le giveaway est toujours valide
      const remainingTime = row.endTime - Date.now();
      
      if (remainingTime <= 0) {
        // Giveaway expiré, le terminer
        await processExpiredGiveaway(row);
      } else {
        // Relancer le compteur
        await restartGiveawayCountdown(row);
        restartedCount++;
      }
    } catch (error) {
      console.error(`❌ Erreur lors du redémarrage du giveaway ${row.giveawayId}:`, error);
    }
  }
  
  console.log(`✅ ${restartedCount} compteurs de giveaways redémarrés`);
}

// Fonction pour relancer un compteur de giveaway spécifique
async function restartGiveawayCountdown(giveaway) {
  try {
    // Récupérer le canal et le message
    const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
    if (!channel) {
      console.log(`❌ Canal ${giveaway.channelId} introuvable pour le giveaway ${giveaway.giveawayId}`);
      return;
    }
    
    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (!message) {
      console.log(`❌ Message ${giveaway.messageId} introuvable pour le giveaway ${giveaway.giveawayId}`);
      return;
    }
    
    const remainingTime = giveaway.endTime - Date.now();
    
    // Mettre à jour le cache
    giveawaysCache.set(giveaway.messageId, giveaway);
    
    // Relancer le compteur approprié
    if (giveaway.tournament_phase === 'tournament') {
      const phase = {
        name: giveaway.phase_number === 1 ? 'Phase 1 - Qualifications' : 
               giveaway.phase_number === 2 ? 'Phase 2 - Demi-finales' : 'Phase Finale',
        winners: giveaway.gagnants,
        phaseNumber: giveaway.phase_number,
        totalPhases: giveaway.total_phases
      };
      
      await TournamentSystem.startPhaseCountdown(message, giveaway, phase, remainingTime);
    } else {
      await TournamentSystem.startClassicCountdown(message, giveaway, remainingTime);
    }
    
    console.log(`✅ Compteur relancé pour le giveaway ${giveaway.giveawayId}`);
  } catch (error) {
    console.error(`❌ Erreur lors du redémarrage du giveaway ${giveaway.giveawayId}:`, error);
  }
}

// Fonction pour traiter les giveaways expirés
async function processExpiredGiveaway(giveaway) {
  try {
    // Récupérer le canal et le message
    const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
    if (!channel) {
      console.log(`❌ Canal introuvable pour le giveaway expiré ${giveaway.giveawayId}`);
      deleteGiveaway(giveaway.messageId);
      return;
    }
    
    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (!message) {
      console.log(`❌ Message introuvable pour le giveaway expiré ${giveaway.giveawayId}`);
      deleteGiveaway(giveaway.messageId);
      return;
    }
    
    // Terminer le giveaway
    if (giveaway.tournament_phase === 'tournament') {
      await TournamentSystem.endTournamentPhase(message, giveaway);
    } else {
      await endClassicGiveaway(message, giveaway);
    }
    
    console.log(`✅ Giveaway expiré ${giveaway.giveawayId} traité`);
  } catch (error) {
    console.error(`❌ Erreur lors du traitement du giveaway expiré ${giveaway.giveawayId}:`, error);
  }
}

// Gestion des giveaways
const loadGiveaways = () => {
  const rows = db.prepare('SELECT * FROM giveaways').all();
  const giveaways = {};
  
  for (const row of rows) {
    row.participants = JSON.parse(row.participants || '[]');
    row.qualified_users = JSON.parse(row.qualified_users || '[]');
   
    if (!row.giveawayId) {
      row.giveawayId = `GIV-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      const updateStmt = db.prepare('UPDATE giveaways SET giveawayId = ? WHERE messageId = ?');
      updateStmt.run(row.giveawayId, row.messageId);
    }
   
    giveaways[row.messageId] = row;
    giveawaysCache.set(row.messageId, row);
  }
  
  return giveaways;
};

const saveGiveaway = (giveaway) => {
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO giveaways (
        messageId, channelId, guildId, prix, gagnants, endTime, participants,
        roleRequired, commentaire, image, organizer,
        tournament_phase, parent_tournament_id, phase_number, total_phases, qualified_users, giveawayId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      giveaway.messageId,
      giveaway.channelId,
      giveaway.guildId,
      giveaway.prix,
      giveaway.gagnants,
      giveaway.endTime,
      JSON.stringify(giveaway.participants),
      giveaway.roleRequired,
      giveaway.commentaire,
      giveaway.image,
      giveaway.organizer,
      giveaway.tournament_phase || 'single',
      giveaway.parent_tournament_id || null,
      giveaway.phase_number || 1,
      giveaway.total_phases || 1,
      JSON.stringify(giveaway.qualified_users || []),
      giveaway.giveawayId
    );
    
    giveawaysCache.set(giveaway.messageId, giveaway);
  } catch (error) {
    console.error('Erreur sauvegarde giveaway:', error);
  }
};

const deleteGiveaway = (messageId) => {
  db.prepare('DELETE FROM giveaways WHERE messageId = ?').run(messageId);
  giveawaysCache.del(messageId);
  
  // Nettoyer l'intervalle si il existe
  if (activeIntervals.has(messageId)) {
    clearInterval(activeIntervals.get(messageId));
    activeIntervals.delete(messageId);
  }
};

function updateActivity() {
  client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });
}

client.on("guildCreate", async guild => {
  updateActivity();
});

client.on("guildDelete", async guild => {
  updateActivity();
});

// Rate limiter
const limit = (userId, cooldown = 1000) => {
  const now = Date.now();
  const lastRequest = rateLimiterCache.get(userId);
  if (lastRequest && now - lastRequest < cooldown) return false;
  rateLimiterCache.set(userId, now);
  return true;
};

// Fonction pour sélectionner les gagnants
function selectWinners(participants, winnerCount) {
  if (participants.length === 0) return [];
  const shuffled = [...participants].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(winnerCount, participants.length));
}

// Fonction pour terminer un giveaway classique
async function endClassicGiveaway(message, giveaway) {
  const currentGiveaway = giveawaysCache.get(giveaway.messageId);
  if (!currentGiveaway) return;
  
  // Nettoyer l'intervalle
  if (activeIntervals.has(currentGiveaway.messageId)) {
    clearInterval(activeIntervals.get(currentGiveaway.messageId));
    activeIntervals.delete(currentGiveaway.messageId);
  }
  
  const winners = selectWinners(currentGiveaway.participants, currentGiveaway.gagnants);
  const winnerMembers = winners.map(id => message.guild.members.cache.get(id)).filter(Boolean);
  const organizer = await message.guild.members.fetch(currentGiveaway.organizer).catch(() => null);
  
  const resultEmbed = new EmbedBuilder()
    .setTitle('🎊 Giveaway Terminé ! 🎊')
    .setDescription(
      winnerMembers.length
        ? `**🏆 Gagnant(s) :**\n${winnerMembers.map(w => `• ${w.user.tag} (<@${w.id}>)`).join('\n')}`
        : `🥺 Aucun participant pour ce giveaway.\n💫 **Ne vous inquiétez pas !** D'autres giveaways arrivent bientôt.`
    )
    .setColor(0xFF9999)
    .addFields(
      { name: '🎁 Prix', value: currentGiveaway.prix, inline: false },
      { name: '👥 Participants totaux', value: `${currentGiveaway.participants.length}`, inline: false },
      { name: '👤 Organisateur', value: organizer ? `<@${organizer.id}>` : 'Inconnu', inline: false }
    )
    .setThumbnail(message.guild.iconURL({ dynamic: true }))
    .setFooter({ text: `ID: ${currentGiveaway.giveawayId} Giveaway terminé`, iconURL: message.guild.iconURL({ dynamic: true }) })
    .setTimestamp()
    .setImage(currentGiveaway.image || 'https://i.imgur.com/w5JVwaR.png');

  if (currentGiveaway.commentaire) {
    resultEmbed.addFields({
      name: '📝 **Informations supplémentaires :**',
      value: `${currentGiveaway.commentaire}`,
      inline: false
    });
  }

  await message.edit({ embeds: [resultEmbed], components: [] });
  await createPrivateThreadForWinners(message.channel, winners, currentGiveaway);
  deleteGiveaway(currentGiveaway.messageId);
}

// GESTION PRINCIPALE DES INTERACTIONS
client.on('interactionCreate', async (interaction) => {
  if (interaction.isCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    
    if (!limit(interaction.user.id)) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Veuillez attendre avant de réessayer.', flags: [MessageFlags.Ephemeral] });
      }
      return;
    }
    
    try {
      await command.execute(interaction);
    } catch (error) {
      console.error('Erreur lors de l\'exécution de la commande:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Erreur lors de l\'exécution de cette commande!', flags: [MessageFlags.Ephemeral] });
      }
    }
  } else if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
  }
});

// Fonction pour gérer les interactions de boutons
async function handleButtonInteraction(interaction) {
  const { customId, message, user, guild } = interaction;
 
  const giveaway = giveawaysCache.get(message.id);
  if (!giveaway) {
    return await interaction.reply({
      content: '❌ Ce giveaway n\'existe plus ou a expiré.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  if (customId === 'enter' && giveaway.tournament_phase === 'tournament' && giveaway.phase_number > 1) {
    return await interaction.reply({
      content: '❌ La participation à cette phase est fermée. Seuls les qualifiés des phases précédentes peuvent participer.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  switch (customId) {
    case 'enter':
      await handleEnterGiveaway(interaction, giveaway);
      break;
    case 'leave':
      await handleLeaveGiveaway(interaction, giveaway);
      break;
    case 'cancel':
      await handleCancelGiveaway(interaction, giveaway);
      break;
    case 'show_participants':
      await handleShowParticipants(interaction, giveaway);
      break;
    case 'tournament_leaderboard':
      await handleTournamentLeaderboard(interaction, giveaway);
      break;
    default:
      await interaction.reply({
        content: '❌ Action non reconnue.',
        flags: [MessageFlags.Ephemeral]
      });
  }
}

// Fonctions de gestion des boutons
async function handleEnterGiveaway(interaction, giveaway) {
  const { user, guild } = interaction;
  
  if (giveaway.roleRequired && !interaction.member.roles.cache.has(giveaway.roleRequired)) {
    const role = guild.roles.cache.get(giveaway.roleRequired);
    return await interaction.reply({
      content: `❌ Vous devez avoir le rôle ${role} pour participer.`,
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  if (giveaway.participants.includes(user.id)) {
    return await interaction.reply({
      content: '❌ Vous participez déjà au giveaway.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  giveaway.participants.push(user.id);
  saveGiveaway(giveaway);
  
  await interaction.reply({
    content: '✅ Vous avez rejoint le giveaway ! Bonne chance !',
    flags: [MessageFlags.Ephemeral]
  });
  
  await updateGiveawayEmbed(interaction.message, giveaway);
}

async function handleLeaveGiveaway(interaction, giveaway) {
  const { user, guild } = interaction;
  
  if (!giveaway.participants.includes(user.id)) {
    return await interaction.reply({
      content: '❌ Vous ne participez pas à ce giveaway.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  if (giveaway.endTime <= Date.now()) {
    return await interaction.reply({
      content: '❌ Ce giveaway est terminé, vous ne pouvez plus vous retirer.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  if (giveaway.tournament_phase === 'tournament' && giveaway.phase_number > 1) {
    return await interaction.reply({
      content: '❌ Vous ne pouvez pas vous retirer de cette phase de tournoi.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  const participantIndex = giveaway.participants.indexOf(user.id);
  if (participantIndex > -1) {
    giveaway.participants.splice(participantIndex, 1);
    saveGiveaway(giveaway);
  }
  
  await interaction.reply({
    content: '✅ Vous avez été retiré du giveaway.',
    flags: [MessageFlags.Ephemeral]
  });
  
  await updateGiveawayEmbed(interaction.message, giveaway);
}

async function handleCancelGiveaway(interaction, giveaway) {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    return await interaction.reply({
      content: '❌ Pas les permissions nécessaires.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  const organizer = await interaction.guild.members.fetch(giveaway.organizer).catch(() => null);
  const cancelledEmbed = new EmbedBuilder()
    .setTitle('❌ Giveaway Annulé ❌')
    .setDescription(`
      **📢 Annonce importante**
     
      Le giveaway a été annulé par l'organisateur.
     
      **🎁 Prix concerné :** ${giveaway.prix}
      **👥 Participants :** ${giveaway.participants.length}
      **🏆 Gagnants prévus :** ${giveaway.gagnants}
      **👤 Organisateur :** ${organizer ? `<@${organizer.id}>` : 'Inconnu'}
     
      *Nous tenons à remercier tous les participants pour leur intérêt.*
     
      💫 **Ne vous inquiétez pas !** D'autres giveaways arrivent bientôt.
    `)
    .setColor(0xE74C3C)
    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
    .setFooter({ text: `ID: ${giveaway.giveawayId} Giveaway annulé`, iconURL: interaction.guild.iconURL({ dynamic: true }) })
    .setTimestamp()
    .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

  if (giveaway.commentaire) {
    cancelledEmbed.addFields({
      name: '📝 **Informations supplémentaires :**',
      value: `${giveaway.commentaire}`,
      inline: false
    });
  }

  await interaction.message.edit({ embeds: [cancelledEmbed], components: [] });
  deleteGiveaway(giveaway.messageId);
 
  await interaction.reply({
    content: '⚠️ Giveaway annulé avec succès.',
    flags: [MessageFlags.Ephemeral]
  });
}

async function handleShowParticipants(interaction, giveaway) {
  if (!giveaway.participants.includes(interaction.user.id)) {
    return await interaction.reply({
      content: '❌ Vous devez participer au giveaway pour voir la liste des participants.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  const participantsList = giveaway.participants.map(id => `<@${id}>`).join(', ') || '👥 Aucun participant.';
  const participantsEmbed = new EmbedBuilder()
    .setTitle('📋 Liste des Participants')
    .setDescription(participantsList)
    .setColor(0x3498DB)
    .setFooter({ text: 'Participants actuels', iconURL: interaction.guild.iconURL({ dynamic: true }) })
    .setTimestamp();
  
  await interaction.reply({
    embeds: [participantsEmbed],
    flags: [MessageFlags.Ephemeral]
  });
}

async function handleTournamentLeaderboard(interaction, giveaway) {
  if (giveaway.tournament_phase !== 'tournament') {
    return await interaction.reply({
      content: '❌ Cette commande est réservée aux tournois.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  const sortedParticipants = [...giveaway.participants].sort(() => Math.random() - 0.5).slice(0, 10);
  
  const leaderboardList = await Promise.all(
    sortedParticipants.map(async (userId, index) => {
      const medals = ['🥇', '🥈', '🥉'];
      const medal = medals[index] || `${index + 1}️⃣`;
     
      try {
        const user = await client.users.fetch(userId);
        return `${medal} **${user.username}**`;
      } catch (error) {
        return `${medal} <@${userId}>`;
      }
    })
  );
  
  const finalList = leaderboardList.join('\n') || '👥 Aucun participant';
  const leaderboardEmbed = new EmbedBuilder()
    .setTitle(`🏆 Classement - Phase ${giveaway.phase_number}`)
    .setDescription(finalList)
    .setColor(0x3498DB)
    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
    .setFooter({ text: `Top ${sortedParticipants.length} participants`, iconURL: interaction.guild.iconURL({ dynamic: true }) })
    .setTimestamp();
  
  await interaction.reply({
    embeds: [leaderboardEmbed],
    flags: [MessageFlags.Ephemeral]
  });
}

// Fonction pour mettre à jour l'embed du giveaway
async function updateGiveawayEmbed(message, giveaway) {
  const description = `
    **🎁 Prix** : ${giveaway.prix}
    **🏆 Gagnants** : ${giveaway.gagnants}
    **⏳ Fin** : <t:${getUnixTimestamp(giveaway.endTime)}:R>
    **👥 Participants** : ${giveaway.participants.length}
    ${giveaway.roleRequired ? `**🔒 Rôle requis** : <@&${giveaway.roleRequired}>` : ''}
    ${giveaway.tournament_phase === 'tournament' ? `\n**🔢 Phase** : ${giveaway.phase_number}/${giveaway.total_phases}\n${giveaway.phase_number === 1 ? `*Les ${giveaway.gagnants} meilleurs participants se qualifieront pour la phase suivante !*` : `*Phase réservée aux qualifiés de la phase précédente.*`}` : ''}
  `;
  
  const embed = new EmbedBuilder()
    .setTitle(
      giveaway.tournament_phase === 'tournament'
        ? `🏆 Tournoi - Phase ${giveaway.phase_number} ${TournamentSystem.getPhaseEmoji(giveaway.phase_number)}`
        : '🎉 Giveaway en Cours 🎉'
    )
    .setDescription(description)
    .setColor(0xA8E4A0)
    .setThumbnail(message.guild.iconURL({ dynamic: true }))
    .setFooter({
      text: `ID: ${giveaway.giveawayId}`,
      iconURL: message.guild.iconURL({ dynamic: true })
    })
    .setTimestamp()
    .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

  if (giveaway.commentaire) {
    embed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${giveaway.commentaire}` });
  }
  
  await message.edit({ embeds: [embed] });
}

// Commande giveaway principale
const giveawayCommand = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Système de giveaways')
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Créer un giveaway classique')
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
          option.setName('role_requis')
            .setDescription('Rôle requis pour participer (optionnel)')
            .setRequired(false)
        )
        .addRoleOption(option =>
          option.setName('role_mention')
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
            .setDescription('URL de l\'image pour le giveaway (jpg, png, gif, etc.)')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('tournament')
        .setDescription('Créer un tournoi en plusieurs phases')
        .addStringOption(option =>
          option.setName('prix')
            .setDescription('Le prix final du tournoi')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option.setName('gagnants_phase1')
            .setDescription('Nombre de qualifiés pour la phase 1')
            .setRequired(true)
            .setMinValue(2)
        )
        .addStringOption(option =>
          option.setName('duree_phase1')
            .setDescription('Durée de la phase 1')
            .setRequired(true)
            .addChoices(
              { name: '30 minutes', value: '30m' },
              { name: '1 heure', value: '1h' },
              { name: '3 heures', value: '3h' },
              { name: '6 heures', value: '6h' },
              { name: '1 jour', value: '1d' }
            )
        )
        .addRoleOption(option =>
          option.setName('role_requis')
            .setDescription('Rôle requis pour participer (optionnel)')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('commentaire')
            .setDescription('Commentaire ou informations supplémentaires (optionnel)')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('image')
            .setDescription('URL de l\'image pour le tournoi (jpg, png, gif, etc.)')
            .setRequired(false)
        )
    ),
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return interaction.reply({ content: '❌ Permissions insuffisantes.', flags: [MessageFlags.Ephemeral] });
    }
    
    await interaction.deferReply();
    const subcommand = interaction.options.getSubcommand();
    
    switch (subcommand) {
      case 'create':
        try {
          await handleClassicGiveaway(interaction);
          await interaction.editReply({ content: '🎯 Giveaway créé avec succès !' });
        } catch (error) {
          console.error('Erreur création giveaway:', error);
          await interaction.editReply({ content: '❌ Erreur lors de la création du giveaway.' });
        }
        break;
        
      case 'tournament':
        const prix = interaction.options.getString('prix');
        const phase1Winners = interaction.options.getInteger('gagnants_phase1');
        const phase1Duration = interaction.options.getString('duree_phase1');
        const roleRequired = interaction.options.getRole('role_requis');
        const commentaire = interaction.options.getString('commentaire');
        let image = interaction.options.getString('image');
        
        if (image && !isValidImageUrl(image)) {
          image = null;
        }
        
        const tournamentOptions = {
          prix,
          phase1Winners,
          phase1Duration,
          roleRequired,
          commentaire,
          image
        };
        
        try {
          await TournamentSystem.createTournament(interaction, tournamentOptions);
          await interaction.editReply({ content: '🎯 Tournoi créé avec succès ! Les phases se dérouleront automatiquement.' });
        } catch (error) {
          console.error('Erreur création tournoi:', error);
          await interaction.editReply({ content: '❌ Erreur lors de la création du tournoi.' });
        }
        break;
    }
  }
};

// Fonction pour gérer les giveaways classiques
async function handleClassicGiveaway(interaction) {
  const prix = interaction.options.getString('prix');
  const gagnants = interaction.options.getInteger('gagnants');
  const duréeInput = interaction.options.getString('durée');
  const roleRequired = interaction.options.getRole('role_requis');
  const roleMention = interaction.options.getRole('role_mention');
  const commentaire = interaction.options.getString('commentaire');
  let image = interaction.options.getString('image');
  const organizer = interaction.user.id;
  
  if (image && !isValidImageUrl(image)) {
    image = null;
  }
  
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
  const endTime = Date.now() + duréeMs;
  const giveawayId = `GIV-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
  
  const embed = new EmbedBuilder()
    .setTitle('🎉 Nouveau Giveaway en Cours 🎉')
    .setDescription(`
      **🎁 Prix** : ${prix}
      **🏆 Gagnants** : ${gagnants}
      **⏳ Fin** : <t:${getUnixTimestamp(endTime)}:R>
      **👥 Participants** : 0
      ${roleRequired ? `**🔒 Rôle requis** : ${roleRequired}` : ''}
    `)
    .setColor(0xA8E4A0)
    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
    .setFooter({ text: `ID: ${giveawayId}`, iconURL: interaction.guild.iconURL({ dynamic: true }) })
    .setTimestamp()
    .setImage(image || 'https://i.imgur.com/w5JVwaR.png');

  if (commentaire) {
    embed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${commentaire}` });
  }
  
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('enter').setLabel('Participer').setStyle(ButtonStyle.Secondary).setEmoji('🎉'),
      new ButtonBuilder().setCustomId('leave').setLabel('Se retirer').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
      new ButtonBuilder().setCustomId('cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
      new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥')
    );
    
  const content = roleMention ? `<@&${roleMention.id}> Un nouveau giveaway vient de commencer !` : undefined;
  const message = await interaction.channel.send({
    content,
    embeds: [embed],
    components: [row]
  });
  
  const participants = [];
  const giveaway = {
    messageId: message.id,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    prix,
    gagnants,
    endTime: endTime,
    participants: participants,
    roleRequired: roleRequired ? roleRequired.id : null,
    commentaire: commentaire || null,
    image: image || null,
    organizer,
    tournament_phase: 'single',
    giveawayId: giveawayId
  };
  
  saveGiveaway(giveaway);
  TournamentSystem.startClassicCountdown(message, giveaway, duréeMs);
}

// Enregistrement de la commande
client.commands.set('giveaway', giveawayCommand);

// Événement clientReady
client.once("clientReady", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}!`);
 
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [giveawayCommand.data.toJSON()];
   
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
   
    console.log('✅ Slash commands enregistrés.');
  } catch (error) {
    console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
  }

  updateActivity();
  
  // Charger les giveaways depuis la base de données
  loadGiveaways();
  
  // Attendre que le client soit complètement prêt avant de redémarrer les compteurs
  setTimeout(async () => {
    await restartAllGiveaways();
    
    // Planifier une vérification périodique des giveaways (sécurité supplémentaire)
    setInterval(async () => {
      const now = Date.now();
      const allGiveaways = giveawaysCache.keys().map(key => giveawaysCache.get(key));
      
      for (const giveaway of allGiveaways) {
        if (giveaway.endTime <= now && activeIntervals.has(giveaway.messageId)) {
          console.log(`⚠️ Giveaway ${giveaway.giveawayId} expiré mais toujours actif, traitement forcé...`);
          await processExpiredGiveaway(giveaway);
        }
      }
    }, 60000); // Vérifier toutes les minutes
  }, 5000); // Attendre 5 secondes pour que tous les canaux soient chargés
});

// Connecter le bot à Discord
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('✅ Connecté à Discord avec succès.'))
  .catch(error => console.error('⚠️ Erreur lors de la connexion à Discord:', error));
