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

// Initialisation des caches avec NodeCache
const cache = new NodeCache({ 
  stdTTL: 3600,
  checkperiod: 600
});

const giveawaysCache = new NodeCache({ 
  stdTTL: 10 * 24 * 60 * 60,
  checkperiod: 3600
});

const rateLimiterCache = new NodeCache({
  stdTTL: 10,
  checkperiod: 60
});

// Fonction pour valider une URL d'image
const isValidImageUrl = (url) => {
  try {
    new URL(url);
    return /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(url);
  } catch {
    return false;
  }
};

// Initialisation de la base de données SQLite
const db = new Database(path.join(__dirname, 'giveaways.db'));

// FONCTION DE MIGRATION DE LA BASE DE DONNÉES
const migrateDatabase = () => {
  try {
    // Vérifier si la table giveaways existe
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='giveaways'").get();
    
    if (!tableExists) {
      // Créer la table si elle n'existe pas
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
          tickets_per_user INTEGER DEFAULT 1,
          tournament_phase TEXT DEFAULT 'single',
          referral_codes TEXT DEFAULT '[]',
          parent_tournament_id TEXT,
          phase_number INTEGER DEFAULT 1,
          total_phases INTEGER DEFAULT 1,
          qualified_users TEXT DEFAULT '[]'
        )
      `);
      console.log('✅ Table giveaways créée avec toutes les colonnes');
      return;
    }

    // Vérifier les colonnes existantes
    const columns = db.prepare("PRAGMA table_info(giveaways)").all();
    const columnNames = columns.map(col => col.name);

    // Liste des colonnes requises
    const requiredColumns = [
      'parent_tournament_id', 'phase_number', 'total_phases', 'qualified_users',
      'tickets_per_user', 'tournament_phase', 'referral_codes'
    ];

    // Ajouter les colonnes manquantes
    for (const column of requiredColumns) {
      if (!columnNames.includes(column)) {
        let columnType = 'TEXT';
        if (column === 'phase_number' || column === 'total_phases' || column === 'tickets_per_user') {
          columnType = 'INTEGER';
        }
        
        try {
          db.exec(`ALTER TABLE giveaways ADD COLUMN ${column} ${columnType} DEFAULT ${columnType === 'INTEGER' ? '1' : "'[]'"}`);
          console.log(`✅ Colonne ${column} ajoutée`);
        } catch (error) {
          console.log(`⚠️ Colonne ${column} déjà présente ou erreur:`, error.message);
        }
      }
    }

  } catch (error) {
    console.error('❌ Erreur lors de la migration:', error);
  }
};

// Exécuter la migration au démarrage
migrateDatabase();

// Créer les autres tables si elles n'existent pas
db.exec(`
  CREATE TABLE IF NOT EXISTS user_stats (
    userId TEXT,
    guildId TEXT,
    giveaways_participated INTEGER DEFAULT 0,
    giveaways_won INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    streak_count INTEGER DEFAULT 0,
    last_participation_date INTEGER,
    referral_count INTEGER DEFAULT 0,
    referral_codes_used TEXT DEFAULT '[]',
    PRIMARY KEY (userId, guildId)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    code TEXT PRIMARY KEY,
    referrerId TEXT,
    guildId TEXT,
    uses INTEGER DEFAULT 0,
    max_uses INTEGER DEFAULT 5,
    created_at INTEGER,
    rewards_claimed BOOLEAN DEFAULT FALSE
  )
`);

// Classe pour le système de niveaux et récompenses
class RewardSystem {
  static calculateLevel(participationCount) {
    return Math.floor(Math.sqrt(participationCount) / 2) + 1;
  }
  
  static getRewardMultiplier(level) {
    return 1 + (level * 0.05);
  }
  
  static async updateUserStats(userId, guildId, action) {
    const cacheKey = `stats_${userId}_${guildId}`;
    let stats = cache.get(cacheKey);
    
    if (!stats) {
      const stmt = db.prepare('SELECT * FROM user_stats WHERE userId = ? AND guildId = ?');
      stats = stmt.get(userId, guildId) || {
        userId,
        guildId,
        giveaways_participated: 0,
        giveaways_won: 0,
        points: 0,
        level: 1,
        streak_count: 0,
        last_participation_date: null,
        referral_count: 0,
        referral_codes_used: '[]'
      };
    }
    
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    
    switch (action.type) {
      case 'PARTICIPATE':
        if (stats.last_participation_date && (now - stats.last_participation_date) < oneDay * 2) {
          stats.streak_count++;
        } else {
          stats.streak_count = 1;
        }
        
        stats.giveaways_participated++;
        stats.last_participation_date = now;
        stats.points += 10 + Math.floor(stats.streak_count / 3);
        break;
        
      case 'WIN':
        stats.giveaways_won++;
        stats.points += 100;
        break;
        
      case 'REFERRAL':
        stats.referral_count++;
        stats.points += 50;
        break;
    }
    
    stats.level = this.calculateLevel(stats.giveaways_participated);
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO user_stats 
      (userId, guildId, giveaways_participated, giveaways_won, points, level, streak_count, last_participation_date, referral_count, referral_codes_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      stats.userId,
      stats.guildId,
      stats.giveaways_participated,
      stats.giveaways_won,
      stats.points,
      stats.level,
      stats.streak_count,
      stats.last_participation_date,
      stats.referral_count,
      stats.referral_codes_used
    );
    
    cache.set(cacheKey, stats, 3600);
    return stats;
  }
  
  static async getUserStats(userId, guildId) {
    const cacheKey = `stats_${userId}_${guildId}`;
    let stats = cache.get(cacheKey);
    
    if (!stats) {
      const stmt = db.prepare('SELECT * FROM user_stats WHERE userId = ? AND guildId = ?');
      stats = stmt.get(userId, guildId);
      
      if (stats) {
        cache.set(cacheKey, stats, 3600);
      }
    }
    
    return stats;
  }

  static async getLeaderboard(guildId, limit = 10) {
    const stmt = db.prepare('SELECT * FROM user_stats WHERE guildId = ? ORDER BY points DESC LIMIT ?');
    return stmt.all(guildId, limit);
  }
}

// Classe pour le système de tickets
class TicketSystem {
  static async calculateTickets(userId, guildId, baseTickets = 1) {
    const stats = await RewardSystem.getUserStats(userId, guildId);
    if (!stats) return baseTickets;
    
    let tickets = baseTickets;
    tickets += Math.floor(stats.level / 3);
    tickets += Math.floor(stats.streak_count / 7);
    tickets += Math.floor(stats.referral_count / 2);
    
    return Math.min(tickets, 10);
  }
  
  static async distributeTickets(participants, guildId) {
    const ticketsDistribution = {};
    
    for (const userId of participants) {
      ticketsDistribution[userId] = await this.calculateTickets(userId, guildId);
    }
    
    return ticketsDistribution;
  }
}

// Classe pour le système de parrainage
class ReferralSystem {
  static generateReferralCode(userId) {
    return `GIVEAWAY-${userId.slice(-6)}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
  }
  
  static async createReferralCode(userId, guildId, maxUses = 5) {
    const code = this.generateReferralCode(userId);
    const stmt = db.prepare(`
      INSERT INTO referrals (code, referrerId, guildId, max_uses, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(code, userId, guildId, maxUses, Date.now());
    return code;
  }
  
  static async useReferralCode(code, newUserId, guildId) {
    const stmt = db.prepare('SELECT * FROM referrals WHERE code = ? AND guildId = ?');
    const referral = stmt.get(code, guildId);
    
    if (!referral || referral.uses >= referral.max_uses) {
      return false;
    }
    
    const userStats = await RewardSystem.getUserStats(newUserId, guildId);
    const usedCodes = userStats ? JSON.parse(userStats.referral_codes_used) : [];
    
    if (usedCodes.includes(code)) {
      return false;
    }
    
    const updateStmt = db.prepare('UPDATE referrals SET uses = uses + 1 WHERE code = ?');
    updateStmt.run(code);
    
    await RewardSystem.updateUserStats(referral.referrerId, guildId, { type: 'REFERRAL' });
    await RewardSystem.updateUserStats(newUserId, guildId, { type: 'REFERRAL' });
    
    usedCodes.push(code);
    const updateUserStmt = db.prepare('UPDATE user_stats SET referral_codes_used = ? WHERE userId = ? AND guildId = ?');
    updateUserStmt.run(JSON.stringify(usedCodes), newUserId, guildId);
    
    cache.del(`stats_${newUserId}_${guildId}`);
    cache.del(`stats_${referral.referrerId}_${guildId}`);
    
    return true;
  }
  
  static async getUserReferralCodes(userId, guildId) {
    const stmt = db.prepare('SELECT * FROM referrals WHERE referrerId = ? AND guildId = ?');
    return stmt.all(userId, guildId);
  }
}

// Classe pour le système de tournoi
class TournamentSystem {
  static generateTournamentId() {
    return `TOURNAMENT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  static parseDuration(durationStr) {
    const units = {
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000
    };
    
    const value = parseInt(durationStr);
    const unit = durationStr.replace(value.toString(), '');
    return value * units[unit];
  }

  static formatDuration(ms) {
    if (ms < 60 * 1000) return `${Math.floor(ms / 1000)} secondes`;
    if (ms < 60 * 60 * 1000) return `${Math.floor(ms / (60 * 1000))} minutes`;
    if (ms < 24 * 60 * 60 * 1000) return `${Math.floor(ms / (60 * 60 * 1000))} heures`;
    return `${Math.floor(ms / (24 * 60 * 60 * 1000))} jours`;
  }

  static createProgressBar(remaining, total) {
    const percentage = Math.max(0, Math.min(100, Math.floor((remaining / total) * 100)));
    const filledBlocks = Math.floor(percentage / 10);
    const emptyBlocks = 10 - filledBlocks;
    
    const filled = '█'.repeat(filledBlocks);
    const empty = '░'.repeat(emptyBlocks);
    
    return `\`[${filled}${empty}]\` ${percentage}%`;
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
    
    const embed = new EmbedBuilder()
      .setTitle(`🏆 Tournoi - ${phase.name} ${this.getPhaseEmoji(phase.phaseNumber)}`)
      .setDescription(`
        **🎁 Prix Final** : ${options.prix}
        **🏆 Gagnants Phase** : ${phase.winners}
        **⏳ Temps restant** : ${this.formatDuration(durationMs)}
        **🔢 Phase** : ${phase.phaseNumber}/${phase.totalPhases}
        **👥 Participants** : 0
        **🎫 Tickets totaux** : 0
        ${options.roleRequired ? `**🔒 Rôle requis** : ${options.roleRequired}` : ''}
        
        ${this.createProgressBar(durationMs, durationMs)}
        *Les ${phase.winners} meilleurs participants se qualifieront pour la phase suivante !*
      `)
      .setColor(0xA8E4A0)
      .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
      .setFooter({ text: `Cliquez pour participer !`, iconURL: interaction.guild.iconURL({ dynamic: true }) })
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
        new ButtonBuilder().setCustomId('cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
        new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
        new ButtonBuilder().setCustomId('user_stats').setLabel('Mes Stats').setStyle(ButtonStyle.Secondary).setEmoji('📊'),
        new ButtonBuilder().setCustomId('tournament_leaderboard').setLabel('Classement').setStyle(ButtonStyle.Secondary).setEmoji('🏆')
      );
    } else {
      // Pour les phases 2 et 3, retirer le bouton participer et annuler
      row.addComponents(
        new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
        new ButtonBuilder().setCustomId('user_stats').setLabel('Mes Stats').setStyle(ButtonStyle.Secondary).setEmoji('📊'),
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
      endTime: Date.now() + durationMs,
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
      referral_codes: []
    };

    saveGiveaway(giveaway);
    this.startPhaseCountdown(message, giveaway, phase, durationMs);
    
    return giveaway;
  }

  static async startPhaseCountdown(message, giveaway, phase, totalDuration) {
    const countdownInterval = setInterval(async () => {
      try {
        const currentGiveaway = giveawaysCache.get(giveaway.messageId);
        if (!currentGiveaway) {
          clearInterval(countdownInterval);
          return;
        }

        const remainingTime = currentGiveaway.endTime - Date.now();
        
        // Vérifier si le temps est écoulé
        if (remainingTime <= 0) {
          clearInterval(countdownInterval);
          await this.endTournamentPhase(message, giveaway);
          return;
        }

        const ticketsDistribution = await TicketSystem.distributeTickets(currentGiveaway.participants, currentGiveaway.guildId);
        const totalTickets = Object.values(ticketsDistribution).reduce((sum, tickets) => sum + tickets, 0);

        const updatedEmbed = new EmbedBuilder()
          .setTitle(`🏆 Tournoi - ${phase.name} ${this.getPhaseEmoji(phase.phaseNumber)}`)
          .setDescription(`
            **🎁 Prix Final** : ${giveaway.prix}
            **🏆 Gagnants Phase** : ${phase.winners}
            **⏳ Temps restant** : ${this.formatDuration(remainingTime)}
            **🔢 Phase** : ${phase.phaseNumber}/${phase.totalPhases}
            **👥 Participants** : ${currentGiveaway.participants.length}
            **🎫 Tickets totaux** : ${totalTickets}
            ${giveaway.roleRequired ? `**🔒 Rôle requis** : <@&${giveaway.roleRequired}>` : ''}
            
            ${this.createProgressBar(remainingTime, totalDuration)}
            *Les ${phase.winners} meilleurs participants se qualifieront pour la phase suivante !*
          `)
          .setColor(0xA8E4A0)
          .setThumbnail(message.guild.iconURL({ dynamic: true }))
          .setFooter({ text: `Tournoi - Phase ${phase.phaseNumber}`, iconURL: message.guild.iconURL({ dynamic: true }) })
          .setTimestamp()
          .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

        if (giveaway.commentaire) {
          updatedEmbed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${giveaway.commentaire}` });
        }

        await message.edit({ embeds: [updatedEmbed] }).catch(() => {
          clearInterval(countdownInterval);
        });
      } catch (error) {
        console.error('Erreur dans le compte à rebours:', error);
        clearInterval(countdownInterval);
      }
    }, 15000); // Mise à jour toutes les 15 secondes pour plus de précision
  }

  static async startClassicCountdown(message, giveaway, totalDuration) {
    const countdownInterval = setInterval(async () => {
      try {
        const currentGiveaway = giveawaysCache.get(giveaway.messageId);
        if (!currentGiveaway) {
          clearInterval(countdownInterval);
          return;
        }

        const remainingTime = currentGiveaway.endTime - Date.now();
        if (remainingTime <= 0) {
          clearInterval(countdownInterval);
          await endClassicGiveaway(message, giveaway);
          return;
        }

        const ticketsDistribution = await TicketSystem.distributeTickets(currentGiveaway.participants, currentGiveaway.guildId);
        const totalTickets = Object.values(ticketsDistribution).reduce((sum, tickets) => sum + tickets, 0);

        const updatedEmbed = new EmbedBuilder()
          .setTitle('🎉 Giveaway en Cours 🎉')
          .setDescription(`
            **🎁 Prix** : ${giveaway.prix}
            **🏆 Gagnants** : ${giveaway.gagnants}
            **⏳ Temps restant** : ${this.formatDuration(remainingTime)}
            **👥 Participants** : ${currentGiveaway.participants.length}
            **🎫 Tickets totaux** : ${totalTickets}
            ${giveaway.roleRequired ? `**🔒 Rôle requis** : <@&${giveaway.roleRequired}>` : ''}
            
            ${this.createProgressBar(remainingTime, totalDuration)}
          `)
          .setColor(0xA8E4A0)
          .setThumbnail(message.guild.iconURL({ dynamic: true }))
          .setFooter({ text: 'Cliquez pour participer !', iconURL: message.guild.iconURL({ dynamic: true }) })
          .setTimestamp()
          .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

        if (giveaway.commentaire) {
          updatedEmbed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${giveaway.commentaire}` });
        }

        await message.edit({ embeds: [updatedEmbed] }).catch(() => {
          clearInterval(countdownInterval);
        });
      } catch (error) {
        console.error('Erreur dans le compte à rebours classique:', error);
        clearInterval(countdownInterval);
      }
    }, 15000);
  }

static async endTournamentPhase(message, giveaway) {
  const currentGiveaway = giveawaysCache.get(giveaway.messageId);
  if (!currentGiveaway) return;

  const ticketsDistribution = await TicketSystem.distributeTickets(currentGiveaway.participants, currentGiveaway.guildId);
  
  const sortedParticipants = currentGiveaway.participants
    .map(userId => ({ userId, tickets: ticketsDistribution[userId] || 1 }))
    .sort((a, b) => b.tickets - a.tickets);

  const qualifiedUsers = sortedParticipants
    .slice(0, currentGiveaway.gagnants)
    .map(p => p.userId);

  currentGiveaway.qualified_users = qualifiedUsers;
  saveGiveaway(currentGiveaway);

  const qualifiedMembers = qualifiedUsers.map(id => message.guild.members.cache.get(id)).filter(Boolean);

  // Récupérer l'organisateur
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
    .setFooter({ text: `Tournoi - Phase ${currentGiveaway.phase_number} terminée`, iconURL: message.guild.iconURL({ dynamic: true }) })
    .setTimestamp()
    .setImage(currentGiveaway.image || 'https://i.imgur.com/w5JVwaR.png');

  // AJOUT: Inclure la description/commentaire si elle existe
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

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Tournoi - ${nextPhase.name} ${this.getPhaseEmoji(nextPhaseNumber)}`)
      .setDescription(`
        **🎁 Prix Final** : ${previousPhase.prix}
        **🏆 Gagnants Phase** : ${nextPhase.winners}
        **⏳ Temps restant** : ${this.formatDuration(durationMs)}
        **🔢 Phase** : ${nextPhaseNumber}/${nextPhase.totalPhases}
        **👥 Qualifiés** : ${previousPhase.qualified_users.length}
        
        ${this.createProgressBar(durationMs, durationMs)}
        *Bonne chance aux qualifiés de la phase précédente !*
      `)
      .setColor(0xA8E4A0)
      .setThumbnail(originalMessage.guild.iconURL({ dynamic: true }))
      .setFooter({ text: `Tournoi - Phase ${nextPhaseNumber}`, iconURL: originalMessage.guild.iconURL({ dynamic: true }) })
      .setTimestamp()
      .setImage(previousPhase.image || 'https://i.imgur.com/w5JVwaR.png');

    if (previousPhase.commentaire) {
      embed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${previousPhase.commentaire}` });
    }

    // Pour les phases 2 et 3, retirer le bouton participer et annuler
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
        new ButtonBuilder().setCustomId('user_stats').setLabel('Mes Stats').setStyle(ButtonStyle.Secondary).setEmoji('📊'),
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
      endTime: Date.now() + durationMs,
      participants: previousPhase.qualified_users, // Seuls les qualifiés peuvent participer
      roleRequired: previousPhase.roleRequired,
      commentaire: previousPhase.commentaire,
      image: previousPhase.image,
      organizer: previousPhase.organizer,
      tournament_phase: 'tournament',
      parent_tournament_id: previousPhase.parent_tournament_id,
      phase_number: nextPhaseNumber,
      total_phases: nextPhase.totalPhases,
      qualified_users: [],
      referral_codes: []
    };

    saveGiveaway(newGiveaway);
    this.startPhaseCountdown(message, newGiveaway, nextPhase, durationMs);
  }

