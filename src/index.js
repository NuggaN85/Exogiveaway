'use strict';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import NodeCache from 'node-cache';
import { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  PermissionsBitField, 
  ChannelType, 
  SlashCommandBuilder, 
  ActivityType, 
  REST, 
  Routes, 
  MessageFlags,
  Events
} from 'discord.js';

// ==================== CONFIGURATION INITIALE ====================

// Définir __dirname pour les modules ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration des variables d'environnement
dotenv.config();

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN manquant dans le fichier .env');
  process.exit(1);
}

// Gestion des erreurs non capturées
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// ==================== IMAGES DES GIVEAWAYS ====================

const GIVEAWAY_IMAGES = {
  active:    'https://i.imgur.com/h5t1NPw.png', // Nouveau giveaway & giveaway en cours
  ended:     'https://i.imgur.com/h5t1NPw.png', // Giveaway terminé
  cancelled: 'https://i.imgur.com/Xd0D0UJ.png', // Giveaway annulé
  winners:   'https://i.imgur.com/cpg5KVR.png', // Fil privé gagnants
};

// ==================== INITIALISATION DES CACHES ====================

const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const giveawaysCache = new NodeCache({ stdTTL: 10 * 24 * 60 * 60, checkperiod: 3600 });
const rateLimiterCache = new NodeCache({ stdTTL: 10, checkperiod: 60 });
const activeIntervals = new Map();

// ==================== FONCTIONS UTILITAIRES ====================

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

// Fonction utilitaire pour obtenir l'avatar du bot
function getBotAvatarURL() {
  return client.user?.displayAvatarURL({ dynamic: true }) ?? null;
}

// ==================== BASE DE DONNÉES ====================

// Initialisation de la base de données SQLite
const db = new Database(path.join(__dirname, 'giveaways.db'), {
  verbose: process.env.NODE_ENV === 'development' ? console.log : null,
  fileMustExist: false,
  timeout: 5000
});

    // Configuration pragma optimisée
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

const initializeDatabase = () => {
  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='giveaways'").get();
    
    if (!tableExists) {
      console.log('⚠️ Table giveaways non trouvée, création...');
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
          giveawayId TEXT UNIQUE,
          startTime INTEGER,
          duration INTEGER
        )
      `);
      console.log('✅ Table giveaways créée');
    } else {
      // Ajouter les colonnes manquantes si nécessaire
      try {
        db.exec('ALTER TABLE giveaways ADD COLUMN startTime INTEGER');
        db.exec('ALTER TABLE giveaways ADD COLUMN duration INTEGER');
      } catch (e) {
        // Colonnes déjà existantes
      }
      console.log('✅ Base de données OK');
    }
  } catch (error) {
    console.error('❌ Erreur vérification base de données:', error);
  }
};

initializeDatabase();

// Fonctions de gestion de la base de données
const saveGiveaway = (giveaway) => {
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO giveaways (
        messageId, channelId, guildId, prix, gagnants, endTime, participants,
        roleRequired, commentaire, image, organizer, giveawayId, startTime, duration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      giveaway.giveawayId,
      giveaway.startTime,
      giveaway.duration
    );
    
    giveawaysCache.set(giveaway.messageId, giveaway);
  } catch (error) {
    console.error('Erreur sauvegarde giveaway:', error);
  }
};

const deleteGiveaway = (messageId) => {
  db.prepare('DELETE FROM giveaways WHERE messageId = ?').run(messageId);
  giveawaysCache.del(messageId);
  
  if (activeIntervals.has(messageId)) {
    clearInterval(activeIntervals.get(messageId));
    activeIntervals.delete(messageId);
  }
};

const loadGiveaways = () => {
  const rows = db.prepare('SELECT * FROM giveaways').all();
  const giveaways = {};
  
  for (const row of rows) {
    row.participants = JSON.parse(row.participants || '[]');
   
    if (!row.giveawayId) {
      row.giveawayId = `GIV-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      const updateStmt = db.prepare('UPDATE giveaways SET giveawayId = ? WHERE messageId = ?');
      updateStmt.run(row.giveawayId, row.messageId);
    }
   
    // Calculer startTime et duration si manquants
    if (!row.startTime && row.endTime && row.duration) {
      row.startTime = row.endTime - row.duration;
    }
   
    giveaways[row.messageId] = row;
    giveawaysCache.set(row.messageId, row);
  }
  
  return giveaways;
};

