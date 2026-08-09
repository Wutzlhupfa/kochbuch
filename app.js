const STORAGE_KEY = "kuechenbuch-recipes-v1";
const SUPABASE_URL = "https://ohdamaixedupjivfobsv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_65F5g7J7EJ0LzAqxchLKCA_6j9K31yM";
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
let recipes = [];
let storageMode = "checking";
let currentUser = null;
let activeCategory = "Alle";
let searchTerm = "";
let formProducts = [];
let formIngredients = [];
let formCalculation = null;
let formComponents = [];
let scannerStream = null;
let scannerAnimationFrame = null;
let lastScanAttempt = 0;
let formImage = "";
let pendingImageFile = null;
let imagePreviewObjectUrl = "";

const recipeGrid = document.querySelector("#recipeGrid");
const emptyState = document.querySelector("#emptyState");
const recipeModal = document.querySelector("#recipeModal");
const detailModal = document.querySelector("#detailModal");
const recipeForm = document.querySelector("#recipeForm");

function loadBrowserBackup() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

function setStorageStatus(mode, message) {
  storageMode = mode;
  const status = document.querySelector("#storageStatus");
  document.querySelector("#storageStatusText").textContent = message;
  status.classList.toggle("browser-storage", ["browser", "error", "published"].includes(mode));
}

function updateAuthInterface() {
  const authButton = document.querySelector("#authButton");
  const authUser = document.querySelector("#authUser");
  authButton.textContent = currentUser ? "Abmelden" : "Anmelden";
  authUser.textContent = currentUser?.email || "Nicht angemeldet";
}

function openAuth() {
  document.querySelector("#authError").textContent = "";
  const modal = document.querySelector("#authModal");
  if (!modal.open) modal.showModal();
  setTimeout(() => document.querySelector("#authEmail").focus(), 50);
}

function closeAuth() {
  document.querySelector("#authModal").close();
}

function ensureCanEdit() {
  if (currentUser) return true;
  openAuth();
  return false;
}

async function loadPublishedRecipes() {
  const response = await fetch("data/recipes.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Veröffentlichte Sammlung nicht gefunden");
  return response.json();
}

async function loadRecipes() {
  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from("recipes")
        .select("data, updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      if (data.length) {
        recipes = data.map(row => row.data);
        setStorageStatus("cloud", currentUser
          ? "Zentral in Supabase gespeichert"
          : "Zentrale Sammlung · zum Bearbeiten anmelden");
        return;
      }

      recipes = await loadPublishedRecipes();
      if (currentUser && recipes.length) {
        await saveRecipes();
        setStorageStatus("cloud", "Bestehende Sammlung nach Supabase importiert");
      } else {
        setStorageStatus("published", "Veröffentlichte Sammlung · zum Importieren anmelden");
      }
      return;
    } catch (error) {
      console.error("Supabase konnte nicht geladen werden:", error);
    }
  }

  try {
    recipes = await loadPublishedRecipes();
    setStorageStatus("published", "Veröffentlichte Sammlung · Cloud nicht erreichbar");
    return;
  } catch {
    recipes = loadBrowserBackup();
    setStorageStatus("browser", "Cloud nicht erreichbar · Browser-Sicherung geladen");
  }
}

async function saveRecipes() {
  if (supabaseClient && currentUser) {
    const rows = recipes.map(recipe => ({
      id: recipe.id,
      data: recipe,
      updated_at: new Date().toISOString(),
      updated_by: currentUser.id
    }));
    const { data: existing, error: readError } = await supabaseClient.from("recipes").select("id");
    if (readError) throw new Error(`Cloud-Speicher konnte nicht gelesen werden: ${readError.message}`);
    if (rows.length) {
      const { error } = await supabaseClient.from("recipes").upsert(rows, { onConflict: "id" });
      if (error) throw new Error(`Cloud-Speichern fehlgeschlagen: ${error.message}`);
    }
    const currentIds = new Set(rows.map(row => row.id));
    const deletedIds = (existing || []).map(row => row.id).filter(id => !currentIds.has(id));
    if (deletedIds.length) {
      const { error } = await supabaseClient.from("recipes").delete().in("id", deletedIds);
      if (error) throw new Error(`Cloud-Löschen fehlgeschlagen: ${error.message}`);
    }
    localStorage.removeItem(STORAGE_KEY);
    setStorageStatus("cloud", "Zentral in Supabase gespeichert");
    return true;
  }

  if (supabaseClient && !currentUser) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes));
    setStorageStatus("browser", "Nicht angemeldet · Änderung nur im Browser gesichert");
    openAuth();
    return false;
  }

  try {
    const response = await fetch("/api/recipes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(recipes)
    });
    if (!response.ok) throw new Error("Speichern fehlgeschlagen");
    localStorage.removeItem(STORAGE_KEY);
    setStorageStatus("file", "Sicher im Programmordner gespeichert");
    return true;
  } catch {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes));
    setStorageStatus("browser", "Nur im Browser gespeichert – bitte server.py starten");
    alert("Der Programmordner ist gerade nicht erreichbar. Das Rezept wurde vorsichtshalber nur im Browser gespeichert. Starte die Website mit server.py, damit es in data/recipes.json geschrieben wird.");
    return false;
  }
}