static async endTournament(message, finalPhase) {
  const winners = finalPhase.qualified_users;
  const winnerMembers = winners.map(id => message.guild.members.cache.get(id)).filter(Boolean);

  // Récupérer l'organisateur
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
    .setFooter({ text: 'Tournoi terminé - Félicitations !', iconURL: message.guild.iconURL({ dynamic: true }) })
    .setTimestamp()
    .setImage(finalPhase.image || 'https://i.imgur.com/w5JVwaR.png');

  // AJOUT: Inclure la description/commentaire si elle existe
  if (finalPhase.commentaire) {
    winnerEmbed.addFields({ 
      name: '📝 **Informations supplémentaires :**', 
      value: `${finalPhase.commentaire}`, 
      inline: false 
    });
  }

  await message.channel.send({ embeds: [winnerEmbed] });

  // Créer un fil privé pour les gagnants DANS LE MÊME SALON
  await createPrivateThreadForWinners(message.channel, winners, finalPhase);

  for (const winnerId of winners) {
    await RewardSystem.updateUserStats(winnerId, finalPhase.guildId, { type: 'WIN' });
  }
  deleteGiveaway(currentGiveaway.messageId);
}

  static async getTournamentLeaderboard(guildId) {
    const stmt = db.prepare('SELECT * FROM giveaways WHERE guildId = ? AND tournament_phase = "tournament" ORDER BY endTime DESC LIMIT 10');
    const giveaways = stmt.all(guildId);

    for (const giveaway of giveaways) {
      giveaway.participants = JSON.parse(giveaway.participants || '[]');
      giveaway.qualified_users = JSON.parse(giveaway.qualified_users || '[]');
    }

    return giveaways;
  }
}

