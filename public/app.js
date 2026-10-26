const $ = (id) => document.getElementById(id);
const stato = { materia: null, argomento: null, coda: [], indice: 0 };
const ricerca = { carte: [], esclusi: new Set() };
const MAX_RISULTATI = 100;
const caricamento = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';

async function api(percorso, metodo = "GET", dati) {
  let res;
  try {
    res = await fetch(percorso, {
      method: metodo,
      headers: { "Content-Type": "application/json" },
      body: dati && JSON.stringify(dati),
    });
  } catch {
    throw new Error("Impossibile contattare il server. Controlla la connessione e riprova.");
  }
  if (res.status === 404) throw new Error("Elemento non trovato: potrebbe essere stato eliminato.");
  if (res.status >= 500) throw new Error("Errore del server, riprova tra poco.");
  if (!res.ok) {
    const errore = await res.json().then((j) => j?.errore, () => null);
    throw new Error(errore ? `Operazione non riuscita: ${errore}.` : "Operazione non riuscita. Controlla i dati e riprova.");
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
    if (await esegui(form.querySelector("[type=submit]"), errore, () => salva(dati))) bootstrap.Modal.getInstance(modale).hide();
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
  try {
    const elementi = await api(percorso);
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
  elemento.querySelector(".domanda").textContent = carta.domanda;
  elemento.querySelector(".risposta").textContent = (carta.opzioni?.length ? "✓ " : "") + carta.risposta;
  elemento.querySelector(".nota").textContent = statistiche(ripasso.media_esito, ripasso.numero_ripassi, "mai ripassata");
  elemento.querySelector(".multipla").classList.toggle("d-none", !carta.opzioni?.length);
  elemento.querySelector(".risposta").classList.toggle("text-success", !!carta.opzioni?.length);
  elemento.querySelector(".sbagliate").replaceChildren(
    ...(carta.opzioni ?? []).map((o) => Object.assign(document.createElement("li"), { textContent: o })),
  );
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
  const opzioni = dati.opzioni.split("\n").map((o) => o.trim()).filter(Boolean).slice(0, 9);
  return { ...dati, difficolta: +dati.difficolta, opzioni: opzioni.length ? opzioni : null };
}

function nuovaCarta() {
  apriModale("modale-carta", "Nuova carta", {}, async (dati) => {
    await api("/carte", "POST", { ...datiCarta(dati), id_argomento: stato.argomento.id_argomento });
    avviso("Carta creata.", "success");
    caricaCarte();
  });
}

function modificaCarta(carta, dopo = caricaCarte) {
  const { domanda, risposta, difficolta } = carta;
  const opzioni = (carta.opzioni ?? []).join("\n");
  apriModale("modale-carta", "Modifica carta", { domanda, risposta, opzioni, difficolta }, async (dati) => {
    await api(`/carte/${carta.id_carta}`, "PUT", datiCarta(dati));
    avviso("Carta modificata.", "success");
    dopo();
  });
}

function eliminaCarta(carta) {
  conferma(`Vuoi eliminare la carta «${carta.domanda}»?`, async () => {
    await api(`/carte/${carta.id_carta}`, "DELETE");
    avviso("Carta eliminata.", "success");
    caricaCarte();
  });
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
    const coda = await api(`/carte/da-ripassare?materia=${$("scelta-materia").value}&argomenti=${argomenti}`);
    if (!coda.length) return avviso("Non ci sono carte da ripassare per la selezione scelta. Riprova più avanti o scegli altri argomenti.", "info");
    stato.coda = coda;
    stato.indice = 0;
    mostra("sessione");
    mostraCarta();
  });
}

function mostraCarta() {
  const { carta } = stato.coda[stato.indice];
  $("progresso").textContent = `Carta ${stato.indice + 1} di ${stato.coda.length}`;
  $("domanda").textContent = carta.domanda;
  $("risposta").textContent = carta.risposta;
  $("blocco-risposta").classList.add("d-none");
  $("voti").classList.add("d-none");
  $("avviso-voto").innerHTML = "";
  const quiz = carta.opzioni?.length;
  $("mostra-risposta").classList.toggle("d-none", !!quiz);
  $("opzioni").classList.toggle("d-none", !quiz);
  $("opzioni").replaceChildren(...(quiz ? opzioniMescolate(carta).map((testo) => bottoneOpzione(carta, testo)) : []));
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

function mostraRisposta() {
  $("blocco-risposta").classList.remove("d-none");
  $("voti").classList.remove("d-none");
  $("mostra-risposta").classList.add("d-none");
}

async function vota(voto) {
  const { carta } = stato.coda[stato.indice];
  if (!(await esegui($("voti"), $("avviso-voto"), () => api(`/carte/${carta.id_carta}/voto`, "POST", { voto })))) return;
  stato.indice++;
  if (stato.indice < stato.coda.length) mostraCarta();
  else mostra("fine");
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
