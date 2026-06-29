'use strict';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomInt, createHash } from 'crypto';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import NodeCache from 'node-cache';
import {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionsBitField, ChannelType, SlashCommandBuilder,
  ActivityType, REST, Routes, MessageFlags, Events,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  SeparatorSpacingSize, ThumbnailBuilder, SectionBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder,
} from 'discord.js';

// ==================== INIT ====================

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config();

if (!process.env.DISCORD_TOKEN) { console.error('❌ DISCORD_TOKEN manquant'); process.exit(1); }

process.on('unhandledRejection', (r, p) => console.error('Unhandled Rejection:', p, r));
process.on('uncaughtException',  (e)    => console.error('Uncaught Exception:', e));

// ==================== CONSTANTES ====================

const MAX_PRIX_LENGTH    = 256;
const MAX_COMMENT_LENGTH = 512;
const PARTICIPANT_CD     = 3000;
const COMMAND_CD         = 1500;
const PARTICIPANTS_PAGE  = 20;

const GIVEAWAY_IMAGES = {
  active:    'https://i.imgur.com/h5t1NPw.png',
  ended:     'https://i.imgur.com/h5t1NPw.png',
  cancelled: 'https://i.imgur.com/Xd0D0UJ.png',
  winners:   'https://i.imgur.com/cpg5KVR.png',
};

// Couleurs en entier (hex) pour ContainerBuilder.setAccentColor
const COLORS = {
  green:   0xA8E4A0,
  yellow:  0xFFD580,
  orange:  0xFF9966,
  red:     0xFF9999,
  blue:    0x3498DB,
  grey:    0x95A5A6,
  crimson: 0xE74C3C,
  gold:    0xFFD700,
};

// ==================== CACHES ====================

const giveawaysCache    = new NodeCache({ stdTTL: 10 * 24 * 60 * 60, checkperiod: 3600 });
const rateLimiterCache  = new NodeCache({ stdTTL: 10, checkperiod: 60 });
const guildConfigCache  = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const participationLock = new Set();
const activeTimers      = new Map();
const dmReminderSent    = new Set();

// ==================== UTILITAIRES ====================

function sanitize(str, maxLen = 512) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/@(everyone|here)/gi, '@\u200b$1').slice(0, maxLen).trim();
}

const isValidImageUrl = (url) => {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    return /\.(jpg|jpeg|png|gif|bmp|webp|avif)(\?.*)?$/i.test(u.pathname);
  } catch { return false; }
};

function toUnix(ms) { return Math.floor(ms / 1000); }

function rateLimit(userId, action = 'cmd', cooldown = COMMAND_CD) {
  const key  = `${action}:${userId}`;
  const last = rateLimiterCache.get(key);
  const now  = Date.now();
  if (last && now - last < cooldown) return false;
  rateLimiterCache.set(key, now, Math.ceil(cooldown / 1000));
  return true;
}

function selectWinners(participants, count) {
  if (!participants.length) return [];
  const arr = [...participants];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

function hashDraw(participants, winners, timestamp) {
  const payload = JSON.stringify({ participants: [...participants].sort(), winners, timestamp });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16).toUpperCase();
}

function getUpdateInterval(remainingMs) {
  if (remainingMs > 24 * 60 * 60 * 1000) return 10 * 60 * 1000;
  if (remainingMs > 60 * 60 * 1000)      return 2  * 60 * 1000;
  if (remainingMs > 5  * 60 * 1000)      return 30 * 1000;
  return 10 * 1000;
}

function getMemberTickets(member, bonusRoles) {
  let t = 1;
  for (const [rId, bonus] of Object.entries(bonusRoles))
    if (member.roles.cache.has(rId)) t = Math.max(t, Number(bonus));
  return Math.min(t, 10);
}

function buildDrawPool(participants, memberCache, bonusRoles) {
  if (!Object.keys(bonusRoles).length) return participants;
  const pool = [];
  for (const uid of participants) {
    const m = memberCache.get(uid);
    const t = m ? getMemberTickets(m, bonusRoles) : 1;
    for (let i = 0; i < t; i++) pool.push(uid);
  }
  return pool;
}

let clientInstance = null;

// ==================== BASE DE DONNÉES ====================

const db = new Database(path.join(__dirname, 'giveaways.db'), {
  verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
  timeout: 5000
});