// Fonction pour créer un fil privé pour les gagnants DANS LE BON SALON
async function createPrivateThreadForWinners(channel, winners, giveaway) {
  try {
    if (winners.length === 0) return;

    const winnerMembers = winners.map(id => channel.guild.members.cache.get(id)).filter(Boolean);
    
    if (winnerMembers.length === 0) return;

    // Vérifier les permissions dans le salon actuel
    if (!channel.permissionsFor(channel.guild.members.me).has(PermissionsBitField.Flags.CreatePrivateThreads)) {
      console.log('❌ Pas de permission pour créer un fil privé dans ce salon');
      return;
    }

    // Créer un fil privé DANS LE SALON ACTUEL
    const threadName = `🎉 Gagnants - ${giveaway.prix.substring(0, 50)}`;
    
    const thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440, // 24 heures
      type: ChannelType.PrivateThread,
      reason: 'Fil privé pour les gagnants du giveaway'
    });

    // Ajouter les gagnants au fil
    for (const member of winnerMembers) {
      try {
        await thread.members.add(member.id);
        console.log(`✅ Ajouté ${member.user.tag} au fil privé`);
      } catch (error) {
        console.log(`❌ Impossible d'ajouter ${member.user.tag} au fil:`, error.message);
      }
    }

    // Ajouter l'organisateur
    try {
      const organizer = await channel.guild.members.fetch(giveaway.organizer);
      await thread.members.add(organizer);
      console.log(`✅ Ajouté l'organisateur ${organizer.user.tag} au fil privé`);
    } catch (error) {
      console.log('❌ Impossible d\'ajouter l\'organisateur au fil:', error.message);
    }

    // Envoyer un message de bienvenue dans le fil
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
    
    console.log(`✅ Fil privé créé pour les gagnants: ${thread.name}`);

    // ENVOYER UN NOUVEAU MESSAGE TEXTE SIMPLE
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
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

