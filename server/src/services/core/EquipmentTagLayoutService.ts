/**
 * A CARA da plaquinha — logo, cores e milímetros, por empresa.
 *
 * ## Por que no banco, e não no navegador
 *
 * No sistema anterior o layout vivia no `localStorage` de quem editou
 * (`motoelectrica_plaquinha_config`). Dois gerentes da mesma oficina
 * imprimiam plaquinhas diferentes e ninguém conseguia dizer qual era a certa —
 * e o backup do sistema nem exportava essa chave, então a identidade visual
 * sumia junto com o cache do navegador. Aqui é do cadastro da empresa.
 *
 * ## O que mora aqui e o que NÃO mora
 *
 * Aqui está a CARA: logo, cor de fundo, cor do texto, cantos e o tamanho em
 * milímetro quando a empresa quer o próprio. A GEOMETRIA DA FOLHA — onde cada
 * plaquinha cai no papel, quantas cabem, o vão da tesoura — continua no
 * catálogo de formatos, que sabe fazer a conta do módulo do QR e recusar
 * tamanho que a câmera não lê.
 *
 * É a divisão que o sistema anterior não fazia: lá o editor mexia nos dois ao
 * mesmo tempo e ninguém conferia nada. O resultado era uma folha de 12
 * plaquinhas de 100 × 40 mm em que o QR ia a 28 mm por gosto — e ninguém sabia
 * dizer se dava para ler.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { exigirEmpresaComPlaquinha } from './EquipmentTagPoolService.js';

export interface TagLayout {
  logoUrl: string | null;
  logoXmm: number;
  logoYmm: number;
  logoWmm: number;
  logoHmm: number;
  bgColor: string;
  textColor: string;
  rounded: boolean;
  widthMm: number;
  heightMm: number;
  marginMm: number;
}

/**
 * Os padrões, verbatim do sistema anterior.
 *
 * 100 × 40 mm com margem de 4, fundo branco e texto quase preto: é a
 * plaquinha que a oficina já conhece. Vieram sem discussão porque são o que o
 * dono já usa — mudar o padrão seria trocar a cara das máquinas do pátio sem
 * ninguém pedir.
 */
export const LAYOUT_PADRAO: TagLayout = {
  logoUrl: null,
  logoXmm: 8,
  logoYmm: 4,
  logoWmm: 28,
  logoHmm: 20,
  bgColor: '#ffffff',
  textColor: '#1a1a1a',
  rounded: true,
  widthMm: 100,
  heightMm: 40,
  marginMm: 4,
};

/** Limites de cada medida, em milímetro. Fora disso a plaquinha não é papel. */
const LIMITES = {
  widthMm: { min: 40, max: 200 },
  heightMm: { min: 20, max: 140 },
  marginMm: { min: 0, max: 20 },
  logoXmm: { min: -20, max: 200 },
  logoYmm: { min: -20, max: 140 },
  logoWmm: { min: 1, max: 200 },
  logoHmm: { min: 1, max: 140 },
} as const;

const COR = /^#[0-9a-fA-F]{6}$/;

function medida(valor: unknown, campo: keyof typeof LIMITES, padrao: number): number {
  if (valor === undefined || valor === null || valor === '') return padrao;
  const n = Number(valor);
  const { min, max } = LIMITES[campo];
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ApiError(
      'CORE_TAG_LAYOUT_INVALID',
      `${campo} tem que ficar entre ${min} e ${max} mm.`,
      400,
      { campo, min, max },
    );
  }
  // Meio milímetro é o passo que a impressora comum resolve; guardar 3,14159
  // dá falsa precisão a quem lê o número na tela.
  return Math.round(n * 2) / 2;
}

function cor(valor: unknown, padrao: string): string {
  if (valor === undefined || valor === null || valor === '') return padrao;
  const s = String(valor).trim();
  if (!COR.test(s)) {
    throw new ApiError(
      'CORE_TAG_LAYOUT_COLOR',
      'Cor inválida: use o formato #rrggbb.',
      400,
    );
  }
  return s.toLowerCase();
}

/**
 * A logo vem como `data:` do navegador — e ela tem teto.
 *
 * No sistema anterior a logo era gravada em base64 dentro do mesmo objeto do
 * `localStorage`, sem limite e sem `try`: logo grande estourava a cota do
 * navegador dentro de um `useEffect`, e o erro aparecia como tela branca. Aqui
 * o teto é do servidor e a recusa diz o tamanho.
 */
const MAX_LOGO_BYTES = 512 * 1024;

function logo(valor: unknown, padrao: string | null): string | null {
  if (valor === undefined) return padrao;
  if (valor === null || valor === '') return null;
  const s = String(valor);
  if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(s)) {
    throw new ApiError(
      'CORE_TAG_LOGO_FORMAT',
      'A logo precisa ser uma imagem PNG, JPEG, WebP ou SVG.',
      400,
    );
  }
  // O base64 incha o arquivo em um terço: o teto é medido no que sobra depois
  // de decodificar, que é o tamanho real da imagem.
  const bytes = Math.floor((s.length - s.indexOf(',') - 1) * 0.75);
  if (bytes > MAX_LOGO_BYTES) {
    throw new ApiError(
      'CORE_TAG_LOGO_TOO_LARGE',
      `A logo passa de ${Math.round(MAX_LOGO_BYTES / 1024)} KB. Reduza a imagem antes de subir.`,
      413,
      { bytes, max: MAX_LOGO_BYTES },
    );
  }
  return s;
}

