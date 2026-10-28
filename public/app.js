const $ = (id) => document.getElementById(id);
const stato = { materia: null, argomento: null, coda: [], indice: 0 };
const ricerca = { carte: [], esclusi: new Set() };
const MAX_RISULTATI = 100;
// Come in src/validazione.ts: le immagini più grandi vengono ridotte e ricompresse nel browser prima dell'invio.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const LATO_MAX_IMMAGINE = 1600;
const TIPI_FILE = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"];
const caricamento = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';
const caricamentoPiccolo = '<div class="py-2"><div class="spinner-border spinner-border-sm text-primary" role="status"></div></div>';

// Con un FormData (caricamento di un file) il corpo parte così com'è e il browser imposta da sé il Content-Type multipart.
async function api(percorso, metodo = "GET", dati) {
  const form = dati instanceof FormData;
  let res;
  try {
    res = await fetch(percorso, {
      method: metodo,
      headers: form ? {} : { "Content-Type": "application/json" },
      body: form ? dati : dati && JSON.stringify(dati),
    });
  } catch {
    throw new Error("Impossibile contattare il server. Controlla la connessione e riprova.");
  }
  if (res.status === 404) throw new Error("Elemento non trovato: potrebbe essere stato eliminato.");
  if (!res.ok) {
    // Il 500 non spiega nulla («errore interno»); gli altri (anche 502 e 503 dell'AI) hanno un messaggio utile.
    const errore = res.status === 500 ? null : await res.json().then((j) => j?.errore, () => null);
    if (res.status >= 500 && !errore) throw new Error("Errore del server, riprova tra poco.");
    throw Object.assign(new Error(errore ? `Operazione non riuscita: ${errore}.` : "Operazione non riuscita. Controlla i dati e riprova."), { stato: res.status });
  }
  return res.status === 204 ? null : res.json();
}

function avviso(testo, tipo = "danger", dove = $("avviso")) {
  dove.innerHTML = `<div class="alert alert-${tipo} alert-dismissible fade show"><span></span><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Chiudi"></button></div>`;
  dove.querySelector("span").textContent = testo;
}

async function esegui(bottone, dove, azione) {
  bottone.disabled = true;
  try {
    await azione();
    return true;
  } catch (e) {
    avviso(e.message, "danger", dove);
    return false;
  } finally {
    bottone.disabled = false;
  }
}

function apriModale(id, titolo, valori, salva) {
  const modale = $(id);
  const form = modale.querySelector("form");
  const errore = modale.querySelector(".avviso-modale");
  form.reset();
  form.classList.remove("was-validated");
  errore.innerHTML = "";
  modale.querySelector(".modal-title").textContent = titolo;
  Object.entries(valori).forEach(([nome, valore]) => (form.elements[nome].value = valore));
  form.onsubmit = async (e) => {
    e.preventDefault();
    [...form.elements].forEach((campo) => (campo.value = campo.value.trim()));
    form.classList.add("was-validated");
    if (!form.checkValidity()) return;
    const dati = Object.fromEntries(new FormData(form));
    // form.elements comprende anche un submit fuori dal form collegato con l'attributo form= (modale della carta).
    const bottone = [...form.elements].find((campo) => campo.type === "submit");
    if (await esegui(bottone, errore, () => salva(dati))) bootstrap.Modal.getInstance(modale).hide();
  };
  modale.addEventListener("shown.bs.modal", () => form.querySelector("input, textarea").focus(), { once: true });
  bootstrap.Modal.getOrCreateInstance(modale).show();
}

function conferma(messaggio, elimina) {
  const modale = $("modale-conferma");
  const errore = modale.querySelector(".avviso-modale");
  const bottone = modale.querySelector(".conferma");
  errore.innerHTML = "";
  modale.querySelector(".messaggio").textContent = messaggio;
  bottone.onclick = async () => {
    if (await esegui(bottone, errore, elimina)) bootstrap.Modal.getInstance(modale).hide();
  };
  bootstrap.Modal.getOrCreateInstance(modale).show();
}

async function elenco(id, percorso, disegna, vuoto, etichetta, crea, classe = "list-group") {
  const lista = $(id);
  lista.className = classe;
  lista.innerHTML = caricamento;
  const richiesta = (lista.dataset.richiesta = String(Date.now() + Math.random()));
  try {
    const elementi = await api(percorso);
    if (lista.dataset.richiesta !== richiesta) return; // è partito un caricamento più recente
    if (elementi.length) return lista.replaceChildren(...elementi.map(disegna));
    const blocco = $("modello-vuoto").content.firstElementChild.cloneNode(true);
    blocco.querySelector(".messaggio").textContent = vuoto;
    blocco.querySelector(".crea").textContent = etichetta;
    blocco.querySelector(".crea").onclick = crea;
    lista.replaceChildren(blocco);
  } catch (e) {
    lista.innerHTML = "";
    avviso(e.message);
  }
}

function riga(testo, apri, modifica, elimina, nota = "") {
  const elemento = $("modello-riga").content.firstElementChild.cloneNode(true);
  elemento.querySelector(".apri").textContent = testo;
  elemento.querySelector(".nota").textContent = nota;
  elemento.querySelector(".apri").onclick = apri;
  elemento.querySelector(".modifica").onclick = modifica;
  elemento.querySelector(".elimina").onclick = elimina;
  return elemento;
}

function statistiche(media, ripassi, mai) {
  return ripassi ? `media ${media.toFixed(1)} · ${ripassi} ${ripassi === 1 ? "ripasso" : "ripassi"}` : mai;
}