function escapeHtml(value = "") {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[character]);
}

function validUrl(value) {
  try {
    if (!value) return null;
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function clearPreviewObjectUrl() {
  if (imagePreviewObjectUrl) URL.revokeObjectURL(imagePreviewObjectUrl);
  imagePreviewObjectUrl = "";
}

function updateImagePreview() {
  const field = document.querySelector("#imagePreviewField");
  const preview = document.querySelector("#imagePreview");
  clearPreviewObjectUrl();
  let source = validUrl(formImage);
  if (pendingImageFile) {
    imagePreviewObjectUrl = URL.createObjectURL(pendingImageFile);
    source = imagePreviewObjectUrl;
  }
  field.hidden = !source;
  if (source) preview.src = source;
  else preview.removeAttribute("src");
}

async function uploadPendingImage() {
  if (!pendingImageFile) return formImage;
  if (supabaseClient) {
    if (!currentUser) throw new Error("Bitte zuerst anmelden, um Bilder hochzuladen.");
    const extensionMap = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
    const extension = extensionMap[pendingImageFile.type];
    const uniqueId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const filename = `${currentUser.id}/recipe-${uniqueId}.${extension}`;
    const { error } = await supabaseClient.storage
      .from("recipe-images")
      .upload(filename, pendingImageFile, { contentType: pendingImageFile.type, upsert: false });
    if (error) throw new Error(`Bild konnte nicht hochgeladen werden: ${error.message}`);
    const { data } = supabaseClient.storage.from("recipe-images").getPublicUrl(filename);
    formImage = data.publicUrl;
    pendingImageFile = null;
    clearPreviewObjectUrl();
    return formImage;
  }
  const response = await fetch("/api/image", {
    method: "POST",
    headers: { "Content-Type": pendingImageFile.type || "application/octet-stream" },
    body: pendingImageFile
  });
  let result = {};
  try { result = await response.json(); } catch { /* Fehlermeldung folgt unten. */ }
  if (!response.ok || !result.path) {
    throw new Error(result.error || "Das Bild konnte nicht im Programmordner gespeichert werden.");
  }
  formImage = result.path;
  pendingImageFile = null;
  clearPreviewObjectUrl();
  return formImage;
}

const nutritionFields = {
  energyKj: "#energyKjInput",
  energyKcal: "#energyKcalInput",
  fat: "#fatInput",
  saturates: "#saturatesInput",
  carbs: "#carbsInput",
  sugars: "#sugarsInput",
  protein: "#proteinInput",
  salt: "#saltInput",
  fiber: "#fiberInput"
};

const nutritionLabels = {
  energyKj: ["Energie", "kJ"],
  energyKcal: ["Kalorien", "kcal"],
  fat: ["Fett", "g"],
  saturates: ["davon gesättigte Fettsäuren", "g"],
  carbs: ["Kohlenhydrate", "g"],
  sugars: ["davon Zucker", "g"],
  protein: ["Eiweiß", "g"],
  salt: ["Salz", "g"],
  fiber: ["Ballaststoffe", "g"]
};

function setNutritionValues(nutrition = {}) {
  Object.entries(nutritionFields).forEach(([key, selector]) => {
    const value = nutrition[key];
    document.querySelector(selector).value = value ?? "";
  });
}

function getNutritionValues() {
  return Object.fromEntries(Object.entries(nutritionFields).map(([key, selector]) => {
    const raw = document.querySelector(selector).value;
    return [key, raw === "" ? null : Number(raw)];
  }));
}

function hasNutritionValues(nutrition = {}) {
  return Object.values(nutrition).some(value => value !== null && value !== "" && value !== undefined);
}

const ingredientUnits = ["g", "kg", "ml", "l", "Stück", "EL", "TL", "Prise"];

function newIngredientId() {
  return crypto.randomUUID ? crypto.randomUUID() : `ingredient-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newComponentId() {
  return crypto.randomUUID ? crypto.randomUUID() : `component-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeComponent(value = {}) {
  return {
    id: value.id || newComponentId(),
    name: value.name || "Rezeptteil",
    instructions: value.instructions || ""
  };
}

function normalizeIngredient(value) {
  if (value && typeof value === "object") {
    return {
      id: value.id || newIngredientId(),
      name: value.name || "",
      amount: value.amount ?? "",
      unit: ingredientUnits.includes(value.unit) ? value.unit : "g",
      weightGrams: value.weightGrams ?? "",
      checked: Boolean(value.checked),
      nutritionPer100g: value.nutritionPer100g || null,
      nutritionSource: value.nutritionSource || "",
      nutritionMatches: value.nutritionMatches || [],
      productBarcode: value.productBarcode || "",
      componentId: value.componentId || ""
    };
  }
  const text = String(value || "").trim();
  const match = text.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|EL|TL|Stück|Prise)?\s+(.+)$/i);
  if (!match) return { id: newIngredientId(), name: text, amount: "", unit: "g", weightGrams: "", checked: false, nutritionPer100g: null, nutritionSource: "", nutritionMatches: [], productBarcode: "", componentId: "" };
  const enteredUnit = match[2] || "Stück";
  const unit = ingredientUnits.find(item => item.toLowerCase() === enteredUnit.toLowerCase()) || "Stück";
  return { id: newIngredientId(), name: match[3], amount: Number(match[1].replace(",", ".")), unit, weightGrams: "", checked: false, nutritionPer100g: null, nutritionSource: "", nutritionMatches: [], productBarcode: "", componentId: "" };
}

function normalizeAllRecipes() {
  recipes.forEach(recipe => {
    if (!Array.isArray(recipe.components) || !recipe.components.length) {
      recipe.components = [normalizeComponent({ name: "Allgemein", instructions: recipe.instructions || "" })];
    } else {
      recipe.components = recipe.components.map(normalizeComponent);
    }
    recipe.ingredients = (recipe.ingredients || []).map(normalizeIngredient);
    const fallbackComponentId = recipe.components[0].id;
    recipe.ingredients.forEach(ingredient => {
      if (!recipe.components.some(component => component.id === ingredient.componentId)) ingredient.componentId = fallbackComponentId;
    });
  });
}

function ingredientWeight(ingredient) {
  const explicitWeight = Number(ingredient.weightGrams);
  if (explicitWeight > 0) return explicitWeight;
  const amount = Number(ingredient.amount);
  if (!(amount > 0)) return null;
  if (ingredient.unit === "g") return amount;
  if (ingredient.unit === "kg") return amount * 1000;
  if (ingredient.unit === "ml") return amount;
  if (ingredient.unit === "l") return amount * 1000;
  return null;
}

function ingredientLabel(ingredient) {
  const item = normalizeIngredient(ingredient);
  const amount = item.amount !== "" ? `${String(item.amount).replace(".", ",")} ${item.unit} ` : "";
  return `${amount}${item.name}`.trim();
}

function addIngredient(initial = {}) {
  const ingredient = normalizeIngredient(initial);
  if (!ingredient.componentId) ingredient.componentId = formComponents[0]?.id || "";
  formIngredients.unshift(ingredient);
  renderIngredientRows();
}

function addComponent() {
  formComponents.push(normalizeComponent({ name: `Rezeptteil ${formComponents.length + 1}` }));
  renderComponentRows();
  renderIngredientRows();
}

function renderComponentRows() {
  const container = document.querySelector("#componentRows");
  container.replaceChildren();
  formComponents.forEach((component, index) => {
    const row = document.createElement("article");
    row.className = "component-row";
    row.innerHTML = `
      <label>Name des Rezeptteils<input class="component-name-input" type="text" value="${escapeHtml(component.name)}" placeholder="z. B. Teig (optional)"></label>
      <label>Anleitung<textarea class="component-instructions-input" rows="4" placeholder="Zubereitung für diesen Teil … (optional)">${escapeHtml(component.instructions)}</textarea></label>
      <button class="component-remove" type="button" aria-label="Rezeptteil entfernen" ${formComponents.length === 1 ? "disabled" : ""}>×</button>`;
    row.querySelector(".component-name-input").addEventListener("input", event => { component.name = event.target.value; });
    row.querySelector(".component-name-input").addEventListener("change", renderIngredientRows);
    row.querySelector(".component-instructions-input").addEventListener("input", event => { component.instructions = event.target.value; });
    row.querySelector(".component-remove").addEventListener("click", () => {
      if (formComponents.length === 1) return;
      const fallbackId = formComponents.find(item => item.id !== component.id).id;
      formIngredients.forEach(ingredient => { if (ingredient.componentId === component.id) ingredient.componentId = fallbackId; });
      formComponents.splice(index, 1);
      renderComponentRows();
      renderIngredientRows();
    });
    container.append(row);
  });
}

function renderIngredientRows() {
  const container = document.querySelector("#ingredientRows");
  container.replaceChildren();
  const groupContainers = new Map();
  formComponents.forEach(component => {
    const group = document.createElement("section");
    group.className = "ingredient-group";
    group.innerHTML = `<div class="ingredient-group-heading"><h4>${escapeHtml(component.name)}</h4><button class="secondary-button compact-button" type="button">＋ Zutat für ${escapeHtml(component.name)}</button></div><div class="ingredient-group-rows"><p class="ingredient-group-empty">Noch keine Zutaten in diesem Rezeptteil.</p></div>`;
    group.querySelector("button").addEventListener("click", () => addIngredient({ componentId: component.id }));
    const rows = group.querySelector(".ingredient-group-rows");
    groupContainers.set(component.id, rows);
    container.append(group);
  });
  formIngredients.forEach((ingredient, index) => {
    const row = document.createElement("article");
    row.className = `ingredient-row${ingredient.checked ? " checked" : ""}`;
    const unitOptions = ingredientUnits.map(unit => `<option value="${unit}"${unit === ingredient.unit ? " selected" : ""}>${unit}</option>`).join("");
    const componentOptions = formComponents.map(component => `<option value="${escapeHtml(component.id)}"${component.id === ingredient.componentId ? " selected" : ""}>${escapeHtml(component.name)}</option>`).join("");
    const sourceText = ingredient.nutritionPer100g
      ? `${ingredient.nutritionSource || "Nährwerte vorhanden"}${ingredient.nutritionMatches?.length ? ` · Basis: ${ingredient.nutritionMatches.slice(0, 2).join(", ")}` : ""}`
      : "Noch keine Nährwerte zugeordnet";
    row.innerHTML = `
      <label class="ingredient-check-wrap"><span class="sr-only">Auf Einkaufsliste abhaken</span><input class="ingredient-check" type="checkbox" ${ingredient.checked ? "checked" : ""}></label>
      <label>Menge<input class="ingredient-amount-input" type="number" min="0" step="0.01" value="${escapeHtml(String(ingredient.amount ?? ""))}" placeholder="100"></label>
      <label>Einheit<select class="ingredient-unit-input">${unitOptions}</select></label>
      <label class="ingredient-name-field">Zutat<input class="ingredient-name-input" type="text" value="${escapeHtml(ingredient.name)}" placeholder="z. B. Mehl (optional)"></label>
      <label class="ingredient-weight-field">Gewicht g<input class="ingredient-weight-input" type="number" min="0" step="0.1" value="${escapeHtml(String(ingredient.weightGrams ?? ""))}" placeholder="auto"></label>
      <button class="ingredient-row-remove" type="button" aria-label="Zutat entfernen">×</button>
      <label class="ingredient-component-field">Gehört zu<select class="ingredient-component-input">${componentOptions}</select></label>
      <div class="ingredient-lookup"><p class="ingredient-lookup-status ${ingredient.nutritionPer100g ? "success" : ""}">${escapeHtml(sourceText)}</p><button class="ingredient-lookup-button" type="button">Nährwerte suchen</button></div>`;

    const update = (key, value) => { ingredient[key] = value; };
    row.querySelector(".ingredient-check").addEventListener("change", event => { update("checked", event.target.checked); row.classList.toggle("checked", event.target.checked); });
    row.querySelector(".ingredient-amount-input").addEventListener("input", event => update("amount", event.target.value === "" ? "" : Number(event.target.value)));
    row.querySelector(".ingredient-unit-input").addEventListener("change", event => update("unit", event.target.value));
    row.querySelector(".ingredient-name-input").addEventListener("input", event => {
      update("name", event.target.value);
      ingredient.nutritionPer100g = null;
      ingredient.nutritionSource = "";
      row.querySelector(".ingredient-lookup-status").textContent = "Zutat geändert – Nährwerte neu suchen";
      row.querySelector(".ingredient-lookup-status").className = "ingredient-lookup-status";
    });
    row.querySelector(".ingredient-weight-input").addEventListener("input", event => update("weightGrams", event.target.value === "" ? "" : Number(event.target.value)));
    row.querySelector(".ingredient-component-input").addEventListener("change", event => {
      update("componentId", event.target.value);
      renderIngredientRows();
    });
    row.querySelector(".ingredient-row-remove").addEventListener("click", () => { formIngredients.splice(index, 1); renderIngredientRows(); });
    row.querySelector(".ingredient-lookup-button").addEventListener("click", event => lookupIngredientNutrition(ingredient, event.target, row.querySelector(".ingredient-lookup-status")));
    const target = groupContainers.get(ingredient.componentId) || groupContainers.values().next().value;
    if (target) {
      target.querySelector(".ingredient-group-empty")?.remove();
      target.append(row);
    }
  });
}

async function lookupIngredientNutrition(ingredient, button = null, statusElement = null) {
  if (!ingredient.name.trim()) throw new Error("Bitte zuerst eine Zutat eingeben.");
  if (button) button.disabled = true;
  if (statusElement) { statusElement.textContent = "Durchschnittswerte werden gesucht …"; statusElement.className = "ingredient-lookup-status"; }
  try {
    const response = await fetch(`/api/ingredient?query=${encodeURIComponent(ingredient.name.trim())}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Keine Nährwerte gefunden.");
    ingredient.nutritionPer100g = result.nutrition;
    ingredient.nutritionSource = `${result.source} (${result.sampleCount} Treffer)`;
    ingredient.nutritionMatches = result.matches || [];
    if (statusElement) { statusElement.textContent = ingredient.nutritionSource; statusElement.className = "ingredient-lookup-status success"; }
    return true;
  } catch (error) {
    if (statusElement) { statusElement.textContent = error.message; statusElement.className = "ingredient-lookup-status error"; }
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

async function calculateRecipeNutrition() {
  const button = document.querySelector("#calculateNutritionButton");
  const summary = document.querySelector("#calculationSummary");
  const usableIngredients = formIngredients.filter(item => item.name.trim());
  if (!usableIngredients.length) {
    summary.textContent = "Bitte zuerst mindestens eine Zutat anlegen.";
    return;
  }
  const missingWeights = usableIngredients.filter(item => !ingredientWeight(item));
  if (missingWeights.length) {
    summary.textContent = `Gewicht fehlt bei: ${missingWeights.map(item => item.name).join(", ")}. Bei Stück/EL/TL bitte das Gewicht in Gramm ergänzen.`;
    return;
  }
  button.disabled = true;
  const missingNutrition = usableIngredients.filter(item => !item.nutritionPer100g);
  if (missingNutrition.length > 10) {
    summary.textContent = "Bitte zuerst bei einigen Zutaten einzeln auf „Nährwerte suchen“ klicken. Pro Minute sind höchstens zehn neue Internetsuchen möglich.";
    button.disabled = false;
    return;
  }
  const failed = [];
  for (let index = 0; index < missingNutrition.length; index += 1) {
    const ingredient = missingNutrition[index];
    summary.textContent = `Suche Nährwerte ${index + 1}/${missingNutrition.length}: ${ingredient.name} …`;
    try { await lookupIngredientNutrition(ingredient); }
    catch { failed.push(ingredient.name); }
  }
  renderIngredientRows();
  if (failed.length) {
    summary.textContent = `Keine Berechnung möglich. Es fehlen Nährwerte für: ${failed.join(", ")}. Bitte Bezeichnung präzisieren oder Werte über einen Barcode übernehmen.`;
    button.disabled = false;
    return;
  }

  const totalWeight = usableIngredients.reduce((sum, item) => sum + ingredientWeight(item), 0);
  const calculated = {};
  Object.keys(nutritionFields).forEach(key => {
    const contributions = usableIngredients
      .filter(item => item.nutritionPer100g?.[key] !== null && item.nutritionPer100g?.[key] !== undefined)
      .map(item => Number(item.nutritionPer100g[key]) * ingredientWeight(item) / 100);
    calculated[key] = contributions.length ? Math.round((contributions.reduce((sum, value) => sum + value, 0) / totalWeight * 100) * 100) / 100 : null;
  });
  setNutritionValues(calculated);
  formCalculation = {
    totalWeightGrams: Math.round(totalWeight * 10) / 10,
    ingredientCount: usableIngredients.length,
    calculatedAt: new Date().toISOString(),
    source: "Open Food Facts – gemittelte Produktwerte"
  };
  summary.textContent = `Berechnet aus ${usableIngredients.length} Zutaten und ${Math.round(totalWeight)} g Gesamtgewicht. Flüssigkeiten wurden näherungsweise mit 1 g/ml angesetzt.`;
  button.disabled = false;
}

function renderScannedProducts() {
  const container = document.querySelector("#scannedProducts");
  container.replaceChildren();
  formProducts.forEach((product, index) => {
    const item = document.createElement("article");
    item.className = "product-item";
    const imageUrl = validUrl(product.image);
    item.innerHTML = `
      ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : '<span class="product-placeholder">▦</span>'}
      <div><strong>${escapeHtml(product.name)}</strong><p>${escapeHtml(product.brand || `EAN ${product.barcode}`)}</p>${product.ingredientText ? `<p>Zutaten: ${escapeHtml(product.ingredientText)}</p>` : ""}</div>
      <button class="product-remove" type="button" aria-label="Produkt entfernen">×</button>`;
    item.querySelector(".product-remove").addEventListener("click", () => {
      formProducts.splice(index, 1);
      renderScannedProducts();
    });
    container.append(item);
  });
}

function setBarcodeStatus(message, isError = false) {
  const status = document.querySelector("#barcodeStatus");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function lookupBarcode() {
  const input = document.querySelector("#barcodeInput");
  const barcode = input.value.replace(/\D/g, "");
  input.value = barcode;
  if (!/^\d{8,14}$/.test(barcode)) {
    setBarcodeStatus("Bitte einen Barcode mit 8 bis 14 Ziffern eingeben.", true);
    return;
  }
  if (formProducts.some(product => product.barcode === barcode)) {
    setBarcodeStatus("Dieses Produkt wurde bereits hinzugefügt.", true);
    return;
  }

  const button = document.querySelector("#lookupBarcodeButton");
  button.disabled = true;
  setBarcodeStatus("Produktdaten werden geladen …");
  try {
    const response = await fetch(`/api/product?barcode=${encodeURIComponent(barcode)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Produkt wurde nicht gefunden.");
    formProducts.push(result);
    renderScannedProducts();
    addIngredient({
      name: result.name,
      amount: 100,
      unit: "g",
      nutritionPer100g: result.nutrition,
      nutritionSource: `Barcode ${result.barcode} · Open Food Facts`,
      nutritionMatches: [result.name],
      productBarcode: result.barcode
    });
    setBarcodeStatus(`${result.name} wurde als 100-g-Zutatenposition hinzugefügt. Passe die verwendete Menge bei Bedarf an.`);
    input.value = "";
  } catch (error) {
    setBarcodeStatus(error.message || "Produktdaten konnten nicht geladen werden.", true);
  } finally {
    button.disabled = false;
  }
}

function stopBarcodeScanner() {
  if (scannerAnimationFrame) cancelAnimationFrame(scannerAnimationFrame);
  scannerAnimationFrame = null;
  if (scannerStream) scannerStream.getTracks().forEach(track => track.stop());
  scannerStream = null;
  const view = document.querySelector("#scannerView");
  const video = document.querySelector("#scannerVideo");
  video.srcObject = null;
  view.hidden = true;
}

async function startBarcodeScanner() {
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
    setBarcodeStatus("Die Kamera-Barcoderkennung wird von diesem Browser nicht unterstützt. Bitte Chrome verwenden oder die EAN manuell eingeben.", true);
    return;
  }
  try {
    const supportedFormats = await BarcodeDetector.getSupportedFormats();
    const formats = ["ean_13", "ean_8", "upc_a", "upc_e"].filter(format => supportedFormats.includes(format));
    if (!formats.length) throw new Error("EAN-Barcodes werden von diesem Browser nicht unterstützt.");
    const detector = new BarcodeDetector({ formats });
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const view = document.querySelector("#scannerView");
    const video = document.querySelector("#scannerVideo");
    video.srcObject = scannerStream;
    view.hidden = false;
    await video.play();
    setBarcodeStatus("Halte den Barcode ruhig in den markierten Bereich.");

    const scanFrame = async timestamp => {
      if (!scannerStream) return;
      if (timestamp - lastScanAttempt > 350) {
        lastScanAttempt = timestamp;
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length) {
            document.querySelector("#barcodeInput").value = barcodes[0].rawValue;
            stopBarcodeScanner();
            await lookupBarcode();
            return;
          }
        } catch { /* Der nächste Kameraframe wird erneut geprüft. */ }
      }
      scannerAnimationFrame = requestAnimationFrame(scanFrame);
    };
    scannerAnimationFrame = requestAnimationFrame(scanFrame);
  } catch (error) {
    stopBarcodeScanner();
    setBarcodeStatus(error.name === "NotAllowedError" ? "Der Kamerazugriff wurde nicht erlaubt." : (error.message || "Kamera konnte nicht gestartet werden."), true);
  }
}

