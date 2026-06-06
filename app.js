// ========================= PORTAL IMPERIAL POS =========================
const DB = {
  get(k){ try { return JSON.parse(localStorage.getItem('pi_'+k)); } catch(e){ return null; } },
  set(k,v){ localStorage.setItem('pi_'+k, JSON.stringify(v)); },
};
const ic = id => `<svg class="ic"><use href="#${id}"/></svg>`;
function now(){ return new Date().toISOString(); }
function fmtDate(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString('es-CO')+' '+d.toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'}); }
function fmtMoney(n){ return '$ '+(Math.round(n)||0).toLocaleString('es-CO'); }
function uid(){ return '_'+Math.random().toString(36).substr(2,9); }
function today(){ return new Date().toISOString().split('T')[0]; }
function escapeHtml(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function nextFactura(){ const n=(DB.get('factura_seq')||0)+1; DB.set('factura_seq',n); return 'PI-'+String(n).padStart(6,'0'); }

function toast(msg,type='info'){
  const el=document.createElement('div');
  el.className='toast '+type;
  const icon = type==='success'?'i-check':type==='error'?'i-warning':'i-bell';
  el.innerHTML = ic(icon)+'<span>'+escapeHtml(msg)+'</span>';
  document.getElementById('toast-container').appendChild(el);
  setTimeout(()=>el.remove(),3500);
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
  ]);
  if(!DB.get('productos')) DB.set('productos',[
    {id:'p1',nombre:'Arroz Especial',precio:18000,cat:'Arroces',activo:true},
    {id:'p2',nombre:'Chow Mein',precio:16000,cat:'Arroces',activo:true},
    {id:'p3',nombre:'Costilla BBQ',precio:28000,cat:'Carnes',activo:true},
    {id:'p4',nombre:'Pollo Agridulce',precio:22000,cat:'Carnes',activo:true},
    {id:'p5',nombre:'Camarones al Vapor',precio:32000,cat:'Mariscos',activo:true},
    {id:'p6',nombre:'Sopa Wonton',precio:14000,cat:'Sopas',activo:true},
    {id:'p7',nombre:'Té Chino',precio:5000,cat:'Bebidas',activo:true},
    {id:'p8',nombre:'Gaseosa',precio:4000,cat:'Bebidas',activo:true},
    {id:'p9',nombre:'Pato Laqueado',precio:45000,cat:'Especiales',activo:true},
    {id:'p10',nombre:'Rollos Primavera',precio:10000,cat:'Extras',activo:true},
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
  if(DB.get('caja_actual')===null && DB.get('caja_actual')!==false) { if(localStorage.getItem('pi_caja_actual')===null) DB.set('caja_actual',null); }
  if(!DB.get('factura_seq')) DB.set('factura_seq',0);
  if(!DB.get('config')) DB.set('config',{
    nombre:'Portal Imperial', nit:'900.123.456-7', dir:'Calle 10 #5-20', tel:'(7) 633 0000',
    numMesas:25, permitirEliminarDomicilio:true, permitirEliminarMesa:false, permitirEliminarLlevar:false
  });
}

// ========================= STATE =========================
const STATE = { user:null, page:'dashboard', order:[], descuento:0, descMot:'',
  tipoPedido:'mesa', mesa:'', cliNombre:'', cliTel:'', cliDir:'', cliBarrio:'', valorDom:0, orderObs:'', editandoVenta:null };

// ========================= AUTH =========================
function doLogin(){
  const u=document.getElementById('login-user').value.trim();
  const p=document.getElementById('login-pass').value;
  const user=(DB.get('usuarios')||[]).find(x=>x.usuario===u && x.pass===p && x.activo);
  if(!user){ const e=document.getElementById('login-error'); e.textContent='Usuario o contraseña incorrectos.'; e.style.display='block'; return; }
  STATE.user=user;
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  document.getElementById('user-name-sb').textContent=user.nombre;
  document.getElementById('user-role-sb').textContent=user.rol.charAt(0).toUpperCase()+user.rol.slice(1);
  document.getElementById('user-avatar-sb').textContent=user.nombre.charAt(0).toUpperCase();
  buildSidebar();
  logAudit('Inicio de sesión');
  showPage(user.rol==='cocina'?'cocina':'dashboard');
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

// ========================= SIDEBAR =========================
const NAV = [
  {sec:'Principal'},
  {id:'dashboard',icon:'i-dashboard',label:'Dashboard',roles:['admin','cajero','supervisor']},
  {id:'ventas',icon:'i-cart',label:'Nueva Venta',roles:['admin','cajero','supervisor']},
  {id:'pedidos',icon:'i-orders',label:'Pedidos',roles:['admin','cajero','supervisor'],badge:'activos'},
  {id:'listos',icon:'i-ready',label:'Pedidos Listos',roles:['admin','cajero','supervisor'],badge:'listos'},
  {sec:'Operaciones'},
  {id:'caja',icon:'i-cash',label:'Caja',roles:['admin','cajero','supervisor']},
  {id:'domicilios',icon:'i-delivery',label:'Domicilios',roles:['admin','cajero','supervisor']},
  {id:'cocina',icon:'i-chef',label:'Cocina',roles:['admin','cocina','supervisor'],badge:'cocina'},
  {sec:'Gestión'},
  {id:'usuarios',icon:'i-users',label:'Usuarios',roles:['admin']},
  {id:'historial',icon:'i-history',label:'Historial',roles:['admin','cajero','supervisor']},
  {id:'reportes',icon:'i-report',label:'Reportes',roles:['admin','supervisor']},
  {id:'auditoria',icon:'i-audit',label:'Auditoría',roles:['admin']},
  {id:'menu',icon:'i-menu-food',label:'Menú',roles:['admin','supervisor']},
  {id:'config',icon:'i-settings',label:'Configuración',roles:['admin','supervisor']},
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
    listos: vs.filter(v=>v.estadoCocina==='listo' && v.estadoPedido!=='entregado').length,
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
  reportes:['i-report','Reportes'], auditoria:['i-audit','Auditoría'], menu:['i-menu-food','Menú'], config:['i-settings','Configuración']
};
function showPage(name){
  STATE.page=name;
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
  document.getElementById('nav-'+name)?.classList.add('active');
  const m=PAGE_META[name]||['i-dashboard',name];
  document.getElementById('page-title').innerHTML=ic(m[0])+' '+m[1];
  document.getElementById('sidebar').classList.remove('open');
  const fns={dashboard,ventas,pedidos,listos,caja,domicilios,cocina,usuarios,historial,reportes,auditoria,menu,config};
  document.getElementById('content').innerHTML = fns[name] ? fns[name]() : '<p class="text-gray">Página no encontrada.</p>';
  if(name==='ventas'){ STATE.order=STATE.order||[]; renderTipoPedido(); renderOrderPanel(); }
  updateBadges();
}

// ========================= DASHBOARD =========================
function dashboard(){
  const vs=DB.get('ventas')||[]; const t=today();
  const hoy=vs.filter(v=>v.fecha?.startsWith(t)&&v.estado!=='anulada');
  const totalHoy=hoy.reduce((a,v)=>a+v.total,0);
  const weekAgo=new Date(Date.now()-7*864e5).toISOString().split('T')[0];
  const sem=vs.filter(v=>v.fecha>=weekAgo&&v.estado!=='anulada');
  const ma=new Date(); ma.setDate(1);
  const mes=vs.filter(v=>v.fecha>=ma.toISOString().split('T')[0]&&v.estado!=='anulada');
  const activos=vs.filter(v=>v.estadoPedido==='activo'&&v.estado!=='anulada').length;
  const entregados=vs.filter(v=>v.estadoPedido==='entregado').length;
  const metodos={efectivo:0,nequi:0,daviplata:0,tarjeta:0};
  hoy.forEach(v=>{ if(metodos[v.metodo]!==undefined) metodos[v.metodo]+=v.total; });
  const days=[];
  for(let i=6;i>=0;i--){ const d=new Date(Date.now()-i*864e5); const dk=d.toISOString().split('T')[0];
    days.push({lbl:d.toLocaleDateString('es-CO',{weekday:'short'}), tot:vs.filter(v=>v.fecha?.startsWith(dk)&&v.estado!=='anulada').reduce((a,v)=>a+v.total,0)}); }
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
      ${Object.entries({efectivo:'Efectivo',nequi:'Nequi',daviplata:'Daviplata',tarjeta:'Tarjeta'}).map(([k,l])=>`<div class="flex-between" style="padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.04)"><span class="text-sm">${l}</span><span class="text-gold font-bold">${fmtMoney(metodos[k])}</span></div>`).join('')}
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
  if(v.tipo==='domicilio') return v.domiciliario?escapeHtml(v.domiciliario):(v.cliNombre?escapeHtml(v.cliNombre):'Domicilio');
  return v.factura||'—';
}
function estadoBadge(e){ return e==='anulada'?`<span class="badge badge-red">Anulada</span>`:e==='pagada'?`<span class="badge badge-green">Pagada</span>`:`<span class="badge badge-gold">${e||'activa'}</span>`; }

// ========================= VENTAS (POS) =========================
function ventas(){
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
    html=`<input type="text" class="mini-input" style="margin-bottom:6px;" placeholder="Nombre del cliente *" value="${escapeHtml(STATE.cliNombre)}" oninput="STATE.cliNombre=this.value">
    <input type="text" class="mini-input" style="margin-bottom:8px;" placeholder="Teléfono (opcional)" value="${escapeHtml(STATE.cliTel)}" oninput="STATE.cliTel=this.value">`;
  } else if(STATE.tipoPedido==='domicilio'){
    html=`<input type="text" class="mini-input" list="clientes-list" style="margin-bottom:6px;" placeholder="Nombre del cliente *" value="${escapeHtml(STATE.cliNombre)}" oninput="STATE.cliNombre=this.value;autoFillCliente(this.value)">
    <input type="text" class="mini-input" style="margin-bottom:6px;" placeholder="Teléfono *" value="${escapeHtml(STATE.cliTel)}" oninput="STATE.cliTel=this.value">
    <input type="text" class="mini-input" style="margin-bottom:6px;" placeholder="Dirección *" value="${escapeHtml(STATE.cliDir)}" oninput="STATE.cliDir=this.value">
    <input type="text" class="mini-input" style="margin-bottom:6px;" placeholder="Barrio" value="${escapeHtml(STATE.cliBarrio)}" oninput="STATE.cliBarrio=this.value">
    <input type="number" class="mini-input" style="margin-bottom:8px;" placeholder="Valor domicilio *" value="${STATE.valorDom||''}" oninput="STATE.valorDom=parseFloat(this.value)||0;renderOrderPanel()">`;
  }
  c.innerHTML=html;
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
function clearOrder(){ STATE.order=[]; STATE.descuento=0; STATE.descMot=''; STATE.cliNombre=''; STATE.cliTel=''; STATE.cliDir=''; STATE.cliBarrio=''; STATE.valorDom=0; STATE.mesa=''; STATE.orderObs=''; STATE.editandoVenta=null;
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
    <div class="flex-between mt-1" style="font-size:17px;font-weight:700;"><span>Total</span><span class="text-gold">${fmtMoney(total)}</span></div>
    <div class="flex-between mt-1 gap-2" style="flex-wrap:wrap;">
      <button class="btn btn-ghost btn-sm" onclick="openModal('modal-descuento')">${ic('i-tag')} Descuento</button>
      <select id="pay-method" class="mini-input" style="flex:1;min-width:110px;width:auto;"><option value="efectivo">Efectivo</option><option value="nequi">Nequi</option><option value="daviplata">Daviplata</option><option value="tarjeta">Tarjeta</option></select>
    </div>
    <button class="btn btn-gold btn-block mt-1" onclick="cobrarVenta()" style="font-size:14px;padding:12px;">${ic('i-check')} ${STATE.editandoVenta?'Guardar Cambios':'Cobrar '+fmtMoney(total)}</button>`;
}
function applyDescuento(){
  const tipo=document.getElementById('desc-tipo').value, val=parseFloat(document.getElementById('desc-valor').value)||0;
  const sub=STATE.order.reduce((a,i)=>a+i.precio*i.qty,0);
  STATE.descuento=tipo==='pct'?sub*(val/100):val; STATE.descMot=document.getElementById('desc-motivo').value;
  closeModal('modal-descuento'); renderOrderPanel(); toast('Descuento aplicado','success');
}

function cobrarVenta(){
  if(STATE.order.length===0){ toast('Agregue productos primero','error'); return; }
  if(STATE.tipoPedido==='domicilio' && (!STATE.cliNombre||!STATE.cliTel||!STATE.cliDir)){ toast('Domicilio requiere nombre, teléfono y dirección','error'); return; }
  if(STATE.tipoPedido==='llevar' && !STATE.cliNombre){ toast('Indique el nombre del cliente','error'); return; }
  if(STATE.tipoPedido==='mesa' && !STATE.mesa){ toast('Seleccione una mesa','error'); return; }
  const metodo=document.getElementById('pay-method')?.value||'efectivo';
  const subtotal=STATE.order.reduce((a,i)=>a+i.precio*i.qty,0);
  const dom=STATE.tipoPedido==='domicilio'?(STATE.valorDom||0):0;
  const total=Math.max(0,subtotal+dom-(STATE.descuento||0));
  const vs=DB.get('ventas')||[];

  if(STATE.editandoVenta){
    const v=vs.find(x=>x.id===STATE.editandoVenta.id);
    if(v){ v.items=[...STATE.order]; v.subtotal=subtotal; v.valorDom=dom; v.descuento=STATE.descuento||0; v.total=total; v.metodo=metodo; v.obs=STATE.orderObs;
      v.modificadoPor=STATE.user.nombre; v.modificadoEn=now(); DB.set('ventas',vs);
      logAudit('Editó pedido',`${v.factura} por ${STATE.user.nombre}`); toast('Pedido actualizado','success'); }
    clearOrder(); showPage('pedidos'); return;
  }

  const esDomicilio = STATE.tipoPedido==='domicilio';
  const factura = esDomicilio ? '' : nextFactura();
  const venta={ id:uid(),factura,fecha:now(),tipo:STATE.tipoPedido,
    mesa:STATE.tipoPedido==='mesa'?STATE.mesa:'', cliNombre:STATE.cliNombre,cliTel:STATE.cliTel,cliDir:STATE.cliDir,cliBarrio:STATE.cliBarrio,
    valorDom:dom, items:[...STATE.order], subtotal, descuento:STATE.descuento||0, descMot:STATE.descMot,
    total, metodo, estado:'pagada', estadoPedido:'activo', estadoCocina:'pendiente', domiciliario:'',
    obs:STATE.orderObs, cajero:STATE.user?.nombre, cajaId:DB.get('caja_actual')?.id||null };
  vs.unshift(venta); DB.set('ventas',vs);

  // guardar cliente domicilio
  if(STATE.tipoPedido==='domicilio'){
    const cls=DB.get('clientes')||[]; const ex=cls.find(c=>c.tel===STATE.cliTel);
    if(ex){ ex.pedidos=(ex.pedidos||0)+1; } else cls.unshift({id:uid(),nombre:STATE.cliNombre,tel:STATE.cliTel,dir:STATE.cliDir,barrio:STATE.cliBarrio,pedidos:1,creado:now()});
    DB.set('clientes',cls);
  }
  logAudit('Creó venta',`${factura} - ${fmtMoney(total)}`);
  notifyKitchen();
  clearOrder();
  toast(esDomicilio?'Domicilio registrado':`Venta registrada: ${factura}`,'success');
  printTicketCocina(venta);
  setTimeout(()=>printFactura(venta),400);
}

// ========================= IMPRESIÓN =========================
function printFactura(v){
  const cfg=DB.get('config')||{}; const pa=document.getElementById('print-area');
  const esDom = v.tipo==='domicilio';
  pa.innerHTML=`<div style="text-align:center;"><strong style="font-size:15px;">${escapeHtml(cfg.nombre||'Portal Imperial')}</strong><br>NIT: ${cfg.nit||''}<br>${escapeHtml(cfg.dir||'')} - Tel: ${cfg.tel||''}<hr style="border:1px dashed #000;margin:6px 0;">${esDom?'<strong>DOMICILIO</strong>':'<strong>FACTURA '+v.factura+'</strong>'}<br>${fmtDate(v.fecha)}<br>${tipoLabel(v.tipo)}${v.mesa?' - '+v.mesa:''}${v.cliNombre?'<br>Cliente: '+escapeHtml(v.cliNombre):''}${esDom&&v.domiciliario?'<br>Mensajero: '+escapeHtml(v.domiciliario):''}<br>Cajero: ${escapeHtml(v.cajero||'')}<hr style="border:1px dashed #000;margin:6px 0;"></div>
  ${v.items.map(i=>`<div style="display:flex;justify-content:space-between;"><span>${i.qty}x ${escapeHtml(i.nombre)}</span><span>${fmtMoney(i.precio*i.qty)}</span></div>`).join('')}
  <hr style="border:1px dashed #000;margin:6px 0;">
  ${v.valorDom>0?`<div style="display:flex;justify-content:space-between;"><span>Domicilio</span><span>${fmtMoney(v.valorDom)}</span></div>`:''}
  ${v.descuento>0?`<div style="display:flex;justify-content:space-between;"><span>Descuento</span><span>-${fmtMoney(v.descuento)}</span></div>`:''}
  <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:15px;"><span>TOTAL</span><span>${fmtMoney(v.total)}</span></div>
  <div style="text-align:center;margin-top:8px;font-size:11px;">Método: ${v.metodo}<br>¡Gracias por su visita!</div>`;
  pa.style.display='block'; window.print(); pa.style.display='none';
}
function printTicketCocina(v){
  const pa=document.getElementById('print-area');
  const esDom = v.tipo==='domicilio';
  pa.innerHTML=`<div style="text-align:center;"><strong style="font-size:16px;">COCINA</strong><br>${esDom?'<strong>DOMICILIO</strong>':'<strong>'+v.factura+'</strong>'}<br>${tipoLabel(v.tipo)}${v.mesa?' - '+v.mesa:''}${esDom&&v.cliNombre?'<br>'+escapeHtml(v.cliNombre):''}<br>${fmtDate(v.fecha)}<hr style="border:1px dashed #000;margin:6px 0;"></div>
  ${v.items.map(i=>`<div style="font-size:14px;margin-bottom:4px;"><strong>${i.qty}x ${escapeHtml(i.nombre)}</strong>${i.obs?`<br><span style="font-size:12px;">>> ${escapeHtml(i.obs)}</span>`:''}</div>`).join('')}
  ${v.obs?`<hr style="border:1px dashed #000;margin:6px 0;"><div style="font-size:12px;">Nota: ${escapeHtml(v.obs)}</div>`:''}`;
  // No imprime automáticamente, queda disponible vía botón. (Evita doble diálogo)
}

// ========================= NOTIFICACIÓN COCINA (SONIDO) =========================
function beep(freq=800,dur=200){
  try{ const ctx=new (window.AudioContext||window.webkitAudioContext)(); const o=ctx.createOscillator(),g=ctx.createGain();
  o.connect(g); g.connect(ctx.destination); o.frequency.value=freq; o.type='sine'; g.gain.setValueAtTime(0.3,ctx.currentTime);
  o.start(); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+dur/1000); o.stop(ctx.currentTime+dur/1000);}catch(e){}
}
function notifyKitchen(){ beep(800,150); setTimeout(()=>beep(600,200),180); }

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
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Pedido / Mensajero</th><th>Tipo</th><th>Cliente/Mesa</th><th>Total</th><th>Cocina</th><th>Pedido</th><th>Domiciliario</th><th>Acciones</th></tr></thead><tbody>
  ${list.map(v=>{
    const editable = isAdmin || (v.estadoCocina!=='entregado' && v.estadoPedido!=='entregado');
    return `<tr>
    <td><span class="text-gold font-bold">${refPedido(v)}</span>${v.modificadoPor?`<br><span class="text-xs text-gray">editado: ${escapeHtml(v.modificadoPor)}</span>`:''}</td>
    <td>${tipoLabel(v.tipo)}</td>
    <td>${escapeHtml(v.cliNombre||v.mesa||'—')}${v.cliTel?`<br><span class="text-xs text-gray">${escapeHtml(v.cliTel)}</span>`:''}</td>
    <td class="font-bold">${fmtMoney(v.total)}</td>
    <td>${cocinaBadge(v.estadoCocina)}</td>
    <td><select onchange="setEstadoPedido('${v.id}',this.value)" class="mini-input" style="width:auto;padding:4px 8px;"><option value="activo" ${v.estadoPedido==='activo'?'selected':''}>Activo</option><option value="entregado" ${v.estadoPedido==='entregado'?'selected':''}>Entregado</option></select></td>
    <td>${v.tipo==='domicilio'?domiciliarioSelect(v):'—'}</td>
    <td style="display:flex;gap:5px;flex-wrap:wrap;">
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
    <div class="flex-between mb-2"><span class="text-gold font-bold" style="font-size:16px;">${refPedido(v)}</span><span class="badge badge-green">${ic('i-check')} Listo</span></div>
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
    const min=Math.floor((Date.now()-new Date(v.fecha))/60000);
    const t=min<15?'verde':min<25?'amarillo':'rojo';
    return `<div class="kds-card t-${t}">
      <div class="flex-between mb-2"><span class="text-gold font-bold" style="font-size:16px;">${refPedido(v)}</span>
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
  if(v){ v.estadoCocina=e; if(e==='entregado') v.estadoPedido='entregado'; DB.set('ventas',vs);
    if(e==='listo'){ beep(900,300); toast(`${v.factura} listo para entregar`,'success'); } logAudit('Cocina: '+e,v.factura); }
  showPage(STATE.page); updateBadges();
}

// ========================= CAJA =========================
function caja(){
  const c=DB.get('caja_actual'); const cierres=DB.get('cierres')||[];
  if(!c){
    return `<div class="card" style="max-width:480px;margin:0 auto;text-align:center;padding:36px;">
      <div style="font-size:48px;color:var(--gold);margin-bottom:12px;">${ic('i-cash')}</div>
      <h2 style="font-family:Cinzel,serif;color:var(--gold);margin-bottom:10px;">Caja Cerrada</h2>
      <p class="text-gray mb-2">Abra la caja para comenzar a operar.</p>
      <button class="btn btn-gold" onclick="openModal('modal-caja')" style="padding:13px 30px;">${ic('i-lock')} Abrir Caja</button></div>
      ${cierres.length>0?`<div class="card mt-2"><div class="card-title">${ic('i-history')} Historial de Cierres</div><div class="table-wrap"><table class="data-table"><thead><tr><th>Cajero</th><th>Fondo</th><th>Efectivo</th><th>Nequi</th><th>Daviplata</th><th>Tarjeta</th><th>Gastos</th><th>Total Ventas</th><th>Cierre</th></tr></thead><tbody>${cierres.slice(0,10).map(c=>`<tr><td>${escapeHtml(c.cajero)}</td><td>${fmtMoney(c.fondo)}</td><td>${fmtMoney(c.efectivo)}</td><td>${fmtMoney(c.nequi)}</td><td>${fmtMoney(c.daviplata)}</td><td>${fmtMoney(c.tarjeta)}</td><td class="text-red">${fmtMoney(c.gastos||0)}</td><td class="font-bold text-gold">${fmtMoney(c.total)}</td><td class="text-xs text-gray">${fmtDate(c.cierre)}</td></tr>`).join('')}</tbody></table></div></div>`:''}`;
  }
  const movs=c.movimientos||[];
  const vs=(DB.get('ventas')||[]).filter(v=>v.estado!=='anulada'&&v.cajaId===c.id);
  const ef=vs.filter(v=>v.metodo==='efectivo').reduce((a,v)=>a+v.total,0);
  const nq=vs.filter(v=>v.metodo==='nequi').reduce((a,v)=>a+v.total,0);
  const dp=vs.filter(v=>v.metodo==='daviplata').reduce((a,v)=>a+v.total,0);
  const tc=vs.filter(v=>v.metodo==='tarjeta').reduce((a,v)=>a+v.total,0);
  const totalV=ef+nq+dp+tc;
  const entradas=movs.filter(m=>m.tipo==='entrada').reduce((a,m)=>a+m.monto,0);
  const gastos=movs.filter(m=>m.tipo==='salida'||m.tipo==='gasto'||m.tipo==='nomina').reduce((a,m)=>a+m.monto,0);
  const enCaja=c.fondo+ef+entradas-gastos;
  return `<div class="stats-grid">
    <div class="stat-card green"><div class="stat-icon">${ic('i-cash')}</div><div class="stat-label">Efectivo</div><div class="stat-value">${fmtMoney(ef)}</div></div>
    <div class="stat-card blue"><div class="stat-icon">${ic('i-phone')}</div><div class="stat-label">Nequi</div><div class="stat-value">${fmtMoney(nq)}</div></div>
    <div class="stat-card gold"><div class="stat-icon">${ic('i-phone')}</div><div class="stat-label">Daviplata</div><div class="stat-value">${fmtMoney(dp)}</div></div>
    <div class="stat-card red"><div class="stat-icon">${ic('i-cash')}</div><div class="stat-label">Tarjeta</div><div class="stat-value">${fmtMoney(tc)}</div></div>
  </div>
  <div class="grid-2">
    <div class="card"><div class="card-title">${ic('i-cash')} Resumen de Caja — ${escapeHtml(c.cajero)}</div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Apertura</span><span class="text-sm">${fmtDate(c.apertura)}</span></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Fondo Inicial</span><strong>${fmtMoney(c.fondo)}</strong></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Total Ventas</span><strong class="text-gold">${fmtMoney(totalV)}</strong></div>
      <div class="flex-between" style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span>Entradas Extra</span><strong class="text-green">${fmtMoney(entradas)}</strong></div>
      <div class="flex-between" style="padding:7px 0;"><span>Gastos / Nómina / Salidas</span><strong class="text-red">-${fmtMoney(gastos)}</strong></div>
      <hr class="divider">
      <div class="flex-between" style="font-size:18px;font-weight:700;"><span>Efectivo en Caja</span><span class="text-gold">${fmtMoney(enCaja)}</span></div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="btn btn-ghost" onclick="openModal('modal-movimiento')">${ic('i-money-out')} Gasto / Movimiento</button>
        <button class="btn btn-danger" onclick="cerrarCaja()" style="flex:1;">${ic('i-lock')} Cerrar Caja</button>
      </div></div>
    <div class="card"><div class="card-title">${ic('i-orders')} Movimientos del Día</div>
      ${movs.length===0?`<p class="text-gray text-sm">Sin gastos ni movimientos registrados</p>`:
      `<div class="table-wrap"><table class="data-table"><thead><tr><th>Tipo</th><th>Descripción</th><th>Monto</th><th>Hora</th></tr></thead><tbody>${movs.slice().reverse().map(m=>`<tr><td>${movBadge(m.tipo)}</td><td>${escapeHtml(m.desc)}${m.empleado?'<br><span class="text-xs text-gray">'+escapeHtml(m.empleado)+'</span>':''}</td><td class="${m.tipo==='entrada'?'text-green':'text-red'}">${m.tipo==='entrada'?'+':'-'}${fmtMoney(m.monto)}</td><td class="text-xs text-gray">${fmtDate(m.fecha)}</td></tr>`).join('')}</tbody></table></div>`}
    </div></div>`;
}
function movBadge(t){ const m={entrada:['badge-green','Entrada'],salida:['badge-red','Salida'],gasto:['badge-orange','Gasto'],nomina:['badge-red','Nómina']}; const x=m[t]||['badge-gray',t]; return `<span class="badge ${x[0]}">${x[1]}</span>`; }
function abrirCaja(){
  const fondo=parseFloat(document.getElementById('caja-fondo').value)||0;
  DB.set('caja_actual',{id:uid(),cajero:STATE.user.nombre,apertura:now(),fondo,movimientos:[]});
  logAudit('Abrió caja',`Fondo: ${fmtMoney(fondo)}`); closeModal('modal-caja'); toast('Caja abierta','success'); showPage('caja');
}
function saveMovimiento(){
  const tipo=document.getElementById('mov-tipo').value;
  const monto=parseFloat(document.getElementById('mov-monto').value)||0;
  const desc=document.getElementById('mov-desc').value;
  const empleado=document.getElementById('mov-empleado').value;
  if(monto<=0){ toast('Ingrese un monto válido','error'); return; }
  const c=DB.get('caja_actual'); if(!c) return;
  c.movimientos.push({tipo,monto,desc:desc||(tipo==='nomina'?'Pago de nómina':tipo),empleado,fecha:now()});
  DB.set('caja_actual',c);
  logAudit('Registró '+tipo,`${fmtMoney(monto)} - ${desc} ${empleado?'('+empleado+')':''}`);
  closeModal('modal-movimiento'); toast('Movimiento registrado','success'); showPage('caja');
}
function toggleEmpleadoField(){
  const t=document.getElementById('mov-tipo').value;
  document.getElementById('mov-empleado-wrap').style.display = t==='nomina'?'block':'none';
}
function cerrarCaja(){
  if(!confirm('¿Cerrar la caja? Se generará el reporte de cierre del empleado.')) return;
  const c=DB.get('caja_actual');
  const vs=(DB.get('ventas')||[]).filter(v=>v.estado!=='anulada'&&v.cajaId===c.id);
  const ef=vs.filter(v=>v.metodo==='efectivo').reduce((a,v)=>a+v.total,0);
  const nq=vs.filter(v=>v.metodo==='nequi').reduce((a,v)=>a+v.total,0);
  const dp=vs.filter(v=>v.metodo==='daviplata').reduce((a,v)=>a+v.total,0);
  const tc=vs.filter(v=>v.metodo==='tarjeta').reduce((a,v)=>a+v.total,0);
  const gastos=(c.movimientos||[]).filter(m=>m.tipo!=='entrada').reduce((a,m)=>a+m.monto,0);
  const cierre={...c,cierre:now(),efectivo:ef,nequi:nq,daviplata:dp,tarjeta:tc,gastos,total:ef+nq+dp+tc};
  const cs=DB.get('cierres')||[]; cs.unshift(cierre); DB.set('cierres',cs); DB.set('caja_actual',null);
  logAudit('Cerró caja',`${c.cajero} - Total: ${fmtMoney(cierre.total)}`);
  toast('Caja cerrada','success'); showPage('caja');
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
  const hoy=vs.filter(v=>v.fecha?.startsWith(t)&&v.estado!=='anulada'); const totalHoy=hoy.reduce((a,v)=>a+v.total,0);
  const weekly=[]; for(let i=6;i>=0;i--){ const d=new Date(Date.now()-i*864e5); const dk=d.toISOString().split('T')[0];
    const p=vs.filter(v=>v.fecha?.startsWith(dk)&&v.estado!=='anulada'); weekly.push({lbl:d.toLocaleDateString('es-CO',{weekday:'short'}),total:p.reduce((a,v)=>a+v.total,0)}); }
  const monthly=[]; for(let i=11;i>=0;i--){ const d=new Date(); d.setMonth(d.getMonth()-i); d.setDate(1); const mk=d.toISOString().substring(0,7);
    const p=vs.filter(v=>v.fecha?.startsWith(mk)&&v.estado!=='anulada'); monthly.push({lbl:d.toLocaleDateString('es-CO',{month:'short'}),total:p.reduce((a,v)=>a+v.total,0)}); }
  const mw=Math.max(...weekly.map(d=>d.total),1), mm=Math.max(...monthly.map(d=>d.total),1);
  const items={}; hoy.forEach(v=>v.items?.forEach(i=>{ if(!items[i.nombre])items[i.nombre]={qty:0,total:0}; items[i.nombre].qty+=i.qty; items[i.nombre].total+=i.precio*i.qty; }));
  const top=Object.entries(items).sort((a,b)=>b[1].qty-a[1].qty).slice(0,10);
  return `<div class="grid-2">
    <div class="card"><div class="card-title">${ic('i-report')} Ventas por Día (7 días)</div><div class="bar-chart" style="height:140px;">${weekly.map(d=>`<div class="bar-item"><div class="bar-val">${d.total>0?(d.total/1000).toFixed(0)+'k':''}</div><div class="bar-fill" style="height:${Math.max(4,(d.total/mw)*110)}px"></div><div class="bar-label">${d.lbl}</div></div>`).join('')}</div></div>
    <div class="card"><div class="card-title">${ic('i-report')} Ventas Mensuales (12 meses)</div><div class="bar-chart" style="height:140px;">${monthly.map(d=>`<div class="bar-item"><div class="bar-val">${d.total>0?(d.total/1000).toFixed(0)+'k':''}</div><div class="bar-fill" style="height:${Math.max(4,(d.total/mm)*110)}px"></div><div class="bar-label">${d.lbl}</div></div>`).join('')}</div></div>
  </div>
  <div class="card"><div class="card-title">${ic('i-cash')} Resumen del Día</div><div class="stats-grid">
    <div class="stat-card green"><div class="stat-label">Total Ventas</div><div class="stat-value">${fmtMoney(totalHoy)}</div><div class="stat-sub">${hoy.length} transacciones</div></div>
    <div class="stat-card red"><div class="stat-label">Ticket Promedio</div><div class="stat-value">${fmtMoney(hoy.length?Math.round(totalHoy/hoy.length):0)}</div></div>
  </div></div>
  <div class="card"><div class="card-title">${ic('i-menu-food')} Productos Más Vendidos (Hoy)</div>
    ${top.length===0?`<p class="text-gray text-sm">Sin datos</p>`:`<div class="table-wrap"><table class="data-table"><thead><tr><th>Producto</th><th>Unidades</th><th>Total</th></tr></thead><tbody>${top.map(([n,d])=>`<tr><td>${escapeHtml(n)}</td><td><strong>${d.qty}</strong></td><td class="text-gold">${fmtMoney(d.total)}</td></tr>`).join('')}</tbody></table></div>`}
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
  ['p-nombre','p-precio','p-desc'].forEach(i=>document.getElementById(i).value=''); document.getElementById('edit-prod-id').value=''; document.getElementById('p-cat').value='Arroces';
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
  const c=DB.get('config')||{}; const ds=DB.get('domiciliarios')||[];
  return `<div class="grid-2">
    <div class="card"><div class="card-title">${ic('i-settings')} Datos del Negocio</div>
      <div class="form-group"><label>Nombre</label><input type="text" id="cfg-nombre" value="${escapeHtml(c.nombre||'')}"></div>
      <div class="form-grid-2"><div class="form-group"><label>NIT</label><input type="text" id="cfg-nit" value="${escapeHtml(c.nit||'')}"></div><div class="form-group"><label>Teléfono</label><input type="text" id="cfg-tel" value="${escapeHtml(c.tel||'')}"></div></div>
      <div class="form-group"><label>Dirección</label><input type="text" id="cfg-dir" value="${escapeHtml(c.dir||'')}"></div>
      <div class="form-group"><label>Cantidad de Mesas</label><input type="number" id="cfg-mesas" value="${c.numMesas||25}" min="1" max="200"></div>
      <button class="btn btn-gold" onclick="saveConfig()">${ic('i-check')} Guardar</button>
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
    </div></div>`;
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

// ========================= MODALS HTML =========================
function buildModals(){
  document.getElementById('modals').innerHTML=`
  <div id="modal-recovery" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-lock')} Recuperar Contraseña</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-recovery')">${ic('i-close')}</button></div><div class="modal-body"><p class="text-sm text-gray mb-2">Solicite al administrador el código de recuperación.</p><div class="form-group"><label>Código de recuperación</label><input type="text" id="rec-code" placeholder="4 dígitos" maxlength="4"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-recovery')">Cancelar</button><button class="btn btn-gold" onclick="doRecovery()">Continuar</button></div></div></div>

  <div id="modal-descuento" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:350px;"><div class="modal-header"><h3>${ic('i-tag')} Aplicar Descuento</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-descuento')">${ic('i-close')}</button></div><div class="modal-body"><div class="form-group"><label>Tipo</label><select id="desc-tipo"><option value="pct">Porcentaje (%)</option><option value="fijo">Valor fijo (COP)</option></select></div><div class="form-group"><label>Valor</label><input type="number" id="desc-valor" placeholder="0" min="0"></div><div class="form-group"><label>Motivo</label><input type="text" id="desc-motivo" placeholder="Razón"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-descuento')">Cancelar</button><button class="btn btn-gold" onclick="applyDescuento()">Aplicar</button></div></div></div>

  <div id="modal-caja" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-cash')} Apertura de Caja</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-caja')">${ic('i-close')}</button></div><div class="modal-body"><div class="form-group"><label>Fondo Inicial (COP)</label><input type="number" id="caja-fondo" value="100000"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-caja')">Cancelar</button><button class="btn btn-gold" onclick="abrirCaja()">Abrir Caja</button></div></div></div>

  <div id="modal-movimiento" style="display:none;" class="modal-overlay"><div class="modal" style="max-width:400px;"><div class="modal-header"><h3>${ic('i-money-out')} Gasto / Movimiento</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-movimiento')">${ic('i-close')}</button></div><div class="modal-body"><div class="form-group"><label>Tipo</label><select id="mov-tipo" onchange="toggleEmpleadoField()"><option value="nomina">Pago de Nómina / Empleado</option><option value="gasto">Gasto Menor</option><option value="salida">Salida</option><option value="entrada">Entrada</option></select></div><div class="form-group" id="mov-empleado-wrap"><label>Empleado</label><input type="text" id="mov-empleado" placeholder="Nombre del empleado"></div><div class="form-group"><label>Monto (COP)</label><input type="number" id="mov-monto" placeholder="0"></div><div class="form-group"><label>Descripción</label><input type="text" id="mov-desc" placeholder="Detalle del movimiento"></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-movimiento')">Cancelar</button><button class="btn btn-gold" onclick="saveMovimiento()">Registrar</button></div></div></div>

  <div id="modal-cliente" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-cli-title">${ic('i-delivery')} Nuevo Cliente</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-cliente')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-cli-id"><div class="form-grid-2"><div class="form-group"><label>Nombre</label><input type="text" id="c-nombre"></div><div class="form-group"><label>Teléfono</label><input type="text" id="c-tel"></div><div class="form-group" style="grid-column:1/-1"><label>Dirección</label><input type="text" id="c-dir"></div><div class="form-group"><label>Barrio</label><input type="text" id="c-barrio"></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-cliente')">Cancelar</button><button class="btn btn-gold" onclick="saveCliente()">Guardar</button></div></div></div>

  <div id="modal-usuario" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-usuario-title">${ic('i-users')} Nuevo Usuario</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-usuario')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-uid"><div class="form-grid-2"><div class="form-group"><label>Nombre</label><input type="text" id="u-nombre"></div><div class="form-group"><label>Usuario</label><input type="text" id="u-usuario"></div><div class="form-group"><label>Contraseña</label><input type="password" id="u-pass"></div><div class="form-group"><label>Rol</label><select id="u-rol"><option value="admin">Administrador</option><option value="cajero" selected>Cajero</option><option value="supervisor">Supervisor</option><option value="cocina">Cocina</option></select></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-usuario')">Cancelar</button><button class="btn btn-gold" onclick="saveUsuario()">Guardar</button></div></div></div>

  <div id="modal-producto" style="display:none;" class="modal-overlay"><div class="modal"><div class="modal-header"><h3 id="modal-prod-title">${ic('i-menu-food')} Nuevo Producto</h3><button class="btn btn-icon btn-ghost" onclick="closeModal('modal-producto')">${ic('i-close')}</button></div><div class="modal-body"><input type="hidden" id="edit-prod-id"><div class="form-grid-2"><div class="form-group"><label>Nombre</label><input type="text" id="p-nombre"></div><div class="form-group"><label>Precio (COP)</label><input type="number" id="p-precio"></div><div class="form-group"><label>Categoría</label><select id="p-cat"><option>Arroces</option><option>Carnes</option><option>Mariscos</option><option>Sopas</option><option>Bebidas</option><option>Especiales</option><option>Extras</option></select></div><div class="form-group" style="grid-column:1/-1"><label>Descripción</label><input type="text" id="p-desc"></div></div></div><div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal('modal-producto')">Cancelar</button><button class="btn btn-gold" onclick="saveProducto()">Guardar</button></div></div></div>`;
}

// ========================= CLOCK / TIMERS =========================
function updateClock(){ const el=document.getElementById('time-display'); if(el) el.textContent=new Date().toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
setInterval(updateClock,1000);
setInterval(()=>{ if(STATE.page==='cocina'||STATE.page==='listos'){ showPage(STATE.page); } updateBadges(); },15000);
let lastAct=Date.now();
document.addEventListener('mousemove',()=>lastAct=Date.now());
document.addEventListener('keydown',()=>lastAct=Date.now());
document.addEventListener('touchstart',()=>lastAct=Date.now());
setInterval(()=>{ if(STATE.user && Date.now()-lastAct>30*60*1000){ toast('Sesión cerrada por inactividad'); doLogout(); }},60000);

// ========================= BOOT =========================
initData();
buildModals();
updateClock();
document.getElementById('login-pass').addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });
document.getElementById('login-user').addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('login-pass').focus(); });