function mostra(id) {
  document.querySelectorAll(".schermata").forEach((s) => s.classList.toggle("d-none", s.id !== id));
  $("avviso").innerHTML = "";
  adattaLarghezza(id);
  window.scrollTo(0, 0);
}

// La vista a card usa tutta la larghezza disponibile; le altre schermate restano strette per la leggibilità.
// Vale anche per la navbar, così il logo resta allineato al contenuto.
function adattaLarghezza(schermata) {
  const largo = schermata === "argomento" && vistaCarte() === "card";
  document.querySelectorAll(".contenuto").forEach((el) => el.classList.toggle("contenuto-largo", largo));
}

function vaiHome() {
  mostra("home");
  caricaMaterie();
}

function caricaMaterie() {
  elenco(
    "lista-materie",
    "/materie",
    (m) => riga(m.nome_materia, () => apriMateria(m), () => modificaMateria(m), () => eliminaMateria(m)),
    "Non hai ancora creato materie.",
    "Crea la prima materia",
    nuovaMateria,
  );
}

function nuovaMateria() {
  apriModale("modale-nome", "Nuova materia", {}, async ({ nome }) => {
    await api("/materie", "POST", { nome_materia: nome });
    avviso("Materia creata.", "success");
    caricaMaterie();
  });
}

function modificaMateria(m) {
  apriModale("modale-nome", "Modifica materia", { nome: m.nome_materia }, async ({ nome }) => {
    await api(`/materie/${m.id_materia}`, "PUT", { nome_materia: nome });
    avviso("Materia modificata.", "success");
    caricaMaterie();
  });
}

function eliminaMateria(m) {
  conferma(
    `Vuoi eliminare la materia «${m.nome_materia}»? Verranno eliminati anche tutti i suoi argomenti e le relative carte.`,
    async () => {
      await api(`/materie/${m.id_materia}`, "DELETE");
      avviso("Materia eliminata.", "success");
      caricaMaterie();
    },
  );
}

function apriMateria(materia) {
  stato.materia = materia;
  $("titolo-materia").textContent = materia.nome_materia;
  mostra("materia");
  caricaArgomenti();
}

function caricaArgomenti() {
  elenco(
    "lista-argomenti",
    `/materie/${stato.materia.id_materia}/argomenti`,
    (a) =>
      riga(
        a.nome_argomento,
        () => apriArgomento(a),
        () => modificaArgomento(a),
        () => eliminaArgomento(a),
        statistiche(a.media, a.ripassi, "mai ripassato"),
      ),
    "Non ci sono ancora argomenti in questa materia.",
    "Crea il primo argomento",
    nuovoArgomento,
  );
}

function nuovoArgomento() {
  apriModale("modale-nome", "Nuovo argomento", {}, async ({ nome }) => {
    await api("/argomenti", "POST", { nome_argomento: nome, id_materia: stato.materia.id_materia });
    avviso("Argomento creato.", "success");
    caricaArgomenti();
  });
}

function modificaArgomento(a) {
  apriModale("modale-nome", "Modifica argomento", { nome: a.nome_argomento }, async ({ nome }) => {
    await api(`/argomenti/${a.id_argomento}`, "PUT", { nome_argomento: nome });
    avviso("Argomento modificato.", "success");
    caricaArgomenti();
  });
}

function eliminaArgomento(a) {
  conferma(`Vuoi eliminare l'argomento «${a.nome_argomento}»? Verranno eliminate anche tutte le sue carte.`, async () => {
    await api(`/argomenti/${a.id_argomento}`, "DELETE");
    avviso("Argomento eliminato.", "success");
    caricaArgomenti();
  });
}

function apriArgomento(argomento) {
  stato.argomento = argomento;
  $("titolo-argomento").textContent = argomento.nome_argomento;
  $("indietro-materia").textContent = "← " + stato.materia.nome_materia;
  mostra("argomento");
  caricaCarte();
  pannelloMateriali($("materiali-argomento"), `/argomenti/${argomento.id_argomento}`, "Materiali dell'argomento");
}

function vistaCarte() {
  try {
    return localStorage.getItem("vistaCarte") === "card" ? "card" : "lista";
  } catch {
    return "lista";
  }
}

function impostaVista(vista) {
  try {
    localStorage.setItem("vistaCarte", vista);
  } catch {}
  caricaCarte();
}

// Mostra il testo di una carta: l'HTML già renderizzato dal Worker (unico punto che usa innerHTML per i contenuti)
// oppure, per le carte non ancora renderizzate, il testo grezzo.
function mostraTesto(elemento, grezzo, render, prefisso = "") {
  elemento.classList.toggle("renderizzato", render != null);
  if (render == null) return (elemento.textContent = prefisso + grezzo);
  elemento.innerHTML = render;
  if (prefisso) elemento.prepend(prefisso);
}