db.pragma('journal_mode = WAL');
db.pragma('synchronous  = NORMAL');
db.pragma('cache_size   = -64000');
db.pragma('temp_store   = MEMORY');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS giveaways (
    messageId    TEXT PRIMARY KEY,
    channelId    TEXT NOT NULL,
    guildId      TEXT NOT NULL,
    prix         TEXT NOT NULL,
    gagnants     INTEGER NOT NULL,
    endTime      INTEGER NOT NULL,
    participants TEXT NOT NULL DEFAULT '[]',
    roleRequired TEXT,
    commentaire  TEXT,
    image        TEXT,
    organizer    TEXT NOT NULL,
    startTime    INTEGER NOT NULL,
    duration     INTEGER NOT NULL,
    bonusRoles   TEXT DEFAULT '{}',
    drawHash     TEXT,
    scheduledStart INTEGER,
    roleMention     TEXT
  );

  CREATE TABLE IF NOT EXISTS giveaway_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId      TEXT NOT NULL,
    channelId    TEXT NOT NULL,
    prix         TEXT NOT NULL,
    organizer    TEXT NOT NULL,
    participants INTEGER NOT NULL,
    participantsList TEXT NOT NULL DEFAULT '[]',
    winners      TEXT NOT NULL,
    drawHash     TEXT,
    endedAt      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    userId  TEXT NOT NULL,
    guildId TEXT NOT NULL,
    addedBy TEXT NOT NULL,
    reason  TEXT,
    addedAt INTEGER NOT NULL,
    PRIMARY KEY (userId, guildId)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId   TEXT NOT NULL,
    action    TEXT NOT NULL,
    actorId   TEXT NOT NULL,
    targetId  TEXT,
    detail    TEXT,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS guild_config (
    guildId          TEXT PRIMARY KEY,
    logChannelId     TEXT,
    allowedChannels  TEXT DEFAULT '[]',
    allowedRoles     TEXT DEFAULT '[]',
    maxConcurrent    INTEGER DEFAULT 5,
    dmReminder       INTEGER DEFAULT 1,
    updatedAt        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_stats (
    userId       TEXT NOT NULL,
    guildId      TEXT NOT NULL,
    participations INTEGER NOT NULL DEFAULT 0,
    wins           INTEGER NOT NULL DEFAULT 0,
    lastUpdated  INTEGER NOT NULL,
    PRIMARY KEY (userId, guildId)
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_giveaways_guildId ON giveaways (guildId);
  CREATE INDEX IF NOT EXISTS idx_giveaways_endTime ON giveaways (endTime);
  CREATE INDEX IF NOT EXISTS idx_giveaways_guild_end ON giveaways (guildId, endTime);
  CREATE INDEX IF NOT EXISTS idx_history_guildId_endedAt ON giveaway_history (guildId, endedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_blacklist_guildId ON blacklist (guildId);
  CREATE INDEX IF NOT EXISTS idx_audit_guildId ON audit_log (guildId);
  CREATE INDEX IF NOT EXISTS idx_audit_guild_created ON audit_log (guildId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_stats_guildId_wins ON user_stats (guildId, wins DESC);
`);

console.log('✅ Index créés / vérifiés');

const cols = db.pragma('table_info(giveaways)').map(c => c.name);
if (!cols.includes('scheduledStart')) {
  db.exec('ALTER TABLE giveaways ADD COLUMN scheduledStart INTEGER');
  console.log('✅ Colonne scheduledStart ajoutée');
}
if (!cols.includes('roleMention')) {
  db.exec('ALTER TABLE giveaways ADD COLUMN roleMention TEXT');
  console.log('✅ Colonne roleMention ajoutée');
}

console.log('✅ Base de données initialisée');

// ==================== PREPARED STATEMENTS ====================

const stmts = {
  upsertGiveaway: db.prepare(`
    INSERT OR REPLACE INTO giveaways
      (messageId,channelId,guildId,prix,gagnants,endTime,participants,
       roleRequired,commentaire,image,organizer,startTime,duration,bonusRoles,drawHash,scheduledStart,roleMention)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `),
  deleteGiveaway:     db.prepare('DELETE FROM giveaways WHERE messageId = ?'),
  selectAll:          db.prepare('SELECT * FROM giveaways'),
  insertHistory:      db.prepare(`
    INSERT INTO giveaway_history
      (guildId,channelId,prix,organizer,participants,participantsList,winners,drawHash,endedAt)
    VALUES (?,?,?,?,?,?,?,?,?)
  `),
  isBlacklisted:      db.prepare('SELECT 1 FROM blacklist WHERE userId=? AND guildId=?'),
  addBlacklist:       db.prepare('INSERT OR REPLACE INTO blacklist (userId,guildId,addedBy,reason,addedAt) VALUES (?,?,?,?,?)'),
  removeBlacklist:    db.prepare('DELETE FROM blacklist WHERE userId=? AND guildId=?'),
  insertAudit:        db.prepare('INSERT INTO audit_log (guildId,action,actorId,targetId,detail,createdAt) VALUES (?,?,?,?,?,?)'),
  listHistory:        db.prepare('SELECT * FROM giveaway_history WHERE guildId=? ORDER BY endedAt DESC LIMIT 10'),
  updateStartTime:    db.prepare('UPDATE giveaways SET startTime=? WHERE messageId=?'),
  getGuildConfig:     db.prepare('SELECT * FROM guild_config WHERE guildId=?'),
  upsertGuildConfig:  db.prepare(`
    INSERT OR REPLACE INTO guild_config
      (guildId,logChannelId,allowedChannels,allowedRoles,maxConcurrent,dmReminder,updatedAt)
    VALUES (?,?,?,?,?,?,?)
  `),
  upsertStats: db.prepare(`
    INSERT INTO user_stats (userId,guildId,participations,wins,lastUpdated) VALUES (?,?,1,0,?)
    ON CONFLICT(userId,guildId) DO UPDATE SET
      participations = participations + 1,
      lastUpdated    = excluded.lastUpdated
  `),
  addWin: db.prepare(`
    INSERT INTO user_stats (userId,guildId,participations,wins,lastUpdated) VALUES (?,?,0,1,?)
    ON CONFLICT(userId,guildId) DO UPDATE SET
      wins        = wins + 1,
      lastUpdated = excluded.lastUpdated
  `),
  getUserStats: db.prepare('SELECT * FROM user_stats WHERE userId=? AND guildId=?'),
  topWinners:   db.prepare('SELECT * FROM user_stats WHERE guildId=? ORDER BY wins DESC LIMIT 10'),
  countActive:  db.prepare('SELECT COUNT(*) as cnt FROM giveaways WHERE guildId=?'),
  getHistoryByHash: db.prepare('SELECT * FROM giveaway_history WHERE drawHash = ? AND guildId = ?'),
};

// ==================== GUILD CONFIG ====================

function getGuildConfig(guildId) {
  const cached = guildConfigCache.get(guildId);
  if (cached) return cached;

  const row = stmts.getGuildConfig.get(guildId);
  const config = row ? {
    ...row,
    allowedChannels: JSON.parse(row.allowedChannels || '[]'),
    allowedRoles:    JSON.parse(row.allowedRoles    || '[]'),
  } : {
    guildId, logChannelId: null,
    allowedChannels: [], allowedRoles: [],
    maxConcurrent: 5, dmReminder: 1
  };

  guildConfigCache.set(guildId, config);
  return config;
}

function saveGuildConfig(config) {
  stmts.upsertGuildConfig.run(
    config.guildId,
    config.logChannelId ?? null,
    JSON.stringify(config.allowedChannels ?? []),
    JSON.stringify(config.allowedRoles    ?? []),
    config.maxConcurrent ?? 5,
    config.dmReminder    ?? 1,
    Date.now()
  );
  guildConfigCache.set(config.guildId, config);
}

async function postToLogChannel(guildId, container) {
  try {
    const config = getGuildConfig(guildId);
    if (!config.logChannelId) return;
    const channel = await clientInstance.channels.fetch(config.logChannelId).catch(() => null);
    if (!channel) return;
    await channel.send({ components: [container], flags: [MessageFlags.IsComponentsV2] });
  } catch {}
}

// ==================== DB HELPERS ====================

function saveGiveaway(giveaway) {
  stmts.upsertGiveaway.run(
    giveaway.messageId, giveaway.channelId, giveaway.guildId,
    giveaway.prix, giveaway.gagnants, giveaway.endTime,
    JSON.stringify(giveaway.participants),
    giveaway.roleRequired ?? null, giveaway.commentaire ?? null,
    giveaway.image ?? null, giveaway.organizer,
    giveaway.startTime, giveaway.duration,
    JSON.stringify(giveaway.bonusRoles ?? {}),
    giveaway.drawHash ?? null,
    giveaway.scheduledStart ?? null,
    giveaway.roleMention ?? null
  );
  giveawaysCache.set(giveaway.messageId, giveaway);
}

function deleteGiveaway(messageId) {
  stmts.deleteGiveaway.run(messageId);
  giveawaysCache.del(messageId);
  dmReminderSent.delete(messageId);
  if (activeTimers.has(messageId)) {
    clearTimeout(activeTimers.get(messageId));
    activeTimers.delete(messageId);
  }
}

function archiveGiveaway(giveaway, winners, drawHash) {
  try {
    stmts.insertHistory.run(
      giveaway.guildId, giveaway.channelId,
      giveaway.prix, giveaway.organizer,
      giveaway.participants.length,
      JSON.stringify(giveaway.participants),
      JSON.stringify(winners),
      drawHash ?? null, Date.now()
    );
  } catch (e) { console.error('archiveGiveaway:', e); }
}

function auditLog(guildId, action, actorId, targetId = null, detail = null) {
  try { stmts.insertAudit.run(guildId, action, actorId, targetId, detail ? JSON.stringify(detail) : null, Date.now()); } catch {}
}

function loadGiveaways() {
  const rows = stmts.selectAll.all();
  for (const row of rows) {
    row.participants = JSON.parse(row.participants || '[]');
    row.bonusRoles   = JSON.parse(row.bonusRoles   || '{}');
    row.roleMention  = row.roleMention ?? null;
    if (!row.startTime && row.duration) {
      row.startTime = row.endTime - row.duration;
      stmts.updateStartTime.run(row.startTime, row.messageId);
    }
    giveawaysCache.set(row.messageId, row);
  }
  return rows;
}

// ==================== COMPONENTS V2 BUILDERS ====================

function generateProgressBar(giveaway) {
  const { startTime, endTime } = giveaway;
  if (!startTime || !endTime) return { progressBar: '░'.repeat(20), color: COLORS.red, percentage: 0 };
  const total = endTime - startTime;
  if (total <= 0) return { progressBar: '█'.repeat(20), color: COLORS.red, percentage: 100 };
  const elapsed    = Math.max(0, Date.now() - startTime);
  const remaining  = Math.max(0, endTime - Date.now());
  const percentage = Math.round(Math.min(100, (elapsed / total) * 100));
  const remainPct  = (remaining / total) * 100;
  const color = remainPct > 66 ? COLORS.green : remainPct > 33 ? COLORS.yellow : remainPct > 10 ? COLORS.orange : COLORS.red;
  const filled = Math.round((percentage / 100) * 20);
  return { progressBar: '█'.repeat(filled) + '░'.repeat(20 - filled), color, percentage };
}

/**
 * Giveaway actif — Container v2
 */
function createGiveawayContainer(giveaway, guild) {
  const progress   = generateProgressBar(giveaway);
  const hasBonuses = Object.keys(giveaway.bonusRoles ?? {}).length > 0;

  // --- Ligne de bonus roles si besoin ---
  let bonusText = '';
  if (hasBonuses) {
    const lines = Object.entries(giveaway.bonusRoles)
      .map(([r, t]) => `<@&${r}> → ${t} ticket${t > 1 ? 's' : ''}`)
      .join('\n');
    bonusText = `\n\n**🎟️ Tickets bonus :**\n${lines}`;
  }

  const roleText = giveaway.roleRequired ? `\n\n**🔒 Rôle requis :**<@&${giveaway.roleRequired}>` : '';
  const mentionText = giveaway.roleMention ? `\n\n**📣 Rôle mentionné :**<@&${giveaway.roleMention}>` : '';
  const commentText = giveaway.commentaire
    ? `\n\n**📝 Informations supplémentaires :**\n${sanitize(giveaway.commentaire, MAX_COMMENT_LENGTH)}`
    : '';

  const mainText =
    `**🎁 Prix :** ${sanitize(giveaway.prix, MAX_PRIX_LENGTH)}\n\n` +
    `**👥 Participants :** ${giveaway.participants.length}\n\n` +
    `**🏆 Gagnants :** ${giveaway.gagnants}\n\n` +
    `**⏳ Fin :** <t:${toUnix(giveaway.endTime)}:R> • <t:${toUnix(giveaway.endTime)}:d>` +
    roleText + mentionText + bonusText +
    `\n\n**⏱️ Progression :** ${progress.percentage}%\n\`${progress.progressBar}\`` +
    commentText;

  const container = new ContainerBuilder()
    .setAccentColor(progress.color);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('# 🎉 Giveaway en Cours 🎉')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(mainText)
  );

  // Image du giveaway
  const imageUrl = giveaway.image || GIVEAWAY_IMAGES.active;
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(imageUrl)
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('enter').setLabel('Participer').setStyle(ButtonStyle.Secondary).setEmoji('🎉'),
      new ButtonBuilder().setCustomId('leave').setLabel('Se retirer').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
      new ButtonBuilder().setCustomId('cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
      new ButtonBuilder().setCustomId('show_participants').setLabel('Participants').setStyle(ButtonStyle.Secondary).setEmoji('👥')
    )
  );

  return container;
}

/**
 * Giveaway terminé — Container v2
 */
function createEndedGiveawayContainer(giveaway, winnerMembers, organizer, drawHash, guild) {
  const winnersText = winnerMembers.length
    ? winnerMembers.map(w => `<@${w.id}>`).join(', ')
    : '🥺 Aucun participant.';

  const organizerText = organizer ? `<@${organizer.id}>` : 'Inconnu';

  const commentText = giveaway.commentaire
    ? `\n\n**📝 Informations supplémentaires :**\n${sanitize(giveaway.commentaire)}`
    : '';

  const mainText =
    `**🎁 Prix :** ${sanitize(giveaway.prix)}\n\n` +
    `**👥 Participants :** ${giveaway.participants.length}\n\n` +
    `**🏆 Gagnant(s) :** ${winnersText}\n\n` +
    `**👤 Organisateur :** ${organizerText}` +
    commentText;

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.red);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('# 🎊 Giveaway Terminé ! 🎊')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(mainText)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(giveaway.image || GIVEAWAY_IMAGES.ended)
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  return container;
}

