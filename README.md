# Flashcard

Applicazione web per creare flashcard e ripassarle con un sistema di ripasso programmato.
Ogni carta appartiene a un argomento, ogni argomento a una materia. Dopo ogni risposta l'utente si dà un voto da 0 a 5 e il backend pianifica il ripasso successivo.
Durante la giornata le carte da ripassare arrivano anche su Telegram, a orari casuali (vedi [Bot Telegram](#bot-telegram)).

## Architettura

Un unico **Cloudflare Worker** serve le API, il frontend e il webhook del bot Telegram; un Cron Trigger lo attiva ogni 10 minuti per l'invio delle domande.

```
flashcard/
├── src/
│   ├── schema.ts        tabelle del database (Drizzle ORM)
│   ├── index.ts         tutte le API (Hono) e punto d'ingresso del Worker
│   ├── materiali.ts     API dei materiali (note e file) e pulizia dei file orfani in R2
│   ├── render.ts        rendering del LaTeX con KaTeX, al salvataggio
│   ├── spiegazioni.ts   API delle spiegazioni (manuali o AI, con cache)
│   ├── ai.ts            prompt, impronta e adapter dei provider AI (Anthropic, OpenAI-compatibile)
│   ├── validazione.ts   controlli sui body delle richieste e limiti dei materiali
│   ├── ripasso.ts       carte da ripassare e registrazione del voto, usate da API e bot
│   └── telegram.ts      bot Telegram: invio programmato e gestione dei click
├── public/
│   ├── index.html       interfaccia (Bootstrap da CDN)
│   └── app.js           logica del frontend (JavaScript puro)
├── drizzle/             migrazioni SQL generate da drizzle-kit
├── drizzle.config.ts
├── wrangler.jsonc       configurazione Worker, dominio, cron, asset statici, D1 e R2
└── package.json
```

- **Backend:** TypeScript, [Hono](https://hono.dev) per il routing, [Drizzle ORM](https://orm.drizzle.team) per le query su **Cloudflare D1** (SQLite).
- **File:** i file dei materiali stanno in **Cloudflare R2** (binding `FILES`); in D1 restano solo i metadati.
- **AI (facoltativa):** le spiegazioni si possono generare con un provider esterno, chiamato con `fetch` (nessun SDK) e solo su richiesta esplicita; vedi [Spiegazioni](#spiegazioni).
- **Frontend:** HTML, JavaScript puro e Bootstrap 5, senza build. È un'unica pagina che mostra una schermata alla volta.
- **Instradamento:** le richieste che corrispondono a un file in `public/` (es. `/`, `/app.js`) sono servite come asset statici; tutte le altre arrivano a Hono. Il frontend chiama le API con percorsi relativi, quindi non serve CORS.

### Modello dati

```
Materia   1 ── N  Argomento  1 ── N  Carta  1 ── 1  Ripasso
                     │               │  └── 1 ── 0..1  Spiegazione
                     └── N Materiale ┘   (di un argomento oppure di una carta)
```

| Tabella | Campi |
|---|---|
| `materia` | `id_materia`, `nome_materia` |
| `argomento` | `id_argomento`, `nome_argomento`, `id_materia` |
| `carta` | `id_carta`, `domanda`, `risposta`, `domanda_render`, `risposta_render` (HTML del [LaTeX](#latex), `null` finché non calcolato), `opzioni` (JSON, facoltativo), `difficolta` (default 3 se creata da API; la colonna nel DB ha ancora default 1), `id_argomento` |
| `ripasso` | `id_carta`, `ultimo_ripasso`, `prossimo_ripasso`, `media_esito`, `numero_ripassi` |
| `materiale` | `id_materiale`, `tipo` (`testo` o `file`), `titolo`, `testo`, `testo_render` (HTML del [LaTeX](#latex) delle note, `null` per i file), `hash`, `mime`, `dimensione`, `id_argomento` **oppure** `id_carta` (esattamente uno dei due, imposto da un vincolo CHECK), `creato_il` (millisecondi) |
| `spiegazione` | `id_carta` (chiave, una per carta), `testo`, `testo_render` (HTML del [LaTeX](#latex)), `fonte` (`manuale` o `ai`), `modello` (`null` se manuale), `impronta` (SHA-256 di domanda, risposta e contenuto dei materiali usati), `materiali` (JSON degli id usati), `creata_il` (millisecondi) |
| `uso_ai` | `giorno` (`YYYY-MM-DD`, ora italiana), `chiamate`: contatore per il tetto giornaliero delle chiamate AI |
| `invio_telegram` | `id` (sempre 1), `prossimo_invio` (timestamp in millisecondi) |

- Le eliminazioni sono **a cascata**: eliminando una materia si eliminano anche i suoi argomenti, le carte, i materiali, le spiegazioni e i dati di ripasso. I file rimasti senza materiali vengono tolti anche da R2 (vedi [Materiali](#materiali)).
- Il ripasso viene creato automaticamente insieme alla carta, con `prossimo_ripasso` = oggi.
- Le date sono stringhe `YYYY-MM-DD` in UTC.

### Algoritmo di ripasso

- **Carte da ripassare:** quelle con `prossimo_ripasso` ≤ oggi, ordinate per `prossimo_ripasso` crescente, poi per `difficolta` decrescente (a parità di data le più difficili per prime) e infine per `media_esito` crescente.
- **Dopo un voto:**
  - `numero_ripassi` aumenta di 1;
  - la media si aggiorna con `(media × n + voto) / (n + 1)`;
  - con un voto da 0 a 2 la carta torna **domani**;
  - con un voto da 3 a 5 torna tra **media × numero_ripassi × fattore** giorni (arrotondato per eccesso, minimo 1), dove il fattore dipende dalla difficoltà della carta.
- **Difficoltà:** va da 1 (molto facile) a 5 (molto difficile); il 3 è neutro. Il fattore dell'intervallo è `1 + (3 − difficoltà) × 0.2`, quindi 1.4 · 1.2 · 1.0 · 0.8 · 0.6: le carte difficili tornano prima, quelle facili più tardi. Il voto da 0 a 2 rimanda sempre a domani, qualunque sia la difficoltà.
- Un voto viene registrato solo se nel frattempo la carta non è stata ripassata: un doppio click o un vecchio messaggio Telegram non possono sovrascrivere un ripasso più recente.
- Le date (`oggi`, `ultimo_ripasso`, `prossimo_ripasso`) sono in **ora italiana**: un voto dato a mezzanotte e mezza conta per il nuovo giorno.

### Media di risposta

Nell'elenco di carte e argomenti, accanto a ogni riga, l'app mostra la media dei voti e il numero di ripassi (es. `media 3.5 · 4 ripassi`). Se non c'è ancora nessun ripasso compare *mai ripassata* (carta) o *mai ripassato* (argomento).

- **Carta:** `media_esito` e `numero_ripassi` del suo ripasso, già inclusi in `GET /argomenti/:id/carte`.
- **Argomento:** `GET /materie/:id/argomenti` aggiunge a ogni argomento due campi calcolati dal database:
  - `ripassi`: somma dei `numero_ripassi` delle sue carte (0 se non ce ne sono);
  - `media`: media dei voti dati nell'argomento pesata per difficoltà (formula qui sotto), oppure `null` se `ripassi` è 0.
- La media è **pesata** due volte: una carta ripassata 10 volte conta 10 volte più di una ripassata una sola, e ogni voto pesa quanto la **difficoltà** della carta. Quindi `media = Σ(media_esito × numero_ripassi × difficoltà) / Σ(numero_ripassi × difficoltà)`: i voti sulle carte difficili contano di più di quelli sulle carte facili. Le carte mai ripassate non influiscono; `ripassi` resta il numero semplice di ripassi.

### Ricerca

Nella pagina di una materia il pulsante **Cerca** apre una schermata che cerca nelle carte di *quella* materia.

- **Dati:** premendo Cerca il frontend scarica una volta sola le carte della materia (`GET /materie/:id/carte`); da lì il filtro lavora in memoria, quindi i risultati compaiono mentre si scrive, senza altre richieste. Non c'è cache: ogni volta che si riapre la ricerca i dati sono ricaricati, e lo stesso avviene dopo ogni modifica di una carta fatta dai risultati.
- **Dove cerca:** nella domanda, nella risposta e nelle opzioni sbagliate. Ogni risultato mostra i badge **Domanda**, **Risposta**, **Opzioni** dove ha trovato qualcosa, il nome dell'argomento e il testo trovato evidenziato.
- **Confronto:** senza distinzione di maiuscole e accenti (`perche`, `perché` e `PERCHÈ` sono equivalenti), con ogni spazio o a capo trattato come uno spazio.
- **Più parole:** devono esserci tutte, in qualsiasi ordine, anche in campi diversi. Se compaiono vicine e nell'ordine scritto il risultato ha il badge **Frase esatta**. Tra virgolette (`"cielo blu"`) cerca solo la frase esatta.
- **Ordine:** prima le frasi esatte, poi le corrispondenze nella domanda, poi quelle solo in risposta o opzioni.
- **Filtro per argomento:** le caselle sotto il campo escludono gli argomenti non selezionati.
- Si mostrano al massimo 100 risultati (costante `MAX_RISULTATI` in `public/app.js`); oltre, la schermata invita ad affinare la ricerca. Cliccando un risultato si apre la modifica della carta.

### Materiali

Ad **argomenti** e **carte** si possono collegare materiali di studio: **note** di testo (anche con formule LaTeX, scritte come testo) e **file**. Il materiale di un argomento serve per i contenuti grandi e condivisi da più carte; quello di una carta per ciò che riguarda solo lei.

- **Archiviazione:** i byte dei file stanno in R2, la riga in D1 contiene solo i metadati. La chiave dell'oggetto è lo **SHA-256 del contenuto**, quindi lo stesso file caricato più volte occupa un solo oggetto. Quando l'ultimo materiale che lo usa viene eliminato (direttamente o a cascata, eliminando carta, argomento o materia) il file viene tolto da R2.
- **Tipi ammessi:** PNG, JPEG, GIF, WebP, PDF e testo semplice. SVG e HTML sono esclusi di proposito, perché potrebbero eseguire codice nel browser. Il tipo dichiarato dal client non basta: il server controlla anche i primi byte del file.
- **Download:** `GET /materiali/:id/file` restituisce il file con `X-Content-Type-Options: nosniff` e una `Content-Security-Policy` restrittiva. Le immagini si aprono nel browser, gli altri tipi si scaricano.
- **Limiti** (costanti in cima al blocco "Limiti dei materiali" di `src/validazione.ts`):

  | Limite | Valore |
  |---|---|
  | Dimensione di un file | 2 MB |
  | File per carta | 3 |
  | File per argomento | 150 (conta solo i file dell'argomento stesso, non quelli delle sue carte) |
  | Lunghezza di una nota | 20 000 caratteri |
  | Lunghezza del titolo | 100 caratteri |

  Le note di testo non hanno un limite di numero e non c'è un tetto sullo spazio totale in R2: per i costi si usa l'allerta di budget di Cloudflare.
- **Stato:** per ora c'è solo il backend. L'interfaccia e l'inclusione nell'esportazione sono i passi successivi.

### LaTeX

Nelle domande, nelle risposte e nelle note le formule si scrivono tra `$...$` (in linea) e `$$...$$` (a blocco); `\$` è un dollaro letterale. Il **Worker le renderizza con KaTeX una sola volta, al salvataggio**, e salva l'HTML accanto al testo grezzo (`domanda_render`, `risposta_render`, `testo_render`). Ripasso e vista a carte mostrano l'HTML già pronto (serve solo il CSS di KaTeX, caricato da CDN); la finestra di modifica, l'elenco, la ricerca e il bot Telegram usano il testo grezzo.

- Il testo fuori dalle formule viene escapato (niente HTML dall'utente) e gli a capo diventano `<br>`. KaTeX gira con `trust: false`.
- Frasi come «costa $5 e $6» restano testo: l'apertura non ha spazio dopo, la chiusura non ha spazio prima né una cifra dopo. Al massimo 200 formule per testo.
- L'importazione rigenera sempre l'HTML; l'esportazione (versione 1) non lo include.
- **Carte esistenti:** finché `*_render` è `null` il frontend mostra il testo grezzo. Per calcolarlo, dopo il deploy, ripeti `POST /rirenderizza` (100 elementi per chiamata) finché `rimaste` è 0:

  ```bash
  # in locale
  until curl -s -X POST http://localhost:8787/rirenderizza | tee /dev/stderr | grep -q '"rimaste":0'; do :; done
  ```

  In produzione un `curl` da terminale viene fermato da Cloudflare Access: apri l'app nel browser (già loggato) e lancia dalla console, ripetendo finché `rimaste` è 0:

  ```js
  await fetch("/rirenderizza", { method: "POST" }).then((r) => r.json())
  ```

### Spiegazioni

Ogni carta può avere **una spiegazione**, scritta a mano oppure generata dall'AI. Una volta salvata fa da **cache**: richiederla di nuovo non richiama mai l'AI, a meno di chiedere esplicitamente `rigenera: true`. Una spiegazione scritta a mano non viene mai sovrascritta senza `rigenera: true`.

- **Contesto:** a ogni richiesta si scelgono i materiali da dare all'AI, tra quelli della carta e del suo argomento (altri id danno 400). Note e file di testo vanno come testo, immagini e PDF come allegati.
- **Obsoleta:** al salvataggio si calcola un'`impronta` (SHA-256 di domanda, risposta e contenuto dei materiali usati). Se poi la carta o uno di quei materiali cambia, o un materiale viene eliminato, le risposte riportano `obsoleta: true`: la spiegazione resta visibile e si può rigenerare.
- **Sicurezza del prompt:** carta e materiali arrivano al modello tra tag (`<carta>`, `<materiale>`) con `<`, `>`, `&` escapati, e il prompt di sistema dice di trattarli solo come dati, ignorando eventuali istruzioni contenute. Il testo restituito passa da `rendi` come tutto il resto (niente HTML dal modello).
- **Senza AI:** `POST /carte/:id/spiegazione/prompt` restituisce il prompt già pronto da incollare in una chat qualsiasi (gli allegati sono elencati da aggiungere a mano); la risposta si salva con `PUT /carte/:id/spiegazione`. Così l'app funziona anche senza provider configurato.
- **Quando si chiama l'AI:** solo da `POST /carte/:id/spiegazione/genera`. Mai dal cron né da Telegram.
- **Limiti** (costanti in cima a `src/ai.ts`; il numero di materiali è in `src/validazione.ts`):

  | Limite | Valore |
  |---|---|
  | Materiali per richiesta | 20 |
  | Immagini per chiamata | 5 |
  | Byte totali dei materiali inviati | 8 MB |
  | Chiamate AI al giorno (contatore in `uso_ai`, ora italiana) | 30 |

  Ogni tentativo di chiamata conta nel limite giornaliero, anche se il provider poi risponde con un errore.

#### Provider AI

Il provider si sceglie con le variabili del Worker. Senza `AI_PROVIDER` la funzione AI è spenta (`ai: false` nelle risposte) e resta la modalità manuale.

| Variabile | `anthropic` | `openai` (qualsiasi API compatibile: OpenAI, OpenRouter, Ollama…) |
|---|---|---|
| `AI_PROVIDER` | `anthropic` | `openai` |
| `AI_API_KEY` | obbligatoria | facoltativa (Ollama in locale non la vuole) |
| `AI_MODEL` | facoltativa, default `claude-opus-5-5` | obbligatoria |
| `AI_BASE_URL` | – | obbligatoria, es. `https://api.openai.com/v1` (il Worker aggiunge `/chat/completions`) |

- Con Anthropic i PDF sono supportati; con l'adapter OpenAI-compatibile no (400 se selezionati), perché non c'è un formato standard. Per i modelli Anthropic recenti la richiesta abilita il fallback lato server: se il modello rifiuta, l'API ripete la richiesta con un altro modello, e `modello` registra quello che ha risposto davvero.
- **La chiave è il vero rischio di spesa.** Usa una chiave **dedicata a questo progetto**, imposta un **limite di spesa mensile** sulla console del provider e salvala solo come secret:
  ```bash
  npx wrangler secret put AI_PROVIDER   # anthropic oppure openai
  npx wrangler secret put AI_API_KEY
  npx wrangler secret put AI_MODEL      # facoltativa con anthropic
  npx wrangler secret put AI_BASE_URL   # solo con openai
  ```
  In locale vanno in `.dev.vars`. Per spegnere l'AI: `npx wrangler secret delete AI_PROVIDER`.

## API

Tutte le richieste e risposte sono in JSON, tranne il caricamento di un file (`multipart/form-data`) e il suo download.

| Metodo | Percorso | Body | Risposta |
|---|---|---|---|
| GET | `/materie` | – | elenco delle materie |
| GET | `/materie/:id` | – | una materia |
| POST | `/materie` | `{ nome_materia }` | materia creata (201) |
| PUT | `/materie/:id` | `{ nome_materia }` | materia aggiornata |
| DELETE | `/materie/:id` | – | 204 |
| GET | `/materie/:id/argomenti` | – | argomenti della materia, ciascuno con `media` e `ripassi` (vedi [Media di risposta](#media-di-risposta)) |
| GET | `/materie/:id/carte` | – | tutte le carte della materia, ciascuna con `nome_argomento` (usata dalla [Ricerca](#ricerca)) |
| GET | `/argomenti/:id` | – | un argomento |
| POST | `/argomenti` | `{ nome_argomento, id_materia }` | argomento creato (201) |
| PUT | `/argomenti/:id` | `{ nome_argomento }` | argomento aggiornato |
| DELETE | `/argomenti/:id` | – | 204 |
| GET | `/argomenti/:id/carte` | – | `[{ carta, ripasso }]` |
| GET | `/carte/:id` | – | `{ carta, ripasso }` |
| POST | `/carte` | `{ domanda, risposta, id_argomento, opzioni?, difficolta? }` | `{ carta, ripasso }` (201) |
| PUT | `/carte/:id` | almeno uno tra `domanda`, `risposta`, `opzioni`, `difficolta` | carta aggiornata |
| DELETE | `/carte/:id` | – | 204 |
| GET | `/argomenti/:id/materiali` | – | materiali dell'argomento (404 se non esiste) |
| GET | `/carte/:id/materiali` | – | materiali della carta (404 se non esiste) |
| POST | `/argomenti/:id/materiali`, `/carte/:id/materiali` | **nota:** JSON `{ testo, titolo? }`. **File:** `multipart/form-data` con campo `file` e `titolo` facoltativo (se manca si usa il nome del file) | materiale creato (201). 413 se il file supera i 2 MB, 400 per tipo non ammesso o limite per carta/argomento raggiunto |
| PUT | `/materiali/:id` | almeno uno tra `titolo` (vuoto = nessun titolo) e `testo` (solo per le note) | materiale aggiornato |
| DELETE | `/materiali/:id` | – | 204; il file va via da R2 se nessun altro materiale lo usa |
| GET | `/materiali/:id/file` | – | il file (404 per le note) |
| GET | `/carte/:id/spiegazione` | – | `{ spiegazione, obsoleta, ai }`: `spiegazione` è `null` se non c'è; `ai` dice se un provider è configurato (vedi [Spiegazioni](#spiegazioni)) |
| PUT | `/carte/:id/spiegazione` | `{ testo, materiali? }` (id dei materiali usati come contesto) | `{ spiegazione, obsoleta, ai }`: salva una spiegazione **manuale**, sostituendo quella esistente |
| POST | `/carte/:id/spiegazione/genera` | `{ materiali?, rigenera? }` | `{ spiegazione, obsoleta, ai, dalla_cache }`. Se esiste già e manca `rigenera: true` restituisce quella salvata **senza chiamare l'AI**. 503 se l'AI non è configurata, 429 oltre il limite giornaliero, 502 se il provider fallisce |
| POST | `/carte/:id/spiegazione/prompt` | `{ materiali? }` | `{ prompt, allegati }`: il prompt da copiare in una chat esterna, con l'elenco di immagini e PDF da allegare a mano. Non chiama l'AI |
| POST | `/rirenderizza` | – | `{ rinnovate, rimaste }`: calcola l'HTML LaTeX di carte e note che non ce l'hanno (max 100 per chiamata, idempotente), vedi [LaTeX](#latex) |
| GET | `/carte/da-ripassare` | query facoltative `materia=ID`, `argomenti=ID,ID`, `modo=scadenza\|anticipo\|tutte` (default `scadenza`), `casuale=0\|1`, `limite=1..500` | `[{ carta, ripasso }]` in ordine di priorità |
| POST | `/carte/:id/voto` | `{ voto }` intero da 0 a 5 | ripasso aggiornato |
| GET | `/esporta` | — | archivio JSON (`versione: 1`, materie → argomenti → carte con dati di ripasso), scaricabile |
| POST | `/importa` | archivio JSON nel formato di `/esporta`; `?azzera=1` riporta i ripassi a zero | `{ materie, argomenti, carte, saltate }`: i record **nuovi** creati e le carte già presenti saltate. Materie e argomenti con lo stesso nome si riusano, le carte con stessa domanda e risposta nello stesso argomento si saltano: reimportare lo stesso file non cambia nulla. Atomico: in caso di errore non scrive niente (409 se i dati cambiano durante l'importazione). Max 5000 carte |
| POST | `/telegram/webhook` | update di Telegram | 200 (401 senza il secret corretto) |

Validazione dei body: si accettano solo i campi elencati (un campo in più, anche solo scritto male, dà 400). `nome_materia` e `nome_argomento` sono testi non vuoti fino a 100 caratteri, `domanda` e `risposta` fino a 5000; `opzioni` è `null` o un elenco di al massimo 9 testi; `difficolta` è un intero da 1 a 5 (3 se omessa). Gli spazi iniziali e finali vengono tolti. In modifica non si possono cambiare `id_materia` e `id_argomento`. Per i materiali valgono i limiti della sezione [Materiali](#materiali).

Errori:
- `400` con `{ "errore": "messaggio" }`: dati non validi, id non numerico, JSON malformato o riferimenti inesistenti;
- `404` (testo semplice): risorsa non trovata;
- `409` con `{ "errore": "messaggio" }`: la carta è stata ripassata mentre arrivava il voto, oppure esiste già un elemento con lo stesso nome;
- `413` con `{ "errore": "messaggio" }`: file oltre il limite di dimensione;
- `429` con `{ "errore": "messaggio" }`: limite giornaliero delle chiamate AI raggiunto;
- `502` con `{ "errore": "messaggio" }`: il provider AI non ha risposto correttamente (il dettaglio finisce nei log del Worker);
- `503` con `{ "errore": "messaggio" }`: funzione AI non configurata;
- `500` con `{ "errore": "errore interno" }`: errore imprevisto, il dettaglio finisce nei log del Worker.

Esempio:

```bash
curl -X POST localhost:8787/carte/1/voto -H "Content-Type: application/json" -d '{"voto": 4}'
```

## Avvio in locale

Requisiti: Node.js 22 o superiore (richiesto da Wrangler).

```bash
npm install
npm run db:migrate:local
npm run dev
```

L'app è disponibile su <http://localhost:8787>. Il database locale viene salvato in `.wrangler/`.

Per provare l'invio delle domande serve il file `.dev.vars` (vedi [Configurazione](#configurazione)); poi avvia `npx wrangler dev --test-scheduled` e apri <http://localhost:8787/__scheduled> per eseguire il cron a mano. I click sui bottoni arrivano solo al Worker pubblicato, perché il webhook punta al dominio pubblico.

## Deploy su Cloudflare

1. Accedi al tuo account Cloudflare:
   ```bash
   npx wrangler login --scopes account:read user:read workers:write workers_scripts:write d1:write
   ```
2. Crea il database D1:
   ```bash
   npx wrangler d1 create flashcard
   ```
3. Copia il `database_id` restituito in `wrangler.jsonc`, al posto di `"local"`, poi fai commit e push della modifica. L'ID non è un segreto.
   Nello stesso file, in `routes`, metti il tuo dominio (deve essere gestito da Cloudflare): il Worker viene pubblicato come custom domain e l'indirizzo `workers.dev` resta disattivato.
4. Crea il bucket R2 per i file dei materiali (il nome deve coincidere con `bucket_name` in `wrangler.jsonc`). R2 non richiede secret: il Worker lo raggiunge tramite il binding `FILES`. Il bucket resta privato, non attivare l'accesso pubblico (`r2.dev` o dominio):
   ```bash
   npx wrangler r2 bucket create flashcard-files
   ```
   Su Cloudflare conviene impostare un'allerta di budget per R2 (*Notifications*): non esiste un tetto di spesa rigido.
5. Crea le tabelle nel database remoto:
   ```bash
   npm run db:migrate:remote
   ```
6. Pubblica il Worker, che contiene API, frontend e bot:
   ```bash
   npm run deploy
   ```
   Nell'output devono comparire il dominio `(custom domain)` e `schedule: */10 * * * *`.

Il database su Cloudflare parte **vuoto**: i dati creati in locale restano solo nel database locale.

### Aggiornamenti successivi

- **Modifiche al codice** (`src/` o `public/`): basta `npm run deploy`.
- **Modifiche al database:** prima applica le migrazioni, poi pubblica (vedi [Modificare il database](#modificare-il-database)).
- **Dopo l'aggiornamento che introduce il [LaTeX](#latex):** `npm run db:migrate:remote`, poi `npm run deploy`, poi `POST /rirenderizza` fino a `rimaste: 0` (dalla console del browser, vedi [LaTeX](#latex)).
- **Dopo l'aggiornamento che introduce le [Spiegazioni](#spiegazioni):** `npm run db:migrate:remote`, poi `npm run deploy`. L'AI resta spenta finché non imposti i secret del [provider](#provider-ai).

### Proteggere l'accesso

L'app non ha autenticazione propria: chiunque raggiunga il dominio può leggere e modificare i dati.
Proteggilo con [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/), da *Zero Trust → Access → Applications*:

1. un'applicazione **Self-hosted** su tutto il dominio, con una policy **Allow** solo per la tua email;
2. un'applicazione **Self-hosted** sullo stesso dominio con path `telegram/webhook`, con una policy **Bypass** che include solo gli IP da cui Telegram invia i webhook: `149.154.160.0/20` e `91.108.4.0/22`. Il percorso più specifico prevale, quindi tutto il resto resta dietro login.

Verifica:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<dominio>/materie                      # 302: login di Access
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<dominio>/telegram/webhook     # 403: non sei Telegram
```

## Bot Telegram

Tra le **8 e le 23** (ora italiana), a distanza casuale tra **30 e 90 minuti**, il bot invia una carta scelta a caso tra quelle da ripassare, con probabilità proporzionale alla difficoltà (una carta di difficoltà 5 esce cinque volte più spesso di una di difficoltà 1). Sotto la domanda c'è il bottone **Vedi risposta**; premendolo il messaggio mostra la risposta e i bottoni **0–5**, e il voto viene registrato come dall'app web. Se la carta ha delle `opzioni` (risposte sbagliate), diventa a scelta multipla: la domanda arriva con le opzioni A, B, C… mescolate e al posto di *Vedi risposta* ci sono i bottoni con le lettere; dopo la scelta il messaggio segna quella giusta (✅) e quella sbagliata (❌) e mostra i bottoni **0–5**. Il voto resta sempre manuale. Orari e frequenza si cambiano con le costanti in cima a `src/telegram.ts`.

Funzionamento:
- il cron gira ogni 10 minuti e invia solo quando è passato l'orario salvato in `invio_telegram.prossimo_invio`, poi ne sceglie uno nuovo;
- se non ci sono carte da ripassare non invia nulla;
- i click arrivano da Telegram al webhook `POST /telegram/webhook`, che risponde sempre 200 alle richieste autentiche (altrimenti Telegram le ripeterebbe).

### Sicurezza

- Il webhook è l'unico percorso escluso da Access, e solo per gli IP di Telegram.
- Il Worker accetta la richiesta solo se l'header `X-Telegram-Bot-Api-Secret-Token` coincide con `TELEGRAM_WEBHOOK_SECRET` (confronto a tempo costante), altrimenti risponde 401.
- Vengono gestiti solo i click fatti dal tuo account (`TELEGRAM_CHAT_ID`) nella chat privata col bot; tutto il resto è ignorato.
- Il bot non può essere aggiunto ai gruppi e il webhook riceve solo i click (`callback_query`), non i messaggi.

### Configurazione

1. Con [@BotFather](https://t.me/BotFather) crea il bot (`/newbot`) e disattiva i gruppi (`/setjoingroups` → *Disable*).
2. Apri il bot e premi **Avvia**: finché non lo fai, il bot non può scriverti.
3. Salva i tre secret del Worker:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN       # token dato da BotFather
   npx wrangler secret put TELEGRAM_CHAT_ID         # il tuo id utente Telegram
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # stringa casuale, es. openssl rand -hex 32
   ```
   Per lo sviluppo locale metti gli stessi valori in `.dev.vars` (formato `NOME=valore`), già escluso da git.
4. Configura Access come in [Proteggere l'accesso](#proteggere-laccesso) e pubblica il Worker.
5. Registra il webhook (una volta sola). Il comando legge token e secret da `.dev.vars` in una subshell, così non restano nel terminale né nella cronologia:
   ```bash
   ( set -a; . ./.dev.vars; curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -H "Content-Type: application/json" -d "{\"url\":\"https://<dominio>/telegram/webhook\",\"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\",\"allowed_updates\":[\"callback_query\"],\"drop_pending_updates\":true}" ); echo
   ```
6. Controlla lo stato del webhook; dopo un click non deve comparire `last_error_message`:
   ```bash
   ( set -a; . ./.dev.vars; curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo" ); echo
   ```

## Modificare il database

1. Modifica `src/schema.ts`.
2. Genera la migrazione in `drizzle/`:
   ```bash
   npm run db:generate
   ```
3. Applicala in locale e provala con `npm run dev`:
   ```bash
   npm run db:migrate:local
   ```
4. Applicala al database remoto **prima** di pubblicare il nuovo codice, poi pubblica:
   ```bash
   npm run db:migrate:remote
   npm run deploy
   ```

## Script disponibili

| Comando | Cosa fa |
|---|---|
| `npm run dev` | avvia il Worker in locale |
| `npm run deploy` | pubblica su Cloudflare |
| `npm run db:generate` | genera una migrazione da `src/schema.ts` |
| `npm run db:migrate:local` | applica le migrazioni al D1 locale |
| `npm run db:migrate:remote` | applica le migrazioni al D1 su Cloudflare |
