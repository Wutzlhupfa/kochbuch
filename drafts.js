/* Device-local recipe drafts, including File objects. Never writes to Supabase. */
const RecipeDrafts = (() => {
  const DB_NAME='kochbuch-drafts-v1', STORE='drafts', DELAY=500;
  const imageTokens=new WeakMap();
  let databasePromise=null, active=null;
  const copy=value=>JSON.parse(JSON.stringify(value));
  const note=message=>{document.querySelector('#draftStatus').textContent=message;};
  function database() {
    if(databasePromise) return databasePromise;
    databasePromise=new Promise((resolve,reject)=>{
      if(!window.indexedDB) { reject(new Error('IndexedDB ist in diesem Browser nicht verfügbar.'));return; }
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'key'});
      request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();databasePromise=null;};resolve(request.result);};
      request.onerror=()=>reject(request.error || new Error('Lokaler Entwurfsspeicher nicht erreichbar.'));
      request.onblocked=()=>reject(new Error('Ein anderer Tab blockiert den Entwurfsspeicher.'));
    }).catch(error=>{databasePromise=null;throw error;});
    return databasePromise;
  }
  async function read(key) {
    const db=await database();
    return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly'),request=tx.objectStore(STORE).get(key);request.onsuccess=()=>resolve(request.result || null);request.onerror=()=>reject(request.error);});
  }
  async function readForEditor(state) {
    const current=await read(state.key);
    if(current || !supabaseClient) return current;
    const db=await database();
    const records=await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly'),request=tx.objectStore(STORE).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const prefix=`cloud:${SUPABASE_URL}:user:`;
    const legacy=records.filter(record=>record.schema===1 && record.id===state.id && record.scope?.startsWith(prefix))
      .sort((a,b)=>String(b.savedAt).localeCompare(String(a.savedAt)))[0];
    // Offer an old account-scoped local draft without deleting or auto-applying it.
    return legacy ? {...legacy,key:state.key,scope:state.scope,revision:0,legacy:{key:legacy.key,revision:legacy.revision}} : null;
  }
  async function change(key,revision,value) {
    const db=await database();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),request=store.get(key);
      let conflict=null, nextRevision=value?revision+1:0;
      request.onsuccess=()=>{
        if((request.result?.revision || 0)!==revision) {conflict=new Error('Dieser Entwurf wurde in einem anderen Tab geändert. Er wird nicht überschrieben. Bitte den Editor erneut öffnen.');tx.abort();return;}
        if(value) store.put({...value,key,revision:nextRevision});else store.delete(key);
      };
      tx.oncomplete=()=>resolve(nextRevision);
      tx.onerror=tx.onabort=()=>reject(conflict || tx.error || new Error('Entwurf konnte nicht lokal gespeichert werden.'));
    });
  }
  function scope() { return supabaseClient ? `cloud:${SUPABASE_URL}:public` : `local:${location.origin}`; }
  function keyFor(id) {return `${scope()}:${id?'edit:'+id:'new'}`;}
  function capture() {
    const fields=Object.fromEntries([...recipeForm.querySelectorAll('input[id]:not([type=file]),select[id],textarea[id]')]
      .filter(element=>element.id!=='recipeId').map(element=>[element.id,element.type==='checkbox'?element.checked:element.value]));
    const file=pendingImageFile;
    if(file && !imageTokens.has(file)) imageTokens.set(file,crypto.randomUUID());
    return {fields,ingredients:copy(formIngredients),components:copy(formComponents),tags:copy(formTags),image:formImage,
      file,fileToken:file?imageTokens.get(file):null,snapshot:copy(editingRecipeSnapshot || {})};
  }
  function fingerprint(value) {const {file,...rest}=value;return JSON.stringify({...rest,file:file?{name:file.name,size:file.size,type:file.type,lastModified:file.lastModified}:null});}
  function dirty(state=active) {return Boolean(state && state===active && recipeModal.open && fingerprint(capture())!==state.baseline);}
  function failure(error) {note(`Entwurf NICHT gesichert: ${error.message || 'Browserspeicher voll/gesperrt.'} Bitte das Rezept manuell speichern oder den Editor offen lassen.`);}
  function hidePrompt(){document.querySelector('#draftPrompt').hidden=true;}
  function resetConflict() {document.querySelector('#draftConflict').hidden=true;}
  function markConflict(message) {
    if(!active) return;
    active.conflict=true;
    document.querySelector('#draftConflict').hidden=false;
    document.querySelector('#draftConflictText').textContent=message+' Das bestehende Rezept wird nicht überschrieben. Du kannst den Entwurf als neues Rezept weiterbearbeiten oder schließen und den aktuellen Stand neu öffnen.';
  }
  function begin() {
    const id=document.querySelector('#recipeId').value;
    const state={key:keyFor(id),scope:scope(),id,revision:0,baseVersion:editingRecipeVersion,localVersion:localRecipeEtag,
      baseline:fingerprint(capture()),lastSaved:null,timer:null,tail:Promise.resolve(),pending:null,conflict:false,loading:true};
    active=state;hidePrompt();resetConflict();note('Änderungen werden nach kurzer Pause nur auf diesem Gerät als Entwurf gesichert. Beim Schließen bleibt der Entwurf erhalten.');
    state.ready=readForEditor(state).then(record=>{
      if(active!==state) return;
      state.revision=record?.revision || 0;state.legacy=record?.legacy || null;state.loading=false;
      if(record) {
        if(record.id!==state.id || record.scope!==state.scope || record.schema!==1) throw new Error('Entwurf passt nicht zu diesem Rezept oder Speicherort.');
        state.pending=record;
        document.querySelector('#draftPrompt').hidden=false;
        document.querySelector('#draftPromptText').textContent=`Ungespeicherter ${state.id?'Rezeptentwurf':'neuer Rezeptentwurf'} vom ${new Date(record.savedAt).toLocaleString('de-DE')} auf diesem Gerät gefunden.`;
        note('Bitte zuerst den vorhandenen Entwurf wiederherstellen oder verwerfen. Es wurde noch nichts übernommen.');
      } else if(dirty(state)) schedule();
    }).catch(error=>{if(active===state){state.loading=false;failure(error);}});
  }
  function schedule() {
    const state=active;
    if(!state || !recipeModal.open || state.scope!==scope() || editorSaveInProgress) return;
    clearTimeout(state.timer);
    if(state.loading || state.pending) return;
    note('Entwurf wird lokal gesichert …');
    state.timer=setTimeout(()=>{flush(state).catch(failure);},DELAY);
  }
  async function flush(state=active) {
    if(!state || state!==active) return;
    clearTimeout(state.timer);
    await state.ready;
    if(state!==active || state.pending) return;
    if(state.scope!==scope()) throw new Error("Speicherort geändert. Bitte den ursprünglichen Speicherort erneut öffnen; die letzten Änderungen sind noch nicht gesichert.");
    const data=capture(), signature=fingerprint(data);
    if(signature===state.lastSaved) return;
    if(signature===state.baseline) {
      if(state.lastSaved) {await state.tail.catch(()=>{});state.revision=await change(state.key,state.revision,null);state.lastSaved=null;note('Keine ungespeicherten Änderungen.');}
      return;
    }
    if(new TextEncoder().encode(JSON.stringify({...data,file:null})).length>1024*1024 || (data.file?.size || 0)>8*1024*1024) throw new Error('Entwurf ist zu groß (maximal 1 MiB Text und 8 MiB Bild).');
    const record={schema:1,key:state.key,scope:state.scope,id:state.id,baseVersion:state.baseVersion,localVersion:state.localVersion,
      legacy:state.legacy || null,data,savedAt:new Date().toISOString()};
    state.tail=state.tail.catch(()=>{}).then(async()=>{
      state.revision=await change(state.key,state.revision,record);
      state.lastSaved=signature;
      if(active===state) note(`Entwurf lokal gesichert (${new Date().toLocaleTimeString('de-DE')}). Noch nicht als Rezept gespeichert. Beim Schließen bleibt er erhalten.`);
    });
    await state.tail;
  }
  async function prepareSave() {
    const state=active;
    if(!state) return true;
    await state.ready;
    if(state.scope!==scope()) {markConflict('Der Speicherort hat sich geändert.');return false;}
    if(state.pending) {note('Bitte den gefundenen Entwurf zuerst wiederherstellen oder verwerfen.');return false;}
    if(state.conflict) {note('Ein Konflikt verhindert das Überschreiben. Bitte als neues Rezept weiterbearbeiten.');return false;}
    clearTimeout(state.timer);
    // Local draft failure must not prevent a deliberate successful recipe save.
    try {await flush(state);}catch(error){failure(error);}
    return true;
  }
  async function complete() {
    const state=active;
    if(!state) return;
    clearTimeout(state.timer);await state.ready;await state.tail.catch(()=>{});
    try {state.revision=await change(state.key,state.revision,null);if(state.legacy) await change(state.legacy.key,state.legacy.revision,null);}
    catch(error){document.querySelector('#editorStatus').textContent=`Rezept gespeichert. Der lokale Entwurf konnte nicht entfernt werden: ${error.message}`;}
    if(active===state) active=null;
  }
  function requestClose() {
    const state=active;
    if(editorSaveInProgress) return;
    if(!state || (!dirty(state) && !state.lastSaved)) {clearTimeout(state?.timer);document.querySelector('#editorStatus').textContent=state?.pending?'Editor geschlossen. Der vorhandene lokale Entwurf bleibt erhalten.':'Editor geschlossen. Keine ungespeicherten Änderungen.';active=null;finishCloseForm();return;}
    return (async()=>{
      try {
        await state.ready;
        if(state.pending) {if(!confirm('Ein älterer Entwurf wartet noch auf deine Auswahl. Neue Eingaben im Editor sind noch nicht gesichert. Trotzdem schließen und den vorhandenen Entwurf behalten?'))return;}
        else {await flush(state);await state.tail;}
        if(active!==state) return;
        document.querySelector('#editorStatus').textContent=state.pending?'Der vorhandene lokale Entwurf bleibt erhalten.':'Editor geschlossen. Dein Entwurf bleibt auf diesem Gerät gespeichert. Beim erneuten Bearbeiten kannst du ihn wiederherstellen.';
      } catch(error) {
        failure(error);
        if(!confirm('Der Entwurf konnte NICHT gespeichert werden. Trotzdem schließen und die ungesicherten Änderungen verlieren?'))return;
      }
      if(active===state){active=null;finishCloseForm();}
    })();
  }
  async function restore() {
    const state=active,record=state?.pending;
    if(!record || state.scope!==scope()) return;
    let conflict='';
    if(state.id) {
      try {
        if(supabaseClient) {
          const {data,error}=await supabaseClient.from('recipes').select('id, data, updated_at').eq('id',state.id);
          if(error)throw error;
          if(!data?.length || !record.baseVersion || data[0].updated_at!==record.baseVersion) conflict='Das Rezept wurde seit Erstellung des Entwurfs geändert oder gelöscht.';
        } else {
          const response=await fetch('/api/recipes',{cache:'no-store'});
          if(!response.ok)throw new Error('Sammlung nicht lesbar');
          const items=await response.json();
          if(!items.some(item=>item.id===state.id) || !record.localVersion || response.headers.get('ETag')!==record.localVersion) conflict='Die lokale Sammlung wurde seit Erstellung des Entwurfs geändert.';
        }
      } catch {conflict='Der aktuelle Rezeptstand konnte nicht überprüft werden.';}
    }
    if(active!==state || state.scope!==scope()) return;
    const data=record.data;
    editingRecipeSnapshot=copy(data.snapshot);editingRecipeVersion=record.baseVersion;
    formIngredients=copy(data.ingredients);formComponents=copy(data.components);formTags=copy(data.tags);
    formImage=data.image;pendingImageFile=data.file || null;
    if(pendingImageFile) imageTokens.set(pendingImageFile,data.fileToken);
    setNutritionBasisForm(JSON.parse(data.fields.nutritionBasisInput));
    for(const [id,value] of Object.entries(data.fields)) {
      const element=document.getElementById(id);
      if(!element || !recipeForm.contains(element) || id==='recipeId' || id==='imageFileInput') continue;
      if(element.type==='checkbox')element.checked=Boolean(value);else element.value=value;
    }
    document.querySelector('#imageFileInput').value='';
    renderComponentRows();renderIngredientRows();renderFormTags();updateImagePreview();
    // renderFormTags rebuilds only chips and suggestions; retain pending tag text.
    state.baseVersion=record.baseVersion;state.localVersion=record.localVersion;
    state.lastSaved=fingerprint(capture());state.pending=null;hidePrompt();
    note('Lokalen Entwurf wiederhergestellt. Er wird erst mit „Rezept speichern“ endgültig gespeichert.');
    if(conflict)markConflict(conflict);
  }
  async function discard() {
    const state=active;if(!state)return;
    clearTimeout(state.timer);await state.ready;await state.tail.catch(()=>{});
    state.revision=await change(state.key,state.revision,null);
    if(state.legacy) await change(state.legacy.key,state.legacy.revision,null);
    state.legacy=null;
    state.pending=null;hidePrompt();
    // Existing saved recipe remains in the editor when rejecting a found draft.
    note('Lokalen Entwurf verworfen. Gespeicherte Rezeptdaten wurden nicht verändert.');
    state.lastSaved=null;
    if(dirty(state)) schedule();
  }
  async function asNew() {
    const state=active;if(!state || !state.conflict)return;
    const key=keyFor('');
    if(await read(key)) {note('Es existiert bereits ein neuer Rezeptentwurf. Bitte diesen erst wiederherstellen oder verwerfen; er wird nicht überschrieben.');return;}
    await state.tail.catch(()=>{});
    const oldKey=state.key,oldRevision=state.revision;
    document.querySelector('#recipeId').value='';
    document.querySelector('#titleInput').value=`${document.querySelector('#titleInput').value} (Entwurfskopie)`;
    editingRecipeSnapshot={...editingRecipeSnapshot,favorite:false};editingRecipeVersion=null;
    state.key=key;state.id='';state.revision=0;state.baseVersion=null;state.localVersion=null;state.conflict=false;state.lastSaved=null;
    resetConflict();
    await flush(state);
    try {await change(oldKey,oldRevision,null);}catch{ /* Keep old draft if another tab changed it. */ }
    note('Als neuer Rezeptentwurf übernommen. Das ursprüngliche Rezept bleibt unverändert.');
  }
  recipeForm.addEventListener('input',schedule);
  recipeForm.addEventListener('change',schedule);
  // Buttons mutate component/tag/ingredient arrays without native input events.
  recipeForm.addEventListener('click',event=>{if(event.target.closest('.ingredient-row-remove,.component-remove,#addComponentButton,#addTagButton,.tag-chip,.ingredient-group-heading button,#removeImageButton'))schedule();});
  document.querySelector('#restoreDraftButton').addEventListener('click',()=>restore().catch(failure));
  document.querySelector('#discardDraftButton').addEventListener('click',()=>discard().catch(failure));
  document.querySelector('#draftAsNewButton').addEventListener('click',()=>asNew().catch(failure));
  recipeModal.addEventListener('cancel',event=>{event.preventDefault();requestClose();});
  recipeModal.addEventListener('close',()=>{if(active){flush().catch(failure);}});
  window.addEventListener('beforeunload',event=>{
    if(active && dirty() && fingerprint(capture())!==active.lastSaved){flush().catch(()=>{});event.preventDefault();event.returnValue='';}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)flush().catch(failure);});
  window.addEventListener('pagehide',()=>{flush().catch(()=>{});});
  return {begin,schedule,flush,prepareSave,complete,requestClose,markConflict,read,keyFor,ready:()=>active?.ready || Promise.resolve(),hasConflict:()=>Boolean(active?.conflict),restore,discard,asNew};
})();
