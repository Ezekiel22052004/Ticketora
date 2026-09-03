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
app.post('/api/payments/create',asyncRoute(async(req,res)=>{
  const eventId=Number(req.body.eventId),name=clean(req.body.name,255),email=clean(req.body.email,255).toLowerCase(),ticketType=clean(req.body.ticketType,120),promo=clean(req.body.promo,60).toUpperCase();if(!Number.isInteger(eventId)||!name||!email||!ticketType)return res.status(400).json({success:false,message:'Informations d’achat incomplètes.'});
  const c=await pool.connect();try{await c.query('BEGIN');const er=await c.query("SELECT * FROM events WHERE id=$1 AND status='PUBLIE' FOR UPDATE",[eventId]);if(!er.rows.length)throw new Error('Événement indisponible.');const ev=er.rows[0];let cats=Array.isArray(ev.ticket_categories)?ev.ticket_categories:[];if(typeof ev.ticket_categories==='string')cats=JSON.parse(ev.ticket_categories);const cat=cats.find(x=>String(x.name).toLowerCase()===ticketType.toLowerCase());if(!cat)throw new Error('Type de billet indisponible.');const baseAmount=Number(cat.price||0);let discount=0;if(promo==='PROMO10')discount=Math.round(baseAmount*0.10);const total=baseAmount-discount;if(total<100)throw new Error('Montant du billet trop faible pour le paiement.');const sold=await c.query('SELECT COUNT(*)::int n FROM tickets WHERE event_id=$1',[eventId]);if(Number(ev.capacity)>0&&sold.rows[0].n>=Number(ev.capacity))throw new Error('Événement complet.');const ref=fmtRef();await c.query('INSERT INTO orders(reference,event_id,ticket_type,customer_name,customer_email,base_amount,discount_amount,total_amount,promo_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ref,eventId,ticketType,name,email,baseAmount,discount,total,promo]);await c.query('COMMIT');
    const returnUrl=process.env.TCHIN_RETURN_URL||`${FRONTEND_URL}/?payment=return`;const cancelUrl=process.env.TCHIN_CANCEL_URL||`${FRONTEND_URL}/?payment=cancel`;const callback=process.env.TCHIN_CALLBACK_URL||`${req.protocol}://${req.get('host')}/api/webhooks/tchin`;
    const td=await tchinRequest('/payments',{method:'POST',body:JSON.stringify({amount:total,description:`Ticketora ${ref} - ${ev.title}`,env:process.env.TCHIN_ENV||'test',return_url:returnUrl,cancel_url:cancelUrl,callback_url:callback,fees_on_customer:false})});
    await pool.query('UPDATE orders SET tchin_token=$1,tchin_status=\'pending\' WHERE reference=$2',[td.token,ref]);res.json({success:true,reference:ref,token:td.token,payment_url:td.payment_url,amount:total});
  }catch(e){try{await c.query('ROLLBACK')}catch{};res.status(400).json({success:false,message:e.message});}finally{c.release();}
}));

async function fulfillOrder(orderId,sourceData={}){
  const c=await pool.connect();try{await c.query('BEGIN');const or=await c.query('SELECT o.*,e.title event_title,e.date event_date,e.location event_location,e.org_id,e.capacity FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1 FOR UPDATE',[orderId]);if(!or.rows.length)throw new Error('Commande introuvable.');const o=or.rows[0];if(o.status==='PAID'){const tr=await c.query('SELECT * FROM tickets WHERE order_id=$1',[orderId]);await c.query('COMMIT');return tr.rows[0]||null;}const expected=Number(o.total_amount);const received=Number(sourceData.amount??expected);if(received!==expected)throw new Error('Montant de paiement différent du montant attendu.');if(sourceData.mode&&sourceData.mode!==(process.env.TCHIN_ENV||'test'))throw new Error('Mode de paiement non conforme.');if((process.env.TCHIN_ENV||'test')==='test')throw new Error('Paiement de test : aucun billet réel ne doit être délivré.');const sold=await c.query('SELECT COUNT(*)::int n FROM tickets WHERE event_id=$1',[o.event_id]);if(Number(o.capacity)>0&&sold.rows[0].n>=Number(o.capacity))throw new Error('Événement complet au moment de la confirmation.');const split=commissionFor(expected);let code;for(let i=0;i<8;i++){const candidate=fmtTicket();const exists=await c.query('SELECT 1 FROM tickets WHERE code=$1',[candidate]);if(!exists.rows.length){code=candidate;break;}}if(!code)throw new Error('Impossible de générer une référence billet unique.');const tr=await c.query(`INSERT INTO tickets(order_id,code,event_id,org_id,event_title,event_date,event_location,ticket_type,customer_name,customer_email,total_amount,admin_commission,organizer_amount,commission_rate) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[o.id,code,o.event_id,o.org_id,o.event_title,o.event_date,o.event_location,o.ticket_type,o.customer_name,o.customer_email,expected,split.admin,split.organizer,split.rate]);await c.query("UPDATE orders SET status='PAID',paid_at=NOW(),tchin_status='completed',tchin_reference=COALESCE($1,tchin_reference),tchin_mode=COALESCE($2,tchin_mode) WHERE id=$3",[sourceData.reference||null,sourceData.mode||null,o.id]);await logAction(c,'SYSTEM','TCHIN','TICKET_ISSUED','ticket',tr.rows[0].id,{order_id:o.id,reference:o.reference});await c.query('COMMIT');return tr.rows[0];}catch(e){try{await c.query('ROLLBACK')}catch{};throw e}finally{c.release();}}

function pickWebhook(req){const b=req.body||{};const d=b.data||{};const get=k=>d[k]??b[`data[${k}]`]??b[k];return {status:get('status'),reference:get('reference'),token:get('token'),amount:get('amount'),fee:get('fee'),net:get('net'),mode:get('mode'),timestamp:get('timestamp'),signature:get('signature'),customer:get('customer'),method:get('method')};}
function validTchinSignature(p){const ts=String(p.timestamp||'');if(!/^\d+$/.test(ts))return false;const ms=Number(ts);const now=Date.now();const stamp=ms<1e12?ms*1000:ms;if(Math.abs(now-stamp)>5*60*1000)return false;const raw=[p.timestamp,p.reference,p.token,p.status,p.amount,p.net,p.mode].map(x=>String(x??'')).join('.');const expected=crypto.createHmac('sha256',process.env.TCHIN_PRIVATE_KEY||'').update(raw).digest('hex');const a=Buffer.from(expected,'utf8'),b=Buffer.from(String(p.signature||''),'utf8');return a.length===b.length&&crypto.timingSafeEqual(a,b);}
async function handleTchinWebhook(req,res){const p=pickWebhook(req);if(!process.env.TCHIN_PRIVATE_KEY||!validTchinSignature(p))return res.status(401).send('invalid signature');try{const or=await pool.query('SELECT * FROM orders WHERE tchin_token=$1 OR reference=$2 LIMIT 1',[p.token,p.reference]);if(!or.rows.length)return res.status(200).send('ignored');const o=or.rows[0];await pool.query('UPDATE orders SET tchin_status=$1,tchin_reference=COALESCE($2,tchin_reference),tchin_mode=COALESCE($3,tchin_mode) WHERE id=$4',[p.status,p.reference,p.mode,o.id]);if(p.status==='completed'){try{await fulfillOrder(o.id,p);}catch(e){console.error('Tchin fulfillment:',e.message);}}else if(['failed','cancelled'].includes(String(p.status))){await pool.query("UPDATE orders SET status=CASE WHEN status='PAID' THEN status ELSE 'CANCELLED' END WHERE id=$1",[o.id]);}return res.status(200).send('ok');}catch(e){console.error(e);return res.status(500).send('retry');}}

app.get('/api/payments/:token/status',asyncRoute(async(req,res)=>{const token=clean(req.params.token,255);const or=await pool.query('SELECT o.*,e.title event_title FROM orders o JOIN events e ON e.id=o.event_id WHERE o.tchin_token=$1',[token]);if(!or.rows.length)return res.status(404).json({success:false,message:'Transaction introuvable.'});let o=or.rows[0];let td=await tchinRequest(`/payments/${encodeURIComponent(token)}/status`,{method:'GET',headers:{'Content-Type':'application/json'}});const status=td.status||td.data?.status||'pending';if(status==='completed'&&o.status!=='PAID'){try{const ticket=await fulfillOrder(o.id,{amount:td.amount??o.total_amount,mode:td.mode||process.env.TCHIN_ENV,reference:td.reference||null});o=(await pool.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];return res.json({success:true,status:'completed',paid:true,ticket:ticket?{code:ticket.code,event_title:ticket.event_title,event_date:ticket.event_date,event_location:ticket.event_location,ticket_type:ticket.ticket_type,customer_name:ticket.customer_name,customer_email:ticket.customer_email}:null});}catch(e){return res.json({success:true,status:'completed',paid:false,message:e.message});}}const tr=await pool.query('SELECT code,event_title,event_date,event_location,ticket_type,customer_name,customer_email FROM tickets WHERE order_id=$1',[o.id]);res.json({success:true,status:o.status==='PAID'?'completed':status,paid:o.status==='PAID',ticket:tr.rows[0]||null});}));

// ---------- BILLETS ----------
app.get('/api/tickets/verify/:code',asyncRoute(async(req,res)=>{const code=clean(req.params.code,32).toUpperCase();const r=await pool.query('SELECT code,event_title,event_date,event_location,ticket_type,customer_name,used,used_at FROM tickets WHERE UPPER(code)=UPPER($1)',[code]);if(!r.rows.length)return res.status(404).json({success:false,status:'INVALID',message:'BILLET NON VALIDE'});const t=r.rows[0];res.json({success:true,status:t.used?'USED':'VALID',message:t.used?'BILLET DÉJÀ UTILISÉ':'BILLET VALIDE',ticket:t});}));
async function scanTicket(code,orgId){const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query('SELECT t.*,e.title event_title,e.date event_date,e.location event_location FROM tickets t JOIN events e ON e.id=t.event_id WHERE UPPER(t.code)=UPPER($1) FOR UPDATE',[code]);if(!r.rows.length){await c.query('ROLLBACK');return {http:404,data:{success:false,status:'INVALID',message:'BILLET NON VALIDE'}};}const t=r.rows[0];if(String(t.org_id)!==String(orgId)){await c.query('ROLLBACK');return {http:403,data:{success:false,status:'INVALID',message:'Ce billet ne correspond pas à cet organisateur.'}};}if(t.used){await c.query('ROLLBACK');return {http:409,data:{success:false,status:'USED',message:'BILLET DÉJÀ UTILISÉ',ticket:t}};}const u=await c.query('UPDATE tickets SET used=true,used_at=NOW(),scan_count=scan_count+1 WHERE id=$1 RETURNING *',[t.id]);await c.query('COMMIT');return {http:200,data:{success:true,status:'VALID',message:'ENTRÉE AUTORISÉE',ticket:u.rows[0]}};}catch(e){try{await c.query('ROLLBACK')}catch{};throw e}finally{c.release();}}
app.post('/api/tickets/scan',requireOrg,asyncRoute(async(req,res)=>{const code=clean(req.body.code,32).toUpperCase();if(!code)return res.status(400).json({success:false,message:'Code requis.'});const x=await scanTicket(code,req.session.user.id);res.status(x.http).json(x.data);}));
app.post('/api/admin/tickets/scan',requireAdmin,asyncRoute(async(req,res)=>{const code=clean(req.body.code,32).toUpperCase();if(!code)return res.status(400).json({success:false,message:'Code requis.'});const r=await pool.query('SELECT * FROM tickets WHERE UPPER(code)=UPPER($1)',[code]);if(!r.rows.length)return res.status(404).json({success:false,status:'INVALID',message:'BILLET NON VALIDE'});const t=r.rows[0];if(t.used)return res.status(409).json({success:false,status:'USED',message:'BILLET DÉJÀ UTILISÉ',ticket:t});const c=await pool.connect();try{await c.query('BEGIN');const u=await c.query('UPDATE tickets SET used=true,used_at=NOW(),scan_count=scan_count+1 WHERE id=$1 AND used=false RETURNING *',[t.id]);await c.query('COMMIT');if(!u.rows.length)return res.status(409).json({success:false,status:'USED',message:'BILLET DÉJÀ UTILISÉ'});res.json({success:true,status:'VALID',message:'ENTRÉE AUTORISÉE',ticket:u.rows[0]});}finally{c.release();}}));

// ---------- STATS / PAYOUTS ----------
app.get('/api/organizers/stats',requireOrg,asyncRoute(async(req,res)=>{const id=req.session.user.id;const [e,t,p]=await Promise.all([pool.query('SELECT * FROM events WHERE org_id=$1 ORDER BY id DESC',[id]),pool.query('SELECT * FROM tickets WHERE org_id=$1 ORDER BY id DESC',[id]),pool.query('SELECT * FROM payouts WHERE org_id=$1 ORDER BY id DESC',[id])]);const net=t.rows.reduce((s,x)=>s+Number(x.organizer_amount||0),0);res.json({success:true,events:e.rows,tickets:t.rows,payouts:p.rows,netRevenue:net});}));
app.delete('/api/organizers/events/:id',requireOrg,asyncRoute(async(req,res)=>{const sold=await pool.query('SELECT COUNT(*)::int AS n FROM tickets WHERE event_id=$1',[req.params.id]);const orders=await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE event_id=$1',[req.params.id]);if(Number(sold.rows[0].n)>0||Number(orders.rows[0].n)>0)return res.status(400).json({success:false,message:'Impossible de supprimer cet événement : des achats ou billets sont déjà liés à cet événement.'});const r=await pool.query('DELETE FROM events WHERE id=$1 AND org_id=$2 RETURNING id',[req.params.id,req.session.user.id]);if(!r.rows.length)return res.status(404).json({success:false,message:'Événement introuvable.'});res.json({success:true});}));
app.post('/api/payouts',requireOrg,asyncRoute(async(req,res)=>{
  const amount=positiveInt(req.body.amount),account=clean(req.body.account,120);
  if(!amount||!account)return res.status(400).json({success:false,message:'Montant et compte obligatoires.'});
  const bal=await pool.query(`SELECT COALESCE((SELECT SUM(organizer_amount) FROM tickets WHERE org_id=$1),0)-COALESCE((SELECT SUM(amount) FROM payouts WHERE org_id=$1 AND status IN ('EN_ATTENTE','VALIDE','PAYE')),0) AS available`,[req.session.user.id]);
  const available=Number(bal.rows[0].available||0);
  if(amount>available)return res.status(400).json({success:false,message:`Solde disponible insuffisant. Disponible : ${available} FCFA.`});
  const r=await pool.query('INSERT INTO payouts(org_id,amount,account) VALUES($1,$2,$3) RETURNING *',[req.session.user.id,amount,account]);
  res.status(201).json({success:true,payout:r.rows[0],available:available-amount});
}));
app.delete('/api/payouts/:id',requireOrg,asyncRoute(async(req,res)=>{const r=await pool.query("DELETE FROM payouts WHERE id=$1 AND org_id=$2 AND status IN ('EN_ATTENTE','REFUSE') RETURNING id",[req.params.id,req.session.user.id]);if(!r.rows.length)return res.status(400).json({success:false,message:'Ce retrait ne peut plus être supprimé.'});res.json({success:true});}));
app.delete('/api/admin/payouts/:id',requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query("DELETE FROM payouts WHERE id=$1 AND status IN ('EN_ATTENTE','REFUSE') RETURNING id",[req.params.id]);if(!r.rows.length)return res.status(400).json({success:false,message:'Ce retrait ne peut plus être supprimé.'});res.json({success:true});}));
app.get('/api/admin/payouts',requireAdmin,asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT p.*,o.nom,o.prenom,o.email,o.phone FROM payouts p JOIN organizers o ON o.id=p.org_id ORDER BY CASE WHEN p.status='EN_ATTENTE' THEN 0 WHEN p.status='VALIDE' THEN 1 ELSE 2 END,p.id DESC`);
  const bal=await pool.query(`SELECT COALESCE(SUM(organizer_amount),0) AS total FROM tickets`);
  res.json({success:true,payouts:r.rows,totalOrganizerRevenue:Number(bal.rows[0].total||0)});
}));
app.post('/api/admin/payouts/:id/status',requireAdmin,asyncRoute(async(req,res)=>{
  const status=clean(req.body.status,20);
  if(!['VALIDE','REFUSE','PAYE'].includes(status))return res.status(400).json({success:false,message:'Statut de retrait invalide.'});
  const current=await pool.query('SELECT p.*,o.nom,o.prenom FROM payouts p JOIN organizers o ON o.id=p.org_id WHERE p.id=$1',[req.params.id]);
  if(!current.rows.length)return res.status(404).json({success:false,message:'Demande de retrait introuvable.'});
  const payout=current.rows[0];
  if(status==='VALIDE' && payout.status!=='EN_ATTENTE')return res.status(400).json({success:false,message:'Cette demande ne peut plus être validée.'});
  if(status==='PAYE' && !['VALIDE','EN_ATTENTE'].includes(payout.status))return res.status(400).json({success:false,message:'Cette demande ne peut pas être marquée payée.'});
  if(['VALIDE','PAYE'].includes(status)){
    const bal=await pool.query(`SELECT COALESCE((SELECT SUM(organizer_amount) FROM tickets WHERE org_id=$1),0)-COALESCE((SELECT SUM(amount) FROM payouts WHERE org_id=$1 AND id<>$2 AND status IN ('EN_ATTENTE','VALIDE','PAYE')),0) AS available`,[payout.org_id,payout.id]);
    if(Number(payout.amount)>Number(bal.rows[0].available||0))return res.status(400).json({success:false,message:'Solde organisateur insuffisant pour ce retrait.'});
  }
  const r=await pool.query(`UPDATE payouts SET status=$1,processed_at=CASE WHEN $1='PAYE' THEN NOW() ELSE processed_at END WHERE id=$2 RETURNING *`,[status,payout.id]);
  await logAction(pool,'ADMIN','ADMIN',`PAYOUT_${status}`,'payout',payout.id,{organizer_id:payout.org_id,amount:payout.amount});
  res.json({success:true,payout:r.rows[0]});
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
app.get('/api/admin/payments',requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query(`SELECT t.*,o.reference,o.tchin_token,o.tchin_status FROM tickets t JOIN orders o ON o.id=t.order_id ORDER BY t.id DESC`);res.json({success:true,payments:r.rows});}));
app.get('/api/admin/overview',requireAdmin,asyncRoute(async(req,res)=>{const [rev,tix,ev,pending,sales]=await Promise.all([pool.query('SELECT COALESCE(SUM(admin_commission),0)::int revenue,COALESCE(SUM(total_amount),0)::int volume FROM tickets'),pool.query('SELECT COUNT(*)::int n FROM tickets'),pool.query("SELECT COUNT(*)::int n FROM events WHERE status='PUBLIE'"),pool.query("SELECT COUNT(*)::int n FROM organizers WHERE status='EN_ATTENTE'"),pool.query('SELECT t.*,o.reference FROM tickets t JOIN orders o ON o.id=t.order_id ORDER BY t.id DESC LIMIT 20')]);res.json({success:true,stats:{revenue:Number(rev.rows[0].revenue),volume:Number(rev.rows[0].volume),tickets:tix.rows[0].n,events:ev.rows[0].n,pendingOrganizers:pending.rows[0].n},sales:sales.rows});}));

// ---------- QR ----------
app.get('/api/tickets/:code/qr',asyncRoute(async(req,res)=>{const code=clean(req.params.code,32).toUpperCase();const r=await pool.query('SELECT 1 FROM tickets WHERE code=$1',[code]);if(!r.rows.length)return res.status(404).end();const png=await QRCode.toBuffer(code,{width:500,margin:1,errorCorrectionLevel:'M'});res.type('png').send(png);}));

// Static files for local same-origin testing.
app.use(express.static(__dirname));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({success:false,message:'Erreur interne du serveur.'});});

app.listen(PORT,async()=>{try{await ensureEventImageColumn();await ensureAdminPayoutTable();console.log(`Ticketora API sur http://localhost:${PORT}`);}catch(e){console.error('Initialisation base admin retraits:',e.message);console.log(`Ticketora API sur http://localhost:${PORT}`);}});
