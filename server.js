require('dotenv').config({ path: require('path').join(__dirname,'.env') });
const express=require('express');
const cors=require('cors');
const helmet=require('helmet');
const rateLimit=require('express-rate-limit');
const session=require('express-session');
const pgSession=require('connect-pg-simple')(session);
const {Pool}=require('pg');
const bcrypt=require('bcryptjs');
const crypto=require('crypto');
const QRCode=require('qrcode');

const app=express();
const PORT=Number(process.env.PORT||3000);
const FRONTEND_URL=(process.env.FRONTEND_URL||'http://localhost:3000').replace(/\/$/,'');
const isProd=process.env.NODE_ENV==='production';
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:undefined});

if(!process.env.DATABASE_URL) console.warn('DATABASE_URL manquante.');
if(!process.env.SESSION_SECRET) console.warn('SESSION_SECRET manquante.');

const allowedOrigins=new Set([FRONTEND_URL,'http://localhost:3000','http://127.0.0.1:3000','http://localhost:5500','http://127.0.0.1:5500']);
app.set('trust proxy',1);
app.use(helmet({
  crossOriginResourcePolicy:{policy:'cross-origin'},
  contentSecurityPolicy:{
    directives:{
      defaultSrc:["'self'"],
      scriptSrc:["'self'","'unsafe-inline'","'unsafe-eval'",'https://cdn.tailwindcss.com','https://cdnjs.cloudflare.com','https://cdn.jsdelivr.net'],
      scriptSrcAttr:["'unsafe-inline'"],
      styleSrc:["'self'","'unsafe-inline'",'https://cdnjs.cloudflare.com','https://fonts.googleapis.com'],
      fontSrc:["'self'",'https://cdnjs.cloudflare.com','https://fonts.gstatic.com','data:'],
      imgSrc:["'self'",'data:','blob:','https:'],
      connectSrc:["'self'",'https:'],
      frameSrc:["'self'",'https:'],
      objectSrc:["'none'"],
      baseUri:["'self'"],
      formAction:["'self'"]
    }
  }
}));
app.use(cors({origin:(origin,cb)=>{if(!origin||allowedOrigins.has(origin)) return cb(null,true); return cb(new Error('Origin non autorisée'));},credentials:true}));
app.use(rateLimit({windowMs:60*1000,max:180,standardHeaders:true,legacyHeaders:false}));

// Webhook Tchin: x-www-form-urlencoded, avant express.json.
app.post('/api/webhooks/tchin',express.urlencoded({extended:true,limit:'100kb'}),handleTchinWebhook);
app.use(express.json({limit:'5mb'}));
app.use(express.urlencoded({extended:true,limit:'200kb'}));

app.use(session({
  store:new pgSession({pool,tableName:'user_sessions',createTableIfMissing:true}),
  secret:process.env.SESSION_SECRET||'CHANGE_ME_DEV_ONLY',
  resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,secure:isProd,sameSite:isProd?'none':'lax',maxAge:8*60*60*1000}
}));

