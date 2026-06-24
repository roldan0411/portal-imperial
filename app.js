// ========================= PORTAL IMPERIAL POS =========================
// ---- CAPA DE DATOS: cache en memoria sincronizado con Firebase en tiempo real ----
const CACHE = {};            // copia local de todos los datos
let FB_READY = false;        // ¿ya cargó Firebase?
let fbDB = null;             // referencia a la base de datos

const DB = {
  get(k){ return (k in CACHE) ? CACHE[k] : null; },
  set(k,v){
    CACHE[k] = v;
    try { localStorage.setItem('pi_'+k, JSON.stringify(v)); } catch(e){}
    if(FB_READY && fbDB){
      try { fbDB.ref('data/'+k).set(v===undefined?null:v); } catch(e){ console.warn('FB set',e); }
    }
  },
};
// Guarda un cambio en un pedido SIN riesgo de borrar pedidos de otros dispositivos.
// En vez de reescribir todo el array a ciegas, fusiona por id: conserva todos los
// pedidos que existan (en el cache local Y en lo último recibido de Firebase) y
// solo agrega o actualiza el pedido indicado. Evita que dos cajas se pisen los pedidos.
function fusionarYGuardarVentas(arrayLocal){
  // arrayLocal ya viene con el cambio aplicado. Garantizamos no perder nada.
  const porId = {};
  // 1) lo que ya está en cache (incluye lo que llegó de Firebase por el listener)
  (CACHE['ventas']||[]).forEach(v=>{ if(v&&v.id) porId[v.id]=v; });
  // 2) aplicar/montar el array local encima (cambios recientes ganan)
  (arrayLocal||[]).forEach(v=>{ if(v&&v.id) porId[v.id]=v; });
  const fusionado = Object.values(porId).sort((a,b)=> new Date(b.fecha)-new Date(a.fecha));
  DB.set('ventas', fusionado);
}
// Borra UN solo pedido de forma segura, sin arrastrar ni borrar los demás.
function borrarVentaSegura(id){
  const porId = {};
  (CACHE['ventas']||[]).forEach(v=>{ if(v&&v.id) porId[v.id]=v; });
  delete porId[id];
  const fusionado = Object.values(porId).sort((a,b)=> new Date(b.fecha)-new Date(a.fecha));
  DB.set('ventas', fusionado);
}
const ic = id => `<svg class="ic"><use href="#${id}"/></svg>`;
let SERVER_OFFSET = 0; // diferencia entre reloj del servidor y el del dispositivo (ms)
function now(){ return new Date(Date.now() + SERVER_OFFSET).toISOString(); }
function ahoraMs(){ return Date.now() + SERVER_OFFSET; }
function fmtDate(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString('es-CO')+' '+d.toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'}); }
function fmtMoney(n){ return '$ '+(Math.round(n)||0).toLocaleString('es-CO'); }
function uid(){ return '_'+Math.random().toString(36).substr(2,9); }
// today() usa el MISMO instante y formato que now() (la fecha ISO del servidor),
// así el filtro "de hoy" coincide exactamente con la fecha guardada en cada pedido.
function today(){ return new Date(Date.now() + SERVER_OFFSET).toISOString().split('T')[0]; }
// ¿La venta es del mismo "día de operación"? Compara la parte de fecha (YYYY-MM-DD) del ISO.
function esDeHoy(v){ return (v.fecha||'').slice(0,10) === today(); }
function escapeHtml(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
// Una venta cuenta como ingreso solo si ya fue cobrada (pagada). Las mesas 'abierta' no suman.
function esPagada(v){ return v.estado==='pagada'; }
// ============================================================
// MÓDULO DE PAGOS Y CAJA — RECONSTRUIDO LIMPIO (v2)
// ============================================================
// REGLAS (confirmadas por el dueño):
// 1. Venta (comida): es el ingreso del negocio. Se reparte entre métodos.
// 2. Propina: va al mesero. NO entra a caja, NO suma a ventas.
// 3. Recargo datáfono: cubre el datáfono. NO entra a caja, NO es del negocio.
// 4. Domicilio EN EFECTIVO: el cliente le paga directo al domiciliario. NO entra a caja.
// 5. Domicilio POR BANCO: entra al banco; se le paga al domiciliario en EFECTIVO del cajón
//    → ese efectivo SALE de la caja (se descuenta automáticamente).
//
// Cada venta pagada guarda:
//   v.comida      = valor de la comida (= v.total)
//   v.propina     = propina (al mesero)
//   v.recargo     = recargo datáfono
//   v.valorDom    = valor del domicilio
//   v.domPorBanco = true si el domicilio entró por banco (se paga al domiciliario en efectivo)
//   v.pagosVenta  = {efectivo,banco,tarjeta} → reparto SOLO de la comida por método
//   v.pagosExtra  = {efectivo,banco,tarjeta} → reparto de propina+recargo+domicilio-banco por método

// Efectivo (de COMIDA) que se queda en el cajón por esta venta.
function efectivoEnCajaDe(v){
  if(v.estado!=='pagada') return 0;
  if(v.pagosVenta && typeof v.pagosVenta==='object') return v.pagosVenta.efectivo||0;
  // Respaldo para ventas viejas
  if(v.pagos && typeof v.pagos==='object') return v.pagos.efectivo||0;
  if(v.metodo==='efectivo') return v.total||0;
  return 0;
}
// Venta (comida) recibida por un método específico. Esto es lo que muestran las tarjetas.
function montoPorMetodoDe(v, metodo){
  if(v.estado!=='pagada') return 0;
  if(v.pagosVenta && typeof v.pagosVenta==='object') return v.pagosVenta[metodo]||0;
  if(v.pagos && typeof v.pagos==='object') return v.pagos[metodo]||0;
  return v.metodo===metodo ? (v.total||0) : 0;
}
// Domicilio que entró por banco y se le pagó al domiciliario en efectivo del cajón.
// Ese efectivo SALE de la caja, así que se descuenta del efectivo esperado.
function domicilioSalidaEfectivo(v){
  if(v.estado!=='pagada') return 0;
  if(v.valorDom>0 && v.domPorBanco) return v.valorDom;
  return 0;
}
// Métodos de pago del sistema (solo los que usa el negocio: Efectivo, Banco, Tarjeta)
const METODOS_PAGO = [['efectivo','Efectivo'],['banco','Banco'],['tarjeta','Tarjeta']];
function opcionesMetodo(sel){ return METODOS_PAGO.map(([v,l])=>`<option value="${v}" ${sel===v?'selected':''}>${l}</option>`).join(''); }
function nombreMetodo(m){ const f=METODOS_PAGO.find(x=>x[0]===m); return f?f[1]:(m||'—'); }

function nextFactura(){ const n=(DB.get('factura_seq')||0)+1; DB.set('factura_seq',n); return 'PI-'+String(n).padStart(6,'0'); }
// Número de orden para cocina, se reinicia cada día (#001, #002...)
function nextOrden(){
  // El número de orden de cocina vive dentro de la caja abierta.
  // Cada vez que se abre caja empieza en 1; al cerrar se descarta.
  const c=DB.get('caja_actual');
  if(!c) return 1; // sin caja no debería ocurrir, pero por seguridad
  c.ordenSeq=(c.ordenSeq||0)+1;
  DB.set('caja_actual',c);
  return c.ordenSeq;
}

function toast(msg,type='info'){
  const el=document.createElement('div');
  el.className='toast '+type;
  const icon = type==='success'?'i-check':type==='error'?'i-warning':'i-bell';
  el.innerHTML = ic(icon)+'<span>'+escapeHtml(msg)+'</span>';
  document.getElementById('toast-container').appendChild(el);
  setTimeout(()=>el.remove(),3500);
  if(type==='success') sonidoExito(); else if(type==='error') sonidoError();
}
function openModal(id){ const m=document.getElementById(id); if(m) m.style.display='flex'; }
function closeModal(id){ const m=document.getElementById(id); if(m) m.style.display='none'; }
function togglePass(id,btn){ const i=document.getElementById(id); if(i.type==='password'){i.type='text';btn.innerHTML=ic('i-eye-off');}else{i.type='password';btn.innerHTML=ic('i-eye');} }

function logAudit(accion,detalle=''){
  const logs=DB.get('auditoria')||[];
  logs.unshift({id:uid(),usuario:STATE.user?.nombre||'?',accion,detalle,fecha:now(),ip:'local'});
  DB.set('auditoria',logs.slice(0,1000));
}

// ========================= INIT DATA =========================
function initData(){
  if(!DB.get('usuarios')) DB.set('usuarios',[
    {id:'u1',nombre:'Administrador',usuario:'admin',pass:'admin123',rol:'admin',activo:true,creado:now()},
    {id:'u2',nombre:'Carlos Cajero',usuario:'cajero1',pass:'caja123',rol:'cajero',activo:true,creado:now()},
    {id:'u3',nombre:'Cocina',usuario:'cocina',pass:'cocina123',rol:'cocina',activo:true,creado:now()},
    {id:'u4',nombre:'Biometría',usuario:'biometria',pass:'biometria123',rol:'biometria',activo:true,creado:now()},
    {id:'u5',nombre:'Impresiones',usuario:'impresiones',pass:'impresiones123',rol:'impresiones',activo:true,creado:now()},
    {id:'u6',nombre:'Jefe',usuario:'jefe',pass:'jefe123',rol:'jefe',activo:true,creado:now()},
  ]);
  if(!DB.get('productos')) DB.set('productos',[
    {id:'p1',nombre:'Rollos Primavera',precio:10000,cat:'Entremeses',activo:true},
    {id:'p2',nombre:'Chowfan Especial',precio:18000,cat:'Chowfan',activo:true},
    {id:'p3',nombre:'Chopsuey de Pollo',precio:17000,cat:'Chopsuey',activo:true},
    {id:'p4',nombre:'Lomein Especial',precio:18000,cat:'Lomein',activo:true},
    {id:'p5',nombre:'Plato Combinado #1',precio:22000,cat:'Platos Combinados',activo:true},
    {id:'p6',nombre:'Costilla BBQ',precio:28000,cat:'Costillas',activo:true},
    {id:'p7',nombre:'Pollo Agridulce',precio:22000,cat:'Pollo',activo:true},
    {id:'p8',nombre:'Plato Personal Pollo',precio:15000,cat:'Platos Personales',activo:true},
    {id:'p9',nombre:'Combo Familiar 4 Personas',precio:60000,cat:'Combos Familiares',activo:true},
    {id:'p10',nombre:'Gaseosa',precio:4000,cat:'Bebidas',activo:true},
    {id:'p11',nombre:'Promo del Mes',precio:20000,cat:'Promo del Mes',activo:true},
    {id:'p12',nombre:'Porción Arroz',precio:6000,cat:'Adicionales',activo:true},
  ]);
  if(!DB.get('ventas')) DB.set('ventas',[]);
  if(!DB.get('clientes')) DB.set('clientes',[]);
  if(!DB.get('cierres')) DB.set('cierres',[]);
  if(!DB.get('auditoria')) DB.set('auditoria',[]);
  if(!DB.get('domiciliarios')) DB.set('domiciliarios',[
    {id:'d1',nombre:'Juan Pérez',activo:true},
    {id:'d2',nombre:'Carlos Gómez',activo:true},
    {id:'d3',nombre:'Luis Rodríguez',activo:true},
  ]);
  if(!('caja_actual' in CACHE)) DB.set('caja_actual',null);
  if(!DB.get('factura_seq')) DB.set('factura_seq',0);
  if(!DB.get('empleados')) DB.set('empleados',[
    {id:'e1',nombre:'Carlos Gómez',cedula:'1098765432',codigo:'1234',activo:true},
  ]);
  if(!DB.get('marcaciones')) DB.set('marcaciones',[]);
  // Asegurar que exista el usuario de biometría aunque ya haya usuarios guardados
  (function(){ const us=DB.get('usuarios')||[]; let ch=false;
    const bio=us.find(u=>u.usuario==='biometria');
    if(!bio){ us.push({id:uid(),nombre:'Biometría',usuario:'biometria',pass:'biometria123',rol:'biometria',activo:true,creado:now()}); ch=true; }
    else if(bio.rol!=='biometria'){ bio.rol='biometria'; ch=true; }
    const imp=us.find(u=>u.usuario==='impresiones');
    if(!imp){ us.push({id:uid(),nombre:'Impresiones',usuario:'impresiones',pass:'impresiones123',rol:'impresiones',activo:true,creado:now()}); ch=true; }
    else if(imp.rol!=='impresiones'){ imp.rol='impresiones'; ch=true; }
    const jefe=us.find(u=>u.usuario==='jefe');
    if(!jefe){ us.push({id:uid(),nombre:'Jefe',usuario:'jefe',pass:'jefe123',rol:'jefe',activo:true,creado:now()}); ch=true; }
    else if(jefe.rol!=='jefe'){ jefe.rol='jefe'; ch=true; }
    if(ch) DB.set('usuarios',us);
  })();
  if(!DB.get('config')) DB.set('config',{
    nombre:'Portal Imperial', nit:'900.123.456-7', dir:'Calle 10 #5-20', tel:'(7) 633 0000',
    numMesas:25, permitirEliminarDomicilio:true, permitirEliminarMesa:false, permitirEliminarLlevar:false,
    gpsActivo:false, gpsLat:0, gpsLng:0, gpsRadio:100, logo:(window.LOGO_DEFAULT||''),
    marcaAgua:'WALLACE COMPANY SYSTEM ING CCIA ROLDAN A.', marcaAguaActiva:true,
    qzActivo:false, qzImpresora:'POS printer 203DPI series'
  });
  // Si ya existe config pero sin logo, poner el logo por defecto
  (function(){ const c=DB.get('config')||{}; if(!c.logo && window.LOGO_DEFAULT){ c.logo=window.LOGO_DEFAULT; DB.set('config',c); } })();
}

// ========================= STATE =========================
const STATE = { user:null, page:'dashboard', order:[], descuento:0, descMot:'',
  tipoPedido:'mesa', mesa:'', cliNombre:'', cliTel:'', cliDir:'', cliBarrio:'', valorDom:0, propina:0, recargo:0, metodoVenta:'efectivo', orderObs:'', editandoVenta:null };

// ========================= AUTH =========================
function doLogin(){
  const u=document.getElementById('login-user').value.trim();
  const p=document.getElementById('login-pass').value;
  const user=(DB.get('usuarios')||[]).find(x=>x.usuario===u && x.pass===p && x.activo);
  if(!user){ const e=document.getElementById('login-error'); e.textContent='Usuario o contraseña incorrectos.'; e.style.display='block'; return; }
  STATE.user=user;
  document.getElementById('login-user').value='';
  document.getElementById('login-pass').value='';
  document.getElementById('login-error').style.display='none';
  // Usuario biometría: va directo a la pantalla de marcación, no entra al sistema
  if(user.rol==='biometria' || user.usuario==='biometria'){
    logAudit('Abrió pantalla de biometría');
    mostrarAsistencia();
    return;
  }
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  document.getElementById('user-name-sb').textContent=user.nombre;
  document.getElementById('user-role-sb').textContent=user.rol.charAt(0).toUpperCase()+user.rol.slice(1);
  document.getElementById('user-avatar-sb').textContent=user.nombre.charAt(0).toUpperCase();
  // Logo en el sidebar
  const logoSb=(DB.get('config')||{}).logo||window.LOGO_DEFAULT;
  if(logoSb){ const img=document.getElementById('sidebar-logo-img'); const fb=document.getElementById('sidebar-logo-fallback');
    if(img){ img.src=logoSb; img.style.display='block'; } if(fb) fb.style.display='none'; }
  buildSidebar();
  logAudit('Inicio de sesión');
  const landing = user.rol==='cocina'?'cocina' : (user.rol==='mesero')?'ventas' : (user.rol==='cajero')?'caja' : (user.rol==='impresiones')?'impresiones' : 'dashboard';
  showPage(landing);
}
function doLogout(){
  if(STATE.user) logAudit('Cierre de sesión');
  STATE.user=null; STATE.order=[];
  document.getElementById('login-user').value='';
  document.getElementById('login-pass').value='';
  document.getElementById('login-error').style.display='none';
  document.getElementById('app').style.display='none';
  document.getElementById('login-screen').style.display='flex';
}
function doRecovery(){
  const code=document.getElementById('rec-code').value;
  if(code==='9999'){ toast('Contacte al administrador para restablecer su contraseña.','success'); closeModal('modal-recovery'); }
  else toast('Código incorrecto.','error');
}

// ========================= CONTROL DE ASISTENCIA =========================
function mostrarAsistencia(){
  // Mostrar la pantalla de marcación sobre el login
  document.getElementById('app').style.display='none';
  document.getElementById('login-screen').style.display='flex';
  document.querySelector('#login-screen .login-card').style.display='none';
  document.getElementById('asistencia-card').style.display='block';
  document.getElementById('asis-cedula').value='';
  document.getElementById('asis-codigo').value='';
  document.getElementById('asis-msg').style.display='none';
}
function salirAsistencia(){
  // Cierra sesión y vuelve al login normal
  STATE.user=null;
  document.getElementById('asistencia-card').style.display='none';
  document.querySelector('#login-screen .login-card').style.display='block';
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('app').style.display='none';
}
function asisMsg(txt,ok){
  const el=document.getElementById('asis-msg');
  el.textContent=txt; el.style.color=ok?'#2ECC71':'var(--red-light)'; el.style.display='block';
}
function distanciaMetros(lat1,lng1,lat2,lng2){
  const R=6371000, rad=Math.PI/180;
  const dLat=(lat2-lat1)*rad, dLng=(lng2-lng1)*rad;
  const a=Math.sin(dLat/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function marcar(tipo){
  const ced=document.getElementById('asis-cedula').value.trim();
  const cod=document.getElementById('asis-codigo').value.trim();
  if(!ced||!cod){ asisMsg('Ingrese cédula y código.',false); return; }
  const emp=(DB.get('empleados')||[]).find(e=>e.cedula===ced && e.codigo===cod && e.activo);
  if(!emp){ asisMsg('Cédula o código incorrectos.',false); return; }
  registrarMarcacion(emp,tipo);
}
function registrarMarcacion(emp,tipo){
  const marcs=DB.get('marcaciones')||[];
  const hoyStr=today();
  const ultimaHoy=marcs.filter(m=>m.empId===emp.id && m.fecha.startsWith(hoyStr)).sort((a,b)=>new Date(b.fecha)-new Date(a.fecha))[0];
  if(ultimaHoy && ultimaHoy.tipo===tipo){ asisMsg(`Ya registró ${tipo} hace un momento.`,false); return; }
  marcs.unshift({id:uid(),empId:emp.id,nombre:emp.nombre,cedula:emp.cedula,tipo,fecha:now()});
  DB.set('marcaciones',marcs);
  const hora=new Date(ahoraMs()).toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'});
  asisMsg(`${emp.nombre}: ${tipo.toUpperCase()} registrada a las ${hora}`,true);
  document.getElementById('asis-cedula').value='';
  document.getElementById('asis-codigo').value='';
  // La pantalla queda abierta para el siguiente empleado. Se cierra con el botón "Salir".
  setTimeout(()=>{ const el=document.getElementById('asis-msg'); if(el) el.style.display='none'; }, 6000);
}

// ========================= SIDEBAR =========================
const NAV = [
  {sec:'Principal'},
  {id:'dashboard',icon:'i-dashboard',label:'Dashboard',roles:['admin','supervisor','jefe']},
  {id:'ventas',icon:'i-cart',label:'Nueva Venta',roles:['admin','cajero','supervisor','mesero','jefe']},
  {id:'pedidos',icon:'i-orders',label:'Pedidos',roles:['admin','cajero','supervisor','mesero','impresiones','jefe'],badge:'activos'},
  {id:'listos',icon:'i-ready',label:'Pedidos Listos',roles:['admin','cajero','supervisor','mesero','jefe'],badge:'listos'},
  {sec:'Operaciones'},
  {id:'caja',icon:'i-cash',label:'Caja',roles:['admin','cajero','supervisor','jefe']},
  {id:'domicilios',icon:'i-delivery',label:'Domicilios',roles:['admin','cajero','supervisor','mesero','jefe']},
  {id:'cocina',icon:'i-chef',label:'Cocina',roles:['admin','cocina','supervisor','jefe'],badge:'cocina'},
  {id:'tiempos',icon:'i-clock',label:'Tiempos de Entrega',roles:['admin','cajero','supervisor','mesero','cocina','jefe']},
  {id:'impresiones',icon:'i-orders',label:'Impresiones',roles:['admin','cajero','supervisor','impresiones','jefe']},
  {sec:'Gestión'},
  {id:'usuarios',icon:'i-users',label:'Usuarios',roles:['admin']},
  {id:'historial',icon:'i-history',label:'Historial',roles:['admin','supervisor','jefe']},
  {id:'reportes',icon:'i-report',label:'Reportes',roles:['admin','supervisor','jefe']},
  {id:'auditoria',icon:'i-audit',label:'Auditoría',roles:['admin']},
  {id:'asistencia',icon:'i-clock',label:'Asistencia',roles:['admin','supervisor','jefe']},
  {id:'menu',icon:'i-menu-food',label:'Menú',roles:['admin','supervisor','jefe']},
  {id:'config',icon:'i-settings',label:'Configuración',roles:['admin']},
];
function buildSidebar(){
  const rol=STATE.user.rol;
  let html='';
  NAV.forEach(n=>{
    if(n.sec){ html+=`<div class="nav-section">${n.sec}</div>`; return; }
    if(!n.roles.includes(rol)) return;
    html+=`<div class="nav-item" id="nav-${n.id}" onclick="showPage('${n.id}')">${ic(n.icon)}<span>${n.label}</span><span class="nav-badge" id="badge-${n.id}" style="display:none"></span></div>`;
  });
  document.getElementById('sidebar-nav').innerHTML=html;
  updateBadges();
}
function updateBadges(){
  const vs=DB.get('ventas')||[];
  const counts={
    activos: vs.filter(v=>v.estado!=='anulada' && v.estadoPedido!=='entregado').length,
    listos: vs.filter(v=>v.estadoCocina==='listo' && v.estadoPedido!=='entregado' && v.estado!=='anulada').length,
    cocina: vs.filter(v=>v.estado!=='anulada' && v.estadoPedido!=='entregado' && v.estadoCocina!=='listo').length,
  };
  ['activos','listos','cocina'].forEach(k=>{
    NAV.filter(n=>n.badge===k).forEach(n=>{
      const b=document.getElementById('badge-'+n.id);
      if(b){ if(counts[k]>0){ b.textContent=counts[k]; b.style.display='flex'; } else b.style.display='none'; }
    });
  });
}

// ========================= NAVIGATION =========================
const PAGE_META={
  dashboard:['i-dashboard','Dashboard'], ventas:['i-cart','Nueva Venta'], pedidos:['i-orders','Pedidos'],
  listos:['i-ready','Pedidos Listos'], caja:['i-cash','Caja'], domicilios:['i-delivery','Domicilios'],
  cocina:['i-chef','Pantalla de Cocina'], usuarios:['i-users','Usuarios'], historial:['i-history','Historial'],
  reportes:['i-report','Reportes'], auditoria:['i-audit','Auditoría'], menu:['i-menu-food','Menú'], config:['i-settings','Configuración'],
  asistencia:['i-clock','Control de Asistencia'],
  tiempos:['i-clock','Tiempos de Entrega'],
  impresiones:['i-orders','Impresiones']
};
function showPage(name){
  STATE.page=name;
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
  document.getElementById('nav-'+name)?.classList.add('active');
  const m=PAGE_META[name]||['i-dashboard',name];
  document.getElementById('page-title').innerHTML=ic(m[0])+' '+m[1];
  document.getElementById('sidebar').classList.remove('open');
  const fns={dashboard,ventas,pedidos,listos,caja,domicilios,cocina,usuarios,historial,reportes,auditoria,menu,config,asistencia,tiempos,impresiones};
  document.getElementById('content').innerHTML = fns[name] ? fns[name]() : '<p class="text-gray">Página no encontrada.</p>';
  if(name==='ventas'){ ESCRIBIENDO=true; STATE.order=STATE.order||[]; renderTipoPedido(); renderOrderPanel(); }
  else { ESCRIBIENDO=false; }
  updateBadges();
}

// ========================= DASHBOARD =========================
function dashboard(){
  const vs=DB.get('ventas')||[]; const t=today();
  const hoy=vs.filter(v=>v.fecha?.startsWith(t)&&esPagada(v));
  const totalHoy=hoy.reduce((a,v)=>a+v.total,0);
  const weekAgo=new Date(Date.now()-7*864e5).toISOString().split('T')[0];
  const sem=vs.filter(v=>v.fecha>=weekAgo&&esPagada(v));
  const ma=new Date(); ma.setDate(1);
  const mes=vs.filter(v=>v.fecha>=ma.toISOString().split('T')[0]&&esPagada(v));
  const activos=vs.filter(v=>v.estadoPedido==='activo'&&v.estado!=='anulada').length;
  const entregados=vs.filter(v=>v.estadoPedido==='entregado').length;
  const metodos={}; METODOS_PAGO.forEach(([k])=>metodos[k]=0);
  hoy.forEach(v=>{ if(metodos[v.metodo]!==undefined) metodos[v.metodo]+=(v.ventaReal!==undefined?v.ventaReal:v.total); });
  const days=[];
  for(let i=6;i>=0;i--){ const d=new Date(Date.now()-i*864e5); const dk=d.toISOString().split('T')[0];
    days.push({lbl:d.toLocaleDateString('es-CO',{weekday:'short'}), tot:vs.filter(v=>v.fecha?.startsWith(dk)&&esPagada(v)).reduce((a,v)=>a+v.total,0)}); }
  const mx=Math.max(...days.map(d=>d.tot),1);
  const bars=days.map(d=>`<div class="bar-item"><div class="bar-val">${d.tot>0?(d.tot/1000).toFixed(0)+'k':''}</div><div class="bar-fill" style="height:${Math.max(4,(d.tot/mx)*90)}px"></div><div class="bar-label">${d.lbl}</div></div>`).join('');
  return `
  <div class="stats-grid">
    <div class="stat-card red"><div class="stat-icon">${ic('i-cash')}</div><div class="stat-label">Ventas Hoy</div><div class="stat-value">${fmtMoney(totalHoy)}</div><div class="stat-sub">${hoy.length} pedidos</div></div>
    <div class="stat-card gold"><div class="stat-icon">${ic('i-history')}</div><div class="stat-label">Esta Semana</div><div class="stat-value">${fmtMoney(sem.reduce((a,v)=>a+v.total,0))}</div><div class="stat-sub">${sem.length} pedidos</div></div>
    <div class="stat-card green"><div class="stat-icon">${ic('i-report')}</div><div class="stat-label">Este Mes</div><div class="stat-value">${fmtMoney(mes.reduce((a,v)=>a+v.total,0))}</div><div class="stat-sub">${mes.length} pedidos</div></div>
    <div class="stat-card blue"><div class="stat-icon">${ic('i-bell')}</div><div class="stat-label">Pedidos Activos</div><div class="stat-value">${activos}</div><div class="stat-sub">${entregados} entregados</div></div>
  </div>
  <div class="grid-2">
    <div class="card"><div class="card-title">${ic('i-report')} Ventas Últimos 7 Días</div><div class="bar-chart">${bars}</div></div>
    <div class="card"><div class="card-title">${ic('i-cash')} Métodos de Pago (Hoy)</div>
      ${METODOS_PAGO.map(([k,l])=>`<div class="flex-between" style="padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.04)"><span class="text-sm">${l}</span><span class="text-gold font-bold">${fmtMoney(metodos[k])}</span></div>`).join('')}
    </div>
  </div>
  <div class="card"><div class="card-title">${ic('i-history')} Últimas Ventas</div>
    ${vs.length===0?`<div class="empty-state">${ic('i-empty')}<p>No hay ventas aún</p></div>`:
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Pedido</th><th>Tipo</th><th>Cliente/Mesa</th><th>Método</th><th>Total</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>
    ${vs.slice(0,10).map(v=>`<tr><td><span class="text-gold font-bold">${refPedido(v)}</span></td><td>${tipoLabel(v.tipo)}</td><td>${escapeHtml(v.cliNombre||v.mesa||'—')}</td><td>${v.metodo||'—'}</td><td class="font-bold">${fmtMoney(v.total)}</td><td>${estadoBadge(v.estado)}</td><td class="text-xs text-gray">${fmtDate(v.fecha)}</td></tr>`).join('')}
    </tbody></table></div>`}
  </div>`;
}
function tipoLabel(t){ return {mesa:'Mesa',domicilio:'Domicilio',llevar:'Para llevar'}[t]||'—'; }
function refPedido(v){
  // Domicilio: nombre del cliente o mensajero, nunca número
  if(v.tipo==='domicilio') return v.cliNombre?escapeHtml(v.cliNombre):(v.domiciliario?escapeHtml(v.domiciliario):'Domicilio');
  // Mesa/llevar: si ya tiene factura la muestra, si no la orden de cocina
  if(v.factura) return v.factura;
  if(v.ordenCocina) return 'Orden #'+String(v.ordenCocina).padStart(3,'0');
  return '—';
}
// Referencia para COCINA y PEDIDOS LISTOS: nunca usa factura, siempre orden o nombre
function refCocina(v){
  if(v.tipo==='domicilio') return v.cliNombre?escapeHtml(v.cliNombre):(v.domiciliario?escapeHtml(v.domiciliario):'Domicilio');
  if(v.ordenCocina) return 'Orden #'+String(v.ordenCocina).padStart(3,'0');
  return '—';
}
function estadoBadge(e){ return e==='anulada'?`<span class="badge badge-red">Anulada</span>`:e==='pagada'?`<span class="badge badge-green">Pagada</span>`:e==='abierta'?`<span class="badge badge-orange">Abierta</span>`:`<span class="badge badge-gold">${e||'activa'}</span>`; }

// ========================= VENTAS (POS) =========================
function ventas(){
  // Obligar a abrir caja antes de vender. NADIE vende si no hay caja abierta.
  if(!DB.get('caja_actual')){
    const esMesero = STATE.user.rol==='mesero';
    return `<div class="card" style="max-width:520px;margin:40px auto;text-align:center;padding:40px;">
      <div style="font-size:48px;color:var(--gold);margin-bottom:12px;">${ic('i-lock')}</div>
      <h2 style="font-family:Cinzel,serif;color:var(--gold);margin-bottom:12px;">Caja cerrada</h2>
      ${esMesero
        ? `<p class="text-gray mb-2">No se puede vender porque la caja está cerrada. Avise al <strong>cajero o administrador</strong> para que abra la caja. Usted no puede abrir caja.</p>`
        : `<p class="text-gray mb-2">No puede registrar ventas sin antes abrir la caja con el fondo inicial. Esto es necesario para que el cuadre de caja al final del día sea correcto.</p>
           <button class="btn btn-gold" onclick="showPage('caja')" style="padding:13px 30px;">${ic('i-lock')} Ir a Abrir Caja</button>`}
    </div>`;
  }
  const prods=(DB.get('productos')||[]).filter(p=>p.activo);
  const cats=['Todos',...new Set(prods.map(p=>p.cat))];
  const clientes=DB.get('clientes')||[];
  const editing=STATE.editandoVenta;
  return `
  <div class="pos-layout">
    <div style="display:flex;flex-direction:column;gap:12px;overflow:hidden;">
      <div style="position:relative;"><span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--gray3)">${ic('i-search')}</span>
      <input type="text" id="search-prod" placeholder="Buscar producto..." oninput="filterMenu()" style="padding-left:38px;"></div>
      <div class="category-tabs" id="cat-tabs">${cats.map((c,i)=>`<button class="cat-tab${i===0?' active':''}" onclick="setCat('${c}',this)">${c}</button>`).join('')}</div>
      <div class="menu-grid" id="menu-grid">${prods.map(menuCard).join('')}</div>
    </div>
    <div class="order-panel">
      <div class="order-head">
        <div class="flex-between mb-2"><span class="card-title" style="margin:0;">${ic('i-cart')} ${editing?'Editar '+editing.factura:'Pedido'}</span><button class="btn btn-ghost btn-sm" onclick="clearOrder()">${ic('i-trash')}</button></div>
        <div class="tipo-toggle" id="tipo-toggle"></div>
        <div id="campos-tipo"></div>
        <input type="text" placeholder="Observaciones del pedido..." id="order-obs" class="mini-input" oninput="STATE.orderObs=this.value" value="${escapeHtml(STATE.orderObs)}">
      </div>
      <div class="order-items" id="order-items"></div>
      <div class="order-summary" id="order-summary"></div>
    </div>
  </div>
  <datalist id="clientes-list">${clientes.map(c=>`<option value="${escapeHtml(c.nombre)}" data-id="${c.id}">`).join('')}</datalist>`;
}
function menuCard(p){
  if(p.agotado){
    return `<div class="menu-item-card" style="opacity:0.5;cursor:not-allowed;position:relative;" onclick="toast('${escapeHtml(p.nombre)} está AGOTADO hoy','error')"><div class="item-ic">${ic('i-menu-food')}</div><div class="item-name">${escapeHtml(p.nombre)}</div><div class="item-price" style="color:var(--red-light);font-weight:bold;">AGOTADO</div></div>`;
  }
  return `<div class="menu-item-card" onclick="addToOrder('${p.id}')"><div class="item-ic">${ic('i-menu-food')}</div><div class="item-name">${escapeHtml(p.nombre)}</div><div class="item-price">${fmtMoney(p.precio)}</div></div>`;
}

let currentCat='Todos';
function setCat(c,el){ currentCat=c; document.querySelectorAll('.cat-tab').forEach(t=>t.classList.remove('active')); el.classList.add('active'); filterMenu(); }
function filterMenu(){
  const q=(document.getElementById('search-prod')?.value||'').toLowerCase();
  const prods=(DB.get('productos')||[]).filter(p=>p.activo && (currentCat==='Todos'||p.cat===currentCat) && (!q||p.nombre.toLowerCase().includes(q)));
  const g=document.getElementById('menu-grid');
  if(g) g.innerHTML=prods.map(menuCard).join('')||'<p class="text-gray text-sm" style="padding:20px;">Sin resultados</p>';
}

function renderTipoPedido(){
  const tt=document.getElementById('tipo-toggle'); if(!tt) return;
  const tipos=[['mesa','i-table','Mesa'],['llevar','i-bag','Llevar'],['domicilio','i-delivery','Domicilio']];
  tt.innerHTML=tipos.map(([t,i,l])=>`<button class="btn btn-sm ${STATE.tipoPedido===t?'btn-gold':'btn-ghost'}" onclick="setTipoPedido('${t}')">${ic(i)} ${l}</button>`).join('');
  renderCamposTipo();
}
function setTipoPedido(t){ STATE.tipoPedido=t; renderTipoPedido(); }
function renderCamposTipo(){
  const c=document.getElementById('campos-tipo'); if(!c) return;
  const cfg=DB.get('config')||{}; const nMesas=cfg.numMesas||25;
  let html='';
  if(STATE.tipoPedido==='mesa'){
    html=`<select class="mini-input" style="margin-bottom:8px;" onchange="STATE.mesa=this.value"><option value="">Seleccionar mesa...</option>${Array.from({length:nMesas},(_,i)=>`<option value="Mesa ${i+1}" ${STATE.mesa==='Mesa '+(i+1)?'selected':''}>Mesa ${i+1}</option>`).join('')}</select>`;
  } else if(STATE.tipoPedido==='llevar'){
    html=`<input type="tel" class="mini-input" style="margin-bottom:6px;" placeholder="Teléfono (busca cliente)" value="${escapeHtml(STATE.cliTel)}" oninput="STATE.cliTel=this.value;autoFillPorTel(this.value)">
    <input type="text" class="mini-input" list="clientes-list" style="margin-bottom:8px;" placeholder="Nombre del cliente *" value="${escapeHtml(STATE.cliNombre)}" oninput="STATE.cliNombre=this.value;autoFillCliente(this.value)">`;
  } else if(STATE.tipoPedido==='domicilio'){
    html=`<input type="tel" class="mini-input" style="margin-bottom:6px;" placeholder="Teléfono * (busca cliente)" value="${escapeHtml(STATE.cliTel)}" oninput="STATE.cliTel=this.value;autoFillPorTel(this.value)">
    <input type="text" class="mini-input" list="clientes-list" style="margin-bottom:6px;" placeholder="Nombre del cliente *" value="${escapeHtml(STATE.cliNombre)}" oninput="STATE.cliNombre=this.value;autoFillCliente(this.value)">
    <input type="text" class="mini-input" style="margin-bottom:6px;" placeholder="Dirección *" value="${escapeHtml(STATE.cliDir)}" oninput="STATE.cliDir=this.value">
    <input type="text" class="mini-input" style="margin-bottom:6px;" placeholder="Barrio" value="${escapeHtml(STATE.cliBarrio)}" oninput="STATE.cliBarrio=this.value">
    <input type="number" class="mini-input" style="margin-bottom:8px;" placeholder="Valor domicilio *" value="${STATE.valorDom||''}" oninput="STATE.valorDom=parseFloat(this.value)||0;renderOrderPanel()">`;
  }
  c.innerHTML=html;
}
function autoFillPorTel(tel){
  if(!tel||tel.length<6) return;
  const cl=(DB.get('clientes')||[]).find(c=>c.tel===tel);
  if(cl){ STATE.cliNombre=cl.nombre||''; STATE.cliDir=cl.dir||''; STATE.cliBarrio=cl.barrio||'';
    renderCamposTipo(); toast('Cliente encontrado: '+cl.nombre,'success'); }
}
function autoFillCliente(nombre){
  const cl=(DB.get('clientes')||[]).find(c=>c.nombre.toLowerCase()===nombre.toLowerCase());
  if(cl){ STATE.cliTel=cl.tel||''; STATE.cliDir=cl.dir||''; STATE.cliBarrio=cl.barrio||''; renderCamposTipo(); }
}

function addToOrder(id){
  const p=(DB.get('productos')||[]).find(x=>x.id===id); if(!p) return;
  if(p.agotado){ toast(`${p.nombre} está AGOTADO hoy`,'error'); return; }
  const e=STATE.order.find(x=>x.id===id);
  if(e) e.qty++; else STATE.order.push({id,nombre:p.nombre,precio:p.precio,qty:1,obs:''});
  renderOrderPanel();
}
function removeFromOrder(id){ STATE.order=STATE.order.filter(x=>x.id!==id); renderOrderPanel(); }
function changeQty(id,d){ const i=STATE.order.find(x=>x.id===id); if(i){ i.qty=Math.max(1,i.qty+d); renderOrderPanel(); } }
function setItemObs(id,v){ const i=STATE.order.find(x=>x.id===id); if(i) i.obs=v; }
function clearOrder(){ STATE.order=[]; STATE.descuento=0; STATE.descMot=''; STATE.cliNombre=''; STATE.cliTel=''; STATE.cliDir=''; STATE.cliBarrio=''; STATE.valorDom=0; STATE.propina=0; STATE.recargo=0; STATE.metodoVenta='efectivo'; STATE.mesa=''; STATE.orderObs=''; STATE.editandoVenta=null;
  const o=document.getElementById('order-obs'); if(o)o.value=''; renderCamposTipo(); renderOrderPanel(); }

function renderOrderPanel(){
  const itemsEl=document.getElementById('order-items'), sumEl=document.getElementById('order-summary');
  if(!itemsEl) return;
  if(STATE.order.length===0){ itemsEl.innerHTML=`<div class="empty-state">${ic('i-cart')}<p>Seleccione productos</p></div>`; sumEl.innerHTML=''; return; }
  itemsEl.innerHTML=STATE.order.map(item=>`
    <div class="order-item-row">
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;">${escapeHtml(item.nombre)}</div>
        <input type="text" placeholder="Sin observaciones..." value="${escapeHtml(item.obs||'')}" oninput="setItemObs('${item.id}',this.value)" style="width:100%;margin-top:2px;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.08);color:var(--gray3);font-size:11px;outline:none;padding:2px 0;">
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <button class="btn btn-icon btn-ghost btn-sm" onclick="changeQty('${item.id}',-1)" style="width:24px;height:24px;padding:0;">−</button>
        <span style="font-size:13px;font-weight:700;min-width:18px;text-align:center;">${item.qty}</span>
        <button class="btn btn-icon btn-ghost btn-sm" onclick="changeQty('${item.id}',1)" style="width:24px;height:24px;padding:0;">+</button>
      </div>
      <div style="min-width:72px;text-align:right;">
        <div style="font-size:12px;font-weight:700;color:var(--gold);">${fmtMoney(item.precio*item.qty)}</div>
        <button onclick="removeFromOrder('${item.id}')" style="background:none;border:none;color:var(--gray2);cursor:pointer;font-size:11px;">quitar</button>
      </div>
    </div>`).join('');
  const subtotal=STATE.order.reduce((a,i)=>a+i.precio*i.qty,0);
  const dom=STATE.tipoPedido==='domicilio'?(STATE.valorDom||0):0;
  const desc=STATE.descuento||0;
  const total=Math.max(0,subtotal+dom-desc);
  sumEl.innerHTML=`
    <div class="flex-between text-sm"><span class="text-gray">Subtotal</span><span>${fmtMoney(subtotal)}</span></div>
    ${dom>0?`<div class="flex-between text-sm"><span class="text-gray">Domicilio</span><span>${fmtMoney(dom)}</span></div>`:''}
    ${desc>0?`<div class="flex-between text-sm text-red"><span>Descuento ${STATE.descMot?'('+escapeHtml(STATE.descMot)+')':''}</span><span>-${fmtMoney(desc)}</span></div>`:''}
    <div class="flex-between mt-1" style="font-size:17px;font-weight:700;"><span>Total</span><span class="text-gold" id="venta-total-disp">${fmtMoney(total)}</span></div>
    <div class="flex-between mt-1 gap-2" style="flex-wrap:wrap;">
      <button class="btn btn-ghost btn-sm" onclick="openModal('modal-descuento')">${ic('i-tag')} Descuento</button>
    </div>
    ${STATE.tipoPedido==='mesa'
      ? `<button class="btn btn-gold btn-block mt-1" onclick="guardarMesa()" style="font-size:14px;padding:12px;">${ic('i-check')} ${STATE.editandoVenta?'Actualizar Mesa':'Abrir Mesa / Enviar a Cocina'}</button>
         <p class="text-xs text-gray" style="text-align:center;margin-top:6px;">La mesa queda abierta. Se cobra al final desde Pedidos.</p>`
      : (STATE.user.rol==='mesero'
        ? `<button class="btn btn-gold btn-block mt-1" onclick="guardarPedidoAbierto()" style="font-size:14px;padding:12px;">${ic('i-check')} Enviar a Cocina (sin cobrar)</button>
           <p class="text-xs text-gray" style="text-align:center;margin-top:6px;">El pedido queda abierto. El cajero lo cobra.</p>`
        : `<button class="btn btn-gold btn-block mt-1" id="btn-cobrar-venta" onclick="cobrarVenta()" style="font-size:14px;padding:12px;">${ic('i-check')} ${STATE.editandoVenta?'Guardar Cambios':'Enviar y Cobrar'}</button>
           <p class="text-xs text-gray" style="text-align:center;margin-top:6px;">Se enviará a cocina y abrirá el cobro (puede dividir el pago).</p>`)}`;
}
function actualizarTotalVenta(){
  // Actualiza solo el total mostrado y el botón, SIN redibujar (para no perder el foco al escribir)
  const subtotal=STATE.order.reduce((a,i)=>a+i.precio*i.qty,0);
  const dom=STATE.tipoPedido==='domicilio'?(STATE.valorDom||0):0;
  const total=Math.max(0,subtotal+dom-(STATE.descuento||0));
  const metodoSel=STATE.metodoVenta||'efectivo';
  const propinaV=STATE.propina||0;
  const recargoV=(metodoSel==='tarjeta')?(STATE.recargo||0):0;
  const totalCobrar=total+propinaV+recargoV;
  const disp=document.getElementById('venta-total-disp'); if(disp) disp.textContent=fmtMoney(totalCobrar);
  const btn=document.getElementById('btn-cobrar-venta'); if(btn && !STATE.editandoVenta) btn.innerHTML=`${ic('i-check')} Cobrar ${fmtMoney(totalCobrar)}`;
}
function applyDescuento(){
  const tipo=document.getElementById('desc-tipo').value, val=parseFloat(document.getElementById('desc-valor').value)||0;
  const sub=STATE.order.reduce((a,i)=>a+i.precio*i.qty,0);
  STATE.descuento=tipo==='pct'?sub*(val/100):val; STATE.descMot=document.getElementById('desc-motivo').value;
  closeModal('modal-descuento'); renderOrderPanel(); toast('Descuento aplicado','success');
}

function guardarMesa(){
  if(!DB.get('caja_actual')){ toast('Debe abrir la caja antes de vender','error'); showPage('caja'); return; }
  if(STATE.order.length===0){ toast('Agregue productos primero','error'); return; }
  if(!STATE.mesa){ toast('Seleccione una mesa','error'); return; }
  const subtotal=STATE.order.reduce((a,i)=>a+i.precio*i.qty,0);
  const total=Math.max(0,subtotal-(STATE.descuento||0));
  const vs=DB.get('ventas')||[];

  if(STATE.editandoVenta){
    // Actualizar mesa existente: marcar platos nuevos como pendientes para cocina
    const v=vs.find(x=>x.id===STATE.editandoVenta.id);
    if(v){
      v.items=[...STATE.order]; v.subtotal=subtotal; v.descuento=STATE.descuento||0; v.descMot=STATE.descMot;
      v.total=total; v.obs=STATE.orderObs; v.modificadoPor=STATE.user.nombre; v.modificadoEn=now();
      v.estadoCocina='pendiente'; // vuelve a cocina por si agregó/quitó platos
      v.ticketImpreso=false; // reimprimir comanda con los cambios
      v.reimpreso=(v.reimpreso||0)+1;
      fusionarYGuardarVentas(vs);
      logAudit('Actualizó mesa',`${v.mesa} por ${STATE.user.nombre}`);
      notifyKitchen();
      toast('Mesa actualizada y enviada a cocina','success');
      printTicketCocina(v);
    }
    clearOrder(); showPage('pedidos'); return;
  }

  // Nueva mesa abierta (sin número de factura todavía, sin cobrar)
  const venta={ id:uid(), factura:'', ordenCocina:nextOrden(), fecha:now(), tipo:'mesa', mesa:STATE.mesa,
    cliNombre:'',cliTel:'',cliDir:'',cliBarrio:'', valorDom:0,
    items:[...STATE.order], subtotal, descuento:STATE.descuento||0, descMot:STATE.descMot,
    total, metodo:'', estado:'abierta', estadoPedido:'activo', estadoCocina:'pendiente', domiciliario:'',
    obs:STATE.orderObs, cajero:STATE.user?.nombre, atendidoPor:STATE.user?.nombre, atendidoRol:STATE.user?.rol, cajaId:DB.get('caja_actual')?.id||null };
  vs.unshift(venta); fusionarYGuardarVentas(vs);
  logAudit('Abrió mesa',STATE.mesa);
  notifyKitchen();
  clearOrder();
  toast(`${venta.mesa} abierta y enviada a cocina`,'success');
  printTicketCocina(venta);
}

function guardarPedidoAbierto(){
  if(!DB.get('caja_actual')){ toast('No hay caja abierta. Avise al cajero.','error'); return; }
  if(STATE.order.length===0){ toast('Agregue productos primero','error'); return; }
  if(STATE.tipoPedido==='domicilio' && (!STATE.cliNombre||!STATE.cliTel||!STATE.cliDir)){ toast('Domicilio requiere nombre, teléfono y dirección','error'); return; }
  if(STATE.tipoPedido==='llevar' && !STATE.cliNombre){ toast('Indique el nombre del cliente','error'); return; }
  const subtotal=STATE.order.reduce((a,i)=>a+i.precio*i.qty,0);
  const dom=STATE.tipoPedido==='domicilio'?(STATE.valorDom||0):0;
  const ventaReal=Math.max(0,subtotal-(STATE.descuento||0));
  const esDomicilio = STATE.tipoPedido==='domicilio';
  const vs=DB.get('ventas')||[];
  const venta={ id:uid(),factura:'',ordenCocina: esDomicilio?null:nextOrden(),fecha:now(),tipo:STATE.tipoPedido,
    mesa:'', cliNombre:STATE.cliNombre,cliTel:STATE.cliTel,cliDir:STATE.cliDir,cliBarrio:STATE.cliBarrio,
    valorDom:dom, items:[...STATE.order], subtotal, descuento:STATE.descuento||0, descMot:STATE.descMot,
    total:ventaReal, ventaReal, propina:0, recargo:0, totalCobrado:0,
    metodo:'', estado:'abierta', estadoPedido:'activo', estadoCocina:'pendiente', domiciliario:'',
    obs:STATE.orderObs, cajero:'', mesero:STATE.user.nombre, creadoPor:STATE.user.nombre, atendidoPor:STATE.user.nombre, atendidoRol:STATE.user.rol, cajaId:DB.get('caja_actual')?.id||null };
  vs.unshift(venta); fusionarYGuardarVentas(vs);
  if(esDomicilio){
    const cls=DB.get('clientes')||[]; const ex=cls.find(c=>c.tel===STATE.cliTel);
    if(ex){ ex.pedidos=(ex.pedidos||0)+1; ex.nombre=STATE.cliNombre; ex.dir=STATE.cliDir; ex.barrio=STATE.cliBarrio; } else cls.unshift({id:uid(),nombre:STATE.cliNombre,tel:STATE.cliTel,dir:STATE.cliDir,barrio:STATE.cliBarrio,pedidos:1,creado:now()});
    DB.set('clientes',cls);
  }
  logAudit('Mesero creó pedido',`${esDomicilio?STATE.cliNombre:'Orden '+venta.ordenCocina} por ${STATE.user.nombre}`);
  notifyKitchen(); clearOrder();
  toast('Pedido enviado a cocina. El cajero lo cobrará.','success');
  printTicketCocina(venta);
}
function cobrarVenta(){
  if(!DB.get('caja_actual')){ toast('Debe abrir la caja antes de vender','error'); showPage('caja'); return; }
  if(STATE.order.length===0){ toast('Agregue productos primero','error'); return; }
  if(STATE.tipoPedido==='domicilio' && (!STATE.cliNombre||!STATE.cliTel||!STATE.cliDir)){ toast('Domicilio requiere nombre, teléfono y dirección','error'); return; }
  if(STATE.tipoPedido==='llevar' && !STATE.cliNombre){ toast('Indique el nombre del cliente','error'); return; }
  const subtotal=STATE.order.reduce((a,i)=>a+i.precio*i.qty,0);
  const dom=STATE.tipoPedido==='domicilio'?(STATE.valorDom||0):0;
  const ventaReal=Math.max(0,subtotal-(STATE.descuento||0));
  const vs=DB.get('ventas')||[];

  if(STATE.editandoVenta){
    const v=vs.find(x=>x.id===STATE.editandoVenta.id);
    if(v){ v.items=[...STATE.order]; v.subtotal=subtotal; v.valorDom=dom; v.descuento=STATE.descuento||0;
      v.total=ventaReal; v.obs=STATE.orderObs;
      v.estadoCocina='pendiente'; // vuelve a cocina con los cambios
      v.ticketImpreso=false; v.reimpreso=(v.reimpreso||0)+1; // reimprimir comanda
      v.modificadoPor=STATE.user.nombre; v.modificadoEn=now(); fusionarYGuardarVentas(vs);
      notifyKitchen();
      logAudit('Editó pedido',`${v.factura||v.cliNombre} por ${STATE.user.nombre}`); toast('Pedido actualizado y reenviado a cocina','success');
      printTicketCocina(v); }
    clearOrder(); showPage('pedidos'); return;
  }

  const esDomicilio = STATE.tipoPedido==='domicilio';
  // Crear el pedido ABIERTO (aún sin cobrar) y enviarlo a cocina
  const venta={ id:uid(),factura:'',ordenCocina: esDomicilio?null:nextOrden(),fecha:now(),tipo:STATE.tipoPedido,
    mesa:STATE.tipoPedido==='mesa'?STATE.mesa:'', cliNombre:STATE.cliNombre,cliTel:STATE.cliTel,cliDir:STATE.cliDir,cliBarrio:STATE.cliBarrio,
    valorDom:dom, items:[...STATE.order], subtotal, descuento:STATE.descuento||0, descMot:STATE.descMot,
    total:ventaReal, ventaReal, propina:0, recargo:0, totalCobrado:0,
    metodo:'', estado:'abierta', estadoPedido:'activo', estadoCocina:'pendiente', domiciliario:'',
    obs:STATE.orderObs, cajero:STATE.user?.nombre, atendidoPor:STATE.user?.nombre, atendidoRol:STATE.user?.rol, mesero:STATE.user?.rol==='mesero'?STATE.user.nombre:'', cajaId:DB.get('caja_actual')?.id||null };
  vs.unshift(venta); fusionarYGuardarVentas(vs);

  if(esDomicilio){
    const cls=DB.get('clientes')||[]; const ex=cls.find(c=>c.tel===STATE.cliTel);
    if(ex){ ex.pedidos=(ex.pedidos||0)+1; ex.nombre=STATE.cliNombre; ex.dir=STATE.cliDir; ex.barrio=STATE.cliBarrio; } else cls.unshift({id:uid(),nombre:STATE.cliNombre,tel:STATE.cliTel,dir:STATE.cliDir,barrio:STATE.cliBarrio,pedidos:1,creado:now()});
    DB.set('clientes',cls);
  }
  logAudit('Creó venta',`${STATE.cliNombre||venta.ordenCocina} - venta ${fmtMoney(ventaReal)}`);
  notifyKitchen();
  printTicketCocina(venta);
  const idNuevo=venta.id;
  clearOrder();
  // Abrir el modal de cobro con pago dividido (igual que mesa)
  showPage('pedidos');
  setTimeout(()=>abrirCobroMesa(idNuevo), 200);
}

// ========================= IMPRESIÓN =========================
// Impresión robusta: en móvil abre ventana nueva (más confiable que window.print directo)
// ===================== IMPRESIÓN (con soporte QZ Tray) =====================
let qzConectado=false;
function qzListo(){ return (typeof qz!=='undefined') && qz.websocket && qz.websocket.isActive && qz.websocket.isActive(); }
function conectarQZ(){
  return new Promise((resolve,reject)=>{
    if(typeof qz==='undefined'){ reject('QZ Tray no está cargado'); return; }
    if(qzListo()){ resolve(); return; }
    qz.websocket.connect().then(()=>{ qzConectado=true; resolve(); }).catch(err=>{ qzConectado=false; reject(err); });
  });
}
function imprimirConQZ(html){
  const cfg=DB.get('config')||{};
  const impresora=cfg.qzImpresora||'POS printer 203DPI series';
  return conectarQZ().then(()=>qz.printers.find(impresora)).then(found=>{
    const printer = Array.isArray(found)? found[0] : found;
    const config = qz.configs.create(printer, {
      scaleContent:true,
      rasterize:true,
      units:'mm',
      size:{ width:72, height:null },
      margins:0,
      colorType:'grayscale',
      interpolation:'nearest-neighbor'
    });
    const data = [{
      type:'pixel', format:'html', flavor:'plain',
      data:`<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}body{width:72mm;font-family:'Courier New',monospace;color:#000;}</style></head><body><div style="width:72mm;padding:2mm;">${html}</div></body></html>`
    }];
    return qz.print(config, data);
  });
}
// ¿Este dispositivo es la estación de impresión? (se marca solo en el computador de la caja)
function esEstacionImpresion(){ try{ return localStorage.getItem('pi_estacion_impresion')==='1'; }catch(e){ return false; } }
function setEstacionImpresion(on){ try{ localStorage.setItem('pi_estacion_impresion', on?'1':'0'); }catch(e){} }
// ¿Este equipo debe imprimir directo al crear un pedido?
function debeImprimirAqui(){
  const cfg=DB.get('config')||{};
  // Si el Centro de Impresión está activo (global), NINGÚN dispositivo imprime al crear:
  // solo el computador de la caja imprime desde su Centro de Impresión.
  if(cfg.centroImpresionActivo) return false;
  if(!cfg.qzActivo) return true;
  return esEstacionImpresion();
}