interface LinhaDeLayout {
  logo_url: string | null;
  logo_x_mm: number;
  logo_y_mm: number;
  logo_w_mm: number;
  logo_h_mm: number;
  bg_color: string;
  text_color: string;
  rounded: number;
  width_mm: number;
  height_mm: number;
  margin_mm: number;
}

function daLinha(l: LinhaDeLayout): TagLayout {
  return {
    logoUrl: l.logo_url,
    logoXmm: Number(l.logo_x_mm),
    logoYmm: Number(l.logo_y_mm),
    logoWmm: Number(l.logo_w_mm),
    logoHmm: Number(l.logo_h_mm),
    bgColor: String(l.bg_color),
    textColor: String(l.text_color),
    rounded: Number(l.rounded) === 1,
    widthMm: Number(l.width_mm),
    heightMm: Number(l.height_mm),
    marginMm: Number(l.margin_mm),
  };
}

/** O layout da empresa, ou o padrão — a tela nunca fica sem resposta. */
export function layoutDaEmpresa(companyId: string): TagLayout {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT * FROM core_equipment_tag_layouts WHERE company_id = ?')
    .get(companyId) as LinhaDeLayout | undefined;
  return linha ? daLinha(linha) : { ...LAYOUT_PADRAO };
}

/**
 * Valida sem gravar — é o que a pré-visualização usa.
 *
 * O editor mostra o resultado ANTES de salvar, e mostrar exige as mesmas
 * regras: cor fora do formato ou medida fora do papel têm que recusar no
 * preview, senão o gerente descobre o problema depois de gravar.
 */
export function layoutValidado(entrada: Record<string, unknown>, base = LAYOUT_PADRAO): TagLayout {
  const layout: TagLayout = {
    logoUrl: logo(entrada.logoUrl, base.logoUrl),
    logoXmm: medida(entrada.logoXmm, 'logoXmm', base.logoXmm),
    logoYmm: medida(entrada.logoYmm, 'logoYmm', base.logoYmm),
    logoWmm: medida(entrada.logoWmm, 'logoWmm', base.logoWmm),
    logoHmm: medida(entrada.logoHmm, 'logoHmm', base.logoHmm),
    bgColor: cor(entrada.bgColor, base.bgColor),
    textColor: cor(entrada.textColor, base.textColor),
    rounded: entrada.rounded === undefined ? base.rounded : entrada.rounded === true,
    widthMm: medida(entrada.widthMm, 'widthMm', base.widthMm),
    heightMm: medida(entrada.heightMm, 'heightMm', base.heightMm),
    marginMm: medida(entrada.marginMm, 'marginMm', base.marginMm),
  };

  /*
    A LOGO TEM QUE CABER NA PLAQUINHA.

    O editor do sistema anterior deixava arrastar a logo até 150 mm numa
    plaquinha de 100 — o excedente sumia sob `overflow:hidden`, sem aviso, e a
    folha saía com metade da marca cortada. Aqui a recusa vem antes do papel.
  */
  if (layout.logoXmm + layout.logoWmm > layout.widthMm) {
    throw new ApiError(
      'CORE_TAG_LOGO_OUT',
      `A logo passa da largura da plaquinha: ${layout.logoXmm} + ${layout.logoWmm} mm não cabem `
      + `em ${layout.widthMm} mm.`,
      400,
    );
  }
  if (layout.logoYmm + layout.logoHmm > layout.heightMm) {
    throw new ApiError(
      'CORE_TAG_LOGO_OUT',
      `A logo passa da altura da plaquinha: ${layout.logoYmm} + ${layout.logoHmm} mm não cabem `
      + `em ${layout.heightMm} mm.`,
      400,
    );
  }
  if (layout.marginMm * 2 >= Math.min(layout.widthMm, layout.heightMm)) {
    throw new ApiError(
      'CORE_TAG_LAYOUT_INVALID',
      'A margem come a plaquinha inteira: sobra espaço nenhum para o QR.',
      400,
    );
  }

  return layout;
}

export function salvarLayout(input: {
  companyId: string;
  userId: string;
  entrada: Record<string, unknown>;
}): TagLayout {
  ensureCoreSchema();
  // A regra de ouro tambem vale aqui: loja que nao usa plaquinha nao tem
  // layout de plaquinha para editar.
  exigirEmpresaComPlaquinha(input.companyId);
  // A base é o que JÁ está gravado: o editor manda só o que mexeu, e partir do
  // padrão apagaria em silêncio o que a empresa configurou antes.
  const layout = layoutValidado(input.entrada, layoutDaEmpresa(input.companyId));
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_equipment_tag_layouts
         (company_id, logo_url, logo_x_mm, logo_y_mm, logo_w_mm, logo_h_mm,
          bg_color, text_color, rounded, width_mm, height_mm, margin_mm,
          updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         logo_url = excluded.logo_url,
         logo_x_mm = excluded.logo_x_mm,
         logo_y_mm = excluded.logo_y_mm,
         logo_w_mm = excluded.logo_w_mm,
         logo_h_mm = excluded.logo_h_mm,
         bg_color = excluded.bg_color,
         text_color = excluded.text_color,
         rounded = excluded.rounded,
         width_mm = excluded.width_mm,
         height_mm = excluded.height_mm,
         margin_mm = excluded.margin_mm,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.companyId,
      layout.logoUrl,
      layout.logoXmm,
      layout.logoYmm,
      layout.logoWmm,
      layout.logoHmm,
      layout.bgColor,
      layout.textColor,
      layout.rounded ? 1 : 0,
      layout.widthMm,
      layout.heightMm,
      layout.marginMm,
      input.userId,
      agora,
    );
  return layout;
}
