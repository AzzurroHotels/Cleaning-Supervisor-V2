// Sends the finished checklist to management. Photos and videos go straight to Blob storage,
// then the report (with references to them) is posted to /api/reports.
const submitButton=document.getElementById('submit');
submitButton.onclick=async()=>{
  const msg=$('msg');
  if(!inspectorToken()){showLogin('Sign in to submit your report.');return}
  if(!navigator.onLine){msg.textContent='No connection. Your checklist is saved on this device; submit once you are back online.';return}
  if(!confirm('Submit this report to management?'))return;
  submitButton.disabled=true;
  try{
    const {upload}=await import('./vendor/blob-client.js');
    const all=Object.values(state.failures).reduce((n,f)=>n+f.media.length,0);
    let done=0;const failures=[];
    for(const [id,f] of Object.entries(state.failures)){
      const media=[];
      for(const m of f.media){
        msg.textContent='Uploading attachment '+(++done)+' of '+all+'…';
        const blob=await getMedia(m.id);
        if(!blob)throw Error('An attachment is missing. Open the failure to remove or replace it.');
        const up=await upload('media/'+(m.name||'attachment').replace(/[^\w.-]+/g,'_'),blob,{access:'private',handleUploadUrl:'/api/upload',contentType:m.type,clientPayload:inspectorToken(),multipart:blob.size>5*1024*1024});
        media.push({pathname:up.pathname,type:m.type,name:m.name});
      }
      const [g,n]=id.split('-').map(Number);
      failures.push({id,status:state.results[id],floor:groups[g][2].floor,area:groups[g][0],item:groups[g][1][n],recheckedAt:f.recheckedAt,location:f.location,notes:f.notes,media});
    }
    msg.textContent='Sending report…';
    const res=await fetch('/api/reports',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+inspectorToken()},body:JSON.stringify({date:state.date,summary:summary(),recheck:state.recheck,handoverDone:state.handoverDone,handover:state.handover,failures,areas:groups.map(([name,items,meta],g)=>({floor:meta.floor,name,note:(state.notes[g]||'').trim(),items:items.map((text,n)=>({text,status:state.results[g+'-'+n]||'unchecked'}))})),areaNotes:groups.flatMap(([area,,meta],g)=>state.notes[g]?.trim()?[{floor:meta.floor,area,note:state.notes[g].trim()}]:[])})});
    if(res.status===401){storeToken('');showLogin('Your session expired. Sign in again; your checklist is still saved.');return}
    if(!res.ok)throw Error((await res.json().catch(()=>({}))).error||'The server rejected the report.');
    msg.textContent='Report submitted to management. You can start a new checklist when ready.';
  }catch(err){
    msg.textContent='Could not submit: '+(err.message||'unknown error')+'. Your checklist is still saved on this device.';
  }finally{submitButton.disabled=false}
};