// Collections
client.commands = new Map();

// Gestion des giveaways
const loadGiveaways = () => {
  const rows = db.prepare('SELECT * FROM giveaways').all();
  const giveaways = {};
  for (const row of rows) {
    row.participants = JSON.parse(row.participants || '[]');
    row.referral_codes = JSON.parse(row.referral_codes || '[]');
    row.qualified_users = JSON.parse(row.qualified_users || '[]');
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
        roleRequired, commentaire, image, organizer, tickets_per_user, 
        tournament_phase, referral_codes, parent_tournament_id, phase_number, total_phases, qualified_users
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      giveaway.tickets_per_user || 1,
      giveaway.tournament_phase || 'single',
      JSON.stringify(giveaway.referral_codes || []),
      giveaway.parent_tournament_id || null,
      giveaway.phase_number || 1,
      giveaway.total_phases || 1,
      JSON.stringify(giveaway.qualified_users || [])
    );
    giveawaysCache.set(giveaway.messageId, giveaway);
  } catch (error) {
    console.error('Erreur sauvegarde giveaway:', error);
  }
};

const deleteGiveaway = (messageId) => {
  db.prepare('DELETE FROM giveaways WHERE messageId = ?').run(messageId);
  giveawaysCache.del(messageId);
};

// Formater le temps
function formatTime(ms) {
  if (isNaN(ms) || ms <= 0) return 'Terminé';
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

// Rate limiter
const limit = (userId, cooldown = 1000) => {
  const now = Date.now();
  const lastRequest = rateLimiterCache.get(userId);
  if (lastRequest && now - lastRequest < cooldown) return false;
  rateLimiterCache.set(userId, now);
  return true;
};

// Fonction pour sélectionner les gagnants
function selectWinners(participants, winnerCount, ticketsDistribution) {
  if (participants.length === 0) return [];
  
  let ticketsPool = [];
  participants.forEach(userId => {
    const tickets = ticketsDistribution[userId] || 1;
    for (let i = 0; i < tickets; i++) {
      ticketsPool.push(userId);
    }
  });
  
  const winners = [];
  let availableTickets = [...ticketsPool];
  
  for (let i = 0; i < Math.min(winnerCount, participants.length); i++) {
    if (availableTickets.length === 0) break;
    
    const randomIndex = Math.floor(Math.random() * availableTickets.length);
    const winner = availableTickets[randomIndex];
    
    // Éviter les doublons
    if (!winners.includes(winner)) {
      winners.push(winner);
    }
    
    // Retirer toutes les entrées de ce gagnant
    availableTickets = availableTickets.filter(ticket => ticket !== winner);
  }
  
  return winners;
}

// Fonction pour terminer un giveaway classique
async function endClassicGiveaway(message, giveaway) {
  const currentGiveaway = giveawaysCache.get(giveaway.messageId);
  if (!currentGiveaway) return;

  const ticketsDistribution = await TicketSystem.distributeTickets(currentGiveaway.participants, currentGiveaway.guildId);
  
  // Sélectionner les gagnants
  const winners = selectWinners(currentGiveaway.participants, currentGiveaway.gagnants, ticketsDistribution);
  
  const winnerMembers = winners.map(id => message.guild.members.cache.get(id)).filter(Boolean);

  // Récupérer l'organisateur
  const organizer = await message.guild.members.fetch(currentGiveaway.organizer).catch(() => null);

  const resultEmbed = new EmbedBuilder()
    .setTitle('🎊 Giveaway Terminé ! 🎊')
    .setDescription(
      winnerMembers.length
        ? `**🏆 Gagnant(s) :**\n${winnerMembers.map(w => `• ${w.user.tag} (<@${w.id}>)`).join('\n')}`
        : '❌ Aucun participant pour ce giveaway.'
    )
    .setColor(0xFF9999)
    .addFields(
      { name: '🎁 Prix', value: currentGiveaway.prix, inline: false },
      { name: '👥 Participants totaux', value: `${currentGiveaway.participants.length}`, inline: false },
      { name: '👤 Organisateur', value: organizer ? `<@${organizer.id}>` : 'Inconnu', inline: false }
    )
    .setThumbnail(message.guild.iconURL({ dynamic: true }))
    .setFooter({ text: 'Giveaway terminé - Félicitations !', iconURL: message.guild.iconURL({ dynamic: true }) })
    .setTimestamp()
    .setImage(currentGiveaway.image || 'https://i.imgur.com/w5JVwaR.png');

  // AJOUT: Inclure la description/commentaire si elle existe
  if (currentGiveaway.commentaire) {
    resultEmbed.addFields({ 
      name: '📝 **Informations supplémentaires :**', 
      value: `${currentGiveaway.commentaire}`, 
      inline: false 
    });
  }

  await message.edit({ embeds: [resultEmbed], components: [] });

  // Créer un fil privé pour les gagnants du giveaway classique DANS LE MÊME SALON
  await createPrivateThreadForWinners(message.channel, winners, currentGiveaway);

  // Mettre à jour les stats des gagnants
  for (const winnerId of winners) {
    await RewardSystem.updateUserStats(winnerId, currentGiveaway.guildId, { type: 'WIN' });
  }

  deleteGiveaway(currentGiveaway.messageId);
}

// GESTION PRINCIPALE DES INTERACTIONS DE BOUTONS
client.on('interactionCreate', async (interaction) => {
  if (interaction.isCommand()) {
    // Gestion des commandes slash
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
        await interaction.reply({ content: '⚠️ Il y a eu une erreur lors de l\'exécution de cette commande!', flags: [MessageFlags.Ephemeral] });
      }
    }
  } else if (interaction.isButton()) {
    // Gestion des boutons
    await handleButtonInteraction(interaction);
  }
});

