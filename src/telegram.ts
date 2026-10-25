import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { argomento, carta, invio_telegram, materia, ripasso } from "./schema";
import { carteDaRipassare, registraVoto } from "./ripasso";

export type Env = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
};

type Messaggio = { message_id: number; chat: { id: number } };
type CallbackQuery = { id: string; from: { id: number }; data?: string; message?: Messaggio };

// Le domande arrivano solo tra le 9 e le 22 (ora italiana), a distanza casuale tra 1 e 3 ore.
const ORA_INIZIO = 9;
const ORA_FINE = 22;
const MINUTI_MIN = 60;
const MINUTI_MAX = 180;

const tg = async (env: Env, metodo: string, body: object) => {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json<{ ok: boolean; description?: string }>();
  if (!j.ok) throw new Error(`Telegram ${metodo}: ${j.description}`);
};

// Confronto a tempo costante: gli hash hanno sempre la stessa lunghezza.
export const segretoValido = async (ricevuto: string | undefined, atteso: string | undefined) => {
  if (!ricevuto || !atteso) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([ricevuto, atteso].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
};

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Telegram accetta messaggi fino a 4096 caratteri.
const breve = (s: string, max: number) => html(s.length > max ? s.slice(0, max) + "…" : s);
const data = (s: string) => s.split("-").reverse().join("/");

const leggiCarta = async (d: DrizzleD1Database, id: number) => {
  const [k] = await d
    .select({ carta, ripasso, nome_argomento: argomento.nome_argomento, nome_materia: materia.nome_materia })
    .from(carta)
    .innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
    .innerJoin(argomento, eq(argomento.id_argomento, carta.id_argomento))
    .innerJoin(materia, eq(materia.id_materia, argomento.id_materia))
    .where(eq(carta.id_carta, id));
  return k;
};
type CartaCompleta = NonNullable<Awaited<ReturnType<typeof leggiCarta>>>;

const LETTERE = "ABCDEFGHIJ";

// Ordine delle opzioni stabile per carta e ripasso (mulberry32): il messaggio e il click calcolano lo stesso ordine.
const opzioniMescolate = (k: CartaCompleta) => {
  const tutte = [k.carta.risposta, ...(k.carta.opzioni ?? [])].slice(0, LETTERE.length);
  let seme = (k.carta.id_carta * 100003 + k.ripasso.numero_ripassi) >>> 0;
  const casuale = () => {
    seme = (seme + 0x6d2b79f5) >>> 0;
    let t = seme;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = tutte.length - 1; i > 0; i--) {
    const j = Math.floor(casuale() * (i + 1));
    [tutte[i], tutte[j]] = [tutte[j], tutte[i]];
  }
  return tutte;
};
const èQuiz = (k: CartaCompleta) => !!k.carta.opzioni?.length;

const intestazione = (k: CartaCompleta) =>
  `<i>${breve(k.nome_materia, 100)} · ${breve(k.nome_argomento, 100)}</i>\n\n<b>Domanda</b>\n${breve(k.carta.domanda, 1500)}`;

// Con `scelta` (indice scelto) le opzioni vengono corrette: ✅ giusta, ❌ scelta sbagliata.
const elencoOpzioni = (k: CartaCompleta, scelta?: number) =>
  opzioniMescolate(k)
    .map((o, i) => {
      const segno = scelta === undefined ? "" : o === k.carta.risposta ? "✅ " : i === scelta ? "❌ " : "";
      return `${segno}<b>${LETTERE[i]}</b>) ${breve(o, 120)}`;
    })
    .join("\n");

const testoDomanda = (k: CartaCompleta) => (èQuiz(k) ? `${intestazione(k)}\n\n${elencoOpzioni(k)}` : intestazione(k));
const testoRisposta = (k: CartaCompleta, scelta?: number) =>
  èQuiz(k)
    ? `${intestazione(k)}\n\n${elencoOpzioni(k, scelta)}\n\n<b>Risposta</b>\n${breve(k.carta.risposta, 1000)}`
    : `${intestazione(k)}\n\n<b>Risposta</b>\n${breve(k.carta.risposta, 1800)}`;

// numero_ripassi viaggia nei bottoni: un click su un messaggio vecchio non può sovrascrivere un ripasso più recente.
const inviaCarta = (env: Env, k: CartaCompleta) => {
  const base = `${k.carta.id_carta}:${k.ripasso.numero_ripassi}`;
  const bottoni = èQuiz(k)
    ? opzioniMescolate(k).map((_, i) => ({ text: LETTERE[i], callback_data: `q:${base}:${i}` }))
    : [{ text: "Vedi risposta", callback_data: `m:${base}` }];
  return tg(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: testoDomanda(k),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [bottoni] },
  });
};