// ==================== FONCTIONS D'AFFICHAGE ====================

// Fonction pour générer la barre de progression
function generateProgressBar(giveaway) {
  const now = Date.now();
  
  // Vérification et calcul robuste des temps
  let startTime = giveaway.startTime;
  const endTime = giveaway.endTime;
  
  // Si startTime n'est pas défini, essayez de le calculer
  if (!startTime && giveaway.duration && endTime) {
    startTime = endTime - giveaway.duration;
  }
  
  // Si toujours pas de startTime, utilisez un fallback
  if (!startTime || !endTime) {
    return {
      progressBar: '█'.repeat(0) + '░'.repeat(20),
      color: '#FF9999',
      percentage: 0
    };
  }
  
  const totalDuration = endTime - startTime;
  
  // Protection contre les durées nulles ou négatives
  if (totalDuration <= 0) {
    return {
      progressBar: '█'.repeat(20),
      color: '#FF9999',
      percentage: 100
    };
  }
  
  const elapsed = now - startTime;
  const remaining = endTime - now;
  
  // Calcul du pourcentage
  let percentage = Math.max(0, Math.min(100, (elapsed / totalDuration) * 100));
  percentage = Math.round(percentage);
  
  // Calculer le pourcentage de temps RESTANT
  const remainingPercentage = (remaining / totalDuration) * 100;
  
  let color;
  
  if (remainingPercentage > 66) {
    color = '#A8E4A0'; // Vert pastel
  } else if (remainingPercentage > 33) {
    color = '#FFD580'; // Orange pastel
  } else if (remainingPercentage > 10) {
    color = '#FF9966'; // Orange plus foncé
  } else {
    color = '#FF9999'; // Rouge pastel
  }
  
  // Créer la barre de progression
  const barLength = 20;
  const filledLength = Math.round((percentage / 100) * barLength);
  const emptyLength = barLength - filledLength;
  
  const progressBar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
  
  return {
    progressBar,
    color,
    percentage
  };
}

function createGiveawayEmbed(giveaway, guild) {
  const progress = generateProgressBar(giveaway);
  const botAvatar = getBotAvatarURL();

  const embed = new EmbedBuilder()
    .setTitle('🎉 Giveaway en Cours 🎉')
    .setColor(progress.color)
    .setThumbnail(botAvatar)
    .setFooter({ 
      text: `ID: ${giveaway.giveawayId}`,
      iconURL: botAvatar
    })
    .setTimestamp()
    .setImage(GIVEAWAY_IMAGES.active);

  // Construction de la description
  let descriptionContent = '';

  // 1. Prix
  descriptionContent += `**🎁 Prix :**\n${giveaway.prix}\n\n`;

  // 2. Participants actuels
  descriptionContent += `**👥 Participants actuels :**\n${giveaway.participants.length}\n\n`;

  // 3. Nombre de gagnants
  descriptionContent += `**🏆 Gagnants :**\n${giveaway.gagnants}\n\n`;

  // 4. Temps restant
  descriptionContent += `**⏳ Fin :**\n<t:${getUnixTimestamp(giveaway.endTime)}:R> • <t:${getUnixTimestamp(giveaway.endTime)}:d>\n\n`;

  // 5. Rôle requis (si présent)
  if (giveaway.roleRequired) {
    descriptionContent += `**🔒 Rôle requis :**\n<@&${giveaway.roleRequired}>\n\n`;
  }

  // 6. Barre de progression
  descriptionContent += `**⏱️ Progression :**\n${progress.percentage}%\n\`${progress.progressBar}\`\n\n`;

  // 7. Informations supplémentaires (optionnel)
  if (giveaway.commentaire) {
    descriptionContent += `**📝 Informations supplémentaires :**\n${giveaway.commentaire}`;
  }

  embed.setDescription(descriptionContent);

  return embed;
}

