/**
 * Administração da loja online, por operação.
 *
 * A vitrine mostrava só o nome fantasia e a contagem de produtos: as seis lojas
 * do grupo apareciam iguais na home, sem nada dizendo o que cada uma vende. E
 * quem administra não tinha onde escrever isso — a única forma de mudar a loja
 * era mexer no cadastro da empresa, que é outra coisa.
 *
 * O QUE NÃO ENTRA AQUI: catálogo.
 *
 * A autoridade sobre o que aparece na loja continua sendo
 * `core_products.publish_online`. Uma lista paralela de "produtos da vitrine"
 * divergiria do cadastro no primeiro produto despublicado — e a loja passaria a
 * oferecer o que não se pode vender. Por isso até o DESTAQUE mora no produto,
 * como sinalizador, e não numa lista à parte.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { STOREFRONT_PRESETS, isStorefrontPreset } from './StorefrontPresets.js';
import { recusaDeProdutoInativo } from './produtoVendavel.js';

export interface StorefrontSettings {
  company_id: string;
  headline: string | null;
  description: string | null;
  whatsapp: string | null;
  banner_text: string | null;
  banner_active: number;
  /** Arquivo no disco, caminho aqui. Nulos até o gestor enviar (rodada 40). */
  logo_url: string | null;
  cover_url: string | null;
  /** Em quantas vezes a loja ANUNCIA que vende. Nulo = não anuncia (rodada 56). */
  installments_max: number | null;
}

function texto(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
}

/**
 * O tipo de negócio da loja — a coluna que decide o ARRANJO da vitrine.
 *
 * Fica junto das configurações de vitrine no SERVIÇO porque é onde a tela do
 * gestor precisa dele; mas a COLUNA fica em `core_companies`, ao lado da
 * resposta para "isto é loja ou oficina", porque é da mesma espécie.
 */
export function getStorefrontPreset(companyId: string): string | null {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT storefront_preset FROM core_companies WHERE id = ?')
    .get(companyId) as { storefront_preset: string | null } | undefined;
  return linha?.storefront_preset ?? null;
}