function imprimirHTML(html){
  const cfg=DB.get('config')||{};
  // Si QZ Tray está activado Y este es el computador de la caja (estación), imprime directo a la térmica
  if(cfg.qzActivo && esEstacionImpresion()){
    imprimirConQZ(html).then(()=>{}).catch(err=>{
      console.warn('QZ Tray falló:', err);
      // NO abrir el diálogo del navegador (el usuario no quiere esa pantalla).
      toast('No se pudo imprimir por QZ Tray. Revise que esté abierto y la impresora encendida.','error');
    });
    return;
  }
  // Si QZ está activo pero este NO es la estación (ej: celular del mesero), no imprime aquí.
  if(cfg.qzActivo && !esEstacionImpresion()){
    return; // el computador de la caja imprime automáticamente
  }
  // Sin QZ: método normal del navegador
  imprimirNavegador(html);
}
function imprimirNavegador(html){
  const pa=document.getElementById('print-area');
  if(!pa) return;
  pa.innerHTML=html;
  pa.style.display='block';
  window.print();
  pa.style.display='none';
}
function probarImpresionQZ(){
  const html=`<div style="text-align:center;font-family:'Courier New',monospace;">
    <div style="font-size:18px;font-weight:bold;">PRUEBA DE IMPRESIÓN</div>
    <div style="font-size:14px;margin-top:8px;">Portal Imperial</div>
    <div style="font-size:13px;margin-top:6px;">Si lees esto, QZ Tray funciona ✓</div>
    <div style="font-size:11px;margin-top:8px;">${fmtDate(now())}</div>
    <div style="font-size:18px;margin-top:8px;">--- &#9986; ---</div></div>`;
  imprimirConQZ(html).then(()=>{
    toast('Prueba enviada a la impresora','success');
  }).catch(err=>{
    toast('Error: '+(err.message||err||'no se pudo conectar a QZ Tray'),'error');
  });
}
function printFactura(v){
  if(!debeImprimirAqui()) return; // con QZ activo, solo imprime la estación de la caja
  imprimirHTML(facturaHTML(v));
}
function facturaHTML(v){
  const cfg=DB.get('config')||{};
  const esDom = v.tipo==='domicilio';
  const subtotalItems = v.items.reduce((a,i)=>a+i.precio*i.qty,0);
  return `
  <div style="font-family:'Courier New',monospace;color:#000;">
    <div style="text-align:center;padding-bottom:8px;">
      ${cfg.logo?`<img src="${cfg.logo}" style="max-height:90px;max-width:200px;margin-bottom:6px;">`:''}
      <div style="font-size:24px;font-weight:bold;letter-spacing:2px;">${escapeHtml(cfg.nombre||'Portal Imperial')}</div>
      <div style="font-size:13px;letter-spacing:3px;color:#333;margin-top:2px;">COMIDA CHINA</div>
      <div style="font-size:12px;margin-top:6px;line-height:1.5;">
        ${cfg.nit?'NIT: '+cfg.nit+'<br>':''}${escapeHtml(cfg.dir||'')}<br>Tel: ${cfg.tel||''}
      </div>
    </div>
    <div style="border-top:2px solid #000;border-bottom:2px solid #000;padding:7px 0;text-align:center;margin:4px 0;">
      <div style="font-size:17px;font-weight:bold;">${esDom?'PEDIDO A DOMICILIO':'FACTURA '+v.factura}</div>
    </div>
    <div style="font-size:15px;line-height:1.7;margin:6px 0;font-weight:bold;">
      <div style="display:flex;justify-content:space-between;"><span>Fecha:</span><span>${fmtDate(v.fechaCobro||v.fecha)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Tipo:</span><span>${tipoLabel(v.tipo)}${v.mesa?' · '+v.mesa:''}</span></div>
      ${v.cliNombre?`<div style="display:flex;justify-content:space-between;"><span>Cliente:</span><span>${escapeHtml(v.cliNombre)}</span></div>`:''}
      ${v.cliTel?`<div style="display:flex;justify-content:space-between;"><span>Teléfono:</span><span>${escapeHtml(v.cliTel)}</span></div>`:''}
      ${esDom&&v.cliDir?`<div style="display:flex;justify-content:space-between;"><span>Dirección:</span><span>${escapeHtml(v.cliDir)}</span></div>`:''}
      ${esDom&&v.cliBarrio?`<div style="display:flex;justify-content:space-between;"><span>Barrio:</span><span>${escapeHtml(v.cliBarrio)}</span></div>`:''}
      ${esDom&&v.domiciliario?`<div style="display:flex;justify-content:space-between;"><span>Mensajero:</span><span>${escapeHtml(v.domiciliario)}</span></div>`:''}
      <div style="display:flex;justify-content:space-between;"><span>Atendió:</span><span>${escapeHtml(v.atendidoPor||v.mesero||v.cajero||'')}</span></div>
      ${v.cobradoPor && v.cobradoPor!==(v.atendidoPor||v.mesero||v.cajero)?`<div style="display:flex;justify-content:space-between;"><span>Cobró:</span><span>${escapeHtml(v.cobradoPor)}</span></div>`:''}
    </div>
    <div style="border-top:1px dashed #000;padding-top:4px;">
      <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:bold;border-bottom:1px solid #000;padding-bottom:3px;margin-bottom:4px;">
        <span style="flex:1;">CANT / PRODUCTO</span><span>VALOR</span>
      </div>
      ${v.items.map(i=>`<div style="display:flex;justify-content:space-between;font-size:15px;font-weight:bold;padding:3px 0;line-height:1.3;"><span style="flex:1;">${i.qty} x ${escapeHtml(i.nombre)}</span><span>${fmtMoney(i.precio*i.qty)}</span></div>`).join('')}
    </div>
    <div style="border-top:1px dashed #000;margin-top:6px;padding-top:6px;font-size:15px;">
      <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${fmtMoney(subtotalItems)}</span></div>
      ${v.descuento>0?`<div style="display:flex;justify-content:space-between;"><span>Descuento</span><span>-${fmtMoney(v.descuento)}</span></div>`:''}
      ${v.valorDom>0?`<div style="display:flex;justify-content:space-between;"><span>Domicilio</span><span>${fmtMoney(v.valorDom)}</span></div>`:''}
      ${v.propina>0?`<div style="display:flex;justify-content:space-between;"><span>Propina</span><span>${fmtMoney(v.propina)}</span></div>`:''}
      ${v.recargo>0?`<div style="display:flex;justify-content:space-between;"><span>Recargo datáfono</span><span>${fmtMoney(v.recargo)}</span></div>`:''}
    </div>
    <div style="border-top:2px solid #000;border-bottom:2px solid #000;margin-top:6px;padding:9px 0;display:flex;justify-content:space-between;font-size:22px;font-weight:bold;">
      <span>TOTAL</span><span>${fmtMoney(v.totalCobrado!==undefined?v.totalCobrado:v.total)}</span>
    </div>
    <div style="text-align:center;font-size:14px;font-weight:bold;margin-top:5px;">Forma de pago: ${nombreMetodo(v.metodo).toUpperCase()}</div>
    ${v.obs?`<div style="border-top:1px dashed #000;margin-top:8px;padding-top:6px;font-size:13px;"><strong>Observación:</strong> ${escapeHtml(v.obs)}</div>`:''}
    <div style="text-align:center;margin-top:12px;font-size:15px;font-weight:bold;letter-spacing:1px;">¡GRACIAS POR SU VISITA!</div>
    <div style="text-align:center;font-size:14px;color:#333;margin-top:4px;font-weight:bold;">Lo esperamos pronto</div>
    <div style="text-align:center;font-size:18px;margin-top:6px;letter-spacing:3px;">★ ★ ★</div>
    ${(cfg.marcaAguaActiva&&cfg.marcaAgua)?`<div style="text-align:center;font-size:12px;color:#444;margin-top:10px;letter-spacing:1px;border-top:1px dotted #999;padding-top:8px;font-weight:bold;">${escapeHtml(cfg.marcaAgua)}</div>`:''}
  </div>`;
}
function ticketCocinaHTML(v){
  const esDom = v.tipo==='domicilio';
  const orden = v.ordenCocina?('#'+String(v.ordenCocina).padStart(3,'0')):'';
  let destino='';
  if(v.tipo==='mesa') destino=(v.mesa||'MESA').toUpperCase();
  else if(esDom) destino='DOMICILIO';
  else destino='PARA LLEVAR';
  const encabezado = esDom
    ? `<div style="font-size:34px;font-weight:bold;line-height:1.1;margin:8px 0;">${escapeHtml((v.cliNombre||'CLIENTE').toUpperCase())}</div>`
    : `<div style="font-size:42px;font-weight:bold;line-height:1.1;margin:8px 0;">ORDEN ${orden}</div>`;
  return `
  <div style="font-family:'Courier New',monospace;color:#000;text-align:center;">
    <div style="font-size:16px;letter-spacing:2px;font-weight:bold;">*** COCINA ***</div>
    ${v.reimpreso?`<div style="border:2px solid #000;padding:4px;margin:4px 0;font-size:16px;font-weight:bold;">⚠ PEDIDO MODIFICADO ⚠<br>(reimpresión ${v.reimpreso})</div>`:''}
    ${encabezado}
    <div style="border:3px solid #000;border-radius:6px;padding:8px;margin:8px 0;font-size:28px;font-weight:bold;">${destino}</div>
    ${esDom?`<div style="font-size:16px;line-height:1.5;margin-bottom:6px;font-weight:bold;">
       ${v.cliDir?escapeHtml(v.cliDir):''}${v.cliBarrio?' · '+escapeHtml(v.cliBarrio):''}<br>
       Tel: ${escapeHtml(v.cliTel||'')}${v.domiciliario?'<br>Mensajero: '+escapeHtml(v.domiciliario):''}
     </div>`:''}
    ${v.tipo==='llevar'&&v.cliNombre?`<div style="font-size:18px;margin-bottom:6px;"><strong>${escapeHtml(v.cliNombre)}</strong></div>`:''}
    <div style="font-size:14px;font-weight:bold;">${fmtDate(v.fecha)}</div>
  </div>
  <hr style="border:1px dashed #000;margin:8px 0;">
  <div style="font-family:'Courier New',monospace;color:#000;">
    ${v.items.map(i=>`<div style="font-size:22px;font-weight:bold;margin-bottom:8px;line-height:1.2;">${i.qty} x ${escapeHtml(i.nombre)}${i.obs?`<div style="font-size:15px;font-weight:normal;padding-left:10px;">&gt;&gt; ${escapeHtml(i.obs)}</div>`:''}</div>`).join('')}
    ${v.obs?`<hr style="border:1px dashed #000;margin:8px 0;"><div style="font-size:16px;font-weight:bold;">NOTA: ${escapeHtml(v.obs)}</div>`:''}
  </div>
  <div style="text-align:center;font-size:18px;margin-top:10px;">--- &#9986; ---</div>`;
}
function printTicketCocina(v){
  const cfg=DB.get('config')||{};
  // Si QZ Tray está activo, la impresión la hace la cola automática del computador de caja
  // (evita impresiones duplicadas). Si no, imprime normal aquí.
  if(cfg.qzActivo){ try{ revisarColaImpresion(); }catch(e){} return; }
  imprimirHTML(ticketCocinaHTML(v));
}

