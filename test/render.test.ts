import { describe, expect, it } from "vitest";
import { rendi } from "../src/render";

describe("rendi", () => {
  it("escapa l'HTML e trasforma gli a capo", () => {
    expect(rendi("<script>alert(1)</script> & co\nriga")).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co<br>riga");
  });

  it("renderizza le formule in linea e a blocco", () => {
    expect(rendi("vale $x^2$")).toContain('class="katex"');
    const blocco = rendi("$$\\int_0^1 x\\,dx$$");
    expect(blocco).toContain("katex-display");
  });

  it("lascia come testo i dollari che non chiudono una formula", () => {
    expect(rendi("costa $5 e $6")).toBe("costa $5 e $6");
    expect(rendi("solo $ qui")).toBe("solo $ qui");
    expect(rendi("$$ non chiuso")).toBe("$$ non chiuso");
    expect(rendi("prezzo $")).toBe("prezzo $");
  });

  it("tratta \\$ come dollaro letterale", () => {
    const html = rendi("\\$x\\$ e $y$");
    expect(html.startsWith("$x$ e ")).toBe(true);
    expect(html.match(/class="katex"/g)).toHaveLength(1);
  });

  it("non lancia con LaTeX errato", () => {
    expect(() => rendi("$\\frac{$")).not.toThrow();
    expect(rendi("$\\comandoinesistente$")).toContain("katex");
  });

  it("l'HTML dentro la matematica non diventa markup", () => {
    const html = rendi("$<img src=x onerror=alert(1)>$");
    expect(html).not.toContain("<img");
  });

  it("con trust disattivato \\href non crea link", () => {
    expect(rendi("$\\href{javascript:alert(1)}{x}$")).not.toMatch(/<a[\s>]|href="/);
  });

  it("senza dollari non passa da KaTeX", () => {
    expect(rendi("testo normale")).toBe("testo normale");
  });
});