export function getStorefrontSettings(companyId: string): StorefrontSettings {
  ensureCoreSchema();
  const db = getConnection();
  const row = db
    .prepare('SELECT * FROM core_storefront_settings WHERE company_id = ?')
    .get(companyId) as unknown as StorefrontSettings | undefined;
  if (row) return row;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_storefront_settings (company_id, banner_active, updated_at)
     VALUES (?, 0, ?)`,
  ).run(companyId, now);
  return db
    .prepare('SELECT * FROM core_storefront_settings WHERE company_id = ?')
    .get(companyId) as unknown as StorefrontSettings;
}

export function updateStorefrontSettings(
  companyId: string,
  input: {
    headline?: string | null;
    description?: string | null;
    whatsapp?: string | null;
    bannerText?: string | null;
    bannerActive?: boolean;
    /** Em quantas vezes a loja anuncia que vende. `null` limpa o selo. */
    installmentsMax?: number | null;
    /** Que negócio esta loja faz — decide o ARRANJO da vitrine (rodada 56). */
    storefrontPreset?: string | null;
  },
): StorefrontSettings {
  ensureCoreSchema();
  const atual = getStorefrontSettings(companyId);

  /*
    AS DUAS RECUSAS VÊM ANTES DA PRIMEIRA ESCRITA.

    A validação do tipo estava DEPOIS do UPDATE: um tipo inválido gravava a
    chamada, a descrição e o parcelamento e só então devolvia 400. O gestor via
    o erro, corrigia o tipo, salvava de novo — e não tinha como saber que a
    metade de cima já estava no banco. Recusa que grava metade é pior que
    recusa: ela mente sobre não ter feito nada.
  */
  const parcelas = parcelasValidadas(input.installmentsMax, atual.installments_max);
  if (input.storefrontPreset !== undefined
      && input.storefrontPreset !== null
      && !isStorefrontPreset(input.storefrontPreset)) {
    throw new ApiError(
      'CORE_STOREFRONT_PRESET_INVALID',
      `Tipo de loja desconhecido. Os que a vitrine sabe desenhar são: ${STOREFRONT_PRESETS.join(', ')}.`,
      400,
    );
  }

  getConnection()
    .prepare(
      `UPDATE core_storefront_settings
          SET headline = ?, description = ?, whatsapp = ?, banner_text = ?,
              banner_active = ?, installments_max = ?, updated_at = ?
        WHERE company_id = ?`,
    )
    .run(
      input.headline === undefined ? atual.headline : texto(input.headline),
      input.description === undefined ? atual.description : texto(input.description),
      input.whatsapp === undefined ? atual.whatsapp : texto(input.whatsapp),
      input.bannerText === undefined ? atual.banner_text : texto(input.bannerText),
      input.bannerActive === undefined ? atual.banner_active : input.bannerActive ? 1 : 0,
      parcelas,
      new Date().toISOString(),
      companyId,
    );

  /*
    O TIPO DA LOJA mora em `core_companies`, e não aqui — porque ele não é
    aparência: é o que a loja É. A tela do gestor mostra os dois lado a lado
    porque é onde o dono pensa neles juntos, e por isso a gravação passa por
    esta função; mas a coluna fica junto de `kind`, ao lado da resposta para
    "isto é loja ou oficina".
  */
  if (input.storefrontPreset !== undefined) {
    getConnection()
      .prepare('UPDATE core_companies SET storefront_preset = ?, updated_at = ? WHERE id = ?')
      .run(input.storefrontPreset, new Date().toISOString(), companyId);
  }

  return getStorefrontSettings(companyId);
}

/**
 * O número de parcelas que a loja anuncia.
 *
 * Recusa em vez de corrigir: "0x" e "-1x" são erro de digitação, e gravar o
 * mais próximo válido faria a loja anunciar um número que ninguém escolheu.
 * O teto de 24 não é lei nenhuma — é o limite acima do qual a parcela vira
 * ficção, e um selo de "120x" na vitrine só faria o cliente desconfiar da loja.
 */
function parcelasValidadas(valor: unknown, atual: number | null): number | null {
  if (valor === undefined) return atual;
  if (valor === null) return null;
  /*
    NaN NÃO É "LIMPAR O CAMPO".

    A tela manda `Number(texto)`, e texto inválido vira NaN — que o JSON
    serializa como `null`. Sem esta linha, digitar "seis" no campo de parcelas
    chegava aqui como nulo, gravava "não anuncia", a tela dizia "Salvo" e o
    selo sumia da vitrine sem ninguém entender por quê. Recusar é o que dá à
    pessoa a chance de corrigir.
  */
  if (typeof valor === 'number' && Number.isNaN(valor)) {
    throw new ApiError(
      'CORE_INSTALLMENTS_INVALID',
      'Informe de 1 a 24 parcelas, ou deixe em branco para não anunciar parcelamento.',
      400,
    );
  }
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 24) {
    throw new ApiError(
      'CORE_INSTALLMENTS_INVALID',
      'Informe de 1 a 24 parcelas, ou deixe em branco para não anunciar parcelamento.',
      400,
    );
  }
  return n;
}

/**
 * Marca ou desmarca destaque.
 *
 * Só produto PUBLICADO pode ser destaque. Destacar o que não está na loja
 * criaria um estado que a vitrine não sabe representar: o produto apareceria
 * na régua de destaques e sumiria ao clicar.
 */
export function setFeatured(
  companyId: string,
  productId: string,
  featured: boolean,
): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const produto = db
      .prepare('SELECT id, name, publish_online, active FROM core_products WHERE id = ? AND company_id = ?')
      .get(productId, companyId) as
      | { id: string; name: string; publish_online: number; active: number }
      | undefined;
    if (!produto) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);

    // Inativo publicado continua com `publish_online = 1` no banco — é o
    // `active` que o tira da vitrine. Destacá-lo seria o mesmo estado que a
    // vitrine não sabe desenhar. Tirar o destaque continua livre: é limpeza.
    if (featured && Number(produto.active) !== 1) {
      throw recusaDeProdutoInativo(produto.name, 'ser destaque da loja', produto.id);
    }

    if (featured && !produto.publish_online) {
      throw new ApiError(
        'CORE_PRODUCT_NOT_PUBLISHED',
        `"${produto.name}" não está publicado na loja: publique antes de destacar.`,
        409,
      );
    }

    db.prepare('UPDATE core_products SET featured_online = ? WHERE id = ?').run(
      featured ? 1 : 0,
      productId,
    );
    return { id: productId, featured_online: featured ? 1 : 0 };
  });
}

/** Publicados da operação, com o sinalizador de destaque, para a tela escolher. */
export function listPublishedForAdmin(companyId: string): Record<string, unknown>[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT id, name, internal_code, price_cents, publish_online, featured_online
         FROM core_products
        WHERE company_id = ? AND active = 1 AND publish_online = 1
        ORDER BY featured_online DESC, name
        LIMIT 300`,
    )
    .all(companyId) as unknown as Record<string, unknown>[];
}