function cartaFlip(carta, ripasso) {
  const elemento = $("modello-card").content.firstElementChild.cloneNode(true);
  const flip = elemento.querySelector(".carta-flip");
  const gira = () => {
    flip.classList.toggle("girata");
    flip.setAttribute("aria-pressed", flip.classList.contains("girata"));
  };
  flip.onclick = gira;
  flip.onkeydown = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    gira();
  };
  mostraTesto(elemento.querySelector(".domanda"), carta.domanda, carta.domanda_render);
  mostraTesto(elemento.querySelector(".risposta"), carta.risposta, carta.risposta_render, carta.opzioni?.length ? "✓ " : "");
  elemento.querySelector(".nota").textContent = statistiche(ripasso.media_esito, ripasso.numero_ripassi, "mai ripassata");
  elemento.querySelector(".multipla").classList.toggle("d-none", !carta.opzioni?.length);
  elemento.querySelector(".risposta").classList.toggle("text-success", !!carta.opzioni?.length);
  elemento.querySelector(".sbagliate").replaceChildren(
    ...(carta.opzioni ?? []).map((o) => Object.assign(document.createElement("li"), { textContent: o })),
  );
  elemento.querySelector(".spiega").onclick = () => apriSpiegazione(carta);
  elemento.querySelector(".modifica").onclick = () => modificaCarta(carta);
  elemento.querySelector(".elimina").onclick = () => eliminaCarta(carta);
  return elemento;
}

function caricaCarte() {
  const vista = vistaCarte();
  adattaLarghezza("argomento");
  $("vista-lista").classList.toggle("active", vista === "lista");
  $("vista-card").classList.toggle("active", vista === "card");
  elenco(
    "lista-carte",
    `/argomenti/${stato.argomento.id_argomento}/carte`,
    ({ carta, ripasso }) =>
      vista === "card"
        ? cartaFlip(carta, ripasso)
        : riga(
            carta.domanda,
            () => modificaCarta(carta),
            () => modificaCarta(carta),
            () => eliminaCarta(carta),
            statistiche(ripasso.media_esito, ripasso.numero_ripassi, "mai ripassata"),
          ),
    "Non hai ancora carte in questo argomento.",
    "Crea la prima carta",
    nuovaCarta,
    vista === "card" ? "griglia-card" : "list-group",
  );
}

// Le opzioni sbagliate arrivano come testo (una per riga) e partono come array, o null se assenti.
function datiCarta(dati) {
  const opzioni = dati.opzioni.split("\n").map((o) => o.trim()).filter(Boolean);
  if (opzioni.length > 9) throw new Error("Puoi inserire al massimo 9 opzioni sbagliate.");
  return { ...dati, difficolta: +dati.difficolta, opzioni: opzioni.length ? opzioni : null };
}

function nuovaCarta() {
  apriModale("modale-carta", "Nuova carta", {}, async (dati) => {
    await api("/carte", "POST", { ...datiCarta(dati), id_argomento: stato.argomento.id_argomento });
    avviso("Carta creata.", "success");
    caricaCarte();
  });
  $("materiali-carta").innerHTML = '<p class="small text-body-secondary mb-0">Salva la carta, poi riaprila per aggiungere materiali.</p>';
}

function modificaCarta(carta, dopo = caricaCarte) {
  const { domanda, risposta, difficolta } = carta;
  const opzioni = (carta.opzioni ?? []).join("\n");
  apriModale("modale-carta", "Modifica carta", { domanda, risposta, opzioni, difficolta }, async (dati) => {
    await api(`/carte/${carta.id_carta}`, "PUT", datiCarta(dati));
    avviso("Carta modificata.", "success");
    dopo();
  });
  pannelloMateriali($("materiali-carta"), `/carte/${carta.id_carta}`, "Materiali della carta");
}

function eliminaCarta(carta) {
  conferma(`Vuoi eliminare la carta «${carta.domanda}»?`, async () => {
    await api(`/carte/${carta.id_carta}`, "DELETE");
    avviso("Carta eliminata.", "success");
    caricaCarte();
  });
}

// ---------- Materiali ----------

const dimensione = (byte) => (byte < 1024 * 1024 ? `${Math.max(1, Math.round(byte / 1024))} KB` : `${(byte / 1024 / 1024).toFixed(1)} MB`);
const nomeMateriale = (m) => m.titolo || (m.tipo === "testo" ? m.testo.slice(0, 60) + (m.testo.length > 60 ? "…" : "") : "File senza nome");
const TIPO_FILE = { "application/pdf": "PDF", "text/plain": "Testo" };
const tipoMateriale = (m) => (m.tipo === "testo" ? "Nota" : m.mime.startsWith("image/") ? "Immagine" : (TIPO_FILE[m.mime] ?? "File"));

// Restituisce il file da caricare: le immagini troppo grandi (byte o lato) diventano WebP, o JPEG se il browser non sa
// produrre WebP, con lato lungo al massimo LATO_MAX_IMMAGINE. Le immagini già piccole restano intatte (schemi e testo
// non perdono qualità), le GIF restano com'è perché potrebbero essere animate.
async function preparaFile(file) {
  const mb = MAX_FILE_BYTES / 1024 / 1024;
  const limite = `Il file supera il limite di ${mb} MB.`;
  if (file.type === "image/svg+xml") throw new Error("Le immagini SVG non sono ammesse: esportale in PNG.");
  if (!file.type.startsWith("image/") || file.type === "image/gif") {
    if (!TIPI_FILE.includes(file.type)) throw new Error("Tipo di file non ammesso: puoi caricare immagini, PDF e file di testo.");
    if (file.size > MAX_FILE_BYTES) throw new Error(limite);
    return file;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Il browser non riesce a leggere questa immagine: convertila in JPEG o PNG.");
  }
  try {
    const lato = Math.max(bitmap.width, bitmap.height);
    if (TIPI_FILE.includes(file.type) && file.size <= MAX_FILE_BYTES && lato <= LATO_MAX_IMMAGINE) return file;
    const scala = Math.min(1, LATO_MAX_IMMAGINE / lato);
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scala), height: Math.round(bitmap.height * scala) });
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const comprimi = (tipo, qualita) => new Promise((fatto) => canvas.toBlob(fatto, tipo, qualita));
    let blob = await comprimi("image/webp", 0.85);
    if (blob?.type !== "image/webp") {
      // Il JPEG non ha trasparenza: si mette un fondo bianco dietro l'immagine.
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      blob = await comprimi("image/jpeg", 0.85);
    }
    if (blob && blob.size > MAX_FILE_BYTES) blob = await comprimi(blob.type, 0.7);
    if (!blob || blob.size > MAX_FILE_BYTES) throw new Error(`Non riesco a ridurre l'immagine sotto ${mb} MB.`);
    const nome = file.name.replace(/\.[^.]*$/, "") || "immagine";
    return new File([blob], `${nome}.${blob.type === "image/webp" ? "webp" : "jpg"}`, { type: blob.type });
  } finally {
    bitmap.close();
  }
}