/**
 * Giveaway annulé — Container v2
 */
function createCancelledContainer(giveaway, organizer, guild) {
  const organizerText = organizer ? `<@${organizer.id}>` : 'Inconnu';
  const commentText = giveaway.commentaire
    ? `\n\n**📝 Informations supplémentaires :**\n${sanitize(giveaway.commentaire)}`
    : '';

  const mainText =
    `**🎁 Prix :** ${sanitize(giveaway.prix)}\n\n` +
    `**👥 Participants :** ${giveaway.participants.length}\n\n` +
    `**👤 Organisateur :** ${organizerText}\n\n` +
    `❌ **ANNULÉ** — D'autres giveaways arrivent bientôt !` +
    commentText;

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.crimson);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('# ❌ Giveaway Annulé')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(mainText)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(GIVEAWAY_IMAGES.cancelled)
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  return container;
}

/**
 * Fil privé gagnants — Container v2
 */
function createWinnersThreadContainer(giveaway, guild, drawHash, winnerMembers) {
  const hashText = drawHash
    ? `\n\n**🔐 Hash de vérification :** \`${drawHash}\`\n*Utilisez \`/giveaway verify ${drawHash}\` pour vérifier ce tirage*`
    : '';

  const winnersLine = winnerMembers?.length
    ? `\n\n**🏆 Gagnant(s) :** ${winnerMembers.map(m => `<@${m.id}>`).join(' ')}`
    : '';

  const mainText =
    `**🎁 Prix :** ${sanitize(giveaway.prix)}` +
    winnersLine +
    hashText +
    `\n\nUtilisez ce fil pour coordonner la remise de votre prix.` +
    (giveaway.commentaire ? `\n\n**📝 Informations supplémentaires :**\n${sanitize(giveaway.commentaire)}` : '');

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.green);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('# 🎊 Félicitations !')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(mainText)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(GIVEAWAY_IMAGES.winners)
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  return container;
}

/**
 * Giveaway planifié — Container v2
 */
function createScheduledContainer(giveaway, duréeInput, guild) {
  const { scheduledStart, endTime, gagnants, prix, roleRequired, commentaire, roleMention } = giveaway;

  const mainText =
    `**🎁 Prix :** ${sanitize(prix)}\n\n` +
    `**🏆 Gagnants :** ${gagnants}\n\n` +
    `**🕐 Début :** <t:${toUnix(scheduledStart)}:F> (<t:${toUnix(scheduledStart)}:R>)\n\n` +
    `**⏱️ Durée :** ${duréeInput}\n\n` +
    `**⏳ Fin prévue :** <t:${toUnix(endTime)}:F>` +
    (roleRequired ? `\n\n**🔒 Rôle requis :** <@&${roleRequired}>` : '') +
    (roleMention ? `\n\n**📣 Rôle mentionné :** <@&${roleMention}>` : '') +
    (commentaire ? `\n\n**📝 Informations supplémentaires :**\n${commentaire}` : '');

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.blue);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('# 📅 Giveaway Planifié')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(mainText)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(GIVEAWAY_IMAGES.active)
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  return container;
}

/**
 * Reminder DM — Container v2
 */
function createDMReminderContainer(giveaway) {
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.yellow);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('# ⏰ Rappel Giveaway')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `Un giveaway auquel vous participez se termine bientôt !\n\n` +
      `**🎁 Prix :** ${sanitize(giveaway.prix)}\n\n` +
      `**⏳ Fin :** <t:${toUnix(giveaway.endTime)}:R>\n\n` +
      `Bonne chance ! 🍀`
    )
  );

  return container;
}

/**
 * Log container générique — Container v2
 */
function createLogContainer(title, content, color = COLORS.green) {
  const container = new ContainerBuilder()
    .setAccentColor(color);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`# ${title}`)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(content)
  );

  return container;
}

/**
 * Info container générique (réponses slash) — Container v2
 */
function createInfoContainer(title, content, color = COLORS.blue) {
  const container = new ContainerBuilder()
    .setAccentColor(color);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`# ${title}`)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(content)
  );

  return container;
}

// ==================== FIN DE GIVEAWAY ====================

async function createPrivateThreadForWinners(channel, winners, giveaway, drawHash) {
  if (!winners.length) return null;
  const winnerMembers = winners.map(id => channel.guild.members.cache.get(id)).filter(Boolean);
  if (!winnerMembers.length) return null;

  const hasPerm = channel.permissionsFor(channel.guild.members.me)
    .has(PermissionsBitField.Flags.CreatePrivateThreads);

  if (!hasPerm) {
    await channel.send({
      content: `🎉 ${winnerMembers.map(m => `<@${m.id}>`).join(' ')} — Contactez <@${giveaway.organizer}> pour votre prix !`
    });
    return null;
  }

  try {
    const thread = await channel.threads.create({
      name: `🎉 Gagnants - ${giveaway.prix.substring(0, 50)}`,
      autoArchiveDuration: 10080,
      type: ChannelType.PrivateThread,
      reason: 'Fil privé gagnants giveaway'
    });
    for (const m of winnerMembers) await thread.members.add(m.id).catch(() => {});
    try { const org = await channel.guild.members.fetch(giveaway.organizer); await thread.members.add(org).catch(() => {}); } catch {}

    const container = createWinnersThreadContainer(giveaway, channel.guild, drawHash, winnerMembers);

    await thread.send({
      components: [container],
      flags: [MessageFlags.IsComponentsV2]
    });
    return thread;
  } catch (e) { console.error('createPrivateThread:', e); return null; }
}

async function sendDMReminders(giveaway) {
  const config = getGuildConfig(giveaway.guildId);
  if (!config.dmReminder) return;

  for (const userId of giveaway.participants) {
    try {
      const user = await clientInstance.users.fetch(userId).catch(() => null);
      if (!user) continue;
      const container = createDMReminderContainer(giveaway);
      await user.send({
        components: [container],
        flags: [MessageFlags.IsComponentsV2]
      }).catch(() => {});
    } catch {}
  }
}

function scheduleNextUpdate(message, giveaway) {
  if (activeTimers.has(giveaway.messageId)) {
    clearTimeout(activeTimers.get(giveaway.messageId));
  }

  const remaining = giveaway.endTime - Date.now();
  if (remaining <= 0) { endClassicGiveaway(message, giveaway).catch(console.error); return; }

  const DM_THRESHOLD = 15 * 60 * 1000;
  if (remaining > DM_THRESHOLD && !dmReminderSent.has(giveaway.messageId)) {
    const msUntilReminder = remaining - DM_THRESHOLD;
    setTimeout(() => {
      if (!dmReminderSent.has(giveaway.messageId)) {
        dmReminderSent.add(giveaway.messageId);
        const fresh = giveawaysCache.get(giveaway.messageId);
        if (fresh) sendDMReminders(fresh).catch(() => {});
      }
    }, msUntilReminder);
  }

  const delay = Math.min(getUpdateInterval(remaining), remaining);

  const timer = setTimeout(async () => {
    const current = giveawaysCache.get(giveaway.messageId);
    if (!current) return;

    if (current.endTime <= Date.now()) {
      await endClassicGiveaway(message, current);
      return;
    }
    try {
      await message.edit({
        components: [createGiveawayContainer(current, message.guild)],
        flags: [MessageFlags.IsComponentsV2]
      });
    } catch { activeTimers.delete(giveaway.messageId); return; }
    scheduleNextUpdate(message, current);
  }, delay);

  activeTimers.set(giveaway.messageId, timer);
}

async function startClassicCountdown(message, giveaway) {
  giveawaysCache.set(giveaway.messageId, giveaway);
  try {
    await message.edit({
      components: [createGiveawayContainer(giveaway, message.guild)],
      flags: [MessageFlags.IsComponentsV2]
    });
  } catch {}
  scheduleNextUpdate(message, giveaway);
}

