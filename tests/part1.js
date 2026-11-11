(async () => {
  const results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); results.push(message); };
  const input = (id, value, type = 'input') => { const el = document.querySelector(id); el.value = value; el.dispatchEvent(new Event(type, { bubbles: true })); };
  const submit = async () => { recipeForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await waitFor(() => !recipeModal.open); };
  const waitFor = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timeout'); };
  const alerts = [];
  window.alert = message => alerts.push(message);
  window.confirm = () => true;
  try {
    await initialize();
    assert(storageMode === 'file' && !supabaseClient, 'Lokaler Speicher ohne Cloud');
    assert(optionalNumber('') === null && optionalNumber(null) === null && optionalNumber(0) === 0, 'Fehlend und Null unterschieden');
    assert(totalDuration({}) === null && totalDuration({ prepMinutes: 0 }) === 0, 'Zeiten: fehlend und 0 korrekt');
    assert(normalizeTags([' High  Protein ', 'high protein', 'Meal Prep']).length === 2, 'Tags normalisiert und dedupliziert');
    openForm();
    input('#titleInput', 'Test Pasta');
    input('#categoryInput', 'Hauptspeise', 'change');
    input('#prepMinutesInput', '10'); input('#cookMinutesInput', '15'); input('#restMinutesInput', '0');
    input('#finishedWeightGramsInput', '850'); input('#difficultyInput', 'Einfach', 'change');
    input('#tagInput', 'High Protein'); addFormTag(); input('#tagInput', ' high  protein '); addFormTag();
    input('#tagInput', 'Meal Prep'); addFormTag();
    document.querySelector('#formTags button').click();
    assert(formTags.length === 1 && formTags[0] === 'Meal Prep', 'Tags einzeln entfernt');
    input('#tagInput', 'High Protein'); addFormTag();
    input('.ingredient-name-input', 'Mehl'); input('.ingredient-amount-input', '200');
    input('#energyKcalInput', '123.456'); input('#saltInput', '0');
    document.querySelector('#nutritionConfirmedInput').checked = true;
    await submit();
    let item = recipes[0];
    assert(item.prepMinutes === 10 && item.restMinutes === 0 && item.finishedWeightGrams === 850 && item.tags.length === 2, 'Informationen und Tags gespeichert');
    assert(item.nutrition.energyKcal === 123.456 && item.nutrition.salt === 0 && item.nutrition.protein === null, 'Manuelle Nährwerte: Präzision, 0 und leer');
    assert(!needsNutritionReview(item) && needsNutritionReview({ nutrition: { protein: 3 } }), 'Alte Nährwerte benötigen Bestätigung');
    openDetail(item.id);
    const nutritionBefore = document.querySelector('.nutrition-table').textContent;
    input('#detailServingsInput', '8');
    assert(document.querySelector('.scaled-ingredient-label').textContent.includes('400 g'), 'Portionsanpassung skaliert Zutaten');
    assert(document.querySelector('.nutrition-table').textContent === nutritionBefore, 'Nährwerte bleiben bei Portionsanpassung gleich');
    detailModal.close();
    document.querySelector('.card-favorite').click(); await waitFor(() => !favoriteWrites.size);
    assert(recipes[0].favorite && !detailModal.open, 'Kartenherz speichert ohne Detailöffnung');
    await initialize(); item = recipes[0];
    assert(item.favorite && item.tags.length === 2 && item.nutrition.energyKcal === 123.456, 'Favoriten und Daten nach erneutem Laden erhalten');
    const frame = document.createElement('iframe'); frame.src='/reload.html'; document.body.append(frame);
    await waitFor(() => frame.contentDocument?.body?.dataset.favorite === 'true');
    frame.contentWindow.location.reload();
    await new Promise(resolve => setTimeout(resolve, 100));
    await waitFor(() => frame.contentDocument?.body?.dataset.favorite === 'true');
    assert(frame.contentDocument.body.dataset.favorite === 'true', 'Favorit nach echtem Neuladen eines Browserdokuments erhalten'); frame.remove();

    openDetail(item.id); document.querySelector('[data-action="favorite"]').click(); await waitFor(() => !favoriteWrites.size);
    assert(!recipes[0].favorite && document.querySelector('[data-action="favorite"]').getAttribute('aria-pressed') === 'false', 'Detailherz entfernt Favorit');
    detailModal.close();
    const originalFetch = window.fetch;
    window.fetch = async () => ({ok:false});
    document.querySelector('.card-favorite').click(); await waitFor(() => !favoriteWrites.size);
    assert(!recipes[0].favorite && alerts.length > 0, 'Fehlgeschlagener Favorit bleibt unverändert');
    window.fetch = originalFetch;
    const old = { ...recipes[0], favorite: true, unknown: { keep: 1 }, products: [{barcode:'12345678'}], nutritionCalculation: {source:'legacy'}, nutritionBasis:{unit:'servings',amount:2} };
    old.ingredients[0].legacy = 'keep'; old.ingredients[0].nutritionPer100g = {protein:10}; old.components[0].legacy = true;
    recipes = [old];
    openForm(old); await submit(); item = recipes[0];
    assert(item.unknown.keep === 1 && item.products[0].barcode === '12345678' && item.ingredients[0].legacy === 'keep' && item.components[0].legacy, 'Legacy- und unbekannte Daten bleiben beim Speichern erhalten');
    assert(item.nutritionBasis.amount === 2 && item.nutritionCalculation.source === 'legacy', 'Alte Bezugsmenge und Metadaten bleiben erhalten');
    activeCategory='Hauptspeise'; selectedTags=['Meal Prep','High Protein']; maxDuration=30; difficultyFilter='Einfach'; favoritesOnly=true; searchTerm='Mehl';
    assert(matchesFilters(item), 'Alle Filter und Zutatensuche kombinierbar');
    assert(!matchesFilters({...item,tags:['High Protein']}) && !matchesFilters({...item,prepMinutes:null,cookMinutes:null,restMinutes:null}) && !matchesFilters({...item,favorite:false}) && !matchesFilters({...item,difficulty:'Mittel'}), 'Filter schließen fehlende Tags, Zeit, Favorit und falsche Schwierigkeit aus');
    document.querySelector('#resetFiltersButton').click();
    assert(selectedTags.length === 0 && maxDuration === null && !favoritesOnly && searchTerm === '' && activeCategory === 'Alle', 'Filter zurückgesetzt');
    const copy = createIndependentRecipeCopy(item);
    assert(!copy.favorite && copy.id !== item.id && copy.ingredients[0].id !== item.ingredients[0].id, 'Duplikat unabhängig und kein Favorit');
    await duplicateRecipe(item, document.createElement('button')); assert(recipes.length===2 && recipeModal.open, 'Duplizieren speichert Kopie'); closeForm();
    sortMode='title_desc'; render(); assert(recipeGrid.firstElementChild.dataset.id === [...recipes].sort((a,b)=>b.title.localeCompare(a.title,'de',{sensitivity:'base'}))[0].id, 'Sortierung Z–A');
    sortMode='title_asc'; render(); assert(recipeGrid.firstElementChild.dataset.id === [...recipes].sort((a,b)=>a.title.localeCompare(b.title,'de',{sensitivity:'base'}))[0].id, 'Sortierung A–Z');
    await deleteRecipe(recipes.find(r=>r.id!==item.id)); assert(recipes.length===1, 'Rezept löschen');
    currentUser=null; storageMode='published';
    const before = JSON.stringify(recipes); document.querySelector('.card-favorite').click();
    assert(document.querySelector('#authModal').open && JSON.stringify(recipes)===before, 'Besucher dürfen Favoriten nicht ändern');
    assert(!document.querySelector('#barcodeInput, #calculateNutritionButton, .shopping-check, .ingredient-weight-input'), 'Entfernte Funktionen fehlen im DOM');
    document.querySelector('#authModal').close(); storageMode='file';
    const fixtures = await (await fetch('/legacy-fixtures.json')).json();
    recipes = JSON.parse(JSON.stringify(fixtures)); normalizeAllRecipes();
    for (const fixture of fixtures) {
      openForm(recipes.find(r => r.id === fixture.id)); await submit();
      const saved = recipes.find(r => r.id === fixture.id);
      assert(JSON.stringify(saved.nutrition) === JSON.stringify(fixture.nutrition) && JSON.stringify(saved.products) === JSON.stringify(fixture.products) && saved.ingredients.length === fixture.ingredients.length && saved.servings === (fixture.servings ?? null), `Bestandsrezept ohne Verlust geöffnet/gespeichert: ${fixture.title}`);
      fixture.ingredients.forEach((ingredient, i) => { if (typeof ingredient === 'object') Object.keys(ingredient).forEach(key => { if (JSON.stringify(saved.ingredients[i][key]) !== JSON.stringify(ingredient[key])) throw new Error(`Zutat verändert: ${fixture.title} ${key}`); }); });
    }
    const cloudRows = [];
    currentUser={id:'test-user'}; storageMode='cloud';
    let cloudError=null, cloudEmpty=false;
    supabaseClient={auth:{getUser:async()=>({data:{user:currentUser}})},from:()=>({
      insert:row=>({select:async()=>{cloudRows.push(row);return {data:[{updated_at:'test-version'}]};}}),
      update:row=>{ const query={eq:()=>query,select:async()=>{cloudRows.push(row);return {error:cloudError,data:cloudEmpty?[]:[{updated_at:'test-version-2'}]};}};return query;},
      delete:()=>{const query={eq:()=>query,select:async()=>({data:[{id:'test'}]})};return query;}
    })};
    await saveRecipeToCloud({id:'test',favorite:true},{isNew:true});
    await saveRecipeToCloud({id:'test',favorite:false},{expectedVersion:'test-version'});
    assert(cloudRows.length===2 && recipeVersions.get('test')==='test-version-2', 'Cloud-Insert/Update mit Mock bestätigt');
    cloudError={message:'Testfehler'};
    let rejected=false; try { await saveRecipeToCloud({id:'test'}); } catch { rejected=true; }
    assert(rejected, 'Cloud-Speicherfehler wird zurückgemeldet'); cloudError=null; cloudEmpty=true;
    rejected=false; try { await saveRecipeToCloud({id:'test'},{expectedVersion:'old'}); } catch { rejected=true; }
    assert(rejected, 'Cloud-Versionskonflikt wird zurückgemeldet');
    await deleteRecipeFromCloud({id:'test'}); assert(!recipeVersions.has('test'), 'Cloud-Löschen mit Mock bestätigt');

    document.body.innerHTML = `<pre id="test-result">PASS ${results.length}\n${results.join('\n')}</pre>`;
  } catch(error) { document.body.innerHTML = `<pre id="test-result">FAIL ${error.stack}\n${results.join('\n')}</pre>`; }
  await fetch('/test-result', {method:'POST',body:document.querySelector('#test-result').textContent});
})();