app.use((req,res,next)=>{
  if(!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  if(req.path==='/api/webhooks/tchin') return next();
  const origin=req.get('origin');
  if(origin && !allowedOrigins.has(origin)) return res.status(403).json({success:false,message:'Origin non autorisée.'});
  next();
});

function requireAdmin(req,res,next){if(req.session?.user?.role!=='ADMIN')return res.status(401).json({success:false,message:'Authentification administrateur requise.'});next();}
function requireOrg(req,res,next){if(req.session?.user?.role!=='ORGANIZER')return res.status(401).json({success:false,message:'Connexion organisateur requise.'});next();}
function asyncRoute(fn){return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
function clean(v,max=255){return String(v??'').trim().slice(0,max);}
function positiveInt(v){const n=Number(v);return Number.isInteger(n)&&n>=0?n:null;}
function fmtRef(){return 'CMD-'+crypto.randomBytes(5).toString('hex').toUpperCase();}
function fmtTicket(){return 'TKT-'+crypto.randomBytes(5).toString('hex').toUpperCase();}
function commissionFor(amount){const rate=amount<5000?0.02:0.05;const admin=Math.round(amount*rate);return {rate:rate*100,admin,organizer:amount-admin};}
function logAction(client,actorType,actorId,action,entityType,entityId,metadata={}){return client.query('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[actorType,String(actorId||''),action,entityType||null,entityId?String(entityId):null,JSON.stringify(metadata)]);}

async function ensureEventImageColumn(){
  if(!process.env.DATABASE_URL) return;
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS image_url TEXT`);
}

async function ensurePromoTables(){
  if(!process.env.DATABASE_URL) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS promo_codes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
    code VARCHAR(60) NOT NULL,
    discount_type VARCHAR(20) NOT NULL CHECK(discount_type IN ('PERCENT','FIXED')),
    discount_value INTEGER NOT NULL CHECK(discount_value > 0),
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    max_uses INTEGER CHECK(max_uses IS NULL OR max_uses > 0),
    max_uses_per_customer INTEGER NOT NULL DEFAULT 1 CHECK(max_uses_per_customer > 0),
    min_amount INTEGER NOT NULL DEFAULT 0 CHECK(min_amount >= 0),
    allowed_ticket_types JSONB NOT NULL DEFAULT '[]'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, code)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS promo_usages (
    id BIGSERIAL PRIMARY KEY,
    promo_id BIGINT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
    order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    customer_email VARCHAR(255) NOT NULL,
    discount_amount INTEGER NOT NULL CHECK(discount_amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','USED','CANCELLED')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at TIMESTAMPTZ,
    UNIQUE(promo_id, order_id)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_promo_codes_org ON promo_codes(org_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_promo_codes_event ON promo_codes(event_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_promo_usages_promo ON promo_usages(promo_id,status)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_promo_usages_customer ON promo_usages(promo_id,customer_email,status)');
}
function promoTypes(v){return Array.isArray(v)?v.map(x=>clean(x,120)).filter(Boolean).slice(0,50):[];}
function normalizePromoCode(v){return clean(v,60).toUpperCase().replace(/\s+/g,'');}
function promoDiscount(promo,baseAmount){
  let discount=promo.discount_type==='PERCENT'?Math.round(baseAmount*Number(promo.discount_value)/100):Number(promo.discount_value);
  discount=Math.max(0,Math.min(discount,baseAmount));
  return discount;
}
async function getValidPromo(client,{orgId,eventId,ticketType,customerEmail,baseAmount,code,lock=false}){
  const sql=`SELECT p.*,e.title AS event_title FROM promo_codes p LEFT JOIN events e ON e.id=p.event_id WHERE p.org_id=$1 AND p.code=$2${lock?' FOR UPDATE OF p':''}`;
  const r=await client.query(sql,[orgId,normalizePromoCode(code)]);
  if(!r.rows.length) throw new Error('Code promo invalide.');
  const p=r.rows[0],now=Date.now();
  if(!p.active) throw new Error('Ce code promo est désactivé.');
  if(p.starts_at && now<new Date(p.starts_at).getTime()) throw new Error('Ce code promo n’est pas encore actif.');
  if(p.ends_at && now>new Date(p.ends_at).getTime()) throw new Error('Ce code promo a expiré.');
  if(p.event_id && Number(p.event_id)!==Number(eventId)) throw new Error('Ce code promo n’est pas valable pour cet événement.');
  const allowed=promoTypes(p.allowed_ticket_types);
  if(allowed.length && !allowed.some(x=>x.toLowerCase()===String(ticketType).toLowerCase())) throw new Error('Ce code promo n’est pas valable pour ce type de billet.');
  if(Number(baseAmount)<Number(p.min_amount||0)) throw new Error(`Montant minimum requis : ${Number(p.min_amount)} FCFA.`);
  const activeReserved=await client.query(`SELECT COUNT(*)::int n FROM promo_usages u JOIN orders o ON o.id=u.order_id WHERE u.promo_id=$1 AND u.status='RESERVED' AND u.reserved_at > NOW()-INTERVAL '30 minutes'`,[p.id]);
  const used=await client.query(`SELECT COUNT(*)::int n FROM promo_usages WHERE promo_id=$1 AND status='USED'`,[p.id]);
  const totalUses=Number(activeReserved.rows[0].n)+Number(used.rows[0].n);
  if(p.max_uses!==null && totalUses>=Number(p.max_uses)) throw new Error('Ce code promo a atteint sa limite d’utilisation.');
  const customerUsed=await client.query(`SELECT COUNT(*)::int n FROM promo_usages WHERE promo_id=$1 AND lower(customer_email)=lower($2) AND status='USED'`,[p.id,customerEmail]);
  const customerReserved=await client.query(`SELECT COUNT(*)::int n FROM promo_usages u JOIN orders o ON o.id=u.order_id WHERE u.promo_id=$1 AND lower(u.customer_email)=lower($2) AND u.status='RESERVED' AND u.reserved_at > NOW()-INTERVAL '30 minutes'`,[p.id,customerEmail]);
  if(Number(customerUsed.rows[0].n)+Number(customerReserved.rows[0].n)>=Number(p.max_uses_per_customer)) throw new Error('Vous avez déjà atteint la limite d’utilisation de ce code promo.');
  const discount=promoDiscount(p,Number(baseAmount));
  const total=Number(baseAmount)-discount;
  if(total<100) throw new Error('Le montant final doit être d’au moins 100 FCFA.');
  return {promo:p,discount,total};
}

async function ensureAdminPayoutTable(){
  if(!process.env.DATABASE_URL) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_payouts (
    id BIGSERIAL PRIMARY KEY,
    amount INTEGER NOT NULL CHECK (amount > 0),
    account VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK (status IN ('EN_ATTENTE','PAYE','REFUSE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_payouts_status ON admin_payouts(status)`);
}

app.get('/api/health',(req,res)=>res.json({success:true,service:'ticketora',time:new Date().toISOString()}));

// ---------- AUTH ORGANISATEUR ----------
app.post('/api/organizers/request',asyncRoute(async(req,res)=>{
  const nom=clean(req.body.nom,180),prenom=clean(req.body.prenom,180),email=clean(req.body.email,255).toLowerCase(),phone=clean(req.body.phone,60),password=String(req.body.password||'');
  if(!nom||!email||!password||password.length<8)return res.status(400).json({success:false,message:'Nom, email et mot de passe (8 caractères minimum) sont obligatoires.'});
  const existing=await pool.query('SELECT id,status FROM organizers WHERE email=$1',[email]);
  if(existing.rows.length)return res.status(409).json({success:false,message:`Une demande ou un compte existe déjà avec cet email (${existing.rows[0].status}).`});
  const hash=await bcrypt.hash(password,12);
  await pool.query('INSERT INTO organizers(nom,prenom,email,phone,password_hash) VALUES($1,$2,$3,$4,$5)',[nom,prenom,email,phone,hash]);
  res.status(201).json({success:true,message:'Demande transmise. L’administrateur doit la valider avant la connexion.'});
}));

app.post('/api/organizers/login',asyncRoute(async(req,res)=>{
  const email=clean(req.body.email,255).toLowerCase(),password=String(req.body.password||'');
  const r=await pool.query('SELECT id,nom,prenom,email,phone,status,password_hash FROM organizers WHERE email=$1',[email]);
  if(!r.rows.length)return res.status(401).json({success:false,message:'Identifiants incorrects.'});
  const o=r.rows[0];
  if(o.status!=='VALIDE')return res.status(403).json({success:false,message:o.status==='EN_ATTENTE'?'Votre demande est encore en attente de validation.':'Votre accès organisateur n’est pas actif.'});
  if(!(await bcrypt.compare(password,o.password_hash)))return res.status(401).json({success:false,message:'Identifiants incorrects.'});
  req.session.user={role:'ORGANIZER',id:o.id,email:o.email,name:o.nom};
  res.json({success:true,organizer:{id:o.id,nom:o.nom,prenom:o.prenom,email:o.email,phone:o.phone}});
}));
app.post('/api/organizers/logout',(req,res)=>req.session.destroy(()=>res.json({success:true})));
app.get('/api/organizers/me',requireOrg,asyncRoute(async(req,res)=>{const r=await pool.query('SELECT id,nom,prenom,email,phone,status FROM organizers WHERE id=$1',[req.session.user.id]);if(!r.rows.length)return res.status(401).json({success:false});res.json({success:true,organizer:r.rows[0]});}));
app.post('/api/organizers/password',requireOrg,asyncRoute(async(req,res)=>{const oldP=String(req.body.oldPassword||''),newP=String(req.body.newPassword||'');if(newP.length<8)return res.status(400).json({success:false,message:'Le nouveau mot de passe doit contenir au moins 8 caractères.'});const r=await pool.query('SELECT password_hash FROM organizers WHERE id=$1',[req.session.user.id]);if(!r.rows.length||!(await bcrypt.compare(oldP,r.rows[0].password_hash)))return res.status(401).json({success:false,message:'Ancien mot de passe incorrect.'});const hash=await bcrypt.hash(newP,12);await pool.query('UPDATE organizers SET password_hash=$1,updated_at=NOW() WHERE id=$2',[hash,req.session.user.id]);res.json({success:true,message:'Mot de passe modifié avec succès.'});}));

// ---------- EVENEMENTS ----------
function normalizeCats(cats){if(!Array.isArray(cats))return [];return cats.map((c,i)=>({id:clean(c.id||('CAT-'+crypto.randomBytes(3).toString('hex').toUpperCase()),60),name:clean(c.name||'Standard',120),price:positiveInt(c.price)||0,total_stock:positiveInt(c.total_stock)||0})).filter(c=>c.name);}
app.get('/api/events',asyncRoute(async(req,res)=>{const r=await pool.query(`SELECT e.*,COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.event_id=e.id),0)::int sold_count FROM events e WHERE e.status='PUBLIE' ORDER BY e.date ASC,e.id DESC`);res.json({success:true,events:r.rows});}));
app.get('/api/organizers/events',requireOrg,asyncRoute(async(req,res)=>{const r=await pool.query('SELECT e.*,COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.event_id=e.id),0)::int sold_count FROM events e WHERE e.org_id=$1 ORDER BY e.id DESC',[req.session.user.id]);res.json({success:true,events:r.rows});}));
app.post('/api/organizers/events',requireOrg,asyncRoute(async(req,res)=>{
  const {title,category,date,location,description,price,capacity,ticketCategories,imageUrl}=req.body;const p=positiveInt(price),cap=positiveInt(capacity),cats=normalizeCats(ticketCategories);if(!clean(title)||!date||!clean(location)||p===null||cap===null||!cats.length)return res.status(400).json({success:false,message:'Informations événement/catégories incomplètes.'});
  const primary=cats[0]?.price??p;const image=clean(imageUrl,1800000);if(image && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(image))return res.status(400).json({success:false,message:'Affiche invalide.'});const r=await pool.query(`INSERT INTO events(org_id,title,category,date,location,description,price,capacity,status,ticket_categories,image_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'EN_ATTENTE',$9::jsonb,$10) RETURNING *`,[req.session.user.id,clean(title),clean(category||'Concert',100),date,clean(location),clean(description,3000),primary,cap,JSON.stringify(cats),image||null]);res.status(201).json({success:true,event:r.rows[0],message:'Événement enregistré. Il attend la validation administrateur.'});
}));
app.put('/api/organizers/events/:id',requireOrg,asyncRoute(async(req,res)=>{const {title,category,date,location,description,price,capacity,ticketCategories}=req.body;const p=positiveInt(price),cap=positiveInt(capacity),cats=normalizeCats(ticketCategories);if(p===null||cap===null||!cats.length)return res.status(400).json({success:false,message:'Données invalides.'});const r=await pool.query(`UPDATE events SET title=$1,category=$2,date=$3,location=$4,description=$5,price=$6,capacity=$7,ticket_categories=$8::jsonb,image_url=$9,updated_at=NOW(),status=CASE WHEN status='PUBLIE' THEN 'EN_ATTENTE' ELSE status END WHERE id=$10 AND org_id=$11 RETURNING *`,[clean(title),clean(category||'Concert',100),date,clean(location),clean(description,3000),p,cap,JSON.stringify(cats),clean(req.body.imageUrl,1800000)||null,req.params.id,req.session.user.id]);if(!r.rows.length)return res.status(404).json({success:false,message:'Événement introuvable.'});res.json({success:true,event:r.rows[0]});}));

// ---------- ADMIN ----------
app.post('/api/admin/login',asyncRoute(async(req,res)=>{const email=clean(req.body.email,255).toLowerCase(),password=String(req.body.password||'');const expected=clean(process.env.ADMIN_EMAIL||'ticketora2026@gmail.com',255).toLowerCase();if(email!==expected||!process.env.ADMIN_PASSWORD||password!==process.env.ADMIN_PASSWORD)return res.status(401).json({success:false,message:'Identifiants administrateur incorrects.'});req.session.user={role:'ADMIN',email};res.json({success:true});}));
app.post('/api/admin/logout',(req,res)=>req.session.destroy(()=>res.json({success:true})));
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({success:true,user:{email:req.session.user.email,role:'ADMIN'}}));
app.get('/api/admin/organizers',requireAdmin,asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT o.id,o.nom,o.prenom,o.email,o.phone,o.status,o.created_at,
    COUNT(DISTINCT e.id)::int AS event_count, COUNT(DISTINCT t.id)::int AS tickets_sold,
    COALESCE(SUM(t.organizer_amount),0)::int AS revenue
    FROM organizers o LEFT JOIN events e ON e.org_id=o.id LEFT JOIN tickets t ON t.org_id=o.id
    GROUP BY o.id ORDER BY CASE WHEN o.status='EN_ATTENTE' THEN 0 WHEN o.status='VALIDE' THEN 1 ELSE 2 END,o.created_at DESC`);
  res.json({success:true,organizers:r.rows});
}));
app.post('/api/admin/organizers/:id/approve',requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query("UPDATE organizers SET status='VALIDE',updated_at=NOW() WHERE id=$1 RETURNING id,status",[req.params.id]);if(!r.rows.length)return res.status(404).json({success:false});res.json({success:true,organizer:r.rows[0]});}));
app.post('/api/admin/organizers/:id/reject',requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query("UPDATE organizers SET status='REFUSE',updated_at=NOW() WHERE id=$1 RETURNING id,status",[req.params.id]);if(!r.rows.length)return res.status(404).json({success:false});res.json({success:true});}));
app.delete('/api/admin/organizers/:id',requireAdmin,asyncRoute(async(req,res)=>{await pool.query('DELETE FROM organizers WHERE id=$1',[req.params.id]);res.json({success:true});}));
app.get('/api/admin/events',requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query(`SELECT e.*,o.nom AS organizer_name,COALESCE((SELECT COUNT(*) FROM tickets t WHERE t.event_id=e.id),0)::int sold_count FROM events e LEFT JOIN organizers o ON o.id=e.org_id ORDER BY e.id DESC`);res.json({success:true,events:r.rows});}));
app.post('/api/admin/events',requireAdmin,asyncRoute(async(req,res)=>{
  const {title,category,date,price,capacity,imageUrl}=req.body;const p=positiveInt(price),cap=positiveInt(capacity);
  if(!clean(title)||!date||p===null||cap===null)return res.status(400).json({success:false,message:'Données invalides.'});
  const image=clean(imageUrl,1800000);if(image && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(image))return res.status(400).json({success:false,message:'Affiche invalide.'});
  const cats=[{id:'CAT-DEFAULT',name:'Standard',price:p,total_stock:cap}];
  const r=await pool.query(`INSERT INTO events(title,category,date,location,description,price,capacity,status,ticket_categories,image_url) VALUES($1,$2,$3,'','',$4,$5,'PUBLIE',$6::jsonb,$7) RETURNING *`,[clean(title),clean(category||'Concert',100),date,p,cap,JSON.stringify(cats),image||null]);
  res.status(201).json({success:true,event:r.rows[0]});
}));
app.post('/api/admin/events/:id/status',requireAdmin,asyncRoute(async(req,res)=>{const status=clean(req.body.status,20);if(!['PUBLIE','REFUSE','EN_ATTENTE','BROUILLON'].includes(status))return res.status(400).json({success:false});const r=await pool.query('UPDATE events SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *',[status,req.params.id]);if(!r.rows.length)return res.status(404).json({success:false});res.json({success:true,event:r.rows[0]});}));
app.delete('/api/admin/events/:id',requireAdmin,asyncRoute(async(req,res)=>{const sold=await pool.query('SELECT COUNT(*)::int AS n FROM tickets WHERE event_id=$1',[req.params.id]);const orders=await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE event_id=$1',[req.params.id]);if(Number(sold.rows[0].n)>0||Number(orders.rows[0].n)>0)return res.status(400).json({success:false,message:'Impossible de supprimer cet événement : des achats ou billets sont déjà liés à cet événement.'});const r=await pool.query('DELETE FROM events WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rows.length)return res.status(404).json({success:false,message:'Événement introuvable.'});res.json({success:true});}));

// ---------- PAIEMENT TCHIN ----------
async function tchinRequest(path,options={}){const base=(process.env.TCHIN_BASE_URL||'https://tchin.tech/api/v1').replace(/\/$/,'');const r=await fetch(base+path,{...options,headers:{Accept:'application/json','Content-Type':'application/json','TCHIN-PUBLIC-KEY':process.env.TCHIN_PUBLIC_KEY||'','TCHIN-PRIVATE-KEY':process.env.TCHIN_PRIVATE_KEY||'',...(options.headers||{})}});let data={};try{data=await r.json();}catch{}if(!r.ok)throw new Error(data?.message||`Tchin HTTP ${r.status}`);return data;}
app.post('/api/promos/validate',asyncRoute(async(req,res)=>{
  const eventId=Number(req.body.eventId),ticketType=clean(req.body.ticketType,120),email=clean(req.body.email,255).toLowerCase(),code=normalizePromoCode(req.body.code),baseAmount=Number(req.body.baseAmount);
  if(!Number.isInteger(eventId)||!ticketType||!email||!code||!Number.isInteger(baseAmount)||baseAmount<0)return res.status(400).json({success:false,message:'Informations du code promo incomplètes.'});
  const ev=await pool.query("SELECT id,org_id FROM events WHERE id=$1 AND status='PUBLIE'",[eventId]);
  if(!ev.rows.length)return res.status(404).json({success:false,message:'Événement indisponible.'});
  const c=await pool.connect();try{const x=await getValidPromo(c,{orgId:ev.rows[0].org_id,eventId,ticketType,customerEmail:email,baseAmount,code});res.json({success:true,code:x.promo.code,discount:x.discount,total:x.total,discountType:x.promo.discount_type,discountValue:x.promo.discount_value});}catch(e){res.status(400).json({success:false,message:e.message});}finally{c.release();}
}));

app.get('/api/organizers/promos',requireOrg,asyncRoute(async(req,res)=>{
  await ensurePromoTables();
  const r=await pool.query(`SELECT p.*,e.title AS event_title,
    COALESCE((SELECT COUNT(*) FROM promo_usages u WHERE u.promo_id=p.id AND u.status='USED'),0)::int AS used_count,
    COALESCE((SELECT SUM(u.discount_amount) FROM promo_usages u WHERE u.promo_id=p.id AND u.status='USED'),0)::int AS discount_total
    FROM promo_codes p LEFT JOIN events e ON e.id=p.event_id WHERE p.org_id=$1 ORDER BY p.id DESC`,[req.session.user.id]);
  res.json({success:true,promos:r.rows});
}));
app.post('/api/organizers/promos',requireOrg,asyncRoute(async(req,res)=>{
  await ensurePromoTables();
  const code=normalizePromoCode(req.body.code),type=clean(req.body.discountType,20).toUpperCase(),value=positiveInt(req.body.discountValue),eventId=req.body.eventId?Number(req.body.eventId):null,minAmount=positiveInt(req.body.minAmount)||0,maxUses=req.body.maxUses?positiveInt(req.body.maxUses):null,maxPerCustomer=positiveInt(req.body.maxUsesPerCustomer)||1,allowed=promoTypes(req.body.allowedTicketTypes),startsAt=req.body.startsAt||null,endsAt=req.body.endsAt||null;
  if(!/^[A-Z0-9_-]{3,60}$/.test(code))return res.status(400).json({success:false,message:'Code invalide : 3 à 60 caractères, lettres/chiffres/_/- uniquement.'});
  if(!['PERCENT','FIXED'].includes(type)||!value)return res.status(400).json({success:false,message:'Type ou valeur de réduction invalide.'});
  if(type==='PERCENT'&&value>100)return res.status(400).json({success:false,message:'Une réduction en pourcentage ne peut pas dépasser 100%.'});
  if(eventId!==null&&!Number.isInteger(eventId))return res.status(400).json({success:false,message:'Événement invalide.'});
  if(startsAt&&endsAt&&new Date(startsAt)>=new Date(endsAt))return res.status(400).json({success:false,message:'La date de fin doit être après la date de début.'});
  const c=await pool.connect();try{await c.query('BEGIN');if(eventId!==null){const er=await c.query('SELECT id FROM events WHERE id=$1 AND org_id=$2',[eventId,req.session.user.id]);if(!er.rows.length)throw new Error('Événement introuvable.');}const r=await c.query(`INSERT INTO promo_codes(org_id,event_id,code,discount_type,discount_value,starts_at,ends_at,max_uses,max_uses_per_customer,min_amount,allowed_ticket_types) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,[req.session.user.id,eventId,code,type,value,startsAt||null,endsAt||null,maxUses,maxPerCustomer,minAmount,JSON.stringify(allowed)]);await logAction(c,'ORGANIZER',req.session.user.id,'PROMO_CREATED','promo_code',r.rows[0].id,{code,event_id:eventId});await c.query('COMMIT');res.status(201).json({success:true,promo:r.rows[0],message:'Code promo créé avec succès.'});}catch(e){try{await c.query('ROLLBACK')}catch{};res.status(e.code==='23505'?409:400).json({success:false,message:e.code==='23505'?'Ce code promo existe déjà.':e.message});}finally{c.release();}
}));
app.post('/api/organizers/promos/:id/toggle',requireOrg,asyncRoute(async(req,res)=>{await ensurePromoTables();const r=await pool.query('UPDATE promo_codes SET active=NOT active,updated_at=NOW() WHERE id=$1 AND org_id=$2 RETURNING *',[req.params.id,req.session.user.id]);if(!r.rows.length)return res.status(404).json({success:false,message:'Code promo introuvable.'});res.json({success:true,promo:r.rows[0]});}));
app.delete('/api/organizers/promos/:id',requireOrg,asyncRoute(async(req,res)=>{await ensurePromoTables();const r=await pool.query(`DELETE FROM promo_codes WHERE id=$1 AND org_id=$2 AND NOT EXISTS (SELECT 1 FROM promo_usages u WHERE u.promo_id=promo_codes.id AND u.status='USED') RETURNING id`,[req.params.id,req.session.user.id]);if(!r.rows.length)return res.status(400).json({success:false,message:'Ce code ne peut pas être supprimé car il a déjà été utilisé.'});res.json({success:true});}));
app.get('/api/organizers/promos/:id/usage',requireOrg,asyncRoute(async(req,res)=>{await ensurePromoTables();const r=await pool.query(`SELECT u.*,o.reference,o.event_id,o.ticket_type,o.base_amount,o.discount_amount AS order_discount,o.total_amount,o.status AS order_status FROM promo_usages u JOIN orders o ON o.id=u.order_id JOIN promo_codes p ON p.id=u.promo_id WHERE u.promo_id=$1 AND p.org_id=$2 ORDER BY u.id DESC`,[req.params.id,req.session.user.id]);res.json({success:true,usage:r.rows});}));

