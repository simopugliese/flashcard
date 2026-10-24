# Flashcard

Applicazione web per creare flashcard e ripassarle con un sistema di ripasso programmato.
Ogni carta appartiene a un argomento, ogni argomento a una materia. Dopo ogni risposta l'utente si dà un voto da 0 a 5 e il backend pianifica il ripasso successivo.

## Architettura

Un unico **Cloudflare Worker** serve sia le API sia il frontend.

```
flashcard/
├── src/
│   ├── schema.ts        tabelle del database (Drizzle ORM)
│   └── index.ts         tutte le API (Hono)
├── public/
│   ├── index.html       interfaccia (Bootstrap da CDN)
│   └── app.js           logica del frontend (JavaScript puro)
├── drizzle/             migrazioni SQL generate da drizzle-kit
├── drizzle.config.ts
├── wrangler.jsonc       configurazione Worker, asset statici e D1
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
| `carta` | `id_carta`, `domanda`, `risposta`, `difficolta` (default 1), `id_argomento` |
| `ripasso` | `id_carta`, `ultimo_ripasso`, `prossimo_ripasso`, `media_esito`, `numero_ripassi` |

- Le eliminazioni sono **a cascata**: eliminando una materia si eliminano anche i suoi argomenti, le carte e i dati di ripasso.
- Il ripasso viene creato automaticamente insieme alla carta, con `prossimo_ripasso` = oggi.
- Le date sono stringhe `YYYY-MM-DD` in UTC.

### Algoritmo di ripasso

- **Carte da ripassare:** quelle con `prossimo_ripasso` ≤ oggi, ordinate per `prossimo_ripasso` crescente e poi per `media_esito` crescente.
- **Dopo un voto:**
  - `numero_ripassi` aumenta di 1;
  - la media si aggiorna con `(media × n + voto) / (n + 1)`;
  - con un voto da 0 a 2 la carta torna **domani**;
  - con un voto da 3 a 5 torna tra **media × numero_ripassi** giorni (arrotondato per eccesso).

## API

Tutte le richieste e risposte sono in JSON.

| Metodo | Percorso | Body | Risposta |
|---|---|---|---|
| GET | `/materie` | – | elenco delle materie |
| GET | `/materie/:id` | – | una materia |
| POST | `/materie` | `{ nome_materia }` | materia creata (201) |
| PUT | `/materie/:id` | `{ nome_materia }` | materia aggiornata |
| DELETE | `/materie/:id` | – | 204 |
| GET | `/materie/:id/argomenti` | – | argomenti della materia |
| GET | `/argomenti/:id` | – | un argomento |
| POST | `/argomenti` | `{ nome_argomento, id_materia }` | argomento creato (201) |
| PUT | `/argomenti/:id` | campi da modificare | argomento aggiornato |
| DELETE | `/argomenti/:id` | – | 204 |
| GET | `/argomenti/:id/carte` | – | `[{ carta, ripasso }]` |
| GET | `/carte/:id` | – | `{ carta, ripasso }` |
| POST | `/carte` | `{ domanda, risposta, id_argomento, difficolta? }` | `{ carta, ripasso }` (201) |
| PUT | `/carte/:id` | campi da modificare | carta aggiornata |
| DELETE | `/carte/:id` | – | 204 |
| GET | `/carte/da-ripassare` | query facoltative `materia=ID`, `argomenti=ID,ID` | `[{ carta, ripasso }]` in ordine di priorità |
| POST | `/carte/:id/voto` | `{ voto }` intero da 0 a 5 | ripasso aggiornato |

Errori:
- `400` con `{ "errore": "messaggio" }`: dati non validi o riferimenti inesistenti;
- `404` (testo semplice): risorsa non trovata.

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

## Deploy su Cloudflare

1. Accedi al tuo account Cloudflare:
   ```bash
   npx wrangler login
   ```
2. Crea il database D1:
   ```bash
   npx wrangler d1 create flashcard
   ```
3. Copia il `database_id` restituito in `wrangler.jsonc`, al posto di `"local"`, poi fai commit e push della modifica. L'ID non è un segreto.
4. Crea le tabelle nel database remoto:
   ```bash
   npm run db:migrate:remote
   ```
5. Pubblica il Worker, che contiene sia le API sia il frontend:
   ```bash
   npm run deploy
   ```
   Se è il tuo primo Worker, Wrangler ti chiede di scegliere un sottodominio `workers.dev`.

Al termine, Wrangler stampa l'indirizzo pubblico `https://flashcard.<tuo-sottodominio>.workers.dev`.

Il database su Cloudflare parte **vuoto**: i dati creati in locale restano solo nel database locale.

### Aggiornamenti successivi

- **Modifiche al codice** (`src/` o `public/`): basta `npm run deploy`.
- **Modifiche al database:** prima applica le migrazioni, poi pubblica (vedi [Modificare il database](#modificare-il-database)).

### Proteggere l'accesso

L'app non ha autenticazione: chiunque conosca l'indirizzo pubblico può leggere e modificare i dati.
Per limitarlo, nella dashboard di Cloudflare vai su *Workers & Pages → flashcard → Settings → Domains & Routes* e attiva [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) sul dominio `workers.dev`, consentendo l'accesso solo alla tua email.

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
