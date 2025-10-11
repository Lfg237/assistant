// server.js
// Node >=18 recommandé (fetch natif). Utilise ES modules.
import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(express.json({ limit: '200kb' })); // limiter la taille utile

// --- Config Supabase (SERVICE ROLE key) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY){
  console.error('ERREUR: Variables d\'environnement Supabase manquantes.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// --- helper: récupérer IP client (X-Forwarded-For support) ---
function getClientIp(req){
  const xff = req.headers['x-forwarded-for'];
  if(xff && typeof xff === 'string') return xff.split(',')[0].trim();
  // fallback
  return req.socket?.remoteAddress || null;
}

/* =================
   Endpoints
   ================= */

/**
 * Créer / mettre à jour un user (utilisé par le client lors de l'inscription)
 * Body: { id?: uuid, username?: string, phone?: string }
 * Si id fourni, met à jour; sinon insère et renvoie id
 */
app.post('/users', async (req, res) => {
  try {
    const { id, username, phone } = req.body;
    if(id){
      const { error } = await supabase.from('users').update({ username, phone }).eq('id', id);
      if(error) throw error;
      return res.json({ ok: true, id });
    } else {
      const { data, error } = await supabase.from('users').insert([{ username, phone }]).select().single();
      if(error) throw error;
      return res.json({ ok:true, id: data.id, user: data });
    }
  } catch(e){
    console.error('POST /users error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * Consentement : enregistre le consentement horodaté
 * Body: { user_id: uuid, consent_text: string }
 */
app.post('/consent', async (req, res) => {
  try {
    const { user_id, consent_text } = req.body;
    if(!user_id || !consent_text) return res.status(400).json({ ok:false, error: 'user_id et consent_text requis' });

    const { error } = await supabase.from('consent_logs').insert([{ user_id, consent_text, given: true }]);
    if(error) throw error;
    return res.json({ ok:true });
  } catch(e){
    console.error('POST /consent error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * Report location (GPS envoyé par le client)
 * Body: { user_id: uuid, latitude: number, longitude: number, accuracy?: number }
 * Le serveur récupère l'IP via getClientIp(req) et stocke la ligne
 */
app.post('/report-location', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const { user_id, latitude, longitude, accuracy } = req.body;
    if(!user_id || typeof latitude !== 'number' || typeof longitude !== 'number'){
      return res.status(400).json({ ok:false, error: 'user_id, latitude et longitude requis' });
    }

    const payload = { user_id, latitude, longitude, accuracy: accuracy || null, ip, created_at: new Date() };
    const { error } = await supabase.from('device_locations').insert([payload]);
    if(error) throw error;
    return res.json({ ok:true });
  } catch(e){
    console.error('POST /report-location error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * Report call logs (depuis l'app native si autorisé)
 * Body: { user_id: uuid, calls: [{ number, direction, started_at, duration_seconds }, ...] }
 */
app.post('/report-calls', async (req, res) => {
  try {
    const { user_id, calls } = req.body;
    if(!user_id || !Array.isArray(calls)) return res.status(400).json({ ok:false, error: 'user_id et calls[] requis' });

    const rows = calls.map(c => ({
      user_id,
      number: c.number,
      direction: c.direction || null,
      started_at: c.started_at ? new Date(c.started_at) : null,
      duration_seconds: c.duration_seconds || null,
      created_at: new Date()
    }));

    const { error } = await supabase.from('call_logs').insert(rows);
    if(error) throw error;
    return res.json({ ok:true, inserted: rows.length });
  } catch(e){
    console.error('POST /report-calls error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * Report IP -> effectuer géoloc IP via service tiers (ex: ipinfo) et stocker
 * Body: { user_id: uuid }
 * Requiert IPINFO_TOKEN ou équivalent dans env.
 */
app.post('/report-ip', async (req, res) => {
  try {
    const IPINFO_TOKEN = process.env.IPINFO_TOKEN || null;
    if(!IPINFO_TOKEN) return res.status(500).json({ ok:false, error: 'IPINFO_TOKEN non configuré' });

    const user_id = req.body.user_id;
    if(!user_id) return res.status(400).json({ ok:false, error: 'user_id requis' });

    const ip = getClientIp(req);
    // appel ipinfo (ou autre). Remplace par le fournisseur que tu as choisi.
    const resp = await fetch(`https://ipinfo.io/${ip}/json?token=${IPINFO_TOKEN}`);
    const geo = await resp.json();

    const row = {
      user_id,
      ip,
      city: geo.city || null,
      region: geo.region || null,
      country: geo.country || null,
      loc: geo.loc || null,
      provider: geo.org || null,
      created_at: new Date()
    };

    const { error } = await supabase.from('ip_locations').insert([row]);
    if(error) throw error;
    return res.json({ ok:true, geo });
  } catch(e){
    console.error('POST /report-ip error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

/* --- endpoint admin pour listing simple (sécurisé en prod par auth/back-office) --- */
app.get('/admin/users', async (req, res) => {
  try {
    // Ici on renvoie users + last location + last ip (limit 1 each)
    const { data: users } = await supabase.from('users').select('id, username, phone, created_at').order('created_at', { ascending: false }).limit(200);
    // For each user get last location/ip/calls (could be optimized via SQL joins)
    const results = [];
    for(const u of users){
      const [{ data: loc }] = await Promise.all([
        supabase.from('device_locations').select('*').eq('user_id', u.id).order('created_at', { ascending: false }).limit(1),
        supabase.from('ip_locations').select('*').eq('user_id', u.id).order('created_at', { ascending: false }).limit(1)
      ]);
      const { data: calls } = await supabase.from('call_logs').select('*').eq('user_id', u.id).order('started_at', { ascending: false }).limit(10);
      results.push({ user: u, last_location: loc?.[0] || null, last_ip: (await supabase.from('ip_locations').select('*').eq('user_id', u.id).order('created_at',{ascending:false}).limit(1)).data?.[0] || null, calls: calls || [] });
    }
    return res.json({ ok:true, results });
  } catch(e){
    console.error('GET /admin/users error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

/* --- health --- */
app.get('/health', (req, res) => res.json({ ok:true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server listening on ${PORT}`));