async function endClassicGiveaway(message, giveaway) {
  if (activeTimers.has(giveaway.messageId)) {
    clearTimeout(activeTimers.get(giveaway.messageId));
    activeTimers.delete(giveaway.messageId);
  }

  const current = giveawaysCache.get(giveaway.messageId) ?? giveaway;
  const pool    = buildDrawPool(current.participants, message.guild.members.cache, current.bonusRoles ?? {});
  const winners = [...new Set(selectWinners(pool, current.gagnants))];
  const winnerMembers = winners.map(id => message.guild.members.cache.get(id)).filter(Boolean);
  const organizer     = await message.guild.members.fetch(current.organizer).catch(() => null);
  const drawHash      = hashDraw(current.participants, winners, current.endTime);

  for (const uid of current.participants) {
    stmts.upsertStats.run(uid, current.guildId, Date.now());
  }
  for (const uid of winners) {
    stmts.addWin.run(uid, current.guildId, Date.now());
  }

  archiveGiveaway(current, winners, drawHash);
  auditLog(current.guildId, 'GIVEAWAY_END', clientInstance.user.id, null, { winners, participants: current.participants.length, drawHash });

  const resultContainer = createEndedGiveawayContainer(current, winnerMembers, organizer, drawHash, message.guild);
  await message.edit({
    components: [resultContainer],
    flags: [MessageFlags.IsComponentsV2]
  }).catch(() => {});

  if (winnerMembers.length > 0) {
    const thread = await createPrivateThreadForWinners(message.channel, winners, current, drawHash);
    await message.channel.send({
      content: thread
        ? `🎉 **GIVEAWAY TERMINÉ !** Les gagnants ont gagné **${sanitize(current.prix)}** ! 🎁 ${thread}`
        : `🎉 **GIVEAWAY TERMINÉ !** Contactez <@${current.organizer}> pour réclamer **${sanitize(current.prix)}** !`
    });
  } else {
    await message.channel.send({ content: `🎉 **GIVEAWAY TERMINÉ !** Aucun participant pour **${sanitize(current.prix)}**.` });
  }

  await postToLogChannel(current.guildId, createLogContainer(
    '📋 Giveaway Terminé',
    `**Prix :** ${sanitize(current.prix)}\n` +
    `**Gagnants :** ${winners.map(id => `<@${id}>`).join(', ') || 'Aucun'}\n` +
    `**Participants :** ${current.participants.length}\n` +
    `**Hash :** \`${drawHash}\``,
    COLORS.green
  ));

  deleteGiveaway(current.messageId);
}

async function processExpiredGiveaway(giveaway) {
  try {
    const channel = await clientInstance.channels.fetch(giveaway.channelId).catch(() => null);
    if (!channel) { deleteGiveaway(giveaway.messageId); return; }
    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (!message) { deleteGiveaway(giveaway.messageId); return; }
    if (!message.components.length) { deleteGiveaway(giveaway.messageId); return; }
    await endClassicGiveaway(message, giveaway);
  } catch (e) { console.error('processExpiredGiveaway:', e); deleteGiveaway(giveaway.messageId); }
}

async function checkExpiredGiveaways() {
  const now = Date.now();
  for (const key of giveawaysCache.keys()) {
    const g = giveawaysCache.get(key);
    if (g && g.endTime <= now && !activeTimers.has(g.messageId)) {
      await processExpiredGiveaway(g).catch(console.error);
    }
  }
}

async function restartAllGiveaways() {
  const rows = stmts.selectAll.all();
  let ok = 0, expired = 0;
  for (const row of rows) {
    try {
      row.participants = JSON.parse(row.participants || '[]');
      row.bonusRoles   = JSON.parse(row.bonusRoles   || '{}');
      if (!row.startTime && row.duration) { row.startTime = row.endTime - row.duration; stmts.updateStartTime.run(row.startTime, row.messageId); }

      if (row.endTime <= Date.now()) { await processExpiredGiveaway(row); expired++; continue; }

      const channel = await clientInstance.channels.fetch(row.channelId).catch(() => null);
      if (!channel) { deleteGiveaway(row.messageId); continue; }
      const message = await channel.messages.fetch(row.messageId).catch(() => null);
      if (!message) { deleteGiveaway(row.messageId); continue; }
      giveawaysCache.set(row.messageId, row);
      await startClassicCountdown(message, row);
      ok++;
    } catch (e) { console.error('restartAllGiveaways:', e); }
  }
  console.log(`✅ Redémarrage : ${ok} actifs, ${expired} expirés traités`);
}

// ==================== GESTION DES BOUTONS ====================

async function handleEnterGiveaway(interaction, giveaway) {
  const { user, guild, member } = interaction;

  if (!rateLimit(user.id, 'enter', PARTICIPANT_CD))
    return interaction.reply({ content: '⏳ Patientez quelques secondes.', flags: [MessageFlags.Ephemeral] });

  if (stmts.isBlacklisted.get(user.id, guild.id))
    return interaction.reply({ content: '<:Erreur:1407372995176960132> Vous êtes blacklisté des giveaways.', flags: [MessageFlags.Ephemeral] });

  if (giveaway.roleRequired && !member.roles.cache.has(giveaway.roleRequired))
    return interaction.reply({ content: `<:Erreur:1407372995176960132> Rôle requis : <@&${giveaway.roleRequired}>`, flags: [MessageFlags.Ephemeral] });

  const lockKey = `${giveaway.messageId}:${user.id}`;
  if (participationLock.has(lockKey))
    return interaction.reply({ content: '⏳ Traitement en cours…', flags: [MessageFlags.Ephemeral] });

  participationLock.add(lockKey);
  try {
    const fresh = giveawaysCache.get(giveaway.messageId);
    if (!fresh) return interaction.reply({ content: '<:Erreur:1407372995176960132> Giveaway introuvable.', flags: [MessageFlags.Ephemeral] });
    if (fresh.participants.includes(user.id)) return interaction.reply({ content: '<:Erreur:1407372995176960132> Vous participez déjà.', flags: [MessageFlags.Ephemeral] });

    fresh.participants.push(user.id);
    saveGiveaway(fresh);

    const tickets = getMemberTickets(member, fresh.bonusRoles ?? {});
    const ticketMsg = tickets > 1 ? ` Vous avez **${tickets} tickets** !` : '';

    await interaction.reply({ content: `<:Valider:1407373060784521287> Vous avez rejoint le giveaway ! Bonne chance !${ticketMsg}`, flags: [MessageFlags.Ephemeral] });
    await interaction.message.edit({
      components: [createGiveawayContainer(fresh, interaction.guild)],
      flags: [MessageFlags.IsComponentsV2]
    }).catch(() => {});
    auditLog(guild.id, 'PARTICIPANT_ENTER', user.id, null);
  } finally { participationLock.delete(lockKey); }
}

async function handleLeaveGiveaway(interaction, giveaway) {
  const { user } = interaction;
  if (!rateLimit(user.id, 'leave', PARTICIPANT_CD))
    return interaction.reply({ content: '⏳ Patientez.', flags: [MessageFlags.Ephemeral] });

  const fresh = giveawaysCache.get(giveaway.messageId);
  if (!fresh || !fresh.participants.includes(user.id))
    return interaction.reply({ content: '<:Erreur:1407372995176960132> Vous ne participez pas à ce giveaway.', flags: [MessageFlags.Ephemeral] });
  if (fresh.endTime <= Date.now())
    return interaction.reply({ content: '<:Erreur:1407372995176960132> Giveaway terminé.', flags: [MessageFlags.Ephemeral] });

  fresh.participants = fresh.participants.filter(id => id !== user.id);
  saveGiveaway(fresh);
  await interaction.reply({ content: '<:Valider:1407373060784521287> Vous avez été Retiré du giveaway ! Dommage !', flags: [MessageFlags.Ephemeral] });
  await interaction.message.edit({
    components: [createGiveawayContainer(fresh, interaction.guild)],
    flags: [MessageFlags.IsComponentsV2]
  }).catch(() => {});
}

async function handleCancelGiveaway(interaction, giveaway) {
  const { member, guild } = interaction;
  if (interaction.user.id !== giveaway.organizer && !member.permissions.has(PermissionsBitField.Flags.ManageGuild))
    return interaction.reply({ content: '<:Erreur:1407372995176960132> Seul l\'organisateur ou un admin peut annuler.', flags: [MessageFlags.Ephemeral] });

  const organizer = await guild.members.fetch(giveaway.organizer).catch(() => null);
  const container = createCancelledContainer(giveaway, organizer, guild);

  await interaction.message.edit({
    components: [container],
    flags: [MessageFlags.IsComponentsV2]
  });

  auditLog(guild.id, 'GIVEAWAY_CANCEL', interaction.user.id, null);

  await postToLogChannel(guild.id, createLogContainer(
    '❌ Giveaway Annulé',
    `**Prix :** ${sanitize(giveaway.prix)}\n**Par :** <@${interaction.user.id}>`,
    COLORS.crimson
  ));

  deleteGiveaway(giveaway.messageId);
  await interaction.reply({ content: '<:Attention:1407372958501965914> Giveaway annulé.', flags: [MessageFlags.Ephemeral] });
}

