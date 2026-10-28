import katex from "katex";

// Oltre questo numero di formule per testo il resto resta testo semplice (tetto al lavoro di KaTeX nel Worker).
const MAX_FORMULE = 200;

const escapaHtml = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const testoSemplice = (t: string) => escapaHtml(t).replace(/\n/g, "<br>");

const formula = (tex: string, display: boolean) => {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20 });
  } catch {
    return testoSemplice(display ? `$$${tex}$$` : `$${tex}$`);
  }
};

const spazio = (c: string | undefined) => c === undefined || /\s/.test(c);

// Posizione del `$` che chiude una formula in linea aperta in `da - 1`, o -1. Come in LaTeX/Markdown, per non scambiare
// per formule frasi come «costa $5 e $6»: niente spazio prima della chiusura e la chiusura non è seguita da una cifra.
const chiusuraInLinea = (t: string, da: number) => {
  for (let j = da; j < t.length; j++) {
    if (t[j] === "\\") j++;
    else if (t[j] === "$" && !spazio(t[j - 1]) && !/\d/.test(t[j + 1] ?? "")) return j;
  }
  return -1;
};

const chiusuraDisplay = (t: string, da: number) => {
  for (let j = da; j < t.length - 1; j++) {
    if (t[j] === "\\") j++;
    else if (t[j] === "$" && t[j + 1] === "$") return j;
  }
  return -1;
};

// Trasforma il testo di una carta o di una nota in HTML sicuro: l'HTML nel testo viene escapato e solo il contenuto
// di $...$ (in linea) e $$...$$ (a blocco) passa da KaTeX. `\$` è un dollaro letterale. Va chiamata al salvataggio.
export const rendi = (testo: string) => {
  if (!testo.includes("$")) return testoSemplice(testo);
  let html = "";
  let grezzo = "";
  let formule = 0;
  const emetti = (h: string) => {
    html += testoSemplice(grezzo) + h;
    grezzo = "";
  };
  for (let i = 0; i < testo.length; ) {
    if (testo[i] === "\\" && testo[i + 1] === "$") {
      grezzo += "$";
      i += 2;
    } else if (testo[i] === "$" && formule < MAX_FORMULE) {
      const display = testo[i + 1] === "$";
      const inizio = i + (display ? 2 : 1);
      const fine = display ? chiusuraDisplay(testo, inizio) : spazio(testo[inizio]) ? -1 : chiusuraInLinea(testo, inizio);
      const tex = fine < 0 ? "" : testo.slice(inizio, fine);
      if (tex.trim()) {
        formule++;
        emetti(formula(tex, display));
        i = fine + (display ? 2 : 1);
      } else {
        grezzo += display ? "$$" : "$";
        i = inizio;
      }
    } else grezzo += testo[i++];
  }
  return html + testoSemplice(grezzo);
};