// Elenco dei materiali di un argomento o di una carta (`percorso` = "/argomenti/ID" o "/carte/ID"), con aggiunta di note
// e file. Le modifiche si salvano subito. Per eliminare si usa confirm(): nel modale della carta non si può aprirne un altro.
function pannelloMateriali(contenitore, percorso, titolo) {
  const pannello = $("modello-materiali").content.firstElementChild.cloneNode(true);
  const lista = pannello.querySelector(".elenco-materiali");
  const avvisi = pannello.querySelector(".avviso-materiali");
  const editor = pannello.querySelector(".editor-materiale");
  const scegli = pannello.querySelector(".scegli-file");
  const bottoneFile = pannello.querySelector(".nuovo-file");
  pannello.querySelector(".titolo").textContent = titolo;
  pannello.querySelector(".aiuto").textContent = "Immagini, PDF e file di testo fino a 2 MB (le immagini grandi vengono ridotte). Le modifiche si salvano subito.";
  contenitore.replaceChildren(pannello);

  const ricarica = async () => {
    lista.innerHTML = caricamentoPiccolo;
    try {
      const materiali = await api(`${percorso}/materiali`);
      if (materiali.length) return lista.replaceChildren(...materiali.map(rigaMateriale));
      lista.innerHTML = '<p class="small text-body-secondary mb-0">Nessun materiale.</p>';
    } catch (e) {
      lista.innerHTML = "";
      avviso(e.message, "danger", avvisi);
    }
  };

  // Senza `m` crea una nota; con una nota ne modifica titolo e testo, con un file solo il titolo.
  const apriEditor = (m) => {
    const nota = !m || m.tipo === "testo";
    editor.reset();
    editor.classList.remove("d-none");
    editor.elements.titolo.value = m?.titolo ?? "";
    editor.elements.testo.value = m?.testo ?? "";
    editor.elements.testo.classList.toggle("d-none", !nota);
    editor.onsubmit = async (e) => {
      e.preventDefault();
      const titolo = editor.elements.titolo.value.trim();
      const testo = editor.elements.testo.value.trim();
      if (nota && !testo) return avviso("Scrivi il testo della nota.", "danger", avvisi);
      const ok = await esegui(editor.querySelector("[type=submit]"), avvisi, async () => {
        if (!m) await api(`${percorso}/materiali`, "POST", { titolo, testo });
        else await api(`/materiali/${m.id_materiale}`, "PUT", nota ? { titolo, testo } : { titolo });
      });
      if (!ok) return;
      avvisi.innerHTML = "";
      editor.classList.add("d-none");
      ricarica();
    };
    (nota ? editor.elements.testo : editor.elements.titolo).focus();
  };
  editor.querySelector(".annulla").onclick = () => editor.classList.add("d-none");

  function rigaMateriale(m) {
    const elemento = $("modello-materiale").content.firstElementChild.cloneNode(true);
    const file = `/materiali/${m.id_materiale}/file`;
    elemento.querySelector(".tipo").textContent = tipoMateriale(m);
    if (m.tipo === "testo") {
      elemento.querySelector(".anteprima").remove();
      elemento.querySelector(".nome").remove();
      elemento.querySelector(".dettagli").remove();
      elemento.querySelector("summary").append(elemento.querySelector(".tipo"), nomeMateriale(m));
      mostraTesto(elemento.querySelector(".corpo"), m.testo, m.testo_render);
    } else {
      elemento.querySelector(".nota-materiale").remove();
      const anteprima = elemento.querySelector(".anteprima");
      if (m.mime.startsWith("image/")) {
        anteprima.href = file;
        anteprima.querySelector("img").src = file;
      } else anteprima.remove();
      Object.assign(elemento.querySelector(".nome"), { href: file, textContent: nomeMateriale(m) });
      elemento.querySelector(".dettagli").textContent = dimensione(m.dimensione);
    }
    elemento.querySelector(".modifica").onclick = () => apriEditor(m);
    const elimina = elemento.querySelector(".elimina");
    elimina.onclick = () => {
      if (!confirm(`Eliminare «${nomeMateriale(m)}»?`)) return;
      esegui(elimina, avvisi, async () => {
        await api(`/materiali/${m.id_materiale}`, "DELETE");
        ricarica();
      });
    };
    return elemento;
  }

  pannello.querySelector(".nuova-nota").onclick = () => apriEditor();
  bottoneFile.onclick = () => scegli.click();
  scegli.onchange = () => {
    const scelto = scegli.files[0];
    scegli.value = "";
    if (!scelto) return;
    const etichetta = bottoneFile.textContent;
    bottoneFile.textContent = "Caricamento…";
    esegui(bottoneFile, avvisi, async () => {
      try {
        const corpo = new FormData();
        const pronto = await preparaFile(scelto);
        corpo.append("file", pronto, pronto.name);
        await api(`${percorso}/materiali`, "POST", corpo);
        avvisi.innerHTML = "";
        ricarica();
      } finally {
        bottoneFile.textContent = etichetta;
      }
    });
  };
  ricarica();
}