function render() {
  const filtered = recipes.filter(recipe => {
    const categoryMatches = activeCategory === "Alle" || recipe.category === activeCategory;
    const searchable = `${recipe.title} ${(recipe.ingredients || []).map(item => normalizeIngredient(item).name).join(" ")}`.toLowerCase();
    return categoryMatches && searchable.includes(searchTerm.toLowerCase());
  });

  recipeGrid.replaceChildren();
  filtered.forEach(recipe => {
    const fragment = document.querySelector("#recipeCardTemplate").content.cloneNode(true);
    const card = fragment.querySelector(".recipe-card");
    const image = fragment.querySelector("img");
    const imageUrl = validUrl(recipe.image);
    if (imageUrl) {
      image.src = imageUrl;
      image.alt = recipe.title;
      image.addEventListener("error", () => image.remove());
    } else image.remove();
    fragment.querySelector(".category-badge").textContent = recipe.category;
    fragment.querySelector("h3").textContent = recipe.title;
    fragment.querySelector(".ingredient-preview").textContent = (recipe.ingredients || []).slice(0, 3).map(ingredientLabel).join(" · ");
    fragment.querySelector(".card-open").addEventListener("click", () => openDetail(recipe.id));
    card.dataset.id = recipe.id;
    recipeGrid.append(fragment);
  });

  emptyState.hidden = filtered.length > 0;
  recipeGrid.hidden = filtered.length === 0;
  document.querySelector("#countAll").textContent = recipes.length;
  document.querySelector("#countStarter").textContent = recipes.filter(r => r.category === "Vorspeise").length;
  document.querySelector("#countMain").textContent = recipes.filter(r => r.category === "Hauptspeise").length;
  document.querySelector("#countDessert").textContent = recipes.filter(r => r.category === "Nachspeise").length;
}

