// Inspector sign-in. The checklist stays hidden until the server has accepted a login ID and password.
const TOKEN_KEY='allen-inspector-token';
let memoryToken='';
function inspectorToken(){
  let t=memoryToken;
  try{t=localStorage.getItem(TOKEN_KEY)||t}catch{}
  return Number(t.split('.')[0])>Date.now()?t:'';
}
function storeToken(t){memoryToken=t;try{t?localStorage.setItem(TOKEN_KEY,t):localStorage.removeItem(TOKEN_KEY)}catch{}}
function signOut(){storeToken('');showLogin()}
function showLogin(notice){
  if(document.getElementById('login'))return;
  const main=document.querySelector('main');
  main.inert=true;
  const box=document.createElement('div');
  box.id='login';
  box.setAttribute('style','position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;background:#f5f5f0;overflow:auto');
  box.innerHTML='<form style="background:#fff;border:1px solid #dce1d7;border-radius:12px;padding:24px;width:100%;max-width:380px"><p class="eyebrow">ALLEN HOSTEL</p><h1 style="margin:0 0 12px">Inspector login</h1><label>Login ID<input id="loginId" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></label><label>Password<input id="loginPassword" type="password" autocomplete="current-password" required></label><p id="loginError" class="error" role="alert"></p><button class="primary" id="loginSubmit" style="width:100%">Sign in</button></form>';
  document.body.append(box);
  const error=box.querySelector('#loginError'),submit=box.querySelector('#loginSubmit');
  error.textContent=notice||'';
  box.querySelector('#loginId').focus();
  box.querySelector('form').onsubmit=async e=>{
    e.preventDefault();
    if(!navigator.onLine){error.textContent='Connect to the internet to sign in.';return}
    submit.disabled=true;error.textContent='';
    try{
      const res=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:box.querySelector('#loginId').value.trim(),password:box.querySelector('#loginPassword').value})});
      const data=await res.json().catch(()=>({}));
      if(!res.ok||!data.token)throw Error(data.error||'Could not sign in.');
      storeToken(data.token);box.remove();main.inert=false;
    }catch(err){error.textContent=err.message||'Could not sign in.'}
    finally{submit.disabled=false}
  };
}
if(!inspectorToken())showLogin();
const signOutButton=document.createElement('button');
signOutButton.type='button';signOutButton.textContent='Sign out';signOutButton.onclick=signOut;
document.getElementById('reset').after(signOutButton);