async function handleShowParticipants(interaction, giveaway, page = 0) {
  const canSee = giveaway.participants.includes(interaction.user.id)
    || interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages);
  if (!canSee)
    return interaction.reply({ content: '<:Erreur:1407372995176960132> Seuls les participants peuvent voir la liste.', flags: [MessageFlags.Ephemeral] });

  const totalPages = Math.max(1, Math.ceil(giveaway.participants.length / PARTICIPANTS_PAGE));
  const paginated  = giveaway.participants.slice(page * PARTICIPANTS_PAGE, (page + 1) * PARTICIPANTS_PAGE);
  const list       = paginated.map(id => `<@${id}>`).join(', ') || 'Aucun participant.';

  const container = createInfoContainer(
    `📋 Participants (page ${page + 1}/${totalPages})`,
    list.slice(0, 4000),
    COLORS.blue
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`participants_prev:${giveaway.messageId}:${page}`)
      .setLabel('◀ Précédent').setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`participants_next:${giveaway.messageId}:${page}`)
      .setLabel('Suivant ▶').setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );

  if (totalPages > 1) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
    );
    container.addActionRowComponents(navRow);
  }

  const opts = {
    components: [container],
    flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2]
  };
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply(opts);
  } else {
    await interaction.reply(opts);
  }
}

async function handleButtonInteraction(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('participants_prev:') || customId.startsWith('participants_next:')) {
    const prefix   = customId.startsWith('participants_prev:') ? 'participants_prev:' : 'participants_next:';
    const rest     = customId.slice(prefix.length);
    const lastColon = rest.lastIndexOf(':');
    const messageId = rest.slice(0, lastColon);
    const currentPage = parseInt(rest.slice(lastColon + 1), 10);
    const giveaway    = giveawaysCache.get(messageId);
    if (!giveaway) return interaction.reply({ content: '<:Erreur:1407372995176960132> Giveaway introuvable.', flags: [MessageFlags.Ephemeral] });
    const newPage = prefix === 'participants_prev:' ? currentPage - 1 : currentPage + 1;
    await interaction.deferUpdate();
    return handleShowParticipants(interaction, giveaway, newPage);
  }

  const giveaway = giveawaysCache.get(interaction.message.id);
  if (!giveaway)
    return interaction.reply({ content: '<:Erreur:1407372995176960132> Ce giveaway n\'existe plus.', flags: [MessageFlags.Ephemeral] });

  switch (customId) {
    case 'enter':             return handleEnterGiveaway(interaction, giveaway);
    case 'leave':             return handleLeaveGiveaway(interaction, giveaway);
    case 'cancel':            return handleCancelGiveaway(interaction, giveaway);
    case 'show_participants': return handleShowParticipants(interaction, giveaway, 0);
    default:
      return interaction.reply({ content: '<:Erreur:1407372995176960132> Action inconnue.', flags: [MessageFlags.Ephemeral] });
  }
}

// ==================== COMMANDES ====================

async function handleClassicGiveaway(interaction) {
  const prix         = sanitize(interaction.options.getString('prix'), MAX_PRIX_LENGTH);
  const gagnants     = interaction.options.getInteger('gagnants');
  const duréeInput   = interaction.options.getString('durée');
  const roleReq      = interaction.options.getRole('role_requis');
  const roleMention  = interaction.options.getRole('role_mention');
  const commentaire  = sanitize(interaction.options.getString('commentaire') ?? '', MAX_COMMENT_LENGTH);
  let   image        = interaction.options.getString('image');
  const organizer    = interaction.user.id;

  if (!prix) throw new Error('Prix invalide.');
  if (image && !isValidImageUrl(image)) image = null;

  const config = getGuildConfig(interaction.guildId);
  if (config.allowedChannels.length && !config.allowedChannels.includes(interaction.channelId))
    throw new Error(`Les giveaways sont uniquement autorisés dans : ${config.allowedChannels.map(id => `<#${id}>`).join(', ')}`);

  if (config.allowedRoles.length && !config.allowedRoles.some(rId => interaction.member.roles.cache.has(rId)))
    throw new Error(`Seuls les membres avec les rôles autorisés peuvent créer des giveaways.`);

  const active = stmts.countActive.get(interaction.guildId);
  if (active.cnt >= config.maxConcurrent)
    throw new Error(`Limite de ${config.maxConcurrent} giveaways simultanés atteinte.`);

  const duréeMap = {
    '5m': 5*60*1000, '10m': 10*60*1000, '30m': 30*60*1000,
    '1h': 3600*1000, '3h': 3*3600*1000, '5h': 5*3600*1000,
    '1d': 86400*1000, '3d': 3*86400*1000, '5d': 5*86400*1000,
    '1w': 7*86400*1000,
  };

  const duréeMs  = duréeMap[duréeInput];
  const startTime = Date.now();
  const endTime   = startTime + duréeMs;

  const giveaway = {
    messageId: '', channelId: interaction.channelId, guildId: interaction.guildId,
    prix, gagnants, endTime, startTime, duration: duréeMs, participants: [],
    roleRequired: roleReq?.id ?? null, commentaire: commentaire || null,
    image: image || null, organizer, bonusRoles: {}, drawHash: null, scheduledStart: null,
    roleMention: roleMention?.id ?? null
  };

  const container = createGiveawayContainer(giveaway, interaction.guild);

  const msg = await interaction.channel.send({
    components: [container],
    flags: [MessageFlags.IsComponentsV2]
  });

  giveaway.messageId = msg.id;
  saveGiveaway(giveaway);
  auditLog(giveaway.guildId, 'GIVEAWAY_CREATE', organizer, null, { prix, gagnants, duration: duréeInput });

  await postToLogChannel(giveaway.guildId, createLogContainer(
    '🎉 Giveaway Créé',
    `**Prix :** ${sanitize(prix)}\n**Par :** <@${organizer}>\n**Durée :** ${duréeInput}`,
    COLORS.green
  ));

  startClassicCountdown(msg, giveaway);
}

async function handleScheduledGiveaway(interaction) {
  const prix         = sanitize(interaction.options.getString('prix'), MAX_PRIX_LENGTH);
  const gagnants     = interaction.options.getInteger('gagnants');
  const duréeInput   = interaction.options.getString('durée');
  const debutStr     = interaction.options.getString('debut');
  const roleReq      = interaction.options.getRole('role_requis');
  const roleMention  = interaction.options.getRole('role_mention');
  const commentaire  = sanitize(interaction.options.getString('commentaire') ?? '', MAX_COMMENT_LENGTH);
  const organizer    = interaction.user.id;

  const match = debutStr.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Format de date invalide. Utilisez JJ/MM/AAAA HH:MM (ex: 25/12/2025 18:00)');

  const [, day, month, year, hours, minutes] = match;
  const scheduledDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes));
  if (isNaN(scheduledDate.getTime())) throw new Error('Date invalide.');
  if (scheduledDate.getTime() <= Date.now()) throw new Error('La date de début doit être dans le futur.');
  if (scheduledDate.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) throw new Error('Maximum 30 jours à l\'avance.');

  const duréeMap = {
    '5m': 5*60*1000, '10m': 10*60*1000, '30m': 30*60*1000,
    '1h': 3600*1000, '3h': 3*3600*1000, '5h': 5*3600*1000,
    '1d': 86400*1000, '3d': 3*86400*1000, '5d': 5*86400*1000,
    '1w': 7*86400*1000,
  };

  const duréeMs        = duréeMap[duréeInput];
  const scheduledStart = scheduledDate.getTime();
  const giveaway = {
    messageId: '', channelId: interaction.channelId, guildId: interaction.guildId,
    prix, gagnants,
    endTime:      scheduledStart + duréeMs,
    startTime:    scheduledStart,
    duration:     duréeMs,
    participants: [],
    roleRequired: roleReq?.id ?? null,
    commentaire:  commentaire || null,
    image:        null, organizer,
    bonusRoles:   {}, drawHash: null,
    scheduledStart,
    roleMention:  roleMention?.id ?? null
  };

  const container = createScheduledContainer(giveaway, duréeInput, interaction.guild);

  const msg = await interaction.channel.send({
    components: [container],
    flags: [MessageFlags.IsComponentsV2]
  });

  giveaway.messageId = msg.id;
  saveGiveaway(giveaway);
  auditLog(giveaway.guildId, 'GIVEAWAY_SCHEDULED', organizer, null, { scheduledStart, duration: duréeInput });

  const msUntilStart = scheduledStart - Date.now();
  setTimeout(async () => {
    const g = giveawaysCache.get(msg.id);
    if (!g) return;

    const now       = Date.now();
    g.startTime     = now;
    g.endTime       = now + duréeMs;
    g.scheduledStart = null;
    saveGiveaway(g);

    const channel = await clientInstance.channels.fetch(g.channelId).catch(() => null);
    const liveContainer = createGiveawayContainer(g, channel?.guild);

    await msg.edit({
      components: [liveContainer],
      flags: [MessageFlags.IsComponentsV2]
    }).catch(() => {});

    startClassicCountdown(msg, g);
  }, msUntilStart);
}