function openForm(recipe = null) {
  if (!ensureCanEdit()) return;
  recipeForm.reset();
  formProducts = typeof structuredClone === "function" ? structuredClone(recipe?.products || []) : JSON.parse(JSON.stringify(recipe?.products || []));
  formComponents = typeof structuredClone === "function" ? structuredClone(recipe?.components || []) : JSON.parse(JSON.stringify(recipe?.components || []));
  formComponents = formComponents.map(normalizeComponent);
  if (!formComponents.length) formComponents.push(normalizeComponent({ name: "Allgemein", instructions: recipe?.instructions || "" }));
  formIngredients = typeof structuredClone === "function" ? structuredClone(recipe?.ingredients || []) : JSON.parse(JSON.stringify(recipe?.ingredients || []));
  formIngredients = formIngredients.map(normalizeIngredient);
  formIngredients.forEach(ingredient => {
    if (!formComponents.some(component => component.id === ingredient.componentId)) ingredient.componentId = formComponents[0].id;
  });
  if (!formIngredients.length) formIngredients.push(normalizeIngredient({}));
  formCalculation = recipe?.nutritionCalculation || null;
  formImage = recipe?.image || "";
  pendingImageFile = null;
  document.querySelector("#formTitle").textContent = recipe ? "Rezept bearbeiten" : "Neues Rezept";
  document.querySelector("#recipeId").value = recipe?.id || "";
  document.querySelector("#titleInput").value = recipe?.title || "";
  document.querySelector("#categoryInput").value = recipe?.category || "Vorspeise";
  document.querySelector("#linksInput").value = recipe?.links.join("\n") || "";
  setNutritionValues(recipe?.nutrition || {});
  setBarcodeStatus("");
  renderScannedProducts();
  renderComponentRows();
  renderIngredientRows();
  document.querySelector("#calculationSummary").textContent = formCalculation
    ? `Zuletzt berechnet aus ${formCalculation.ingredientCount} Zutaten und ${formCalculation.totalWeightGrams} g Gesamtgewicht.`
    : "Noch nicht berechnet.";
  updateImagePreview();
  recipeModal.showModal();
  setTimeout(() => document.querySelector("#titleInput").focus(), 50);
}

