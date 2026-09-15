/**
 * QUEM USA PLAQUINHA COM QR — escolhido pela tela, não por migração
 * (GAP-PRD-185).
 *
 * ## O defeito
 *
 * `core_companies.uses_equipment_tags` só tinha um escritor: o passo de
 * migração que marca os slugs `oficina` e `pj-motors`. A sétima operação de
 * oficina nascia pela tela de Empresas (a promessa "empresa nova sem código") e
 * batia em `CORE_COMPANY_NO_TAGS` na primeira folha de plaquinhas — ligar a
 * marca pedia um UPDATE à mão no banco.
 *
 * ## A escolha, e o padrão
 *
 * Quem abre a operação escolhe na criação; quem responde pelo grupo liga ou
 * desliga depois. Sem escolha explícita, o padrão é o que a própria bancada já
 * diz: `capabilitiesFor('mobility').equipmentTags` é verdadeiro (moto passa
 * dias no pátio e ganha plaquinha), e celular e loja nascem sem. É o mesmo
 * critério que `/labels/equipment` usa para decidir se a máquina ganha QR —
 * uma oficina de mobilidade sem a marca imprimia a plaquinha de cada máquina e
 * não conseguia usar o pool, que é a contradição que o padrão elimina.
 *
 * ## Desligar tem uma recusa
 *
 * Plaquinha já impressa esperando máquina (`gerada` ou `disponivel`) é adesivo
 * que existe no mundo com número do grupo. Desligar a marca com elas no pool
 * as deixaria sem caminho — a marcação de danificada passa pelo mesmo guarda.
 * A recusa diz quantas são e o que fazer. As plaquinhas já COLADAS continuam
 * respondendo pelo QR: desligar só fecha o pool para lotes novos.
 *
 * ## SÓ A PJ MOTORS LIGA (P0 das plaquinhas)
 *
 * O defeito: esta tela ligava a marca em QUALQUER operação, e a oficina de
 * mobilidade nascia com ela ligada por padrão. O dono restringiu a plaquinha à
 * PJ Motors — e uma marca que a tela liga numa loja de roupa é uma porta que o
 * pool teria de fechar depois, em cada rota.
 *
 * A escolha: só a empresa de slug `pj-motors` pode ter a marca. Ligar em outra
 * é 403 (`CORE_COMPANY_TAGS_PJ_ONLY`), na criação e na lista. Desligar em
 * outra continua aceito, e SEM a trava de pendentes: é o jeito de limpar a
 * marca velha que um banco antigo deixou na Oficina, e as plaquinhas dela já
 * não são alcançáveis por rota nenhuma — a trava protegeria um pool que
 * ninguém mais abre. Por que o slug, e não uma lista de ids: é o único
 * identificador que sobrevive a semeadura e restauração, o mesmo que a
 * migração usa.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { EMPRESA_DAS_PLAQUINHAS, ehEmpresaDasPlaquinhas } from './EmpresaDasPlaquinhas.js';

/**
 * O padrão de uma operação nova: SEM plaquinha.
 *
 * Antes derivava da bancada (mobilidade nascia com a marca ligada). Operação
 * nova nunca é a PJ Motors — o slug é único e a PJ já existe —, então o
 * padrão é desligado para todas. Fica como função para a rota continuar
 * dizendo "o padrão" num lugar só.
 */
export function plaquinhaPadraoDaEmpresaNova(slug?: string | null): boolean {
  return ehEmpresaDasPlaquinhas(slug);
}

/**
 * A recusa de ligar a plaquinha fora da PJ Motors — a mesma frase na criação e
 * na lista de Empresas.
 */
export function exigirQueSejaAEmpresaDasPlaquinhas(slug: string | null | undefined, nome: string): void {
  if (ehEmpresaDasPlaquinhas(slug)) return;
  throw new ApiError(
    'CORE_COMPANY_TAGS_PJ_ONLY',
    `Plaquinha com QR e número é exclusiva da PJ Motors (/${EMPRESA_DAS_PLAQUINHAS}): `
      + `${nome} não pode usá-la. Aqui a identificação é a etiqueta de produto.`,
    403,
  );
}