// ------------------------------------------------- imagem da marca (rodada 40)

/**
 * Grava o logo ou a capa da loja.
 *
 * O mesmo desenho das fotos de produto (`ProductImageService`): o arquivo vai
 * para o disco em `data/uploads/lojas`, o banco guarda só a URL pública, e o
 * nome no disco é gerado — nome vindo do cliente não decide caminho de
 * arquivo, senão "../../" viraria escrita fora da pasta.
 *
 * Trocar substitui: cada loja tem UM logo e UMA capa. O arquivo antigo é
 * removido do disco na troca — órfão em pasta de upload é lixo que ninguém
 * enxerga e backup nenhum precisa carregar.
 */
import { mkdirSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repoRoot } from '../../db/sqlite.js';

/*
  SVG SAIU DAQUI (GAP-PRD-066).

  SVG é documento, não só figura: `<svg><script>…</script></svg>` enviado como
  logo virava arquivo público que, aberto pela URL direta, roda script na
  origem de quem o serve — e a implantação recomendada serve API e telas na
  MESMA origem. Dentro de `<img>` (vitrine, cabeçalho da OS) ele não executa;
  a URL direta executa. Sanitizar SVG é um parser inteiro para manter; o logo
  da loja cabe em PNG ou WebP sem perda que se veja.

  O que já está no disco continua abrindo: `/uploads/*` sai com
  `Content-Security-Policy: sandbox` (app.ts), e o papel da OS embute o
  arquivo como `data:` dentro de `<img>`.
*/
const ACEITOS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * O que os bytes SÃO, pela assinatura — não pelo que o cliente declarou.
 *
 * O tipo vem do navegador e é só um rótulo: um SVG com `mimeType: image/png`
 * passava direto e ia para o disco com extensão `.png`. A assinatura dos três
 * formatos aceitos é curta e fixa, e é ela que decide.
 */