// Fonction pour gérer les interactions de boutons
async function handleButtonInteraction(interaction) {
  const { customId, message, user, guild } = interaction;
  
  // Récupérer le giveaway depuis le cache
  const giveaway = giveawaysCache.get(message.id);
  if (!giveaway) {
    return await interaction.reply({ 
      content: '❌ Ce giveaway n\'existe plus ou a expiré.', 
      flags: [MessageFlags.Ephemeral] 
    });
  }

  // Empêcher la participation aux phases 2 et 3 des tournois
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
      
    case 'cancel':
      await handleCancelGiveaway(interaction, giveaway);
      break;
      
    case 'show_participants':
      await handleShowParticipants(interaction, giveaway);
      break;
      
    case 'user_stats':
      await handleUserStats(interaction);
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

  // Vérifier le rôle requis
  if (giveaway.roleRequired && !interaction.member.roles.cache.has(giveaway.roleRequired)) {
    const role = guild.roles.cache.get(giveaway.roleRequired);
    return await interaction.reply({ 
      content: `❌ Vous devez avoir le rôle ${role} pour participer.`, 
      flags: [MessageFlags.Ephemeral] 
    });
  }

  // Vérifier si l'utilisateur participe déjà
  if (giveaway.participants.includes(user.id)) {
    return await interaction.reply({ 
      content: '❌ Vous participez déjà au giveaway.', 
      flags: [MessageFlags.Ephemeral] 
    });
  }

  // Ajouter le participant
  giveaway.participants.push(user.id);
  saveGiveaway(giveaway);

  // Mettre à jour les statistiques
  await RewardSystem.updateUserStats(user.id, guild.id, { type: 'PARTICIPATE' });

  await interaction.reply({ 
    content: '✅ Vous avez rejoint le giveaway ! Bonne chance !', 
    flags: [MessageFlags.Ephemeral] 
  });

  // Mettre à jour l'embed
  await updateGiveawayEmbed(interaction.message, giveaway);
}

