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
│   ├── ripasso.ts       carte da ripassare e registrazione del voto, usate da API e bot
│   └── telegram.ts      bot Telegram: invio programmato e gestione dei click
├── public/
│   ├── index.html       interfaccia (Bootstrap da CDN)
│   └── app.js           logica del frontend (JavaScript puro)
├── drizzle/             migrazioni SQL generate da drizzle-kit
├── drizzle.config.ts
├── wrangler.jsonc       configurazione Worker, dominio, cron, asset statici e D1
└── package.json
```

- **Backend:** TypeScript, [Hono](https://hono.dev) per il routing, [Drizzle ORM](https://orm.drizzle.team) per le query su **Cloudflare D1** (SQLite).
- **Frontend:** HTML, JavaScript puro e Bootstrap 5, senza build. È un'unica pagina che mostra una schermata alla volta.
- **Instradamento:** le richieste che corrispondono a un file in `public/` (es. `/`, `/app.js`) sono servite come asset statici; tutte le altre arrivano a Hono. Il frontend chiama le API con percorsi relativi, quindi non serve CORS.

### Modello dati

```
Materia   1 ── N  Argomento  1 ── N  Carta  1 ── 1  Ripasso
```

| Tabella | Campi |
|---|---|
| `materia` | `id_materia`, `nome_materia` |
| `argomento` | `id_argomento`, `nome_argomento`, `id_materia` |
| `carta` | `id_carta`, `domanda`, `risposta`, `opzioni` (JSON, facoltativo), `difficolta` (default 1), `id_argomento` |
| `ripasso` | `id_carta`, `ultimo_ripasso`, `prossimo_ripasso`, `media_esito`, `numero_ripassi` |
| `invio_telegram` | `id` (sempre 1), `prossimo_invio` (timestamp in millisecondi) |

- Le eliminazioni sono **a cascata**: eliminando una materia si eliminano anche i suoi argomenti, le carte e i dati di ripasso.
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

## API

Tutte le richieste e risposte sono in JSON.

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
| PUT | `/argomenti/:id` | campi da modificare | argomento aggiornato |
| DELETE | `/argomenti/:id` | – | 204 |
| GET | `/argomenti/:id/carte` | – | `[{ carta, ripasso }]` |
| GET | `/carte/:id` | – | `{ carta, ripasso }` |
| POST | `/carte` | `{ domanda, risposta, id_argomento, opzioni?, difficolta? }` | `{ carta, ripasso }` (201) |
| PUT | `/carte/:id` | campi da modificare | carta aggiornata |
| DELETE | `/carte/:id` | – | 204 |
| GET | `/carte/da-ripassare` | query facoltative `materia=ID`, `argomenti=ID,ID` | `[{ carta, ripasso }]` in ordine di priorità |
| POST | `/carte/:id/voto` | `{ voto }` intero da 0 a 5 | ripasso aggiornato |
| POST | `/telegram/webhook` | update di Telegram | 200 (401 senza il secret corretto) |

Errori:
- `400` con `{ "errore": "messaggio" }`: dati non validi o riferimenti inesistenti;
- `404` (testo semplice): risorsa non trovata;
- `409` con `{ "errore": "messaggio" }`: la carta è stata ripassata mentre arrivava il voto.

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
4. Crea le tabelle nel database remoto:
   ```bash
   npm run db:migrate:remote
   ```
5. Pubblica il Worker, che contiene API, frontend e bot:
   ```bash
   npm run deploy
   ```
   Nell'output devono comparire il dominio `(custom domain)` e `schedule: */10 * * * *`.

Il database su Cloudflare parte **vuoto**: i dati creati in locale restano solo nel database locale.

### Aggiornamenti successivi

- **Modifiche al codice** (`src/` o `public/`): basta `npm run deploy`.
- **Modifiche al database:** prima applica le migrazioni, poi pubblica (vedi [Modificare il database](#modificare-il-database)).

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