// ---------- Spiegazione ----------

// Carica e mostra la spiegazione di una carta in `contenitore`. Le risposte arrivate dopo che il contenitore è passato
// a un'altra carta (ripasso) vengono scartate grazie al token in `dataset.richiesta`.
async function bloccoSpiegazione(contenitore, carta) {
  const token = (contenitore.dataset.richiesta = String(Date.now() + Math.random()));
  contenitore.innerHTML = caricamentoPiccolo;
  try {
    const s = await api(`/carte/${carta.id_carta}/spiegazione`);
    if (contenitore.dataset.richiesta === token) disegnaSpiegazione(contenitore, carta, s, token);
  } catch (e) {
    if (contenitore.dataset.richiesta !== token) return;
    contenitore.innerHTML = "";
    avviso(e.message, "danger", contenitore);
  }
}

// Ogni azione passa da un riquadro di conferma con i materiali da usare: quelli della carta spuntati, quelli
// dell'argomento no. Così nessuna chiamata AI parte con un solo clic.
function disegnaSpiegazione(contenitore, carta, { spiegazione: s, obsoleta, ai }, token) {
  const blocco = $("modello-spiegazione").content.firstElementChild.cloneNode(true);
  const q = (selettore) => blocco.querySelector(selettore);
  const avvisi = q(".avviso-spiegazione");
  const passo = q(".passo");
  const scelta = q(".scelta-materiali");
  const conferma = q(".conferma");
  const attuale = () => contenitore.dataset.richiesta === token;
  const aggiorna = (nuovo) => attuale() && disegnaSpiegazione(contenitore, carta, nuovo, token);

  if (s) mostraTesto(q(".testo"), s.testo, s.testo_render);
  else q(".testo").innerHTML = '<span class="text-body-secondary">Nessuna spiegazione.</span>';
  const data = s && new Date(s.creata_il).toLocaleDateString("it-IT");
  q(".info").textContent = !s
    ? ai ? "" : "AI non configurata: con «Copia prompt» puoi usare una chat esterna e incollare qui la risposta."
    : s.fonte === "ai" ? `Generata con ${s.modello} · ${data}` : `Scritta a mano · ${data}`;
  q(".obsoleta").classList.toggle("d-none", !obsoleta);
  q(".genera").textContent = s ? "Rigenera con AI" : "Genera con AI";
  q(".genera").classList.toggle("d-none", !ai);
  q(".scrivi").textContent = s ? "Modifica a mano" : "Scrivi a mano";

  let materiali;
  const caricaMateriali = async () => {
    if (materiali) return;
    scelta.innerHTML = caricamentoPiccolo;
    const [dellaCarta, dellArgomento] = await Promise.all([
      api(`/carte/${carta.id_carta}/materiali`),
      api(`/argomenti/${carta.id_argomento}/materiali`),
    ]);
    materiali = [...dellaCarta.map((m) => [m, true]), ...dellArgomento.map((m) => [m, false])];
    if (!materiali.length) return (scelta.innerHTML = '<p class="small text-body-secondary mb-0">Né la carta né il suo argomento hanno materiali.</p>');
    scelta.replaceChildren(
      ...materiali.map(([m, spuntato]) => {
        const voce = document.createElement("label");
        voce.className = "list-group-item d-flex gap-2 py-2 small";
        const casella = Object.assign(document.createElement("input"), { type: "checkbox", className: "form-check-input flex-shrink-0", value: m.id_materiale, checked: spuntato });
        const testo = Object.assign(document.createElement("span"), { className: "text-break", textContent: `${tipoMateriale(m)} · ${nomeMateriale(m)}` });
        const dove = Object.assign(document.createElement("span"), { className: "text-body-secondary ms-auto flex-shrink-0", textContent: spuntato ? "carta" : "argomento" });
        voce.append(casella, testo, dove);
        return voce;
      }),
    );
  };
  const scelti = () => [...scelta.querySelectorAll("input:checked")].map((c) => +c.value);

  const campoTesto = q(".campo-testo");
  const apriPasso = (modo) => {
    avvisi.innerHTML = "";
    passo.classList.remove("d-none");
    q(".campo-prompt").classList.add("d-none");
    q(".allegati").classList.add("d-none");
    campoTesto.classList.toggle("d-none", modo !== "scrivi");
    if (modo === "scrivi") {
      campoTesto.value = s?.testo ?? "";
      campoTesto.focus();
    }
    conferma.textContent = { genera: s ? "Rigenera" : "Genera", scrivi: "Salva spiegazione", copia: "Copia prompt" }[modo];
    conferma.onclick = () => azioni[modo]();
    conferma.disabled = true;
    caricaMateriali()
      .then(() => (conferma.disabled = false))
      .catch((e) => {
        scelta.innerHTML = "";
        avviso(e.message, "danger", avvisi);
      });
  };

  const azioni = {
    genera: () => {
      if (s?.fonte === "manuale" && !confirm("Sostituire la spiegazione scritta a mano con una generata dall'AI?")) return;
      conferma.textContent = "Generazione…";
      esegui(conferma, avvisi, async () => {
        try {
          aggiorna(await api(`/carte/${carta.id_carta}/spiegazione/genera`, "POST", { materiali: scelti(), rigenera: !!s }));
        } finally {
          conferma.textContent = s ? "Rigenera" : "Genera";
        }
      });
    },
    scrivi: () => {
      const testo = campoTesto.value.trim();
      if (!testo) return avviso("Scrivi la spiegazione prima di salvarla.", "danger", avvisi);
      esegui(conferma, avvisi, async () => aggiorna(await api(`/carte/${carta.id_carta}/spiegazione`, "PUT", { testo, materiali: scelti() })));
    },
    // Dopo la copia il riquadro diventa quello della scrittura a mano, per incollare la risposta della chat esterna.
    copia: () =>
      esegui(conferma, avvisi, async () => {
        const { prompt, allegati } = await api(`/carte/${carta.id_carta}/spiegazione/prompt`, "POST", { materiali: scelti() });
        let copiato = true;
        try {
          await navigator.clipboard.writeText(prompt);
        } catch {
          copiato = false;
        }
        apriPasso("scrivi");
        campoTesto.value = "";
        const campoPrompt = q(".campo-prompt");
        if (!copiato) {
          campoPrompt.value = prompt;
          campoPrompt.classList.remove("d-none");
          campoPrompt.select();
        }
        const elenco = q(".allegati");
        elenco.replaceChildren(
          document.createTextNode(copiato ? "Prompt copiato. " : "Copia il prompt qui sotto. "),
          ...(allegati.length
            ? [document.createTextNode("Allega a mano: "), ...allegati.flatMap((a, i) => [i ? ", " : "", Object.assign(document.createElement("a"), { href: `/materiali/${a.id_materiale}/file`, target: "_blank", rel: "noopener", textContent: a.titolo || a.mime })])]
            : []),
          document.createTextNode(" Poi incolla qui la risposta e salva."),
        );
        elenco.classList.remove("d-none");
      }),
  };

  q(".genera").onclick = () => apriPasso("genera");
  q(".scrivi").onclick = () => apriPasso("scrivi");
  q(".copia").onclick = () => apriPasso("copia");
  q(".annulla").onclick = () => passo.classList.add("d-none");
  contenitore.replaceChildren(blocco);
}

