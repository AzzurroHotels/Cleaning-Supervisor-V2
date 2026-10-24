// Sends the finished checklist to management. Each photo is shrunk and uploaded on its own (the website
// accepts at most 4.5 MB per request), then the report with references to the photos is posted to /api/reports.
// The report server saves it and posts the PDF to WhatsApp.
const submitButton=document.getElementById('submit');

async function shrink(blob,max=1600,quality=0.82){
  try{
    const img=await createImageBitmap(blob);
    const scale=Math.min(1,max/Math.max(img.width,img.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    const out=await new Promise(r=>canvas.toBlob(r,'image/jpeg',quality));
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
    const photos=Object.values(state.failures).reduce((n,f)=>n+f.media.filter(m=>m.type.startsWith('image/')).length,0)+Object.values(state.areaPhotos).reduce((n,l)=>n+l.length,0);
    let done=0,videos=0;const failures=[];
    const sendPhoto=async(blob,name)=>{
      msg.textContent='Uploading photo '+(++done)+' of '+photos+'…';
      const res=await fetch('/api/photo',{method:'POST',headers:{authorization:'Bearer '+inspectorToken(),'content-type':'application/octet-stream','x-name':encodeURIComponent(name||'photo.jpg')},body:blob});
      if(res.status===401)return null;
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw Error(data.error||'A photo could not be uploaded.');
      return {id:data.id,type:blob.type||'image/jpeg',name};
    };
    const areaMedia={};
    for(const [g,list] of Object.entries(state.areaPhotos)){
      areaMedia[g]=[];
      for(const p of list){
        const blob=await getMedia(p.id);
        if(!blob)continue;                               // a photo that is no longer on this phone is skipped
        const sent=await sendPhoto(blob,p.name);
        if(!sent){expired();return}
        areaMedia[g].push(sent);
      }
    }
    for(const [id,f] of Object.entries(state.failures)){
      const media=[];
      for(const m of f.media){
        if(!m.type.startsWith('image/')){videos++;continue}
        const blob=await getMedia(m.id);
        if(!blob)throw Error('An attachment is missing. Open the failure to remove or replace it.');
        const sent=await sendPhoto(await shrink(blob),m.name);
        if(!sent){expired();return}
        media.push(sent);
      }
      const [g,n]=id.split('-').map(Number);
      failures.push({id,status:state.results[id],floor:groups[g][2].floor,area:groups[g][0],item:groups[g][1][n],recheckedAt:f.recheckedAt,location:f.location,notes:f.notes,media});
    }
    msg.textContent='Sending report…';
    const res=await fetch('/api/reports',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+inspectorToken()},body:JSON.stringify({date:state.date,summary:summary(),recheck:state.recheck,handoverDone:state.handoverDone,handover:state.handover,failures,areas:groups.map(([name,items,meta],g)=>({floor:meta.floor,name,note:(state.notes[g]||'').trim(),media:areaMedia[g]||[],items:items.map((text,n)=>({text,status:state.results[g+'-'+n]||'unchecked'}))})),areaNotes:groups.flatMap(([area,,meta],g)=>state.notes[g]?.trim()?[{floor:meta.floor,area,note:state.notes[g].trim()}]:[])})});
    if(res.status===401){expired();return}
    const reply=await res.json().catch(()=>({}));
    if(!res.ok)throw Error(reply.error||'The server rejected the report.');
    msg.textContent=reply.duplicate?'This unchanged report was already submitted, so it was not sent to WhatsApp again.':'Report submitted. The PDF will be posted to the WhatsApp group within a minute.'+(videos?' '+videos+' video(s) were not sent (only photos are sent); share them on WhatsApp if needed.':'');
  }catch(err){
    msg.textContent='Could not submit: '+(err.message||'unknown error')+' Your checklist is still saved on this device.';
  }finally{submitButton.disabled=false}
};
