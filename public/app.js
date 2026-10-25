const $ = (id) => document.getElementById(id);
const stato = { materia: null, argomento: null, coda: [], indice: 0 };

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
  if (!res.ok) throw new Error("Operazione non riuscita. Controlla i dati e riprova.");
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

async function elenco(id, percorso, disegna, vuoto, etichetta, crea) {
  const lista = $(id);
  lista.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';
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

function riga(testo, apri, modifica, elimina) {
  const elemento = $("modello-riga").content.firstElementChild.cloneNode(true);
  elemento.querySelector(".apri").textContent = testo;
  elemento.querySelector(".apri").onclick = apri;
  elemento.querySelector(".modifica").onclick = modifica;
  elemento.querySelector(".elimina").onclick = elimina;
  return elemento;
}

function mostra(id) {
  document.querySelectorAll(".schermata").forEach((s) => s.classList.toggle("d-none", s.id !== id));
  $("avviso").innerHTML = "";
  window.scrollTo(0, 0);
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
    (a) => riga(a.nome_argomento, () => apriArgomento(a), () => modificaArgomento(a), () => eliminaArgomento(a)),
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

function caricaCarte() {
  elenco(
    "lista-carte",
    `/argomenti/${stato.argomento.id_argomento}/carte`,
    ({ carta }) => riga(carta.domanda, () => modificaCarta(carta), () => modificaCarta(carta), () => eliminaCarta(carta)),
    "Non hai ancora carte in questo argomento.",
    "Crea la prima carta",
    nuovaCarta,
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

function modificaCarta(carta) {
  const { domanda, risposta, difficolta } = carta;
  const opzioni = (carta.opzioni ?? []).join("\n");
  apriModale("modale-carta", "Modifica carta", { domanda, risposta, opzioni, difficolta }, async (dati) => {
    await api(`/carte/${carta.id_carta}`, "PUT", datiCarta(dati));
    avviso("Carta modificata.", "success");
    caricaCarte();
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

vaiHome();
