/**
 * A folha de plaquinhas — desenhada no servidor, em milímetro.
 *
 * ## O que estava errado
 *
 * A plaquinha era montada NO NAVEGADOR, em pixels: `w-[170px]`, `text-[22px]`.
 * O adesivo que saía da impressora não tinha tamanho físico previsível — quem
 * imprimisse aquele bloco dependia da margem e do zoom do navegador. E a
 * plaquinha precisa caber num espaço fixo, colada num equipamento.
 *
 * A etiqueta de PRODUTO já fazia certo, e a própria tela promete isso no
 * subtítulo: "a folha é desenhada no servidor, em milímetro". A plaquinha não
 * seguia.
 *
 * ## A célula é uma LINHA, não uma coluna
 *
 * QR à esquerda, dados à direita. É a única disposição que cabe em 25 mm de
 * altura: empilhado, o QR sozinho ocupa a altura inteira e o número da
 * plaquinha sai do papel — sem erro, sem aviso, porque `overflow: hidden`
 * simplesmente corta.
 *
 * ## O fio de corte
 *
 * Folha adesiva comum é recortada à tesoura. O vão entre as células existe
 * para isso, e o fio impresso no meio dele diz onde cortar — sem ele, a linha
 * natural é a fronteira entre duas plaquinhas, e o erro de ±1 mm da mão come a
 * zona de silêncio do QR vizinho.
 */
import { getConnection } from '../../db/sqlite.js';
import { paginaMm, porPagina, recuoDaFolhaMm } from './LabelFormats.js';
import { desenharQr } from './Qr.js';
import { escalaDaPlaquinha, type EquipmentTagFormat } from './EquipmentTagFormats.js';
import { LAYOUT_PADRAO, type TagLayout } from './EquipmentTagLayoutService.js';