function closeForm() { stopBarcodeScanner(); clearPreviewObjectUrl(); recipeModal.close(); }

function openDetail(id) {
  const recipe = recipes.find(item => item.id === id);
  if (!recipe) return;
  const imageUrl = validUrl(recipe.image);
  const links = (recipe.links || []).map(validUrl).filter(Boolean);
  const nutrition = recipe.nutrition || {};
  const products = recipe.products || [];
  const components = recipe.components?.length ? recipe.components : [normalizeComponent({ name: "Allgemein", instructions: recipe.instructions || "" })];
  const nutritionRows = Object.entries(nutritionLabels)
    .map(([key, [label, unit]]) => {
      const hasValue = nutrition[key] !== null && nutrition[key] !== "" && nutrition[key] !== undefined;
      return `<tr><th>${escapeHtml(label)}</th><td>${hasValue ? `${escapeHtml(String(nutrition[key]))} ${unit}` : "–"}</td></tr>`;
    })
    .join("");
  const partsHtml = components.map(component => {
    const componentIngredients = recipe.ingredients
      .map((item, index) => ({ ingredient: normalizeIngredient(item), index }))
      .filter(({ ingredient }) => ingredient.componentId === component.id);
    const shoppingList = componentIngredients.length
      ? componentIngredients.map(({ ingredient, index }) => `<label class="shopping-item${ingredient.checked ? " checked" : ""}"><input class="shopping-check" data-index="${index}" type="checkbox" ${ingredient.checked ? "checked" : ""}><span>${escapeHtml(ingredientLabel(ingredient))}</span></label>`).join("")
      : '<p class="empty-detail-info">Für diesen Teil wurden noch keine Zutaten zugeordnet.</p>';
    return `<section class="recipe-part-detail"><h3 class="recipe-part-title">${escapeHtml(component.name)}</h3><div><h3>Zutaten &amp; Einkaufsliste</h3><div class="ingredient-list">${shoppingList}</div></div><div><h3>Zubereitung</h3><p class="instructions">${escapeHtml(component.instructions)}</p></div></section>`;
  }).join("");
  const detail = document.querySelector("#recipeDetail");
  detail.innerHTML = `
    <div class="detail-hero">
      ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(recipe.title)}">` : ""}
      <button class="icon-button detail-close" type="button" aria-label="Fenster schließen">×</button>
    </div>
    <div class="detail-content">
      <p class="eyebrow">${escapeHtml(recipe.category)}</p>
      <div class="detail-title-row">
        <h2>${escapeHtml(recipe.title)}</h2>
        <div class="detail-actions">
          <button type="button" data-action="edit" title="Bearbeiten" aria-label="Rezept bearbeiten">✎</button>
          <button type="button" data-action="delete" title="Löschen" aria-label="Rezept löschen">⌫</button>
        </div>
      </div>
      <div class="recipe-parts-detail">${partsHtml}</div>
      <section class="detail-links"><h3>Nährwertangaben</h3><table class="nutrition-table"><caption>Durchschnittliche Werte pro 100 g${recipe.nutritionCalculation ? ` · berechnet aus ${recipe.nutritionCalculation.totalWeightGrams} g Zutaten` : ""}</caption><tbody>${nutritionRows}</tbody></table>${hasNutritionValues(nutrition) ? '<p class="nutrition-note">Näherungswerte auf Grundlage der hinterlegten Zutatenmengen.</p>' : '<p class="empty-detail-info">Für dieses Rezept wurden noch keine Nährwerte berechnet.</p>'}</section>
      ${products.length ? `<section class="detail-links"><h3>Gescannte Produkte</h3><div class="product-detail-list">${products.map(product => `<article class="product-detail"><strong>${escapeHtml(product.name)} · EAN ${escapeHtml(product.barcode)}</strong>${product.ingredientText ? `<p><b>Zutaten:</b> ${escapeHtml(product.ingredientText)}</p>` : ""}</article>`).join("")}</div><p class="nutrition-note">Produktdaten: Open Food Facts</p></section>` : ""}
      <section class="detail-links"><h3>Links</h3>${links.length ? `<div class="link-list">${links.map((url, index) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${url.includes("instagram.com") ? "Instagram" : `Webseite ${index + 1}`} ↗</a>`).join("")}</div>` : '<p class="empty-detail-info">Für dieses Rezept wurden noch keine Links hinterlegt.</p>'}</section>
    </div>`;
  detail.querySelector(".detail-close").addEventListener("click", () => detailModal.close());
  detail.querySelector('[data-action="edit"]').addEventListener("click", () => { detailModal.close(); openForm(recipe); });
  detail.querySelector('[data-action="delete"]').addEventListener("click", () => deleteRecipe(recipe));
  detail.querySelectorAll(".shopping-check").forEach(checkbox => checkbox.addEventListener("change", async event => {
    if (!ensureCanEdit()) {
      event.target.checked = !event.target.checked;
      return;
    }
    const ingredient = recipe.ingredients[Number(event.target.dataset.index)];
    ingredient.checked = event.target.checked;
    event.target.closest(".shopping-item").classList.toggle("checked", event.target.checked);
    await saveRecipes();
  }));
  detailModal.showModal();
}

