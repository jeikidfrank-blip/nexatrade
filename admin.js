(() => {
  const cfg = window.NEXATRADE_CONFIG || window.SUPABASE_CONFIG || {};
  const url = cfg.url || cfg.supabaseUrl || window.SUPABASE_URL;
  const key = cfg.anonKey || cfg.publishableKey || cfg.supabaseKey || window.SUPABASE_ANON_KEY;
  const client = url && key && window.supabase ? window.supabase.createClient(url,key) : null;
  const $ = id => document.getElementById(id);
  let users = [];
  const showError = (id,msg) => { const el=$(id); el.textContent=msg; el.hidden=!msg; };
  const toast = msg => { const el=$('toast'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2800); };
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => value ? new Date(value).toLocaleDateString() : '—';
  function renderRows(target,list) {
    if(!list.length){$(target).innerHTML='<p class="empty">No users found.</p>';return;}
    $(target).innerHTML='<table><thead><tr><th>User</th><th>Account</th><th>Status</th><th>Joined</th><th>Manage</th></tr></thead><tbody>'+list.map(u=>{
      const status=u.status||'active', type=u.account_type||'standard';
      return '<tr><td><strong>'+esc(u.full_name||'Unnamed user')+'</strong><small>'+esc(u.email)+'</small></td><td><span class="pill">'+esc(type.toUpperCase())+'</span></td><td><span class="pill '+esc(status)+'">'+esc(status)+'</span></td><td>'+date(u.created_at)+'</td><td><select class="action-select" data-user="'+esc(u.id)+'"><option value="">Actions…</option><option value="vip">Upgrade to VIP</option><option value="standard">Set Standard</option><option value="suspended">Suspend</option><option value="blocked">Block</option><option value="active">Reactivate</option><option value="view">View profile</option></select></td></tr>';
    }).join('')+'</tbody></table>';
    $(target).querySelectorAll('select[data-user]').forEach(el=>el.addEventListener('change',()=>{const action=el.value;el.value='';if(action)manageUser(el.dataset.user,action)}));
  }
  async function rpc(name,args={}) { const {data,error}=await client.rpc(name,args);if(error)throw error;return data; }
  async function loadUsers(){
    try{
      const data=await rpc('admin_list_users');
      users=Array.isArray(data)?data:(data?.users||[]);
      $('stat-users').textContent=users.length;
      $('stat-standard').textContent=users.filter(u=>(u.account_type||'standard')==='standard').length;
      $('stat-vip').textContent=users.filter(u=>u.account_type==='vip').length;
      $('stat-restricted').textContent=users.filter(u=>['blocked','suspended'].includes(u.status)).length;
      renderRows('users-table',users);
      renderRows('recent-users',[...users].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,6));
      filterUsers();
    }catch(e){$('users-table').innerHTML='<p class="empty">Could not load users: '+esc(e.message)+'. Run the admin database setup SQL first.</p>';$('recent-users').innerHTML='<p class="empty">Admin database setup is required.</p>';}
  }
  function filterUsers(){
    const q=$('user-search').value.toLowerCase(), f=$('user-filter').value;
    renderRows('users-table',users.filter(u=>{
      const hay=[u.full_name,u.email,u.id].join(' ').toLowerCase();
      return (!q||hay.includes(q))&&(f==='all'||(f==='suspended'||f==='blocked'?u.status===f:u.account_type===f));
    }));
  }
  async function manageUser(id,action){
    const user=users.find(u=>u.id===id);if(!user)return;
    if(action==='view'){alert('Name: '+(user.full_name||'—')+'\nEmail: '+(user.email||'—')+'\nUser ID: '+id+'\nAccount: '+(user.account_type||'standard')+'\nStatus: '+(user.status||'active'));return;}
    const label=({vip:'upgrade this user to VIP',standard:'set this user to Standard',suspended:'suspend this user',blocked:'block this user',active:'reactivate this user'})[action];
    if(!confirm('Are you sure you want to '+label+'?'))return;
    try{await rpc('admin_update_user',{p_user_id:id,p_account_type:['vip','standard'].includes(action)?action:null,p_status:['active','suspended','blocked'].includes(action)?action:null});toast('User updated successfully.');await loadUsers();}
    catch(e){toast('Action failed: '+e.message);}
  }
  async function enterAdmin(session){
    $('login-screen').hidden=true;$('admin-app').hidden=false;$('admin-email').textContent=session.user.email||'Administrator';
    try{await rpc('admin_list_users');await loadUsers();await loadSettings();await loadActivity();}
    catch(e){$('login-screen').hidden=false;$('admin-app').hidden=true;showError('login-error','This account is not authorized for admin access, or admin setup is incomplete. '+e.message);await client.auth.signOut();}
  }
  async function loadSettings(){
    try{const s=await rpc('admin_get_settings');$('standard-rate').value=s.standard_win_rate??50;$('vip-rate').value=s.vip_win_rate??65;}
    catch(e){$('settings-message').textContent='Settings are not available until the admin SQL setup has been run.';}
  }
  async function loadActivity(){
    try{const rows=await rpc('admin_get_activity');$('activity-list').innerHTML=rows.length?'<div class="table-wrap"><table><thead><tr><th>Action</th><th>Target</th><th>Time</th></tr></thead><tbody>'+rows.map(x=>'<tr><td>'+esc(x.action)+'</td><td>'+esc(x.target_email||x.target_user_id||'—')+'</td><td>'+date(x.created_at)+'</td></tr>').join('')+'</tbody></table></div>':'<p class="empty">No administrator actions recorded yet.</p>';}
    catch(e){$('activity-list').innerHTML='<p class="empty">Activity log will appear after the admin SQL setup is complete.</p>';}
  }
  $('login-form').addEventListener('submit',async e=>{
    e.preventDefault();showError('login-error','');
    if(!client){showError('login-error','Supabase configuration was not detected. Check supabase-config.js.');return;}
    const btn=$('login-submit');btn.disabled=true;btn.textContent='Signing in…';
    try{const {data,error}=await client.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error)throw error;await enterAdmin(data.session);}
    catch(err){showError('login-error',err.message||'Unable to sign in.');}
    finally{btn.disabled=false;btn.innerHTML='Sign in securely <b>→</b>';}
  });
  $('logout').addEventListener('click',async()=>{await client.auth.signOut();$('admin-app').hidden=true;$('login-screen').hidden=false;$('password').value='';});
  document.querySelectorAll('.nav[data-page]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelectorAll('.page').forEach(x=>x.hidden=true);$('page-'+b.dataset.page).hidden=false;$('page-title').textContent=b.querySelector('span').textContent;}));
  ['overview-refresh','users-refresh'].forEach(id=>$(id).addEventListener('click',loadUsers));
  $('activity-refresh').addEventListener('click',loadActivity);
  $('user-search').addEventListener('input',filterUsers);$('user-filter').addEventListener('change',filterUsers);
  $('save-rates').addEventListener('click',async()=>{
    const a=Number($('standard-rate').value),b=Number($('vip-rate').value);
    if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||a>100||b<0||b>100){$('settings-message').textContent='Enter win rates between 0 and 100.';return;}
    try{await rpc('admin_save_settings',{p_standard_win_rate:a,p_vip_win_rate:b});$('settings-message').textContent='Global simulation settings saved.';toast('Settings saved.');}
    catch(e){$('settings-message').textContent='Could not save: '+e.message;}
  });
  client?.auth.getSession().then(({data})=>{if(data.session)enterAdmin(data.session);});
 })();