export interface PlaquinhaItem {
  publicIdLabel: string;
  brand: string | null;
  model: string | null;
  qrUrl: string;
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A logo entra numa `url()` de CSS, e CSS não é HTML.
 *
 * O layout já recusa qualquer coisa que não comece com `data:image/...;base64,`
 * (o validador do serviço), mas quem escreve dentro de `<style>` não pode
 * confiar só no validador de quem chamou: aspas e parênteses fechariam a
 * regra, e `</style>` fecharia o bloco inteiro. Aqui só sobrevive o alfabeto
 * do base64 e o cabeçalho do próprio data URI.
 */
function cssUrl(dataUri: string): string {
  return String(dataUri).replace(/[^A-Za-z0-9+/=:;,.\-_]/g, '');
}

/**
 * O nome da operação, do cadastro.
 *
 * A tela cravava o literal "GRUPO SAMPAIO · Oficina" enquanto o servidor usava
 * o nome real — duas verdades para a mesma etiqueta, num sistema com seis
 * operações. Aqui há uma só, e é a do banco.
 */
function nomeDaEmpresa(companyId: string): string {
  const c = getConnection()
    .prepare('SELECT trade_name, legal_name FROM core_companies WHERE id = ?')
    .get(companyId) as { trade_name: string | null; legal_name: string } | undefined;
  return c?.trade_name || c?.legal_name || '';
}

/**
 * A CÉLULA — com a identidade visual da empresa (rodada 53).
 *
 * A logo é posicionada em MILÍMETRO, absoluta dentro da plaquinha, como no
 * editor do sistema anterior. Ela é desenhada por baixo do conteúdo: uma marca
 * que cobrisse o QR ou o número transformaria a plaquinha em enfeite.
 */
function celula(
  item: PlaquinhaItem,
  f: EquipmentTagFormat,
  empresa: string,
  layout: TagLayout,
): string {
  const qr = desenharQr(item.qrUrl, { nivel: f.nivelQr });
  /*
    A LOGO ENTRA UMA VEZ NA FOLHA, não uma por plaquinha.

    Como `<img src="data:...">` em cada célula, uma marca de 500 KB vira 10 MB
    de HTML numa folha de 21 — e o documento inteiro trafega dentro de JSON.
    Aqui a imagem mora numa regra de CSS (`background-image`), declarada uma
    vez, e cada célula só aponta para a classe.
  */
  const marca = layout.logoUrl ? '<div class="logo"></div>' : '';
  return `<div class="etq">
    ${marca}
    <div class="qr">${qr.svg}</div>
    <div class="dados">
      <p class="id">${esc(item.publicIdLabel)}</p>
      <p class="eq">${esc([item.brand, item.model].filter(Boolean).join(' '))}</p>
      <p class="op">${esc(empresa)}</p>
    </div>
  </div>`;
}

export interface FolhaDePlaquinhas {
  html: string;
  /** Medidas conferidas, para a tela avisar ANTES de gastar folha. */
  moduloMm: number;
  qrMm: number;
  abaixoDoPiso: boolean;
  folhas: number;
}

export function renderEquipmentTagSheet(input: {
  companyId: string;
  format: EquipmentTagFormat;
  items: PlaquinhaItem[];
  /** A cara da empresa. Ausente = o padrão, que é a plaquinha de sempre. */
  layout?: TagLayout;
}): FolhaDePlaquinhas {
  const f = input.format;
  const layout = input.layout ?? LAYOUT_PADRAO;
  const empresa = nomeDaEmpresa(input.companyId);
  const pagina = paginaMm(f);
  const recuo = recuoDaFolhaMm(f);
  const cabem = porPagina(f);

  /*
    A escala sai do QR mais LONGO do lote — e ele é medido UMA vez.

    Todos precisam caber, e usar o primeiro daria uma folha em que só ele cabe.
    A versão anterior chamava `escalaDaPlaquinha` para CADA item, e cada
    chamada codifica o QR inteiro só para contar módulos: com o desenho da
    célula logo depois, eram duas codificações por plaquinha — 2.000 num lote
    de mil, todas para chegar ao mesmo número, porque o endereço só muda no
    token e o token tem tamanho fixo. Mais caracteres nunca dão um símbolo
    menor, então o mais longo é o pior caso.
  */
  const maisLongo = input.items.reduce(
    (maior, i) => (i.qrUrl.length > maior.length ? i.qrUrl : maior),
    input.items[0]?.qrUrl ?? 'x',
  );
  const escala = escalaDaPlaquinha(f, maisLongo);

  const celulas = input.items.map((i) => celula(i, f, empresa, layout));
  const paginas: string[] = [];
  for (let i = 0; i < celulas.length; i += cabem) {
    paginas.push(`<section class="folha">${celulas.slice(i, i + cabem).join('')}</section>`);
  }

  // Em rolo a margem é interna à etiqueta: `recuoDaFolhaMm` devolve zero de
  // propósito, então quem a aplica é a célula.
  const padding = f.midia === 'rolo'
    ? `${f.marginTopMm}mm ${f.marginLeftMm}mm`
    : '0.6mm';

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Plaquinhas — ${esc(f.label)}</title>
<style>
  @page { size: ${pagina.largura}mm ${pagina.altura}mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }

  .folha {
    width: ${pagina.largura}mm;
    height: ${pagina.altura}mm;
    padding: ${recuo.topo}mm ${recuo.esquerda}mm;
    display: grid;
    grid-template-columns: repeat(${f.columns}, ${f.widthMm}mm);
    grid-auto-rows: ${f.heightMm}mm;
    column-gap: ${f.gapXmm}mm;
    row-gap: ${f.gapYmm}mm;
    align-content: start;
    page-break-after: always;
  }
  .folha:last-child { page-break-after: auto; }

  /*
    A célula é uma LINHA. Empilhado, o QR ocupa a altura inteira e o número
    sai do papel — cortado por overflow, sem nada avisando.
  */
  .etq {
    position: relative;
    width: ${f.widthMm}mm;
    height: ${f.heightMm}mm;
    overflow: hidden;
    padding: ${padding};
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 2mm;
    background: ${layout.bgColor};
    color: ${layout.textColor};
    ${layout.rounded ? 'border-radius: 2mm;' : ''}
    ${f.recorteManual ? 'outline: 0.2mm dashed #999; outline-offset: 1mm;' : ''}
  }

  /*
    A LOGO FICA POR BAIXO — e é ela que cede espaço, nunca o QR.

    Empilhamento em vez de opacidade: marca clareada sobre fundo branco some
    na impressora térmica, e quem pediu a logo quer a logo. Por baixo, ela
    aparece inteira onde não há conteúdo e some atrás dele onde há.
  */
  .logo {
    position: absolute;
    left: ${layout.logoXmm}mm;
    top: ${layout.logoYmm}mm;
    width: ${layout.logoWmm}mm;
    height: ${layout.logoHmm}mm;
    z-index: 0;
    ${layout.logoUrl ? `background: center / contain no-repeat url("${cssUrl(layout.logoUrl)}");` : ''}
  }
  .qr, .dados { position: relative; z-index: 1; }
  .qr { width: ${escala.qrMm}mm; height: ${escala.qrMm}mm; flex: none; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .dados { min-width: 0; line-height: 1.25; }
  .id { font-size: ${(f.heightMm * 0.6).toFixed(1)}mm; font-weight: bold;
        letter-spacing: .3px; margin: 0; }
  .eq { font-size: ${(f.heightMm * 0.28).toFixed(1)}mm; margin: 0;
        overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /*
    O nome da operação segue a cor do texto escolhida, só que mais leve.
    Cravar #333 sobre um fundo escuro do layout apagaria a linha.
  */
  .op { font-size: ${(f.heightMm * 0.22).toFixed(1)}mm; margin: 0; opacity: .75; }

  @media screen {
    body { background: #f4f2f7; padding: 12px; }
    .folha { background: #fff; box-shadow: 0 0 0 1px #ccc; margin: 0 auto 12px; }
  }
</style></head><body>${paginas.join('')}</body></html>`;

  return {
    html,
    moduloMm: escala.moduloMm,
    qrMm: escala.qrMm,
    abaixoDoPiso: escala.abaixoDoPiso,
    folhas: paginas.length,
  };
}