function createEndedGiveawayEmbed(giveaway, winnerMembers, organizer) {
  const botAvatar = getBotAvatarURL();

  const embed = new EmbedBuilder()
    .setTitle('🎊 Giveaway Terminé ! 🎊')
    .setColor(0xFF9999)
    .setThumbnail(botAvatar)
    .setFooter({ 
      text: `ID: ${giveaway.giveawayId}`,
      iconURL: botAvatar
    })
    .setTimestamp()
    .setImage(GIVEAWAY_IMAGES.ended);

  // Construction de la description
  let descriptionContent = '';

  // 1. Prix
  descriptionContent += `**🎁 Prix :**\n${giveaway.prix}\n\n`;

  // 2. Participants totaux
  descriptionContent += `**👥 Participants totaux :**\n${giveaway.participants.length}\n\n`;

  // 3. Gagnant(s)
  if (winnerMembers.length) {
    descriptionContent += `**🏆 Gagnant(s) :**\n${winnerMembers.map(w => `<@${w.id}>`).join(', ')}\n\n`;
  } else {
    descriptionContent += `**🏆 Gagnant(s) :**\n🥺 Aucun participant pour ce giveaway.\n\n`;
    descriptionContent += `💫 **Ne vous inquiétez pas !** D'autres giveaways arrivent bientôt.\n\n`;
  }

  // 4. Organisateur
  descriptionContent += `**👤 Organisateur :**\n${organizer ? `<@${organizer.id}>` : 'Inconnu'}`;

  // 5. Informations supplémentaires (optionnel)
  if (giveaway.commentaire) {
    descriptionContent += `\n\n**📝 Informations supplémentaires :**\n${giveaway.commentaire}`;
  }

  embed.setDescription(descriptionContent);

  return embed;
}

// Fonction pour mettre à jour l'embed du giveaway en cours
async function updateGiveawayEmbed(message, giveaway) {
  const embed = createGiveawayEmbed(giveaway, message.guild);
  await message.edit({ embeds: [embed] });
}

// ==================== FONCTIONS DE GESTION DES GIVEAWAYS ====================