function apriSpiegazione(carta) {
  mostraTesto($("spiegazione-domanda"), carta.domanda, carta.domanda_render);
  mostraTesto($("spiegazione-risposta"), carta.risposta, carta.risposta_render);
  bloccoSpiegazione($("spiegazione-modale"), carta);
  bootstrap.Modal.getOrCreateInstance($("modale-spiegazione")).show();
}

async function apriRipasso() {
  mostra("ripasso");
  $("scelta-materia").replaceChildren(new Option("Scegli una materia", ""));
  caricaSceltaArgomenti();
  try {
    const materie = await api("/materie");
    if (!materie.length) return avviso("Non hai ancora creato materie: aggiungine una dalla home.", "info");
    $("scelta-materia").append(...materie.map((m) => new Option(m.nome_materia, m.id_materia)));
  } catch (e) {
    avviso(e.message);
  }
}

async function caricaSceltaArgomenti() {
  const id = $("scelta-materia").value;
  const lista = $("scelta-argomenti");
  lista.innerHTML = `<p class="text-body-secondary mb-0">${id ? "Caricamento…" : "Scegli una materia per vedere i suoi argomenti."}</p>`;
  aggiornaInizia();
  if (!id) return;
  try {
    const argomenti = await api(`/materie/${id}/argomenti`);
    if ($("scelta-materia").value !== id) return;
    if (!argomenti.length) return (lista.innerHTML = '<p class="text-body-secondary mb-0">Questa materia non ha ancora argomenti.</p>');
    lista.replaceChildren(
      ...argomenti.map((a) => {
        const voce = $("modello-argomento").content.firstElementChild.cloneNode(true);
        voce.querySelector("input").value = a.id_argomento;
        voce.querySelector("span").textContent = a.nome_argomento;
        return voce;
      }),
    );
    aggiornaInizia();
  } catch (e) {
    lista.innerHTML = "";
    avviso(e.message);
  }
}

function aggiornaInizia() {
  $("inizia").disabled = !document.querySelector("#scelta-argomenti input:checked");
}

function iniziaSessione() {
  const argomenti = [...document.querySelectorAll("#scelta-argomenti input:checked")].map((c) => c.value).join(",");
  esegui($("inizia"), $("avviso"), async () => {
    const modo = $("scelta-modo").value;
    const query = new URLSearchParams({ materia: $("scelta-materia").value, argomenti, modo, casuale: $("scelta-casuale").checked ? 1 : 0 });
    const limite = $("scelta-limite").value.trim();
    if (limite) query.set("limite", limite);
    const coda = await api(`/carte/da-ripassare?${query}`);
    if (!coda.length) {
      const nessuna = {
        scadenza: "Non ci sono carte da ripassare per la selezione scelta. Riprova più avanti, scegli altri argomenti o usa un altro modo.",
        anticipo: "Tutte le carte della selezione sono già in scadenza: usa il modo «In scadenza».",
        tutte: "La selezione scelta non contiene carte.",
      };
      return avviso(nessuna[modo], "info");
    }
    stato.coda = coda;
    stato.indice = 0;
    mostra("sessione");
    mostraCarta();
  });
}