async function handleCancelGiveaway(interaction, giveaway) {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    return await interaction.reply({ 
      content: '❌ Pas les permissions nécessaires.', 
      flags: [MessageFlags.Ephemeral] 
    });
  }

  // Récupérer l'organisateur
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
      
      *Nous tenons à remercier chaleureusement tous les participants pour leur intérêt et leur participation active. Votre engagement est précieux !*
      
      💫 **Ne vous inquiétez pas !** D'autres giveaways tout aussi excitants arrivent bientôt. Restez à l'affût pour ne pas les manquer !
      
      *Merci à tous pour votre compréhension et votre soutien continu.*
    `)
    .setColor(0xE74C3C)
    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
    .setFooter({ text: 'Giveaway annulé - Merci à tous les participants !', iconURL: interaction.guild.iconURL({ dynamic: true }) })
    .setTimestamp()
    .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

  // AJOUT: Inclure la description/commentaire si elle existe
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
    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
    .setFooter({ text: 'Participants actuels', iconURL: interaction.guild.iconURL({ dynamic: true }) })
    .setTimestamp();

  await interaction.reply({ 
    embeds: [participantsEmbed], 
    flags: [MessageFlags.Ephemeral] 
  });
}

async function handleUserStats(interaction) {
  const stats = await RewardSystem.getUserStats(interaction.user.id, interaction.guild.id);
  if (!stats) {
    return await interaction.reply({ 
      content: '❌ Aucune statistique trouvée. Participez à un giveaway pour commencer !', 
      flags: [MessageFlags.Ephemeral] 
    });
  }
  
  const tickets = await TicketSystem.calculateTickets(interaction.user.id, interaction.guild.id);
  const statsEmbed = new EmbedBuilder()
    .setTitle('📊 Vos Statistiques')
    .setColor(0x3498DB)
    .addFields(
      { name: '🎯 Niveau', value: `${stats.level}`, inline: true },
      { name: '🏆 Giveaways gagnés', value: `${stats.giveaways_won}`, inline: true },
      { name: '📈 Participation', value: `${stats.giveaways_participated}`, inline: true },
      { name: '🔥 Streak actuelle', value: `${stats.streak_count} jours`, inline: true },
      { name: '⭐ Points', value: `${stats.points}`, inline: true },
      { name: '🎫 Tickets par giveaway', value: `${tickets}`, inline: true },
      { name: '👥 Parrainages', value: `${stats.referral_count}`, inline: true }
    )
    .setThumbnail(interaction.user.displayAvatarURL())
    .setFooter({ text: 'Système de récompenses', iconURL: interaction.guild.iconURL({ dynamic: true }) })
    .setTimestamp();
  
  await interaction.reply({ 
    embeds: [statsEmbed], 
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

  const ticketsDistribution = await TicketSystem.distributeTickets(giveaway.participants, giveaway.guildId);
  
  const sortedParticipants = giveaway.participants
    .map(userId => ({ userId, tickets: ticketsDistribution[userId] || 1 }))
    .sort((a, b) => b.tickets - a.tickets)
    .slice(0, 10);

  const leaderboardList = sortedParticipants.map((p, index) => {
    const medals = ['🥇', '🥈', '🥉'];
    const medal = medals[index] || `${index + 1}️⃣`;
    return `${medal} <@${p.userId}> - ${p.tickets} ticket(s)`;
  }).join('\n') || '👥 Aucun participant';

  const leaderboardEmbed = new EmbedBuilder()
    .setTitle(`🏆 Classement - Phase ${giveaway.phase_number}`)
    .setDescription(leaderboardList)
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
  const ticketsDistribution = await TicketSystem.distributeTickets(giveaway.participants, giveaway.guildId);
  const totalTickets = Object.values(ticketsDistribution).reduce((sum, tickets) => sum + tickets, 0);
  const remainingTime = giveaway.endTime - Date.now();

  let description = `
    **🎁 Prix** : ${giveaway.prix}
    **🏆 Gagnants** : ${giveaway.gagnants}
    **⏳ Temps restant** : ${formatTime(remainingTime)}
    **👥 Participants** : ${giveaway.participants.length}
    **🎫 Tickets totaux** : ${totalTickets}
    ${giveaway.roleRequired ? `**🔒 Rôle requis** : <@&${giveaway.roleRequired}>` : ''}
  `;

  if (giveaway.tournament_phase === 'tournament') {
    description += `\n**🔢 Phase** : ${giveaway.phase_number}/${giveaway.total_phases}\n`;
    if (giveaway.phase_number === 1) {
      description += `*Les ${giveaway.gagnants} meilleurs participants se qualifieront pour la phase suivante !*`;
    } else {
      description += `*Phase réservée aux qualifiés de la phase précédente.*`;
    }
  }

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
      text: giveaway.tournament_phase === 'tournament' 
        ? `Tournoi - Phase ${giveaway.phase_number}`
        : 'Cliquez pour participer !',
      iconURL: message.guild.iconURL({ dynamic: true }) 
    })
    .setTimestamp()
    .setImage(giveaway.image || 'https://i.imgur.com/w5JVwaR.png');

  if (giveaway.commentaire) {
    embed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${giveaway.commentaire}` });
  }

  await message.edit({ embeds: [embed] });
}