// ========================= NOTIFICACIÓN COCINA (SONIDO) =========================
function beep(freq=800,dur=200,vol=0.3){
  try{ const ctx=new (window.AudioContext||window.webkitAudioContext)(); const o=ctx.createOscillator(),g=ctx.createGain();
  o.connect(g); g.connect(ctx.destination); o.frequency.value=freq; o.type='square'; g.gain.setValueAtTime(Math.min(1,vol),ctx.currentTime);
  o.start(); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+dur/1000); o.stop(ctx.currentTime+dur/1000);
  }catch(e){}
}
// Nota tipo CAMPANA (suave y musical, no de videojuego): tono principal + armónico brillante
let _audioCtx=null;
function campana(freq, t0, dur, vol){
  try{
    _audioCtx = _audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    const ctx=_audioCtx; const now=ctx.currentTime+t0;
    // tono fundamental
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.type='triangle'; o.frequency.value=freq;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vol, now+0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, now+dur);
    o.start(now); o.stop(now+dur+0.02);
    // armónico (le da brillo de campana)
    const o2=ctx.createOscillator(), g2=ctx.createGain();
    o2.type='sine'; o2.frequency.value=freq*2.01;
    o2.connect(g2); g2.connect(ctx.destination);
    g2.gain.setValueAtTime(0, now);
    g2.gain.linearRampToValueAtTime(vol*0.4, now+0.01);
    g2.gain.exponentialRampToValueAtTime(0.0008, now+dur*0.7);
    o2.start(now); o2.stop(now+dur*0.7+0.02);
  }catch(e){}
}
// Pedido nuevo: timbre elegante (do-mi-sol ascendente, alegre), RÁPIDO, FUERTE y suena 2 veces
function sonidoPedidoNuevo(){
  const V=0.9;
  const melodia = (t)=>{
    campana(1047, t,      0.18, V);  // Do
    campana(1319, t+0.10, 0.18, V);  // Mi
    campana(1568, t+0.20, 0.30, V);  // Sol (un poco más largo)
  };
  melodia(0);      // primera vez
  melodia(0.42);   // segunda vez, enseguida (más rápido)
}
// Sonidos distintos por evento
function sonidoListo(){ campana(1319,0,0.2,0.7); campana(1760,0.12,0.3,0.7); } // campanita alegre
function sonidoError(){ beep(250,300,0.5); }
function sonidoExito(){ campana(1047,0,0.15,0.6); campana(1568,0.09,0.2,0.6); }
function notifyKitchen(){ sonidoPedidoNuevo(); }

