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

const testoDomanda = (k: CartaCompleta) =>
  `<i>${breve(k.nome_materia, 100)} · ${breve(k.nome_argomento, 100)}</i>\n\n<b>Domanda</b>\n${breve(k.carta.domanda, 1800)}`;
const testoRisposta = (k: CartaCompleta) => `${testoDomanda(k)}\n\n<b>Risposta</b>\n${breve(k.carta.risposta, 1800)}`;

// numero_ripassi viaggia nei bottoni: un click su un messaggio vecchio non può sovrascrivere un ripasso più recente.
const inviaCarta = (env: Env, k: CartaCompleta) =>
  tg(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: testoDomanda(k),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "Vedi risposta", callback_data: `m:${k.carta.id_carta}:${k.ripasso.numero_ripassi}` }]],
    },
  });

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
  const k = await leggiCarta(d, carte[Math.floor(Math.random() * carte.length)].carta.id_carta);
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

  const [, id, n, voto] = /^m:(\d{1,9}):(\d{1,9})$/.exec(dati) ?? /^v:(\d{1,9}):(\d{1,9}):([0-5])$/.exec(dati) ?? [];
  if (!id) return "";

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
  if (voto === undefined) {
    await modifica(testoRisposta(k), [
      [0, 1, 2, 3, 4, 5].map((v) => ({ text: String(v), callback_data: `v:${id}:${n}:${v}` })),
    ]);
    return "";
  }
  const nuovo = await registraVoto(d, k.ripasso, +voto);
  if (!nuovo) return giàRipassata();
  await modifica(`${testoRisposta(k)}\n\nVoto <b>${voto}</b> · prossimo ripasso <b>${data(nuovo.prossimo_ripasso)}</b>`);
  return `Voto ${voto} registrato`;
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
