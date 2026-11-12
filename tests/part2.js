(async()=>{
  const B=KochbuchBackup, results=[], errors=[];
  window.addEventListener('error',event=>errors.push(event.message));
  window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
  window.alert=message=>errors.push(message);
  const assert=(ok,message)=>{if(!ok)throw new Error(message);results.push(message);};
  const rejects=async(action,message,pattern)=>{let error;try{await action();}catch(e){error=e;}assert(!!error && (!pattern || pattern.test(error.message)),message+(error?'':' (kein Fehler)'));return error;};
  const clone=value=>JSON.parse(JSON.stringify(value));
  const file=blob=>new File([blob],'test.zip',{type:'application/zip'});
  let adapter;
  async function write(items) {const response=await fetch('/api/recipes',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(items)});if(!response.ok)throw new Error('Testsetup fehlgeschlagen');}
  async function fixtureImage(type,color) {
    const canvas=document.createElement('canvas');canvas.width=8;canvas.height=6;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,8,6);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,type));
    const bytes=new Uint8Array(await blob.arrayBuffer()), info=await B.imageInfo(bytes);
    const path=await adapter.upload(bytes,info);return{bytes,info,path};
  }
  function recipe(title,image='') {
    const componentId=crypto.randomUUID();
    return {id:crypto.randomUUID(),title,category:'Hauptspeise',servings:4,image,
      components:[{id:componentId,name:'Teig',instructions:'Mischen, dann backen.',customPart:'behalten'}],
      ingredients:[{id:crypto.randomUUID(),name:'Mehl',amount:200,unit:'g',componentId,checked:true,weightGrams:200,productBarcode:'12345678',nutritionPer100g:{protein:10},customIngredient:{keep:true}}],
      instructions:'Teig:\nMischen, dann backen.',links:['https://example.org/rezept'],prepMinutes:10,cookMinutes:20,restMinutes:0,finishedWeightGrams:850,difficulty:'Einfach',tags:['High Protein','Meal Prep'],favorite:true,
      nutrition:{energyKcal:123.45,energyKj:null,protein:22.1,salt:0},nutritionBasis:{unit:'servings',amount:2},nutritionVerified:true,nutritionCalculation:{source:'legacy'},products:[{barcode:'12345678',name:'Altprodukt'}],customFuture:{value:[1,'x',null]}};
  }
  try {
    await initialize(); adapter=createBackupAdapter();
    const png=await fixtureImage('image/png','#aabbcc'), jpg=await fixtureImage('image/jpeg','#775533');
    const originals=[recipe('Testbrot',png.path),recipe('Zweites Rezept',jpg.path),recipe('Ohne Bild'),recipe('Geteiltes Bild',png.path)];
    await write(originals);
    const initial=await adapter.snapshot();
    const archive=await B.create(initial.items);
    assert(archive.manifest.recipeCount===4 && archive.manifest.imageCount===2,'ZIP enthält vier Rezepte und zwei echte deduplizierte Bilddateien');
    const zipBytes=new Uint8Array(await archive.blob.arrayBuffer());
    const zip=fflate.unzipSync(zipBytes);
    assert(Object.keys(zip).length===5 && zip["images/"] && zip['manifest.json'] && zip['recipes.json'],'ZIP-Struktur mit Manifest, Rezepten und images/ geprüft');
    await fetch('/test-export',{method:'POST',body:archive.blob});
    let bundle=await B.inspect(file(archive.blob));
    assert((await B.inspect(file(new Blob([fflate.zipSync(zip,{level:6})])))).items.length===4,'Standard-DEFLATE-ZIP wird ebenfalls korrekt und begrenzt entpackt');
    assert(bundle.images.size===2 && bundle.items[2].image==='','ZIP vollständig validiert, Rezept ohne Bild unterstützt');
    assert(bundle.manifest.images.every(entry=>!entry.path.includes('http')),'Bildzuordnung verwendet portable Pfade');
    await write([]);
    let safety=0;
    let outcome=await B.restore(bundle,'replace',adapter,{safety:async backup=>{safety++;assert((await B.inspect(file(backup.blob))).items.length===0,'Leere Sammlung als vollständige Sicherheitskopie gesichert');return true;}});
    assert(safety===1 && outcome.importCount===4 && outcome.imageCount===2,'Vollständige Wiederherstellung nach Datenverlust');
    const restored=(await adapter.snapshot()).items;
    for(let i=0;i<originals.length;i++) {
      assert(B.same({...restored[i],image:originals[i].image},originals[i]),`Sämtliche Rezeptfelder erhalten: ${originals[i].title}`);
      if(restored[i].image) {
        const bytes=new Uint8Array(await(await fetch(restored[i].image)).arrayBuffer());
        const expected=i===1?jpg:png;
        assert(await B.hash(bytes)===expected.info.sha256,`Bildinhalt bytegenau erhalten: ${originals[i].title}`);
        assert((await B.imageInfo(bytes)).mime===expected.info.mime,`Wiederhergestelltes Bild lässt sich öffnen: ${originals[i].title}`);
      }
    }
    assert(restored[0].image===restored[3].image,'Geteilte Bilddatei nur einmal hochgeladen');
    const beforeMerge=await adapter.snapshot();
    const noUploads={...adapter,upload:async()=>{throw new Error('Darf nicht hochladen');}};
    outcome=await B.restore(bundle,'merge',noUploads);
    assert(outcome.importCount===0 && outcome.skipCount===4 && B.snapshotEqual(beforeMerge,await adapter.snapshot()),'Zusammenführen überspringt bestehende IDs ohne Upload/Überschreiben');
    const newRecipe=recipe('Neues Rezept',png.path);
    const newBundle=await B.inspect(file((await B.create([originals[0],newRecipe])).blob));
    const beforeNew=clone((await adapter.snapshot()).items);
    outcome=await B.restore(newBundle,'merge',adapter);
    const afterNew=(await adapter.snapshot()).items;
    assert(outcome.importCount===1 && outcome.skipCount===1 && outcome.imageCount===0 && afterNew.length===5 && B.same(afterNew.slice(0,4),beforeNew),'Zusammenführen fügt nur neue ID hinzu, verwendet vorhandenes identisches Bild und erhält Daten');
    await B.restore(bundle,'replace',adapter,{safety:async backup=>{const checked=await B.inspect(file(backup.blob));assert(checked.items.length===5 && checked.images.size===2,'Sicherheitskopie vor Ersetzen enthält den vollständigen aktuellen Bestand');return true;}});
    assert((await adapter.snapshot()).items.length===4,'Ersetzen entfernt ausschließlich Rezepte außerhalb des Backups');
    const beforeCancel=await adapter.snapshot();
    await rejects(()=>B.restore(bundle,'replace',adapter,{safety:async()=>false}),'Abbruch der Sicherheitskopie verhindert Ersetzen',/Keine Rezeptdaten/);
    assert(B.snapshotEqual(beforeCancel,await adapter.snapshot()),'Abgebrochene Wiederherstellung verändert keine Rezeptdaten');
    await rejects(()=>B.restore(bundle,'replace',adapter),'Ersetzen ohne Sicherheitskopie blockiert',/Sicherheitskopie/);
    const badExisting=[recipe('Defektes aktuelles Bild','images/nicht-vorhanden.png')];await write(badExisting);
    let wasCommitted=false;
    await rejects(()=>B.restore(bundle,'replace',{...adapter,commit:async()=>{wasCommitted=true;}},{safety:async()=>true}),'Fehlendes Bild der Sicherheitskopie blockiert destruktiven Import',/Defektes aktuelles Bild/);
    assert(!wasCommitted && B.same((await adapter.snapshot()).items,badExisting),'Bei fehlgeschlagener Sicherheitskopie bleibt Sammlung erhalten');
    await write([]);
    await rejects(()=>B.restore(bundle,'merge',{...adapter,upload:async()=>{throw new Error('Simulierter Uploadfehler');}}),'Uploadfehler wird ausdrücklich gemeldet',/Bild von/);
    assert((await adapter.snapshot()).items.length===0,'Uploadfehler vor Rezeptänderungen hält Sammlung unverändert');
    const stale=await adapter.snapshot();await write([recipe('Zwischenzeitlich hinzugefügt')]);
    await rejects(()=>B.restore(bundle,'merge',adapter,{expected:stale}),'Veraltete Vorschau wird verworfen',/seit der Vorschau/);
    await rejects(()=>adapter.commit(stale,[]),'Lokale If-Match-Prüfung verhindert Überschreiben',/zwischenzeitlich/);
    assert((await adapter.snapshot()).items.length===1,'Versionskonflikt verändert keine aktuelle Rezeptdatei');
    await rejects(()=>B.inspect(file(new Blob(['kein ZIP']))),'Ungültige ZIP-Datei zurückgewiesen');
    async function modified(change) {
      const entries=fflate.unzipSync(zipBytes);change(entries);return file(new Blob([fflate.zipSync(entries,{level:0})]));
    }
    await rejects(async()=>B.inspect(await modified(entries=>delete entries['manifest.json'])),'Fehlendes Manifest zurückgewiesen',/manifest/);
    await rejects(async()=>B.inspect(await modified(entries=>entries['manifest.json']=new TextEncoder().encode('{kaputt'))),'Beschädigtes Manifest-JSON zurückgewiesen',/JSON/);
    await rejects(async()=>B.inspect(await modified(entries=>{const m=JSON.parse(new TextDecoder().decode(entries['manifest.json']));m.version=999;entries['manifest.json']=new TextEncoder().encode(JSON.stringify(m));})),'Unbekannte Backupversion zurückgewiesen',/version/);
    await rejects(async()=>B.inspect(await modified(entries=>delete entries[bundle.manifest.images[0].path])),'Fehlendes eingebettetes Bild zurückgewiesen',/Bild fehlt/);
    await rejects(async()=>B.inspect(await modified(entries=>entries[bundle.manifest.images[0].path][20]^=1)),'Manipuliertes Bild zurückgewiesen');
    await rejects(async()=>B.inspect(await modified(entries=>entries['../outside.txt']=new Uint8Array([1]))),'ZIP-Path-Traversal zurückgewiesen',/Pfad/);
    const imagePaths=Object.keys(zip).filter(path=>path.endsWith('.png')||path.endsWith('.jpg'));
    const duplicateZip=zipBytes.slice(), oldName=new TextEncoder().encode(imagePaths[1]), newName=new TextEncoder().encode(imagePaths[0]);
    for(let offset=0;offset<=duplicateZip.length-oldName.length;offset++) if(oldName.every((byte,i)=>duplicateZip[offset+i]===byte)) duplicateZip.set(newName,offset);
    await rejects(()=>B.inspect(file(new Blob([duplicateZip]))),'Doppelte ZIP-Dateinamen zurückgewiesen',/doppelter ZIP-Pfad/);

    await rejects(async()=>B.inspect(await modified(entries=>entries['images/a/../../x.png']=png.bytes)),'Verschachtelte unsichere Bildpfade zurückgewiesen',/Pfad/);
    await rejects(async()=>B.inspect(await modified(entries=>entries['recipes.json']=new TextEncoder().encode('{broken'))),'Beschädigte Rezeptdaten zurückgewiesen');
    await rejects(async()=>B.inspect(await modified(entries=>{const m=JSON.parse(new TextDecoder().decode(entries['manifest.json']));delete m.createdAt;entries['manifest.json']=new TextEncoder().encode(JSON.stringify(m));})),'Fehlende Pflichtinformationen zurückgewiesen');
    await rejects(()=>B.create([originals[0],originals[0]]),'Doppelte Rezept-ID zurückgewiesen',/Doppelte/);
    const duplicateRecipeBytes=new TextEncoder().encode(JSON.stringify([bundle.items[0],bundle.items[0]]));
    const duplicateManifest={...bundle.manifest,recipeSha256:await B.hash(duplicateRecipeBytes),recipeCount:2};
    await rejects(async()=>B.inspect(await modified(entries=>{entries['recipes.json']=duplicateRecipeBytes;entries['manifest.json']=new TextEncoder().encode(JSON.stringify(duplicateManifest));})),'Doppelte Rezept-ID auch beim ZIP-Import zurückgewiesen',/Doppelte/);
    const bomb=fflate.zipSync({'manifest.json':new Uint8Array(2*1024*1024)},{level:9});
    await rejects(()=>B.inspect(file(new Blob([bomb]))),'Übermäßige Entpackgröße/Kompressionsverhältnis zurückgewiesen',/Grenzen/);
    await rejects(()=>B.inspect({size:B.LIMITS.archive+1}),'ZIP-Dateigrößenlimit vor Dateizugriff geprüft',/210/);
    await rejects(()=>B.imageInfo(new TextEncoder().encode('<svg onload="alert(1)">')),'SVG/aktive Bildinhalte nicht zugelassen',/Bildformat/);
    await rejects(()=>B.imageInfo(new Uint8Array([137,80,78,71,13,10,26,10])),'Beschädigte Bilddatei zurückgewiesen');
    await rejects(()=>B.create([{...originals[0],access_token:'secret'}]),'Geheime Felder werden nicht exportiert',/geheimes/);
    await rejects(()=>B.inspect(new File(['{"format":"kuechenbuch-backup","version":2}'],'legacy.json')),'Unbekanntes Legacy-Format zurückgewiesen');
    const old=clone(originals[0]);old.id=crypto.randomUUID();old.ingredients=['200 g Mehl'];delete old.tags;delete old.favorite;delete old.prepMinutes;delete old.components;
    const legacy=await B.inspect(new File([JSON.stringify({format:'kuechenbuch-backup',version:1,recipeCount:1,recipes:[old]})],'legacy.json'));
    assert(legacy.legacy && legacy.images.size===0 && legacy.warnings[0].includes('keine eingebetteten'),'Legacy-JSON ausdrücklich als unvollständig bezüglich Bilder gekennzeichnet');
    await write([]);await B.restore(legacy,'merge',adapter);
    const importedLegacy=(await adapter.snapshot()).items[0];
    assert(importedLegacy.nutritionBasis.amount===2 && importedLegacy.ingredients[0]==='200 g Mehl' && (await B.imageInfo(new Uint8Array(await(await fetch(importedLegacy.image)).arrayBuffer()))).mime==='image/png','Legacy-Import erhält alte Struktur/Bezugsmenge und speichert erreichbares Bild neu');
    const emptyBackup=await B.inspect(file((await B.create([])).blob));assert(emptyBackup.items.length===0 && emptyBackup.images.size===0 && fflate.unzipSync(new Uint8Array(await (await B.create([])).blob.arrayBuffer()))['images/'],'Leere Sammlung als gültiges ZIP mit leerem Bilderordner unterstützt');
    // Exercise the actual restore dialog, including the mandatory download gate.
    let downloaded=[];downloadBackupBlob=(blob,name)=>downloaded.push({blob,name});
    await inspectBackupFile(file(archive.blob));
    assert(document.querySelector('#restoreModal').open && document.querySelector('#restorePreviewText').textContent.includes('4 Rezepte'),'Importvorschau zeigt Rezeptanzahl und wartet auf Bestätigung');
    document.querySelector('#restoreMode').value='replace';updateRestorePreview();
    await runRestore();assert(document.querySelector('#restoreResult').textContent.includes('ausdrücklich'),'Zusätzliche ausdrückliche Bestätigung für Ersetzen erforderlich');
    document.querySelector('#replaceConfirm').checked=true;
    const running=runRestore();
    for(let i=0;i<100 && document.querySelector('#restoreSafety').hidden;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert(!document.querySelector('#restoreSafety').hidden && backupBusy && document.querySelector('#safetyContinue').disabled,'Import pausiert vor Datenänderung bis Sicherheitskopie heruntergeladen wurde');
    document.querySelector('#safetyDownload').click();
    assert(downloaded.length===1 && (await B.inspect(file(downloaded[0].blob))).items.length===1,'Sicherheitskopie tatsächlich zum Download angeboten und gültig');
    document.querySelector('#safetyReceived').checked=true;document.querySelector('#safetyReceived').dispatchEvent(new Event('change'));
    document.querySelector('#safetyContinue').click();await running;
    assert(!backupBusy && document.querySelector('#restoreResult').textContent.includes('vollständig geprüft'),'UI-Wiederherstellung nach Downloadbestätigung erfolgreich');
    document.querySelector('#restoreModal').close();
    // In-memory Supabase simulator, never connected to the real account.
    let database=new Map(), mutation=0, failMutation=0, ambiguous=false;
    const q=kind=>({kind,filters:[],values:null,eq(key,value){this.filters.push([key,value]);return this;},order(){return this;},range(start,end){this.start=start;this.end=end;return this;},select(){return this;},
      insert(values){this.kind='insert';this.values=values;return this;},update(values){this.kind='update';this.values=values;return this;},delete(){this.kind='delete';return this;},
      then(resolve,reject){return this.execute().then(resolve,reject);},async execute(){
        const matches=[...database.values()].filter(row=>this.filters.every(([key,value])=>row[key]===value));
        if(this.kind==='read')return{data:clone(this.start===undefined?matches:matches.slice(this.start,this.end+1)),error:null};
        mutation++;if(mutation===failMutation && !ambiguous)return{data:null,error:{message:'simulierter Schreibfehler'}};
        let data=[];
        if(this.kind==='insert'){if(database.has(this.values.id))return{error:{message:'duplicate key'},data:[]};database.set(this.values.id,clone(this.values));data=[this.values];}
        else for(const row of matches){if(this.kind==='delete'){database.delete(row.id);data.push(row);}else{database.set(row.id,clone(this.values));data.push(this.values);}}
        if(mutation===failMutation && ambiguous)throw new Error('Antwort nach Schreiben verloren');
        return{data:clone(data),error:null};
      }});
    const mock={from:()=>q('read')};
    const cloudOriginals=[recipe('Alt A'),recipe('Alt B')];
    const seed=()=>{database=new Map(cloudOriginals.map((data,i)=>[data.id,{id:data.id,data:clone(data),updated_at:`2020-01-0${i+1}T00:00:00Z`,updated_by:'original-user'}]));mutation=0;};
    supabaseClient=mock;storageMode='cloud';adapter=createBackupAdapter();
    seed();const cloudBefore=await adapter.snapshot();const cloudBundle=await B.inspect(file((await B.create([{...cloudOriginals[0],title:'Geändert'},recipe('Neu')])).blob));
    failMutation=0;await B.restore(cloudBundle,'replace',adapter,{safety:async()=>true});assert(database.size===2 && !database.has(cloudOriginals[1].id),'Cloud-Ersetzen per simulierten versionierten Einzelschritten');
    seed();failMutation=2;ambiguous=false;
    await rejects(()=>B.restore(cloudBundle,'replace',adapter,{safety:async()=>true}),'Cloud-Schreibfehler löst Rücknahme aus',/zurückgenommen/);
    assert(B.snapshotEqual(cloudBefore,await adapter.snapshot()),'Cloud-Rollback stellt Daten und Versionen des Ausgangszustands wieder her');
    seed();failMutation=2;ambiguous=true;
    await rejects(()=>B.restore(cloudBundle,'replace',adapter,{safety:async()=>true}),'Verlorene Schreibantwort wird vor Rücknahme aufgeklärt',/zurückgenommen/);
    assert(B.snapshotEqual(cloudBefore,await adapter.snapshot()),'Rollback berücksichtigt trotz verlorener Antwort gespeichertes Rezept');
    // Force verification failure after the delete stage, then restore deleted rows.
    seed();failMutation=0;ambiguous=false;
    // commit itself verifies with the real adapter; inject one read failure after delete.
    const originalFrom=mock.from;let rejectNextRead=false;
    mock.from=()=>{const query=originalFrom();const execute=query.execute;query.execute=async function(){if(this.kind==='read' && rejectNextRead){rejectNextRead=false;return{error:{message:'Test-Abschlussfehler'},data:null};}const result=await execute.call(this);if(this.kind==='delete' && mutation===3)rejectNextRead=true;return result;};return query;};
    await rejects(()=>B.restore(cloudBundle,'replace',adapter,{safety:async()=>true}),'Fehler nach Löschschritt stellt auch entfernte Rezepte wieder her',/zurückgenommen/);
    assert(B.snapshotEqual(cloudBefore,await adapter.snapshot()),'Rollback nach Löschung enthält die gesamte ursprüngliche Sammlung');mock.from=originalFrom;
    backupBusy=true;const count=database.size;assert(await refreshRecipesFromCloud()===false && database.size===count,'Automatische Cloud-Aktualisierung pausiert während Import');backupBusy=false;
    // A delayed refresh from before the import must not apply after the lock ends.
    const savedFrom=mock.from;let resolveRefresh;
    const delayed=new Promise(resolve=>{resolveRefresh=resolve;});
    mock.from=()=>({select:()=>({order:()=>({range:()=>delayed})})});
    const beforeRefresh=clone(recipes), refreshing=refreshRecipesFromCloud();
    await withBackupLock(async()=>{});
    resolveRefresh({data:[{id:'stale',data:recipe('Veraltete Daten'),updated_at:'old'}],error:null});
    assert(await refreshing===false && B.same(beforeRefresh,recipes),'Bereits laufende veraltete Cloud-Abfrage wird auch nach Ende des Imports verworfen');mock.from=savedFrom;
    seed();const cloudBeforeUploads=await adapter.snapshot();let storageCalls=[],uploadFails=false;const storageUrls=new Map();
    mock.storage={from:bucket=>({upload:async(path,blob,options)=>{if(uploadFails)return{error:{message:'Storage-Testfehler'}};storageCalls.push({bucket,path,options});const response=await fetch('/api/image',{method:'POST',headers:{'Content-Type':blob.type},body:blob});storageUrls.set(path,(await response.json()).path);return{error:null};},getPublicUrl:path=>({data:{publicUrl:storageUrls.get(path)}})})};
    const cloudWithImage=await B.inspect(file((await B.create([recipe('Cloud-Bild',png.path)])).blob));
    outcome=await B.restore(cloudWithImage,'merge',adapter);
    assert(outcome.imageCount===1 && storageCalls[0].bucket==='recipe-images' && storageCalls[0].path.startsWith('public/restore-') && storageCalls[0].options.upsert===false,'Simulierter Supabase-Bildupload verwendet Bucket, öffentlichen Pfad und kollisionsfreien Upload');
    seed();uploadFails=true;
    await rejects(()=>B.restore(cloudWithImage,'merge',adapter),'Supabase-Storage-Fehler verhindert Rezeptimport',/Storage-Testfehler/);
    assert(B.snapshotEqual(cloudBeforeUploads,await adapter.snapshot()),'Fehlgeschlagener Cloud-Upload verändert keine Rezeptdaten');
    seed();failMutation=2;ambiguous=false;
    mock.from=()=>{const query=savedFrom();const execute=query.execute;query.execute=async function(){if(this.kind==='update' && mutation>=2)return{error:{message:'Rollback verweigert'},data:null};return execute.call(this);};return query;};
    await rejects(()=>B.restore(cloudBundle,'replace',adapter,{safety:async()=>true}),'Unvollständige Rücknahme wird ausdrücklich als unklarer Zustand gemeldet',/Rücknahme unvollständig/);mock.from=savedFrom;
    seed();failMutation=0;
    const template=recipe('Seitentest');
    database=new Map(Array.from({length:1001},(_,i)=>{const data={...template,id:`page-${String(i).padStart(4,'0')}`};return[data.id,{id:data.id,data,updated_at:'version'}];}));
    assert((await adapter.snapshot()).items.length===1001,'Cloud-Backupquelle liest mehr als 1.000 Rezepte vollständig seitenweise');
    assert(errors.length===0,'Keine JavaScript-Fehler oder unbehandelten Promise-Fehler');
    await fetch('/test-result',{method:'POST',body:`PASS ${results.length}\n${results.join('\n')}`});
  }catch(error){await fetch('/test-result',{method:'POST',body:`FAIL ${error.stack}\n${results.join('\n')}\nBrowserfehler: ${errors.join('; ')}`});}
})();