const oraItaliana = (t: number) =>
  Number(new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "numeric", hourCycle: "h23" }).format(t));

export const invioProgrammato = async (env: Env) => {
  const d = drizzle(env.DB);
  const adesso = Date.now();
  const [stato] = await d.select().from(invio_telegram).where(eq(invio_telegram.id, 1));
  if (stato && adesso < stato.prossimo_invio) return;

  const prossimo = Math.round(adesso + (MINUTI_MIN + Math.random() * (MINUTI_MAX - MINUTI_MIN)) * 60000);
  await d
    .insert(invio_telegram)
    .values({ id: 1, prossimo_invio: prossimo })
    .onConflictDoUpdate({ target: invio_telegram.id, set: { prossimo_invio: prossimo } });

  const ora = oraItaliana(adesso);
  if (ora < ORA_INIZIO || ora >= ORA_FINE) return;
  const carte = await carteDaRipassare(d);
  if (!carte.length) return;
  // Scelta casuale pesata: una carta di difficoltà 5 ha 5 volte la probabilità di una di difficoltà 1.
  let estratto = Math.random() * carte.reduce((somma, { carta }) => somma + carta.difficolta, 0);
  const scelta = carte.find(({ carta }) => (estratto -= carta.difficolta) < 0) ?? carte[carte.length - 1];
  const k = await leggiCarta(d, scelta.carta.id_carta);
  if (k) await inviaCarta(env, k);
};

// Restituisce il testo del breve avviso che Telegram mostra dopo il click.
const gestisciClick = async (env: Env, dati: string, msg: Messaggio) => {
  const modifica = (text: string, inline_keyboard: object[][] = []) =>
    tg(env, "editMessageText", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard },
    });

  // m:id:n = vedi risposta · q:id:n:i = opzione scelta (indice) · v:id:n:voto
  const [, tipo, id, n, x] = /^([mqv]):(\d{1,9}):(\d{1,9})(?::(\d))?$/.exec(dati) ?? [];
  if (!id) return "";
  if ((tipo === "m") !== (x === undefined) || (tipo === "v" && +x > 5)) return "";

  const d = drizzle(env.DB);
  const k = await leggiCarta(d, +id);
  if (!k) {
    await modifica("<i>Questa carta non esiste più.</i>");
    return "Carta eliminata";
  }
  const giàRipassata = async () => {
    await modifica(`${testoRisposta(k)}\n\n<i>Carta già ripassata.</i>`);
    return "Carta già ripassata";
  };
  if (k.ripasso.numero_ripassi !== +n) return giàRipassata();
  if (tipo !== "v") {
    const opzioni = opzioniMescolate(k);
    if (tipo === "q" && (!èQuiz(k) || +x >= opzioni.length)) return "";
    const scelta = tipo === "q" ? +x : undefined;
    await modifica(testoRisposta(k, scelta), [
      [0, 1, 2, 3, 4, 5].map((v) => ({ text: String(v), callback_data: `v:${id}:${n}:${v}` })),
    ]);
    return scelta === undefined ? "" : opzioni[scelta] === k.carta.risposta ? "Giusto! ✅" : "Sbagliato ❌";
  }
  const nuovo = await registraVoto(d, k.ripasso, +x, k.carta.difficolta);
  if (!nuovo) return giàRipassata();
  await modifica(`${testoRisposta(k)}\n\nVoto <b>${x}</b> · prossimo ripasso <b>${data(nuovo.prossimo_ripasso)}</b>`);
  return `Voto ${x} registrato`;
};

// Accetta solo i click fatti da te, nella tua chat privata col bot.
export const gestisciUpdate = async (env: Env, update: { callback_query?: CallbackQuery }) => {
  const q = update.callback_query;
  const mio = Number(env.TELEGRAM_CHAT_ID);
  if (!q?.message || q.from?.id !== mio || q.message.chat?.id !== mio) return;
  let avviso = "";
  try {
    avviso = await gestisciClick(env, q.data ?? "", q.message);
  } finally {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: avviso });
  }
};