async function deleteRecipe(recipe) {
  if (!ensureCanEdit()) return;
  if (!confirm(`„${recipe.title}“ wirklich löschen?`)) return;
  const previousRecipes = recipes;
  recipes = recipes.filter(item => item.id !== recipe.id);
  try {
    await saveRecipes();
    detailModal.close();
    render();
  } catch (error) {
    recipes = previousRecipes;
    alert(error.message);
  }
}

recipeForm.addEventListener("submit", async event => {
  event.preventDefault();
  let components = formComponents
    .filter(component => component.name.trim() || component.instructions.trim())
    .map((component, index) => ({
      ...component,
      name: component.name.trim() || `Rezeptteil ${index + 1}`,
      instructions: component.instructions.trim()
    }));
  if (!components.length) components = [normalizeComponent({ name: "Allgemein", instructions: "" })];
  const ingredients = formIngredients
    .filter(item => item.name.trim())
    .map(item => ({
      ...item,
      componentId: components.some(component => component.id === item.componentId)
        ? item.componentId
        : components[0].id
    }));
  try {
    await uploadPendingImage();
  } catch (error) {
    alert(error.message);
    return;
  }
  const id = document.querySelector("#recipeId").value;
  const recipe = {
    id: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    title: document.querySelector("#titleInput").value.trim(),
    category: document.querySelector("#categoryInput").value,
    image: formImage,
    ingredients,
    instructions: components.map(component => `${component.name}:\n${component.instructions}`).join("\n\n"),
    components,
    links: document.querySelector("#linksInput").value.split("\n").map(item => item.trim()).filter(Boolean),
    products: formProducts,
    nutrition: getNutritionValues(),
    nutritionCalculation: formCalculation
  };
  const previousRecipes = recipes;
  if (id) recipes = recipes.map(item => item.id === id ? recipe : item);
  else recipes = [recipe, ...recipes];
  try {
    await saveRecipes();
    closeForm();
    render();
  } catch (error) {
    recipes = previousRecipes;
    alert(error.message);
  }
});