/**
 * A escolha vinda do corpo. Ausente = usar o padrão; booleano = a escolha;
 * qualquer outra coisa é 400 — "sim" em texto não liga numeração do grupo.
 */
export function lerEscolhaDePlaquinha(valor: unknown): boolean | undefined {
  if (valor === undefined || valor === null) return undefined;
  if (typeof valor !== 'boolean') {
    throw new ApiError(
      'CORE_COMPANY_TAGS_INVALID',
      'Diga se a operação usa plaquinha com QR com verdadeiro ou falso.',
      400,
    );
  }
  return valor;
}

/** Grava a marca — chamada dentro da transação que cria a empresa. */
export function gravarPlaquinhaDaEmpresa(companyId: string, usa: boolean): void {
  getConnection()
    .prepare('UPDATE core_companies SET uses_equipment_tags = ?, updated_at = ? WHERE id = ?')
    .run(usa ? 1 : 0, new Date().toISOString(), companyId);
}

export interface MudancaDePlaquinha {
  companyId: string;
  tradeName: string;
  antes: boolean;
  depois: boolean;
}

/** Liga ou desliga a plaquinha de uma operação que já existe. */
export function definirPlaquinhaDaEmpresa(input: { companyId: string; enabled: unknown }): MudancaDePlaquinha {
  ensureCoreSchema();
  const escolha = lerEscolhaDePlaquinha(input.enabled);
  if (escolha === undefined) {
    throw new ApiError(
      'CORE_COMPANY_TAGS_INVALID',
      'Diga se a operação usa plaquinha com QR com verdadeiro ou falso.',
      400,
    );
  }
  const db = getConnection();
  const empresa = db
    .prepare('SELECT id, slug, trade_name, uses_equipment_tags FROM core_companies WHERE id = ? AND active = 1')
    .get(input.companyId) as
    | { id: string; slug: string; trade_name: string; uses_equipment_tags: number }
    | undefined;
  if (!empresa) {
    throw new ApiError('CORE_COMPANY_NOT_FOUND', 'Empresa não encontrada.', 404);
  }
  const daPj = ehEmpresaDasPlaquinhas(empresa.slug);
  // Ligar fora da PJ Motors é recusado antes de qualquer escrita.
  if (escolha) exigirQueSejaAEmpresaDasPlaquinhas(empresa.slug, empresa.trade_name);
  /*
    O "antes" que a tela vê é o EFETIVO. A marca gravada na Oficina por um
    banco antigo não vale nada (`empresaUsaPlaquinha` exige o slug da PJ), e
    responder "antes: ligada" faria a tela anunciar que desligou algo que
    nunca funcionou. A escrita abaixo, porém, olha o valor GRAVADO: desligar
    limpa a marca velha de verdade.
  */
  const gravada = Number(empresa.uses_equipment_tags) === 1;
  const antes = gravada && daPj;

  // A trava de pendentes só protege o pool que ainda é alcançável: o da PJ.
  if (daPj && antes && !escolha) {
    const pendentes = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM core_equipment_tags
          WHERE company_id = ? AND status IN ('gerada', 'disponivel')
          GROUP BY status`,
      )
      .all(input.companyId) as unknown as { status: string; n: number }[];
    const total = pendentes.reduce((s, p) => s + Number(p.n), 0);
    if (total > 0) {
      throw new ApiError(
        'CORE_COMPANY_TAGS_PENDING',
        `${empresa.trade_name} tem ${total} plaquinha(s) no pool esperando máquina. `
          + 'Associe-as ou marque-as como danificadas em Plaquinhas antes de desligar.',
        409,
        { pendentes },
      );
    }
  }

  if (gravada !== escolha) gravarPlaquinhaDaEmpresa(input.companyId, escolha);
  return { companyId: empresa.id, tradeName: empresa.trade_name, antes, depois: escolha };
}