// Fonction pour créer un fil privé pour les gagnants
async function createPrivateThreadForWinners(channel, winners, giveaway) {
  try {
    if (winners.length === 0) return;
    const winnerMembers = winners.map(id => channel.guild.members.cache.get(id)).filter(Boolean);
   
    if (winnerMembers.length === 0) return;
    
    if (!channel.permissionsFor(channel.guild.members.me).has(PermissionsBitField.Flags.CreatePrivateThreads)) {
      console.log('❌ Pas de permission pour créer un fil privé');
      const winnerMentions = winnerMembers.map(m => `<@${m.id}>`).join(' ');
      await channel.send({
        content: `🎉 Félicitations ${winnerMentions} ! Vous avez gagné **${giveaway.prix}** ! Contactez <@${giveaway.organizer}> pour réclamer votre prix.`
      });
      return;
    }
    
    const threadName = `🎉 Gagnants - ${giveaway.prix.substring(0, 50)}`;

    const thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080,
      type: ChannelType.PrivateThread,
      reason: 'Fil privé pour les gagnants du giveaway',
      topic: `🎉 Gagnants du giveaway ${giveaway.giveawayId} - Prix: ${giveaway.prix}`
    });
    
    for (const member of winnerMembers) {
      try {
        await thread.members.add(member.id);
        console.log(`✅ Ajouté ${member.user.tag} au fil privé`);
      } catch (error) {
        console.log(`❌ Impossible d'ajouter ${member.user.tag} au fil:`, error.message);
      }
    }
    
    try {
      const organizer = await channel.guild.members.fetch(giveaway.organizer);
      await thread.members.add(organizer);
      console.log(`✅ Ajouté l'organisateur ${organizer.user.tag} au fil privé`);
    } catch (error) {
      console.log('❌ Impossible d\'ajouter l\'organisateur au fil:', error.message);
    }
    
    const botAvatar = getBotAvatarURL();

    // Embed de félicitations pour le fil privé gagnants
    const embed = new EmbedBuilder()
      .setTitle('🎊 Félicitations aux Gagnants ! 🎊')
      .setColor(0xA8E4A0)
      .setThumbnail(botAvatar)
      .setFooter({ 
        text: `ID: ${giveaway.giveawayId}`, 
        iconURL: botAvatar
      })
      .setTimestamp()
      .setImage(GIVEAWAY_IMAGES.winners);

    // Construction de la description
    let descriptionContent = '';

    // 1. Prix gagné
    descriptionContent += `**🎁 Prix Gagné :**\n${giveaway.prix}\n\n`;

    // 2. Gagnants
    descriptionContent += `**🏆 Gagnants :**\n${winnerMembers.map(m => `<@${m.id}>`).join(', ')}\n\n`;

    // 3. Organisateur
    descriptionContent += `**👤 Organisateur :**\n<@${giveaway.organizer}>\n\n`;

    // 4. Information sur le fil
    descriptionContent += `**💬 Information :**\nCe fil privé a été créé pour discuter de la remise de votre prix.\n\n`;

    // 5. Informations supplémentaires (optionnel)
    if (giveaway.commentaire) {
      descriptionContent += `**📝 Informations supplémentaires :**\n${giveaway.commentaire}\n\n`;
    }

    // 6. Instructions pour la discussion
    descriptionContent += `**💬 Discussion :**\nUtilisez ce fil pour coordonner la réception de votre prix avec l'organisateur.`;

    embed.setDescription(descriptionContent);
    
    await thread.send({
      content: `🎉 Félicitations ${winnerMembers.map(m => `<@${m.id}>`).join(' ')} !`,
      embeds: [embed]
    });
    
    console.log(`✅ Fil privé créé pour les gagnants du giveaway ${giveaway.giveawayId}`);
    return thread;
  } catch (error) {
    console.error('❌ Erreur lors de la création du fil privé:', error);
    const winnerMembers = winners.map(id => channel.guild.members.cache.get(id)).filter(Boolean);
    if (winnerMembers.length > 0) {
      const winnerMentions = winnerMembers.map(m => `<@${m.id}>`).join(' ');
      await channel.send({
        content: `🎉 Félicitations ${winnerMentions} ! Vous avez gagné **${giveaway.prix}** ! Contactez <@${giveaway.organizer}> pour réclamer votre prix.`
      });
    }
    return null;
  }
}

// Fonction pour démarrer le compte à rebours classique
async function startClassicCountdown(message, giveaway) {
  // Arrêter tout intervalle existant pour ce giveaway
  if (activeIntervals.has(giveaway.messageId)) {
    clearInterval(activeIntervals.get(giveaway.messageId));
    activeIntervals.delete(giveaway.messageId);
  }
  
  // Fonction de mise à jour de l'embed
  const updateEmbed = async () => {
    try {
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
      
      // Mettre à jour l'embed
      const updatedEmbed = createGiveawayEmbed(currentGiveaway, message.guild);
      await message.edit({ embeds: [updatedEmbed] }).catch(() => {
        if (activeIntervals.has(giveaway.messageId)) {
          clearInterval(activeIntervals.get(giveaway.messageId));
          activeIntervals.delete(giveaway.messageId);
        }
      });
    } catch (error) {
      console.error('Erreur dans le compte à rebours classique:', error);
      if (activeIntervals.has(giveaway.messageId)) {
        clearInterval(activeIntervals.get(giveaway.messageId));
        activeIntervals.delete(giveaway.messageId);
      }
    }
  };
  
  // Exécuter la première mise à jour immédiatement
  await updateEmbed();
  
  // Démarrer l'intervalle (toutes les 30 secondes)
  const interval = setInterval(updateEmbed, 30000);
  activeIntervals.set(giveaway.messageId, interval);
}

