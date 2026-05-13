// utils/logger.js - activity logging
const db = require('../config/db');

async function log(userId, actionType, entityType, entityId, details, req) {
  try {
    const ip = req?.ip || req?.headers?.['x-forwarded-for'] || '0.0.0.0';
    const ua = req?.headers?.['user-agent'] || '';
    await db.execute(
      `INSERT INTO activity_logs (user_id,action_type,entity_type,entity_id,details,ip_address,user_agent)
       VALUES (?,?,?,?,?,?,?)`,
      [userId || null, actionType, entityType || null, entityId || null, details || null, ip, ua]
    );
  } catch (e) {
    console.error('Logger error:', e.message);
  }
}

module.exports = { log };
