(() => {
  const LIMIT=10*1024*1024;
  let url='', busy=false, mask=.6, scope='', ready=Promise.resolve();
  const key=()=> 'starpost-background-mask-'+scope;
  const emit=()=>{document.documentElement.style.setProperty('--background-mask',`${Math.round(mask*100)}%`);document.documentElement.style.setProperty('--custom-background',url?`url("${url}")`:'none');document.documentElement.classList.toggle('custom-background',!!url);dispatchEvent(new Event('starpost-background'));};
  function database(mode,operation,owner=scope){return new Promise((resolve,reject)=>{
    if(!owner){reject(new Error('请先登录'));return}
    const request=indexedDB.open('starpost-appearance-'+owner,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('background');
    request.onerror=()=>reject(new Error('浏览器无法保存背景，请检查存储权限'));
    request.onblocked=()=>reject(new Error('请关闭其他星邮页面后重试'));
    request.onsuccess=()=>{const db=request.result,tx=db.transaction('background',mode);let result;
      const op=operation(tx.objectStore('background'));op.onsuccess=()=>{result=op.result};
      tx.oncomplete=()=>{db.close();resolve(result)};tx.onabort=tx.onerror=()=>{db.close();reject(new Error('背景保存失败，可能是本地存储空间不足'))};
    };
  });}
  async function replace(blob,owner=scope){const value=blob?await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取背景'));reader.readAsDataURL(blob)}):'';if(owner===scope){url=value;emit()}}
  function setScope(value){if(scope===value)return ready;scope=value;url='';mask=.6;emit();if(!scope)return ready=Promise.resolve();try{const saved=localStorage.getItem(key());if(saved!==null&&Number.isFinite(Number(saved)))mask=Math.max(.2,Math.min(.9,Number(saved)))}catch{}const owner=scope;ready=database('readonly',s=>s.get('image'),owner).then(blob=>{if(blob instanceof Blob&&blob.type==='image/jpeg'&&blob.size<=2*1024*1024)return replace(blob,owner)}).catch(()=>{});emit();return ready}
  async function normalize(file){
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>LIMIT)throw new Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片');
    let bitmap;
    try { bitmap=await createImageBitmap(file,{imageOrientation:'from-image'}); } catch {throw new Error('无法读取这张图片，请换一张试试');}
    try {
      if(bitmap.width*bitmap.height>40_000_000)throw new Error('图片尺寸过大，请选择 4000 万像素以内的图片');
      const ratio=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.85));
      if(!blob||blob.size>2*1024*1024)throw new Error('图片处理失败或过大，请换一张图片');
      return blob;
    } finally {bitmap.close();}
  }
  async function change(file){
    if(busy)return;const owner=scope;if(!owner)throw new Error('请先登录');busy=true;emit();
    try {await ready;const blob=file?await normalize(file):null;if(scope!==owner)throw new Error('账号已切换，请重试');await database('readwrite',s=>blob?s.put(blob,'image'):s.delete('image'),owner);await replace(blob,owner);if(!blob&&scope===owner)setMask(.6);}
    finally {busy=false;emit();}
  }
  function setMask(value){if(!scope)return;mask=Math.max(.2,Math.min(.9,Number.isFinite(Number(value))?Number(value):.6));try{localStorage.setItem(key(),String(mask))}catch{}emit();}
  window.starpostBackground={get url(){return url},get busy(){return busy},get mask(){return mask},change,setMask,setScope,get ready(){return ready}};
  emit();
})();