function mostraCarta() {
  const { carta } = stato.coda[stato.indice];
  $("progresso").textContent = `Carta ${stato.indice + 1} di ${stato.coda.length}`;
  mostraTesto($("domanda"), carta.domanda, carta.domanda_render);
  mostraTesto($("risposta"), carta.risposta, carta.risposta_render);
  $("blocco-risposta").classList.add("d-none");
  $("spiegazione").replaceChildren();
  $("spiegazione").dataset.richiesta = ""; // scarta le risposte ancora in arrivo per la carta precedente
  $("voti").classList.add("d-none");
  $("avviso-voto").innerHTML = "";
  const quiz = carta.opzioni?.length;
  $("mostra-risposta").classList.toggle("d-none", !!quiz);
  $("opzioni").classList.toggle("d-none", !quiz);
  $("opzioni").replaceChildren(...(quiz ? [...opzioniMescolate(carta).map((testo) => bottoneOpzione(carta, testo)), bottoneNonLoSo(carta)] : []));
  window.scrollTo(0, 0);
}

function opzioniMescolate(carta) {
  const tutte = [carta.risposta, ...carta.opzioni];
  for (let i = tutte.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tutte[i], tutte[j]] = [tutte[j], tutte[i]];
  }
  return tutte;
}

function bottoneOpzione(carta, testo) {
  const b = document.createElement("button");
  b.className = "btn btn-outline-secondary text-start testo-carta";
  b.textContent = testo;
  b.onclick = () => {
    const bottoni = [...$("opzioni").children];
    bottoni.forEach((x) => (x.disabled = true));
    const colora = (x, classe) => x.classList.replace("btn-outline-secondary", classe);
    bottoni.filter((x) => x.textContent === carta.risposta).forEach((x) => colora(x, "btn-success"));
    if (testo !== carta.risposta) colora(b, "btn-danger");
    mostraRisposta();
  };
  return b;
}

function bottoneNonLoSo(carta) {
  const b = document.createElement("button");
  b.className = "btn btn-link";
  b.textContent = "Non lo so";
  b.onclick = () => {
    const bottoni = [...$("opzioni").children];
    bottoni.forEach((x) => (x.disabled = true));
    bottoni.filter((x) => x.textContent === carta.risposta).forEach((x) => x.classList.replace("btn-outline-secondary", "btn-success"));
    mostraRisposta();
  };
  return b;
}

function mostraRisposta() {
  $("blocco-risposta").classList.remove("d-none");
  $("voti").classList.remove("d-none");
  $("mostra-risposta").classList.add("d-none");
  bloccoSpiegazione($("spiegazione"), stato.coda[stato.indice].carta);
}

async function vota(voto) {
  const { carta } = stato.coda[stato.indice];
  let saltata = false;
  const ok = await esegui($("voti"), $("avviso-voto"), async () => {
    try {
      await api(`/carte/${carta.id_carta}/voto`, "POST", { voto });
    } catch (e) {
      if (e.stato !== 409) throw e;
      saltata = true; // già ripassata altrove: si passa alla successiva
    }
  });
  if (!ok) return;
  avanza();
  if (saltata) avviso("La carta precedente era già stata ripassata altrove: voto non registrato.", "info");
}

function avanza() {
  stato.indice++;
  if (stato.indice < stato.coda.length) mostraCarta();
  else mostra("fine");
}

function esciSessione() {
  if (stato.indice === 0 || confirm("Uscire dalla sessione? I voti già dati restano salvati.")) mostra("ripasso");
}

// Minuscolo, senza accenti e con ogni spazio ridotto a " ": mantiene la lunghezza del testo, così gli indici
// trovati nel testo normalizzato valgono anche per quello originale (serve per evidenziare). Un carattere che
// cambierebbe lunghezza (emoji con U+FE0F, segni combinanti isolati, hangul) resta com'è.
const base = (s) =>
  [...s.normalize("NFC")]
    .map((c) => {
      if (/\s/.test(c)) return " ";
      const n = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      return n.length === c.length ? n : c;
    })
    .join("");

async function apriRicerca() {
  ricerca.esclusi.clear();
  $("campo-ricerca").value = "";
  $("titolo-ricerca").textContent = "Cerca in " + stato.materia.nome_materia;
  $("indietro-ricerca").textContent = "← " + stato.materia.nome_materia;
  mostra("ricerca");
  await caricaRicerca();
  $("campo-ricerca").focus();
}

// Scarica le carte della materia aperta e le prepara per la ricerca; si richiama dopo ogni modifica.
async function caricaRicerca() {
  const id = stato.materia.id_materia;
  const campo = $("campo-ricerca");
  campo.disabled = true;
  ricerca.carte = [];
  $("ricerca-argomenti").replaceChildren();
  $("conteggio-ricerca").textContent = "";
  $("risultati-ricerca").innerHTML = caricamento;
  try {
    const carte = await api(`/materie/${id}/carte`);
    if (stato.materia.id_materia !== id) return;
    ricerca.carte = carte.map((c) => {
      const t = { domanda: c.domanda, risposta: c.risposta, opzioni: (c.opzioni ?? []).join(" · ") };
      for (const k in t) t[k] = t[k].normalize("NFC");
      return { ...c, t, n: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, base(v)])) };
    });
    const argomenti = [...new Map(carte.map((c) => [c.id_argomento, c.nome_argomento]))];
    $("ricerca-argomenti").replaceChildren(
      ...argomenti.map(([idArgomento, nome]) => {
        const voce = $("modello-argomento").content.firstElementChild.cloneNode(true);
        const casella = voce.querySelector("input");
        casella.checked = !ricerca.esclusi.has(idArgomento);
        casella.onchange = () => {
          casella.checked ? ricerca.esclusi.delete(idArgomento) : ricerca.esclusi.add(idArgomento);
          cercaOra();
        };
        voce.querySelector("span").textContent = nome;
        return voce;
      }),
    );
    campo.disabled = !carte.length;
    cercaOra();
  } catch (e) {
    $("risultati-ricerca").innerHTML = "";
    avviso(e.message);
  }
}