// Fonction pour terminer un giveaway classique
async function endClassicGiveaway(message, giveaway) {
  const currentGiveaway = giveawaysCache.get(giveaway.messageId);
  if (!currentGiveaway) return;
  
  if (activeIntervals.has(currentGiveaway.messageId)) {
    clearInterval(activeIntervals.get(currentGiveaway.messageId));
    activeIntervals.delete(currentGiveaway.messageId);
  }
  
  const winners = selectWinners(currentGiveaway.participants, currentGiveaway.gagnants);
  const winnerMembers = winners.map(id => message.guild.members.cache.get(id)).filter(Boolean);
  const organizer = await message.guild.members.fetch(currentGiveaway.organizer).catch(() => null);
  
  // Créer l'embed terminé
  const resultEmbed = createEndedGiveawayEmbed(currentGiveaway, winnerMembers, organizer);
  
  await message.edit({ embeds: [resultEmbed], components: [] });
  
  if (winnerMembers.length > 0) {
    const thread = await createPrivateThreadForWinners(message.channel, winners, currentGiveaway);
    
    if (thread) {
      await message.channel.send({
        content: `🎉 **GIVEAWAY TERMINÉ !** Félicitations au(x) gagnant(s) ! Vous avez gagné **${currentGiveaway.prix}** ! 🎁 Récupérez votre gain dans le fil privé : ${thread}`
      });
    } else {
      await message.channel.send({
        content: `🎉 **GIVEAWAY TERMINÉ !** Félicitations au(x) gagnant(s) ! Vous avez gagné **${currentGiveaway.prix}** ! 🎁 Contactez l'organisateur <@${currentGiveaway.organizer}> pour réclamer votre prix.`
      });
    }
  } else {
    await message.channel.send({
      content: `🎉 **GIVEAWAY TERMINÉ !** Aucun participant pour le giveaway **${currentGiveaway.prix}**. Un nouveau giveaway sera bientôt disponible !`
    });
  }
  
  deleteGiveaway(currentGiveaway.messageId);
}

// Fonction pour traiter les giveaways expirés
async function processExpiredGiveaway(giveaway) {
  try {
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
    
    if (message.components.length === 0) {
      console.log(`ℹ️ Giveaway ${giveaway.giveawayId} déjà traité, suppression...`);
      deleteGiveaway(giveaway.messageId);
      return;
    }
    
    console.log(`🎯 Traitement du giveaway expiré ${giveaway.giveawayId}...`);
    
    await endClassicGiveaway(message, giveaway);
    
    console.log(`✅ Giveaway expiré ${giveaway.giveawayId} traité avec succès`);
  } catch (error) {
    console.error(`❌ Erreur lors du traitement du giveaway expiré ${giveaway.giveawayId}:`, error);
    deleteGiveaway(giveaway.messageId);
  }
}

// Fonction pour vérifier périodiquement les giveaways expirés
async function checkExpiredGiveaways() {
  console.log('🔍 Vérification des giveaways expirés...');
  
  const allGiveaways = giveawaysCache.keys().map(key => giveawaysCache.get(key));
  const now = Date.now();
  let expiredCount = 0;
  
  for (const giveaway of allGiveaways) {
    try {
      if (giveaway.endTime <= now) {
        console.log(`⚠️ Giveaway ${giveaway.giveawayId} expiré non traité, traitement forcé...`);
        await processExpiredGiveaway(giveaway);
        expiredCount++;
      }
    } catch (error) {
      console.error(`❌ Erreur lors de la vérification du giveaway ${giveaway.giveawayId}:`, error);
    }
  }
  
  if (expiredCount > 0) {
    console.log(`✅ ${expiredCount} giveaways expirés traités lors de la vérification`);
  }
}

