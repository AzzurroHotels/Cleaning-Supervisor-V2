// Room and bathroom photos. The camera button takes a picture (or you can pick one from the gallery), shrinks it to a
// small low-quality JPEG straight away, keeps it on the phone with the checklist, and shows thumbnails you can remove.
// They are sent with the report when you tap Submit (see submit.js).
const MAX_AREA_PHOTOS=6;
const thumbUrls={};

async function deleteMedia(id){
  try{
    const db=await openDB();
    await new Promise(done=>{const tx=db.transaction('files','readwrite');tx.objectStore('files').delete(id);tx.oncomplete=done;tx.onerror=done});
  }catch{}
}

async function showThumbs(g){
  const box=document.getElementById('thumbs-'+g);
  if(!box)return;
  const mine=String((Number(box.dataset.v)||0)+1);
  box.dataset.v=mine;
  (thumbUrls[g]||[]).forEach(URL.revokeObjectURL);thumbUrls[g]=[];
  const cells=[];
  for(const p of state.areaPhotos[g]||[]){
    const blob=await getMedia(p.id).catch(()=>null);
    const cell=document.createElement('div');cell.className='thumb';
    if(blob){const url=URL.createObjectURL(blob);thumbUrls[g].push(url);const img=document.createElement('img');img.src=url;img.alt='Photo of '+groups[g][0];cell.append(img)}
    else cell.textContent='Photo missing';
    const rm=document.createElement('button');rm.type='button';rm.className='thumb-remove';rm.textContent='×';
    rm.setAttribute('aria-label','Remove this photo');rm.dataset.rmPhoto=g+':'+p.id;cell.append(rm);
    cells.push(cell);
  }
  if(box.dataset.v===mine)box.replaceChildren(...cells);       // ignore results of an older, slower call
}

const hydrateAll=()=>Object.keys(state.areaPhotos).forEach(showThumbs);

document.addEventListener('change',async e=>{
  const g=e.target.dataset?.photo;
  if(g===undefined)return;
  const files=[...e.target.files];
  e.target.value='';                                            // lets the same photo be picked again
  const msg=document.getElementById('msg');
  const list=state.areaPhotos[g]??=[];
  for(const file of files){
    if(list.length>=MAX_AREA_PHOTOS){msg.textContent='You can add up to '+MAX_AREA_PHOTOS+' photos for each room.';break}
    try{
      const small=await shrink(file,1280,0.6);                  // up to 1280 px wide at low quality: roughly 80-200 KB
      const id=crypto.randomUUID();
      await storeMedia(id,small);
      list.push({id,type:small.type||'image/jpeg',name:file.name||'photo.jpg',size:small.size});
    }catch(err){msg.textContent=err.message||'The photo could not be added.'}
  }
  if(!list.length)delete state.areaPhotos[g];
  save();
  document.getElementById('status-'+g).textContent=areaStatus(g);
  showThumbs(g);
});

document.addEventListener('click',e=>{
  const b=e.target.closest?.('button[data-rm-photo]');
  if(!b)return;
  const [g,id]=b.dataset.rmPhoto.split(':');
  if(!confirm('Remove this photo?'))return;
  state.areaPhotos[g]=(state.areaPhotos[g]||[]).filter(p=>p.id!==id);
  if(!state.areaPhotos[g].length)delete state.areaPhotos[g];
  save();deleteMedia(id);
  document.getElementById('status-'+g).textContent=areaStatus(g);
  showThumbs(g);
});

// The checklist is redrawn whenever something changes, so draw the thumbnails again each time.
new MutationObserver(hydrateAll).observe(document.getElementById('list'),{childList:true});
hydrateAll();
