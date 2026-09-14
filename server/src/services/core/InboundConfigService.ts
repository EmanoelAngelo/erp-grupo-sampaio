/**
 * O que a loja decide uma vez, e vale para toda nota que entrar.
 *
 * ## O buraco que isto fecha
 *
 * Quando a entrada de nota cria um produto que ainda não existia no catálogo,
 * ela copia o CFOP do ITEM DA NOTA para o cadastro. Esse CFOP é o do
 * FORNECEDOR, escrito na ótica dele: comprando de outro estado a nota traz
 * 6102 — "venda interestadual" —, e o produto da loja nasce com 6102.
 *
 * Aí a loja vende no balcão, e `FiscalXmlNfce` lê `p.cfop` e o joga direto no
 * XML da NFC-e. A venda local sai declarada como operação interestadual.
 *
 * Ninguém percebe olhando a tela: o produto tem CFOP, o cupom emite, a SEFAZ
 * autoriza (o código existe e é válido). O erro só aparece na apuração, meses
 * depois, quando o contador cruza as operações.
 *
 * ## Nulo não é ausência de configuração
 *
 * Nulo mantém EXATAMENTE o comportamento de hoje: o produto herda o CFOP da
 * nota. É a decisão de quem ainda não decidiu, e não pode virar bloqueio —
 * gate de emissão fiscal por causa de um campo de compras pararia o cupom da
 * loja inteira.
 *
 * ## O que NÃO está aqui, e por quê
 *
 * A rodada previa mais duas configurações. As duas foram recusadas por
 * quebrarem em produção, e a recusa fica escrita para não ser refeita:
 *
 * LOCAL DE ESTOQUE PADRÃO. Só a ENTRADA passaria a gravar local; toda SAÍDA
 * (PDV, OS, devolução, contagem) continua gravando nulo, que o `COALESCE` de
 * `balanceByLocation` joga no local padrão. Receber 10 no Depósito e vender 3
 * no balcão deixaria +10 num local e -3 no outro, e a transferência passaria a
 * oferecer peça já vendida. Posição por local só fecha quando a VENDA souber
 * de onde a peça saiu.
 *
 * TABELA DE PREÇO PADRÃO. O assistente de reprecificação avaliaria a margem
 * pelo preço da tabela e continuaria sugerindo e gravando o preço BASE. O
 * alerta nasceria impossível de zerar, e "Aplicar os preços" ABAIXARIA o preço
 * de prateleira.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface InboundConfig {
  companyId: string;
  defaultSaleCfop: string | null;
}

/**
 * CFOP de SAÍDA: quatro dígitos começando em 5, 6 ou 7.
 *
 * 5 é operação dentro do estado, 6 é interestadual e 7 é exterior. A série
 * 1/2/3 é de ENTRADA — aceitar aqui gravaria no produto o código de quando a
 * mercadoria chega, e a venda sairia declarando que a loja está comprando.
 */
function validarCfopDeSaida(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  if (digitos.length !== 4 || !'567'.includes(digitos[0]!)) {
    throw new ApiError(
      'CORE_CFOP_INVALID',
      'CFOP de venda inválido: são quatro dígitos começando em 5, 6 ou 7.',
      400,
    );
  }
  return digitos;
}

export function getInboundConfig(companyId: string): InboundConfig {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT default_sale_cfop FROM core_inbound_configs WHERE company_id = ?')
    .get(companyId) as { default_sale_cfop?: string | null } | undefined;

  // Empresa sem linha é o estado normal de quem nunca configurou — devolver o
  // padrão vazio evita que todo chamador precise tratar "não existe".
  return { companyId, defaultSaleCfop: linha?.default_sale_cfop ?? null };
}

export function setInboundConfig(
  companyId: string,
  input: { defaultSaleCfop?: string | null },
): InboundConfig {
  ensureCoreSchema();
  const bruto = input.defaultSaleCfop?.trim();
  // String vazia é "limpar", e não "gravar vazio": é como a tela devolve um
  // campo que a pessoa apagou.
  const cfop = bruto ? validarCfopDeSaida(bruto) : null;
  const agora = new Date().toISOString();

  getConnection()
    .prepare(
      `INSERT INTO core_inbound_configs (company_id, default_sale_cfop, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (company_id)
       DO UPDATE SET default_sale_cfop = excluded.default_sale_cfop, updated_at = excluded.updated_at`,
    )
    .run(companyId, cfop, agora, agora);

  return { companyId, defaultSaleCfop: cfop };
}
