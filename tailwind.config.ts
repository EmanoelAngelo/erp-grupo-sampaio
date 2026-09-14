/**
 * Apaga blocos de comentário antes de o varredor ler o arquivo, trocando cada
 * um por espaços do MESMO tamanho — assim nada mais se cola por acidente e as
 * posições do que sobra continuam as mesmas.
 */
function semComentariosDeBloco(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, (bloco) => ' '.repeat(bloco.length));
}

/** @type {import('tailwindcss').Config} */
export default {
    /*
      O QUE O TAILWIND VARRE — e o que ele NÃO deve varrer (rodada 56).

      A varredura é textual: qualquer coisa que PAREÇA classe vira CSS, venha
      de onde vier. O teste que guarda a escala de tipo monta os nomes de
      classe com template literal, e o scanner os pegou verbatim — gerando
      `.text-[length:var(--gs-text${token})]`, que o minificador de CSS não
      consegue nem ler. O build parava com "Unexpected token Delim('$')" numa
      regra que nenhuma tela pediu.

      Teste não é template: nada do que ele escreve precisa virar CSS. Tirá-lo
      da varredura conserta a causa em vez de contornar o sintoma escondendo
      a string do teste.
    */
    /*
      E COMENTÁRIO TAMBÉM NÃO É TEMPLATE.

      A exclusão dos testes acima consertou metade do problema. A outra metade
      apareceu quando um arquivo de PRODUÇÃO passou a documentar o formato de
      data do OFX — `AAAAMMDDHHMMSS[-3:BRT]`, escrito por extenso num bloco
      JSDoc para quem for mexer no leitor de extrato entender o fuso. O
      varredor lê o arquivo como TEXTO, não como código: ele não sabe que
      aquilo é prosa, viu um candidato entre colchetes e gerou
      `.\[-3\:BRT\] { -3: BRT; }` — CSS que o minificador não aceita, e o build
      inteiro parou por causa de uma frase explicativa.

      Excluir o arquivo da varredura seria pior (ele tem classes de verdade).
      Então o comentário sai ANTES da leitura: bloco de comentário nunca
      produz classe, e é justamente onde esta casa escreve suas explicações
      longas.
      Comentário de LINHA fica de fora de propósito — `https://` dentro de um
      atributo tem duas barras, e cortar dali até o fim da linha levaria junto
      as classes que estivessem depois.
    */
    content: {
      files: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
        "!./src/**/__tests__/**",
        "!./src/**/*.test.{ts,tsx}",
      ],
      transform: {
        ts: semComentariosDeBloco,
        tsx: semComentariosDeBloco,
      },
    },
    theme: {
      extend: {
        colors: {
          background: {
            50: '#ffffff',
            100: '#f5f5f5',
            200: '#eeeeee',
            300: '#cccccc',
            400: '#aaaaaa',
            500: '#999999',
            600: '#888888',
            700: '#777777',
            800: '#666666',
            900: '#555555',
            950: '#444444',
          },
          foreground: {
            50: '#ffffff',
            100: '#f5f5f5',
            200: '#eeeeee',
            300: '#cccccc',
            400: '#aaaaaa',
            500: '#999999',
            600: '#888888',
            700: '#777777',
            800: '#666666',
            900: '#555555',
            950: '#333333',
          },
          primary: {
            50: '#fdf8ec',
            100: '#f9f0d5',
            200: '#f3e0aa',
            300: '#eacc74',
            400: '#e0b54a',
            500: '#c9a96e',
            600: '#b8985e',
            700: '#a0804a',
            800: '#856a3d',
            900: '#6d5532',
            950: '#3b2e18',
          },
          accent: {
            50: '#ecfdf5',
            100: '#d1fae5',
            200: '#a7f3d0',
            300: '#6ee7b7',
            400: '#34d399',
            500: '#10b981',
            600: '#059669',
            700: '#047857',
            800: '#065f46',
            900: '#064e3b',
            950: '#022c22',
          },
          secondary: {
            50: '#f8fafc',
            100: '#f1f5f9',
            200: '#e2e8f0',
            300: '#cbd5e1',
            400: '#94a3b8',
            500: '#64748b',
            600: '#475569',
            700: '#334155',
            800: '#1e293b',
            900: '#0f172a',
            950: '#020617',
          },
        },
      },
    },
    plugins: [],
  }