document.querySelectorAll("#newRecipeButton, #heroNewRecipeButton, #emptyNewRecipeButton").forEach(button => button.addEventListener("click", () => openForm()));
document.querySelectorAll("#closeModalButton, #cancelButton").forEach(button => button.addEventListener("click", closeForm));
document.querySelector("#closeAuthButton").addEventListener("click", closeAuth);
document.querySelector("#authButton").addEventListener("click", async () => {
  if (!currentUser) {
    openAuth();
    return;
  }
  await supabaseClient.auth.signOut();
  currentUser = null;
  updateAuthInterface();
  setStorageStatus("cloud", "Zentrale Sammlung · zum Bearbeiten anmelden");
});
document.querySelector("#authForm").addEventListener("submit", async event => {
  event.preventDefault();
  const errorField = document.querySelector("#authError");
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  errorField.textContent = "";
  submitButton.disabled = true;
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: document.querySelector("#authEmail").value.trim(),
    password: document.querySelector("#authPassword").value
  });
  submitButton.disabled = false;
  if (error) {
    errorField.textContent = "Anmeldung fehlgeschlagen. Bitte E-Mail-Adresse und Passwort prüfen.";
    return;
  }
  currentUser = data.user;
  updateAuthInterface();
  closeAuth();
  await loadRecipes();
  normalizeAllRecipes();
  render();
});
document.querySelector("#lookupBarcodeButton").addEventListener("click", lookupBarcode);
document.querySelector("#barcodeInput").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); lookupBarcode(); }
});
document.querySelector("#scanBarcodeButton").addEventListener("click", startBarcodeScanner);
document.querySelector("#stopScannerButton").addEventListener("click", stopBarcodeScanner);
document.querySelector("#addComponentButton").addEventListener("click", addComponent);
document.querySelector("#calculateNutritionButton").addEventListener("click", calculateRecipeNutrition);
document.querySelector("#imageFileInput").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;
  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowedTypes.includes(file.type)) {
    alert("Bitte ein JPG-, PNG-, WebP- oder GIF-Bild auswählen.");
    event.target.value = "";
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    alert("Das Bild darf höchstens 8 MB groß sein.");
    event.target.value = "";
    return;
  }
  pendingImageFile = file;
  updateImagePreview();
});
document.querySelector("#removeImageButton").addEventListener("click", () => {
  formImage = "";
  pendingImageFile = null;
  document.querySelector("#imageFileInput").value = "";
  updateImagePreview();
});
document.querySelector("#searchInput").addEventListener("input", event => { searchTerm = event.target.value.trim(); render(); });
document.querySelectorAll(".category-tab").forEach(tab => tab.addEventListener("click", () => {
  activeCategory = tab.dataset.category;
  document.querySelectorAll(".category-tab").forEach(item => item.classList.toggle("active", item === tab));
  render();
}));
[recipeModal, detailModal, document.querySelector("#authModal")].forEach(modal => modal.addEventListener("click", event => {
  if (event.target === modal) {
    if (modal === recipeModal) closeForm();
    else if (modal.id === "authModal") closeAuth();
    else modal.close();
  }
}));

async function initialize() {
  if (supabaseClient) {
    const { data } = await supabaseClient.auth.getSession();
    currentUser = data.session?.user || null;
  }
  updateAuthInterface();
  await loadRecipes();
  normalizeAllRecipes();
  render();
}

initialize();