// Le parole devono esserci tutte, in qualsiasi ordine; tra virgolette conta solo la frase intera.
function interpretaRicerca(testo) {
  const t = base(testo).trim();
  const frase = t.replace(/"/g, "").trim().replace(/ +/g, " ");
  if (!frase) return null;
  return { frase, parole: t.startsWith('"') ? [frase] : frase.split(" "), esatta: frase.includes(" ") };
}

function trova(carta, q) {
  const campi = ["domanda", "risposta", "opzioni"];
  if (!q.parole.every((p) => campi.some((k) => carta.n[k].includes(p)))) return null;
  const dove = Object.fromEntries(campi.map((k) => [k, q.parole.some((p) => carta.n[k].includes(p))]));
  const esatta = q.esatta && campi.some((k) => carta.n[k].includes(q.frase));
  return { carta, dove, esatta, rango: (esatta ? 0 : 2) + (dove.domanda ? 0 : 1) };
}

function evidenzia(elemento, testo, normalizzato, parole) {
  const intervalli = [];
  for (const p of parole) for (let i = normalizzato.indexOf(p); i >= 0; i = normalizzato.indexOf(p, i + p.length)) intervalli.push([i, i + p.length]);
  intervalli.sort((a, b) => a[0] - b[0]);
  const nodi = [];
  let pos = 0;
  for (const [da, a] of intervalli) {
    if (a <= pos) continue;
    const inizio = Math.max(da, pos);
    const marca = document.createElement("mark");
    marca.textContent = testo.slice(inizio, a);
    nodi.push(testo.slice(pos, inizio), marca);
    pos = a;
  }
  elemento.replaceChildren(...nodi, testo.slice(pos));
}

function disegnaRisultato({ carta, dove, esatta }, q) {
  const elemento = $("modello-risultato").content.firstElementChild.cloneNode(true);
  elemento.querySelector(".argomento").textContent = carta.nome_argomento;
  const etichette = [esatta && ["Frase esatta", "success"], dove.domanda && ["Domanda", "primary"], dove.risposta && ["Risposta", "secondary"], dove.opzioni && ["Opzioni", "secondary"]];
  elemento.querySelector(".etichette").replaceChildren(
    ...etichette.filter(Boolean).map(([testo, colore]) => {
      const badge = document.createElement("span");
      badge.className = `badge text-bg-${colore}`;
      badge.textContent = testo;
      return badge;
    }),
  );
  for (const k of ["domanda", "risposta", "opzioni"]) {
    const blocco = elemento.querySelector("." + k);
    if (k === "domanda" || dove[k]) evidenzia(blocco.querySelector(".valore"), carta.t[k], carta.n[k], q.parole);
    else blocco.remove();
  }
  elemento.onclick = () => modificaCarta(carta, caricaRicerca);
  return elemento;
}

function cercaOra() {
  const lista = $("risultati-ricerca");
  const q = interpretaRicerca($("campo-ricerca").value);
  const messaggio = (testo) => {
    const p = document.createElement("p");
    p.className = "text-body-secondary text-center py-4 mb-0";
    p.textContent = testo;
    lista.replaceChildren(p);
    $("conteggio-ricerca").textContent = "";
  };
  if (!ricerca.carte.length) return messaggio("Questa materia non ha ancora carte.");
  if (!q) return messaggio("Scrivi per cercare nelle domande e nelle risposte.");
  const trovati = ricerca.carte
    .filter((c) => !ricerca.esclusi.has(c.id_argomento))
    .map((c) => trova(c, q))
    .filter(Boolean)
    .sort((a, b) => a.rango - b.rango);
  if (!trovati.length) return messaggio("Nessuna carta trovata.");
  lista.replaceChildren(...trovati.slice(0, MAX_RISULTATI).map((r) => disegnaRisultato(r, q)));
  $("conteggio-ricerca").textContent =
    `${trovati.length} ${trovati.length === 1 ? "carta trovata" : "carte trovate"}` +
    (trovati.length > MAX_RISULTATI ? ` · mostrate le prime ${MAX_RISULTATI}, affina la ricerca` : "");
}

vaiHome();

function esporta() {
  esegui($("esporta"), $("avviso"), async () => {
    const res = await fetch("/esporta");
    if (!res.ok) throw new Error("Esportazione non riuscita.");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await res.blob());
    link.download = `flashcard-${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

async function importa(campo) {
  const file = campo.files[0];
  campo.value = "";
  if (!file) return;
  let dati;
  try {
    dati = JSON.parse(await file.text());
  } catch {
    return avviso("Il file non è un JSON valido.");
  }
  campo.disabled = true;
  try {
    const r = await api("/importa", "POST", dati);
    avviso(`Importate ${r.materie} materie, ${r.argomenti} argomenti e ${r.carte} carte nuove${r.saltate ? ` (${r.saltate} già presenti, saltate)` : ""}.`, "success");
    caricaMaterie();
  } catch (e) {
    avviso(e.message);
  } finally {
    campo.disabled = false;
  }
}