async function handleForceEnd(interaction) {
  const msgId = interaction.options.getString('hash');
  let target = null;
  for (const key of giveawaysCache.keys()) {
    const g = giveawaysCache.get(key);
    if (g?.messageId === msgId && g?.guildId === interaction.guildId) { target = g; break; }
  }
  if (!target) return interaction.editReply({ content: '<:Erreur:1407372995176960132> Giveaway introuvable.' });
  if (interaction.user.id !== target.organizer && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
    return interaction.editReply({ content: '<:Erreur:1407372995176960132> Permissions insuffisantes.' });

  const channel = await clientInstance.channels.fetch(target.channelId).catch(() => null);
  const message = channel ? await channel.messages.fetch(target.messageId).catch(() => null) : null;
  if (!channel || !message) return interaction.editReply({ content: '<:Erreur:1407372995176960132> Message introuvable.' });

  target.endTime = Date.now() - 1;
  giveawaysCache.set(target.messageId, target);
  await endClassicGiveaway(message, target);
  await interaction.editReply({ content: '<:Valider:1407373060784521287> Giveaway terminé manuellement.' });
}

async function handleReroll(interaction) {
  const hash = interaction.options.getString('hash');
  const row  = stmts.getHistoryByHash.get(hash.toUpperCase(), interaction.guildId);
  if (!row) return interaction.editReply({ content: `<:Erreur:1407372995176960132> Historique introuvable.` });
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages) && interaction.user.id !== row.organizer)
    return interaction.editReply({ content: '<:Erreur:1407372995176960132> Permissions insuffisantes.' });

  const participants = JSON.parse(row.participantsList || '[]');
  if (!participants.length) return interaction.editReply({ content: '<:Erreur:1407372995176960132> Aucun participant.' });

  const newWinners   = selectWinners(participants, 1);
  const winnerMember = newWinners[0] ? interaction.guild.members.cache.get(newWinners[0]) : null;

  const container = createInfoContainer(
    '🔄 Nouveau Tirage (Reroll) !',
    winnerMember
      ? `**🏆 Nouveau gagnant :** <@${winnerMember.id}>\n\n**🎁 Prix :** ${sanitize(row.prix)}`
      : '🥺 Impossible de sélectionner un gagnant.',
    COLORS.green
  );

  await interaction.editReply({
    components: [container],
    flags: [MessageFlags.IsComponentsV2]
  });
  auditLog(interaction.guildId, 'GIVEAWAY_REROLL', interaction.user.id, null, { newWinners });
}

async function handleList(interaction) {
  const active = giveawaysCache.keys()
    .map(k => giveawaysCache.get(k))
    .filter(g => g?.guildId === interaction.guildId)
    .sort((a, b) => a.endTime - b.endTime);

  if (!active.length) return interaction.editReply({ content: '📭 Aucun giveaway actif.' });

  const lines = active.map(g => {
    const scheduled = g.scheduledStart && g.scheduledStart > Date.now() ? '📅 ' : '🔴 ';
    return `${scheduled}**${sanitize(g.prix, 60)}** — fin <t:${toUnix(g.endTime)}:R> — ${g.participants.length} participants`;
  });

  const container = createInfoContainer(
    `📋 Giveaways actifs (${active.length})`,
    lines.join('\n').slice(0, 4000),
    COLORS.blue
  );

  await interaction.editReply({
    components: [container],
    flags: [MessageFlags.IsComponentsV2]
  });
}

async function handleInfo(interaction) {
  const hash = interaction.options.getString('hash');
  let target = null;

  for (const key of giveawaysCache.keys()) {
    const g = giveawaysCache.get(key);
    if (g?.messageId === hash && g?.guildId === interaction.guildId) { target = g; break; }
  }

  if (!target) {
    const hist = stmts.getHistoryByHash.get(hash.toUpperCase(), interaction.guildId);
    if (!hist) return interaction.editReply({ content: '<:Erreur:1407372995176960132> Hash introuvable dans les giveaways actifs ou l\'historique.' });
    const winners = JSON.parse(hist.winners || '[]');
    const container = createInfoContainer(
      '📜 Historique Giveaway',
      `**🎁 Prix :** ${sanitize(hist.prix)}\n` +
      `**👥 Participants :** ${hist.participants}\n` +
      `**🏆 Gagnant(s) :** ${winners.map(id => `<@${id}>`).join(', ') || 'Aucun'}\n` +
      `**👤 Organisateur :** <@${hist.organizer}>\n` +
      `**📅 Terminé :** <t:${toUnix(hist.endedAt)}:f>` +
      (hist.drawHash ? `\n**🔐 Hash :** \`${hist.drawHash}\`` : ''),
      COLORS.grey
    );
    return interaction.editReply({
      components: [container],
      flags: [MessageFlags.IsComponentsV2]
    });
  }

  await interaction.editReply({
    components: [createGiveawayContainer(target, interaction.guild)],
    flags: [MessageFlags.IsComponentsV2]
  });
}

async function handleHistory(interaction) {
  const rows = stmts.listHistory.all(interaction.guildId);
  if (!rows.length) return interaction.editReply({ content: '📭 Aucun giveaway terminé.' });
  const lines = rows.map(r => {
    const w = JSON.parse(r.winners || '[]');
    return `• **${sanitize(r.prix, 50)}** — ${r.participants} participants — ${w.length} gagnant(s) — <t:${toUnix(r.endedAt)}:d>${r.drawHash ? ` — \`${r.drawHash}\`` : ''}`;
  });

  const container = createInfoContainer(
    '📜 Historique (10 derniers)',
    lines.join('\n').slice(0, 4000),
    COLORS.grey
  );

  await interaction.editReply({
    components: [container],
    flags: [MessageFlags.IsComponentsV2]
  });
}

async function handleVerify(interaction) {
  const input = interaction.options.getString('hash').trim();
  const hist = stmts.getHistoryByHash.get(input.toUpperCase(), interaction.guildId);

  if (!hist) {
    return interaction.editReply({
      content: `<:Erreur:1407372995176960132> Hash \`${sanitize(input, 64)}\` introuvable dans l'historique.\n` +
        `> Utilisez \`/giveaway history\` pour voir les hash des giveaways récents.`
    });
  }

  const winners      = JSON.parse(hist.winners         || '[]');
  const participants = JSON.parse(hist.participantsList || '[]');
  const recomputed   = hashDraw(participants, winners, hist.endedAt);
  const match        = recomputed === hist.drawHash;

  const container = createInfoContainer(
    '🔐 Vérification du Tirage',
    `**🎁 Prix :** ${sanitize(hist.prix)}\n` +
    `**👥 Participants :** ${hist.participants}\n` +
    `**🏆 Gagnant(s) :** ${winners.map(id => `<@${id}>`).join(', ') || 'Aucun'}\n\n` +
    `**🔐 Hash enregistré :** \`${hist.drawHash ?? 'N/A'}\`\n` +
    `**🔁 Hash recalculé :** \`${recomputed}\`\n\n` +
    `**Résultat :** ${match ? '✅ Tirage authentique — les données n\'ont pas été modifiées' : '⚠️ Hash différent — les données ont peut-être été altérées'}`,
    match ? COLORS.green : COLORS.crimson
  );

  await interaction.editReply({
    components: [container],
    flags: [MessageFlags.IsComponentsV2]
  });
}

async function handleBlacklist(interaction) {
  const sub = interaction.options.getSubcommand();
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages))
    return interaction.editReply({ content: '<:Erreur:1407372995176960132> Permissions insuffisantes.' });

  if (sub === 'add') {
    const user   = interaction.options.getUser('utilisateur');
    const reason = sanitize(interaction.options.getString('raison') ?? '', 256);
    stmts.addBlacklist.run(user.id, interaction.guildId, interaction.user.id, reason, Date.now());
    auditLog(interaction.guildId, 'BLACKLIST_ADD', interaction.user.id, user.id, { reason });
    await interaction.editReply({ content: `<:Valider:1407373060784521287> <@${user.id}> blacklisté.` });
  } else {
    const user = interaction.options.getUser('utilisateur');
    stmts.removeBlacklist.run(user.id, interaction.guildId);
    await interaction.editReply({ content: `<:Valider:1407373060784521287> <@${user.id}> retiré de la blacklist.` });
  }
}