// Fonction pour relancer un compteur de giveaway spécifique
async function restartGiveawayCountdown(giveaway) {
  try {
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
    
    giveawaysCache.set(giveaway.messageId, giveaway);
    await startClassicCountdown(message, giveaway);
    
    console.log(`✅ Compteur relancé pour le giveaway ${giveaway.giveawayId}`);
  } catch (error) {
    console.error(`❌ Erreur lors du redémarrage du giveaway ${giveaway.giveawayId}:`, error);
  }
}

// Fonction pour relancer les compteurs des giveaways existants
async function restartAllGiveaways() {
  console.log('🔄 Redémarrage des compteurs de giveaways...');
  
  const rows = db.prepare('SELECT * FROM giveaways').all();
  let restartedCount = 0;
  let expiredCount = 0;
  let errorCount = 0;
  
  for (const row of rows) {
    try {
      row.participants = JSON.parse(row.participants || '[]');
      
      if (!row.startTime && row.endTime && row.duration) {
        row.startTime = row.endTime - row.duration;
        const updateStmt = db.prepare('UPDATE giveaways SET startTime = ? WHERE messageId = ?');
        updateStmt.run(row.startTime, row.messageId);
      }
      
      const remainingTime = row.endTime - Date.now();
      
      if (remainingTime <= 0) {
        console.log(`⚠️ Giveaway ${row.giveawayId} expiré, traitement...`);
        await processExpiredGiveaway(row);
        expiredCount++;
      } else {
        await restartGiveawayCountdown(row);
        restartedCount++;
      }
    } catch (error) {
      console.error(`❌ Erreur lors du redémarrage du giveaway ${row.giveawayId}:`, error);
      errorCount++;
    }
  }
  
  console.log(`✅ Résultat : ${restartedCount} compteurs redémarrés, ${expiredCount} expirés traités, ${errorCount} erreurs`);
}

// ==================== GESTION DES INTERACTIONS ====================