// Fonction pour démarrer le collector de giveaway
function startGiveawayCollector(message, giveaway, duréeMs) {
  if (giveaway.tournament_phase === 'tournament') {
    // Pour les tournois, le compte à rebours est déjà géré par TournamentSystem.startPhaseCountdown
    return;
  }
  
  // Pour les giveaways classiques
  TournamentSystem.startClassicCountdown(message, giveaway, duréeMs);
}

// Commande giveaway principale
const giveawayCommand = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Système de giveaways avancé')
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
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('leaderboard')
        .setDescription('Classement des participants')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Type de classement')
            .setRequired(false)
            .addChoices(
              { name: 'Classique', value: 'classic' },
              { name: 'Tournoi', value: 'tournament' }
            )
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

      case 'leaderboard':
        const type = interaction.options.getString('type') || 'classic';
        
        if (type === 'tournament') {
          const tournaments = await TournamentSystem.getTournamentLeaderboard(interaction.guild.id);
          
          if (tournaments.length === 0) {
            return interaction.editReply({ content: '❌ Aucun tournoi trouvé sur ce serveur.' });
          }

          const leaderboardEmbed = new EmbedBuilder()
            .setTitle('🏆 Classement des Tournois')
            .setColor(0x3498DB)
            .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
            .setFooter({ text: 'Classement des tournois', iconURL: interaction.guild.iconURL({ dynamic: true }) })
            .setTimestamp();

          tournaments.forEach((tournament, index) => {
            leaderboardEmbed.addFields({
              name: `🎯 Tournoi ${index + 1} - Phase ${tournament.phase_number}`,
              value: `Prix: ${tournament.prix}\nParticipants: ${tournament.participants.length}\nQualifiés: ${tournament.qualified_users.length}\nStatut: ${tournament.endTime > Date.now() ? '🟢 En cours' : '🔴 Terminé'}`,
              inline: true
            });
          });

          await interaction.editReply({ embeds: [leaderboardEmbed] });
        } else {
          const topUsers = await RewardSystem.getLeaderboard(interaction.guild.id, 10);

          if (topUsers.length === 0) {
            return interaction.editReply({ content: '❌ Aucune statistique trouvée sur ce serveur.' });
          }

          const leaderboardEmbed = new EmbedBuilder()
            .setTitle('🏆 Classement des Participants')
            .setColor(0x3498DB)
            .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
            .setFooter({ text: 'Classement général', iconURL: interaction.guild.iconURL({ dynamic: true }) })
            .setTimestamp();

          topUsers.forEach((user, index) => {
            const medals = ['🥇', '🥈', '🥉'];
            const medal = medals[index] || `${index + 1}️⃣`;
            
            leaderboardEmbed.addFields({
              name: `${medal} <@${user.userId}>`,
              value: `Niveau: ${user.level} | Points: ${user.points}\nGagnés: ${user.giveaways_won} | Participations: ${user.giveaways_participated}`,
              inline: false
            });
          });

          await interaction.editReply({ embeds: [leaderboardEmbed] });
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
  const duréeText = {
    '5m': '5 minutes', '10m': '10 minutes', '30m': '30 minutes',
    '1h': '1 heure', '3h': '3 heures', '5h': '5 heures',
    '1d': '1 jour', '3d': '3 jours', '5d': '5 jours', '1w': '1 semaine'
  }[duréeInput];

  const embed = new EmbedBuilder()
    .setTitle('🎉 Nouveau Giveaway en Cours 🎉')
    .setDescription(`
      **🎁 Prix** : ${prix}
      **🏆 Gagnants** : ${gagnants}
      **⏳ Temps restant** : ${duréeText}
      **👥 Participants** : 0
      **🎫 Tickets totaux** : 0
      ${roleRequired ? `**🔒 Rôle requis** : ${roleRequired}` : ''}
    `)
    .setColor(0xA8E4A0)
    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
    .setFooter({ text: 'Cliquez pour participer !', iconURL: interaction.guild.iconURL({ dynamic: true }) })
    .setTimestamp()
    .setImage(image || 'https://i.imgur.com/w5JVwaR.png');

  if (commentaire) {
    embed.addFields({ name: '📝 **Informations supplémentaires :**', value: `${commentaire}` });
  }

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('enter').setLabel('Participer').setStyle(ButtonStyle.Secondary).setEmoji('🎉'),
      new ButtonBuilder().setCustomId('cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
      new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
      new ButtonBuilder().setCustomId('user_stats').setLabel('Mes Stats').setStyle(ButtonStyle.Secondary).setEmoji('📊')
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
    endTime: Date.now() + duréeMs,
    participants: participants,
    roleRequired: roleRequired ? roleRequired.id : null,
    commentaire: commentaire || null,
    image: image || null,
    organizer,
    tournament_phase: 'single',
    referral_codes: []
  };
  saveGiveaway(giveaway);

  startGiveawayCollector(message, giveaway, duréeMs);
}

