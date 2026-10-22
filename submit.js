// Sends the finished checklist to management. Each photo is shrunk and uploaded on its own (the website
// accepts at most 4.5 MB per request), then the report with references to the photos is posted to /api/reports.
// The report server saves it and posts the PDF to WhatsApp.
const submitButton=document.getElementById('submit');

async function shrink(blob){
  try{
    const img=await createImageBitmap(blob);
    const scale=Math.min(1,1600/Math.max(img.width,img.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    const out=await new Promise(r=>canvas.toBlob(r,'image/jpeg',0.82));
    if(out&&out.size<4*1024*1024)return out;
  }catch{}
  if(/^image\/(jpeg|png)$/.test(blob.type)&&blob.size<4*1024*1024)return blob;
  throw Error('A photo could not be prepared. Remove it and add it again.');
}

submitButton.onclick=async()=>{
  const msg=$('msg');
  if(!inspectorToken()){showLogin('Sign in to submit your report.');return}
  if(!navigator.onLine){msg.textContent='No connection. Your checklist is saved on this device; submit once you are back online.';return}
  if(!confirm('Submit this report to management?'))return;
  submitButton.disabled=true;
  const expired=()=>{storeToken('');showLogin('Your session expired. Sign in again; your checklist is still saved.')};
  try{
    const photos=Object.values(state.failures).reduce((n,f)=>n+f.media.filter(m=>m.type.startsWith('image/')).length,0);
    let done=0,videos=0;const failures=[];
    for(const [id,f] of Object.entries(state.failures)){
      const media=[];
      for(const m of f.media){
        if(!m.type.startsWith('image/')){videos++;continue}
        msg.textContent='Uploading photo '+(++done)+' of '+photos+'…';
        const blob=await getMedia(m.id);
        if(!blob)throw Error('An attachment is missing. Open the failure to remove or replace it.');
        const jpeg=await shrink(blob);
        const res=await fetch('/api/photo',{method:'POST',headers:{authorization:'Bearer '+inspectorToken(),'content-type':'application/octet-stream','x-name':encodeURIComponent(m.name||'photo.jpg')},body:jpeg});
        if(res.status===401){expired();return}
        const data=await res.json().catch(()=>({}));
        if(!res.ok)throw Error(data.error||'A photo could not be uploaded.');
        media.push({id:data.id,type:jpeg.type||'image/jpeg',name:m.name});
      }
      const [g,n]=id.split('-').map(Number);
      failures.push({id,status:state.results[id],floor:groups[g][2].floor,area:groups[g][0],item:groups[g][1][n],recheckedAt:f.recheckedAt,location:f.location,notes:f.notes,media});
    }
    msg.textContent='Sending report…';
    const res=await fetch('/api/reports',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+inspectorToken()},body:JSON.stringify({date:state.date,summary:summary(),recheck:state.recheck,handoverDone:state.handoverDone,handover:state.handover,failures,areas:groups.map(([name,items,meta],g)=>({floor:meta.floor,name,note:(state.notes[g]||'').trim(),items:items.map((text,n)=>({text,status:state.results[g+'-'+n]||'unchecked'}))})),areaNotes:groups.flatMap(([area,,meta],g)=>state.notes[g]?.trim()?[{floor:meta.floor,area,note:state.notes[g].trim()}]:[])})});
    if(res.status===401){expired();return}
    if(!res.ok)throw Error((await res.json().catch(()=>({}))).error||'The server rejected the report.');
    msg.textContent='Report submitted. The PDF will be posted to the WhatsApp group within a minute.'+(videos?' '+videos+' video(s) were not sent (only photos are sent); share them on WhatsApp if needed.':'');
  }catch(err){
    msg.textContent='Could not submit: '+(err.message||'unknown error')+' Your checklist is still saved on this device.';
  }finally{submitButton.disabled=false}
};