// Fonctions de gestion des boutons
async function handleEnterGiveaway(interaction, giveaway) {
  const { user, guild } = interaction;
  
  if (giveaway.roleRequired && !interaction.member.roles.cache.has(giveaway.roleRequired)) {
    const role = guild.roles.cache.get(giveaway.roleRequired);
    return await interaction.reply({
      content: `<:Erreur:1407372995176960132> Vous devez avoir le rôle ${role} pour participer.`,
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  if (giveaway.participants.includes(user.id)) {
    return await interaction.reply({
      content: '<:Erreur:1407372995176960132> Vous participez déjà au giveaway.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  giveaway.participants.push(user.id);
  saveGiveaway(giveaway);
  
  await interaction.reply({
    content: '<:Valider:1407373060784521287> Vous avez rejoint le giveaway ! Bonne chance !',
    flags: [MessageFlags.Ephemeral]
  });
  
  await updateGiveawayEmbed(interaction.message, giveaway);
}

async function handleLeaveGiveaway(interaction, giveaway) {
  const { user, guild } = interaction;
  
  if (!giveaway.participants.includes(user.id)) {
    return await interaction.reply({
      content: '<:Erreur:1407372995176960132> Vous ne participez pas à ce giveaway.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  if (giveaway.endTime <= Date.now()) {
    return await interaction.reply({
      content: '<:Erreur:1407372995176960132> Ce giveaway est terminé, vous ne pouvez plus vous retirer.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  const participantIndex = giveaway.participants.indexOf(user.id);
  if (participantIndex > -1) {
    giveaway.participants.splice(participantIndex, 1);
    saveGiveaway(giveaway);
  }
  
  await interaction.reply({
    content: '<:Valider:1407373060784521287> Vous avez été retiré du giveaway.',
    flags: [MessageFlags.Ephemeral]
  });
  
  await updateGiveawayEmbed(interaction.message, giveaway);
}

async function handleCancelGiveaway(interaction, giveaway) {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    return await interaction.reply({
      content: '<:Erreur:1407372995176960132> Pas les permissions nécessaires.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  const organizer = await interaction.guild.members.fetch(giveaway.organizer).catch(() => null);
  const botAvatar = getBotAvatarURL();

  // Embed d'annulation
  const embed = new EmbedBuilder()
    .setTitle('❌ Giveaway Annulé ❌')
    .setColor(0xE74C3C)
    .setThumbnail(botAvatar)
    .setFooter({ 
      text: `ID: ${giveaway.giveawayId}`, 
      iconURL: botAvatar
    })
    .setTimestamp()
    .setImage(GIVEAWAY_IMAGES.cancelled);

  // Construction de la description
  let descriptionContent = '';

  // 1. Prix
  descriptionContent += `**🎁 Prix :**\n${giveaway.prix}\n\n`;

  // 2. Participants
  descriptionContent += `**👥 Participants :**\n${giveaway.participants.length}\n\n`;

  // 3. Gagnants prévus
  descriptionContent += `**🏆 Gagnants prévus :**\n${giveaway.gagnants}\n\n`;

  // 4. Organisateur
  descriptionContent += `**👤 Organisateur :**\n${organizer ? `<@${organizer.id}>` : 'Inconnu'}\n\n`;

  // 5. Statut d'annulation
  descriptionContent += `**📢 Statut :**\n❌ **ANNULÉ** ❌\n\n`;

  // 6. Message d'information
  descriptionContent += `💫 **Ne vous inquiétez pas !** D'autres giveaways arrivent bientôt.\n\n`;

  // 7. Informations supplémentaires (optionnel)
  if (giveaway.commentaire) {
    descriptionContent += `**📝 Informations supplémentaires :**\n${giveaway.commentaire}`;
  }

  embed.setDescription(descriptionContent);

  await interaction.message.edit({ embeds: [embed], components: [] });
  deleteGiveaway(giveaway.messageId);
 
  await interaction.reply({
    content: '<:Attention:1407372958501965914> Giveaway annulé avec succès.',
    flags: [MessageFlags.Ephemeral]
  });
}

async function handleShowParticipants(interaction, giveaway) {
  if (!giveaway.participants.includes(interaction.user.id)) {
    return await interaction.reply({
      content: '<:Erreur:1407372995176960132> Vous devez participer au giveaway pour voir la liste des participants.',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  const participantsList = giveaway.participants.map(id => `<@${id}>`).join(', ') || '👥 Aucun participant.';
  const participantsEmbed = new EmbedBuilder()
    .setTitle('📋 Liste des Participants')
    .setDescription(participantsList)
    .setColor(0x3498DB)
    .setFooter({ text: 'Participants actuels'})
    .setTimestamp();
  
  await interaction.reply({
    embeds: [participantsEmbed],
    flags: [MessageFlags.Ephemeral]
  });
}

// Fonction pour gérer les interactions de boutons
async function handleButtonInteraction(interaction) {
  const { customId, message, user, guild } = interaction;
 
  const giveaway = giveawaysCache.get(message.id);
  if (!giveaway) {
    return await interaction.reply({
      content: '<:Erreur:1407372995176960132> Ce giveaway n\'existe plus ou a expiré.',
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
    default:
      await interaction.reply({
        content: '<:Erreur:1407372995176960132> Action non reconnue.',
        flags: [MessageFlags.Ephemeral]
      });
  }
}

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
  const startTime = Date.now();
  const endTime = startTime + duréeMs;
  const giveawayId = `GIV-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
  
  const participants = [];
  const giveaway = {
    messageId: '',
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
    giveawayId: giveawayId,
    startTime: startTime,
    duration: duréeMs
  };
  
  // Créer l'embed initial
  const embed = createGiveawayEmbed(giveaway, interaction.guild);
  
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('enter').setLabel('Participer').setStyle(ButtonStyle.Secondary).setEmoji('🎉'),
      new ButtonBuilder().setCustomId('leave').setLabel('Se retirer').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
      new ButtonBuilder().setCustomId('cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
      new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥')
    );
    
  const content = roleMention ? `<@&${roleMention.id}> 🎊 **UN NOUVEAU GIVEAWAY VIENT DE COMMENCER !** 🎊` : undefined;
  const message = await interaction.channel.send({
    content,
    embeds: [embed],
    components: [row]
  });
  
  // Mettre à jour le giveaway avec l'ID du message
  giveaway.messageId = message.id;
  saveGiveaway(giveaway);
  
  // Démarrer le compte à rebours
  startClassicCountdown(message, giveaway);
}

// ==================== COMMANDE SLASH ====================

// Commande giveaway principale
const giveawayCommand = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Système de giveaways')
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Créer un giveaway')
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
    ),
async execute(interaction) {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    return interaction.reply({ 
      content: '<:Erreur:1407372995176960132> Permissions insuffisantes.', 
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  // Déférer la réponse comme éphémère
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  
  const subcommand = interaction.options.getSubcommand();
  
  switch (subcommand) {
    case 'create':
      try {
        await handleClassicGiveaway(interaction);
        await interaction.editReply({ 
          content: '<:Valider:1407373060784521287> **Giveaway créé avec succès !**'
        });
      } catch (error) {
        console.error('Erreur création giveaway:', error);
        await interaction.editReply({ 
          content: '<:Erreur:1407372995176960132> Erreur lors de la création du giveaway.'
        });
      }
      break;
    }
  }
};

// ==================== CLIENT DISCORD ====================

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

// Fonction pour mettre à jour l'activité du bot
function updateActivity() {
  client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });
}

// ✅ GESTION PRINCIPALE DES INTERACTIONS avec Events.InteractionCreate
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    
    if (!limit(interaction.user.id)) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '<:Erreur:1407372995176960132> Veuillez attendre avant de réessayer.', flags: [MessageFlags.Ephemeral] });
      }
      return;
    }
    
    try {
      await command.execute(interaction);
    } catch (error) {
      console.error('Erreur lors de l\'exécution de la commande:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '<:Attention:1407372958501965914> Erreur lors de l\'exécution de cette commande!', flags: [MessageFlags.Ephemeral] });
      }
    }
  } else if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
  }
});

// ✅ Événements du client avec Events.GuildCreate et Events.GuildDelete
client.on(Events.GuildCreate, async (guild) => {
  updateActivity();
});

client.on(Events.GuildDelete, async (guild) => {
  updateActivity();
});

// ✅ Événement ClientReady avec Events.ClientReady
client.once(Events.ClientReady, async () => {
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
  
  // Enregistrer la commande
  client.commands.set('giveaway', giveawayCommand);
  
  // Charger les giveaways depuis la base de données
  loadGiveaways();
  
  // Attendre que le client soit complètement prêt avant de redémarrer les compteurs
  setTimeout(async () => {
    await restartAllGiveaways();
    
    // Planifier une vérification périodique des giveaways (toutes les 5 minutes)
    setInterval(async () => {
      await checkExpiredGiveaways();
    }, 5 * 60 * 1000);
    
    // Vérification initiale
    await checkExpiredGiveaways();
    
    console.log('✅ Système de vérification des giveaways activé');
  }, 10000);
});

// Connecter le bot à Discord
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('✅ Connecté à Discord avec succès.'))
  .catch(error => console.error('⚠️ Erreur lors de la connexion à Discord:', error));