app.post('/api/payments/create',asyncRoute(async(req,res)=>{
  const eventId=Number(req.body.eventId),name=clean(req.body.name,255),email=clean(req.body.email,255).toLowerCase(),ticketType=clean(req.body.ticketType,120),promo=normalizePromoCode(req.body.promo);if(!Number.isInteger(eventId)||!name||!email||!ticketType)return res.status(400).json({success:false,message:'Informations d’achat incomplètes.'});
  const c=await pool.connect();try{await c.query('BEGIN');const er=await c.query("SELECT * FROM events WHERE id=$1 AND status='PUBLIE' FOR UPDATE",[eventId]);if(!er.rows.length)throw new Error('Événement indisponible.');const ev=er.rows[0];let cats=Array.isArray(ev.ticket_categories)?ev.ticket_categories:[];if(typeof ev.ticket_categories==='string')cats=JSON.parse(ev.ticket_categories);const cat=cats.find(x=>String(x.name).toLowerCase()===ticketType.toLowerCase());if(!cat)throw new Error('Type de billet indisponible.');const baseAmount=Number(cat.price||0);let discount=0,total=baseAmount,promoRow=null;if(promo){const x=await getValidPromo(c,{orgId:ev.org_id,eventId,ticketType,customerEmail:email,baseAmount,code:promo,lock:true});discount=x.discount;total=x.total;promoRow=x.promo;}if(total<100)throw new Error('Montant du billet trop faible pour le paiement.');const sold=await c.query('SELECT COUNT(*)::int n FROM tickets WHERE event_id=$1',[eventId]);if(Number(ev.capacity)>0&&sold.rows[0].n>=Number(ev.capacity))throw new Error('Événement complet.');const ref=fmtRef();const ord=await c.query('INSERT INTO orders(reference,event_id,ticket_type,customer_name,customer_email,base_amount,discount_amount,total_amount,promo_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[ref,eventId,ticketType,name,email,baseAmount,discount,total,promo]);if(promoRow){await c.query('INSERT INTO promo_usages(promo_id,order_id,customer_email,discount_amount) VALUES($1,$2,$3,$4)',[promoRow.id,ord.rows[0].id,email,discount]);}await c.query('COMMIT');
    const returnUrl=process.env.TCHIN_RETURN_URL||`${FRONTEND_URL}/?payment=return`;const cancelUrl=process.env.TCHIN_CANCEL_URL||`${FRONTEND_URL}/?payment=cancel`;const callback=process.env.TCHIN_CALLBACK_URL||`${req.protocol}://${req.get('host')}/api/webhooks/tchin`;
    try{const td=await tchinRequest('/payments',{method:'POST',body:JSON.stringify({amount:total,description:`Ticketora ${ref} - ${ev.title}`,env:process.env.TCHIN_ENV||'test',return_url:returnUrl,cancel_url:cancelUrl,callback_url:callback,fees_on_customer:false})});await pool.query('UPDATE orders SET tchin_token=$1,tchin_status=\'pending\' WHERE reference=$2',[td.token,ref]);res.json({success:true,reference:ref,token:td.token,payment_url:td.payment_url,amount:total,baseAmount,discount,promoCode:promo||null});}catch(e){await pool.query("UPDATE promo_usages SET status='CANCELLED' WHERE order_id=(SELECT id FROM orders WHERE reference=$1)",[ref]);await pool.query("UPDATE orders SET status='FAILED' WHERE reference=$1",[ref]);throw e;}
  }catch(e){try{await c.query('ROLLBACK')}catch{};res.status(400).json({success:false,message:e.message});}finally{c.release();}
}));
async function fulfillOrder(orderId,sourceData={}){
  const c=await pool.connect();try{await c.query('BEGIN');const or=await c.query('SELECT o.*,e.title event_title,e.date event_date,e.location event_location,e.org_id,e.capacity FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1 FOR UPDATE',[orderId]);if(!or.rows.length)throw new Error('Commande introuvable.');const o=or.rows[0];if(o.status==='PAID'){const tr=await c.query('SELECT * FROM tickets WHERE order_id=$1',[orderId]);await c.query('COMMIT');return tr.rows[0]||null;}const expected=Number(o.total_amount);const received=Number(sourceData.amount??expected);if(received!==expected)throw new Error('Montant de paiement différent du montant attendu.');if(sourceData.mode&&sourceData.mode!==(process.env.TCHIN_ENV||'test'))throw new Error('Mode de paiement non conforme.');if((process.env.TCHIN_ENV||'test')==='test')throw new Error('Paiement de test : aucun billet réel ne doit être délivré.');const sold=await c.query('SELECT COUNT(*)::int n FROM tickets WHERE event_id=$1',[o.event_id]);if(Number(o.capacity)>0&&sold.rows[0].n>=Number(o.capacity))throw new Error('Événement complet au moment de la confirmation.');const split=commissionFor(expected);let code;for(let i=0;i<8;i++){const candidate=fmtTicket();const exists=await c.query('SELECT 1 FROM tickets WHERE code=$1',[candidate]);if(!exists.rows.length){code=candidate;break;}}if(!code)throw new Error('Impossible de générer une référence billet unique.');const tr=await c.query(`INSERT INTO tickets(order_id,code,event_id,org_id,event_title,event_date,event_location,ticket_type,customer_name,customer_email,total_amount,admin_commission,organizer_amount,commission_rate) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[o.id,code,o.event_id,o.org_id,o.event_title,o.event_date,o.event_location,o.ticket_type,o.customer_name,o.customer_email,expected,split.admin,split.organizer,split.rate]);await c.query("UPDATE orders SET status='PAID',paid_at=NOW(),tchin_status='completed',tchin_reference=COALESCE($1,tchin_reference),tchin_mode=COALESCE($2,tchin_mode) WHERE id=$3",[sourceData.reference||null,sourceData.mode||null,o.id]);await c.query("UPDATE promo_usages SET status='USED',used_at=NOW() WHERE order_id=$1 AND status='RESERVED'",[o.id]);await logAction(c,'SYSTEM','TCHIN','TICKET_ISSUED','ticket',tr.rows[0].id,{order_id:o.id,reference:o.reference});await c.query('COMMIT');return tr.rows[0];}catch(e){try{await c.query('ROLLBACK')}catch{};throw e}finally{c.release();}}

function pickWebhook(req){const b=req.body||{};const d=b.data||{};const get=k=>d[k]??b[`data[${k}]`]??b[k];return {status:get('status'),reference:get('reference'),token:get('token'),amount:get('amount'),fee:get('fee'),net:get('net'),mode:get('mode'),timestamp:get('timestamp'),signature:get('signature'),customer:get('customer'),method:get('method')};}
function validTchinSignature(p){const ts=String(p.timestamp||'');if(!/^\d+$/.test(ts))return false;const ms=Number(ts);const now=Date.now();const stamp=ms<1e12?ms*1000:ms;if(Math.abs(now-stamp)>5*60*1000)return false;const raw=[p.timestamp,p.reference,p.token,p.status,p.amount,p.net,p.mode].map(x=>String(x??'')).join('.');const expected=crypto.createHmac('sha256',process.env.TCHIN_PRIVATE_KEY||'').update(raw).digest('hex');const a=Buffer.from(expected,'utf8'),b=Buffer.from(String(p.signature||''),'utf8');return a.length===b.length&&crypto.timingSafeEqual(a,b);}
async function handleTchinWebhook(req,res){const p=pickWebhook(req);if(!process.env.TCHIN_PRIVATE_KEY||!validTchinSignature(p))return res.status(401).send('invalid signature');try{const or=await pool.query('SELECT * FROM orders WHERE tchin_token=$1 OR reference=$2 LIMIT 1',[p.token,p.reference]);if(or.rows.length){const o=or.rows[0];await pool.query('UPDATE orders SET tchin_status=$1,tchin_reference=COALESCE($2,tchin_reference),tchin_mode=COALESCE($3,tchin_mode) WHERE id=$4',[p.status,p.reference,p.mode,o.id]);if(p.status==='completed'){try{await fulfillOrder(o.id,p);}catch(e){console.error('Tchin fulfillment:',e.message);}}else if(['failed','cancelled'].includes(String(p.status))){await pool.query("UPDATE orders SET status=CASE WHEN status='PAID' THEN status ELSE 'CANCELLED' END WHERE id=$1",[o.id]);await pool.query("UPDATE promo_usages SET status='CANCELLED' WHERE order_id=$1 AND status='RESERVED'",[o.id]);}return res.status(200).send('ok');}await ensureCagnotteTables();const cr=await pool.query('SELECT * FROM contributions WHERE tchin_token=$1 OR reference=$2 LIMIT 1',[p.token,p.reference]);if(!cr.rows.length)return res.status(200).send('ignored');const c=cr.rows[0];await pool.query('UPDATE contributions SET tchin_status=$1,tchin_reference=COALESCE($2,tchin_reference),tchin_mode=COALESCE($3,tchin_mode) WHERE id=$4',[p.status,p.reference,p.mode,c.id]);if(p.status==='completed'){if(String(process.env.TCHIN_ENV||'test')==='test')return res.status(200).send('ok');const received=Number(p.amount);if(received!==Number(c.amount))return res.status(400).send('amount mismatch');const u=await pool.query("UPDATE contributions SET status='PAYE',paid_at=NOW() WHERE id=$1 AND status<>'PAYE' RETURNING cagnotte_id,amount",[c.id]);if(u.rows.length)await pool.query('UPDATE cagnottes SET total_amount=total_amount+$1,updated_at=NOW() WHERE id=$2',[u.rows[0].amount,u.rows[0].cagnotte_id]);}else if(['failed','cancelled'].includes(String(p.status))){await pool.query("UPDATE contributions SET status='ANNULE' WHERE id=$1 AND status<>'PAYE'",[c.id]);}return res.status(200).send('ok');}catch(e){console.error(e);return res.status(500).send('retry');}}

app.get('/api/payments/:token/status',asyncRoute(async(req,res)=>{const token=clean(req.params.token,255);const or=await pool.query('SELECT o.*,e.title event_title FROM orders o JOIN events e ON e.id=o.event_id WHERE o.tchin_token=$1',[token]);if(!or.rows.length)return res.status(404).json({success:false,message:'Transaction introuvable.'});let o=or.rows[0];let td=await tchinRequest(`/payments/${encodeURIComponent(token)}/status`,{method:'GET',headers:{'Content-Type':'application/json'}});const status=td.status||td.data?.status||'pending';if(status==='completed'&&o.status!=='PAID'){try{const ticket=await fulfillOrder(o.id,{amount:td.amount??o.total_amount,mode:td.mode||process.env.TCHIN_ENV,reference:td.reference||null});o=(await pool.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];return res.json({success:true,status:'completed',paid:true,ticket:ticket?{code:ticket.code,event_title:ticket.event_title,event_date:ticket.event_date,event_location:ticket.event_location,ticket_type:ticket.ticket_type,customer_name:ticket.customer_name,customer_email:ticket.customer_email}:null});}catch(e){return res.json({success:true,status:'completed',paid:false,message:e.message});}}const tr=await pool.query('SELECT code,event_title,event_date,event_location,ticket_type,customer_name,customer_email FROM tickets WHERE order_id=$1',[o.id]);res.json({success:true,status:o.status==='PAID'?'completed':status,paid:o.status==='PAID',ticket:tr.rows[0]||null});}));

// ---------- BILLETS ----------
app.get('/api/tickets/verify/:code',asyncRoute(async(req,res)=>{const code=clean(req.params.code,32).toUpperCase();const r=await pool.query('SELECT code,event_title,event_date,event_location,ticket_type,customer_name,used,used_at FROM tickets WHERE UPPER(code)=UPPER($1)',[code]);if(!r.rows.length)return res.status(404).json({success:false,status:'INVALID',message:'BILLET NON VALIDE'});const t=r.rows[0];res.json({success:true,status:t.used?'USED':'VALID',message:t.used?'BILLET DÉJÀ UTILISÉ':'BILLET VALIDE',ticket:t});}));
async function scanTicket(code,orgId){const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query('SELECT t.*,e.title event_title,e.date event_date,e.location event_location FROM tickets t JOIN events e ON e.id=t.event_id WHERE UPPER(t.code)=UPPER($1) FOR UPDATE',[code]);if(!r.rows.length){await c.query('ROLLBACK');return {http:404,data:{success:false,status:'INVALID',message:'BILLET NON VALIDE'}};}const t=r.rows[0];if(String(t.org_id)!==String(orgId)){await c.query('ROLLBACK');return {http:403,data:{success:false,status:'INVALID',message:'Ce billet ne correspond pas à cet organisateur.'}};}if(t.used){await c.query('ROLLBACK');return {http:409,data:{success:false,status:'USED',message:'BILLET DÉJÀ UTILISÉ',ticket:t}};}const u=await c.query('UPDATE tickets SET used=true,used_at=NOW(),scan_count=scan_count+1 WHERE id=$1 RETURNING *',[t.id]);await c.query('COMMIT');return {http:200,data:{success:true,status:'VALID',message:'ENTRÉE AUTORISÉE',ticket:u.rows[0]}};}catch(e){try{await c.query('ROLLBACK')}catch{};throw e}finally{c.release();}}
app.post('/api/tickets/scan',requireOrg,asyncRoute(async(req,res)=>{const code=clean(req.body.code,32).toUpperCase();if(!code)return res.status(400).json({success:false,message:'Code requis.'});const x=await scanTicket(code,req.session.user.id);res.status(x.http).json(x.data);}));
app.post('/api/admin/tickets/scan',requireAdmin,asyncRoute(async(req,res)=>{const code=clean(req.body.code,32).toUpperCase();if(!code)return res.status(400).json({success:false,message:'Code requis.'});const r=await pool.query('SELECT * FROM tickets WHERE UPPER(code)=UPPER($1)',[code]);if(!r.rows.length)return res.status(404).json({success:false,status:'INVALID',message:'BILLET NON VALIDE'});const t=r.rows[0];if(t.used)return res.status(409).json({success:false,status:'USED',message:'BILLET DÉJÀ UTILISÉ',ticket:t});const c=await pool.connect();try{await c.query('BEGIN');const u=await c.query('UPDATE tickets SET used=true,used_at=NOW(),scan_count=scan_count+1 WHERE id=$1 AND used=false RETURNING *',[t.id]);await c.query('COMMIT');if(!u.rows.length)return res.status(409).json({success:false,status:'USED',message:'BILLET DÉJÀ UTILISÉ'});res.json({success:true,status:'VALID',message:'ENTRÉE AUTORISÉE',ticket:u.rows[0]});}finally{c.release();}}));


// ---------- TCHIN PAYOUTS / DECAISSEMENTS ----------
async function ensurePayoutTchinColumns(){
  if(!process.env.DATABASE_URL) return;
  await pool.query(`
    ALTER TABLE payouts
      ADD COLUMN IF NOT EXISTS withdraw_mode VARCHAR(80),
      ADD COLUMN IF NOT EXISTS tchin_disburse_token VARCHAR(255),
      ADD COLUMN IF NOT EXISTS tchin_transaction_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS tchin_status VARCHAR(30),
      ADD COLUMN IF NOT EXISTS tchin_fee INTEGER,
      ADD COLUMN IF NOT EXISTS tchin_debited INTEGER,
      ADD COLUMN IF NOT EXISTS tchin_error TEXT,
      ADD COLUMN IF NOT EXISTS tchin_updated_at TIMESTAMPTZ
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_tchin_disburse_token ON payouts(tchin_disburse_token) WHERE tchin_disburse_token IS NOT NULL');
}
function normalizePayoutAccount(value){
  const digits=String(value||'').replace(/\D/g,'');
  if(digits.startsWith('228') && digits.length===11) return digits.slice(3);
  return digits;
}
function payoutTchinMode(value){
  const mode=clean(value,80);
  const allowed=['t-money-togo','moov-togo','orange-money-senegal','free-money-senegal','expresso-senegal','wave-senegal','wizall-senegal','djamo-senegal','orange-money-ci','mtn-ci','moov-ci','wave-ci','djamo-ci','moov-benin','mtn-benin','celtiis-benin','orange-money-burkina','moov-burkina','orange-money-mali','moov-mali','mtn-cameroun'];
  return allowed.includes(mode)?mode:'';
}
async function syncTchinPayout(payout){
  if(!payout?.tchin_disburse_token) return payout;
  try{
    const td=await tchinRequest('/disburse/status',{
      method:'POST',
      body:JSON.stringify({disburse_token:payout.tchin_disburse_token})
    });
    const status=String(td.status||td.data?.status||'').toLowerCase();
    const tx=td.transaction_id||td.data?.transaction_id||null;
    if(['success','completed','successful'].includes(status)){
      const r=await pool.query(
        `UPDATE payouts SET status='PAYE',tchin_status='success',tchin_transaction_id=COALESCE($1,tchin_transaction_id),tchin_error=NULL,tchin_updated_at=NOW(),processed_at=COALESCE(processed_at,NOW()) WHERE id=$2 RETURNING *`,
        [tx,payout.id]
      );
      return r.rows[0]||payout;
    }
    if(['failed','cancelled','canceled','error','rejected'].includes(status)){
      const msg=td.message||td.data?.message||'Le décaissement Tchin a échoué.';
      const r=await pool.query(
        `UPDATE payouts SET status='REFUSE',tchin_status=$1,tchin_error=$2,tchin_updated_at=NOW() WHERE id=$3 RETURNING *`,
        [status,msg,payout.id]
      );
      return r.rows[0]||payout;
    }
    if(status){
      const r=await pool.query(`UPDATE payouts SET tchin_status=$1,tchin_updated_at=NOW() WHERE id=$2 RETURNING *`,[status,payout.id]);
      return r.rows[0]||payout;
    }
  }catch(e){
    console.error('Tchin payout status:',e.message);
  }
  return payout;
}
async function syncPendingTchinPayouts(){
  if(!process.env.TCHIN_PRIVATE_KEY || !process.env.TCHIN_PUBLIC_KEY) return;
  try{
    const r=await pool.query("SELECT * FROM payouts WHERE status='VALIDE' AND tchin_disburse_token IS NOT NULL ORDER BY id ASC LIMIT 25");
    for(const payout of r.rows) await syncTchinPayout(payout);
  }catch(e){console.error('Tchin pending payouts:',e.message);}
}

// ---------- STATS / PAYOUTS ----------
app.get('/api/organizers/stats',requireOrg,asyncRoute(async(req,res)=>{const id=req.session.user.id;const [e,t,p]=await Promise.all([pool.query('SELECT * FROM events WHERE org_id=$1 ORDER BY id DESC',[id]),pool.query('SELECT * FROM tickets WHERE org_id=$1 ORDER BY id DESC',[id]),pool.query('SELECT * FROM payouts WHERE org_id=$1 ORDER BY id DESC',[id])]);const net=t.rows.reduce((s,x)=>s+Number(x.organizer_amount||0),0);res.json({success:true,events:e.rows,tickets:t.rows,payouts:p.rows,netRevenue:net});}));
app.delete('/api/organizers/events/:id',requireOrg,asyncRoute(async(req,res)=>{const sold=await pool.query('SELECT COUNT(*)::int AS n FROM tickets WHERE event_id=$1',[req.params.id]);const orders=await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE event_id=$1',[req.params.id]);if(Number(sold.rows[0].n)>0||Number(orders.rows[0].n)>0)return res.status(400).json({success:false,message:'Impossible de supprimer cet événement : des achats ou billets sont déjà liés à cet événement.'});const r=await pool.query('DELETE FROM events WHERE id=$1 AND org_id=$2 RETURNING id',[req.params.id,req.session.user.id]);if(!r.rows.length)return res.status(404).json({success:false,message:'Événement introuvable.'});res.json({success:true});}));
app.post('/api/payouts',requireOrg,asyncRoute(async(req,res)=>{
  const amount=positiveInt(req.body.amount),account=normalizePayoutAccount(req.body.account),withdrawMode=payoutTchinMode(req.body.withdrawMode);
  if(!amount||!account||!withdrawMode)return res.status(400).json({success:false,message:'Montant, numéro Mobile Money et opérateur Tchin obligatoires.'});
  if(amount<200)return res.status(400).json({success:false,message:'Le retrait minimum est de 200 FCFA.'});
  const bal=await pool.query(`SELECT COALESCE((SELECT SUM(organizer_amount) FROM tickets WHERE org_id=$1),0)-COALESCE((SELECT SUM(amount) FROM payouts WHERE org_id=$1 AND status IN ('EN_ATTENTE','VALIDE','PAYE')),0) AS available`,[req.session.user.id]);
  const available=Number(bal.rows[0].available||0);
  if(amount>available)return res.status(400).json({success:false,message:`Solde disponible insuffisant. Disponible : ${available} FCFA.`});
  const r=await pool.query('INSERT INTO payouts(org_id,amount,account,withdraw_mode,tchin_status) VALUES($1,$2,$3,$4,\'pending\') RETURNING *',[req.session.user.id,amount,account,withdrawMode]);
  res.status(201).json({success:true,payout:r.rows[0],available:available-amount});
}));
app.delete('/api/payouts/:id',requireOrg,asyncRoute(async(req,res)=>{const r=await pool.query("DELETE FROM payouts WHERE id=$1 AND org_id=$2 AND status IN ('EN_ATTENTE','REFUSE') RETURNING id",[req.params.id,req.session.user.id]);if(!r.rows.length)return res.status(400).json({success:false,message:'Ce retrait ne peut plus être supprimé.'});res.json({success:true});}));
app.delete('/api/admin/payouts/:id',requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query("DELETE FROM payouts WHERE id=$1 AND status IN ('EN_ATTENTE','REFUSE') RETURNING id",[req.params.id]);if(!r.rows.length)return res.status(400).json({success:false,message:'Ce retrait ne peut plus être supprimé.'});res.json({success:true});}));
app.get('/api/admin/payouts',requireAdmin,asyncRoute(async(req,res)=>{
  await syncPendingTchinPayouts();
  const r=await pool.query(`SELECT p.*,o.nom,o.prenom,o.email,o.phone FROM payouts p JOIN organizers o ON o.id=p.org_id ORDER BY CASE WHEN p.status='EN_ATTENTE' THEN 0 WHEN p.status='VALIDE' THEN 1 ELSE 2 END,p.id DESC`);
  const bal=await pool.query(`SELECT COALESCE(SUM(organizer_amount),0) AS total FROM tickets`);
  res.json({success:true,payouts:r.rows,totalOrganizerRevenue:Number(bal.rows[0].total||0)});
}));
app.post('/api/admin/payouts/:id/status',requireAdmin,asyncRoute(async(req,res)=>{
  const status=clean(req.body.status,20);
  if(!['VALIDE','REFUSE','PAYE'].includes(status))return res.status(400).json({success:false,message:'Statut de retrait invalide.'});
  const current=await pool.query('SELECT p.*,o.nom,o.prenom FROM payouts p JOIN organizers o ON o.id=p.org_id WHERE p.id=$1',[req.params.id]);
  if(!current.rows.length)return res.status(404).json({success:false,message:'Demande de retrait introuvable.'});
  let payout=current.rows[0];
  if(status==='VALIDE' && payout.status!=='EN_ATTENTE')return res.status(400).json({success:false,message:'Cette demande ne peut plus être validée.'});
  if(status==='PAYE' && !['VALIDE','EN_ATTENTE'].includes(payout.status))return res.status(400).json({success:false,message:'Cette demande ne peut pas être payée.'});

  if(status==='REFUSE'){
    const r=await pool.query(`UPDATE payouts SET status='REFUSE',processed_at=NULL,tchin_error=NULL,tchin_updated_at=NOW() WHERE id=$1 RETURNING *`,[payout.id]);
    await logAction(pool,'ADMIN','ADMIN','PAYOUT_REFUSE','payout',payout.id,{organizer_id:payout.org_id,amount:payout.amount});
    return res.json({success:true,payout:r.rows[0]});
  }

  const bal=await pool.query(`SELECT COALESCE((SELECT SUM(organizer_amount) FROM tickets WHERE org_id=$1),0)-COALESCE((SELECT SUM(amount) FROM payouts WHERE org_id=$1 AND id<>$2 AND status IN ('EN_ATTENTE','VALIDE','PAYE')),0) AS available`,[payout.org_id,payout.id]);
  if(Number(payout.amount)>Number(bal.rows[0].available||0))return res.status(400).json({success:false,message:'Solde organisateur insuffisant pour ce retrait.'});

  if(status==='VALIDE'){
    const r=await pool.query(`UPDATE payouts SET status='VALIDE',tchin_status=COALESCE(tchin_status,'pending'),tchin_error=NULL,tchin_updated_at=NOW() WHERE id=$1 RETURNING *`,[payout.id]);
    await logAction(pool,'ADMIN','ADMIN','PAYOUT_VALIDE','payout',payout.id,{organizer_id:payout.org_id,amount:payout.amount});
    return res.json({success:true,payout:r.rows[0],message:'Retrait validé. Il doit maintenant être payé via Tchin.'});
  }

  // PAYE = déclenchement réel du décaissement Tchin.
  if(!process.env.TCHIN_PUBLIC_KEY||!process.env.TCHIN_PRIVATE_KEY)return res.status(503).json({success:false,message:'Tchin n’est pas configuré sur le serveur.'});
  if(!payout.withdraw_mode)return res.status(400).json({success:false,message:'Opérateur Tchin manquant sur cette demande de retrait.'});
  if(payout.tchin_disburse_token)return res.status(409).json({success:false,message:'Un décaissement Tchin existe déjà pour cette demande. Vérifiez son statut.'});

  let init;
  try{
    init=await tchinRequest('/disburse/initiate',{
      method:'POST',
      body:JSON.stringify({
        account_alias:payout.account,
        amount:Number(payout.amount),
        withdraw_mode:payout.withdraw_mode
      })
    });
    if(!init.success||!init.disburse_token)throw new Error(init.message||'Tchin n’a pas préparé le décaissement.');
  }catch(e){
    await pool.query(`UPDATE payouts SET tchin_status='failed',tchin_error=$1,tchin_updated_at=NOW() WHERE id=$2`,[e.message,payout.id]);
    return res.status(400).json({success:false,message:`Tchin : ${e.message}`});
  }

  await pool.query(`UPDATE payouts SET tchin_disburse_token=$1,tchin_fee=$2,tchin_debited=$3,tchin_status='initiated',tchin_error=NULL,tchin_updated_at=NOW(),status='VALIDE' WHERE id=$4`,
    [init.disburse_token,Number(init.fee||0),Number(init.debited||0),payout.id]);

  let submit;
  try{
    submit=await tchinRequest('/disburse/submit',{
      method:'POST',
      body:JSON.stringify({disburse_token:init.disburse_token})
    });
  }catch(e){
    await pool.query(`UPDATE payouts SET tchin_status='failed',tchin_error=$1,tchin_updated_at=NOW() WHERE id=$2`,[e.message,payout.id]);
    return res.status(400).json({success:false,message:`Tchin : ${e.message}`});
  }

  const submitStatus=String(submit.status||'').toLowerCase();
  if(['success','completed','successful'].includes(submitStatus)){
    const updated=await pool.query(`UPDATE payouts SET status='PAYE',tchin_status='success',tchin_transaction_id=$1,tchin_error=NULL,tchin_updated_at=NOW(),processed_at=NOW() WHERE id=$2 RETURNING *`,
      [submit.transaction_id||submit.data?.transaction_id||null,payout.id]);
    await logAction(pool,'ADMIN','ADMIN','PAYOUT_PAYE_TCHIN','payout',payout.id,{organizer_id:payout.org_id,amount:payout.amount,tchin_transaction_id:submit.transaction_id||null});
    return res.json({success:true,payout:updated.rows[0],message:'Retrait envoyé avec succès via Tchin.'});
  }

  // pending: ne jamais resoumettre. Le prochain rafraîchissement vérifie le statut.
  const updated=await pool.query(`UPDATE payouts SET tchin_status='pending',tchin_error=$1,tchin_updated_at=NOW() WHERE id=$2 RETURNING *`,
    [submit.message||'Décaissement Tchin en cours.',payout.id]);
  await logAction(pool,'ADMIN','ADMIN','PAYOUT_TCHIN_PENDING','payout',payout.id,{organizer_id:payout.org_id,amount:payout.amount});
  res.json({success:true,payout:updated.rows[0],message:'Décaissement Tchin en cours. Ticketora ne renverra pas la demande.'});
}));

app.get('/api/admin/withdrawals',requireAdmin,asyncRoute(async(req,res)=>{
  await ensureAdminPayoutTable();
  const [rev,used,rows]=await Promise.all([pool.query(`SELECT COALESCE(SUM(admin_commission),0) AS total FROM tickets`),pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM admin_payouts WHERE status IN ('EN_ATTENTE','PAYE')`),pool.query(`SELECT * FROM admin_payouts ORDER BY id DESC`)]);
  const balance=Number(rev.rows[0].total||0)-Number(used.rows[0].total||0);
  res.json({success:true,withdrawals:rows.rows,balance:Math.max(0,balance),revenue:Number(rev.rows[0].total||0)});
}));
app.post('/api/admin/withdrawals',requireAdmin,asyncRoute(async(req,res)=>{
  await ensureAdminPayoutTable();
  const amount=positiveInt(req.body.amount),account=clean(req.body.account,120);
  if(!amount||!account)return res.status(400).json({success:false,message:'Montant et compte obligatoires.'});
  const rev=await pool.query(`SELECT COALESCE(SUM(admin_commission),0) AS total FROM tickets`);
  const used=await pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM admin_payouts WHERE status IN ('EN_ATTENTE','PAYE')`);
  const balance=Number(rev.rows[0].total||0)-Number(used.rows[0].total||0);
  if(amount>balance)return res.status(400).json({success:false,message:`Solde admin insuffisant. Disponible : ${Math.max(0,balance)} FCFA.`});
  const r=await pool.query('INSERT INTO admin_payouts(amount,account) VALUES($1,$2) RETURNING *',[amount,account]);
  res.status(201).json({success:true,withdrawal:r.rows[0],balance:balance-amount});
}));
app.delete('/api/admin/withdrawals/:id',requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query("DELETE FROM admin_payouts WHERE id=$1 AND status IN ('EN_ATTENTE','REFUSE') RETURNING id",[req.params.id]);if(!r.rows.length)return res.status(400).json({success:false,message:'Ce retrait ne peut plus être supprimé.'});res.json({success:true});}));
app.post('/api/admin/withdrawals/:id/status',requireAdmin,asyncRoute(async(req,res)=>{
  await ensureAdminPayoutTable();
  const status=clean(req.body.status,20);
  if(!['PAYE','REFUSE'].includes(status))return res.status(400).json({success:false,message:'Statut invalide.'});
  const r=await pool.query(`UPDATE admin_payouts SET status=$1,processed_at=CASE WHEN $1='PAYE' THEN NOW() ELSE processed_at END WHERE id=$2 RETURNING *`,[status,req.params.id]);
  if(!r.rows.length)return res.status(404).json({success:false,message:'Retrait admin introuvable.'});
  res.json({success:true,withdrawal:r.rows[0]});
}));
app.get('/api/admin/logs',requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200');res.json({success:true,logs:r.rows});}));
app.get('/api/admin/payments',requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query(`SELECT t.*,o.reference,o.tchin_token,o.tchin_status FROM tickets t JOIN orders o ON o.id=t.order_id ORDER BY t.id DESC`);res.json({success:true,payments:r.rows});}));
app.get('/api/admin/overview',requireAdmin,asyncRoute(async(req,res)=>{const [rev,tix,ev,pending,sales,orgs,users,paystats]=await Promise.all([pool.query('SELECT COALESCE(SUM(admin_commission),0)::int revenue,COALESCE(SUM(total_amount),0)::int volume FROM tickets'),pool.query('SELECT COUNT(*)::int n FROM tickets'),pool.query("SELECT COUNT(*)::int n FROM events WHERE status='PUBLIE'"),pool.query("SELECT COUNT(*)::int n FROM organizers WHERE status='EN_ATTENTE'"),pool.query('SELECT t.*,o.reference FROM tickets t JOIN orders o ON o.id=t.order_id ORDER BY t.id DESC LIMIT 20'),pool.query("SELECT COUNT(*)::int n FROM organizers WHERE status='VALIDE'"),pool.query("SELECT COUNT(DISTINCT LOWER(customer_email))::int n FROM orders WHERE customer_email IS NOT NULL AND customer_email<>''"),pool.query("SELECT COUNT(*) FILTER (WHERE tchin_status='pending')::int pending, COUNT(*) FILTER (WHERE tchin_status='completed')::int completed, COUNT(*) FILTER (WHERE tchin_status='failed')::int failed, COUNT(*) FILTER (WHERE tchin_status='refunded')::int refunded FROM orders")]);res.json({success:true,stats:{revenue:Number(rev.rows[0].revenue),volume:Number(rev.rows[0].volume),tickets:tix.rows[0].n,events:ev.rows[0].n,pendingOrganizers:pending.rows[0].n,organizers:orgs.rows[0].n,users:users.rows[0].n,payments:{pending:paystats.rows[0].pending||0,completed:paystats.rows[0].completed||0,failed:paystats.rows[0].failed||0,refunded:paystats.rows[0].refunded||0}},sales:sales.rows});}));


// ---------- CHAT ADMIN <-> ORGANISATEURS ----------
async function ensureChatTable(){
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    organizer_id BIGINT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    sender_role VARCHAR(20) NOT NULL CHECK(sender_role IN ('ADMIN','ORGANIZER')),
    message TEXT NOT NULL CHECK(length(trim(message)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_chat_messages_org ON chat_messages(organizer_id,id)');
}


// ---------- AGENTS / SCANNERS ORGANISATEURS ----------
async function ensureScannerTable(){
  if(!process.env.DATABASE_URL) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS scanner_agents (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    agent_number VARCHAR(60) NOT NULL UNIQUE,
    name VARCHAR(180) NOT NULL DEFAULT 'Agent scanner',
    password_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_scanner_agents_org ON scanner_agents(org_id)');
}

app.get('/api/organizers/scanners',requireOrg,asyncRoute(async(req,res)=>{
  await ensureScannerTable();
  const r=await pool.query('SELECT id,agent_number,name,active,created_at,last_login_at FROM scanner_agents WHERE org_id=$1 ORDER BY id DESC',[req.session.user.id]);
  res.json({success:true,scanners:r.rows});
}));
app.post('/api/organizers/scanners',requireOrg,asyncRoute(async(req,res)=>{
  await ensureScannerTable();
  const number=clean(req.body.number,60).toUpperCase().replace(/\s+/g,'');
  const name=clean(req.body.name,180)||'Agent scanner';
  const password=String(req.body.password||'');
  if(!number||password.length<6)return res.status(400).json({success:false,message:'Numéro et mot de passe (6 caractères minimum) obligatoires.'});
  const exists=await pool.query('SELECT 1 FROM scanner_agents WHERE agent_number=$1',[number]);
  if(exists.rows.length)return res.status(409).json({success:false,message:'Ce numéro de scanner existe déjà.'});
  const hash=await bcrypt.hash(password,12);
  const r=await pool.query('INSERT INTO scanner_agents(org_id,agent_number,name,password_hash) VALUES($1,$2,$3,$4) RETURNING id,agent_number,name,active,created_at',[req.session.user.id,number,name,hash]);
  await pool.query("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,metadata) VALUES('ORGANIZER',$1,'SCANNER_CREATED','scanner',$2,$3)",[req.session.user.id,r.rows[0].id,JSON.stringify({agent_number:number})]);
  res.status(201).json({success:true,scanner:r.rows[0],message:'Agent scanner créé. Conservez le numéro et le mot de passe.'});
}));
app.post('/api/organizers/scanners/:id/toggle',requireOrg,asyncRoute(async(req,res)=>{
  await ensureScannerTable();
  const r=await pool.query('UPDATE scanner_agents SET active=NOT active WHERE id=$1 AND org_id=$2 RETURNING id,agent_number,name,active',[req.params.id,req.session.user.id]);
  if(!r.rows.length)return res.status(404).json({success:false,message:'Agent scanner introuvable.'});
  res.json({success:true,scanner:r.rows[0]});
}));
app.delete('/api/organizers/scanners/:id',requireOrg,asyncRoute(async(req,res)=>{
  await ensureScannerTable();
  const r=await pool.query('DELETE FROM scanner_agents WHERE id=$1 AND org_id=$2 RETURNING id',[req.params.id,req.session.user.id]);
  if(!r.rows.length)return res.status(404).json({success:false,message:'Agent scanner introuvable.'});
  res.json({success:true});
}));

// ---------- AUTHENTIFICATION SCANNER ----------
app.post('/api/scanners/login',asyncRoute(async(req,res)=>{
  await ensureScannerTable();
  const number=clean(req.body.number,60).toUpperCase().replace(/\s+/g,''),password=String(req.body.password||'');
  const r=await pool.query('SELECT id,org_id,agent_number,name,password_hash,active FROM scanner_agents WHERE agent_number=$1',[number]);
  if(!r.rows.length)return res.status(401).json({success:false,message:'Numéro ou mot de passe incorrect.'});
  const a=r.rows[0];
  if(!a.active)return res.status(403).json({success:false,message:'Ce scanner a été désactivé par l’organisateur.'});
  if(!(await bcrypt.compare(password,a.password_hash)))return res.status(401).json({success:false,message:'Numéro ou mot de passe incorrect.'});
  await pool.query('UPDATE scanner_agents SET last_login_at=NOW() WHERE id=$1',[a.id]);
  req.session.user={role:'SCANNER',id:a.id,orgId:a.org_id,number:a.agent_number,name:a.name};
  res.json({success:true,scanner:{id:a.id,number:a.agent_number,name:a.name}});
}));
app.post('/api/scanners/logout',(req,res)=>req.session.destroy(()=>res.json({success:true})));
function requireScanner(req,res,next){if(req.session?.user?.role!=='SCANNER')return res.status(401).json({success:false,message:'Connexion scanner requise.'});next();}
app.get('/api/scanners/me',requireScanner,asyncRoute(async(req,res)=>{await ensureScannerTable();const r=await pool.query('SELECT id,agent_number,name,active,org_id FROM scanner_agents WHERE id=$1',[req.session.user.id]);if(!r.rows.length||!r.rows[0].active)return res.status(401).json({success:false,message:'Scanner inactif.'});res.json({success:true,scanner:r.rows[0]});}));
app.post('/api/scanners/scan',requireScanner,asyncRoute(async(req,res)=>{const code=clean(req.body.code,32).toUpperCase();if(!code)return res.status(400).json({success:false,message:'Code billet requis.'});const x=await scanTicket(code,req.session.user.orgId);res.status(x.http).json(x.data);}));
app.get('/api/chat/conversations',requireAdmin,asyncRoute(async(req,res)=>{
  await ensureChatTable();
  const r=await pool.query(`SELECT o.id,o.nom,o.prenom,o.email,o.status,
    m.message AS last_message,m.sender_role,m.created_at AS last_message_at,
    COALESCE((SELECT COUNT(*) FROM chat_messages x WHERE x.organizer_id=o.id AND x.sender_role='ORGANIZER' AND x.read_at IS NULL),0)::int AS unread
    FROM organizers o LEFT JOIN LATERAL (SELECT message,sender_role,created_at FROM chat_messages WHERE organizer_id=o.id ORDER BY id DESC LIMIT 1) m ON true
    WHERE EXISTS(SELECT 1 FROM chat_messages z WHERE z.organizer_id=o.id)
    ORDER BY COALESCE(m.created_at,o.created_at) DESC`);
  res.json({success:true,conversations:r.rows});
}));
app.get('/api/chat/messages/:organizerId',requireAdmin,asyncRoute(async(req,res)=>{
  await ensureChatTable();
  const id=Number(req.params.organizerId); if(!id)return res.status(400).json({success:false,message:'Organisateur invalide.'});
  await pool.query("UPDATE chat_messages SET read_at=NOW() WHERE organizer_id=$1 AND sender_role='ORGANIZER' AND read_at IS NULL",[id]);
  const org=await pool.query('SELECT id,nom,prenom,email,status FROM organizers WHERE id=$1',[id]);
  if(!org.rows.length)return res.status(404).json({success:false,message:'Organisateur introuvable.'});
  const r=await pool.query('SELECT id,sender_role,message,created_at FROM chat_messages WHERE organizer_id=$1 ORDER BY id ASC',[id]);
  res.json({success:true,organizer:org.rows[0],messages:r.rows});
}));
app.post('/api/chat/messages/:organizerId',requireAdmin,asyncRoute(async(req,res)=>{
  await ensureChatTable();
  const id=Number(req.params.organizerId),message=clean(req.body.message,4000);
  if(!id||!message)return res.status(400).json({success:false,message:'Message obligatoire.'});
  const org=await pool.query('SELECT id FROM organizers WHERE id=$1',[id]); if(!org.rows.length)return res.status(404).json({success:false,message:'Organisateur introuvable.'});
  const r=await pool.query("INSERT INTO chat_messages(organizer_id,sender_role,message) VALUES($1,'ADMIN',$2) RETURNING id,sender_role,message,created_at",[id,message]);
  res.status(201).json({success:true,message:r.rows[0]});
}));
app.get('/api/organizers/chat/messages',requireOrg,asyncRoute(async(req,res)=>{
  await ensureChatTable();
  const id=req.session.user.id;
  await pool.query("UPDATE chat_messages SET read_at=NOW() WHERE organizer_id=$1 AND sender_role='ADMIN' AND read_at IS NULL",[id]);
  const r=await pool.query('SELECT id,sender_role,message,created_at FROM chat_messages WHERE organizer_id=$1 ORDER BY id ASC',[id]);
  res.json({success:true,messages:r.rows});
}));
app.post('/api/organizers/chat/messages',requireOrg,asyncRoute(async(req,res)=>{
  await ensureChatTable();
  const message=clean(req.body.message,4000); if(!message)return res.status(400).json({success:false,message:'Message obligatoire.'});
  const r=await pool.query("INSERT INTO chat_messages(organizer_id,sender_role,message) VALUES($1,'ORGANIZER',$2) RETURNING id,sender_role,message,created_at",[req.session.user.id,message]);
  res.status(201).json({success:true,message:r.rows[0]});
}));


// ---------- CAGNOTTES ----------
async function ensureCagnotteTables(){
  if(!process.env.DATABASE_URL) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS cagnottes (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    images JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'BROUILLON' CHECK(status IN ('BROUILLON','PUBLIE','TERMINE')),
    target_amount INTEGER,
    total_amount INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    launched_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS contributions (
    id BIGSERIAL PRIMARY KEY,
    cagnotte_id BIGINT NOT NULL REFERENCES cagnottes(id) ON DELETE CASCADE,
    contributor_name VARCHAR(255),
    contributor_email VARCHAR(255),
    amount INTEGER NOT NULL CHECK(amount >= 100),
    status VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK(status IN ('EN_ATTENTE','PAYE','ANNULE')),
    reference VARCHAR(80) UNIQUE NOT NULL,
    tchin_token VARCHAR(255) UNIQUE,
    tchin_reference VARCHAR(255),
    tchin_status VARCHAR(30),
    tchin_mode VARCHAR(30),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cagnottes_status ON cagnottes(status)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_contributions_cagnotte ON contributions(cagnotte_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_contributions_tchin ON contributions(tchin_token)');
}
function normalizeImages(images){if(!Array.isArray(images))return [];return images.map(x=>clean(x,1800000)).filter(x=>/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(x)).slice(0,6);}
app.get('/api/cagnottes',asyncRoute(async(req,res)=>{await ensureCagnotteTables();const r=await pool.query("SELECT id,title,description,images,status,target_amount,total_amount,created_at,launched_at FROM cagnottes WHERE status='PUBLIE' ORDER BY id DESC");res.json({success:true,cagnottes:r.rows});}));
app.get('/api/admin/cagnottes',requireAdmin,asyncRoute(async(req,res)=>{await ensureCagnotteTables();const r=await pool.query('SELECT * FROM cagnottes ORDER BY id DESC');res.json({success:true,cagnottes:r.rows});}));
app.post('/api/admin/cagnottes',requireAdmin,asyncRoute(async(req,res)=>{await ensureCagnotteTables();const title=clean(req.body.title,255),description=clean(req.body.description,10000),images=normalizeImages(req.body.images),target=positiveInt(req.body.targetAmount);if(!title||!description)return res.status(400).json({success:false,message:'Titre et description obligatoires.'});const r=await pool.query('INSERT INTO cagnottes(title,description,images,target_amount) VALUES($1,$2,$3::jsonb,$4) RETURNING *',[title,description,JSON.stringify(images),target||null]);res.status(201).json({success:true,cagnotte:r.rows[0],message:'Cagnotte créée en brouillon.'});}));
app.post('/api/admin/cagnottes/:id/launch',requireAdmin,asyncRoute(async(req,res)=>{await ensureCagnotteTables();const r=await pool.query("UPDATE cagnottes SET status='PUBLIE',launched_at=COALESCE(launched_at,NOW()),updated_at=NOW() WHERE id=$1 RETURNING *",[req.params.id]);if(!r.rows.length)return res.status(404).json({success:false,message:'Cagnotte introuvable.'});res.json({success:true,cagnotte:r.rows[0]});}));
app.post('/api/admin/cagnottes/:id/stop',requireAdmin,asyncRoute(async(req,res)=>{await ensureCagnotteTables();const r=await pool.query("UPDATE cagnottes SET status='TERMINE',updated_at=NOW() WHERE id=$1 RETURNING *",[req.params.id]);if(!r.rows.length)return res.status(404).json({success:false,message:'Cagnotte introuvable.'});res.json({success:true,cagnotte:r.rows[0]});}));
app.delete('/api/admin/cagnottes/:id',requireAdmin,asyncRoute(async(req,res)=>{await ensureCagnotteTables();const r=await pool.query("DELETE FROM cagnottes WHERE id=$1 AND status<>'PUBLIE' RETURNING id",[req.params.id]);if(!r.rows.length)return res.status(400).json({success:false,message:'Une cagnotte publiée ne peut pas être supprimée.'});res.json({success:true});}));
app.get('/api/admin/cagnottes/:id/contributions',requireAdmin,asyncRoute(async(req,res)=>{await ensureCagnotteTables();const r=await pool.query('SELECT * FROM contributions WHERE cagnotte_id=$1 ORDER BY id DESC',[req.params.id]);res.json({success:true,contributions:r.rows});}));
app.post('/api/cagnottes/:id/contribute',asyncRoute(async(req,res)=>{await ensureCagnotteTables();const id=Number(req.params.id),name=clean(req.body.name,255),email=clean(req.body.email,255).toLowerCase(),amount=positiveInt(req.body.amount);if(!id||!amount||amount<100)return res.status(400).json({success:false,message:'Choisissez un montant d’au moins 100 FCFA.'});const c=await pool.connect();try{await c.query('BEGIN');const cg=await c.query("SELECT * FROM cagnottes WHERE id=$1 AND status='PUBLIE' FOR UPDATE",[id]);if(!cg.rows.length)throw new Error('Cagnotte indisponible.');const ref='CAG-'+crypto.randomBytes(5).toString('hex').toUpperCase();await c.query('INSERT INTO contributions(cagnotte_id,contributor_name,contributor_email,amount,reference) VALUES($1,$2,$3,$4,$5)',[id,name||'Anonyme',email||null,amount,ref]);await c.query('COMMIT');const returnUrl=process.env.TCHIN_RETURN_URL||`${FRONTEND_URL}/?cagnotte=return`;const cancelUrl=process.env.TCHIN_CANCEL_URL||`${FRONTEND_URL}/?cagnotte=cancel`;const callback=process.env.TCHIN_CALLBACK_URL||`${req.protocol}://${req.get('host')}/api/webhooks/tchin`;const td=await tchinRequest('/payments',{method:'POST',body:JSON.stringify({amount,description:`Ticketora Cagnotte ${ref} - ${cg.rows[0].title}`,env:process.env.TCHIN_ENV||'test',return_url:returnUrl,cancel_url:cancelUrl,callback_url:callback,fees_on_customer:false})});await pool.query('UPDATE contributions SET tchin_token=$1,tchin_status=\'pending\',tchin_mode=$2 WHERE reference=$3',[td.token,process.env.TCHIN_ENV||'test',ref]);res.json({success:true,reference:ref,token:td.token,payment_url:td.payment_url,amount});}catch(e){try{await c.query('ROLLBACK')}catch{};res.status(400).json({success:false,message:e.message});}finally{c.release();}}));
app.get('/api/cagnottes/contributions/:token/status',asyncRoute(async(req,res)=>{await ensureCagnotteTables();const token=clean(req.params.token,255);const r=await pool.query('SELECT c.*,g.title FROM contributions c JOIN cagnottes g ON g.id=c.cagnotte_id WHERE c.tchin_token=$1',[token]);if(!r.rows.length)return res.status(404).json({success:false,message:'Contribution introuvable.'});const c=r.rows[0];const td=await tchinRequest(`/payments/${encodeURIComponent(token)}/status`,{method:'GET'});const status=td.status||td.data?.status||c.tchin_status||'pending';if(status==='completed'&&c.status!=='PAYE'&&String(process.env.TCHIN_ENV||'test')!=='test'){await pool.query("UPDATE contributions SET status='PAYE',paid_at=NOW(),tchin_status='completed',tchin_reference=COALESCE($1,tchin_reference),tchin_mode=COALESCE($2,tchin_mode) WHERE id=$3 AND status<>'PAYE'",[td.reference||null,td.mode||null,c.id]);await pool.query('UPDATE cagnottes SET total_amount=total_amount+$1,updated_at=NOW() WHERE id=$2',[c.amount,c.cagnotte_id]);return res.json({success:true,status:'completed',paid:true});}res.json({success:true,status,paid:c.status==='PAYE'});}));
// ---------- QR ----------
app.get('/api/tickets/:code/qr',asyncRoute(async(req,res)=>{const code=clean(req.params.code,32).toUpperCase();const r=await pool.query('SELECT 1 FROM tickets WHERE code=$1',[code]);if(!r.rows.length)return res.status(404).end();const png=await QRCode.toBuffer(code,{width:500,margin:1,errorCorrectionLevel:'M'});res.type('png').send(png);}));

// Static files for local same-origin testing.
app.use(express.static(__dirname));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({success:false,message:'Erreur interne du serveur.'});});

app.listen(PORT,async()=>{try{await ensureEventImageColumn();await ensureAdminPayoutTable();await ensurePayoutTchinColumns();await ensureChatTable();await ensureScannerTable();await ensureCagnotteTables();await ensurePromoTables();console.log(`Ticketora API sur http://localhost:${PORT}`);setInterval(syncPendingTchinPayouts,120000);}catch(e){console.error('Initialisation base admin retraits:',e.message);console.log(`Ticketora API sur http://localhost:${PORT}`);}});
