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
const ic = id => `<svg class="ic"><use href="#${id}"/></svg>`;
let SERVER_OFFSET = 0; // diferencia entre reloj del servidor y el del dispositivo (ms)
function now(){ return new Date(Date.now() + SERVER_OFFSET).toISOString(); }
function ahoraMs(){ return Date.now() + SERVER_OFFSET; }
function fmtDate(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString('es-CO')+' '+d.toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'}); }
function fmtMoney(n){ return '$ '+(Math.round(n)||0).toLocaleString('es-CO'); }
function uid(){ return '_'+Math.random().toString(36).substr(2,9); }
function today(){ return new Date().toISOString().split('T')[0]; }
function escapeHtml(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
// Una venta cuenta como ingreso solo si ya fue cobrada (pagada). Las mesas 'abierta' no suman.
function esPagada(v){ return v.estado==='pagada'; }
// Efectivo que de verdad queda en caja por una venta en efectivo:
// venta real + domicilio + recargo. NO incluye propina (se la lleva el mesero al instante).
function efectivoEnCajaDe(v){
  if(v.metodo!=='efectivo') return 0;
  const venta = v.ventaReal!==undefined?v.ventaReal:v.total;
  return venta + (v.valorDom||0) + (v.recargo||0);
}
// Métodos de pago del sistema (centralizados)
const METODOS_PAGO = [['efectivo','Efectivo'],['banco','Banco'],['tarjeta','Tarjeta'],['llave','Llave']];
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
    if(ch) DB.set('usuarios',us);
  })();
  if(!DB.get('config')) DB.set('config',{
    nombre:'Portal Imperial', nit:'900.123.456-7', dir:'Calle 10 #5-20', tel:'(7) 633 0000',
    numMesas:25, permitirEliminarDomicilio:true, permitirEliminarMesa:false, permitirEliminarLlevar:false,
    gpsActivo:false, gpsLat:0, gpsLng:0, gpsRadio:100, logo:(window.LOGO_DEFAULT||''),
    marcaAgua:'WALLACE COMPANY SYSTEM ING CCIA ROLDAN A.', marcaAguaActiva:true
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
  const landing = user.rol==='cocina'?'cocina' : (user.rol==='mesero')?'ventas' : (user.rol==='cajero')?'caja' : 'dashboard';
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
  {id:'dashboard',icon:'i-dashboard',label:'Dashboard',roles:['admin','supervisor']},
  {id:'ventas',icon:'i-cart',label:'Nueva Venta',roles:['admin','cajero','supervisor','mesero']},
  {id:'pedidos',icon:'i-orders',label:'Pedidos',roles:['admin','cajero','supervisor','mesero'],badge:'activos'},
  {id:'listos',icon:'i-ready',label:'Pedidos Listos',roles:['admin','cajero','supervisor','mesero'],badge:'listos'},
  {sec:'Operaciones'},
  {id:'caja',icon:'i-cash',label:'Caja',roles:['admin','cajero','supervisor']},
  {id:'domicilios',icon:'i-delivery',label:'Domicilios',roles:['admin','cajero','supervisor','mesero']},
  {id:'cocina',icon:'i-chef',label:'Cocina',roles:['admin','cocina','supervisor'],badge:'cocina'},
  {id:'tiempos',icon:'i-clock',label:'Tiempos de Entrega',roles:['admin','cajero','supervisor','mesero','cocina']},
  {sec:'Gestión'},
  {id:'usuarios',icon:'i-users',label:'Usuarios',roles:['admin']},
  {id:'historial',icon:'i-history',label:'Historial',roles:['admin','supervisor']},
  {id:'reportes',icon:'i-report',label:'Reportes',roles:['admin','supervisor']},
  {id:'auditoria',icon:'i-audit',label:'Auditoría',roles:['admin']},
  {id:'asistencia',icon:'i-clock',label:'Asistencia',roles:['admin','supervisor']},
  {id:'menu',icon:'i-menu-food',label:'Menú',roles:['admin','supervisor']},
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
  tiempos:['i-clock','Tiempos de Entrega']
};
function showPage(name){
  STATE.page=name;
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
  document.getElementById('nav-'+name)?.classList.add('active');
  const m=PAGE_META[name]||['i-dashboard',name];
  document.getElementById('page-title').innerHTML=ic(m[0])+' '+m[1];
  document.getElementById('sidebar').classList.remove('open');
  const fns={dashboard,ventas,pedidos,listos,caja,domicilios,cocina,usuarios,historial,reportes,auditoria,menu,config,asistencia,tiempos};
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
function menuCard(p){ return `<div class="menu-item-card" onclick="addToOrder('${p.id}')"><div class="item-ic">${ic('i-menu-food')}</div><div class="item-name">${escapeHtml(p.nombre)}</div><div class="item-price">${fmtMoney(p.precio)}</div></div>`; }

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
      DB.set('ventas',vs);
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
    obs:STATE.orderObs, cajero:STATE.user?.nombre, cajaId:DB.get('caja_actual')?.id||null };
  vs.unshift(venta); DB.set('ventas',vs);
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
    obs:STATE.orderObs, cajero:'', mesero:STATE.user.nombre, creadoPor:STATE.user.nombre, cajaId:DB.get('caja_actual')?.id||null };
  vs.unshift(venta); DB.set('ventas',vs);
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
      v.modificadoPor=STATE.user.nombre; v.modificadoEn=now(); DB.set('ventas',vs);
      logAudit('Editó pedido',`${v.factura||v.cliNombre} por ${STATE.user.nombre}`); toast('Pedido actualizado','success'); }
    clearOrder(); showPage('pedidos'); return;
  }

  const esDomicilio = STATE.tipoPedido==='domicilio';
  // Crear el pedido ABIERTO (aún sin cobrar) y enviarlo a cocina
  const venta={ id:uid(),factura:'',ordenCocina: esDomicilio?null:nextOrden(),fecha:now(),tipo:STATE.tipoPedido,
    mesa:STATE.tipoPedido==='mesa'?STATE.mesa:'', cliNombre:STATE.cliNombre,cliTel:STATE.cliTel,cliDir:STATE.cliDir,cliBarrio:STATE.cliBarrio,
    valorDom:dom, items:[...STATE.order], subtotal, descuento:STATE.descuento||0, descMot:STATE.descMot,
    total:ventaReal, ventaReal, propina:0, recargo:0, totalCobrado:0,
    metodo:'', estado:'abierta', estadoPedido:'activo', estadoCocina:'pendiente', domiciliario:'',
    obs:STATE.orderObs, cajero:STATE.user?.nombre, mesero:STATE.user?.rol==='mesero'?STATE.user.nombre:'', cajaId:DB.get('caja_actual')?.id||null };
  vs.unshift(venta); DB.set('ventas',vs);

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
function imprimirHTML(html){
  const esMovil = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if(esMovil){
    const w=window.open('','_blank');
    if(!w){ // si el navegador bloquea ventanas, usar el método clásico
      const pa=document.getElementById('print-area'); pa.innerHTML=html; pa.style.display='block'; window.print(); pa.style.display='none'; return;
    }
    w.document.write(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Imprimir</title><style>@media print{@page{margin:5mm;}}body{margin:0;padding:8px;font-family:'Courier New',monospace;}</style></head><body>${html}<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script></body></html>`);
    w.document.close();
  } else {
    const pa=document.getElementById('print-area'); pa.innerHTML=html; pa.style.display='block'; window.print(); pa.style.display='none';
  }
}
function printFactura(v){
  const cfg=DB.get('config')||{};
  const esDom = v.tipo==='domicilio';
  const subtotalItems = v.items.reduce((a,i)=>a+i.precio*i.qty,0);
  const html=`
  <div style="font-family:'Courier New',monospace;color:#000;">
    <div style="text-align:center;padding-bottom:8px;">
      ${cfg.logo?`<img src="${cfg.logo}" style="max-height:70px;max-width:180px;margin-bottom:6px;">`:''}
      <div style="font-size:20px;font-weight:bold;letter-spacing:2px;">${escapeHtml(cfg.nombre||'Portal Imperial')}</div>
      <div style="font-size:11px;letter-spacing:3px;color:#333;margin-top:2px;">COMIDA CHINA</div>
      <div style="font-size:10px;margin-top:6px;line-height:1.5;">
        NIT: ${cfg.nit||''}<br>${escapeHtml(cfg.dir||'')}<br>Tel: ${cfg.tel||''}
      </div>
    </div>
    <div style="border-top:2px solid #000;border-bottom:2px solid #000;padding:6px 0;text-align:center;margin:4px 0;">
      <div style="font-size:14px;font-weight:bold;">${esDom?'PEDIDO A DOMICILIO':'FACTURA '+v.factura}</div>
    </div>
    <div style="font-size:10px;line-height:1.6;margin:6px 0;">
      <div style="display:flex;justify-content:space-between;"><span>Fecha:</span><span>${fmtDate(v.fechaCobro||v.fecha)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Tipo:</span><span>${tipoLabel(v.tipo)}${v.mesa?' · '+v.mesa:''}</span></div>
      ${v.cliNombre?`<div style="display:flex;justify-content:space-between;"><span>Cliente:</span><span>${escapeHtml(v.cliNombre)}</span></div>`:''}
      ${esDom&&v.cliDir?`<div style="display:flex;justify-content:space-between;"><span>Dirección:</span><span>${escapeHtml(v.cliDir)}</span></div>`:''}
      ${esDom&&v.domiciliario?`<div style="display:flex;justify-content:space-between;"><span>Mensajero:</span><span>${escapeHtml(v.domiciliario)}</span></div>`:''}
      <div style="display:flex;justify-content:space-between;"><span>Atendió:</span><span>${escapeHtml(v.cajero||'')}</span></div>
    </div>
    <div style="border-top:1px dashed #000;padding-top:4px;">
      <div style="display:flex;justify-content:space-between;font-size:10px;font-weight:bold;border-bottom:1px solid #000;padding-bottom:3px;margin-bottom:4px;">
        <span style="flex:1;">CANT / PRODUCTO</span><span>VALOR</span>
      </div>
      ${v.items.map(i=>`<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;"><span style="flex:1;">${i.qty} x ${escapeHtml(i.nombre)}</span><span>${fmtMoney(i.precio*i.qty)}</span></div>`).join('')}
    </div>
    <div style="border-top:1px dashed #000;margin-top:6px;padding-top:6px;font-size:11px;">
      <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${fmtMoney(subtotalItems)}</span></div>
      ${v.descuento>0?`<div style="display:flex;justify-content:space-between;"><span>Descuento</span><span>-${fmtMoney(v.descuento)}</span></div>`:''}
      ${v.valorDom>0?`<div style="display:flex;justify-content:space-between;"><span>Domicilio</span><span>${fmtMoney(v.valorDom)}</span></div>`:''}
      ${v.propina>0?`<div style="display:flex;justify-content:space-between;"><span>Propina</span><span>${fmtMoney(v.propina)}</span></div>`:''}
      ${v.recargo>0?`<div style="display:flex;justify-content:space-between;"><span>Recargo datáfono</span><span>${fmtMoney(v.recargo)}</span></div>`:''}
    </div>
    <div style="border-top:2px solid #000;border-bottom:2px solid #000;margin-top:6px;padding:8px 0;display:flex;justify-content:space-between;font-size:16px;font-weight:bold;">
      <span>TOTAL</span><span>${fmtMoney(v.totalCobrado!==undefined?v.totalCobrado:v.total)}</span>
    </div>
    <div style="text-align:center;font-size:10px;margin-top:4px;">Forma de pago: ${nombreMetodo(v.metodo).toUpperCase()}</div>
    <div style="text-align:center;margin-top:14px;font-size:11px;font-weight:bold;letter-spacing:1px;">¡GRACIAS POR SU VISITA!</div>
    <div style="text-align:center;font-size:9px;color:#555;margin-top:4px;">Lo esperamos pronto</div>
    <div style="text-align:center;font-size:18px;margin-top:6px;letter-spacing:3px;">★ ★ ★</div>
    ${(cfg.marcaAguaActiva&&cfg.marcaAgua)?`<div style="text-align:center;font-size:8px;color:#999;margin-top:10px;letter-spacing:1px;border-top:1px dotted #ccc;padding-top:6px;">${escapeHtml(cfg.marcaAgua)}</div>`:''}
  </div>`;
  imprimirHTML(html);
}
function printTicketCocina(v){
  const esDom = v.tipo==='domicilio';
  const orden = v.ordenCocina?('#'+String(v.ordenCocina).padStart(3,'0')):'';
  let destino='';
  if(v.tipo==='mesa') destino=(v.mesa||'MESA').toUpperCase();
  else if(esDom) destino='DOMICILIO';
  else destino='PARA LLEVAR';
  const encabezado = esDom
    ? `<div style="font-size:28px;font-weight:bold;line-height:1.1;margin:6px 0;">${escapeHtml((v.cliNombre||'CLIENTE').toUpperCase())}</div>`
    : `<div style="font-size:34px;font-weight:bold;line-height:1.1;margin:6px 0;">ORDEN ${orden}</div>`;
  const html=`
  <div style="font-family:'Courier New',monospace;color:#000;text-align:center;">
    <div style="font-size:13px;letter-spacing:2px;">*** COCINA ***</div>
    ${encabezado}
    <div style="border:2px solid #000;border-radius:6px;padding:6px;margin:6px 0;font-size:22px;font-weight:bold;">${destino}</div>
    ${esDom?`<div style="font-size:13px;line-height:1.5;margin-bottom:4px;">
       ${v.cliDir?escapeHtml(v.cliDir):''}${v.cliBarrio?' · '+escapeHtml(v.cliBarrio):''}<br>
       Tel: ${escapeHtml(v.cliTel||'')}${v.domiciliario?'<br>Mensajero: '+escapeHtml(v.domiciliario):''}
     </div>`:''}
    ${v.tipo==='llevar'&&v.cliNombre?`<div style="font-size:14px;margin-bottom:4px;"><strong>${escapeHtml(v.cliNombre)}</strong></div>`:''}
    <div style="font-size:11px;">${fmtDate(v.fecha)}</div>
  </div>
  <hr style="border:1px dashed #000;margin:6px 0;">
  <div style="font-family:'Courier New',monospace;color:#000;">
    ${v.items.map(i=>`<div style="font-size:16px;font-weight:bold;margin-bottom:6px;">${i.qty} x ${escapeHtml(i.nombre)}${i.obs?`<div style="font-size:12px;font-weight:normal;padding-left:10px;">&gt;&gt; ${escapeHtml(i.obs)}</div>`:''}</div>`).join('')}
    ${v.obs?`<hr style="border:1px dashed #000;margin:6px 0;"><div style="font-size:13px;">NOTA: ${escapeHtml(v.obs)}</div>`:''}
  </div>
  <div style="text-align:center;font-size:18px;margin-top:8px;">--- &#9986; ---</div>`;
  imprimirHTML(html);
}

// ========================= NOTIFICACIÓN COCINA (SONIDO) =========================
function beep(freq=800,dur=200){
  try{ const ctx=new (window.AudioContext||window.webkitAudioContext)(); const o=ctx.createOscillator(),g=ctx.createGain();
  o.connect(g); g.connect(ctx.destination); o.frequency.value=freq; o.type='sine'; g.gain.setValueAtTime(0.3,ctx.currentTime);
  o.start(); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+dur/1000); o.stop(ctx.currentTime+dur/1000);
  }catch(e){}
}
// Sonidos distintos por evento
function sonidoPedidoNuevo(){ beep(700,120); setTimeout(()=>beep(900,180),140); } // dos tonos ascendentes
function sonidoListo(){ beep(1000,150); setTimeout(()=>beep(1300,250),170); }      // campanita alegre
function sonidoError(){ beep(250,300); }                                            // tono grave
function sonidoExito(){ beep(900,100); setTimeout(()=>beep(1200,120),110); }        // confirmación
function notifyKitchen(){ sonidoPedidoNuevo(); }

// ========================= PEDIDOS =========================
function pedidos(){
  const vs=(DB.get('ventas')||[]).filter(v=>v.estado!=='anulada');
  return `<div class="card"><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-orders')} Pedidos</div>
    <div style="display:flex;gap:8px;"><div style="position:relative;"><span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--gray3)">${ic('i-search')}</span><input type="text" id="ped-q" placeholder="Factura, cliente, teléfono..." oninput="showPage('pedidos')" style="padding-left:34px;width:240px;"></div>
    <button class="btn btn-primary btn-sm" onclick="showPage('ventas')">${ic('i-plus')} Nueva</button></div></div>
    ${renderPedidosTable(vs)}</div>`;
}
function renderPedidosTable(vs){
  const q=(document.getElementById('ped-q')?.value||'').toLowerCase();
  let list=vs.filter(v=>!q||(v.factura||'').toLowerCase().includes(q)||(v.cliNombre||'').toLowerCase().includes(q)||(v.cliTel||'').includes(q)||(v.domiciliario||'').toLowerCase().includes(q));
  if(list.length===0) return `<div class="empty-state">${ic('i-empty')}<p>Sin pedidos</p></div>`;
  const isAdmin=STATE.user.rol==='admin'||STATE.user.rol==='supervisor';
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Pedido / Mensajero</th><th>Tipo</th><th>Cliente/Mesa</th><th>Total</th><th>Cobro</th><th>Cocina</th><th>Pedido</th><th>Domiciliario</th><th>Acciones</th></tr></thead><tbody>
  ${list.map(v=>{
    const editable = isAdmin || (v.estadoCocina!=='entregado' && v.estadoPedido!=='entregado');
    const abierta = v.estado==='abierta';
    const porVerificar = v.estado==='por_verificar';
    return `<tr ${abierta?'style="background:rgba(212,175,55,0.06)"':porVerificar?'style="background:rgba(52,152,219,0.08)"':''}>
    <td><span class="text-gold font-bold">${refPedido(v)}</span>${v.modificadoPor?`<br><span class="text-xs text-gray">editado: ${escapeHtml(v.modificadoPor)}</span>`:''}</td>
    <td>${tipoLabel(v.tipo)}</td>
    <td>${escapeHtml(v.cliNombre||v.mesa||'—')}${v.cliTel?`<br><span class="text-xs text-gray">${escapeHtml(v.cliTel)}</span>`:''}</td>
    <td class="font-bold">${fmtMoney(v.total)}</td>
    <td>${abierta?'<span class="badge badge-orange">Abierta</span>':porVerificar?'<span class="badge badge-blue">Por verificar</span>':'<span class="badge badge-green">Pagada</span>'}</td>
    <td>${cocinaBadge(v.estadoCocina)}</td>
    <td><select onchange="setEstadoPedido('${v.id}',this.value)" class="mini-input" style="width:auto;padding:4px 8px;"><option value="activo" ${v.estadoPedido==='activo'?'selected':''}>Activo</option><option value="entregado" ${v.estadoPedido==='entregado'?'selected':''}>Entregado</option></select></td>
    <td>${v.tipo==='domicilio'?domiciliarioSelect(v):'—'}</td>
    <td style="display:flex;gap:5px;flex-wrap:wrap;">
      ${abierta?`<button class="btn btn-success btn-sm" onclick="abrirCobroMesa('${v.id}')" title="Cobrar y cerrar">${ic('i-cash')} Cobrar</button>`:''}
      ${porVerificar?`<button class="btn btn-primary btn-sm" onclick="verificarPago('${v.id}')" title="Verificar comprobante">${ic('i-check')} Verificar</button>`:''}
      ${editable?`<button class="btn btn-ghost btn-sm" onclick="editarPedido('${v.id}')" title="Editar">${ic('i-edit')}</button>`:''}
      <button class="btn btn-ghost btn-sm" onclick="reimprimir('${v.id}')" title="Reimprimir">${ic('i-print')}</button>
      ${isAdmin?`<button class="btn btn-danger btn-sm" onclick="anularVenta('${v.id}')" title="Anular">${ic('i-ban')}</button>`:''}
      ${isAdmin && v.tipo==='domicilio' && (DB.get('config')?.permitirEliminarDomicilio)?`<button class="btn btn-danger btn-sm" onclick="eliminarDefinitivo('${v.id}')" title="Eliminar definitivamente">${ic('i-trash')}</button>`:''}
    </td></tr>`;}).join('')}
  </tbody></table></div>`;
}
function cocinaBadge(e){ const m={pendiente:['badge-orange','Pendiente'],preparando:['badge-blue','Preparando'],listo:['badge-green','Listo'],entregado:['badge-gray','Entregado']}; const x=m[e||'pendiente']; return `<span class="badge ${x[0]}">${x[1]}</span>`; }
function domiciliarioSelect(v){
  const ds=(DB.get('domiciliarios')||[]).filter(d=>d.activo);
  return `<select onchange="asignarDomiciliario('${v.id}',this.value)" class="mini-input" style="width:auto;padding:4px 8px;"><option value="">Asignar...</option>${ds.map(d=>`<option ${v.domiciliario===d.nombre?'selected':''}>${escapeHtml(d.nombre)}</option>`).join('')}</select>`;
}
function asignarDomiciliario(id,nombre){ const vs=DB.get('ventas')||[]; const v=vs.find(x=>x.id===id); if(v){v.domiciliario=nombre;DB.set('ventas',vs);logAudit('Asignó domiciliario',`${v.factura} → ${nombre}`);toast('Domiciliario asignado','success');} }
function setEstadoPedido(id,e){ const vs=DB.get('ventas')||[]; const v=vs.find(x=>x.id===id); if(v){v.estadoPedido=e;if(e==='entregado')v.estadoCocina='entregado';DB.set('ventas',vs);} updateBadges(); }
function editarPedido(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  STATE.editandoVenta=v; STATE.order=v.items.map(i=>({...i})); STATE.tipoPedido=v.tipo; STATE.mesa=v.mesa||'';
  STATE.cliNombre=v.cliNombre||''; STATE.cliTel=v.cliTel||''; STATE.cliDir=v.cliDir||''; STATE.cliBarrio=v.cliBarrio||'';
  STATE.valorDom=v.valorDom||0; STATE.descuento=v.descuento||0; STATE.descMot=v.descMot||''; STATE.orderObs=v.obs||'';
  showPage('ventas');
}

let cobrandoMesaId=null, cobroBaseTotal=0, cobroTotalCliente=0;
function abrirCobroMesa(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  cobrandoMesaId=id; cobroBaseTotal=v.total;
  const ref = v.tipo==='mesa'?v.mesa : (v.cliNombre||refCocina(v));
  const extra = v.valorDom>0?` + domicilio ${fmtMoney(v.valorDom)}`:'';
  document.getElementById('cobro-mesa-info').innerHTML=`<strong>${escapeHtml(ref)}</strong> · ${v.items.length} platos · Venta <span class="text-gold font-bold">${fmtMoney(v.total)}</span>${extra}`;
  ['cobro-propina','cobro-recargo','pago-efectivo','pago-tarjeta','pago-banco','pago-llave'].forEach(i=>{ const el=document.getElementById(i); if(el) el.value=''; });
  document.getElementById('cobro-propina').value=0;
  document.getElementById('cobro-recargo').value=0;
  openModal('modal-cobro');
  actualizarTotalCobro();
}
function actualizarTotalCobro(){
  const propina=parseFloat(document.getElementById('cobro-propina')?.value)||0;
  const recargo=parseFloat(document.getElementById('cobro-recargo')?.value)||0;
  const v=(DB.get('ventas')||[]).find(x=>x.id===cobrandoMesaId);
  const dom=v?(v.valorDom||0):0;
  cobroTotalCliente=cobroBaseTotal+dom+propina+recargo;
  const el=document.getElementById('cobro-total-final');
  if(el) el.textContent=fmtMoney(cobroTotalCliente);
  actualizarRepartoCobro();
}
function actualizarRepartoCobro(){
  const ef=parseFloat(document.getElementById('pago-efectivo')?.value)||0;
  const ta=parseFloat(document.getElementById('pago-tarjeta')?.value)||0;
  const ba=parseFloat(document.getElementById('pago-banco')?.value)||0;
  const ll=parseFloat(document.getElementById('pago-llave')?.value)||0;
  const suma=ef+ta+ba+ll;
  const msg=document.getElementById('cobro-reparto-msg');
  const btn=document.getElementById('btn-confirmar-cobro');
  if(!msg) return;
  const falta=cobroTotalCliente-suma;
  if(suma===0){ msg.innerHTML='<span class="text-gray">Escriba cómo paga el cliente</span>'; }
  else if(Math.abs(falta)<1){ msg.innerHTML='<span class="text-green font-bold">✓ Pago completo</span>'; }
  else if(falta>0){ msg.innerHTML=`<span class="text-gold">Falta ${fmtMoney(falta)}</span>`; }
  else { msg.innerHTML=`<span class="text-red">Sobra ${fmtMoney(Math.abs(falta))} (revise)</span>`; }
}
function confirmarCobroMesa(){
  const id=cobrandoMesaId; if(!id) return;
  const propina=parseFloat(document.getElementById('cobro-propina')?.value)||0;
  const recargo=parseFloat(document.getElementById('cobro-recargo')?.value)||0;
  const pagos={ efectivo:parseFloat(document.getElementById('pago-efectivo')?.value)||0,
    tarjeta:parseFloat(document.getElementById('pago-tarjeta')?.value)||0,
    banco:parseFloat(document.getElementById('pago-banco')?.value)||0,
    llave:parseFloat(document.getElementById('pago-llave')?.value)||0 };
  const suma=pagos.efectivo+pagos.tarjeta+pagos.banco+pagos.llave;
  if(suma<=0){ toast('Indique cómo paga el cliente','error'); return; }
  if(Math.abs(cobroTotalCliente-suma)>=1){ toast('Lo pagado no cuadra con el total a cobrar','error'); return; }
  const vs=DB.get('ventas')||[];
  const v=vs.find(x=>x.id===id); if(!v){ closeModal('modal-cobro'); return; }
  const dom=v.valorDom||0;
  v.ventaReal=v.total;
  v.propina=propina; v.recargo=recargo;
  v.totalCobrado=v.total+dom+propina+recargo;
  v.pagos=pagos;
  // método principal: el de mayor monto (para reportes)
  v.metodo=Object.entries(pagos).sort((a,b)=>b[1]-a[1])[0][0];
  v.fechaCobro=now(); v.cobradoPor=STATE.user.nombre;
  v.cajaId=DB.get('caja_actual')?.id||v.cajaId||null;
  if(!v.factura && v.tipo!=='domicilio') v.factura=nextFactura();
  // Banco o Llave con monto => queda PENDIENTE de verificación
  const requiereVerif = pagos.banco>0 || pagos.llave>0;
  if(requiereVerif){
    v.estado='por_verificar';
    DB.set('ventas',vs);
    logAudit('Cobro pendiente de verificar',`${v.factura||v.cliNombre} - banco/llave`);
    closeModal('modal-cobro'); cobrandoMesaId=null;
    toast('Pago registrado. Pendiente de verificar el comprobante (Banco/Llave).','info');
    showPage('pedidos'); return;
  }
  v.estado='pagada';
  DB.set('ventas',vs);
  const ref=v.tipo==='mesa'?v.mesa:(v.factura||v.cliNombre);
  logAudit('Cobró pedido',`${ref} - venta ${fmtMoney(v.ventaReal)}${propina>0?' propina '+fmtMoney(propina):''}${recargo>0?' recargo '+fmtMoney(recargo):''}`);
  closeModal('modal-cobro'); cobrandoMesaId=null;
  toast(`${ref} cobrada`,'success');
  printFactura(v);
  showPage('pedidos');
}
function verificarPago(id){
  const vs=DB.get('ventas')||[]; const v=vs.find(x=>x.id===id); if(!v) return;
  if(!confirm('¿Confirma que ya verificó el comprobante de pago (Banco/Llave) y el dinero está recibido?')) return;
  v.estado='pagada'; v.verificadoPor=STATE.user.nombre; v.fechaVerif=now();
  DB.set('ventas',vs);
  logAudit('Verificó pago',`${v.factura||v.cliNombre} por ${STATE.user.nombre}`);
  toast('Pago verificado','success');
  printFactura(v);
  showPage('pedidos');
}
function anularVenta(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  if(v.tipo==='domicilio'){
    if(!confirm('Este es un domicilio. Se eliminará por completo sin dejar rastro en el sistema. ¿Continuar?')) return;
    DB.set('ventas',(DB.get('ventas')||[]).filter(x=>x.id!==id));
    toast('Domicilio eliminado','error'); showPage('pedidos'); return;
  }
  if(!confirm('¿Anular esta venta? Quedará registrada como anulada en el historial y auditoría.')) return;
  const vs=DB.get('ventas')||[]; const t=vs.find(x=>x.id===id); if(t){t.estado='anulada';DB.set('ventas',vs);logAudit('Anuló venta',t.factura);}
  toast('Venta anulada','error'); showPage('pedidos');
}
function eliminarDefinitivo(id){
  const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(!v) return;
  if(!confirm('⚠ ADVERTENCIA: Esta acción eliminará PERMANENTEMENTE el domicilio.\n\nSe borrará de: ventas, historial, reportes, caja y estadísticas. No quedará ningún rastro en el sistema. NO se puede deshacer.\n\n¿Continuar?')) return;
  DB.set('ventas',(DB.get('ventas')||[]).filter(x=>x.id!==id));
  toast('Domicilio eliminado permanentemente','error'); showPage('pedidos');
}
function reimprimir(id){ const v=(DB.get('ventas')||[]).find(x=>x.id===id); if(v){logAudit('Reimprimió factura',v.factura);printFactura(v);} }

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
function cocina(){
  const vs=(DB.get('ventas')||[]).filter(v=>v.estado!=='anulada'&&v.estadoPedido!=='entregado'&&v.estadoCocina!=='entregado')
    .sort((a,b)=>new Date(a.fecha)-new Date(b.fecha));
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
      </div></div>`;}).join('')}</div>`;
}
function setEstadoCocina(id,e){
  const vs=DB.get('ventas')||[]; const v=vs.find(x=>x.id===id);
  if(v){ v.estadoCocina=e; if(e==='entregado') v.estadoPedido='entregado';
    if(e==='preparando' && !v.horaPreparando) v.horaPreparando=now();
    if(e==='listo' && !v.horaListo) v.horaListo=now();  // momento en que quedó listo (para medir tiempos)
    DB.set('ventas',vs);
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
           <button class="btn btn-gold" onclick="openModal('modal-caja')" style="padding:13px 30px;">${ic('i-lock')} Abrir Caja</button>`
        : `<p class="text-gray mb-2">La caja está cerrada. Solo el cajero, administrador o supervisor pueden abrirla.</p>`}
      </div>
      ${cierres.length>0&&puedeAbrir?`<div class="card mt-2"><div class="card-title">${ic('i-history')} Historial de Cierres</div><div class="table-wrap"><table class="data-table"><thead><tr><th>Cajero</th><th>Fondo</th><th>Total Ventas</th><th>Esperado</th><th>Contado</th><th>Cuadre</th><th>Cierre</th></tr></thead><tbody>${cierres.slice(0,15).map(c=>{ const d=c.diferencia; const cuadre = d===undefined?'<span class="text-gray">—</span>':d===0?'<span class="badge badge-green">Cuadrada</span>':d>0?`<span class="badge badge-blue">Sobra ${fmtMoney(d)}</span>`:`<span class="badge badge-red">Falta ${fmtMoney(Math.abs(d))}</span>`; return `<tr><td>${escapeHtml(c.cajero)}</td><td>${fmtMoney(c.fondo)}</td><td class="font-bold text-gold">${fmtMoney(c.total)}</td><td>${c.esperadoEfectivo!==undefined?fmtMoney(c.esperadoEfectivo):'—'}</td><td>${c.contadoEfectivo!==undefined?fmtMoney(c.contadoEfectivo):'—'}</td><td>${cuadre}</td><td class="text-xs text-gray">${fmtDate(c.cierre)}</td></tr>`; }).join('')}</tbody></table></div></div>`:''}`;
  }
  const movs=c.movimientos||[];
  const vs=(DB.get('ventas')||[]).filter(v=>esPagada(v)&&v.cajaId===c.id);
  // Ingresos reales por método (solo venta real, sin propina/domicilio/recargo)
  const porMetodo={}; METODOS_PAGO.forEach(([k])=>porMetodo[k]=0);
  vs.forEach(v=>{ if(porMetodo[v.metodo]!==undefined) porMetodo[v.metodo]+=(v.ventaReal!==undefined?v.ventaReal:v.total); });
  const totalV=Object.values(porMetodo).reduce((a,b)=>a+b,0);
  // Conceptos que NO son ingreso del negocio
  const totalPropinas=vs.reduce((a,v)=>a+(v.propina||0),0);
  const totalDomicilios=vs.reduce((a,v)=>a+(v.valorDom||0),0);
  const totalRecargos=vs.reduce((a,v)=>a+(v.recargo||0),0);
  // Movimientos de caja
  const entradas=movs.filter(m=>m.tipo==='entrada').reduce((a,m)=>a+m.monto,0);
  const gastos=movs.filter(m=>m.tipo==='salida'||m.tipo==='gasto'||m.tipo==='nomina').reduce((a,m)=>a+m.monto,0);
  const retiros=movs.filter(m=>m.tipo==='retiro').reduce((a,m)=>a+m.monto,0);
  // Efectivo en caja: fondo + ventas efectivo + domicilios efectivo + propinas efectivo + recargos efectivo + entradas - gastos - retiros
  const efectivoVentas=vs.reduce((a,v)=>a+efectivoEnCajaDe(v),0);
  const enCaja=c.fondo+efectivoVentas+entradas-gastos-retiros;
  const puedeRetiro = STATE.user.rol==='admin'||STATE.user.rol==='supervisor';

  const cards=METODOS_PAGO.map(([k,l],i)=>{ const colores=['green','blue','gold','red']; return `<div class="stat-card ${colores[i%4]}"><div class="stat-icon">${ic('i-cash')}</div><div class="stat-label">${l}</div><div class="stat-value">${fmtMoney(porMetodo[k])}</div></div>`; }).join('');

  return `<div class="stats-grid">${cards}</div>
  <div class="grid-2">
    <div class="card"><div class="card-title">${ic('i-cash')} Resumen de Caja — ${escapeHtml(c.cajero)}</div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Apertura</span><span class="text-sm">${fmtDate(c.apertura)}</span></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Base Inicial</span><strong>${fmtMoney(c.fondo)}</strong></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Ventas Reales</span><strong class="text-gold">${fmtMoney(totalV)}</strong></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Entradas Extra</span><strong class="text-green">${fmtMoney(entradas)}</strong></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Gastos / Nómina</span><strong class="text-red">-${fmtMoney(gastos)}</strong></div>
      <div class="flex-between" style="padding:7px 0;"><span>Retiros Autorizados</span><strong class="text-red">-${fmtMoney(retiros)}</strong></div>
      <hr class="divider">
      <div class="flex-between" style="font-size:18px;font-weight:700;"><span>Efectivo en Caja</span><span class="text-gold">${fmtMoney(enCaja)}</span></div>
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
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Tipo</th><th>Descripción</th><th>Usuario</th><th>Monto</th><th>Hora</th></tr></thead><tbody>${movs.slice().reverse().map(m=>`<tr><td>${movBadge(m.tipo)}</td><td>${escapeHtml(m.desc)}${m.empleado?'<br><span class="text-xs text-gray">'+escapeHtml(m.empleado)+'</span>':''}</td><td class="text-xs">${escapeHtml(m.usuario||'')}</td><td class="${m.tipo==='entrada'?'text-green':'text-red'}">${m.tipo==='entrada'?'+':'-'}${fmtMoney(m.monto)}</td><td class="text-xs text-gray">${fmtDate(m.fecha)}</td></tr>`).join('')}</tbody></table></div>`}
  </div>`;
}
function propinasPorMesero(vs){
  const x={}; vs.forEach(v=>{ if(v.propina>0){ const m=v.mesero||v.cajero||'—'; x[m]=(x[m]||0)+v.propina; } });
  return Object.entries(x).map(([m,t])=>`<div class="flex-between text-sm" style="padding:4px 0;"><span>${escapeHtml(m)}</span><span class="text-green">${fmtMoney(t)}</span></div>`).join('')||'<span class="text-xs text-gray">—</span>';
}
function movBadge(t){ const m={entrada:['badge-green','Entrada'],salida:['badge-red','Salida'],gasto:['badge-orange','Gasto'],nomina:['badge-red','Nómina'],retiro:['badge-blue','Retiro']}; const x=m[t]||['badge-gray',t]; return `<span class="badge ${x[0]}">${x[1]}</span>`; }
function abrirCaja(){
  if(STATE.user.rol==='mesero'){ toast('Un mesero no puede abrir caja','error'); closeModal('modal-caja'); return; }
  const fondo=parseFloat(document.getElementById('caja-fondo').value)||0;
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
  c.movimientos.push({tipo:'retiro',monto,desc:motivo||'Retiro de efectivo',usuario:STATE.user.nombre,fecha:now()});
  DB.set('caja_actual',c);
  logAudit('Retiro de efectivo',`${fmtMoney(monto)} - ${motivo} (por ${STATE.user.nombre})`);
  closeModal('modal-retiro'); toast('Retiro registrado','success'); showPage('caja');
}
function saveMovimiento(){
  const tipo=document.getElementById('mov-tipo').value;
  const monto=parseFloat(document.getElementById('mov-monto').value)||0;
  const desc=document.getElementById('mov-desc').value;
  const empleado=document.getElementById('mov-empleado').value;
  if(monto<=0){ toast('Ingrese un monto válido','error'); return; }
  const c=DB.get('caja_actual'); if(!c){ toast('No hay caja abierta','error'); closeModal('modal-movimiento'); return; }
  if(!Array.isArray(c.movimientos)) c.movimientos=[];
  c.movimientos.push({tipo,monto,desc:desc||(tipo==='nomina'?'Pago de nómina':tipo),empleado,usuario:STATE.user.nombre,fecha:now()});
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
  const esperadoEfectivo=c.fondo+efectivoVentas+entradas-gastos-retiros;
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
  const porMetodo={}; METODOS_PAGO.forEach(([k])=>porMetodo[k]=vs.filter(v=>v.metodo===k).reduce((a,v)=>a+(v.ventaReal!==undefined?v.ventaReal:v.total),0));
  const totalVentas=Object.values(porMetodo).reduce((a,b)=>a+b,0);
  const propinas=vs.reduce((a,v)=>a+(v.propina||0),0);
  const domicilios=vs.reduce((a,v)=>a+(v.valorDom||0),0);
  const recargos=vs.reduce((a,v)=>a+(v.recargo||0),0);
  const efectivoVentas=vs.reduce((a,v)=>a+efectivoEnCajaDe(v),0);
  const entradas=(c.movimientos||[]).filter(m=>m.tipo==='entrada').reduce((a,m)=>a+m.monto,0);
  const gastos=(c.movimientos||[]).filter(m=>m.tipo==='salida'||m.tipo==='gasto'||m.tipo==='nomina').reduce((a,m)=>a+m.monto,0);
  const retiros=(c.movimientos||[]).filter(m=>m.tipo==='retiro').reduce((a,m)=>a+m.monto,0);
  const esperadoEfectivo=c.fondo+efectivoVentas+entradas-gastos-retiros;
  const diferencia=contado-esperadoEfectivo;
  const cierre={...c,cierre:now(),porMetodo,gastos,entradas,retiros,propinas,domicilios,recargos,
    total:totalVentas, esperadoEfectivo, contadoEfectivo:contado, baseFinal:contado, diferencia, obsCierre:obs, cerradoPor:STATE.user.nombre};
  const cs=DB.get('cierres')||[]; cs.unshift(cierre); DB.set('cierres',cs); DB.set('caja_actual',null);
  logAudit('Cerró caja',`${c.cajero} - Ventas: ${fmtMoney(totalVentas)} - ${diferencia===0?'Cuadrada':diferencia>0?'Sobra '+fmtMoney(diferencia):'Falta '+fmtMoney(Math.abs(diferencia))}`);
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
    ${us.map(u=>`<tr><td class="font-bold">${escapeHtml(u.nombre)}</td><td><span class="text-gold">${escapeHtml(u.usuario)}</span></td><td><span class="badge ${u.rol==='admin'?'badge-red':u.rol==='supervisor'?'badge-blue':u.rol==='cocina'?'badge-orange':'badge-gold'}">${u.rol}</span></td><td><span class="badge ${u.activo?'badge-green':'badge-gray'}">${u.activo?'Activo':'Inactivo'}</span></td><td style="display:flex;gap:6px;"><button class="btn btn-ghost btn-sm" onclick="openModalUsuario('${u.id}')">${ic('i-edit')}</button><button class="btn btn-${u.activo?'danger':'success'} btn-sm" onclick="toggleUsuario('${u.id}')">${u.activo?ic('i-ban'):ic('i-check')}</button></td></tr>`).join('')}
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

// ========================= HISTORIAL =========================
function historial(){
  const vs=DB.get('ventas')||[];
  return `<div class="card"><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-history')} Historial de Ventas</div>
    <div style="position:relative;"><span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--gray3)">${ic('i-search')}</span><input type="text" id="hist-q" placeholder="Factura, cliente, teléfono..." oninput="showPage('historial')" style="padding-left:34px;width:240px;"></div></div>
    ${renderHistTable(vs)}</div>`;
}
function renderHistTable(vs){
  const q=(document.getElementById('hist-q')?.value||'').toLowerCase();
  const list=vs.filter(v=>!q||(v.factura||'').toLowerCase().includes(q)||(v.cliNombre||'').toLowerCase().includes(q)||(v.cliTel||'').includes(q)||(v.domiciliario||'').toLowerCase().includes(q));
  if(list.length===0) return `<div class="empty-state">${ic('i-empty')}<p>Sin ventas</p></div>`;
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
  return `<div class="card"><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-audit')} Registro de Auditoría</div><span class="badge badge-gold">${logs.length} registros · Solo lectura</span></div>
    ${logs.length===0?`<div class="empty-state">${ic('i-empty')}<p>Sin registros</p></div>`:
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>Usuario</th><th>Acción</th><th>Detalle</th><th>Fecha</th></tr></thead><tbody>
    ${logs.slice(0,300).map(l=>`<tr><td><strong>${escapeHtml(l.usuario)}</strong></td><td>${escapeHtml(l.accion)}</td><td class="text-sm text-gray">${escapeHtml(l.detalle||'—')}</td><td class="text-xs text-gray">${fmtDate(l.fecha)}</td></tr>`).join('')}
    </tbody></table></div>`}</div>`;
}

// ========================= MENÚ =========================
function menu(){
  const ps=DB.get('productos')||[];
  return `<div class="card"><div class="flex-between mb-2"><div class="card-title" style="margin:0;">${ic('i-menu-food')} Gestión del Menú</div><button class="btn btn-primary btn-sm" onclick="openModalProducto()">${ic('i-plus')} Nuevo Producto</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Nombre</th><th>Categoría</th><th>Precio</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>
    ${ps.map(p=>`<tr><td class="font-bold">${escapeHtml(p.nombre)}</td><td><span class="badge badge-blue">${escapeHtml(p.cat)}</span></td><td class="text-gold font-bold">${fmtMoney(p.precio)}</td><td><span class="badge ${p.activo?'badge-green':'badge-gray'}">${p.activo?'Activo':'Inactivo'}</span></td><td style="display:flex;gap:6px;"><button class="btn btn-ghost btn-sm" onclick="openModalProducto('${p.id}')">${ic('i-edit')}</button><button class="btn btn-${p.activo?'danger':'success'} btn-sm" onclick="toggleProducto('${p.id}')">${p.activo?ic('i-ban'):ic('i-check')}</button></td></tr>`).join('')}
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

  <div id="modal-caja" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-cash')} Apertura de Caja</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-caja')">${ic('i-close')}</button></div><div class="modal-body"><div class="form-group"><label>Fondo Inicial (COP)</label><input type="number" id="caja-fondo" value="100000"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-caja')">Cancelar</button><button class="btn btn-gold" onclick="abrirCaja()">Abrir Caja</button></div></div></div>

  <div id="modal-cierre" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:420px;"><div class="modal-header"><h3>${ic('i-lock')} Cierre y Cuadre de Caja</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-cierre')">${ic('i-close')}</button></div><div class="modal-body"><div class="flex-between mb-2" style="padding:8px 12px;background:rgba(212,175,55,0.08);border-radius:8px;"><span class="text-sm">Efectivo que debería haber</span><span class="text-gold font-bold" id="cierre-esperado">—</span></div><div class="form-group"><label>Efectivo contado en el cajón (COP)</label><input type="number" id="cierre-contado" placeholder="Cuente la plata y escriba el total" oninput="calcularDiferencia()"></div><div style="text-align:center;font-size:16px;padding:10px;border-radius:8px;background:rgba(0,0,0,0.2);margin-bottom:12px;" id="cierre-dif"><span class="text-gray">Cuente el efectivo del cajón</span></div><div class="form-group"><label>Observaciones (opcional)</label><input type="text" id="cierre-obs" placeholder="Ej: motivo del faltante"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-cierre')">Cancelar</button><button class="btn btn-danger" onclick="confirmarCierre()">${ic('i-lock')} Cerrar Caja</button></div></div></div>

  <div id="modal-cobro" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:440px;"><div class="modal-header"><h3>${ic('i-cash')} Cobrar</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-cobro')">${ic('i-close')}</button></div><div class="modal-body"><p class="text-sm mb-2" id="cobro-mesa-info"></p>
    <div class="form-grid-2">
      <div class="form-group"><label>Propina (del mesero)</label><input type="number" inputmode="numeric" id="cobro-propina" placeholder="0" value="0" min="0" oninput="actualizarTotalCobro()"></div>
      <div class="form-group"><label>Recargo datáfono</label><input type="number" inputmode="numeric" id="cobro-recargo" placeholder="0" value="0" min="0" oninput="actualizarTotalCobro()"></div>
    </div>
    <div class="flex-between mb-2" style="font-size:16px;font-weight:700;border-top:1px solid rgba(212,175,55,0.15);padding-top:10px;"><span>Total a cobrar</span><span class="text-gold" id="cobro-total-final">—</span></div>
    <label class="text-sm" style="display:block;margin-bottom:6px;">¿Cómo paga el cliente?</label>
    <p class="text-xs text-gray mb-2">Escriba cuánto paga en cada forma. Puede combinar varias. Deje en 0 las que no use.</p>
    <div class="form-grid-2">
      <div class="form-group"><label>Efectivo</label><input type="number" inputmode="numeric" id="pago-efectivo" placeholder="0" oninput="actualizarRepartoCobro()"></div>
      <div class="form-group"><label>Tarjeta</label><input type="number" inputmode="numeric" id="pago-tarjeta" placeholder="0" oninput="actualizarRepartoCobro()"></div>
      <div class="form-group"><label>Banco <span class="text-xs text-gray">(verificar)</span></label><input type="number" inputmode="numeric" id="pago-banco" placeholder="0" oninput="actualizarRepartoCobro()"></div>
      <div class="form-group"><label>Llave <span class="text-xs text-gray">(verificar)</span></label><input type="number" inputmode="numeric" id="pago-llave" placeholder="0" oninput="actualizarRepartoCobro()"></div>
    </div>
    <div style="text-align:center;font-size:13px;padding:8px;border-radius:8px;background:rgba(0,0,0,0.2);" id="cobro-reparto-msg">—</div>
    </div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-cobro')">Cancelar</button><button class="btn btn-gold" id="btn-confirmar-cobro" onclick="confirmarCobroMesa()">${ic('i-check')} Cobrar</button></div></div></div>

  <div id="modal-empleado" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-emp-title">${ic('i-users')} Nuevo Empleado</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-empleado')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-emp-id"><div class="form-grid-2"><div class="form-group" style="grid-column:1/-1"><label>Nombre completo</label><input type="text" id="e-nombre"></div><div class="form-group"><label>Cédula</label><input type="text" id="e-cedula" inputmode="numeric"></div><div class="form-group"><label>Código (para marcar)</label><input type="text" id="e-codigo" inputmode="numeric" placeholder="Ej: 1234"></div></div><p class="text-xs text-gray mt-1">El empleado usará su cédula y este código en la pantalla de marcación de entrada/salida.</p></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-empleado')">Cancelar</button><button class="btn btn-gold" onclick="saveEmpleado()">Guardar</button></div></div></div>

  <div id="modal-marcacion" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:420px;"><div class="modal-header"><h3 id="modal-mc-title">${ic('i-clock')} Agregar Marcación</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-marcacion')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-mc-id"><div class="form-group"><label>Empleado</label><select id="mc-emp"></select></div><div class="form-grid-2"><div class="form-group"><label>Tipo</label><select id="mc-tipo"><option value="entrada">Entrada</option><option value="salida">Salida</option></select></div><div class="form-group"><label>Fecha y hora</label><input type="datetime-local" id="mc-fecha"></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-marcacion')">Cancelar</button><button class="btn btn-gold" onclick="saveMarcacion()">Guardar</button></div></div></div>

  <div id="modal-movimiento" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-money-out')} Gasto / Movimiento</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-movimiento')">${ic('i-close')}</button></div><div class="modal-body"><div class="form-group"><label>Tipo</label><select id="mov-tipo" onchange="toggleEmpleadoField()"><option value="nomina">Pago de Nómina / Empleado</option><option value="gasto">Gasto Menor</option><option value="salida">Salida</option><option value="entrada">Entrada</option></select></div><div class="form-group" id="mov-empleado-wrap"><label>Empleado</label><input type="text" id="mov-empleado" placeholder="Nombre del empleado"></div><div class="form-group"><label>Monto (COP)</label><input type="number" id="mov-monto" placeholder="0"></div><div class="form-group"><label>Descripción</label><input type="text" id="mov-desc" placeholder="Detalle del movimiento"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-movimiento')">Cancelar</button><button class="btn btn-gold" onclick="saveMovimiento()">Registrar</button></div></div></div>

  <div id="modal-retiro" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-money-out')} Retiro de Efectivo</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-retiro')">${ic('i-close')}</button></div><div class="modal-body"><p class="text-sm text-gray mb-2">Retiro oficial del efectivo (ej: los dueños retiran las ventas del día). No genera faltante: el sistema lo reconoce como salida autorizada.</p><div class="form-group"><label>Monto a retirar (COP)</label><input type="number" id="ret-monto" placeholder="0"></div><div class="form-group"><label>Motivo</label><input type="text" id="ret-motivo" placeholder="Ej: retiro ventas del día"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-retiro')">Cancelar</button><button class="btn btn-gold" onclick="saveRetiro()">${ic('i-check')} Registrar Retiro</button></div></div></div>

  <div id="modal-cliente" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-cli-title">${ic('i-delivery')} Nuevo Cliente</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-cliente')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-cli-id"><div class="form-grid-2"><div class="form-group"><label>Nombre</label><input type="text" id="c-nombre"></div><div class="form-group"><label>Teléfono</label><input type="text" id="c-tel"></div><div class="form-group" style="grid-column:1/-1"><label>Dirección</label><input type="text" id="c-dir"></div><div class="form-group"><label>Barrio</label><input type="text" id="c-barrio"></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-cliente')">Cancelar</button><button class="btn btn-gold" onclick="saveCliente()">Guardar</button></div></div></div>

  <div id="modal-usuario" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-usuario-title">${ic('i-users')} Nuevo Usuario</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-usuario')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-uid"><div class="form-grid-2"><div class="form-group"><label>Nombre</label><input type="text" id="u-nombre"></div><div class="form-group"><label>Usuario</label><input type="text" id="u-usuario"></div><div class="form-group"><label>Contraseña</label><input type="password" id="u-pass"></div><div class="form-group"><label>Rol</label><select id="u-rol"><option value="admin">Administrador</option><option value="supervisor">Supervisor</option><option value="cajero" selected>Cajero</option><option value="mesero">Mesero</option><option value="cocina">Cocina</option></select></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-usuario')">Cancelar</button><button class="btn btn-gold" onclick="saveUsuario()">Guardar</button></div></div></div>

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
  const pass=document.getElementById('lock-pass').value;
  if(STATE.user && pass===STATE.user.pass){ ocultarBloqueo(); }
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
    });
  });
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