// Commande pour les statistiques utilisateur
const statsCommand = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Voir vos statistiques de giveaway'),
  async execute(interaction) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    
    const stats = await RewardSystem.getUserStats(interaction.user.id, interaction.guild.id);
    if (!stats) {
      return interaction.editReply({ content: '❌ Aucune statistique trouvée. Participez à un giveaway pour commencer !' });
    }
    
    const tickets = await TicketSystem.calculateTickets(interaction.user.id, interaction.guild.id);
    const statsEmbed = new EmbedBuilder()
      .setTitle('📊 Vos Statistiques')
      .setColor(0x3498DB)
      .addFields(
        { name: '🎯 Niveau', value: `${stats.level}`, inline: true },
        { name: '🏆 Giveaways gagnés', value: `${stats.giveaways_won}`, inline: true },
        { name: '📈 Participation', value: `${stats.giveaways_participated}`, inline: true },
        { name: '🔥 Streak actuelle', value: `${stats.streak_count} jours`, inline: true },
        { name: '⭐ Points', value: `${stats.points}`, inline: true },
        { name: '🎫 Tickets par giveaway', value: `${tickets}`, inline: true },
        { name: '👥 Parrainages', value: `${stats.referral_count}`, inline: true }
      )
      .setThumbnail(interaction.user.displayAvatarURL())
      .setFooter({ text: 'Système de récompenses', iconURL: interaction.guild.iconURL({ dynamic: true }) })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [statsEmbed] });
  }
};

// Commande pour le système de parrainage
const referralCommand = {
  data: new SlashCommandBuilder()
    .setName('parrainage')
    .setDescription('Gérer votre système de parrainage')
    .addSubcommand(subcommand =>
      subcommand
        .setName('creer')
        .setDescription('Créer un code de parrainage')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('utiliser')
        .setDescription('Utiliser un code de parrainage')
        .addStringOption(option =>
          option.setName('code')
            .setDescription('Le code de parrainage à utiliser')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('liste')
        .setDescription('Voir vos codes de parrainage')
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    
    const subcommand = interaction.options.getSubcommand();
    
    switch (subcommand) {
      case 'creer':
        const code = await ReferralSystem.createReferralCode(interaction.user.id, interaction.guild.id);
        const embed = new EmbedBuilder()
          .setTitle('🎫 Code de Parrainage Créé')
          .setDescription(
            `Votre code de parrainage : \`${code}\`\n\n**Comment l'utiliser :**\n• Partagez ce code avec vos amis\n• Ils doivent utiliser la commande \`/parrainage utiliser\`\n• Vous gagnez des récompenses à chaque utilisation !`
          )
          .setColor(0x3498DB)
          .addFields(
            { name: '🔄 Utilisations max', value: '5', inline: true },
            { name: '🎁 Récompense par utilisation', value: '50 points + tickets bonus', inline: true }
          )
          .setThumbnail(interaction.user.displayAvatarURL())
          .setFooter({ text: 'Système de parrainage', iconURL: interaction.guild.iconURL({ dynamic: true }) })
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        break;
        
      case 'utiliser':
        const referralCode = interaction.options.getString('code');
        const success = await ReferralSystem.useReferralCode(referralCode, interaction.user.id, interaction.guild.id);
        
        if (success) {
          await interaction.editReply({ 
            content: '✅ Code de parrainage utilisé avec succès ! Vous avez gagné 50 points et des tickets bonus pour les prochains giveaways.' 
          });
        } else {
          await interaction.editReply({ 
            content: '❌ Code de parrainage invalide ou déjà utilisé. Vérifiez le code et réessayez.' 
          });
        }
        break;
        
      case 'liste':
        const codes = await ReferralSystem.getUserReferralCodes(interaction.user.id, interaction.guild.id);
        
        if (codes.length === 0) {
          return interaction.editReply({ 
            content: '❌ Vous n\'avez aucun code de parrainage. Créez-en un avec `/parrainage creer`.' 
          });
        }
        
        const codesList = codes.map(code => 
          `\`${code.code}\` - ${code.uses}/${code.max_uses} utilisations`
        ).join('\n');
        
        const codesEmbed = new EmbedBuilder()
          .setTitle('📋 Vos Codes de Parrainage')
          .setDescription(codesList)
          .setColor(0x3498DB)
          .setThumbnail(interaction.user.displayAvatarURL())
          .setFooter({ text: 'Système de parrainage', iconURL: interaction.guild.iconURL({ dynamic: true }) })
          .setTimestamp();
        
        await interaction.editReply({ embeds: [codesEmbed] });
        break;
    }
  }
};

// Enregistrement des commandes
client.commands.set('giveaway', giveawayCommand);
client.commands.set('stats', statsCommand);
client.commands.set('parrainage', referralCommand);

// Événement clientReady
client.once('clientReady', async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}!`);
  
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [giveawayCommand.data.toJSON(), statsCommand.data.toJSON(), referralCommand.data.toJSON()];
    
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    
    console.log('✅ Slash commands enregistrés.');
  } catch (error) {
    console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
  }
  
  updateActivity();
  loadGiveaways();
});

// Connecter le bot à Discord
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('✅ Connecté à Discord avec succès.'))
  .catch(error => console.error('⚠️ Erreur lors de la connexion à Discord:', error));