// ========================= PEDIDOS =========================
function pedidos(){
  // Los pedidos se reinician con la CAJA: solo se ven los de la caja abierta actualmente.
  // Al cerrar caja y abrir una nueva, empieza limpio (sin los pedidos de la caja anterior).
  // Excepción de seguridad: los abiertos/por verificar SIEMPRE se ven (nunca se pierde uno sin cobrar).
  const cajaActual=DB.get('caja_actual');
  const cajaId=cajaActual?cajaActual.id:null;
  const vs=(DB.get('ventas')||[]).filter(v=>{
    if(v.estado==='anulada') return false;
    if(v.estado==='abierta' || v.estado==='por_verificar') return true; // nunca ocultar sin cobrar
    return cajaId && v.cajaId===cajaId; // solo los de la caja abierta ahora
  });
  return `<div class="card"><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-orders')} Pedidos <span class="text-sm text-gray" style="font-weight:normal;">(caja actual)</span></div>
    <div style="display:flex;gap:8px;"><div style="position:relative;"><span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--gray3)">${ic('i-search')}</span><input type="text" id="ped-q" placeholder="Factura, cliente, teléfono..." value="${escapeHtml(STATE.pedQ||'')}" oninput="STATE.pedQ=this.value;document.getElementById('ped-table-wrap').innerHTML=renderPedidosTable(window.__pedlist||[])" style="padding-left:34px;width:240px;"></div>
    <button class="btn btn-primary btn-sm" onclick="showPage('ventas')">${ic('i-plus')} Nueva</button></div></div>
    <div id="ped-table-wrap">${renderPedidosTable(vs)}</div></div>`;
}
function renderPedidosTable(vs){
  window.__pedlist=vs;
  const q=(STATE.pedQ||'').toLowerCase().trim();
  let list=vs.filter(v=>!q||(v.factura||'').toLowerCase().includes(q)||(v.cliNombre||'').toLowerCase().includes(q)||(v.cliTel||'').includes(q)||(v.domiciliario||'').toLowerCase().includes(q)||(v.mesa||'').toLowerCase().includes(q));
  if(list.length===0) return `<div class="empty-state">${ic('i-empty')}<p>Sin pedidos${q?' para "'+escapeHtml(q)+'"':''}</p></div>`;
  const isAdmin=STATE.user.rol==='admin'||STATE.user.rol==='supervisor';
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Pedido / Mensajero</th><th>Tipo</th><th>Cliente/Mesa</th><th>Total</th><th>Cobro</th><th>Cocina</th><th>Pedido</th><th>Domiciliario</th><th>Acciones</th></tr></thead><tbody>
  ${list.map(v=>{
    // Admin/supervisor editan siempre. Cajero edita pedidos no pagados.
    // El MESERO solo puede editar MESAS que estén abiertas (sin cobrar).
    const noPagado = v.estado!=='pagada';
    const esMesero = STATE.user.rol==='mesero';
    const meseroEditaMesa = esMesero && v.tipo==='mesa' && v.estado==='abierta';
    const editable = STATE.user.rol==='impresiones' ? false
      : esMesero ? meseroEditaMesa
      : (isAdmin || noPagado);
    const abierta = v.estado==='abierta';
    const porVerificar = v.estado==='por_verificar';
    return `<tr ${abierta?'style="background:rgba(212,175,55,0.06)"':porVerificar?'style="background:rgba(52,152,219,0.08)"':''}>
    <td><span class="text-gold font-bold">${refPedido(v)}</span>${v.modificadoPor?`<br><span class="text-xs text-gray">editado: ${escapeHtml(v.modificadoPor)}</span>`:''}</td>
    <td>${tipoLabel(v.tipo)}</td>
    <td>${escapeHtml(v.cliNombre||v.mesa||'—')}${v.cliTel?`<br><span class="text-xs text-gray">${escapeHtml(v.cliTel)}</span>`:''}</td>
    <td class="font-bold">${fmtMoney(v.total)}</td>
    <td>${abierta?'<span class="badge badge-orange">Abierta</span>':porVerificar?'<span class="badge badge-blue">Por verificar</span>':'<span class="badge badge-green">Pagada</span>'}</td>
    <td>${cocinaBadge(v.estadoCocina)}${v.llamadoMesero&&v.estadoPedido!=='entregado'?'<br><span class="badge badge-gold" style="margin-top:3px;">🔔 Listo - recoger</span>':''}</td>
    <td><select onchange="setEstadoPedido('${v.id}',this.value)" class="mini-input" style="width:auto;padding:4px 8px;"><option value="activo" ${v.estadoPedido==='activo'?'selected':''}>Activo</option><option value="entregado" ${v.estadoPedido==='entregado'?'selected':''}>Entregado</option></select></td>
    <td>${v.tipo==='domicilio'?domiciliarioSelect(v):'—'}</td>
    <td style="display:flex;gap:5px;flex-wrap:wrap;">
      ${abierta && STATE.user.rol!=='mesero' && STATE.user.rol!=='impresiones'?`<button class="btn btn-success btn-sm" onclick="abrirCobroMesa('${v.id}')" title="Cobrar y cerrar">${ic('i-cash')} Cobrar</button>`:''}
      ${porVerificar?`<button class="btn btn-primary btn-sm" onclick="verificarPago('${v.id}')" title="Verificar comprobante">${ic('i-check')} Verificar</button>`:''}
      ${editable?`<button class="btn btn-ghost btn-sm" onclick="editarPedido('${v.id}')" title="Editar">${ic('i-edit')}</button>`:''}
      ${['admin','supervisor'].includes(STATE.user.rol) && v.items.length>1?`<button class="btn btn-ghost btn-sm" onclick="abrirQuitarProducto('${v.id}')" title="Quitar un producto">${ic('i-menu-food')}−</button>`:''}
      <button class="btn btn-ghost btn-sm" onclick="reimprimir('${v.id}')" title="Reimprimir">${ic('i-print')}</button>
      ${(v.tipo==='domicilio' ? STATE.user.rol==='admin' : (isAdmin||STATE.user.rol==='jefe'))?`<button class="btn btn-danger btn-sm" onclick="anularVenta('${v.id}')" title="${v.tipo==='domicilio'?'Eliminar domicilio':'Anular'}">${ic('i-ban')}</button>`:''}
      ${['admin','supervisor'].includes(STATE.user.rol)?`<button class="btn btn-danger btn-sm" onclick="eliminarDefinitivo('${v.id}')" title="Eliminar factura por completo">${ic('i-trash')}</button>`:''}
    </td></tr>`;}).join('')}
  </tbody></table></div>`;
}
function cocinaBadge(e){ const m={pendiente:['badge-orange','Pendiente'],preparando:['badge-blue','Preparando'],listo:['badge-green','Listo'],entregado:['badge-gray','Entregado']}; const x=m[e||'pendiente']; return `<span class="badge ${x[0]}">${x[1]}</span>`; }
function domiciliarioSelect(v){
  const ds=(DB.get('domiciliarios')||[]).filter(d=>d.activo);
  return `<select onchange="asignarDomiciliario('${v.id}',this.value)" class="mini-input" style="width:auto;padding:4px 8px;"><option value="">Asignar...</option>${ds.map(d=>`<option ${v.domiciliario===d.nombre?'selected':''}>${escapeHtml(d.nombre)}</option>`).join('')}</select>`;
}
function asignarDomiciliario(id,nombre){ const vs=DB.get('ventas')||[]; const v=vs.find(x=>x.id===id); if(v){v.domiciliario=nombre;fusionarYGuardarVentas(vs);logAudit('Asignó domiciliario',`${v.factura} → ${nombre}`);toast('Domiciliario asignado','success');} }
function setEstadoPedido(id,e){ const vs=DB.get('ventas')||[]; const v=vs.find(x=>x.id===id); if(v){v.estadoPedido=e;if(e==='entregado')v.estadoCocina='entregado';fusionarYGuardarVentas(vs); logAudit('Cambió estado pedido',`${refPedido(v)} → ${e} (por ${STATE.user.nombre})`);} updateBadges(); }
// El SUPERVISOR (o admin) puede quitar un producto de cualquier pedido, incluso pagado.
// Recalcula el total y ajusta los métodos de pago proporcionalmente. Sin valores fantasma.
function abrirQuitarProducto(id){
  if(!['admin','supervisor'].includes(STATE.user.rol)){ toast('Solo supervisor o admin','error'); return; }
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  const cont=document.getElementById('quitarprod-lista');
  cont.innerHTML=v.items.map((i,idx)=>`<div class="flex-between" style="padding:10px;border-bottom:1px solid rgba(255,255,255,0.06);">
    <div><strong>${escapeHtml(i.nombre)}</strong> <span class="text-gray">x${i.qty}</span><br><span class="text-xs text-gold">${fmtMoney(i.precio*i.qty)}</span></div>
    <button class="btn btn-danger btn-sm" onclick="quitarProductoPedido('${v.id}',${idx})">${ic('i-trash')} Quitar</button>
  </div>`).join('');
  document.getElementById('quitarprod-info').textContent=`${v.factura||refPedido(v)} · Total actual: ${fmtMoney(v.total)}`;
  openModal('modal-quitarprod');
}
function quitarProductoPedido(ventaId, itemIdx){
  if(!['admin','supervisor'].includes(STATE.user.rol)){ toast('Solo el supervisor o admin pueden quitar productos','error'); return; }
  const vs=DB.get('ventas')||[]; const v=vs.find(x=>x.id===ventaId); if(!v) return;
  const item=v.items[itemIdx]; if(!item) return;
  if(v.items.length<=1){ toast('No se puede quitar el único producto. Mejor anule el pedido.','error'); return; }
  if(!confirm(`¿Quitar "${item.nombre}" (${fmtMoney(item.precio*item.qty)}) del pedido?\n\nEl total y los pagos se recalculan automáticamente.`)) return;

  // Quitar el item y recalcular la comida (total)
  v.items.splice(itemIdx,1);
  const nuevoSubtotal=v.items.reduce((a,i)=>a+i.precio*i.qty,0);
  v.subtotal=nuevoSubtotal;
  const desc=v.descuento||0;
  v.total=Math.max(0, nuevoSubtotal-desc);
  v.comida=v.total;
  v.ventaReal=v.total;

  // Si ya estaba pagado/por verificar, reajustar el reparto de la COMIDA (pagosVenta)
  // proporcionalmente al nuevo total. pagosExtra (propina/recargo/domicilio) NO cambia.
  if((v.estado==='pagada'||v.estado==='por_verificar') && v.pagosVenta){
    const totalVentaAntes=Object.values(v.pagosVenta).reduce((a,b)=>a+b,0);
    if(totalVentaAntes>0){
      const factor=v.total/totalVentaAntes;
      const nuevos={efectivo:0,tarjeta:0,banco:0}; let suma=0;
      Object.keys(v.pagosVenta).forEach(k=>{ nuevos[k]=Math.round((v.pagosVenta[k]||0)*factor); suma+=nuevos[k]; });
      // Ajustar el redondeo para que cuadre exacto con el nuevo total de comida
      const dif=v.total-suma;
      if(dif!==0){ const kMax=Object.keys(nuevos).sort((a,b)=>nuevos[b]-nuevos[a])[0]; nuevos[kMax]+=dif; }
      v.pagosVenta=nuevos;
      // pagos total = pagosVenta (comida) + pagosExtra (propina+recargo+domicilio)
      const ex=v.pagosExtra||{efectivo:0,tarjeta:0,banco:0};
      v.pagos={ efectivo:(nuevos.efectivo||0)+(ex.efectivo||0), tarjeta:(nuevos.tarjeta||0)+(ex.tarjeta||0), banco:(nuevos.banco||0)+(ex.banco||0) };
      v.totalCobrado=Object.values(v.pagos).reduce((a,b)=>a+b,0);
      v.metodo=Object.entries(v.pagosVenta).sort((a,b)=>b[1]-a[1])[0][0]||'efectivo';
    }
  }

  v.modificadoPor=STATE.user.nombre; v.modificadoEn=now();
  // NO se registra en auditoría cuando lo hace admin/supervisor (indicación de los dueños).
  fusionarYGuardarVentas(vs);
  toast(`Producto quitado. Nuevo total: ${fmtMoney(v.total)}`,'success');
  // Reimprimir comanda con el cambio
  v.ticketImpreso=false; v.reimpreso=(v.reimpreso||0)+1;
  try{ printTicketCocina(v); }catch(e){}
  closeModal('modal-quitarprod');
  showPage('pedidos');
}
function editarPedido(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  if(STATE.user.rol==='impresiones'){ toast('Este usuario no puede editar pedidos','error'); return; }
  if(STATE.user.rol==='mesero'){
    // El mesero solo puede editar mesas abiertas (sin cobrar)
    if(!(v.tipo==='mesa' && v.estado==='abierta')){ toast('Solo puede editar mesas que estén abiertas','error'); return; }
  }
  STATE.editandoVenta=v; STATE.order=v.items.map(i=>({...i})); STATE.tipoPedido=v.tipo; STATE.mesa=v.mesa||'';
  STATE.cliNombre=v.cliNombre||''; STATE.cliTel=v.cliTel||''; STATE.cliDir=v.cliDir||''; STATE.cliBarrio=v.cliBarrio||'';
  STATE.valorDom=v.valorDom||0; STATE.descuento=v.descuento||0; STATE.descMot=v.descMot||''; STATE.orderObs=v.obs||'';
  showPage('ventas');
}

let cobrandoMesaId=null, cobroComida=0, cobroTotalCliente=0;
function abrirCobroMesa(id){
  if(STATE.user.rol==='mesero' || STATE.user.rol==='impresiones'){ toast('Este usuario no puede cobrar. El cajero realiza el cobro.','error'); return; }
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  cobrandoMesaId=id; cobroComida=v.total||0;
  const ref = v.tipo==='mesa'?v.mesa : (v.cliNombre||refCocina(v));
  const extra = v.valorDom>0?` + domicilio ${fmtMoney(v.valorDom)}`:'';
  document.getElementById('cobro-mesa-info').innerHTML=`<strong>${escapeHtml(ref)}</strong> · ${v.items.length} platos · Comida <span class="text-gold font-bold">${fmtMoney(v.total)}</span>${extra}`;
  ['cobro-propina','cobro-recargo','pago-efectivo','pago-tarjeta','pago-banco'].forEach(i=>{ const el=document.getElementById(i); if(el) el.value=''; });
  document.getElementById('cobro-propina').value=0;
  document.getElementById('cobro-recargo').value=0;
  const domFormaEl=document.getElementById('cobro-dom-forma'); if(domFormaEl) domFormaEl.value='efectivo_directo';
  openModal('modal-cobro');
  actualizarTotalCobro();
}
// Calcula el TOTAL que el cliente debe pagar en caja según las reglas.
function actualizarTotalCobro(){
  const propina=parseFloat(document.getElementById('cobro-propina')?.value)||0;
  const recargo=parseFloat(document.getElementById('cobro-recargo')?.value)||0;
  const v=(DB.get('ventas')||[]).find(x=>x.id===cobrandoMesaId);
  const dom=v?(v.valorDom||0):0;
  // Cuadro de domicilio: solo si hay domicilio
  const domBox=document.getElementById('cobro-domicilio-box');
  if(domBox) domBox.style.display = dom>0 ? 'block':'none';
  const domValorSpan=document.getElementById('cobro-dom-valor'); if(domValorSpan) domValorSpan.textContent=fmtMoney(dom);
  const domForma=document.getElementById('cobro-dom-forma')?.value||'efectivo_directo';
  // REGLA: el domicilio EN EFECTIVO no entra a caja (lo cobra el domiciliario directo).
  // El domicilio POR BANCO sí entra (el cliente lo transfiere junto con la comida).
  const domEnTotal = (dom>0 && domForma==='banco') ? dom : 0;
  // Ayuda visual
  const ayuda=document.getElementById('cobro-dom-ayuda');
  if(ayuda){ ayuda.textContent = domForma==='banco'
    ? 'El cliente transfiere comida + domicilio. Luego le pagas al domiciliario en efectivo del cajón (el sistema lo descuenta solo).'
    : 'El cliente le paga el domicilio en efectivo al domiciliario. No pasa por la caja.'; }
  // Total a cobrar = comida + propina + recargo + (domicilio solo si es por banco)
  cobroTotalCliente = cobroComida + propina + recargo + domEnTotal;
  const el=document.getElementById('cobro-total-final');
  if(el) el.textContent=fmtMoney(cobroTotalCliente);
  const queCobrar=document.getElementById('cobro-que-cobrar');
  if(queCobrar) queCobrar.textContent = dom>0 ? (domEnTotal>0?'(comida + domicilio + extras)':'(comida + extras; domicilio aparte)') : '';
  actualizarRepartoCobro();
}
// Verifica que lo repartido en métodos cuadre con el total a cobrar.
function actualizarRepartoCobro(){
  const ef=parseFloat(document.getElementById('pago-efectivo')?.value)||0;
  const ta=parseFloat(document.getElementById('pago-tarjeta')?.value)||0;
  const ba=parseFloat(document.getElementById('pago-banco')?.value)||0;
  const suma=ef+ta+ba;
  const msg=document.getElementById('cobro-reparto-msg');
  if(!msg) return;
  const falta=cobroTotalCliente-suma;
  if(suma===0){ msg.innerHTML='<span class="text-gray">Escriba cómo paga el cliente</span>'; }
  else if(Math.abs(falta)<1){ msg.innerHTML='<span class="text-green font-bold">✓ Pago completo</span>'; }
  else if(falta>0){ msg.innerHTML=`<span class="text-gold">Falta ${fmtMoney(falta)}</span>`; }
  else { msg.innerHTML=`<span class="text-red">Sobra ${fmtMoney(Math.abs(falta))} (revise)</span>`; }
}
// Confirma el cobro: separa comida, propina, recargo y domicilio en sus métodos.
function confirmarCobroMesa(){
  const id=cobrandoMesaId; if(!id) return;
  const propina=parseFloat(document.getElementById('cobro-propina')?.value)||0;
  const recargo=parseFloat(document.getElementById('cobro-recargo')?.value)||0;
  const pagos={ efectivo:parseFloat(document.getElementById('pago-efectivo')?.value)||0,
    tarjeta:parseFloat(document.getElementById('pago-tarjeta')?.value)||0,
    banco:parseFloat(document.getElementById('pago-banco')?.value)||0 };
  const suma=pagos.efectivo+pagos.tarjeta+pagos.banco;
  if(suma<=0){ toast('Indique cómo paga el cliente','error'); return; }
  if(Math.abs(cobroTotalCliente-suma)>=1){ toast('Lo pagado no cuadra con el total a cobrar','error'); return; }
  const vs=DB.get('ventas')||[];
  const v=vs.find(x=>x.id===id); if(!v){ closeModal('modal-cobro'); return; }
  const dom=v.valorDom||0;
  const domForma=document.getElementById('cobro-dom-forma')?.value||'efectivo_directo';
  const comida=v.total||0;
  const domPorBanco = (dom>0 && domForma==='banco');

  // ===== SEPARACIÓN DE CONCEPTOS (POS profesional) =====
  // El total recibido = comida + propina + recargo + (domicilio si es por banco).
  // Repartimos cada peso a su concepto. La COMIDA se cubre primero, en orden:
  // efectivo → tarjeta → banco. El resto (propina+recargo+domicilio) es "extra" (no del negocio).
  let restante={ efectivo:pagos.efectivo, tarjeta:pagos.tarjeta, banco:pagos.banco };
  const pagosVenta={ efectivo:0, tarjeta:0, banco:0 }; // solo comida
  // Cubrir la comida tomando de cada método disponible
  let porCubrir=comida;
  for(const k of ['efectivo','tarjeta','banco']){
    if(porCubrir<=0) break;
    const toma=Math.min(restante[k], porCubrir);
    pagosVenta[k]+=toma; restante[k]-=toma; porCubrir-=toma;
  }
  // Lo que queda en 'restante' es propina + recargo + domicilio-banco (no es venta del negocio)
  const pagosExtra={ efectivo:restante.efectivo, tarjeta:restante.tarjeta, banco:restante.banco };

  // Guardar todo separado y claro
  v.comida=comida;
  v.ventaReal=comida;        // compatibilidad con reportes existentes
  v.propina=propina;         // va al mesero
  v.recargo=recargo;         // recargo datáfono (no es del negocio)
  v.valorDom=dom;
  v.domFormaPago = dom>0 ? domForma : null;
  v.domPorBanco = domPorBanco;   // si entró por banco → se paga al domiciliario en efectivo
  v.pagos=pagos;             // total que puso el cliente por método
  v.pagosVenta=pagosVenta;   // SOLO comida por método (lo que es venta real)
  v.pagosExtra=pagosExtra;   // propina+recargo+domicilio por método
  v.totalCobrado=suma;
  v.metodo=Object.entries(pagosVenta).sort((a,b)=>b[1]-a[1])[0][0]||'efectivo';
  v.fechaCobro=now(); v.cobradoPor=STATE.user.nombre;
  v.cajaId=DB.get('caja_actual')?.id||v.cajaId||null;
  if(!v.factura && v.tipo!=='domicilio') v.factura=nextFactura();

  // Si entró dinero por banco, queda PENDIENTE de verificar el comprobante
  const requiereVerif = pagos.banco>0;
  if(requiereVerif){
    v.estado='por_verificar';
    fusionarYGuardarVentas(vs);
    closeModal('modal-cobro'); cobrandoMesaId=null;
    toast('Pago registrado. Verifica el comprobante del Banco en Pedidos.','info');
    showPage('pedidos'); return;
  }
  v.estado='pagada';
  fusionarYGuardarVentas(vs);
  const ref=v.tipo==='mesa'?v.mesa:(v.factura||v.cliNombre);
  closeModal('modal-cobro'); cobrandoMesaId=null;
  toast(`${ref} cobrada`,'success');
  printFactura(v);
  showPage('pedidos');
}
function verificarPago(id){
  const vs=DB.get('ventas')||[]; const v=vs.find(x=>x.id===id); if(!v) return;
  if(!confirm('¿Confirma que ya verificó el comprobante de pago (Banco) y el dinero está recibido?')) return;
  v.estado='pagada'; v.verificadoPor=STATE.user.nombre; v.fechaVerif=now();
  fusionarYGuardarVentas(vs);
  toast('Pago verificado','success');
  printFactura(v);
  showPage('pedidos');
}
function anularVenta(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  if(v.tipo==='domicilio'){
    // Solo el ADMINISTRADOR puede borrar domicilios, y solo cuando él lo decida.
    // No se borran solos. No deja ningún rastro (ni historial, ni auditoría).
    if(STATE.user.rol!=='admin'){ toast('Solo el administrador puede eliminar domicilios','error'); return; }
    if(!confirm('Este es un domicilio. Se ELIMINARÁ por completo, sin dejar ningún rastro en el sistema (ni en historial ni en auditoría).\n\n¿Continuar?')) return;
    borrarVentaSegura(id);
    toast('Domicilio eliminado','error'); showPage('pedidos'); return;
  }
  if(!confirm('¿Anular esta venta? Quedará registrada como ANULADA en el historial y auditoría (no se borra, queda el rastro).')) return;
  const vs=DB.get('ventas')||[]; const t=vs.find(x=>x.id===id);
  if(t){ t.estado='anulada'; t.anuladoPor=STATE.user.nombre; t.anuladoEn=now(); fusionarYGuardarVentas(vs); logAudit('Anuló venta',`${t.factura||refPedido(t)} por ${STATE.user.nombre}`); }
  toast('Venta anulada (queda en historial)','error'); showPage('pedidos');
}
function eliminarDefinitivo(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  if(!['admin','supervisor'].includes(STATE.user.rol)){ toast('Solo administrador o supervisor pueden eliminar','error'); return; }
  if(!confirm(`⚠ Eliminar PERMANENTEMENTE este pedido (${fmtMoney(v.total)}).\n\nSe descontará de ventas, reportes y del efectivo esperado en caja. NO se puede deshacer.\n\n¿Continuar?`)) return;
  // Al borrar el pedido de ventas, automáticamente sale del total de ventas Y del efectivo
  // esperado en caja (el cuadre solo suma pedidos pagados que existen). Así descuenta solo.
  borrarVentaSegura(id);
  // NO se registra en auditoría cuando lo hace admin o supervisor (según indicación de los dueños).
  toast('Pedido eliminado. Descontado de ventas y caja.','error'); showPage('pedidos');
}
function reimprimir(id){ const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(v){printFactura(v);} }

// ========================= PEDIDOS LISTOS =========================
function listos(){
  const vs=(DB.get('ventas')||[]).filter(v=>v.estadoCocina==='listo'&&v.estadoPedido!=='entregado'&&v.estado!=='anulada');
  return `<div class="card"><div class="card-title">${ic('i-ready')} Pedidos Listos para Entregar</div>
  ${vs.length===0?`<div class="empty-state">${ic('i-empty')}<p>No hay pedidos listos</p></div>`:
  `<div class="kds-grid">${vs.map(v=>`<div class="kds-card t-verde">
    <div class="flex-between mb-2"><span class="text-gold font-bold" style="font-size:16px;">${refCocina(v)}</span><span class="badge badge-green">${ic('i-check')} Listo</span></div>
    <div class="text-sm mb-2">${tipoLabel(v.tipo)}${v.mesa?' · '+v.mesa:''}${v.cliNombre?' · '+escapeHtml(v.cliNombre):''}</div>
    ${v.tipo==='domicilio'?`<div class="text-xs text-gray mb-2">${ic('i-pin')} ${escapeHtml(v.cliDir||'')} ${v.domiciliario?'· '+escapeHtml(v.domiciliario):''}</div>`:''}
    <button class="btn btn-success btn-block btn-sm" onclick="setEstadoCocina('${v.id}','entregado')">${ic('i-check')} Marcar Entregado</button>
  </div>`).join('')}</div>`}</div>`;
}

// ========================= COCINA (KDS) =========================
let ultimoCountCocina=-1;
function cocina(){
  const vs=(DB.get('ventas')||[]).filter(v=>v.estado!=='anulada'&&v.estadoPedido!=='entregado'&&v.estadoCocina!=='entregado')
    .sort((a,b)=>new Date(a.fecha)-new Date(b.fecha));
  // Detectar pedido NUEVO: si hay más pedidos que antes, sonar alarma fuerte
  const pendientes=vs.filter(v=>v.estadoCocina==='pendiente'||v.estadoCocina==='preparando').length;
  if(ultimoCountCocina>=0 && pendientes>ultimoCountCocina){ try{ sonidoPedidoNuevo(); }catch(e){} }
  ultimoCountCocina=pendientes;
  return `<div><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-chef')} Pantalla de Cocina</div>
    <span class="badge badge-blue">Ordenado por tiempo de espera · Sin precios</span></div>
    <div id="kds-container">${renderKDS(vs)}</div></div>`;
}
function renderKDS(vs){
  if(vs.length===0) return `<div class="empty-state">${ic('i-empty')}<p>No hay pedidos en cocina</p></div>`;
  return `<div class="kds-grid">${vs.map(v=>{
    const min=Math.floor((ahoraMs()-new Date(v.fecha))/60000);
    const t=min<15?'verde':min<25?'amarillo':'rojo';
    return `<div class="kds-card t-${t}">
      <div class="flex-between mb-2"><span class="text-gold font-bold" style="font-size:16px;">${refCocina(v)}</span>
      <span class="kds-timer ${t==='rojo'?'text-red':t==='amarillo'?'text-gold':'text-green'}">${min} min</span></div>
      <div class="text-sm" style="margin-bottom:8px;color:var(--light);">${tipoLabel(v.tipo)}${v.mesa?' · '+v.mesa:''}${v.cliNombre?' · '+escapeHtml(v.cliNombre):''}</div>
      ${v.tipo==='domicilio'?`<div class="text-xs text-gray" style="margin-bottom:8px;">${ic('i-pin')} ${escapeHtml(v.cliDir||'')}<br>${ic('i-phone')} ${escapeHtml(v.cliTel||'')}</div>`:''}
      ${v.items.map(i=>`<div style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);"><span style="font-size:16px;font-weight:700;">${i.qty}x</span> <span style="font-size:14px;">${escapeHtml(i.nombre)}</span>${i.obs?`<div class="text-xs text-red" style="margin-top:2px;">${ic('i-warning')} ${escapeHtml(i.obs)}</div>`:''}</div>`).join('')}
      ${v.obs?`<div style="margin-top:8px;padding:6px 10px;background:rgba(230,126,34,0.1);border-radius:6px;font-size:12px;color:var(--orange);">${escapeHtml(v.obs)}</div>`:''}
      <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">
        ${v.estadoCocina!=='preparando'&&v.estadoCocina!=='listo'?`<button class="btn btn-primary btn-sm" onclick="setEstadoCocina('${v.id}','preparando')">${ic('i-chef')} Preparando</button>`:''}
        ${v.estadoCocina!=='listo'?`<button class="btn btn-success btn-sm" onclick="setEstadoCocina('${v.id}','listo')">${ic('i-check')} Listo</button>`:`<span class="badge badge-green">${ic('i-check')} Listo</span>`}
        ${v.estadoCocina==='listo'?`<button class="btn btn-gold btn-sm" onclick="llamarMesero('${v.id}')">${ic('i-bell')} Llamar mesero</button>`:''}
      </div></div>`;}).join('')}</div>`;
}
function llamarMesero(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  // Marca un aviso que verán cajero/meseros, y suena alarma
  const vs=DB.get('ventas')||[]; const t=vs.find(x=>x.id===id);
  if(t){ t.llamadoMesero=true; t.llamadoEn=now(); fusionarYGuardarVentas(vs); }
  try{ sonidoListo(); }catch(e){}
  toast(`Avisando: ${refCocina(v)} está listo para entregar`,'success');
}
function setEstadoCocina(id,e){
  const vs=DB.get('ventas')||[]; const v=vs.find(x=>x.id===id);
  if(v){ v.estadoCocina=e; if(e==='entregado') v.estadoPedido='entregado';
    if(e==='preparando' && !v.horaPreparando) v.horaPreparando=now();
    if(e==='listo' && !v.horaListo) v.horaListo=now();  // momento en que quedó listo (para medir tiempos)
    fusionarYGuardarVentas(vs);
    if(e==='listo'){ sonidoListo(); toast(`${refCocina(v)} listo para entregar`,'success'); } logAudit('Cocina: '+e,v.factura||v.cliNombre); }
  showPage(STATE.page); updateBadges();
}

// ========================= CAJA =========================
function caja(){
  const c=DB.get('caja_actual'); const cierres=DB.get('cierres')||[];
  const puedeAbrir = ['admin','cajero','supervisor'].includes(STATE.user.rol);
  if(!c){
    return `<div class="card" style="max-width:480px;margin:0 auto;text-align:center;padding:36px;">
      <div style="font-size:48px;color:var(--red-light);margin-bottom:12px;">${ic('i-lock')}</div>
      <h2 style="font-family:Cinzel,serif;color:var(--gold);margin-bottom:10px;">Caja Cerrada</h2>
      ${puedeAbrir
        ? `<p class="text-gray mb-2">La caja está cerrada. Ábrala con la base inicial para comenzar a operar.</p>
           <button class="btn btn-gold" onclick="abrirModalCaja()" style="padding:13px 30px;">${ic('i-lock')} Abrir Caja</button>`
        : `<p class="text-gray mb-2">La caja está cerrada. Solo el cajero, administrador o supervisor pueden abrirla.</p>`}
      ${(['admin','supervisor'].includes(STATE.user.rol) && (DB.get('config')||{}).baseSiguiente)?`
        <div style="margin-top:16px;border-top:1px solid rgba(212,175,55,0.15);padding-top:14px;">
          <p class="text-sm text-gray">Base guardada para mañana: <strong class="text-gold">${fmtMoney((DB.get('config')||{}).baseSiguiente)}</strong></p>
          <button class="btn btn-ghost btn-sm mt-1" onclick="retiroCajaCerrada()" style="border-color:var(--blue);">${ic('i-cash')} Retirar dinero de la caja cerrada</button>
          <p class="text-xs text-gray mt-1">Reduce la base con la que abrirá mañana. Queda registrado.</p>
        </div>`:''}
      </div>
      ${cierres.length>0&&puedeAbrir?`<div class="card mt-2"><div class="card-title">${ic('i-history')} Historial de Cierres</div><div class="table-wrap"><table class="data-table"><thead><tr><th>Cajero</th><th>Fondo</th><th>Total Ventas</th><th>Esperado</th><th>Contado</th><th>Cuadre</th><th>Cierre</th></tr></thead><tbody>${cierres.slice(0,15).map(c=>{ const d=c.diferencia; const cuadre = d===undefined?'<span class="text-gray">—</span>':d===0?'<span class="badge badge-green">Cuadrada</span>':d>0?`<span class="badge badge-blue">Sobra ${fmtMoney(d)}</span>`:`<span class="badge badge-red">Falta ${fmtMoney(Math.abs(d))}</span>`; return `<tr><td>${escapeHtml(c.cajero)}</td><td>${fmtMoney(c.fondo)}</td><td class="font-bold text-gold">${fmtMoney(c.total)}</td><td>${c.esperadoEfectivo!==undefined?fmtMoney(c.esperadoEfectivo):'—'}</td><td>${c.contadoEfectivo!==undefined?fmtMoney(c.contadoEfectivo):'—'}</td><td>${cuadre}</td><td class="text-xs text-gray">${fmtDate(c.cierre)}</td></tr>`; }).join('')}</tbody></table></div></div>`:''}`;
  }
  const movs=c.movimientos||[];
  const vs=(DB.get('ventas')||[]).filter(v=>esPagada(v)&&v.cajaId===c.id);
  // VENTA (solo comida) por cada método: esto es lo que muestran las tarjetas.
  const porMetodo={}; METODOS_PAGO.forEach(([k])=>porMetodo[k]=0);
  vs.forEach(v=>{ METODOS_PAGO.forEach(([k])=>{ porMetodo[k]+=montoPorMetodoDe(v,k); }); });
  const totalVentaPorMetodo=Object.values(porMetodo).reduce((a,b)=>a+b,0);
  // VENTAS REALES = solo la comida
  const ventasReales=vs.reduce((a,v)=>a+(v.ventaReal!==undefined?v.ventaReal:v.total),0);
  const totalV=ventasReales;
  // Conceptos que NO son ingreso del negocio (van a terceros)
  const totalPropinas=vs.reduce((a,v)=>a+(v.propina||0),0);
  const totalDomicilios=vs.reduce((a,v)=>a+(v.valorDom||0),0);
  const totalRecargos=vs.reduce((a,v)=>a+(v.recargo||0),0);
  // Domicilios que entraron por banco (el restaurante se los paga al domiciliario en efectivo)
  const totalDomBanco=vs.reduce((a,v)=>a+(v.domPorBanco?(v.valorDom||0):0),0);
  // Movimientos de caja
  const entradas=movs.filter(m=>m.tipo==='entrada').reduce((a,m)=>a+m.monto,0);
  const gastos=movs.filter(m=>m.tipo==='salida'||m.tipo==='gasto'||m.tipo==='nomina').reduce((a,m)=>a+m.monto,0);
  const retiros=movs.filter(m=>m.tipo==='retiro').reduce((a,m)=>a+m.monto,0);
  // Efectivo que debe haber en el cajón
  const efectivoVentas=vs.reduce((a,v)=>a+efectivoEnCajaDe(v),0);
  // Domicilios por banco: se le pagan al domiciliario en EFECTIVO del cajón → ese efectivo SALE.
  const domiBanco=vs.reduce((a,v)=>a+domicilioSalidaEfectivo(v),0);
  const enCaja=c.fondo+efectivoVentas+entradas-gastos-retiros-domiBanco;
  const puedeRetiro = STATE.user.rol==='admin'||STATE.user.rol==='supervisor';
  // Pedidos pendientes de verificar (Banco): su dinero aún no cuenta en el cuadre.
  const porVerificar=(DB.get('ventas')||[]).filter(v=>v.estado==='por_verificar'&&v.cajaId===c.id);
  const montoPorVerificar=porVerificar.reduce((a,v)=>a+(v.totalCobrado||v.total||0),0);

  const cards=METODOS_PAGO.map(([k,l],i)=>{ const colores=['green','blue','gold']; return `<div class="stat-card ${colores[i%3]}"><div class="stat-icon">${ic('i-cash')}</div><div class="stat-label">${l}</div><div class="stat-value">${fmtMoney(porMetodo[k])}</div></div>`; }).join('');

  return `<div class="stats-grid">${cards}</div>
  <p class="text-xs text-gray" style="margin:-4px 0 10px;">${ic('i-cash')} VENTA (solo comida) recibida por cada método. Total venta: <strong class="text-gold">${fmtMoney(totalVentaPorMetodo)}</strong>.${totalDomBanco>0?` Además entraron <strong>${fmtMoney(totalDomBanco)}</strong> de domicilios por banco (se le pagan al domiciliario en efectivo).`:''}</p>
  ${porVerificar.length>0?`<div class="card" style="border:1px solid var(--orange);background:rgba(230,126,34,0.08);">
    <div class="flex-between"><span class="text-orange font-bold">${ic('i-warning')} ${porVerificar.length} pago(s) SIN verificar — ${fmtMoney(montoPorVerificar)}</span></div>
    <p class="text-xs text-gray mt-1">Estos pagos (Banco/Llave) todavía NO cuentan en el cuadre porque faltan verificar. Ve a Pedidos y dale "Verificar" a cada uno cuando confirmes el comprobante. Si no los verificas, la caja se descuadra.</p>
  </div>`:''}
  <div class="grid-2">
    <div class="card"><div class="card-title">${ic('i-cash')} Resumen de Caja — ${escapeHtml(c.cajero)}</div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Apertura</span><span class="text-sm">${fmtDate(c.apertura)}</span></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Base Inicial</span><strong>${fmtMoney(c.fondo)}</strong></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Ventas Reales (solo comida)</span><strong class="text-gold">${fmtMoney(totalV)}</strong></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Entradas Extra</span><strong class="text-green">${fmtMoney(entradas)}</strong></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Gastos / Nómina</span><strong class="text-red">-${fmtMoney(gastos)}</strong></div>
      <div class="flex-between" style="padding:7px 0;"><span>Retiros Autorizados</span><strong class="text-red">-${fmtMoney(retiros)}</strong></div>
      <hr class="divider">
      <div class="flex-between" style="font-size:18px;font-weight:700;"><span>Efectivo en Caja</span><span class="text-gold">${fmtMoney(enCaja)}</span></div>
      <p class="text-xs text-gray mt-1">Efectivo del cajón: base + comida en efectivo + entradas − gastos − retiros${domiBanco>0?' − domicilios por banco ('+fmtMoney(domiBanco)+', pagados al domiciliario en efectivo)':''}. Propina, recargo y domicilio en efectivo no entran a caja. El banco/tarjeta tampoco está en el cajón.</p>
      ${STATE.user.rol==='admin'?`<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;color:var(--gold);">🔍 Ver desglose del efectivo (diagnóstico)</summary>
        <div style="margin-top:8px;font-size:11px;">
          <div class="flex-between" style="padding:3px 0;"><span>Base inicial</span><span>${fmtMoney(c.fondo)}</span></div>
          <div class="flex-between" style="padding:3px 0;"><span>+ Comida en efectivo</span><span>${fmtMoney(efectivoVentas)}</span></div>
          <div class="flex-between" style="padding:3px 0;"><span>+ Entradas extra</span><span>${fmtMoney(entradas)}</span></div>
          <div class="flex-between" style="padding:3px 0;"><span>− Gastos</span><span>-${fmtMoney(gastos)}</span></div>
          <div class="flex-between" style="padding:3px 0;"><span>− Retiros</span><span>-${fmtMoney(retiros)}</span></div>
          <hr style="border-color:rgba(255,255,255,0.1);margin:4px 0;">
          <div class="flex-between" style="padding:3px 0;font-weight:bold;"><span>= Efectivo esperado</span><span>${fmtMoney(enCaja)}</span></div>
          <p class="text-gray" style="margin-top:6px;">TODOS los pedidos que recibieron efectivo (para detectar descuadres):</p>
          ${vs.filter(v=>{ const ef=v.pagos?(v.pagos.efectivo||0):(v.metodo==='efectivo'?(v.totalCobrado||v.total):0); return ef>0; }).map(v=>{
            const comida=(v.ventaReal!==undefined?v.ventaReal:v.total)||0;
            const efRecibido=v.pagos?(v.pagos.efectivo||0):(v.metodo==='efectivo'?(v.totalCobrado||v.total):0);
            const efCuenta=efectivoEnCajaDe(v);
            const ba=v.pagos?(v.pagos.banco||0):0;
            // Detección correcta: el efectivo recibido por VENTA debe igualar lo que cuenta caja.
            // (el domicilio en efectivo directo NO está dentro de efRecibido, así que no se resta)
            const efVenta=v.pagosVenta?(v.pagosVenta.efectivo||0):efRecibido;
            const dif=efVenta-efCuenta;
            const alerta = Math.abs(dif)>1;
            return `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);${alerta?'background:rgba(231,76,60,0.12);':''}">
              <div class="flex-between"><span>${escapeHtml(refPedido(v))}${alerta?' ⚠':''}</span><span class="text-gold">caja cuenta ${fmtMoney(efCuenta)}</span></div>
              <div class="text-gray" style="font-size:10px;">comida ${fmtMoney(comida)} · dom ${fmtMoney(v.valorDom||0)} · prop ${fmtMoney(v.propina||0)} · recibió efectivo ${fmtMoney(efRecibido)}${ba?' · banco '+fmtMoney(ba):''}${alerta?' · ⚠ REVISAR '+fmtMoney(dif):''}</div>
            </div>`;
          }).join('')||'<span class="text-gray">Ninguno</span>'}
          <p class="text-gray" style="margin-top:8px;">TODOS los domicilios (para ver cómo se cobró cada uno):</p>
          ${vs.filter(v=>v.valorDom>0).map(v=>{
            const ba=v.pagos?(v.pagos.banco||0):0;
            const ef=v.pagos?(v.pagos.efectivo||0):0;
            const entra=v.domEntraCaja;
            return `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);${!entra&&ba>0?'background:rgba(231,76,60,0.12);':''}">
              <div class="flex-between"><span>${escapeHtml(refPedido(v))}</span><span>dom ${fmtMoney(v.valorDom)}</span></div>
              <div class="text-gray" style="font-size:10px;">forma dom: <strong>${v.domFormaPago||'NO MARCADO'}</strong> · entra a caja: ${entra?'SÍ':'NO'} · pagó: ef ${fmtMoney(ef)}${ba?' · banco '+fmtMoney(ba):''}${!entra&&ba>0?' · ⚠ domicilio por banco NO marcado':''}</div>
            </div>`;
          }).join('')||'<span class="text-gray">Sin domicilios</span>'}
        </div></details>`:''}
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">
        <button class="btn btn-ghost" onclick="openModal('modal-movimiento')">${ic('i-money-out')} Gasto</button>
        ${puedeRetiro?`<button class="btn btn-ghost" onclick="openModalRetiro()">${ic('i-money-out')} Retiro</button>`:''}
        <button class="btn btn-danger" onclick="cerrarCaja()" style="flex:1;">${ic('i-lock')} Cerrar Caja</button>
      </div></div>
    <div class="card"><div class="card-title">${ic('i-orders')} No son ingreso del negocio</div>
      <p class="text-xs text-gray mb-2">Estos valores se cobran pero pertenecen a terceros. No suman a las ventas reales.</p>
      <div class="flex-between" style="padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>${ic('i-users')} Propinas (del mesero)</span><strong class="text-green">${fmtMoney(totalPropinas)}</strong></div>
      <div class="flex-between" style="padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>${ic('i-delivery')} Domicilios (del domiciliario)</span><strong class="text-blue">${fmtMoney(totalDomicilios)}</strong></div>
      <div class="flex-between" style="padding:9px 0;"><span>${ic('i-cash')} Recargos datáfono</span><strong class="text-gold">${fmtMoney(totalRecargos)}</strong></div>
      ${totalPropinas>0?`<hr class="divider"><div class="card-title" style="font-size:11px;">Propinas por mesero</div>${propinasPorMesero(vs)}`:''}
    </div></div>
  <div class="card"><div class="card-title">${ic('i-orders')} Movimientos del Día</div>
    ${movs.length===0?`<p class="text-gray text-sm">Sin movimientos registrados</p>`:
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Tipo</th><th>Descripción</th><th>Usuario</th><th>Monto</th><th>Hora</th>${STATE.user.rol==='admin'?'<th>Corregir</th>':''}</tr></thead><tbody>${movs.slice().reverse().map((m,ri)=>{ const realIdx=movs.length-1-ri; return `<tr><td>${movBadge(m.tipo)}</td><td>${escapeHtml(m.desc)}${m.empleado?'<br><span class="text-xs text-gray">'+escapeHtml(m.empleado)+'</span>':''}</td><td class="text-xs">${escapeHtml(m.usuario||'')}</td><td class="${m.tipo==='entrada'?'text-green':'text-red'}">${m.tipo==='entrada'?'+':'-'}${fmtMoney(m.monto)}</td><td class="text-xs text-gray">${fmtDate(m.fecha)}</td>${STATE.user.rol==='admin'?`<td style="display:flex;gap:5px;"><button class="btn btn-ghost btn-sm" onclick="editarMovimiento(${realIdx})" title="Editar">${ic('i-edit')}</button><button class="btn btn-danger btn-sm" onclick="eliminarMovimiento(${realIdx})" title="Eliminar">${ic('i-trash')}</button></td>`:''}</tr>`; }).join('')}</tbody></table></div>${STATE.user.rol==='admin'?'<p class="text-xs text-gray mt-1">Como administrador puede corregir o eliminar un movimiento si hubo un error. Queda registrado en auditoría.</p>':''}`}
  </div>`;
}
function propinasPorMesero(vs){
  const x={}; vs.forEach(v=>{ if(v.propina>0){ const m=v.mesero||v.cajero||'—'; x[m]=(x[m]||0)+v.propina; } });
  return Object.entries(x).map(([m,t])=>`<div class="flex-between text-sm" style="padding:4px 0;"><span>${escapeHtml(m)}</span><span class="text-green">${fmtMoney(t)}</span></div>`).join('')||'<span class="text-xs text-gray">—</span>';
}
function movBadge(t){ const m={entrada:['badge-green','Entrada'],salida:['badge-red','Salida'],gasto:['badge-orange','Gasto'],nomina:['badge-red','Nómina'],retiro:['badge-blue','Retiro']}; const x=m[t]||['badge-gray',t]; return `<span class="badge ${x[0]}">${x[1]}</span>`; }
function retiroCajaCerrada(){
  if(!['admin','supervisor'].includes(STATE.user.rol)){ toast('Solo admin o supervisor','error'); return; }
  const cfg=DB.get('config')||{};
  const base=cfg.baseSiguiente||0;
  const txt=prompt(`Base guardada para mañana: ${fmtMoney(base)}\n\n¿Cuánto dinero va a retirar? (se descontará de la base de mañana)`);
  if(txt===null) return;
  const monto=parseFloat(txt)||0;
  if(monto<=0){ toast('Monto inválido','error'); return; }
  if(monto>base){ toast('No puede retirar más de la base guardada','error'); return; }
  const nuevaBase=base-monto;
  cfg.baseSiguiente=nuevaBase;
  cfg.retirosCajaCerrada=cfg.retirosCajaCerrada||[];
  cfg.retirosCajaCerrada.unshift({monto,por:STATE.user.nombre,fecha:now(),baseAntes:base,baseDespues:nuevaBase});
  DB.set('config',cfg);
  logAudit('Retiro con caja cerrada',`${fmtMoney(monto)} retirado por ${STATE.user.nombre}. Base mañana: ${fmtMoney(base)} → ${fmtMoney(nuevaBase)}`);
  toast(`Retirados ${fmtMoney(monto)}. Base de mañana: ${fmtMoney(nuevaBase)}`,'success');
  showPage('caja');
}
function abrirModalCaja(){
  const cfg=DB.get('config')||{};
  const baseObl=cfg.baseSiguiente;
  const input=document.getElementById('caja-fondo');
  const aviso=document.getElementById('caja-base-aviso');
  if(baseObl!==undefined && baseObl!==null){
    // Base obligatoria = lo que quedó al cerrar ayer. Bloqueada.
    if(input){ input.value=baseObl; input.readOnly=true; input.style.opacity='0.7'; }
    if(aviso) aviso.innerHTML=`La base de hoy es <strong>${fmtMoney(baseObl)}</strong>, igual a lo que quedó contado en el último cierre. No se puede cambiar.`;
  } else {
    if(input){ input.readOnly=false; input.style.opacity='1'; }
    if(aviso) aviso.textContent='Primera apertura: ingrese la base con la que inicia.';
  }
  openModal('modal-caja');
}
function abrirCaja(){
  if(STATE.user.rol==='mesero'){ toast('Un mesero no puede abrir caja','error'); closeModal('modal-caja'); return; }
  const cfg=DB.get('config')||{};
  let fondo=parseFloat(document.getElementById('caja-fondo').value)||0;
  // Si hay base obligatoria del cierre anterior, forzarla
  if(cfg.baseSiguiente!==undefined && cfg.baseSiguiente!==null){ fondo=cfg.baseSiguiente; }
  DB.set('caja_actual',{id:uid(),cajero:STATE.user.nombre,apertura:now(),fondo,movimientos:[],ordenSeq:0});
  logAudit('Abrió caja',`Base: ${fmtMoney(fondo)}`); closeModal('modal-caja'); toast('Caja abierta','success'); showPage('caja');
}
function openModalRetiro(){
  document.getElementById('ret-monto').value=''; document.getElementById('ret-motivo').value='';
  openModal('modal-retiro');
}
function saveRetiro(){
  const monto=parseFloat(document.getElementById('ret-monto').value)||0;
  const motivo=document.getElementById('ret-motivo').value.trim();
  if(monto<=0){ toast('Ingrese un monto válido','error'); return; }
  const c=DB.get('caja_actual'); if(!c){ toast('No hay caja abierta','error'); closeModal('modal-retiro'); return; }
  if(!Array.isArray(c.movimientos)) c.movimientos=[];
  c.movimientos.push({id:uid(),tipo:'retiro',monto,desc:motivo||'Retiro de efectivo',usuario:STATE.user.nombre,fecha:now()});
  DB.set('caja_actual',c);
  logAudit('Retiro de efectivo',`${fmtMoney(monto)} - ${motivo} (por ${STATE.user.nombre})`);
  closeModal('modal-retiro'); toast('Retiro registrado','success'); showPage('caja');
}
function eliminarMovimiento(idx){
  if(STATE.user.rol!=='admin'){ toast('Solo el administrador puede corregir movimientos','error'); return; }
  const c=DB.get('caja_actual'); if(!c||!Array.isArray(c.movimientos)) return;
  const m=c.movimientos[idx]; if(!m) return;
  if(!confirm(`¿Eliminar este movimiento?\n\n${m.tipo.toUpperCase()}: ${fmtMoney(m.monto)}\n${m.desc||''}\n\nEsto corrige el cuadre de caja. Quedará en auditoría.`)) return;
  c.movimientos.splice(idx,1);
  DB.set('caja_actual',c);
  logAudit('Eliminó movimiento (corrección)',`${m.tipo} ${fmtMoney(m.monto)} - ${m.desc||''} (por ${STATE.user.nombre})`);
  toast('Movimiento eliminado','success'); showPage('caja');
}
let editMovIdx=null;
function editarMovimiento(idx){
  if(STATE.user.rol!=='admin'){ toast('Solo el administrador puede corregir movimientos','error'); return; }
  const c=DB.get('caja_actual'); if(!c||!Array.isArray(c.movimientos)) return;
  const m=c.movimientos[idx]; if(!m) return;
  editMovIdx=idx;
  document.getElementById('editmov-monto').value=m.monto;
  document.getElementById('editmov-desc').value=m.desc||'';
  openModal('modal-editmov');
}
function saveEditMovimiento(){
  if(STATE.user.rol!=='admin') return;
  const c=DB.get('caja_actual'); if(!c||!Array.isArray(c.movimientos)) return;
  const m=c.movimientos[editMovIdx]; if(!m){ closeModal('modal-editmov'); return; }
  const nuevoMonto=parseFloat(document.getElementById('editmov-monto').value)||0;
  const nuevaDesc=document.getElementById('editmov-desc').value.trim();
  if(nuevoMonto<=0){ toast('Monto inválido','error'); return; }
  const antes=`${fmtMoney(m.monto)} - ${m.desc||''}`;
  m.monto=nuevoMonto; m.desc=nuevaDesc||m.desc; m.editadoPor=STATE.user.nombre; m.editadoEn=now();
  DB.set('caja_actual',c);
  logAudit('Editó movimiento (corrección)',`Antes: ${antes} → Ahora: ${fmtMoney(nuevoMonto)} - ${nuevaDesc} (por ${STATE.user.nombre})`);
  closeModal('modal-editmov'); toast('Movimiento corregido','success'); showPage('caja');
}
function saveMovimiento(){
  const tipo=document.getElementById('mov-tipo').value;
  const monto=parseFloat(document.getElementById('mov-monto').value)||0;
  const desc=document.getElementById('mov-desc').value;
  const empleado=document.getElementById('mov-empleado').value;
  if(monto<=0){ toast('Ingrese un monto válido','error'); return; }
  const c=DB.get('caja_actual'); if(!c){ toast('No hay caja abierta','error'); closeModal('modal-movimiento'); return; }
  if(!Array.isArray(c.movimientos)) c.movimientos=[];
  c.movimientos.push({id:uid(),tipo,monto,desc:desc||(tipo==='nomina'?'Pago de nómina':tipo),empleado,usuario:STATE.user.nombre,fecha:now()});
  DB.set('caja_actual',c);
  logAudit('Registró '+tipo,`${fmtMoney(monto)} - ${desc} ${empleado?'('+empleado+')':''}`);
  // limpiar campos
  document.getElementById('mov-monto').value=''; document.getElementById('mov-desc').value=''; document.getElementById('mov-empleado').value='';
  closeModal('modal-movimiento'); toast('Movimiento registrado','success'); showPage('caja');
}
function toggleEmpleadoField(){
  const t=document.getElementById('mov-tipo').value;
  document.getElementById('mov-empleado-wrap').style.display = t==='nomina'?'block':'none';
}
function cerrarCaja(){
  const c=DB.get('caja_actual'); if(!c) return;
  const vs=(DB.get('ventas')||[]).filter(v=>esPagada(v)&&v.cajaId===c.id);
  const efectivoVentas=vs.reduce((a,v)=>a+efectivoEnCajaDe(v),0);
  const entradas=(c.movimientos||[]).filter(m=>m.tipo==='entrada').reduce((a,m)=>a+m.monto,0);
  const gastos=(c.movimientos||[]).filter(m=>m.tipo==='salida'||m.tipo==='gasto'||m.tipo==='nomina').reduce((a,m)=>a+m.monto,0);
  const retiros=(c.movimientos||[]).filter(m=>m.tipo==='retiro').reduce((a,m)=>a+m.monto,0);
  const domiBanco=vs.reduce((a,v)=>a+domicilioSalidaEfectivo(v),0);
  const esperadoEfectivo=c.fondo+efectivoVentas+entradas-gastos-retiros-domiBanco;
  window._cierreEsperado=esperadoEfectivo;
  document.getElementById('cierre-esperado').textContent=fmtMoney(esperadoEfectivo);
  document.getElementById('cierre-contado').value='';
  document.getElementById('cierre-dif').innerHTML='<span class="text-gray">Cuente el efectivo del cajón</span>';
  document.getElementById('cierre-obs').value='';
  openModal('modal-cierre');
}
function calcularDiferencia(){
  const contado=parseFloat(document.getElementById('cierre-contado').value)||0;
  const esperado=window._cierreEsperado||0;
  const dif=contado-esperado;
  const el=document.getElementById('cierre-dif');
  if(!document.getElementById('cierre-contado').value){ el.innerHTML='<span class="text-gray">Cuente el efectivo del cajón</span>'; return; }
  if(dif===0) el.innerHTML=`<span class="text-green font-bold">✓ Caja cuadrada perfectamente</span>`;
  else if(dif>0) el.innerHTML=`<span style="color:var(--blue-l);font-weight:700;">Sobra ${fmtMoney(dif)}</span>`;
  else el.innerHTML=`<span class="text-red font-bold">Falta ${fmtMoney(Math.abs(dif))}</span>`;
}
function confirmarCierre(){
  const c=DB.get('caja_actual'); if(!c){ closeModal('modal-cierre'); return; }
  const contado=parseFloat(document.getElementById('cierre-contado').value);
  if(isNaN(contado)){ toast('Ingrese el efectivo contado','error'); return; }
  const obs=document.getElementById('cierre-obs').value;
  const vs=(DB.get('ventas')||[]).filter(v=>esPagada(v)&&v.cajaId===c.id);
  const porMetodo={}; METODOS_PAGO.forEach(([k])=>porMetodo[k]=vs.reduce((a,v)=>a+montoPorMetodoDe(v,k),0));
  const totalVentas=Object.values(porMetodo).reduce((a,b)=>a+b,0);
  const propinas=vs.reduce((a,v)=>a+(v.propina||0),0);
  const domicilios=vs.reduce((a,v)=>a+(v.valorDom||0),0);
  const recargos=vs.reduce((a,v)=>a+(v.recargo||0),0);
  const efectivoVentas=vs.reduce((a,v)=>a+efectivoEnCajaDe(v),0);
  const entradas=(c.movimientos||[]).filter(m=>m.tipo==='entrada').reduce((a,m)=>a+m.monto,0);
  const gastos=(c.movimientos||[]).filter(m=>m.tipo==='salida'||m.tipo==='gasto'||m.tipo==='nomina').reduce((a,m)=>a+m.monto,0);
  const retiros=(c.movimientos||[]).filter(m=>m.tipo==='retiro').reduce((a,m)=>a+m.monto,0);
  const domiBanco=vs.reduce((a,v)=>a+domicilioSalidaEfectivo(v),0);
  const esperadoEfectivo=c.fondo+efectivoVentas+entradas-gastos-retiros-domiBanco;
  const diferencia=contado-esperadoEfectivo;
  const cierre={...c,cierre:now(),porMetodo,gastos,entradas,retiros,propinas,domicilios,recargos,domiBanco,
    total:totalVentas, esperadoEfectivo, contadoEfectivo:contado, baseFinal:contado, diferencia, obsCierre:obs, cerradoPor:STATE.user.nombre};
  const cs=DB.get('cierres')||[]; cs.unshift(cierre); DB.set('cierres',cs); DB.set('caja_actual',null);
  // La base del día siguiente DEBE ser lo que quedó contado al cerrar
  const cfg=DB.get('config')||{}; cfg.baseSiguiente=contado; DB.set('config',cfg);
  logAudit('Cerró caja',`${c.cajero} - Ventas: ${fmtMoney(totalVentas)} - ${diferencia===0?'Cuadrada':diferencia>0?'Sobra '+fmtMoney(diferencia):'Falta '+fmtMoney(Math.abs(diferencia))} - Base día siguiente: ${fmtMoney(contado)}`);
  closeModal('modal-cierre');
  toast(diferencia===0?'Caja cerrada y cuadrada':diferencia>0?`Caja cerrada. Sobran ${fmtMoney(diferencia)}`:`Caja cerrada. Faltan ${fmtMoney(Math.abs(diferencia))}`, diferencia===0?'success':'error');
  imprimirCierre(cierre);
  showPage('caja');
}
function imprimirCierre(c){
  const cfg=DB.get('config')||{};
  const dif=c.diferencia||0;
  const html=`<div style="font-family:'Courier New',monospace;color:#000;">
    <div style="text-align:center;font-size:15px;font-weight:bold;">${escapeHtml(cfg.nombre||'Portal Imperial')}</div>
    <div style="text-align:center;font-size:13px;font-weight:bold;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:4px 0;margin:6px 0;">CIERRE DE CAJA</div>
    <div style="font-size:11px;line-height:1.7;">
      <div style="display:flex;justify-content:space-between;"><span>Cajero:</span><span>${escapeHtml(c.cajero)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Apertura:</span><span>${fmtDate(c.apertura)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Cierre:</span><span>${fmtDate(c.cierre)}</span></div>
    </div>
    <div style="border-top:1px dashed #000;margin:6px 0;padding-top:6px;font-size:11px;line-height:1.7;">
      <div style="display:flex;justify-content:space-between;"><span>Base inicial</span><span>${fmtMoney(c.fondo)}</span></div>
      ${METODOS_PAGO.map(([k,l])=>`<div style="display:flex;justify-content:space-between;"><span>Ventas ${l}</span><span>${fmtMoney((c.porMetodo&&c.porMetodo[k])||0)}</span></div>`).join('')}
      <div style="display:flex;justify-content:space-between;"><span>Entradas</span><span>${fmtMoney(c.entradas||0)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Gastos/nómina</span><span>-${fmtMoney(c.gastos||0)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Retiros</span><span>-${fmtMoney(c.retiros||0)}</span></div>
    </div>
    <div style="border-top:1px dashed #000;margin:6px 0;padding-top:6px;font-size:10px;line-height:1.6;color:#333;">
      <div style="display:flex;justify-content:space-between;"><span>Propinas (no ingreso)</span><span>${fmtMoney(c.propinas||0)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Domicilios (no ingreso)</span><span>${fmtMoney(c.domicilios||0)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Recargos datáfono</span><span>${fmtMoney(c.recargos||0)}</span></div>
    </div>
    <div style="border-top:1px dashed #000;margin:6px 0;padding-top:6px;font-size:12px;line-height:1.8;">
      <div style="display:flex;justify-content:space-between;font-weight:bold;"><span>Total ventas reales</span><span>${fmtMoney(c.total)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Efectivo esperado</span><span>${fmtMoney(c.esperadoEfectivo)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Efectivo contado</span><span>${fmtMoney(c.contadoEfectivo)}</span></div>
    </div>
    <div style="border:2px solid #000;border-radius:4px;margin-top:6px;padding:6px;text-align:center;font-size:14px;font-weight:bold;">
      ${dif===0?'CAJA CUADRADA':dif>0?'SOBRA '+fmtMoney(dif):'FALTA '+fmtMoney(Math.abs(dif))}
    </div>
    ${c.obsCierre?`<div style="font-size:10px;margin-top:6px;">Obs: ${escapeHtml(c.obsCierre)}</div>`:''}
    <div style="text-align:center;font-size:10px;margin-top:8px;">Firma: _______________</div>
  </div>`;
  imprimirHTML(html);
}

// ========================= DOMICILIOS / CLIENTES =========================
function domicilios(){
  const cls=DB.get('clientes')||[];
  return `<div class="card"><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-delivery')} Clientes Frecuentes</div>
    <button class="btn btn-primary btn-sm" onclick="openModalCliente()">${ic('i-plus')} Nuevo Cliente</button></div>
    ${cls.length===0?`<div class="empty-state">${ic('i-empty')}<p>Sin clientes registrados</p></div>`:
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Nombre</th><th>Teléfono</th><th>Dirección</th><th>Barrio</th><th>Pedidos</th><th>Acciones</th></tr></thead><tbody>
    ${cls.map(c=>`<tr><td class="font-bold">${escapeHtml(c.nombre)}</td><td>${escapeHtml(c.tel||'')}</td><td>${escapeHtml(c.dir||'')}</td><td>${c.barrio?`<span class="badge badge-blue">${escapeHtml(c.barrio)}</span>`:'—'}</td><td>${c.pedidos||0}</td><td style="display:flex;gap:6px;"><button class="btn btn-ghost btn-sm" onclick="openModalCliente('${c.id}')">${ic('i-edit')}</button>${(STATE.user.rol==='admin'||STATE.user.rol==='supervisor')?`<button class="btn btn-danger btn-sm" onclick="eliminarCliente('${c.id}')">${ic('i-trash')}</button>`:''}</td></tr>`).join('')}
    </tbody></table></div>`}</div>`;
}
function openModalCliente(id){
  ['c-nombre','c-tel','c-dir','c-barrio'].forEach(i=>document.getElementById(i).value='');
  document.getElementById('edit-cli-id').value='';
  if(id){ const c=(DB.get('clientes')||[]).find(x=>x.id===id); if(c){ document.getElementById('edit-cli-id').value=c.id;
    document.getElementById('c-nombre').value=c.nombre||''; document.getElementById('c-tel').value=c.tel||'';
    document.getElementById('c-dir').value=c.dir||''; document.getElementById('c-barrio').value=c.barrio||''; }}
  document.getElementById('modal-cli-title').innerHTML=ic('i-delivery')+(id?' Editar Cliente':' Nuevo Cliente');
  openModal('modal-cliente');
}
function saveCliente(){
  const id=document.getElementById('edit-cli-id').value; const cls=DB.get('clientes')||[];
  const data={nombre:document.getElementById('c-nombre').value.trim(),tel:document.getElementById('c-tel').value.trim(),dir:document.getElementById('c-dir').value.trim(),barrio:document.getElementById('c-barrio').value.trim()};
  if(!data.nombre){ toast('Nombre requerido','error'); return; }
  if(id){ const idx=cls.findIndex(x=>x.id===id); if(idx>=0) cls[idx]={...cls[idx],...data}; }
  else cls.unshift({id:uid(),...data,pedidos:0,creado:now()});
  DB.set('clientes',cls); logAudit(id?'Editó cliente':'Creó cliente',data.nombre);
  closeModal('modal-cliente'); toast('Cliente guardado','success'); showPage('domicilios');
}
function eliminarCliente(id){ if(!confirm('¿Eliminar este cliente?')) return; DB.set('clientes',(DB.get('clientes')||[]).filter(c=>c.id!==id)); logAudit('Eliminó cliente',id); showPage('domicilios'); }

// ========================= USUARIOS =========================
function usuarios(){
  if(STATE.user.rol!=='admin') return `<div class="empty-state">${ic('i-lock')}<p>Acceso restringido. Solo el administrador puede gestionar usuarios.</p></div>`;
  const us=DB.get('usuarios')||[];
  return `<div class="card"><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-users')} Gestión de Usuarios</div>
    <button class="btn btn-primary btn-sm" onclick="openModalUsuario()">${ic('i-plus')} Nuevo Usuario</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>
    ${us.map(u=>`<tr><td class="font-bold">${escapeHtml(u.nombre)}</td><td><span class="text-gold">${escapeHtml(u.usuario)}</span></td><td><span class="badge ${u.rol==='admin'?'badge-red':u.rol==='supervisor'?'badge-blue':u.rol==='cocina'?'badge-orange':'badge-gold'}">${u.rol}</span></td><td><span class="badge ${u.activo?'badge-green':'badge-gray'}">${u.activo?'Activo':'Inactivo'}</span></td><td style="display:flex;gap:6px;"><button class="btn btn-ghost btn-sm" onclick="openModalUsuario('${u.id}')" title="Editar">${ic('i-edit')}</button><button class="btn btn-${u.activo?'danger':'success'} btn-sm" onclick="toggleUsuario('${u.id}')" title="${u.activo?'Desactivar':'Activar'}">${u.activo?ic('i-ban'):ic('i-check')}</button><button class="btn btn-danger btn-sm" onclick="eliminarUsuario('${u.id}')" title="Eliminar definitivamente">${ic('i-trash')}</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
}
function openModalUsuario(id){
  ['u-nombre','u-usuario','u-pass'].forEach(i=>document.getElementById(i).value='');
  document.getElementById('edit-uid').value=''; document.getElementById('u-rol').value='cajero';
  document.getElementById('u-pass').placeholder='Contraseña';
  if(id){ const u=(DB.get('usuarios')||[]).find(x=>x.id===id); if(u){ document.getElementById('edit-uid').value=u.id;
    document.getElementById('u-nombre').value=u.nombre; document.getElementById('u-usuario').value=u.usuario;
    document.getElementById('u-rol').value=u.rol; document.getElementById('u-pass').placeholder='Dejar vacío para no cambiar'; }}
  document.getElementById('modal-usuario-title').innerHTML=ic('i-users')+(id?' Editar Usuario':' Nuevo Usuario');
  openModal('modal-usuario');
}
function saveUsuario(){
  const id=document.getElementById('edit-uid').value; const us=DB.get('usuarios')||[];
  const nombre=document.getElementById('u-nombre').value.trim(), usuario=document.getElementById('u-usuario').value.trim();
  const pass=document.getElementById('u-pass').value, rol=document.getElementById('u-rol').value;
  if(!nombre||!usuario){ toast('Complete los campos','error'); return; }
  if(id){ const idx=us.findIndex(x=>x.id===id); if(idx>=0){ us[idx].nombre=nombre; us[idx].usuario=usuario; us[idx].rol=rol; if(pass) us[idx].pass=pass; }}
  else { if(!pass){ toast('Contraseña requerida','error'); return; } us.push({id:uid(),nombre,usuario,pass,rol,activo:true,creado:now()}); }
  DB.set('usuarios',us); logAudit(id?'Editó usuario':'Creó usuario',nombre);
  closeModal('modal-usuario'); toast('Usuario guardado','success'); showPage('usuarios');
}
function toggleUsuario(id){ const us=DB.get('usuarios')||[]; const u=us.find(x=>x.id===id); if(u){u.activo=!u.activo;DB.set('usuarios',us);logAudit((u.activo?'Activó':'Desactivó')+' usuario',u.nombre);} showPage('usuarios'); }
function eliminarUsuario(id){
  if(STATE.user.rol!=='admin'){ toast('Solo el administrador puede eliminar usuarios','error'); return; }
  const us=DB.get('usuarios')||[]; const u=us.find(x=>x.id===id); if(!u) return;
  if(u.id===STATE.user.id){ toast('No puede eliminarse a sí mismo','error'); return; }
  if(u.usuario==='admin'){ toast('No se puede eliminar el administrador principal','error'); return; }
  const protegidos=['biometria','impresiones'];
  if(protegidos.includes(u.usuario)){
    if(!confirm(`"${u.nombre}" es un usuario del sistema (${u.usuario}). Si lo elimina, se volverá a crear solo al recargar. ¿Eliminar de todas formas?`)) return;
  }
  if(!confirm(`¿Eliminar DEFINITIVAMENTE al usuario "${u.nombre}" (${u.usuario})?\n\nEsto no se puede deshacer. El usuario desaparece de la lista.`)) return;
  const nuevos=us.filter(x=>x.id!==id);
  DB.set('usuarios',nuevos);
  logAudit('Eliminó usuario definitivamente',`${u.nombre} (${u.usuario}) por ${STATE.user.nombre}`);
  toast('Usuario eliminado','success');
  showPage('usuarios');
}

// ========================= HISTORIAL =========================
function historial(){
  const vs=DB.get('ventas')||[];
  return `<div class="card"><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-history')} Historial de Ventas</div>
    <div style="position:relative;"><span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--gray3)">${ic('i-search')}</span><input type="text" id="hist-q" placeholder="Factura, cliente, teléfono..." value="${escapeHtml(STATE.histQ||'')}" oninput="STATE.histQ=this.value;document.getElementById('hist-table-wrap').innerHTML=renderHistTable(DB.get('ventas')||[])" style="padding-left:34px;width:240px;"></div></div>
    <div id="hist-table-wrap">${renderHistTable(vs)}</div></div>`;
}
function renderHistTable(vs){
  const q=(STATE.histQ||'').toLowerCase().trim();
  const list=vs.filter(v=>!q||(v.factura||'').toLowerCase().includes(q)||(v.cliNombre||'').toLowerCase().includes(q)||(v.cliTel||'').includes(q)||(v.domiciliario||'').toLowerCase().includes(q)||(v.mesa||'').toLowerCase().includes(q));
  if(list.length===0) return `<div class="empty-state">${ic('i-empty')}<p>Sin resultados${q?' para "'+escapeHtml(q)+'"':''}</p></div>`;
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Pedido</th><th>Tipo</th><th>Cliente/Mesa</th><th>Subtotal</th><th>Desc.</th><th>Total</th><th>Método</th><th>Estado</th><th>Fecha</th><th></th></tr></thead><tbody>
  ${list.map(v=>`<tr style="${v.estado==='anulada'?'opacity:.4':''}"><td><span class="text-gold font-bold">${refPedido(v)}</span>${v.estado==='anulada'?'<br><span class="text-xs text-red">(ANULADA)</span>':''}</td><td>${tipoLabel(v.tipo)}</td><td>${escapeHtml(v.cliNombre||v.mesa||'—')}</td><td>${fmtMoney(v.subtotal||v.total)}</td><td>${v.descuento>0?fmtMoney(v.descuento):'—'}</td><td class="font-bold">${fmtMoney(v.total)}</td><td>${v.metodo||'—'}</td><td>${estadoBadge(v.estado)}</td><td class="text-xs text-gray">${fmtDate(v.fecha)}</td><td><button class="btn btn-ghost btn-sm" onclick="reimprimir('${v.id}')">${ic('i-print')}</button></td></tr>`).join('')}
  </tbody></table></div>`;
}

// ========================= REPORTES =========================
function reportes(){
  const vs=DB.get('ventas')||[]; const t=today();
  const hoy=vs.filter(v=>v.fecha?.startsWith(t)&&esPagada(v)); const totalHoy=hoy.reduce((a,v)=>a+v.total,0);
  const weekly=[]; for(let i=6;i>=0;i--){ const d=new Date(ahoraMs()-i*864e5); const dk=d.toISOString().split('T')[0];
    const p=vs.filter(v=>v.fecha?.startsWith(dk)&&esPagada(v)); weekly.push({lbl:d.toLocaleDateString('es-CO',{weekday:'short'}),total:p.reduce((a,v)=>a+v.total,0)}); }
  const monthly=[]; for(let i=11;i>=0;i--){ const d=new Date(); d.setMonth(d.getMonth()-i); d.setDate(1); const mk=d.toISOString().substring(0,7);
    const p=vs.filter(v=>v.fecha?.startsWith(mk)&&esPagada(v)); monthly.push({lbl:d.toLocaleDateString('es-CO',{month:'short'}),total:p.reduce((a,v)=>a+v.total,0)}); }
  const mw=Math.max(...weekly.map(d=>d.total),1), mm=Math.max(...monthly.map(d=>d.total),1);

  // Productos vendidos (últimos 30 días) para más y menos vendidos
  const ini30=new Date(ahoraMs()-30*864e5).toISOString().split('T')[0];
  const ventas30=vs.filter(v=>v.fecha>=ini30&&esPagada(v));
  const items={}; ventas30.forEach(v=>v.items?.forEach(i=>{ if(!items[i.nombre])items[i.nombre]={qty:0,total:0}; items[i.nombre].qty+=i.qty; items[i.nombre].total+=i.precio*i.qty; }));
  const ordenados=Object.entries(items).sort((a,b)=>b[1].qty-a[1].qty);
  const top=ordenados.slice(0,8);
  const menos=ordenados.slice(-8).reverse();

  // Horas pico (últimos 30 días): ventas por hora del día
  const horas=new Array(24).fill(0);
  ventas30.forEach(v=>{ const h=new Date(v.fecha).getHours(); horas[h]+=v.total; });
  const maxHora=Math.max(...horas,1);
  const horasActivas=horas.map((tot,h)=>({h,tot})).filter(x=>x.tot>0);

  // Comparativo: este día de semana vs el mismo día la semana pasada
  const hoyTotal=totalHoy;
  const haceSemana=new Date(ahoraMs()-7*864e5).toISOString().split('T')[0];
  const totalHaceSemana=vs.filter(v=>v.fecha?.startsWith(haceSemana)&&esPagada(v)).reduce((a,v)=>a+v.total,0);
  const difSemana=totalHaceSemana>0?((hoyTotal-totalHaceSemana)/totalHaceSemana*100):0;

  // ----- RESUMEN DEL DÍA: propinas (repartidas entre meseros) y platos del día -----
  const propinasHoy=hoy.reduce((a,v)=>a+(v.propina||0),0);
  const meseros=(DB.get('usuarios')||[]).filter(u=>u.rol==='mesero').map(u=>u.nombre);
  const numMeseros=meseros.length||1;
  const propinaPorMesero=propinasHoy/numMeseros;
  const itemsHoy={}; hoy.forEach(v=>v.items?.forEach(i=>{ if(!itemsHoy[i.nombre])itemsHoy[i.nombre]=0; itemsHoy[i.nombre]+=i.qty; }));
  const topHoy=Object.entries(itemsHoy).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const domiciliosHoy=hoy.filter(v=>v.tipo==='domicilio').length;
  const recargosHoy=hoy.reduce((a,v)=>a+(v.recargo||0),0);

  // ----- ALERTAS -----
  const alertas=[];
  const cierres=DB.get('cierres')||[];
  cierres.slice(0,5).forEach(c=>{ if(c.diferencia<0) alertas.push({tipo:'falta',txt:`Caja de ${c.cajero} cerró con faltante de ${fmtMoney(Math.abs(c.diferencia))} (${fmtDate(c.cierre)})`}); });
  const anulHoy=vs.filter(v=>v.estado==='anulada'&&v.fecha?.startsWith(t)).length;
  if(anulHoy>=3) alertas.push({tipo:'anul',txt:`Hoy se han anulado ${anulHoy} ventas. Revise el detalle en Historial.`});

  return `
  ${alertas.length>0?`<div class="card" style="border-color:rgba(192,57,43,0.4);background:linear-gradient(145deg,rgba(192,57,43,0.1),var(--dark));">
    <div class="card-title text-red">${ic('i-warning')} Alertas</div>
    ${alertas.map(a=>`<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px;">${ic('i-warning')} ${escapeHtml(a.txt)}</div>`).join('')}
  </div>`:''}

  <div class="card" style="background:linear-gradient(145deg,rgba(212,175,55,0.1),var(--dark));">
    <div class="card-title">${ic('i-report')} Resumen del Día (Hoy)</div>
    <div class="stats-grid" style="margin-bottom:12px;">
      <div class="stat-card green"><div class="stat-label">Vendido hoy</div><div class="stat-value">${fmtMoney(totalHoy)}</div><div class="stat-sub">${hoy.length} ventas</div></div>
      <div class="stat-card gold"><div class="stat-label">Propinas del día</div><div class="stat-value">${fmtMoney(propinasHoy)}</div><div class="stat-sub">para los meseros</div></div>
      <div class="stat-card blue"><div class="stat-label">Domicilios</div><div class="stat-value">${domiciliosHoy}</div><div class="stat-sub">recargos: ${fmtMoney(recargosHoy)}</div></div>
    </div>
    <div class="grid-2">
      <div>
        <p class="text-sm font-bold text-gold mb-1">${ic('i-cash')} Propinas a repartir (entre ${numMeseros} mesero${numMeseros!==1?'s':''})</p>
        ${propinasHoy>0?`<div style="padding:10px;background:rgba(46,204,113,0.08);border-radius:8px;">
          <div class="flex-between" style="font-size:15px;font-weight:bold;"><span>A cada mesero le toca:</span><span class="text-gold">${fmtMoney(propinaPorMesero)}</span></div>
          ${meseros.length>0?`<div class="text-xs text-gray mt-1">${meseros.map(m=>escapeHtml(m)).join(' · ')}</div>`:''}
        </div>`:`<p class="text-sm text-gray">No hay propinas registradas hoy.</p>`}
      </div>
      <div>
        <p class="text-sm font-bold text-gold mb-1">${ic('i-chef')} Platos más pedidos hoy</p>
        ${topHoy.length>0?`<table class="data-table" style="font-size:13px;"><tbody>${topHoy.map(([n,q])=>`<tr><td>${escapeHtml(n)}</td><td class="text-gold font-bold" style="text-align:right;">${q}</td></tr>`).join('')}</tbody></table>`:`<p class="text-sm text-gray">Aún no hay ventas hoy.</p>`}
      </div>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card green"><div class="stat-label">Ventas Hoy</div><div class="stat-value">${fmtMoney(totalHoy)}</div><div class="stat-sub">${hoy.length} transacciones</div></div>
    <div class="stat-card gold"><div class="stat-label">Ticket Promedio</div><div class="stat-value">${fmtMoney(hoy.length?Math.round(totalHoy/hoy.length):0)}</div></div>
    <div class="stat-card ${difSemana>=0?'green':'red'}"><div class="stat-label">vs. mismo día semana pasada</div><div class="stat-value">${difSemana>=0?'+':''}${difSemana.toFixed(0)}%</div><div class="stat-sub">Hace 7 días: ${fmtMoney(totalHaceSemana)}</div></div>
  </div>

  <div class="grid-2">
    <div class="card"><div class="card-title">${ic('i-report')} Ventas por Día (7 días)</div><div class="bar-chart" style="height:140px;">${weekly.map(d=>`<div class="bar-item"><div class="bar-val">${d.total>0?(d.total/1000).toFixed(0)+'k':''}</div><div class="bar-fill" style="height:${Math.max(4,(d.total/mw)*110)}px"></div><div class="bar-label">${d.lbl}</div></div>`).join('')}</div></div>
    <div class="card"><div class="card-title">${ic('i-report')} Ventas Mensuales (12 meses)</div><div class="bar-chart" style="height:140px;">${monthly.map(d=>`<div class="bar-item"><div class="bar-val">${d.total>0?(d.total/1000).toFixed(0)+'k':''}</div><div class="bar-fill" style="height:${Math.max(4,(d.total/mm)*110)}px"></div><div class="bar-label">${d.lbl}</div></div>`).join('')}</div></div>
  </div>

  <div class="card"><div class="card-title">${ic('i-clock')} Horas Pico (últimos 30 días)</div>
    ${horasActivas.length===0?`<p class="text-gray text-sm">Sin datos</p>`:
    `<div class="bar-chart" style="height:120px;">${horasActivas.map(x=>`<div class="bar-item"><div class="bar-val">${(x.tot/1000).toFixed(0)+'k'}</div><div class="bar-fill" style="height:${Math.max(4,(x.tot/maxHora)*90)}px"></div><div class="bar-label">${x.h}h</div></div>`).join('')}</div>
    <p class="text-xs text-gray mt-1">Te ayuda a saber a qué horas necesitas más personal.</p>`}
  </div>

  <div class="grid-2">
    <div class="card"><div class="card-title">${ic('i-menu-food')} Más Vendidos (30 días)</div>
      ${top.length===0?`<p class="text-gray text-sm">Sin datos</p>`:`<div class="table-wrap"><table class="data-table"><thead><tr><th>Producto</th><th>Uds.</th><th>Total</th></tr></thead><tbody>${top.map(([n,d])=>`<tr><td>${escapeHtml(n)}</td><td><strong>${d.qty}</strong></td><td class="text-gold">${fmtMoney(d.total)}</td></tr>`).join('')}</tbody></table></div>`}
    </div>
    <div class="card"><div class="card-title">${ic('i-report')} Menos Vendidos (30 días)</div>
      ${menos.length===0?`<p class="text-gray text-sm">Sin datos</p>`:`<div class="table-wrap"><table class="data-table"><thead><tr><th>Producto</th><th>Uds.</th><th>Total</th></tr></thead><tbody>${menos.map(([n,d])=>`<tr><td>${escapeHtml(n)}</td><td><strong>${d.qty}</strong></td><td class="text-gray">${fmtMoney(d.total)}</td></tr>`).join('')}</tbody></table></div>
      <p class="text-xs text-gray mt-1">Candidatos a quitar o renovar en el menú.</p>`}
    </div>
  </div>`;
}

// ========================= AUDITORÍA =========================
function auditoria(){
  if(STATE.user.rol!=='admin') return `<div class="empty-state">${ic('i-lock')}<p>Acceso restringido. Solo el administrador puede ver la auditoría.</p></div>`;
  const logs=DB.get('auditoria')||[];
  const usuarios=[...new Set(logs.map(l=>l.usuario))].sort();
  const filtro=STATE.auditFiltro||'';
  const filtrados=filtro?logs.filter(l=>l.usuario===filtro):logs;
  return `<div class="card"><div class="flex-between mb-2" style="flex-wrap:wrap;gap:10px;"><div class="card-title" style="margin:0;">${ic('i-audit')} Registro de Auditoría</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <select class="mini-input" style="width:auto;" onchange="STATE.auditFiltro=this.value;showPage('auditoria')">
        <option value="">Todos los usuarios</option>
        ${usuarios.map(u=>`<option value="${escapeHtml(u)}" ${u===filtro?'selected':''}>${escapeHtml(u)}</option>`).join('')}
      </select>
      <span class="badge badge-gold">${filtrados.length} registros</span>
    </div></div>
    ${filtrados.length===0?`<div class="empty-state">${ic('i-empty')}<p>Sin registros${filtro?' para '+escapeHtml(filtro):''}</p></div>`:
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Usuario</th><th>Acción</th><th>Detalle</th><th>Fecha</th></tr></thead><tbody>
    ${filtrados.slice(0,400).map(l=>`<tr><td><strong>${escapeHtml(l.usuario)}</strong></td><td>${escapeHtml(l.accion)}</td><td class="text-sm text-gray">${escapeHtml(l.detalle||'—')}</td><td class="text-xs text-gray">${fmtDate(l.fecha)}</td></tr>`).join('')}
    </tbody></table></div>`}</div>`;
}

// ========================= MENÚ =========================
function menu(){
  const ps=DB.get('productos')||[];
  return `<div class="card"><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-menu-food')} Gestión del Menú</div><button class="btn btn-primary btn-sm" onclick="openModalProducto()">${ic('i-plus')} Nuevo Producto</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Nombre</th><th>Categoría</th><th>Precio</th><th>Estado</th><th>Disponible hoy</th><th>Acciones</th></tr></thead><tbody>
    ${ps.map(p=>`<tr><td class="font-bold">${escapeHtml(p.nombre)}${p.agotado?' <span class="badge badge-red">AGOTADO</span>':''}</td><td><span class="badge badge-blue">${escapeHtml(p.cat)}</span></td><td class="text-gold font-bold">${fmtMoney(p.precio)}</td><td><span class="badge ${p.activo?'badge-green':'badge-gray'}">${p.activo?'Activo':'Inactivo'}</span></td><td><button class="btn btn-${p.agotado?'danger':'ghost'} btn-sm" onclick="toggleAgotado('${p.id}')">${p.agotado?'Marcar disponible':'Marcar agotado'}</button></td><td style="display:flex;gap:6px;"><button class="btn btn-ghost btn-sm" onclick="openModalProducto('${p.id}')" title="Editar">${ic('i-edit')}</button><button class="btn btn-${p.activo?'danger':'success'} btn-sm" onclick="toggleProducto('${p.id}')" title="${p.activo?'Desactivar':'Activar'}">${p.activo?ic('i-ban'):ic('i-check')}</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
}
function openModalProducto(id){
  ['p-nombre','p-precio','p-desc'].forEach(i=>document.getElementById(i).value=''); document.getElementById('edit-prod-id').value=''; document.getElementById('p-cat').value='Entremeses';
  if(id){ const p=(DB.get('productos')||[]).find(x=>x.id===id); if(p){ document.getElementById('edit-prod-id').value=p.id;
    document.getElementById('p-nombre').value=p.nombre; document.getElementById('p-precio').value=p.precio; document.getElementById('p-cat').value=p.cat; }}
  document.getElementById('modal-prod-title').innerHTML=ic('i-menu-food')+(id?' Editar Producto':' Nuevo Producto');
  openModal('modal-producto');
}
function saveProducto(){
  const id=document.getElementById('edit-prod-id').value; const ps=DB.get('productos')||[];
  const data={nombre:document.getElementById('p-nombre').value.trim(),precio:parseFloat(document.getElementById('p-precio').value)||0,cat:document.getElementById('p-cat').value};
  if(!data.nombre||!data.precio){ toast('Complete nombre y precio','error'); return; }
  if(id){ const idx=ps.findIndex(x=>x.id===id); if(idx>=0) ps[idx]={...ps[idx],...data}; }
  else ps.push({id:uid(),...data,activo:true});
  DB.set('productos',ps); logAudit(id?'Editó producto':'Creó producto',data.nombre);
  closeModal('modal-producto'); toast('Producto guardado','success'); showPage('menu');
}
function toggleProducto(id){ const ps=DB.get('productos')||[]; const p=ps.find(x=>x.id===id); if(p){p.activo=!p.activo;DB.set('productos',ps);} showPage('menu'); }
function toggleAgotado(id){
  const ps=DB.get('productos')||[]; const p=ps.find(x=>x.id===id);
  if(p){ p.agotado=!p.agotado; DB.set('productos',ps); logAudit(p.agotado?'Marcó agotado':'Marcó disponible',p.nombre); toast(p.agotado?`${p.nombre} marcado AGOTADO`:`${p.nombre} disponible de nuevo`, p.agotado?'error':'success'); }
  showPage('menu');
}

// ========================= CONFIGURACIÓN =========================
function config(){
  if(STATE.user.rol!=='admin') return `<div class="empty-state">${ic('i-lock')}<p>Acceso restringido. Solo el administrador puede ver la configuración.</p></div>`;
  const c=DB.get('config')||{}; const ds=DB.get('domiciliarios')||[];
  return `<div class="grid-2">
    <div class="card"><div class="card-title">${ic('i-settings')} Datos del Negocio</div>
      <div class="form-group"><label>Nombre</label><input type="text" id="cfg-nombre" value="${escapeHtml(c.nombre||'')}"></div>
      <div class="form-grid-2"><div class="form-group"><label>NIT</label><input type="text" id="cfg-nit" value="${escapeHtml(c.nit||'')}"></div><div class="form-group"><label>Teléfono</label><input type="text" id="cfg-tel" value="${escapeHtml(c.tel||'')}"></div></div>
      <div class="form-group"><label>Dirección</label><input type="text" id="cfg-dir" value="${escapeHtml(c.dir||'')}"></div>
      <div class="form-group"><label>Cantidad de Mesas</label><input type="number" id="cfg-mesas" value="${c.numMesas||25}" min="1" max="200"></div>
      <div class="form-group"><label>Logo del restaurante (para la factura)</label>
        <input type="file" id="cfg-logo-file" accept="image/png,image/jpeg" onchange="cargarLogo(event)">
        <div id="cfg-logo-preview" style="margin-top:8px;">${c.logo?`<img src="${c.logo}" style="max-height:70px;border-radius:6px;background:#fff;padding:4px;"> <button class="btn btn-ghost btn-sm" onclick="quitarLogo()">${ic('i-trash')} Quitar</button>`:'<span class="text-xs text-gray">Sin logo. Suba un PNG o JPG.</span>'}</div>
      </div>
      <button class="btn btn-gold" onclick="saveConfig()">${ic('i-check')} Guardar</button>
    </div>
    <div class="card"><div class="card-title">${ic('i-edit')} Marca de Agua en Facturas</div>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;"><input type="checkbox" id="cfg-marca-activa" ${c.marcaAguaActiva?'checked':''} style="width:auto;"> Mostrar marca de agua en las facturas</label>
      <div class="form-group"><label>Texto de la marca de agua</label><input type="text" id="cfg-marca-texto" value="${escapeHtml(c.marcaAgua||'')}"></div>
      <button class="btn btn-gold" onclick="saveMarcaAgua()">${ic('i-check')} Guardar Marca de Agua</button>
    </div>
    <div class="card" style="grid-column:1/-1"><div class="card-title">${ic('i-cash')} Impresión Térmica (QZ Tray)</div>
      <p class="text-sm text-gray mb-2">Imprime directo a la impresora térmica sin el diálogo de Windows y sin texto raro. Requiere tener <strong>QZ Tray</strong> instalado y abierto en el computador de la caja.</p>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;"><input type="checkbox" id="cfg-qz-activo" ${c.qzActivo?'checked':''} style="width:auto;"> <strong>Activar impresión por QZ Tray</strong></label>
      <div class="form-group"><label>Nombre exacto de la impresora</label><input type="text" id="cfg-qz-impresora" value="${escapeHtml(c.qzImpresora||'')}" placeholder="POS printer 203DPI series"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-gold" onclick="saveQZ()">${ic('i-check')} Guardar</button>
        <button class="btn btn-ghost" onclick="probarConexionQZ()">${ic('i-cash')} Probar conexión</button>
        <button class="btn btn-ghost" onclick="probarImpresionQZ()">${ic('i-orders')} Imprimir prueba</button>
      </div>
      <p class="text-xs text-gray mt-2" id="qz-estado">Estado: sin verificar</p>
      <hr class="divider">
      <div style="padding:10px;border-radius:8px;background:rgba(212,175,55,0.06);">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;"><input type="checkbox" id="cfg-estacion" ${esEstacionImpresion()?'checked':''} onchange="toggleEstacion(this.checked)" style="width:auto;"> <strong>Este es el computador que imprime (estación de caja)</strong></label>
        <p class="text-xs text-gray mt-1">Marca esta casilla SOLO en el computador de la caja conectado a la impresora. Ese equipo imprimirá automáticamente los pedidos que lleguen desde los celulares. Déjala desmarcada en celulares y tablets.</p>
      </div>
    </div>
    <div class="card"><div class="card-title">${ic('i-trash')} Permisos de Eliminación Definitiva</div>
      <p class="text-sm text-gray mb-2">La eliminación definitiva borra el pedido de ventas, caja, reportes y estadísticas sin dejar rastro. Solo el administrador puede ejecutarla.</p>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;"><input type="checkbox" id="cfg-del-dom" ${c.permitirEliminarDomicilio?'checked':''} style="width:auto;"> Permitir eliminar domicilios</label>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;"><input type="checkbox" id="cfg-del-mesa" ${c.permitirEliminarMesa?'checked':''} style="width:auto;"> Permitir eliminar ventas de mesa</label>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;"><input type="checkbox" id="cfg-del-llevar" ${c.permitirEliminarLlevar?'checked':''} style="width:auto;"> Permitir eliminar pedidos para llevar</label>
      <button class="btn btn-gold mt-2" onclick="savePermisos()">${ic('i-check')} Guardar Permisos</button>
      <hr class="divider">
      <div class="card-title">${ic('i-rider')} Domiciliarios</div>
      <div style="display:flex;gap:8px;margin-bottom:10px;"><input type="text" id="new-dom" placeholder="Nombre del domiciliario"><button class="btn btn-primary" onclick="addDomiciliario()">${ic('i-plus')}</button></div>
      ${ds.map(d=>`<div class="flex-between" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>${escapeHtml(d.nombre)}</span><button class="btn btn-danger btn-sm" onclick="delDomiciliario('${d.id}')">${ic('i-trash')}</button></div>`).join('')}
    </div>
    <div class="card" style="grid-column:1/-1"><div class="card-title">${ic('i-history')} Respaldo de Datos</div>
      <p class="text-sm text-gray mb-2">Descarga una copia de seguridad de toda la información (ventas, caja, empleados, asistencias, configuración). Guárdala en un lugar seguro cada cierto tiempo. Si algo se daña, puedes restaurarla.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-gold" onclick="exportarDatos()">${ic('i-history')} Descargar Respaldo</button>
        <label class="btn btn-ghost" style="cursor:pointer;">${ic('i-history')} Restaurar Respaldo<input type="file" accept="application/json" onchange="importarDatos(event)" style="display:none;"></label>
      </div>
      <p class="text-xs text-red mt-2">Restaurar reemplaza TODOS los datos actuales por los del archivo. Úsalo solo si necesitas recuperar información.</p>
    </div></div>`;
}
function usarMiUbicacion(){
  if(!navigator.geolocation){ toast('Este dispositivo no permite ubicación','error'); return; }
  toast('Obteniendo ubicación...','info');
  navigator.geolocation.getCurrentPosition(
    pos=>{ document.getElementById('cfg-gps-lat').value=pos.coords.latitude.toFixed(6);
      document.getElementById('cfg-gps-lng').value=pos.coords.longitude.toFixed(6);
      toast('Ubicación capturada. No olvides Guardar GPS.','success'); },
    err=>{ toast('No se pudo obtener la ubicación. Permita el acceso al GPS.','error'); },
    {enableHighAccuracy:true,timeout:10000,maximumAge:0}
  );
}
function saveGps(){
  const c=DB.get('config')||{};
  c.gpsActivo=document.getElementById('cfg-gps-activo').checked;
  c.gpsLat=parseFloat(document.getElementById('cfg-gps-lat').value)||0;
  c.gpsLng=parseFloat(document.getElementById('cfg-gps-lng').value)||0;
  c.gpsRadio=parseInt(document.getElementById('cfg-gps-radio').value)||100;
  if(c.gpsActivo && (!c.gpsLat||!c.gpsLng)){ toast('Ingrese las coordenadas o use "Usar mi ubicación actual"','error'); return; }
  DB.set('config',c); logAudit('Modificó control GPS',c.gpsActivo?'Activado':'Desactivado'); toast('Configuración GPS guardada','success');
}
function cargarLogo(e){
  const file=e.target.files[0]; if(!file) return;
  if(file.size>500000){ toast('La imagen es muy grande. Use una de menos de 500 KB.','error'); return; }
  const reader=new FileReader();
  reader.onload=ev=>{
    const c=DB.get('config')||{}; c.logo=ev.target.result; DB.set('config',c);
    toast('Logo cargado','success'); showPage('config');
  };
  reader.readAsDataURL(file);
}
function quitarLogo(){ const c=DB.get('config')||{}; c.logo=''; DB.set('config',c); toast('Logo quitado','info'); showPage('config'); }
function saveMarcaAgua(){
  const c=DB.get('config')||{};
  c.marcaAgua=document.getElementById('cfg-marca-texto').value;
  c.marcaAguaActiva=document.getElementById('cfg-marca-activa').checked;
  DB.set('config',c); logAudit('Modificó marca de agua'); toast('Marca de agua guardada','success');
}
function toggleEstacion(on){
  setEstacionImpresion(on);
  if(on){
    // Marcar TODOS los pedidos actuales como ya impresos, para que solo imprima los NUEVOS de aquí en adelante
    const vs=DB.get('ventas')||[]; let cambio=false;
    vs.forEach(v=>{ if(!v.ticketImpreso){ v.ticketImpreso=true; cambio=true; } if(v.estado==='pagada' && !v.facturaImpresa){ v.facturaImpresa=true; cambio=true; } });
    if(cambio) fusionarYGuardarVentas(vs);
    toast('Estación activada. Imprimirá solo los pedidos NUEVOS de aquí en adelante.','success');
    arrancarAutoImpresion();
  } else {
    toast('Este dispositivo ya no imprime automáticamente','info');
  }
}
function saveQZ(){
  const c=DB.get('config')||{};
  c.qzActivo=document.getElementById('cfg-qz-activo').checked;
  c.qzImpresora=document.getElementById('cfg-qz-impresora').value.trim();
  DB.set('config',c); logAudit('Modificó impresión QZ Tray',c.qzActivo?'Activado':'Desactivado'); toast('Configuración de impresión guardada','success');
}
// ----- Estación de impresión -----
let autoImpresionTimer=null;
function arrancarAutoImpresion(){
  if(autoImpresionTimer) return;
  autoImpresionTimer=setInterval(()=>{ try{ revisarColaImpresion(); }catch(e){} }, 5000);
}
function probarConexionQZ(){
  const est=document.getElementById('qz-estado');
  if(est) est.textContent='Estado: conectando...';
  conectarQZ().then(()=>{
    return qz.printers.find();
  }).then(printers=>{
    const lista=Array.isArray(printers)?printers:[printers];
    if(est) est.innerHTML=`<span class="text-green">✓ QZ Tray conectado.</span> Impresoras detectadas: ${lista.map(p=>escapeHtml(p)).join(', ')}`;
    toast('QZ Tray conectado correctamente','success');
  }).catch(err=>{
    if(est) est.innerHTML=`<span class="text-red">✗ No se pudo conectar.</span> Verifique que QZ Tray esté abierto en este computador.`;
    toast('No se pudo conectar a QZ Tray','error');
  });
}

// ----- Respaldo de datos (exportar / importar) -----
function exportarDatos(){
  const data={}; FIREBASE_KEYS.forEach(k=>{ data[k]=DB.get(k); });
  data._exportado=now(); data._version='PortalImperial1';
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  const fecha=new Date(ahoraMs()).toISOString().split('T')[0];
  a.href=url; a.download=`respaldo-portal-imperial-${fecha}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  logAudit('Exportó respaldo de datos');
  toast('Respaldo descargado','success');
}
function importarDatos(e){
  const file=e.target.files[0]; if(!file) return;
  if(!confirm('⚠ ATENCIÓN: Importar un respaldo REEMPLAZARÁ todos los datos actuales (ventas, caja, empleados, etc.) por los del archivo. Esto afecta a todos los dispositivos. ¿Está seguro?')){ e.target.value=''; return; }
  const reader=new FileReader();
  reader.onload=ev=>{
    try{
      const data=JSON.parse(ev.target.result);
      if(data._version!=='PortalImperial1'){ toast('El archivo no es un respaldo válido','error'); return; }
      FIREBASE_KEYS.forEach(k=>{ if(data[k]!==undefined && data[k]!==null) DB.set(k,data[k]); });
      logAudit('Importó respaldo de datos',data._exportado||'');
      toast('Respaldo importado correctamente','success');
      setTimeout(()=>{ showPage('dashboard'); },800);
    }catch(err){ toast('Error al leer el archivo','error'); }
  };
  reader.readAsText(file);
  e.target.value='';
}
function saveConfig(){
  const c=DB.get('config')||{};
  c.nombre=document.getElementById('cfg-nombre').value; c.nit=document.getElementById('cfg-nit').value;
  c.tel=document.getElementById('cfg-tel').value; c.dir=document.getElementById('cfg-dir').value;
  c.numMesas=parseInt(document.getElementById('cfg-mesas').value)||25;
  DB.set('config',c); logAudit('Modificó configuración'); toast('Configuración guardada','success');
}
function savePermisos(){
  const c=DB.get('config')||{};
  c.permitirEliminarDomicilio=document.getElementById('cfg-del-dom').checked;
  c.permitirEliminarMesa=document.getElementById('cfg-del-mesa').checked;
  c.permitirEliminarLlevar=document.getElementById('cfg-del-llevar').checked;
  DB.set('config',c); logAudit('Modificó permisos de eliminación'); toast('Permisos guardados','success');
}
function addDomiciliario(){ const n=document.getElementById('new-dom').value.trim(); if(!n)return; const ds=DB.get('domiciliarios')||[]; ds.push({id:uid(),nombre:n,activo:true}); DB.set('domiciliarios',ds); showPage('config'); }
function delDomiciliario(id){ DB.set('domiciliarios',(DB.get('domiciliarios')||[]).filter(d=>d.id!==id)); showPage('config'); }

// ========================= CONTROL DE ASISTENCIA (gestión + reportes) =========================
let asisPeriodo='dia';
function setAsisPeriodo(p){ asisPeriodo=p; showPage('asistencia'); }
// ========================= IMPRESIONES (cola para el cajero) =========================
// Esta pantalla vive en el computador de la caja. Cuando un mesero crea un pedido,
// aquí aparece la comanda de cocina y la factura, y se imprimen solas por USB (método normal Windows).
let autoImpresionCajaTimer=null;
function impresiones(){
  // Marcar este equipo como el que imprime (para que la auto-impresión funcione aquí)
  if(!autoImpresionCajaTimer){
    autoImpresionCajaTimer=setInterval(procesarImpresionesPendientes, 4000);
  }
  const vs=DB.get('ventas')||[];
  // Pedidos recientes (últimas 3 horas), no anulados
  const reciente = v => (ahoraMs()-new Date(v.fecha))/3600000 < 3;
  const lista=vs.filter(v=>v.estado!=='anulada' && reciente(v))
    .sort((a,b)=>new Date(b.fecha)-new Date(a.fecha));
  const autoOn = imprAutoActiva();
  return `
  <div class="card" style="background:linear-gradient(145deg,rgba(212,175,55,0.1),var(--dark));">
    <div class="flex-between" style="flex-wrap:wrap;gap:10px;">
      <div>
        <div class="card-title" style="margin:0;">${ic('i-orders')} Centro de Impresión</div>
        <p class="text-sm text-gray" style="margin:4px 0 0;">Deja esta pantalla abierta en el computador de la caja. Los pedidos de los meseros se imprimen aquí por USB.</p>
      </div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 14px;border-radius:8px;background:${autoOn?'rgba(46,204,113,0.15)':'rgba(231,76,60,0.12)'};">
        <input type="checkbox" ${autoOn?'checked':''} onchange="toggleImprAuto(this.checked)" style="width:auto;">
        <strong>${autoOn?'✓ Impresión automática ACTIVA':'Impresión automática apagada'}</strong>
      </label>
    </div>
  </div>
  ${!autoOn?`<div class="card" style="border:1px solid var(--orange);"><p class="text-sm" style="color:var(--orange);margin:0;">${ic('i-warning')} La impresión automática está apagada. Actívala arriba para que los pedidos se impriman solos en este computador.</p></div>`:''}
  ${colaImpr.length>0?`<div class="card" style="border:1px solid var(--gold);"><p class="text-sm" style="margin:0;">${ic('i-clock')} <strong>${colaImpr.length}</strong> impresión(es) en cola, esperando turno...</p></div>`:''}
  <div class="card">
    <div class="card-title">${ic('i-clock')} Pedidos recientes</div>
    ${lista.length===0?`<p class="text-gray" style="text-align:center;padding:20px;">No hay pedidos recientes. Cuando un mesero tome un pedido, aparecerá aquí y se imprimirá solo.</p>`:`
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Pedido</th><th>Tipo</th><th>Cliente/Mesa</th><th>Hora</th><th>Cocina</th><th>Factura</th><th>Reimprimir</th></tr></thead><tbody>
    ${lista.map(v=>`<tr>
      <td><span class="text-gold font-bold">${refPedido(v)}</span></td>
      <td>${tipoLabel(v.tipo)}</td>
      <td>${escapeHtml(v.cliNombre||v.mesa||'—')}</td>
      <td class="text-xs text-gray">${fmtDate(v.fecha)}</td>
      <td>${v.ticketImpreso?'<span class="badge badge-green">✓ Impresa</span>':'<span class="badge badge-orange">Pendiente</span>'}</td>
      <td>${v.estado==='pagada'?(v.facturaImpresa?'<span class="badge badge-green">✓ Impresa</span>':'<span class="badge badge-orange">Pendiente</span>'):'<span class="text-xs text-gray">sin cobrar</span>'}</td>
      <td style="display:flex;gap:5px;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" onclick="reimprimirComanda('${v.id}')" title="Reimprimir comanda">${ic('i-chef')}</button>
        ${v.estado==='pagada'?`<button class="btn btn-ghost btn-sm" onclick="reimprimirFactura('${v.id}')" title="Reimprimir factura">${ic('i-cash')}</button>`:''}
      </td>
    </tr>`).join('')}
    </tbody></table></div>`}
  </div>`;
}
function imprAutoActiva(){ try{ return localStorage.getItem('pi_impr_auto')==='1'; }catch(e){ return false; } }
function toggleImprAuto(on){
  try{ localStorage.setItem('pi_impr_auto', on?'1':'0'); }catch(e){}
  const cfg=DB.get('config')||{};
  cfg.centroImpresionActivo = on; // bandera GLOBAL: los demás dispositivos no imprimen al crear
  DB.set('config',cfg);
  if(on){
    // Marcar lo existente como ya impreso para no imprimir el histórico de golpe
    const vs=DB.get('ventas')||[]; let ch=false;
    vs.forEach(v=>{ if(!v.ticketImpreso){v.ticketImpreso=true;ch=true;} if(v.estado==='pagada'&&!v.facturaImpresa){v.facturaImpresa=true;ch=true;} });
    if(ch) fusionarYGuardarVentas(vs);
    toast('Impresión automática activada en este computador. Solo imprimirá pedidos NUEVOS.','success');
    if(!autoImpresionCajaTimer) autoImpresionCajaTimer=setInterval(procesarImpresionesPendientes, 4000);
  } else {
    toast('Impresión automática apagada','info');
  }
  showPage('impresiones');
}
// ====== COLA DE IMPRESIÓN REAL (no pierde trabajos) ======
let colaImpr=[];           // fila de trabajos por imprimir, en orden
let colaImprActiva=false;  // si hay una impresión en curso
const colaImprIds=new Set(); // para no encolar dos veces lo mismo

function procesarImpresionesPendientes(){
  if(!imprAutoActiva()) return;
  const vs=DB.get('ventas')||[];
  const reciente = v => (ahoraMs()-new Date(v.fecha))/60000 < 30; // últimos 30 min
  // Recorrer del más viejo al más nuevo para mantener el ORDEN de llegada
  const ordenados=[...vs].sort((a,b)=>new Date(a.fecha)-new Date(b.fecha));
  ordenados.forEach(v=>{
    if(v.estado==='anulada' || !reciente(v)) return;
    // Comanda de cocina pendiente
    if(!v.ticketImpreso){
      const key='ticket-'+v.id;
      if(!colaImprIds.has(key)){ colaImprIds.add(key); colaImpr.push({id:v.id,tipo:'ticket',key}); }
    }
    // Factura pendiente (solo si está pagada)
    if(v.estado==='pagada' && !v.facturaImpresa){
      const key='factura-'+v.id;
      if(!colaImprIds.has(key)){ colaImprIds.add(key); colaImpr.push({id:v.id,tipo:'factura',key}); }
    }
  });
  arrancarColaImpr();
}
function arrancarColaImpr(){
  if(colaImprActiva) return;          // ya hay una imprimiendo
  if(colaImpr.length===0) return;     // nada que imprimir
  colaImprActiva=true;
  const job=colaImpr.shift();
  const v=(DB.get('ventas')||[]).find(x=>x.id===job.id);
  if(!v){ colaImprActiva=false; colaImprIds.delete(job.key); arrancarColaImpr(); return; }
  const html = job.tipo==='ticket'? ticketCocinaHTML(v) : facturaHTML(v);
  // Marcar como impreso ANTES de imprimir (para no perder el rastro aunque falle el navegador)
  const all=DB.get('ventas')||[]; const t=all.find(x=>x.id===job.id);
  if(t){ if(job.tipo==='ticket') t.ticketImpreso=true; else t.facturaImpresa=true; fusionarYGuardarVentas(all); }
  try{ imprimirNavegador(html); }catch(e){ console.warn('Impr error',e); }
  // Esperar a que termine antes de la siguiente (evita que se solapen y se pierdan)
  setTimeout(()=>{
    colaImprIds.delete(job.key);
    colaImprActiva=false;
    arrancarColaImpr(); // siguiente de la cola
  }, 3000);
}
function reimprimirComanda(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  imprimirNavegador(ticketCocinaHTML(v)); toast('Reimprimiendo comanda...','info');
}
function reimprimirFactura(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  imprimirNavegador(facturaHTML(v)); toast('Reimprimiendo factura...','info');
}
function tiempos(){
  const vs=DB.get('ventas')||[];
  // Pedidos con tiempo medido (entrada a cocina -> listo), ordenados del más reciente al más viejo
  const conTiempo=vs.filter(v=>v.fecha && v.horaListo)
    .map(v=>({ tipo:v.tipo, min:(new Date(v.horaListo)-new Date(v.fecha))/60000, fecha:v.horaListo, ref:refCocina(v) }))
    .filter(x=>x.min>0 && x.min<240)
    .sort((a,b)=>new Date(b.fecha)-new Date(a.fecha));

  const prom = arr => arr.length? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
  // ESTIMADO EN VIVO: promedio de los últimos 5 pedidos listos (refleja el ritmo actual)
  const ultimos5=conTiempo.slice(0,5).map(x=>x.min);
  const ultimos3=conTiempo.slice(0,3).map(x=>x.min);
  const promVivo = ultimos5.length>=3 ? prom(ultimos5) : (ultimos3.length>0? prom(ultimos3) : 0);
  const promGeneral=prom(conTiempo.map(x=>x.min));

  // Por tipo (últimos 5 de cada tipo)
  const porTipo={};
  ['mesa','llevar','domicilio'].forEach(t=>{ const a=conTiempo.filter(x=>x.tipo===t).slice(0,5).map(x=>x.min); porTipo[t]={prom:prom(a),n:a.length}; });

  // Estimado redondeado a 5 min hacia arriba, con margen
  const base=promVivo||promGeneral;
  const estimado = base? Math.ceil(base/5)*5 : 0;
  const estimadoMax = estimado? estimado+10 : 0;
  const enCocinaAhora=vs.filter(v=>v.estado!=='anulada'&&v.estadoPedido!=='entregado'&&v.estadoCocina!=='listo'&&v.estadoCocina!=='entregado').length;
  const fmtMin = m => m>0? (m>=60? Math.floor(m/60)+'h '+Math.round(m%60)+'min' : Math.round(m)+' min') : '—';

  return `
  <div class="card" style="text-align:center;background:linear-gradient(145deg,rgba(212,175,55,0.12),var(--dark));">
    <div class="card-title" style="justify-content:center;">${ic('i-clock')} Tiempo estimado para el cliente</div>
    ${estimado? `<div style="font-size:42px;font-weight:800;color:var(--gold);line-height:1.1;margin:8px 0;">${estimado} – ${estimadoMax} min</div>
      <p class="text-sm text-gray">Basado en los últimos ${Math.min(5,conTiempo.length)} pedidos preparados. Dile al cliente este tiempo aproximado.</p>
      ${enCocinaAhora>=4?`<p class="text-xs" style="color:var(--orange);margin-top:6px;">${ic('i-warning')} Hay ${enCocinaAhora} pedidos en cocina ahora. El tiempo puede ser un poco mayor.</p>`:''}`
      : `<p class="text-gray mt-2">Aún no hay suficientes datos. Necesita al menos 3 pedidos marcados como "listo" en cocina para calcular el promedio. Llevan ${conTiempo.length}.</p>`}
  </div>

  <div class="stats-grid">
    <div class="stat-card gold"><div class="stat-label">Promedio en vivo</div><div class="stat-value">${fmtMin(promVivo)}</div><div class="stat-sub">últimos ${Math.min(5,conTiempo.length)} pedidos</div></div>
    <div class="stat-card green"><div class="stat-label">Promedio histórico</div><div class="stat-value">${fmtMin(promGeneral)}</div><div class="stat-sub">${conTiempo.length} pedidos medidos</div></div>
    <div class="stat-card blue"><div class="stat-label">En cocina ahora</div><div class="stat-value">${enCocinaAhora}</div><div class="stat-sub">preparándose</div></div>
  </div>

  <div class="card"><div class="card-title">${ic('i-report')} Tiempo promedio por tipo (últimos pedidos)</div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Tipo</th><th>Tiempo promedio</th><th>Medidos</th></tr></thead><tbody>
      <tr><td>${ic('i-table')} Mesa</td><td class="text-gold font-bold">${fmtMin(porTipo.mesa.prom)}</td><td>${porTipo.mesa.n}</td></tr>
      <tr><td>${ic('i-bag')} Para llevar</td><td class="text-gold font-bold">${fmtMin(porTipo.llevar.prom)}</td><td>${porTipo.llevar.n}</td></tr>
      <tr><td>${ic('i-delivery')} Domicilio</td><td class="text-gold font-bold">${fmtMin(porTipo.domicilio.prom)}</td><td>${porTipo.domicilio.n}</td></tr>
    </tbody></table></div>
  </div>
  ${conTiempo.length>0?`<div class="card"><div class="card-title">${ic('i-clock')} Últimos pedidos preparados</div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Pedido</th><th>Tipo</th><th>Tiempo</th></tr></thead><tbody>
    ${conTiempo.slice(0,8).map(x=>`<tr><td>${x.ref}</td><td>${tipoLabel(x.tipo)}</td><td class="font-bold ${x.min>25?'text-red':x.min>15?'text-gold':'text-green'}">${fmtMin(x.min)}</td></tr>`).join('')}
    </tbody></table></div></div>`:''}`;
}
function asistencia(){
  const emps=DB.get('empleados')||[];
  const marcs=DB.get('marcaciones')||[];
  // Calcular rango según periodo
  const ahora=new Date(); let desde;
  if(asisPeriodo==='dia'){ desde=new Date(ahora); desde.setHours(0,0,0,0); }
  else if(asisPeriodo==='semana'){ desde=new Date(ahora.getTime()-7*864e5); }
  else { desde=new Date(ahora); desde.setDate(1); desde.setHours(0,0,0,0); }
  const enRango=marcs.filter(m=>new Date(m.fecha)>=desde).sort((a,b)=>new Date(a.fecha)-new Date(b.fecha));

  // Agrupar por empleado y por día para emparejar entrada/salida
  const jornadas=calcularJornadas(enRango);
  const totalHorasEmp={};
  jornadas.forEach(j=>{ if(j.horas) totalHorasEmp[j.empId]=(totalHorasEmp[j.empId]||0)+j.horas; });

  return `
  <div class="card" style="text-align:center;background:linear-gradient(145deg,rgba(212,175,55,0.1),var(--dark));">
    <div class="card-title" style="justify-content:center;">${ic('i-clock')} Pantalla de Marcación</div>
    <p class="text-sm text-gray mb-2">Abre la pantalla donde los empleados marcan entrada y salida con su cédula y código.</p>
    <button class="btn btn-gold" onclick="mostrarAsistencia()" style="padding:12px 28px;">${ic('i-clock')} Abrir Pantalla de Marcación</button>
  </div>
  <div class="card">
    <div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-users')} Empleados (Asistencia)</div>
      <button class="btn btn-primary btn-sm" onclick="openModalEmpleado()">${ic('i-plus')} Nuevo Empleado</button></div>
    ${emps.length===0?`<div class="empty-state">${ic('i-empty')}<p>Sin empleados registrados</p></div>`:
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Nombre</th><th>Cédula</th><th>Código</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>
    ${emps.map(e=>`<tr><td class="font-bold">${escapeHtml(e.nombre)}</td><td>${escapeHtml(e.cedula)}</td><td><span class="text-gold">${escapeHtml(e.codigo)}</span></td><td><span class="badge ${e.activo?'badge-green':'badge-gray'}">${e.activo?'Activo':'Inactivo'}</span></td><td style="display:flex;gap:6px;"><button class="btn btn-ghost btn-sm" onclick="openModalEmpleado('${e.id}')">${ic('i-edit')}</button><button class="btn btn-${e.activo?'danger':'success'} btn-sm" onclick="toggleEmpleado('${e.id}')">${e.activo?ic('i-ban'):ic('i-check')}</button></td></tr>`).join('')}
    </tbody></table></div>`}
  </div>
  <div class="card">
    <div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-clock')} Reporte de Asistencia</div>
      <div class="category-tabs" style="margin:0;">
        <button class="cat-tab ${asisPeriodo==='dia'?'active':''}" onclick="setAsisPeriodo('dia')">Hoy</button>
        <button class="cat-tab ${asisPeriodo==='semana'?'active':''}" onclick="setAsisPeriodo('semana')">Semana</button>
        <button class="cat-tab ${asisPeriodo==='mes'?'active':''}" onclick="setAsisPeriodo('mes')">Mes</button>
      </div></div>
    ${jornadas.length===0?`<div class="empty-state">${ic('i-empty')}<p>Sin marcaciones en este periodo</p></div>`:
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Empleado</th><th>Día</th><th>Entrada</th><th>Salida</th><th>Horas</th></tr></thead><tbody>
    ${jornadas.map(j=>`<tr><td class="font-bold">${escapeHtml(j.nombre)}</td><td>${j.dia}</td><td class="text-green">${j.entrada||'—'}</td><td class="text-red">${j.salida||'—'}</td><td class="font-bold text-gold">${j.horas?j.horas.toFixed(2)+' h':'—'}</td></tr>`).join('')}
    </tbody></table></div>
    <hr class="divider">
    <div class="card-title">${ic('i-report')} Total de Horas por Empleado (${asisPeriodo==='dia'?'hoy':asisPeriodo==='semana'?'esta semana':'este mes'})</div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Empleado</th><th>Total Horas</th></tr></thead><tbody>
    ${Object.entries(totalHorasEmp).map(([id,h])=>{ const e=emps.find(x=>x.id===id); return `<tr><td class="font-bold">${escapeHtml(e?e.nombre:'?')}</td><td class="text-gold font-bold">${h.toFixed(2)} h</td></tr>`; }).join('')||'<tr><td colspan="2" class="text-gray">Sin horas completas aún</td></tr>'}
    </tbody></table></div>`}
  </div>
  ${STATE.user.rol==='admin'?`
  <div class="card">
    <div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-edit')} Editar Marcaciones (solo admin)</div>
      <button class="btn btn-primary btn-sm" onclick="openModalMarcacion()">${ic('i-plus')} Agregar Marcación Manual</button></div>
    <p class="text-sm text-gray mb-2">Aquí puedes corregir, agregar o eliminar marcaciones cuando un empleado olvidó marcar o se equivocó.</p>
    ${enRango.length===0?`<div class="empty-state">${ic('i-empty')}<p>Sin marcaciones en este periodo</p></div>`:
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Empleado</th><th>Tipo</th><th>Fecha y Hora</th><th>Acciones</th></tr></thead><tbody>
    ${enRango.slice().reverse().map(m=>`<tr><td class="font-bold">${escapeHtml(m.nombre)}</td><td><span class="badge ${m.tipo==='entrada'?'badge-green':'badge-red'}">${m.tipo==='entrada'?'Entrada':'Salida'}</span></td><td>${fmtDate(m.fecha)}</td><td style="display:flex;gap:6px;"><button class="btn btn-ghost btn-sm" onclick="openModalMarcacion('${m.id}')">${ic('i-edit')}</button><button class="btn btn-danger btn-sm" onclick="eliminarMarcacion('${m.id}')">${ic('i-trash')}</button></td></tr>`).join('')}
    </tbody></table></div>`}
  </div>`:''}`;
}
function calcularJornadas(marcs){
  // Empareja entrada→salida por empleado y por día
  const porEmpDia={};
  marcs.forEach(m=>{
    const dia=m.fecha.split('T')[0];
    const key=m.empId+'|'+dia;
    if(!porEmpDia[key]) porEmpDia[key]={empId:m.empId,nombre:m.nombre,dia:fmtDiaCorto(dia),diaRaw:dia,marcas:[]};
    porEmpDia[key].marcas.push(m);
  });
  const jornadas=[];
  Object.values(porEmpDia).forEach(g=>{
    let entrada=null;
    g.marcas.forEach(m=>{
      if(m.tipo==='entrada'){ entrada=m; }
      else if(m.tipo==='salida' && entrada){
        const h=(new Date(m.fecha)-new Date(entrada.fecha))/3600000;
        jornadas.push({empId:g.empId,nombre:g.nombre,dia:g.dia,
          entrada:fmtHora(entrada.fecha),salida:fmtHora(m.fecha),horas:h>0?h:0});
        entrada=null;
      }
    });
    if(entrada){ jornadas.push({empId:g.empId,nombre:g.nombre,dia:g.dia,entrada:fmtHora(entrada.fecha),salida:null,horas:0}); }
  });
  return jornadas.sort((a,b)=>a.nombre.localeCompare(b.nombre));
}
function fmtHora(iso){ return new Date(iso).toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'}); }
function fmtDiaCorto(d){ const x=new Date(d+'T12:00:00'); return x.toLocaleDateString('es-CO',{weekday:'short',day:'2-digit',month:'2-digit'}); }

function openModalEmpleado(id){
  ['e-nombre','e-cedula','e-codigo'].forEach(i=>document.getElementById(i).value='');
  document.getElementById('edit-emp-id').value='';
  if(id){ const e=(DB.get('empleados')||[]).find(x=>x.id===id); if(e){ document.getElementById('edit-emp-id').value=e.id;
    document.getElementById('e-nombre').value=e.nombre; document.getElementById('e-cedula').value=e.cedula; document.getElementById('e-codigo').value=e.codigo; }}
  document.getElementById('modal-emp-title').innerHTML=ic('i-users')+(id?' Editar Empleado':' Nuevo Empleado');
  openModal('modal-empleado');
}
function saveEmpleado(){
  const id=document.getElementById('edit-emp-id').value; const emps=DB.get('empleados')||[];
  const data={nombre:document.getElementById('e-nombre').value.trim(),cedula:document.getElementById('e-cedula').value.trim(),codigo:document.getElementById('e-codigo').value.trim()};
  if(!data.nombre||!data.cedula||!data.codigo){ toast('Complete nombre, cédula y código','error'); return; }
  if(id){ const idx=emps.findIndex(x=>x.id===id); if(idx>=0) emps[idx]={...emps[idx],...data}; }
  else emps.push({id:uid(),...data,activo:true});
  DB.set('empleados',emps); logAudit(id?'Editó empleado':'Creó empleado',data.nombre);
  closeModal('modal-empleado'); toast('Empleado guardado','success'); showPage('asistencia');
}
function toggleEmpleado(id){ const emps=DB.get('empleados')||[]; const e=emps.find(x=>x.id===id); if(e){e.activo=!e.activo;DB.set('empleados',emps);} showPage('asistencia'); }

// ----- Editar/agregar/eliminar marcaciones (solo admin) -----
function openModalMarcacion(id){
  const emps=(DB.get('empleados')||[]);
  const sel=document.getElementById('mc-emp');
  sel.innerHTML=emps.map(e=>`<option value="${e.id}">${escapeHtml(e.nombre)} — ${escapeHtml(e.cedula)}</option>`).join('');
  document.getElementById('edit-mc-id').value='';
  document.getElementById('mc-tipo').value='entrada';
  // fecha/hora por defecto: ahora
  const ahora=new Date(); const local=new Date(ahora.getTime()-ahora.getTimezoneOffset()*60000).toISOString().slice(0,16);
  document.getElementById('mc-fecha').value=local;
  if(id){
    const m=(DB.get('marcaciones')||[]).find(x=>x.id===id);
    if(m){ document.getElementById('edit-mc-id').value=m.id; sel.value=m.empId; document.getElementById('mc-tipo').value=m.tipo;
      const d=new Date(m.fecha); document.getElementById('mc-fecha').value=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
  }
  document.getElementById('modal-mc-title').innerHTML=ic('i-clock')+(id?' Editar Marcación':' Agregar Marcación');
  openModal('modal-marcacion');
}
function saveMarcacion(){
  const id=document.getElementById('edit-mc-id').value;
  const empId=document.getElementById('mc-emp').value;
  const tipo=document.getElementById('mc-tipo').value;
  const fechaStr=document.getElementById('mc-fecha').value;
  if(!empId||!fechaStr){ toast('Complete empleado y fecha/hora','error'); return; }
  const emp=(DB.get('empleados')||[]).find(e=>e.id===empId);
  const fechaISO=new Date(fechaStr).toISOString();
  const marcs=DB.get('marcaciones')||[];
  if(id){
    const m=marcs.find(x=>x.id===id);
    if(m){ m.empId=empId; m.nombre=emp?.nombre||m.nombre; m.cedula=emp?.cedula||m.cedula; m.tipo=tipo; m.fecha=fechaISO; m.editadoPor=STATE.user.nombre; }
    logAudit('Editó marcación',`${emp?.nombre} ${tipo} ${fmtDate(fechaISO)}`);
  } else {
    marcs.unshift({id:uid(),empId,nombre:emp?.nombre||'?',cedula:emp?.cedula||'',tipo,fecha:fechaISO,manual:true,creadoPor:STATE.user.nombre});
    logAudit('Agregó marcación manual',`${emp?.nombre} ${tipo} ${fmtDate(fechaISO)}`);
  }
  DB.set('marcaciones',marcs);
  closeModal('modal-marcacion'); toast('Marcación guardada','success'); showPage('asistencia');
}
function eliminarMarcacion(id){
  if(!confirm('¿Eliminar esta marcación?')) return;
  const m=(DB.get('marcaciones')||[]).find(x=>x.id===id);
  DB.set('marcaciones',(DB.get('marcaciones')||[]).filter(x=>x.id!==id));
  logAudit('Eliminó marcación',m?`${m.nombre} ${m.tipo} ${fmtDate(m.fecha)}`:id);
  toast('Marcación eliminada','error'); showPage('asistencia');
}

// ========================= MODALS HTML =========================
function buildModals(){
  document.getElementById('modals').innerHTML=`
  <div id="modal-recovery" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-lock')} Recuperar Contraseña</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-recovery')">${ic('i-close')}</button></div><div class="modal-body"><p class="text-sm text-gray mb-2">Solicite al administrador el código de recuperación.</p><div class="form-group"><label>Código de recuperación</label><input type="text" id="rec-code" placeholder="4 dígitos" maxlength="4"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-recovery')">Cancelar</button><button class="btn btn-gold" onclick="doRecovery()">Continuar</button></div></div></div>

  <div id="modal-descuento" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:350px;"><div class="modal-header"><h3>${ic('i-tag')} Aplicar Descuento</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-descuento')">${ic('i-close')}</button></div><div class="modal-body"><div class="form-group"><label>Tipo</label><select id="desc-tipo"><option value="pct">Porcentaje (%)</option><option value="fijo">Valor fijo (COP)</option></select></div><div class="form-group"><label>Valor</label><input type="number" id="desc-valor" placeholder="0" min="0"></div><div class="form-group"><label>Motivo</label><input type="text" id="desc-motivo" placeholder="Razón"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-descuento')">Cancelar</button><button class="btn btn-gold" onclick="applyDescuento()">Aplicar</button></div></div></div>

  <div id="modal-caja" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-cash')} Apertura de Caja</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-caja')">${ic('i-close')}</button></div><div class="modal-body"><div class="form-group"><label>Fondo Inicial (COP)</label><input type="number" id="caja-fondo" value="100000"><p class="text-xs text-gray mt-1" id="caja-base-aviso"></p></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-caja')">Cancelar</button><button class="btn btn-gold" onclick="abrirCaja()">Abrir Caja</button></div></div></div>

  <div id="modal-cierre" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:420px;"><div class="modal-header"><h3>${ic('i-lock')} Cierre y Cuadre de Caja</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-cierre')">${ic('i-close')}</button></div><div class="modal-body"><div class="flex-between mb-2" style="padding:8px 12px;background:rgba(212,175,55,0.08);border-radius:8px;"><span class="text-sm">Efectivo que debería haber</span><span class="text-gold font-bold" id="cierre-esperado">—</span></div><div class="form-group"><label>Efectivo contado en el cajón (COP)</label><input type="number" id="cierre-contado" placeholder="Cuente la plata y escriba el total" oninput="calcularDiferencia()"></div><div style="text-align:center;font-size:16px;padding:10px;border-radius:8px;background:rgba(0,0,0,0.2);margin-bottom:12px;" id="cierre-dif"><span class="text-gray">Cuente el efectivo del cajón</span></div><div class="form-group"><label>Observaciones (opcional)</label><input type="text" id="cierre-obs" placeholder="Ej: motivo del faltante"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-cierre')">Cancelar</button><button class="btn btn-danger" onclick="confirmarCierre()">${ic('i-lock')} Cerrar Caja</button></div></div></div>

  <div id="modal-quitarprod" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:440px;"><div class="modal-header"><h3>${ic('i-menu-food')} Quitar Producto</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-quitarprod')">${ic('i-close')}</button></div><div class="modal-body"><p class="text-sm text-gray mb-2" id="quitarprod-info"></p><p class="text-xs text-gray mb-2">Al quitar un producto, el total se recalcula y los pagos se ajustan automáticamente. Queda en auditoría.</p><div id="quitarprod-lista"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-quitarprod')">Cerrar</button></div></div></div>
  <div id="modal-cobro" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:440px;"><div class="modal-header"><h3>${ic('i-cash')} Cobrar</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-cobro')">${ic('i-close')}</button></div><div class="modal-body"><p class="text-sm mb-2" id="cobro-mesa-info"></p>
    <div class="form-grid-2">
      <div class="form-group"><label>Propina (del mesero)</label><input type="number" inputmode="numeric" id="cobro-propina" placeholder="0" value="0" min="0" oninput="actualizarTotalCobro()"></div>
      <div class="form-group"><label>Recargo datáfono</label><input type="number" inputmode="numeric" id="cobro-recargo" placeholder="0" value="0" min="0" oninput="actualizarTotalCobro()"></div>
    </div>
    <p class="text-xs text-gray mb-2" style="margin-top:-4px;">La propina y el recargo NO son del negocio: no entran a caja ni a ventas.</p>
    <div id="cobro-domicilio-box" style="display:none;background:rgba(52,152,219,0.08);border-radius:8px;padding:10px;margin-bottom:10px;">
      <label class="text-sm" style="display:block;margin-bottom:6px;">🛵 Domicilio: <span id="cobro-dom-valor" class="text-gold">0</span> — ¿cómo lo paga el cliente?</label>
      <select id="cobro-dom-forma" class="mini-input" style="width:100%;" onchange="actualizarTotalCobro()">
        <option value="efectivo_directo">EFECTIVO — el cliente le paga directo al domiciliario (NO entra a caja)</option>
        <option value="banco">BANCO — entra a mi banco (yo le pago al domiciliario en efectivo del cajón)</option>
      </select>
      <p class="text-xs text-gray mt-1" id="cobro-dom-ayuda"></p>
    </div>
    <div class="flex-between mb-2" style="font-size:16px;font-weight:700;border-top:1px solid rgba(212,175,55,0.15);padding-top:10px;"><span>Total a cobrar <span class="text-xs text-gray" id="cobro-que-cobrar"></span></span><span class="text-gold" id="cobro-total-final">—</span></div>
    <label class="text-sm" style="display:block;margin-bottom:6px;">¿Cómo paga el cliente?</label>
    <p class="text-xs text-gray mb-2">Escriba cuánto paga en cada forma. Puede combinar varias. Deje en 0 las que no use.</p>
    <div class="form-grid-2">
      <div class="form-group"><label>Efectivo</label><input type="number" inputmode="numeric" id="pago-efectivo" placeholder="0" oninput="actualizarRepartoCobro()"></div>
      <div class="form-group"><label>Tarjeta</label><input type="number" inputmode="numeric" id="pago-tarjeta" placeholder="0" oninput="actualizarRepartoCobro()"></div>
      <div class="form-group" style="grid-column:1/-1"><label>Banco <span class="text-xs text-gray">(transferencia)</span></label><input type="number" inputmode="numeric" id="pago-banco" placeholder="0" oninput="actualizarRepartoCobro()"></div>
    </div>
    <div style="text-align:center;font-size:13px;padding:8px;border-radius:8px;background:rgba(0,0,0,0.2);" id="cobro-reparto-msg">—</div>
    </div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-cobro')">Cancelar</button><button class="btn btn-gold" id="btn-confirmar-cobro" onclick="confirmarCobroMesa()">${ic('i-check')} Cobrar</button></div></div></div>

  <div id="modal-empleado" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-emp-title">${ic('i-users')} Nuevo Empleado</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-empleado')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-emp-id"><div class="form-grid-2"><div class="form-group" style="grid-column:1/-1"><label>Nombre completo</label><input type="text" id="e-nombre"></div><div class="form-group"><label>Cédula</label><input type="text" id="e-cedula" inputmode="numeric"></div><div class="form-group"><label>Código (para marcar)</label><input type="text" id="e-codigo" inputmode="numeric" placeholder="Ej: 1234"></div></div><p class="text-xs text-gray mt-1">El empleado usará su cédula y este código en la pantalla de marcación de entrada/salida.</p></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-empleado')">Cancelar</button><button class="btn btn-gold" onclick="saveEmpleado()">Guardar</button></div></div></div>

  <div id="modal-marcacion" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:420px;"><div class="modal-header"><h3 id="modal-mc-title">${ic('i-clock')} Agregar Marcación</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-marcacion')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-mc-id"><div class="form-group"><label>Empleado</label><select id="mc-emp"></select></div><div class="form-grid-2"><div class="form-group"><label>Tipo</label><select id="mc-tipo"><option value="entrada">Entrada</option><option value="salida">Salida</option></select></div><div class="form-group"><label>Fecha y hora</label><input type="datetime-local" id="mc-fecha"></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-marcacion')">Cancelar</button><button class="btn btn-gold" onclick="saveMarcacion()">Guardar</button></div></div></div>

  <div id="modal-movimiento" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-money-out')} Gasto / Movimiento</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-movimiento')">${ic('i-close')}</button></div><div class="modal-body"><div class="form-group"><label>Tipo</label><select id="mov-tipo" onchange="toggleEmpleadoField()"><option value="nomina">Pago de Nómina / Empleado</option><option value="gasto">Gasto Menor</option><option value="salida">Salida</option><option value="entrada">Entrada</option></select></div><div class="form-group" id="mov-empleado-wrap"><label>Empleado</label><input type="text" id="mov-empleado" placeholder="Nombre del empleado"></div><div class="form-group"><label>Monto (COP)</label><input type="number" id="mov-monto" placeholder="0"></div><div class="form-group"><label>Descripción</label><input type="text" id="mov-desc" placeholder="Detalle del movimiento"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-movimiento')">Cancelar</button><button class="btn btn-gold" onclick="saveMovimiento()">Registrar</button></div></div></div>

  <div id="modal-editmov" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-edit')} Corregir Movimiento</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-editmov')">${ic('i-close')}</button></div><div class="modal-body"><p class="text-sm text-gray mb-2">Corrige el monto o la descripción si hubo un error al registrar. Queda en auditoría.</p><div class="form-group"><label>Monto (COP)</label><input type="number" id="editmov-monto" placeholder="0"></div><div class="form-group"><label>Descripción</label><input type="text" id="editmov-desc" placeholder="Detalle"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-editmov')">Cancelar</button><button class="btn btn-gold" onclick="saveEditMovimiento()">${ic('i-check')} Guardar Corrección</button></div></div></div>
  <div id="modal-retiro" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-money-out')} Retiro de Efectivo</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-retiro')">${ic('i-close')}</button></div><div class="modal-body"><p class="text-sm text-gray mb-2">Retiro oficial del efectivo (ej: los dueños retiran las ventas del día). No genera faltante: el sistema lo reconoce como salida autorizada.</p><div class="form-group"><label>Monto a retirar (COP)</label><input type="number" id="ret-monto" placeholder="0"></div><div class="form-group"><label>Motivo</label><input type="text" id="ret-motivo" placeholder="Ej: retiro ventas del día"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-retiro')">Cancelar</button><button class="btn btn-gold" onclick="saveRetiro()">${ic('i-check')} Registrar Retiro</button></div></div></div>

  <div id="modal-cliente" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-cli-title">${ic('i-delivery')} Nuevo Cliente</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-cliente')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-cli-id"><div class="form-grid-2"><div class="form-group"><label>Nombre</label><input type="text" id="c-nombre"></div><div class="form-group"><label>Teléfono</label><input type="text" id="c-tel"></div><div class="form-group" style="grid-column:1/-1"><label>Dirección</label><input type="text" id="c-dir"></div><div class="form-group"><label>Barrio</label><input type="text" id="c-barrio"></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-cliente')">Cancelar</button><button class="btn btn-gold" onclick="saveCliente()">Guardar</button></div></div></div>

  <div id="modal-usuario" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-usuario-title">${ic('i-users')} Nuevo Usuario</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-usuario')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-uid"><div class="form-grid-2"><div class="form-group"><label>Nombre</label><input type="text" id="u-nombre"></div><div class="form-group"><label>Usuario</label><input type="text" id="u-usuario"></div><div class="form-group"><label>Contraseña</label><input type="password" id="u-pass"></div><div class="form-group"><label>Rol</label><select id="u-rol"><option value="admin">Administrador</option><option value="jefe">Jefe</option><option value="supervisor">Supervisor</option><option value="cajero" selected>Cajero</option><option value="mesero">Mesero</option><option value="cocina">Cocina</option></select></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-usuario')">Cancelar</button><button class="btn btn-gold" onclick="saveUsuario()">Guardar</button></div></div></div>

  <div id="modal-producto" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-prod-title">${ic('i-menu-food')} Nuevo Producto</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-producto')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-prod-id"><div class="form-grid-2"><div class="form-group"><label>Nombre</label><input type="text" id="p-nombre"></div><div class="form-group"><label>Precio (COP)</label><input type="number" id="p-precio"></div><div class="form-group"><label>Categoría</label><select id="p-cat"><option>Entremeses</option><option>Chowfan</option><option>Chopsuey</option><option>Lomein</option><option>Platos Combinados</option><option>Costillas</option><option>Pollo</option><option>Platos Personales</option><option>Combos Familiares</option><option>Bebidas</option><option>Promo del Mes</option><option>Adicionales</option></select></div><div class="form-group" style="grid-column:1/-1"><label>Descripción</label><input type="text" id="p-desc"></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-producto')">Cancelar</button><button class="btn btn-gold" onclick="saveProducto()">Guardar</button></div></div></div>`;
}

// ========================= CLOCK / TIMERS =========================
function updateClock(){ const el=document.getElementById('time-display'); if(el) el.textContent=new Date(ahoraMs()).toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }

// ----- Modo táctil -----
function toggleTactil(){
  document.body.classList.toggle('tactil');
  const on=document.body.classList.contains('tactil');
  try{ localStorage.setItem('pi_tactil', on?'1':'0'); }catch(e){}
  toast(on?'Modo táctil activado':'Modo táctil desactivado','info');
}
function aplicarTactilGuardado(){ try{ if(localStorage.getItem('pi_tactil')==='1') document.body.classList.add('tactil'); }catch(e){} }

// ----- Bloqueo de pantalla por PIN/contraseña -----
function bloquearPantalla(){
  if(!STATE.user) return;
  document.getElementById('lock-user').textContent=STATE.user.nombre+' — '+STATE.user.usuario;
  document.getElementById('lock-pass').value='';
  document.getElementById('lock-error').style.display='none';
  document.getElementById('lock-screen').style.display='flex';
  setTimeout(()=>document.getElementById('lock-pass').focus(),100);
}
function ocultarBloqueo(){ document.getElementById('lock-screen').style.display='none'; }
function desbloquearPantalla(){
  const pass=(document.getElementById('lock-pass').value||'').trim();
  if(!STATE.user){ ocultarBloqueo(); return; }
  // Verificar contra los datos actuales del usuario (por si cambió la clave), comparando sin espacios extra
  const us=DB.get('usuarios')||[];
  const actual=us.find(u=>u.id===STATE.user.id) || us.find(u=>u.usuario===STATE.user.usuario);
  const claveOk = (STATE.user.pass||'').trim();
  const claveActual = actual?(actual.pass||'').trim():claveOk;
  if(pass===claveOk || pass===claveActual){ document.getElementById('lock-pass').value=''; document.getElementById('lock-error').style.display='none'; ocultarBloqueo(); }
  else { document.getElementById('lock-error').style.display='block'; document.getElementById('lock-pass').value=''; sonidoError(); }
}
setInterval(updateClock,1000);
setInterval(()=>{ if(STATE.user && (STATE.page==='cocina'||STATE.page==='listos'||STATE.page==='pedidos'||STATE.page==='tiempos')){ showPage(STATE.page); } updateBadges(); },6000);
let lastAct=Date.now();
document.addEventListener('mousemove',()=>lastAct=Date.now());
document.addEventListener('keydown',()=>lastAct=Date.now());
document.addEventListener('touchstart',()=>lastAct=Date.now());
setInterval(()=>{ if(STATE.user && Date.now()-lastAct>30*60*1000){ toast('Sesión cerrada por inactividad'); doLogout(); }},60000);

// ========================= BOOT con FIREBASE =========================
const FIREBASE_KEYS = ['usuarios','productos','ventas','clientes','cierres','auditoria','domiciliarios','caja_actual','factura_seq','config','empleados','marcaciones'];

function showConexion(estado){
  let el=document.getElementById('fb-status');
  if(!el){ el=document.createElement('div'); el.id='fb-status'; el.style.cssText='position:fixed;bottom:10px;left:10px;z-index:9998;font-size:11px;padding:5px 10px;border-radius:20px;font-family:Inter,sans-serif;'; document.body.appendChild(el); }
  if(estado==='ok'){ el.style.background='rgba(39,174,96,0.2)'; el.style.color='#2ECC71'; el.style.border='1px solid rgba(39,174,96,0.4)'; el.textContent='● Sincronizado'; }
  else if(estado==='off'){ el.style.background='rgba(192,57,43,0.2)'; el.style.color='#E74C3C'; el.style.border='1px solid rgba(192,57,43,0.4)'; el.textContent='● Sin conexión (modo local)'; }
  else { el.style.background='rgba(212,175,55,0.2)'; el.style.color='#D4AF37'; el.style.border='1px solid rgba(212,175,55,0.4)'; el.textContent='● Conectando...'; }
}

function bootApp(){
  buildModals();
  updateClock();
  aplicarTactilGuardado();
  // Mostrar logo en el login si existe
  const logo=(DB.get('config')||{}).logo||window.LOGO_DEFAULT;
  if(logo){ const img=document.getElementById('login-logo-img'); const fb=document.getElementById('login-logo-fallback');
    if(img){ img.src=logo; img.style.display='block'; } if(fb) fb.style.display='none'; }
  document.getElementById('login-pass').addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });
  document.getElementById('login-user').addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('login-pass').focus(); });
  document.getElementById('lock-pass').addEventListener('keydown',e=>{ if(e.key==='Enter') desbloquearPantalla(); });
  // Atajos de teclado para cajeros rápidos
  document.addEventListener('keydown',e=>{
    if(!STATE.user) return;
    if(document.getElementById('lock-screen').style.display==='flex') return;
    // Solo si no está escribiendo en un campo
    const tag=(e.target.tagName||'').toLowerCase();
    if(tag==='input'||tag==='select'||tag==='textarea') return;
    if(e.key==='F2'){ e.preventDefault(); if(STATE.user.rol!=='cocina'&&STATE.user.rol!=='biometria') showPage('ventas'); }
    else if(e.key==='F3'){ e.preventDefault(); showPage('pedidos'); }
    else if(e.key==='F4'){ e.preventDefault(); showPage('caja'); }
    else if(e.key==='F8'){ e.preventDefault(); bloquearPantalla(); }
    else if(e.key==='Escape'){ document.querySelectorAll('.modal-overlay').forEach(m=>{ if(m.style.display==='flex') m.style.display='none'; }); }
  });
  // Si este computador es la estación de impresión, arrancar la impresión automática
  if(esEstacionImpresion()){ setTimeout(arrancarAutoImpresion, 3000); }
  // Si este computador tiene el Centro de Impresión activo, arrancar su cola
  if(imprAutoActiva()){ setTimeout(()=>{ if(!autoImpresionCajaTimer) autoImpresionCajaTimer=setInterval(procesarImpresionesPendientes,4000); }, 3000); }
}

function startFirebase(){
  showConexion('conectando');
  // Cargar respaldo local primero (arranque instantáneo)
  FIREBASE_KEYS.forEach(k=>{ try{ const v=localStorage.getItem('pi_'+k); if(v!==null) CACHE[k]=JSON.parse(v); }catch(e){} });

  try {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    fbDB = firebase.database();
  } catch(e){
    console.error('Firebase init falló:', e);
    showConexion('off'); FB_READY=false; initData(); bootApp(); return;
  }

  // Estado de conexión
  fbDB.ref('.info/connected').on('value', s=>{ showConexion(s.val()?'ok':'off'); });

  // Hora real del servidor: Firebase entrega la diferencia con el reloj local.
  // Así, aunque alguien cambie la hora de su dispositivo, las marcaciones y ventas usan la hora real.
  fbDB.ref('.info/serverTimeOffset').on('value', s=>{
    const off = s.val();
    if(typeof off==='number') SERVER_OFFSET = off;
  });

  // Carga inicial completa
  fbDB.ref('data').once('value').then(snap=>{
    const data = snap.val() || {};
    FIREBASE_KEYS.forEach(k=>{ if(data[k]!==undefined && data[k]!==null) CACHE[k]=data[k]; });
    FB_READY = true;
    initData();           // crea datos por defecto solo si faltan (los sube a FB)
    listenRealtime();     // escucha cambios de otros dispositivos
    bootApp();
  }).catch(e=>{
    console.error('Carga inicial FB falló:', e);
    showConexion('off'); FB_READY=true; initData(); bootApp();
  });
}

// Escuchar cambios en tiempo real desde otros dispositivos
function listenRealtime(){
  FIREBASE_KEYS.forEach(k=>{
    fbDB.ref('data/'+k).on('value', snap=>{
      const v = snap.val();
      // caja_actual puede ser null de forma legítima (caja cerrada): ese cambio SÍ debe propagarse
      // para que TODOS los dispositivos vean la caja cerrada al instante.
      if(k==='caja_actual'){
        CACHE[k] = (v===undefined? null : v);
        try { localStorage.setItem('pi_'+k, JSON.stringify(CACHE[k])); } catch(e){}
        if(STATE.user && !ESCRIBIENDO){
          if(STATE.page!=='ventas'){ try{ showPage(STATE.page); }catch(e){} }
          else { try{ showPage('ventas'); }catch(e){} } // refrescar ventas para mostrar/ocultar bloqueo de caja
          updateBadges();
        }
        return;
      }
      if(v===null || v===undefined) return;
      CACHE[k] = v;
      try { localStorage.setItem('pi_'+k, JSON.stringify(v)); } catch(e){}
      // Si el usuario está dentro y NO está escribiendo una venta, refrescar la pantalla
      if(STATE.user && !ESCRIBIENDO){
        if(STATE.page!=='ventas'){ try{ showPage(STATE.page); }catch(e){} }
        updateBadges();
      }
      // Si llegan ventas nuevas y este es el computador de impresión, imprimir lo pendiente
      if(k==='ventas'){ try{ revisarColaImpresion(); }catch(e){} try{ procesarImpresionesPendientes(); }catch(e){} }
    });
  });
}

// ===================== COLA DE IMPRESIÓN AUTOMÁTICA =====================
// El computador de la caja (estación) imprime automáticamente los pedidos nuevos
let imprimiendoCola=false;
function revisarColaImpresion(){
  const cfg=DB.get('config')||{};
  if(!cfg.qzActivo || !esEstacionImpresion()) return; // solo el computador de impresión
  if(imprimiendoCola) return;
  const vs=DB.get('ventas')||[];
  // SOLO pedidos recientes (últimos 30 min). Evita imprimir todo el histórico en bucle.
  const reciente = v => (ahoraMs()-new Date(v.fecha))/60000 < 30;
  const tickets=vs.filter(v=>v.estado!=='anulada' && !v.ticketImpreso && reciente(v)).map(v=>({v,tipo:'ticket'}));
  const facturas=vs.filter(v=>v.estado==='pagada' && !v.facturaImpresa && reciente(v)).map(v=>({v,tipo:'factura'}));
  const pendientes=[...tickets,...facturas];
  if(pendientes.length===0) return;
  // Seguridad: nunca imprimir más de 6 cosas en una pasada (si hay más, algo está mal)
  const lote=pendientes.slice(0,6);
  imprimiendoCola=true;
  let i=0;
  function siguiente(){
    if(i>=lote.length){ imprimiendoCola=false; return; }
    const item=lote[i]; i++;
    const html = item.tipo==='ticket'? ticketCocinaHTML(item.v) : facturaHTML(item.v);
    try{ imprimirConQZ(html).then(()=>{
      const all=DB.get('ventas')||[]; const t=all.find(x=>x.id===item.v.id);
      if(t){ if(item.tipo==='ticket') t.ticketImpreso=true; else t.facturaImpresa=true; fusionarYGuardarVentas(all); }
      setTimeout(siguiente, 1000);
    }).catch(err=>{ console.warn('Cola impresión:',err); imprimiendoCola=false; }); }
    catch(e){ imprimiendoCola=false; }
  }
  siguiente();
}

// Bandera para no refrescar mientras se arma un pedido
let ESCRIBIENDO = false;

// Arranque: esperar a que cargue la librería de Firebase
window.addEventListener('load', ()=>{
  if(typeof firebase==='undefined' || !window.FIREBASE_CONFIG){
    console.warn('Firebase no disponible, modo local');
    showConexion('off');
    FIREBASE_KEYS.forEach(k=>{ try{ const v=localStorage.getItem('pi_'+k); if(v!==null) CACHE[k]=JSON.parse(v); }catch(e){} });
    initData(); bootApp(); return;
  }
  startFirebase();
});