async function handleStats(interaction) {
  const target = interaction.options.getUser('utilisateur') ?? interaction.user;
  const row    = stmts.getUserStats.get(target.id, interaction.guildId);

  if (!row) return interaction.editReply({ content: `📊 <@${target.id}> n'a encore jamais participé à un giveaway sur ce serveur.` });

  const winRate = row.participations > 0 ? ((row.wins / row.participations) * 100).toFixed(1) : '0.0';

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.blue);

  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# 📊 Statistiques de ${target.username}`)
      )
      .setThumbnailAccessory(
        new ThumbnailBuilder().setURL(target.displayAvatarURL({ dynamic: true }))
      )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**👥 Participations :** ${row.participations}\n\n` +
      `**🏆 Victoires :** ${row.wins}\n\n` +
      `**🎯 Taux de victoire :** ${winRate}%\n\n` +
      `**📅 Dernière activité :** <t:${toUnix(row.lastUpdated)}:R>`
    )
  );

  await interaction.editReply({
    components: [container],
    flags: [MessageFlags.IsComponentsV2]
  });
}

async function handleLeaderboard(interaction) {
  const rows = stmts.topWinners.all(interaction.guildId);
  if (!rows.length) return interaction.editReply({ content: '📭 Aucune statistique disponible.' });

  const medals = ['🥇', '🥈', '🥉'];
  const lines  = await Promise.all(rows.map(async (r, i) => {
    const user = await clientInstance.users.fetch(r.userId).catch(() => null);
    const name = user ? user.username : `User#${r.userId.slice(-4)}`;
    const medal = medals[i] ?? `**${i + 1}.**`;
    const rate   = r.participations > 0 ? ((r.wins / r.participations) * 100).toFixed(1) : '0.0';
    return `${medal} **${name}** — 🏆 ${r.wins} victoires / 👥 ${r.participations} participations (${rate}%)`;
  }));

  const container = createInfoContainer(
    '🏆 Leaderboard des Gagnants',
    lines.join('\n'),
    COLORS.gold
  );

  await interaction.editReply({
    components: [container],
    flags: [MessageFlags.IsComponentsV2]
  });
}

async function handleSetup(interaction) {
  const sub = interaction.options.getSubcommand();
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
    return interaction.editReply({ content: '<:Erreur:1407372995176960132> Permission ManageGuild requise.' });

  const config = getGuildConfig(interaction.guildId);

  if (sub === 'log_channel') {
    const channel = interaction.options.getChannel('canal');
    config.logChannelId = channel?.id ?? null;
    saveGuildConfig(config);
    await interaction.editReply({ content: channel ? `<:Valider:1407373060784521287> Canal de logs défini : <#${channel.id}>` : '<:Valider:1407373060784521287> Canal de logs désactivé.' });

  } else if (sub === 'allow_channel') {
    const channel = interaction.options.getChannel('canal');
    const action  = interaction.options.getString('action');
    if (action === 'add') {
      if (!config.allowedChannels.includes(channel.id)) config.allowedChannels.push(channel.id);
      await interaction.editReply({ content: `<:Valider:1407373060784521287> <#${channel.id}> ajouté à la whitelist.` });
    } else {
      config.allowedChannels = config.allowedChannels.filter(id => id !== channel.id);
      await interaction.editReply({ content: `<:Valider:1407373060784521287> <#${channel.id}> retiré de la whitelist.` });
    }
    saveGuildConfig(config);

  } else if (sub === 'allow_role') {
    const role   = interaction.options.getRole('role');
    const action = interaction.options.getString('action');
    if (action === 'add') {
      if (!config.allowedRoles.includes(role.id)) config.allowedRoles.push(role.id);
      await interaction.editReply({ content: `<:Valider:1407373060784521287> <@&${role.id}> autorisé à créer des giveaways.` });
    } else {
      config.allowedRoles = config.allowedRoles.filter(id => id !== role.id);
      await interaction.editReply({ content: `<:Valider:1407373060784521287> <@&${role.id}> retiré.` });
    }
    saveGuildConfig(config);

  } else if (sub === 'max_concurrent') {
    const max = interaction.options.getInteger('max');
    config.maxConcurrent = max;
    saveGuildConfig(config);
    await interaction.editReply({ content: `<:Valider:1407373060784521287> Limite définie à ${max} giveaways simultanés.` });

  } else if (sub === 'dm_reminder') {
    const enabled = interaction.options.getBoolean('activer');
    config.dmReminder = enabled ? 1 : 0;
    saveGuildConfig(config);
    await interaction.editReply({ content: `<:Valider:1407373060784521287> Rappel DM ${enabled ? 'activé' : 'désactivé'}.` });

  } else if (sub === 'view') {
    const lines = [
      `**📢 Canal de logs :** ${config.logChannelId ? `<#${config.logChannelId}>` : 'Non défini'}`,
      `**📌 Canaux autorisés :** ${config.allowedChannels.length ? config.allowedChannels.map(id => `<#${id}>`).join(', ') : 'Tous'}`,
      `**👑 Rôles autorisés :** ${config.allowedRoles.length ? config.allowedRoles.map(id => `<@&${id}>`).join(', ') : 'Tous (ManageMessages)'}`,
      `**🔢 Max simultanés :** ${config.maxConcurrent}`,
      `**💌 Rappel DM :** ${config.dmReminder ? '✅ Activé' : '❌ Désactivé'}`,
    ];
    const container = createInfoContainer(
      '⚙️ Configuration Giveaway',
      lines.join('\n'),
      COLORS.blue
    );
    await interaction.editReply({
      components: [container],
      flags: [MessageFlags.IsComponentsV2]
    });

  } else if (sub === 'reload') {
    guildConfigCache.del(interaction.guildId);
    getGuildConfig(interaction.guildId);
    console.log(`🔄 Config rechargée pour guild ${interaction.guildId}`);
    await interaction.editReply({ content: `<:Valider:1407373060784521287> Configuration rechargée depuis la base de données. Aucun redémarrage nécessaire.` });
  }
}

// ==================== COMMANDES SLASH ====================