function tipoPelosBytes(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
const MAX_IMAGEM_LOJA = 3 * 1024 * 1024;
const PREFIXO_PUBLICO = '/uploads/lojas';

/**
 * A pasta no disco — REDIRECIONÁVEL, como o banco.
 *
 * Sem o redirecionamento, cada rodada da suíte deixava aqui um PNG de 1x1.
 * Medido em 27/08/2026: 458 arquivos, TODOS com exatamente 70 bytes, ZERO
 * referências no banco inteiro — e a curva de criação por dia é a das
 * rodadas da suíte, não a de alguém trocando o logo da loja.
 *
 * Não era só sujeira: era o que a primeira cópia remota dos uploads levaria
 * para o bucket, e ficaria lá para sempre, num armazenamento pago.
 *
 * O padrão NÃO muda. Esta pasta fica na raiz do repositório e as outras duas
 * sob `server/` — acidente histórico que não vale corrigir agora: os links já
 * gravados apontam para cá, e mudar o padrão os quebraria todos de uma vez.
 */
export function storeUploadsDir(): string {
  const raiz = process.env.DEVORA_UPLOADS_DIR || resolve(repoRoot(), 'data', 'uploads');
  return resolve(raiz, 'lojas');
}

export type TipoImagemDaLoja = 'logo' | 'capa';

export function setStoreImage(input: {
  companyId: string;
  tipo: TipoImagemDaLoja;
  /** `data:image/png;base64,...` ou base64 puro com mimeType informado. */
  dataUrl: string;
  mimeType?: string;
}): StorefrontSettings {
  ensureCoreSchema();
  const coluna = input.tipo === 'logo' ? 'logo_url' : 'cover_url';

  const match = /^data:([^;]+);base64,(.*)$/s.exec(input.dataUrl ?? '');
  const mime = (match?.[1] ?? input.mimeType ?? '').toLowerCase();
  const base64 = match?.[2] ?? input.dataUrl ?? '';
  const extensao = ACEITOS[mime];
  if (!extensao) {
    throw new ApiError(
      'CORE_IMAGE_FORMAT_INVALID',
      'Formato não aceito. Envie JPEG, PNG ou WebP (SVG não é aceito: pode carregar script).',
      400,
      { accepted: Object.keys(ACEITOS) },
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    throw new ApiError('CORE_IMAGE_INVALID', 'Arquivo de imagem inválido.', 400);
  }
  if (bytes.length === 0) {
    throw new ApiError('CORE_IMAGE_INVALID', 'Arquivo de imagem vazio.', 400);
  }
  if (bytes.length > MAX_IMAGEM_LOJA) {
    throw new ApiError(
      'CORE_IMAGE_TOO_LARGE',
      `Imagem acima de ${Math.round(MAX_IMAGEM_LOJA / 1024 / 1024)} MB.`,
      413,
    );
  }
  // O rótulo que o navegador mandou tem de bater com o que os bytes são.
  if (tipoPelosBytes(bytes) !== mime) {
    throw new ApiError(
      'CORE_IMAGE_CONTENT_MISMATCH',
      'O arquivo não é a imagem que diz ser. Envie um JPEG, PNG ou WebP de verdade.',
      400,
      { declared: mime, accepted: Object.keys(ACEITOS) },
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const atual = getStorefrontSettings(input.companyId) as StorefrontSettings &
      Record<string, string | null>;

    const arquivo = `${randomUUID()}.${extensao}`;
    mkdirSync(storeUploadsDir(), { recursive: true });
    writeFileSync(join(storeUploadsDir(), arquivo), bytes);

    db.prepare(
      `UPDATE core_storefront_settings SET ${coluna} = ?, updated_at = ? WHERE company_id = ?`,
    ).run(`${PREFIXO_PUBLICO}/${arquivo}`, new Date().toISOString(), input.companyId);

    // O arquivo antigo sai do disco DEPOIS da troca no banco dar certo.
    const antigo = atual[coluna];
    if (antigo?.startsWith(`${PREFIXO_PUBLICO}/`)) {
      const nome = antigo.slice(PREFIXO_PUBLICO.length + 1);
      // Só nome simples: qualquer coisa com barra não é nosso arquivo.
      if (nome && !nome.includes('/') && !nome.includes('\\')) {
        try {
          const caminho = join(storeUploadsDir(), nome);
          if (existsSync(caminho)) unlinkSync(caminho);
        } catch {
          // Arquivo antigo preso não é motivo para desfazer a troca.
        }
      }
    }

    return getStorefrontSettings(input.companyId);
  });
}

export function removeStoreImage(companyId: string, tipo: TipoImagemDaLoja): StorefrontSettings {
  ensureCoreSchema();
  const coluna = tipo === 'logo' ? 'logo_url' : 'cover_url';
  return withTransaction(() => {
    const db = getConnection();
    const atual = getStorefrontSettings(companyId) as StorefrontSettings &
      Record<string, string | null>;
    db.prepare(
      `UPDATE core_storefront_settings SET ${coluna} = NULL, updated_at = ? WHERE company_id = ?`,
    ).run(new Date().toISOString(), companyId);
    const antigo = atual[coluna];
    if (antigo?.startsWith(`${PREFIXO_PUBLICO}/`)) {
      const nome = antigo.slice(PREFIXO_PUBLICO.length + 1);
      if (nome && !nome.includes('/') && !nome.includes('\\')) {
        try {
          const caminho = join(storeUploadsDir(), nome);
          if (existsSync(caminho)) unlinkSync(caminho);
        } catch {
          // idem: não desfaz a remoção lógica.
        }
      }
    }
    return getStorefrontSettings(companyId);
  });
}
