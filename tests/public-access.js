(async()=>{
  const checks=[],errors=[],alerts=[];
  const assert=(value,label)=>{if(!value)throw new Error(label);checks.push(label);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async condition=>{for(let i=0;i<300;i++){if(condition())return;await wait(10);}throw new Error('Timeout');};
  const clone=value=>JSON.parse(JSON.stringify(value));
  window.alert=message=>alerts.push(message);window.confirm=()=>true;
  window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
  const nativeFetch=window.fetch;
  try{
    await initialize();
    const code=await(await nativeFetch('/app.js')).text();
    assert(!document.querySelector('#authButton,#authForm,#authModal,#authEmail,#authPassword'),'Keine Anmeldung oder Registrierung im DOM');
    assert(code.includes('persistSession: false') && code.includes('autoRefreshToken: false') && code.includes('detectSessionInUrl: false'),'Gespeicherte Sitzungen werden weder geladen noch erneuert');
    assert(!/\.auth\.(getUser|getSession|signIn|signOut|onAuthStateChange)/.test(code),'Keine Authentifizierungsaufrufe im Anwendungscode');
    const fixtures=await(await nativeFetch('/legacy-fixtures.json')).json();
    const seed=clone(fixtures[0]);seed.id=crypto.randomUUID();seed.image='';
    let db=new Map([[seed.id,{id:seed.id,data:seed,updated_at:'2025-01-01T00:00:00.000Z',updated_by:'legacy-author'}]]);
    let denied=false,silentDenied=false,uploadPath='',uploadUrl='';
    const query=()=>({op:'read',filters:[],row:null,start:0,end:499,
      select(){return this;},order(){return this;},range(start,end){this.start=start;this.end=end;return this;},eq(key,value){this.filters.push([key,value]);return this;},
      insert(row){this.op='insert';this.row=row;return this;},update(row){this.op='update';this.row=row;return this;},delete(){this.op='delete';return this;},
      then(resolve,reject){return this.execute().then(resolve,reject);},async execute(){
        const matching=[...db.values()].filter(row=>this.filters.every(([key,value])=>row[key]===value));
        if(this.op==='read')return{data:clone(matching.slice(this.start,this.end+1)),error:null};
        if(denied)return{error:{code:'42501',message:'row level security policy'},data:null};
        if(silentDenied)return{error:null,data:[]};
        const changed=[];
        if(this.op==='insert'){if(db.has(this.row.id))return{error:{message:'duplicate'},data:[]};db.set(this.row.id,clone(this.row));changed.push(this.row);}
        else for(const row of matching){if(this.op==='delete'){db.delete(row.id);changed.push(row);}else{const updated={...row,...clone(this.row)};db.set(row.id,updated);changed.push(updated);}}
        return{data:clone(changed),error:null};
      }});
    // No auth object exists: any remaining login/getUser call would fail.
    supabaseClient={from:()=>query(),storage:{from:bucket=>({upload:async(path,blob,options)=>{
      assert(bucket==='recipe-images' && options.upsert===false,'Anonymer Upload überschreibt keine vorhandenen Bilder');
      uploadPath=path;
      const response=await nativeFetch('/api/image',{method:'POST',headers:{'Content-Type':blob.type},body:blob});uploadUrl=(await response.json()).path;return{error:null};
    },getPublicUrl:()=>({data:{publicUrl:uploadUrl}})})}};
    await loadRecipes();normalizeAllRecipes();render();
    assert(recipes.length===1 && ensureCanEdit(),'Öffentliche Sammlung lädt und ist ohne Sitzung bearbeitbar');
    openForm();await RecipeDrafts.ready();document.querySelector('#titleInput').value='Öffentliches Testrezept';
    formIngredients[0].name='Mehl';formIngredients[0].amount=100;
    recipeForm.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>!editorSaveInProgress);
    assert(!recipeModal.open && db.size===2,'Besucher kann im Simulator ohne Anmeldung ein Rezept erstellen');
    const created=recipes.find(item=>item.id!==seed.id);
    assert(!('updated_by' in db.get(created.id)),'Neue Rezepte benötigen keine Benutzer-ID');
    const originalAuthor=db.get(seed.id).updated_by;
    await saveRecipeToCloud({...db.get(seed.id).data,title:'Anonym bearbeitet'},{expectedVersion:recipeVersions.get(seed.id)});
    assert(db.get(seed.id).data.title==='Anonym bearbeitet' && db.get(seed.id).updated_by===originalAuthor,'Anonyme Bearbeitung erhält vorhandene Autorenmetadaten und Rezeptdaten');
    recipes=[...db.values()].map(row=>row.data);normalizeAllRecipes();render();
    document.querySelector(`.recipe-card[data-id="${created.id}"] .favorite-button`).click();await until(()=>!favoriteWrites.size);
    assert(db.get(created.id).data.favorite===true,'Besucher kann Favoriten ohne Anmeldung ändern');
    openForm(db.get(created.id).data);await RecipeDrafts.ready();document.querySelector('#titleInput').value='Alter Kontoentwurf';await RecipeDrafts.flush();
    const draftKey=RecipeDrafts.keyFor(created.id),storedDraft=await RecipeDrafts.read(draftKey);await closeForm();
    const oldKey=`cloud:${SUPABASE_URL}:user:old-account:edit:${created.id}`;
    await new Promise((resolve,reject)=>{const req=indexedDB.open('kochbuch-drafts-v1');req.onsuccess=()=>{const db=req.result,tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts');store.delete(draftKey);store.put({...storedDraft,key:oldKey,scope:`cloud:${SUPABASE_URL}:user:old-account`});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
    openForm(db.get(created.id).data);await RecipeDrafts.ready();
    assert(!document.querySelector('#draftPrompt').hidden && await RecipeDrafts.read(oldKey),'Alte kontogebundene Entwürfe bleiben erhalten und werden zur Wiederherstellung angeboten');
    await RecipeDrafts.restore();assert(document.querySelector('#titleInput').value==='Alter Kontoentwurf','Kontoentwurf kann ohne Anmeldung wiederhergestellt werden');await closeForm();
    openForm(db.get(created.id).data);await RecipeDrafts.ready();await RecipeDrafts.discard();await closeForm();
    const baseCount=db.size;
    await duplicateRecipe(db.get(created.id).data,document.createElement('button'));await RecipeDrafts.ready();
    const copiedId=document.querySelector('#recipeId').value;
    assert(db.size===baseCount+1 && !db.get(copiedId).data.favorite,'Öffentliches Kopieren funktioniert ohne Benutzerkonto');await closeForm();
    await deleteRecipe(db.get(copiedId).data,recipeVersions.get(copiedId));
    assert(db.size===baseCount && !db.has(copiedId),'Besucher kann im Simulator ohne Anmeldung löschen');
    const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    pendingImageFile=new File([blob],'public.png',{type:'image/png'});await uploadPendingImage();
    assert(uploadPath.startsWith('public/recipe-') && uploadUrl===formImage,'Neue Bilder verwenden öffentlichen Pfad statt Benutzerordner');
    const existing=[...db.values()][0],expectedVersion=existing.updated_at;
    const before=JSON.stringify([...db.values()]);denied=true;
    let error;try{await saveRecipeToCloud({...existing.data,title:'Nicht erlaubt'},{expectedVersion});}catch(e){error=e;}
    assert(error?.message.includes('öffentlichen') && JSON.stringify([...db.values()])===before,'Verweigerte öffentliche Supabase-Schreibrechte werden verständlich gemeldet');
    denied=false;silentDenied=true;error=null;
    try{await saveRecipeToCloud({...existing.data,title:'Nicht erlaubt'},{expectedVersion});}catch(e){error=e;}
    assert(error?.message.includes('unverändert') && JSON.stringify([...db.values()])===before,'RLS-Update mit null betroffenen Zeilen wird nicht fälschlich als Versionskonflikt oder Erfolg ausgegeben');
    silentDenied=false;
    const readBackup=await nativeFetch('/source-backup.zip');
    if(readBackup.ok){
      const bundle=await KochbuchBackup.inspect(new File([await readBackup.blob()],'source.zip'));
      assert(bundle.items.length===33 && bundle.images.size===33,'Aktuelle Vorsicherung mit 33 Rezepten und 33 echten Bildern vollständig validiert');
      assert(bundle.manifest.images.every(entry=>bundle.images.get(entry.path)?.info.sha256===entry.sha256),'Alle gesicherten Produktivbilder sind dekodierbar und stimmen mit ihren Prüfsummen überein');
    }
    assert(errors.length===0,'Keine JavaScript-Fehler im anonymen Gesamtworkflow');
    await nativeFetch('/test-result',{method:'POST',body:`PASS ${checks.length}\n${checks.join('\n')}`});
  }catch(error){await nativeFetch('/test-result',{method:'POST',body:`FAIL ${error.stack}\n${checks.join('\n')}\nBrowserfehler: ${errors.join('; ')}`});}
})();