const giveawayCommand = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Système de giveaways avancé')

    .addSubcommand(sub => sub.setName('create').setDescription('Créer un giveaway')
      .addStringOption(o => o.setName('prix').setDescription('Le prix').setRequired(true).setMaxLength(MAX_PRIX_LENGTH))
      .addIntegerOption(o => o.setName('gagnants').setDescription('Nombre de gagnants').setRequired(true).setMinValue(1).setMaxValue(20))
      .addStringOption(o => o.setName('durée').setDescription('Durée').setRequired(true).addChoices(
        {name:'5 minutes',value:'5m'},{name:'10 minutes',value:'10m'},{name:'30 minutes',value:'30m'},
        {name:'1 heure',value:'1h'},{name:'3 heures',value:'3h'},{name:'5 heures',value:'5h'},
        {name:'1 jour',value:'1d'},{name:'3 jours',value:'3d'},{name:'5 jours',value:'5d'},{name:'1 semaine',value:'1w'}
      ))
      .addRoleOption(o => o.setName('role_requis').setDescription('Rôle requis').setRequired(false))
      .addRoleOption(o => o.setName('role_mention').setDescription('Rôle à mentionner').setRequired(false))
      .addStringOption(o => o.setName('commentaire').setDescription('Commentaire').setRequired(false).setMaxLength(MAX_COMMENT_LENGTH))
      .addStringOption(o => o.setName('image').setDescription('URL image').setRequired(false))
    )

    .addSubcommand(sub => sub.setName('schedule').setDescription('Planifier un giveaway')
      .addStringOption(o => o.setName('prix').setDescription('Le prix').setRequired(true).setMaxLength(MAX_PRIX_LENGTH))
      .addIntegerOption(o => o.setName('gagnants').setDescription('Nombre de gagnants').setRequired(true).setMinValue(1).setMaxValue(20))
      .addStringOption(o => o.setName('durée').setDescription('Durée du giveaway').setRequired(true).addChoices(
        {name:'5 minutes',value:'5m'},{name:'10 minutes',value:'10m'},{name:'30 minutes',value:'30m'},
        {name:'1 heure',value:'1h'},{name:'3 heures',value:'3h'},{name:'5 heures',value:'5h'},
        {name:'1 jour',value:'1d'},{name:'3 jours',value:'3d'},{name:'5 jours',value:'5d'},{name:'1 semaine',value:'1w'}
      ))
      .addStringOption(o => o.setName('debut').setDescription('Date/heure de début (JJ/MM/AAAA HH:MM)').setRequired(true))
      .addRoleOption(o => o.setName('role_requis').setDescription('Rôle requis').setRequired(false))
      .addRoleOption(o => o.setName('role_mention').setDescription('Rôle à mentionner').setRequired(false))
      .addStringOption(o => o.setName('commentaire').setDescription('Commentaire').setRequired(false).setMaxLength(MAX_COMMENT_LENGTH))
    )

    .addSubcommand(sub => sub.setName('end').setDescription('Terminer un giveaway immédiatement')
      .addStringOption(o => o.setName('hash').setDescription('Hash ou messageId du giveaway').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('reroll').setDescription('Retirer un nouveau gagnant')
      .addStringOption(o => o.setName('hash').setDescription('Hash de vérification du giveaway terminé').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('list').setDescription('Voir les giveaways actifs'))
    .addSubcommand(sub => sub.setName('info').setDescription('Détails d\'un giveaway')
      .addStringOption(o => o.setName('hash').setDescription('Hash ou messageId du giveaway').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('history').setDescription('Historique des 10 derniers giveaways'))
    .addSubcommand(sub => sub.setName('verify').setDescription('Vérifier l\'intégrité d\'un tirage')
      .addStringOption(o => o.setName('hash').setDescription('Hash ou messageId du giveaway').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('stats').setDescription('Voir les statistiques d\'un utilisateur')
      .addUserOption(o => o.setName('utilisateur').setDescription('Utilisateur (optionnel)').setRequired(false))
    )
    .addSubcommand(sub => sub.setName('leaderboard').setDescription('Top 10 des gagnants du serveur'))

    .addSubcommandGroup(g => g.setName('blacklist').setDescription('Gestion de la blacklist')
      .addSubcommand(sub => sub.setName('add').setDescription('Blacklister un utilisateur')
        .addUserOption(o => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true))
        .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false).setMaxLength(256))
      )
      .addSubcommand(sub => sub.setName('remove').setDescription('Retirer de la blacklist')
        .addUserOption(o => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true))
      )
    )

    .addSubcommandGroup(g => g.setName('setup').setDescription('Configuration du bot')
      .addSubcommand(sub => sub.setName('view').setDescription('Voir la configuration actuelle'))
      .addSubcommand(sub => sub.setName('reload').setDescription('Recharger la config sans redémarrage'))
      .addSubcommand(sub => sub.setName('log_channel').setDescription('Définir le canal de logs')
        .addChannelOption(o => o.setName('canal').setDescription('Canal (vide = désactiver)').setRequired(false))
      )
      .addSubcommand(sub => sub.setName('allow_channel').setDescription('Gérer la whitelist des canaux')
        .addChannelOption(o => o.setName('canal').setDescription('Canal').setRequired(true))
        .addStringOption(o => o.setName('action').setDescription('Ajouter ou retirer').setRequired(true)
          .addChoices({name:'Ajouter',value:'add'},{name:'Retirer',value:'remove'})
        )
      )
      .addSubcommand(sub => sub.setName('allow_role').setDescription('Gérer les rôles autorisés à créer')
        .addRoleOption(o => o.setName('role').setDescription('Rôle').setRequired(true))
        .addStringOption(o => o.setName('action').setDescription('Ajouter ou retirer').setRequired(true)
          .addChoices({name:'Ajouter',value:'add'},{name:'Retirer',value:'remove'})
        )
      )
      .addSubcommand(sub => sub.setName('max_concurrent').setDescription('Limite de giveaways simultanés')
        .addIntegerOption(o => o.setName('max').setDescription('Maximum').setRequired(true).setMinValue(1).setMaxValue(20))
      )
      .addSubcommand(sub => sub.setName('dm_reminder').setDescription('Activer/désactiver le rappel DM')
        .addBooleanOption(o => o.setName('activer').setDescription('Activer ?').setRequired(true))
      )
    ),

  async execute(interaction) {
    const sub    = interaction.options.getSubcommand(false);
    const group  = interaction.options.getSubcommandGroup(false);
    const publicCmds = ['list', 'info', 'history', 'verify', 'stats', 'leaderboard'];
    const needsPerms = group || !publicCmds.includes(sub ?? '');

    if (needsPerms && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return interaction.reply({ content: '<:Erreur:1407372995176960132> Permissions insuffisantes.', flags: [MessageFlags.Ephemeral] });
    }

    if (!rateLimit(interaction.user.id, 'cmd', COMMAND_CD))
      return interaction.reply({ content: '⏳ Patientez avant de réessayer.', flags: [MessageFlags.Ephemeral] });

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      if (group === 'blacklist') { await handleBlacklist(interaction); return; }
      if (group === 'setup')     { await handleSetup(interaction);     return; }

      switch (sub) {
        case 'create':      await handleClassicGiveaway(interaction); await interaction.editReply({ content: '<:Valider:1407373060784521287> **Giveaway créé !**' }); break;
        case 'schedule':    await handleScheduledGiveaway(interaction); await interaction.editReply({ content: '<:Valider:1407373060784521287> **Giveaway planifié !**' }); break;
        case 'end':         await handleForceEnd(interaction);   break;
        case 'reroll':      await handleReroll(interaction);     break;
        case 'list':        await handleList(interaction);       break;
        case 'info':        await handleInfo(interaction);       break;
        case 'history':     await handleHistory(interaction);    break;
        case 'verify':      await handleVerify(interaction);     break;
        case 'stats':       await handleStats(interaction);      break;
        case 'leaderboard': await handleLeaderboard(interaction); break;
        default: await interaction.editReply({ content: '<:Erreur:1407372995176960132> Commande inconnue.' });
      }
    } catch (e) {
      console.error('execute:', e);
      await interaction.editReply({ content: `<:Erreur:1407372995176960132> ${e.message?.slice(0, 200) ?? 'Erreur inconnue'}` });
    }
  }
};

// ==================== CLIENT ====================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Channel, Partials.Message, Partials.User],
  rest: { timeout: 30000, retries: 3 }, shards: 'auto',
});
client.commands = new Map();
clientInstance = client;

function updateActivity() {
  client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isCommand()) {
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;
    try { await cmd.execute(interaction); }
    catch (e) { console.error('Interaction cmd:', e); if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '<:Attention:1407372958501965914> Erreur.', flags: [MessageFlags.Ephemeral] }).catch(()=>{}); }
  } else if (interaction.isButton()) {
    await handleButtonInteraction(interaction).catch(async (e) => {
      console.error('Interaction btn:', e);
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '<:Erreur:1407372995176960132> Erreur.', flags: [MessageFlags.Ephemeral] }).catch(()=>{});
    });
  }
});

client.on(Events.GuildCreate, async (guild) => {
  updateActivity();

  try {
    const existing = stmts.getGuildConfig.get(guild.id);
    if (!existing) {
      stmts.upsertGuildConfig.run(guild.id, null, '[]', '[]', 5, 1, Date.now());
      console.log(`✅ Config initialisée pour le serveur "${guild.name}" (${guild.id})`);
    }

    auditLog(guild.id, 'BOT_JOIN', client.user.id, null, {
      guildName: guild.name,
      memberCount: guild.memberCount
    });

    try {
      const owner = await guild.fetchOwner();
      const welcomeContainer = new ContainerBuilder()
        .setAccentColor(COLORS.green);

      welcomeContainer.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('# 👋 Merci de m\'avoir ajouté !')
      );

      welcomeContainer.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      );

      welcomeContainer.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `Bonjour ! Je suis votre nouveau bot de giveaways sur **${guild.name}**.\n\n` +
          `**🚀 Pour démarrer :**\n` +
          `• \`/giveaway create\` — Créer un giveaway\n` +
          `• \`/giveaway setup view\` — Voir la configuration\n` +
          `• \`/giveaway setup log_channel #salon\` — Définir un canal de logs\n` +
          `• \`/giveaway setup allow_channel #salon add\` — Restreindre à un canal\n\n` +
          `**📋 Commandes disponibles :**\n` +
          `\`create\` \`schedule\` \`end\` \`reroll\` \`list\` \`info\` \`history\` \`verify\` \`stats\` \`leaderboard\` \`blacklist\` \`setup\`\n\n` +
          `Bonne chance à tous vos participants ! 🎉`
        )
      );

      await owner.send({
        components: [welcomeContainer],
        flags: [MessageFlags.IsComponentsV2]
      }).catch(() => {});
    } catch {}

    console.log(`➕ Bot ajouté sur : "${guild.name}" (${guild.id}) — ${guild.memberCount} membres`);
  } catch (e) {
    console.error(`❌ GuildCreate erreur pour "${guild.name}":`, e);
  }
});

client.on(Events.GuildDelete, async (guild) => {
  updateActivity();

  try {
    const guildId = guild.id;

    let cleanedGiveaways = 0;
    for (const key of giveawaysCache.keys()) {
      const g = giveawaysCache.get(key);
      if (g?.guildId === guildId) {
        deleteGiveaway(g.messageId);
        cleanedGiveaways++;
      }
    }

    const deleteByGuild = db.transaction((gId) => {
      db.prepare('DELETE FROM giveaways        WHERE guildId = ?').run(gId);
      db.prepare('DELETE FROM giveaway_history WHERE guildId = ?').run(gId);
      db.prepare('DELETE FROM blacklist        WHERE guildId = ?').run(gId);
      db.prepare('DELETE FROM audit_log        WHERE guildId = ?').run(gId);
      db.prepare('DELETE FROM guild_config     WHERE guildId = ?').run(gId);
      db.prepare('DELETE FROM user_stats       WHERE guildId = ?').run(gId);
    });
    deleteByGuild(guildId);

    guildConfigCache.del(guildId);

    console.log(`➖ Bot retiré de : "${guild.name ?? guildId}" — ${cleanedGiveaways} giveaway(s) supprimé(s), toutes les données effacées`);
  } catch (e) {
    console.error(`❌ GuildDelete erreur pour guild ${guild.id}:`, e);
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  client.commands.set('giveaway', giveawayCommand);
  updateActivity();

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: [giveawayCommand.data.toJSON()] });
    console.log('✅ Slash commands enregistrées');
  } catch (e) { console.error('Enregistrement:', e); }

  loadGiveaways();

  setTimeout(async () => {
    await restartAllGiveaways();
    setInterval(() => checkExpiredGiveaways().catch(console.error), 2 * 60 * 1000);
    console.log('✅ Système giveaway opérationnel');
  }, 10000);
});

client.login(process.env.DISCORD_TOKEN)
  .catch(e => { console.error('Login:', e); process.exit(1); });
